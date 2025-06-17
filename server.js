const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const cors = require('cors');
const BrowserManager = require('./src/browserManager');
const ExcelProcessor = require('./src/excelProcessor');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = './uploads';
        fs.ensureDirSync(uploadDir);
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['.xlsx', '.xls'];
        const fileExt = path.extname(file.originalname).toLowerCase();
        if (allowedTypes.includes(fileExt)) {
            cb(null, true);
        } else {
            cb(new Error('Only Excel files are allowed'), false);
        }
    }
});

// Initialize browser manager and excel processor
const browserManager = new BrowserManager(5); // 5 concurrent browsers
const excelProcessor = new ExcelProcessor();

// Store active sessions
const activeSessions = new Map();

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    socket.on('captcha-response', async (data) => {
        const { sessionId, captcha, browserId } = data;
        const session = activeSessions.get(sessionId);
        
        if (session && session.waitingForCaptcha) {
            session.captchaResponse = captcha;
            session.waitingForCaptcha = false;
            
            // Continue processing with the captcha
            try {
                await browserManager.submitCaptcha(browserId, captcha);
                socket.emit('captcha-submitted', { success: true });
            } catch (error) {
                socket.emit('captcha-error', { error: error.message });
            }
        }
    });
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Upload Excel file and start processing
app.post('/upload', upload.single('excelFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const filePath = req.file.path;
        const sessionId = Date.now().toString();
        
        // Read consumer numbers from Excel
        const consumerNumbers = await excelProcessor.readConsumerNumbers(filePath);
        
        // Create session
        activeSessions.set(sessionId, {
            consumerNumbers,
            currentIndex: 0,
            results: [],
            status: 'processing'
        });
        
        res.json({
            sessionId,
            totalConsumers: consumerNumbers.length,
            message: 'File uploaded successfully. Processing will begin shortly.'
        });
        
        // Start processing in background
        processConsumerNumbers(sessionId);
        
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get session status
app.get('/status/:sessionId', (req, res) => {
    const session = activeSessions.get(req.params.sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    res.json({
        currentIndex: session.currentIndex,
        totalConsumers: session.consumerNumbers.length,
        status: session.status,
        results: session.results.length
    });
});

// Download results
app.get('/download/:sessionId', async (req, res) => {
    try {
        const session = activeSessions.get(req.params.sessionId);
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        const outputPath = await excelProcessor.writeResults(session.results, req.params.sessionId);
        res.download(outputPath);

    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Download sample template
app.get('/template', async (req, res) => {
    try {
        const templatePath = await excelProcessor.createSampleTemplate();
        res.download(templatePath, 'consumer_numbers_template.xlsx');
    } catch (error) {
        console.error('Template download error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Process consumer numbers
async function processConsumerNumbers(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session) return;
    
    try {
        for (let i = session.currentIndex; i < session.consumerNumbers.length; i++) {
            const consumerNo = session.consumerNumbers[i];
            session.currentIndex = i;
            
            // Get available browser
            const browserId = await browserManager.getAvailableBrowser();
            
            // Emit status update
            io.emit('processing-update', {
                sessionId,
                currentIndex: i,
                consumerNo,
                browserId
            });
            
            try {
                // Process this consumer number
                const result = await processConsumer(consumerNo, browserId, sessionId);
                session.results.push(result);
                
                // Emit result
                io.emit('consumer-processed', {
                    sessionId,
                    consumerNo,
                    result
                });
                
            } catch (error) {
                console.error(`Error processing consumer ${consumerNo}:`, error);
                session.results.push({
                    consumerNo,
                    error: error.message
                });
            } finally {
                // Release browser
                browserManager.releaseBrowser(browserId);
            }
        }
        
        session.status = 'completed';
        io.emit('processing-complete', { sessionId });
        
    } catch (error) {
        console.error('Processing error:', error);
        session.status = 'error';
        io.emit('processing-error', { sessionId, error: error.message });
    }
}

// Process individual consumer
async function processConsumer(consumerNo, browserId, sessionId) {
    try {
        // Format consumer number (pad with zeros if less than 11 digits)
        const formattedConsumerNo = consumerNo.toString().padStart(11, '0');

        console.log(`Processing consumer ${formattedConsumerNo} on ${browserId}`);

        // Navigate and fill form
        await browserManager.navigateToMGVCL(browserId);
        await browserManager.selectCompany(browserId, 'MGVCL');
        await browserManager.enterConsumerNumber(browserId, formattedConsumerNo);

        // Check if captcha is required
        const captchaRequired = await browserManager.isCaptchaRequired(browserId);
        console.log(`Captcha required for ${formattedConsumerNo}: ${captchaRequired}`);

        if (captchaRequired) {
            // Get captcha image and request user input
            const captchaImage = await browserManager.getCaptchaImage(browserId);

            // Set session to wait for captcha
            const session = activeSessions.get(sessionId);
            if (!session) {
                throw new Error('Session not found');
            }

            session.waitingForCaptcha = true;

            // Emit captcha request
            io.emit('captcha-required', {
                sessionId,
                browserId,
                captchaImage,
                consumerNo: formattedConsumerNo
            });

            // Wait for captcha response with timeout
            let waitTime = 0;
            const maxWaitTime = 300000; // 5 minutes timeout

            while (session.waitingForCaptcha && waitTime < maxWaitTime) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                waitTime += 1000;
            }

            if (waitTime >= maxWaitTime) {
                throw new Error('Captcha timeout - no response received within 5 minutes');
            }
        }

        // Submit form and get results
        const billingData = await browserManager.submitAndGetResults(browserId);

        console.log(`Successfully processed consumer ${formattedConsumerNo}`);

        return {
            consumerNo: formattedConsumerNo,
            ...billingData
        };

    } catch (error) {
        console.error(`Error processing consumer ${consumerNo}:`, error);
        throw error;
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} to access the application`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    await browserManager.closeAll();
    process.exit(0);
});

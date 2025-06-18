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
// Add a set to track consumers being processed globally (across all sessions)
const consumersInProgress = new Set();

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    socket.on('captcha-response', async (data) => {
        const { sessionId, captcha, browserId, consumerNo } = data;
        const session = activeSessions.get(sessionId);
        
        if (!session || !session.waitingForCaptcha) return;
        
        try {
            // Verify this browser is actually waiting for captcha
            const browserData = browserManager.browsers.get(browserId);
            if (!browserData || !browserData.captchaRequired || browserData.currentConsumer !== consumerNo) {
                throw new Error('Invalid browser state or consumer mismatch');
            }

            await browserManager.submitCaptcha(browserId, captcha);
            
            socket.emit('captcha-submitted', { 
                success: true, 
                browserId,
                consumerNo 
            });
            
            // Continue processing this consumer
            const billingData = await browserManager.submitAndGetResults(browserId);
            if (billingData) {
                session.results.push({
                    consumerNo,
                    ...billingData
                });
            }
            
        } catch (error) {
            socket.emit('captcha-error', { 
                error: error.message,
                browserId,
                consumerNo
            });
        } finally {
            // Always release the browser
            browserManager.releaseBrowser(browserId);
        }
    });
    
    socket.on('reload-captcha', async (data) => {
        const { sessionId, browserId, consumerNo } = data;
        try {
            await browserManager.refreshCaptcha(browserId);
            const captchaImage = await browserManager.getCaptchaImage(browserId);
            
            io.emit('captcha-required', {
                sessionId,
                browserId,
                captchaImage,
                consumerNo
            });
            
        } catch (error) {
            socket.emit('captcha-error', { error: error.message });
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
        const { sessionId } = req.params;
        const excelProcessor = new ExcelProcessor();
        
        // Get results path for the session
        const resultsPath = path.join(excelProcessor.resultsDir, `MGVCL_Results_${sessionId}.xlsx`);
        
        if (!fs.existsSync(resultsPath)) {
            return res.status(404).json({ error: 'Results file not found' });
        }
        
        res.download(resultsPath);
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ error: 'Failed to download results' });
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
        // Initialize browsers only once
        await browserManager.initialize();

        const queue = session.consumerNumbers.slice(session.currentIndex);
        const completedResults = new Map();
        let currentQueueIndex = 0;

        // Limit concurrent processing to maxBrowsers
        const concurrentProcessing = Math.min(browserManager.maxBrowsers, queue.length);
        const processingPromises = Array(concurrentProcessing).fill(null).map(async () => {
            while (true) {
                const index = currentQueueIndex++;
                if (index >= queue.length) break;

                const consumerNo = queue[index];
                if (consumersInProgress.has(consumerNo)) {
                    continue;
                }

                try {
                    consumersInProgress.add(consumerNo);
                    const result = await processConsumer(consumerNo, null, sessionId);
                    completedResults.set(index, result);
                } catch (error) {
                    console.error(`Error processing consumer ${consumerNo}:`, error);
                    completedResults.set(index, { consumerNo, error: error.message });
                } finally {
                    consumersInProgress.delete(consumerNo);
                }
            }
        });

        await Promise.all(processingPromises);

        // Add results to session in correct order
        for (let i = session.currentIndex; i < session.consumerNumbers.length; i++) {
            const result = completedResults.get(i);
            if (result) {
                session.results.push(result);
            }
        }

        session.currentIndex = session.consumerNumbers.length;
        session.status = 'completed';
        io.emit('processing-complete', { sessionId });

    } catch (error) {
        console.error('Processing error:', error);
        session.status = 'error';
        io.emit('processing-error', { sessionId, error: error.message });
    }
}

// Update processConsumer function
async function processConsumer(consumerNo, _, sessionId) {
    let browserId;
    let retries = 0;
    const maxRetries = 3;
    
    while (retries < maxRetries) {
        try {
            browserId = await browserManager.getAvailableBrowser();
            const formattedConsumerNo = consumerNo.toString().padStart(11, '0');

            console.log(`Processing consumer ${formattedConsumerNo} on ${browserId}`);
            io.emit('processing-update', { sessionId, browserId, consumerNo: formattedConsumerNo });

            await browserManager.navigateToMGVCL(browserId);
            await browserManager.selectCompany(browserId, 'MGVCL');
            await browserManager.enterConsumerNumber(browserId, formattedConsumerNo);

            const captchaRequired = await browserManager.isCaptchaRequired(browserId);
            console.log(`Captcha required for ${formattedConsumerNo}: ${captchaRequired}`);

            if (captchaRequired) {
                const session = activeSessions.get(sessionId);
                if (!session) throw new Error('Session not found');

                browserManager.lockForCaptcha(browserId, formattedConsumerNo);
                const captchaImage = await browserManager.getCaptchaImage(browserId);

                session.waitingForCaptcha = true;
                session.currentBrowserId = browserId;

                io.emit('captcha-required', {
                    sessionId,
                    browserId,
                    captchaImage,
                    consumerNo: formattedConsumerNo
                });

                // Wait for captcha with timeout
                const captchaTimeout = 5 * 60 * 1000; // 5 minutes
                const startTime = Date.now();
                
                while (session.waitingForCaptcha) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    if (Date.now() - startTime >= captchaTimeout) {
                        throw new Error('Captcha timeout');
                    }
                }
            }

            const billingData = await browserManager.submitAndGetResults(browserId);
            return {
                consumerNo: formattedConsumerNo,
                ...billingData,
                browserId
            };

        } catch (error) {
            retries++;
            console.error(`Error processing consumer ${consumerNo} (attempt ${retries}):`, error);
            
            if (retries >= maxRetries) {
                throw error;
            }
            
            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, 5000));
            
        } finally {
            if (browserId) {
                browserManager.releaseBrowser(browserId);
            }
        }
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


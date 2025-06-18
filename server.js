const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const cors = require('cors');
const BrowserManager = require('./src/browserManager');
const ExcelProcessor = require('./src/excelProcessor');

// Ensure results directory exists
const resultsDir = './results';
fs.ensureDirSync(resultsDir);

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
        await browserManager.initialize();
        browserManager.setTotalConsumers(session.consumerNumbers.length);

        const queue = [...session.consumerNumbers];
        let currentQueueIndex = 0;
        let completedConsumers = 0;

        // Add browser availability listener
        browserManager.on('browser-available', async (browserId) => {
            // Get next consumer atomically
            const index = currentQueueIndex++;
            if (index < queue.length) {
                const nextConsumer = queue[index];
                if (!consumersInProgress.has(nextConsumer)) {
                    consumersInProgress.add(nextConsumer);
                    console.log(`Processing next consumer ${nextConsumer} on browser_${browserId}`);
                    processConsumer(nextConsumer, browserId, sessionId).catch(console.error);
                }
            }
        });

        console.log(`Starting processing for session ${sessionId} with ${queue.length} consumers`);
        console.log(`Consumer queue: [${queue.join(', ')}]`);

        // Create worker promises array with proper queue management
        const workers = Array(browserManager.maxBrowsers).fill(null).map(async (_, workerIndex) => {
            console.log(`Worker ${workerIndex} started`);
            
            while (true) {
                // Get next consumer atomically
                const index = currentQueueIndex++;
                if (index >= queue.length) {
                    console.log(`Worker ${workerIndex} finished - no more consumers in queue`);
                    break;
                }

                const consumerNo = queue[index];
                
                try {
                    if (!consumersInProgress.has(consumerNo)) {
                        consumersInProgress.add(consumerNo);
                        console.log(`Worker ${workerIndex}: Processing consumer ${consumerNo} (${index + 1}/${queue.length})`);
                        const result = await processConsumer(consumerNo, workerIndex, sessionId);
                        session.results.push(result);
                        completedConsumers++;
                        console.log(`Worker ${workerIndex}: Completed consumer ${consumerNo}. Progress: ${completedConsumers}/${queue.length}`);
                    }
                } catch (error) {
                    console.error(`Worker ${workerIndex}: Error processing consumer ${consumerNo}:`, error);
                    session.results.push({ consumerNo, error: error.message });
                    completedConsumers++;
                } finally {
                    consumersInProgress.delete(consumerNo);
                }
            }
        });

        // Wait for all workers to complete with timeout
        await Promise.race([
            Promise.all(workers),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Processing timeout')), 30 * 60 * 1000) // 30 min timeout
            )
        ]);

        // Update session status
        session.currentIndex = session.consumerNumbers.length;
        session.status = 'completed';
        
        // Create Excel file with results
        const excelPath = await excelProcessor.writeResults(session.results, sessionId);
        console.log(`Excel file created: ${excelPath}`);
        
        io.emit('processing-complete', { sessionId });
        io.emit('extraction-complete', { sessionId, autoDownload: false });

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
    
    console.log(`processConsumer: Starting processing for consumer ${consumerNo}`);
    
    while (retries < maxRetries) {
        try {
            console.log(`processConsumer: Getting available browser for consumer ${consumerNo} (attempt ${retries + 1})`);
            browserId = await browserManager.getAvailableBrowser();
            
            if (!browserId) {
                console.log(`processConsumer: No browser available, waiting 5 seconds...`);
                await new Promise(resolve => setTimeout(resolve, 5000));
                continue;
            }

            console.log(`processConsumer: Got browser ${browserId} for consumer ${consumerNo}`);
            
            // Initialize browser with fresh page
            await browserManager.navigateToMGVCL(browserId);
            
            const formattedConsumerNo = consumerNo.toString().padStart(11, '0');

            console.log(`Processing consumer ${formattedConsumerNo} on ${browserId}`);
            io.emit('processing-update', { sessionId, browserId, consumerNo: formattedConsumerNo });

            await browserManager.navigateToMGVCL(browserId);
            console.log(`processConsumer: Navigated to MGVCL for consumer ${consumerNo}`);
            await browserManager.selectCompany(browserId, 'MGVCL');
            console.log(`processConsumer: Selected company for consumer ${consumerNo}`);
            await browserManager.enterConsumerNumber(browserId, formattedConsumerNo);
            console.log(`processConsumer: Entered consumer number for consumer ${consumerNo}`);

            const captchaRequired = await browserManager.isCaptchaRequired(browserId);
            console.log(`Captcha required for ${formattedConsumerNo}: ${captchaRequired}`);

            if (captchaRequired) {
                console.log(`processConsumer: Captcha required for consumer ${consumerNo}, waiting for user input`);
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
                console.log(`processConsumer: Captcha submitted for consumer ${consumerNo}`);
            }

            console.log(`processConsumer: Submitting and getting results for consumer ${consumerNo}`);
            const billingData = await browserManager.submitAndGetResults(browserId);
            console.log(`processConsumer: Successfully completed consumer ${consumerNo}`);
            console.log(`processConsumer: Returning result for consumer ${consumerNo}`);
            
            // Release browser before returning
            if (browserId) {
                console.log(`processConsumer: Releasing browser ${browserId} for consumer ${consumerNo}`);
                browserManager.releaseBrowser(browserId);
                console.log(`processConsumer: Browser ${browserId} released and made available for next consumer`);
            }
            
            return {
                consumerNo: formattedConsumerNo,
                ...billingData,
                browserId
            };

        } catch (error) {
            retries++;
            console.error(`Error processing consumer ${consumerNo} (attempt ${retries}):`, error);
            
            if (browserId) {
                console.log(`processConsumer: Releasing browser ${browserId} for consumer ${consumerNo} after error`);
                browserManager.releaseBrowser(browserId);
            }
            
            if (retries >= maxRetries) {
                throw error;
            }
            
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    
    console.log(`processConsumer: Exiting processConsumer for consumer ${consumerNo} - all retries exhausted`);
    throw new Error(`Failed to process consumer ${consumerNo} after ${maxRetries} retries`);
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
// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    await browserManager.closeAll();
    process.exit(0);
});


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
        // Initialize browsers only once
        await browserManager.initialize();

        const queue = session.consumerNumbers.slice(session.currentIndex);
        const completedResults = new Map();
        let currentQueueIndex = 0;

        console.log(`Starting processing for session ${sessionId} with ${queue.length} consumers`);
        console.log(`Consumer queue: [${queue.join(', ')}]`);

        // Create worker functions that will continuously process consumers
        const workers = Array(browserManager.maxBrowsers).fill(null).map(async (_, workerIndex) => {
            console.log(`Worker ${workerIndex} started`);
            
            while (true) {
                // Get next consumer from queue atomically
                const index = currentQueueIndex++;
                console.log(`Worker ${workerIndex}: Queue index ${index}, queue length ${queue.length}, currentQueueIndex ${currentQueueIndex}`);
                
                if (index >= queue.length) {
                    console.log(`Worker ${workerIndex} finished - no more consumers (index ${index} >= ${queue.length})`);
                    break;
                }

                const consumerNo = queue[index];
                if (consumersInProgress.has(consumerNo)) {
                    console.log(`Worker ${workerIndex}: Consumer ${consumerNo} already in progress, skipping`);
                    continue;
                }

                console.log(`Worker ${workerIndex}: Processing consumer ${consumerNo} (index ${index}/${queue.length})`);
                
                try {
                    consumersInProgress.add(consumerNo);
                    console.log(`Worker ${workerIndex}: Starting processConsumer for consumer ${consumerNo}`);
                    const result = await processConsumer(consumerNo, null, sessionId);
                    console.log(`Worker ${workerIndex}: processConsumer completed for consumer ${consumerNo}`);
                    completedResults.set(index, result);
                    console.log(`Worker ${workerIndex}: Completed consumer ${consumerNo}, moving to next...`);
                } catch (error) {
                    console.error(`Worker ${workerIndex}: Error processing consumer ${consumerNo}:`, error);
                    completedResults.set(index, { consumerNo, error: error.message });
                    console.log(`Worker ${workerIndex}: Error recorded for consumer ${consumerNo}, moving to next...`);
                } finally {
                    consumersInProgress.delete(consumerNo);
                    console.log(`Worker ${workerIndex}: Removed consumer ${consumerNo} from in-progress set`);
                }
                
                // Add a small delay to prevent overwhelming the system
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // Log the loop condition check
                console.log(`Worker ${workerIndex}: Loop condition check - currentQueueIndex: ${currentQueueIndex}, queue.length: ${queue.length}, continue: ${currentQueueIndex < queue.length}`);
                
                // Log that we're continuing to next iteration
                console.log(`Worker ${workerIndex}: Continuing to next iteration...`);
            }
            
            console.log(`Worker ${workerIndex} exiting - queue exhausted`);
        });

        // Wait for all workers to complete
        await Promise.all(workers);

        console.log(`All workers completed. Processing ${completedResults.size} results`);

        // Add results to session in correct order
        for (let i = session.currentIndex; i < session.consumerNumbers.length; i++) {
            const result = completedResults.get(i);
            if (result) {
                session.results.push(result);
            }
        }

        console.log(`Session ${sessionId}: Added ${session.results.length} results to session`);

        session.currentIndex = session.consumerNumbers.length;
        session.status = 'completed';
        
        // Create Excel file with results
        try {
            console.log(`Creating Excel file for session ${sessionId} with ${session.results.length} results`);
            const excelPath = await excelProcessor.writeResults(session.results, sessionId);
            console.log(`Excel file created: ${excelPath}`);
        } catch (error) {
            console.error(`Error creating Excel file for session ${sessionId}:`, error);
            session.status = 'error';
            io.emit('processing-error', { sessionId, error: 'Failed to create Excel file' });
            return;
        }
        
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
            console.log(`processConsumer: Got browser ${browserId} for consumer ${consumerNo}`);
            
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
            
            if (retries >= maxRetries) {
                console.log(`processConsumer: Max retries reached for consumer ${consumerNo}, throwing error`);
                // Release browser before throwing error
                if (browserId) {
                    console.log(`processConsumer: Releasing browser ${browserId} for consumer ${consumerNo} after error`);
                    browserManager.releaseBrowser(browserId);
                }
                throw error;
            }
            
            // Release browser before retry
            if (browserId) {
                console.log(`processConsumer: Releasing browser ${browserId} for consumer ${consumerNo} before retry`);
                browserManager.releaseBrowser(browserId);
            }
            
            // Wait before retry
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


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
    
    // Check if there are completed sessions that need to re-send the download signal
    for (const [sessionId, session] of activeSessions.entries()) {
        if (session.status === 'completed' && session.resultsPath) {
            console.log(`Re-sending completion events for previously completed session ${sessionId}`);
            
            // Send both events with delay
            setTimeout(() => {
                console.log(`Re-sending processing-complete event for session ${sessionId}`);
                socket.emit('processing-complete', { sessionId });
                
                setTimeout(() => {
                    console.log(`Re-sending extraction-complete event for session ${sessionId}`);
                    socket.emit('extraction-complete', { sessionId, autoDownload: true });
                }, 1000);
            }, 2000);
        }
    }
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
        const timestamp = req.query.t || Date.now();
        console.log(`\n==== DOWNLOAD REQUEST ====`);
        console.log(`Download requested for session: ${sessionId} (timestamp: ${timestamp})`);
        const excelProcessor = new ExcelProcessor();
        
        // Check if session exists
        const session = activeSessions.get(sessionId);
        if (session) {
            console.log(`Session status: ${session.status}, Results: ${session.results ? session.results.length : 0}`);
        } else {
            console.log(`Session ${sessionId} not found in active sessions`);
        }
        
        // Look for the Excel file in the results directory
        const resultsDir = excelProcessor.resultsDir;
        console.log(`Checking results directory: ${resultsDir}`);
        const files = fs.readdirSync(resultsDir);
        console.log(`Found ${files.length} files in results directory`);
        
        // Find the file that matches the session ID pattern
        const targetFile = files.find(file => 
            file.startsWith(`MGVCL_Results_${sessionId}`) && file.endsWith('.xlsx')
        );
        
        // Debug log all available files for this session
        const matchingFiles = files.filter(file => file.includes(sessionId));
        console.log(`Files matching session ${sessionId}:`, matchingFiles);
        
        if (!targetFile) {
            console.error(`No Excel file found for session ${sessionId}. Available files:`, files);
            return res.status(404).json({ error: 'Results file not found' });
        }
        
        const resultsPath = path.join(resultsDir, targetFile);
        console.log(`Found results file: ${resultsPath}`);
        console.log(`Initiating download for file: ${targetFile}`);
        
        // Set proper headers for file download
        res.setHeader('Content-Disposition', `attachment; filename="${targetFile}"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        console.log(`Set headers for file download: ${targetFile}`);
          console.log(`Starting download response for session ${sessionId}`);
        
        // Check if file exists and is accessible
        try {
            fs.accessSync(resultsPath, fs.constants.F_OK | fs.constants.R_OK);
            console.log(`File exists and is readable: ${resultsPath}`);
            
            // Get file stats
            const stats = fs.statSync(resultsPath);
            console.log(`File size: ${stats.size} bytes, Created: ${stats.birthtime.toISOString()}`);
            
            if (stats.size === 0) {
                console.error(`Warning: File exists but is empty: ${resultsPath}`);
            }
        } catch (accessErr) {
            console.error(`File access error: ${accessErr.message}`);
            return res.status(500).json({ error: 'File exists but cannot be accessed' });
        }
        
        // Send file download
        res.download(resultsPath, targetFile, (err) => {
            if (err) {
                console.error(`Error during download for session ${sessionId}:`, err);
            } else {
                console.log(`File successfully sent for download: ${targetFile}`);
                console.log(`==== DOWNLOAD COMPLETE ====\n`);
            }
        });} catch (error) {
        console.error(`Download error for session ${req.params.sessionId}:`, error);
        res.status(500).json({ error: `Failed to download results: ${error.message}` });
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
    if (!session) {
        console.error(`Session ${sessionId} not found, cannot process`);
        return;
    }

    console.log(`Starting consumer processing for session ${sessionId}`);
    let processingError = null;

    try {
        await browserManager.initialize();
        browserManager.setTotalConsumers(session.consumerNumbers.length);

        const queue = [...session.consumerNumbers];
        let currentQueueIndex = 0;
        let completedConsumers = 0;        // Set up a completion checker with two safeguards:
        // 1. Regular interval check
        // 2. Max processing time check (ensures completion even if something gets stuck)
        const maxProcessingTime = 15 * 60 * 1000; // 15 minutes max processing time
        const startTime = Date.now();
        let lastCompletionTime = startTime; // Track the last time a consumer was completed
        let processingCompleted = false;
          const completionChecker = setInterval(() => {
            const elapsedTime = Date.now() - startTime;
            
            // Show detailed progress info
            console.log(`\n----- PROGRESS MONITOR -----`);
            console.log(`Completion check: ${completedConsumers}/${queue.length} consumers processed (${Math.floor(elapsedTime/1000)}s elapsed)`);
            
            // Get in-progress consumer details 
            const inProgressList = Array.from(consumersInProgress).join(', ');
            console.log(`In-progress consumers (${consumersInProgress.size}): ${inProgressList || 'none'}`);
            
            // List completed consumers
            const completedList = session.results.map(r => r.consumerNo || 'unknown').join(', ');
            console.log(`Completed consumers (${session.results.length}): ${completedList || 'none'}`);
            console.log(`-------------------------\n`);
              // Check different completion conditions
            const isComplete = completedConsumers >= queue.length && queue.length > 0;
            const isTimeout = elapsedTime > maxProcessingTime;
            const isStalled = elapsedTime > 60000 && completedConsumers > 0 && 
                              elapsedTime > (lastCompletionTime + 60000); // No progress for 1 minute
            const shouldForceComplete = completedConsumers >= (queue.length * 0.8) && 
                                       elapsedTime > 120000; // 80% complete and running for 2+ minutes
            
            if (isComplete || isTimeout || isStalled || shouldForceComplete) {
                let completionReason = "";
                
                if (isComplete) {
                    completionReason = "All consumers processed successfully";
                } else if (isTimeout) {
                    completionReason = `Processing timed out after ${Math.floor(elapsedTime/1000)} seconds`;
                } else if (isStalled) {
                    completionReason = `Processing appears stalled - no progress for over 1 minute`;
                } else if (shouldForceComplete) {
                    completionReason = `Force completing with ${completedConsumers}/${queue.length} (${Math.round(completedConsumers/queue.length*100)}%) after ${Math.floor(elapsedTime/1000)} seconds`;
                }
                
                console.log(`\n⚠️ ${completionReason}`);
                
                if (!processingCompleted) {
                    processingCompleted = true;
                    clearInterval(completionChecker);
                    finishProcessing();
                }
            }
        }, 5000);        // Function to finish processing and create results file
        async function finishProcessing() {
            console.log(`\n========================================`);
            
            const completionPercentage = Math.round((completedConsumers / queue.length) * 100);
            
            if (completedConsumers === queue.length) {
                console.log(`🎉 ALL CONSUMERS PROCESSED SUCCESSFULLY! (${completedConsumers}/${queue.length})`);
            } else {
                console.log(`⚠️ PARTIAL COMPLETION: ${completedConsumers}/${queue.length} consumers (${completionPercentage}%)`);
                
                // Add any non-processed consumers to results with error
                const processedConsumerNumbers = new Set(session.results.map(r => r.consumerNo));
                const missingConsumers = queue.filter(consumerNo => !processedConsumerNumbers.has(consumerNo));
                
                if (missingConsumers.length > 0) {
                    console.log(`Adding ${missingConsumers.length} non-processed consumers to results with error status`);
                    
                    missingConsumers.forEach(consumerNo => {
                        session.results.push({
                            consumerNo,
                            error: 'Processing timed out or was incomplete'
                        });
                    });
                }
            }
            
            console.log(`Total consumers processed: ${completedConsumers}/${queue.length} (${completionPercentage}%)`);
            console.log(`*** ALL CONSUMER NUMBERS PROCESSING COMPLETED FOR SESSION ${sessionId} ***`);
            console.log(`========================================\n`);
            
            // Safeguard: make sure session still exists
            if (!activeSessions.has(sessionId)) {
                console.error(`Cannot finish processing - session ${sessionId} no longer exists`);
                return;
            }
            
            // Create Excel file with results
            try {
                // Make sure we have results array
                if (!session.results) {
                    console.warn(`No results array for session ${sessionId}, initializing empty array`);
                    session.results = [];
                }
                
                console.log(`Creating Excel file for session ${sessionId} with ${session.results.length} results`);
                const excelPath = await excelProcessor.writeResults(session.results, sessionId);                console.log(`Excel file created: ${excelPath}`);
                
                // Update session status and store results path for reconnection handling
                session.currentIndex = session.consumerNumbers.length;
                session.status = 'completed';
                session.resultsPath = excelPath; // Store the path for reconnections
                
                // Emit completion events in correct sequence
                console.log(`Emitting completion events for session ${sessionId}`);
                io.emit('processing-complete', { sessionId });
                console.log(`Sent processing-complete event to client for session ${sessionId}`);
                
                // Add a slight delay to ensure processing-complete is processed before extraction-complete
                setTimeout(() => {
                    console.log(`Emitting extraction-complete event with autoDownload=true for session ${sessionId}`);
                    io.emit('extraction-complete', { sessionId, autoDownload: true });
                    console.log(`Sent extraction-complete event to client for session ${sessionId} - file should be automatically downloaded`);
                    
                    // Log a very visible completion message
                    console.log(`\n==================================================`);
                    console.log(`🎉 PROCESSING COMPLETE - DOWNLOAD TRIGGERED 🎉`);
                    console.log(`==================================================\n`);
                }, 1000);
            } catch (error) {
                console.error(`Error creating Excel file for session ${sessionId}:`, error);
                session.status = 'error';
                io.emit('processing-error', { sessionId, error: 'Failed to create Excel file: ' + error.message });
            }
        }

        console.log(`Starting processing for session ${sessionId} with ${queue.length} consumers`);
        console.log(`Consumer queue: [${queue.join(', ')}]`);        // Create a shared function to handle consumer completion
        const handleConsumerCompletion = (consumerNo, result, workerInfo = '') => {
            // Add to results
            session.results.push(result);
            
            // Update counter and log progress
            completedConsumers++;
            lastCompletionTime = Date.now(); // Update the last completion time
            
            console.log(`\n✅ ${workerInfo} Completed consumer ${consumerNo}. Progress: ${completedConsumers}/${queue.length}\n`);
            
            // Clean up tracking
            consumersInProgress.delete(consumerNo);
            
            // Emit progress update to frontend
            io.emit('consumer-processed', { 
                sessionId,
                consumerNo,
                result,
                progress: {
                    completed: completedConsumers,
                    total: queue.length
                }
            });
        };

        // Add browser availability listener for processing consumers from queue
        browserManager.on('browser-available', (browserId) => {
            // Get next consumer atomically
            const index = currentQueueIndex++;
            if (index < queue.length) {
                const nextConsumer = queue[index];
                if (!consumersInProgress.has(nextConsumer)) {
                    consumersInProgress.add(nextConsumer);
                    console.log(`Processing next consumer ${nextConsumer} on browser_${browserId}`);
                    
                    // Process the consumer with explicit promise handling
                    processConsumer(nextConsumer, browserId, sessionId)
                        .then(result => {
                            handleConsumerCompletion(nextConsumer, result, `[browser_${browserId}]`);
                        })
                        .catch(error => {
                            console.error(`Error processing consumer ${nextConsumer}:`, error);
                            handleConsumerCompletion(
                                nextConsumer, 
                                { consumerNo: nextConsumer, error: error.message },
                                `[browser_${browserId}]`
                            );
                        });
                }
            }
        });

        // Start initial set of worker processes
        for (let i = 0; i < Math.min(browserManager.maxBrowsers, queue.length); i++) {
            const index = currentQueueIndex++;
            if (index < queue.length) {
                const consumerNo = queue[index];
                consumersInProgress.add(consumerNo);
                console.log(`Worker ${i}: Processing consumer ${consumerNo} (${index + 1}/${queue.length})`);
                
                // Process the consumer with explicit promise handling
                processConsumer(consumerNo, i, sessionId)
                    .then(result => {
                        handleConsumerCompletion(consumerNo, result, `Worker ${i}:`);
                    })
                    .catch(error => {
                        console.error(`Worker ${i}: Error processing consumer ${consumerNo}:`, error);
                        handleConsumerCompletion(
                            consumerNo, 
                            { consumerNo, error: error.message }, 
                            `Worker ${i}:`
                        );
                    });
            }
        }    } catch (error) {
        processingError = error;
        console.error('Processing error:', error);
        console.log(`Error occurred during processing for session ${sessionId}:`, error);
        session.status = 'error';
        
        // Handle the error by attempting to generate the results anyway
        console.log('Attempting to generate results despite the error...');
        
        // Set up results array if needed
        if (!session.results) {
            session.results = [];
        }
        
        // Create and emit results
        try {
            console.log(`Creating Excel file for session ${sessionId} with ${session.results.length} results (after error)`);
            const excelPath = await excelProcessor.writeResults(session.results, sessionId);
            console.log(`Excel file created despite error: ${excelPath}`);
            
            // Emit completion events
            console.log(`Emitting completion events for session ${sessionId} (after error)`);
            io.emit('processing-complete', { sessionId });
            io.emit('processing-error', { sessionId, error: error.message });
            
            // Add a slight delay to ensure events are processed before extraction-complete
            setTimeout(() => {
                console.log(`Emitting extraction-complete event for session ${sessionId} (after error)`);
                io.emit('extraction-complete', { sessionId, autoDownload: true });
            }, 1000);
        } catch (finalError) {
            console.error(`Final error creating Excel file for session ${sessionId}:`, finalError);
            io.emit('processing-error', { 
                sessionId, 
                error: `Failed to create Excel file after processing error: ${finalError.message}` 
            });        }
    }
    
    console.log(`Processing function initiated for session ${sessionId}`);
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


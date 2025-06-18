class MGVCLApp {
    constructor() {
        this.socket = io();
        this.currentSessionId = null;
        this.captchaQueue = [];
        this.browserStatus = new Map();
        this.captchaTimeouts = new Map();
        
        this.initializeElements();
        this.setupEventListeners();
        this.setupSocketListeners();
        this.initializeBrowserStatus();
    }

    initializeElements() {
        // Form elements
        this.uploadForm = document.getElementById('uploadForm');
        this.excelFileInput = document.getElementById('excelFile');
        this.uploadBtn = document.getElementById('uploadBtn');
        this.captchaForm = document.getElementById('captchaForm');
        this.captchaInput = document.getElementById('captchaInput');
        
        // Display elements
        this.uploadSection = document.getElementById('uploadSection');
        this.processingSection = document.getElementById('processingSection');
        this.captchaSection = document.getElementById('captchaSection');
        this.resultsSection = document.getElementById('resultsSection');
        
        // Status elements
        this.progressFill = document.getElementById('progressFill');
        this.progressText = document.getElementById('progressText');
        this.progressPercent = document.getElementById('progressPercent');
        this.currentConsumer = document.getElementById('currentConsumer');
        this.currentBrowser = document.getElementById('currentBrowser');
        this.browserGrid = document.getElementById('browserGrid');
        
        // Captcha elements
        this.captchaImage = document.getElementById('captchaImage');
        this.captchaConsumer = document.getElementById('captchaBrowser');
        this.captchaBrowser = document.getElementById('captchaBrowser');
        this.queueCount = document.getElementById('queueCount');
        
        // Results elements
        this.totalProcessed = document.getElementById('totalProcessed');
        this.successCount = document.getElementById('successCount');
        this.failCount = document.getElementById('failCount');
        this.downloadResults = document.getElementById('downloadResults');
        this.startNew = document.getElementById('startNew');
        
        // Log elements
        this.logContainer = document.getElementById('logContainer');
        
        // File info elements
        this.fileInfo = document.getElementById('fileInfo');
        this.fileName = document.getElementById('fileName');
        this.fileSize = document.getElementById('fileSize');
    }

    setupEventListeners() {
        // File input change
        this.excelFileInput.addEventListener('change', (e) => {
            this.handleFileSelect(e);
        });
        
        // Upload form submit
        this.uploadForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleFileUpload();
        });
        
        // Captcha form submit
        this.captchaForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleCaptchaSubmit();
        });
        
        // Download results
        this.downloadResults.addEventListener('click', () => {
            this.handleDownloadResults();
        });
        
        // Start new processing
        this.startNew.addEventListener('click', () => {
            this.resetApplication();
        });
        
        // Download template
        document.getElementById('downloadTemplate').addEventListener('click', (e) => {
            e.preventDefault();
            this.downloadTemplate();
        });

        // Reload captcha button
        document.getElementById('reloadCaptchaBtn').addEventListener('click', () => {
            this.handleReloadCaptcha();
        });
    }

    setupSocketListeners() {
        this.socket.on('processing-update', (data) => {
            this.updateProcessingStatus(data);
        });
        
        this.socket.on('captcha-required', (data) => {
            this.handleCaptchaRequired(data);
        });
        
        this.socket.on('captcha-submitted', (data) => {
            this.handleCaptchaSubmitted(data);
        });
        
        this.socket.on('captcha-error', (data) => {
            this.handleCaptchaError(data);
        });
        
        this.socket.on('consumer-processed', (data) => {
            this.handleConsumerProcessed(data);
        });
        
        this.socket.on('processing-complete', (data) => {
            this.handleProcessingComplete(data);
        });
        
        this.socket.on('processing-error', (data) => {
            this.handleProcessingError(data);
        });
        
        this.socket.on('extraction-complete', (data) => {
            this.handleExtractionComplete(data);
        });
    }

    initializeBrowserStatus() {
        // Initialize 5 browser status items
        for (let i = 0; i < 5; i++) {
            const browserId = `browser_${i}`;
            this.browserStatus.set(browserId, 'available');
            
            const browserItem = document.createElement('div');
            browserItem.className = 'browser-item available';
            browserItem.id = `browser-${i}`;
            browserItem.innerHTML = `
                <div>Browser ${i + 1}</div>
                <div class="browser-status-text">Available</div>
            `;
            
            this.browserGrid.appendChild(browserItem);
        }
    }

    handleFileSelect(event) {
        const file = event.target.files[0];
        if (file) {
            this.fileName.textContent = file.name;
            this.fileSize.textContent = this.formatFileSize(file.size);
            this.fileInfo.style.display = 'block';
            
            // Validate file type
            const allowedTypes = ['.xlsx', '.xls'];
            const fileExt = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));
            
            if (!allowedTypes.includes(fileExt)) {
                this.addLogEntry('error', 'Invalid file type. Please select an Excel file (.xlsx or .xls)');
                this.excelFileInput.value = '';
                this.fileInfo.style.display = 'none';
                return;
            }
            
            this.addLogEntry('success', `File selected: ${file.name}`);
        }
    }

    async handleFileUpload() {
        const file = this.excelFileInput.files[0];
        if (!file) {
            this.addLogEntry('error', 'Please select a file first');
            return;
        }

        // Show loading state
        this.uploadBtn.querySelector('.btn-text').style.display = 'none';
        this.uploadBtn.querySelector('.btn-loader').style.display = 'inline';
        this.uploadBtn.disabled = true;

        const formData = new FormData();
        formData.append('excelFile', file);

        try {
            const response = await fetch('/upload', {
                method: 'POST',
                body: formData
            });

            const result = await response.json();

            if (response.ok) {
                this.currentSessionId = result.sessionId;
                this.addLogEntry('success', `File uploaded successfully. Processing ${result.totalConsumers} consumer numbers...`);
                this.showProcessingSection();
            } else {
                throw new Error(result.error || 'Upload failed');
            }
        } catch (error) {
            this.addLogEntry('error', `Upload failed: ${error.message}`);
        } finally {
            // Reset button state
            this.uploadBtn.querySelector('.btn-text').style.display = 'inline';
            this.uploadBtn.querySelector('.btn-loader').style.display = 'none';
            this.uploadBtn.disabled = false;
        }
    }

    async handleCaptchaSubmit() {
        const captchaText = this.captchaInput.value.trim();
        if (!captchaText) {
            this.addLogEntry('error', 'Please enter the captcha text');
            return;
        }

        const currentCaptcha = this.captchaQueue[0];
        if (!currentCaptcha) return;

        // Lock the submit button and input
        this.captchaInput.disabled = true;
        this.captchaForm.querySelector('button[type="submit"]').disabled = true;

        const browserId = currentCaptcha.browserId;
        this.addLogEntry('info', `Submitting captcha for browser ${browserId}...`);

        this.socket.emit('captcha-response', {
            sessionId: this.currentSessionId,
            captcha: captchaText,
            browserId: browserId,
            consumerNo: currentCaptcha.consumerNo
        });

        // Clear the input for next captcha
        this.captchaInput.value = '';
    }

    updateProcessingStatus(data) {
        if (data.sessionId !== this.currentSessionId) return;

        this.currentConsumer.textContent = data.consumerNo;
        this.currentBrowser.textContent = data.browserId;

        // Update browser status
        this.updateBrowserStatus(data.browserId, 'busy');

        this.addLogEntry('info', `Processing consumer: ${data.consumerNo}`, data.browserId);
    }

    handleCaptchaRequired(data) {
        if (data.sessionId !== this.currentSessionId) return;

        this.addLogEntry('info', `Received captcha request for browser ${data.browserId}`);

        // Clear any existing timeout for this browser
        if (this.captchaTimeouts.has(data.browserId)) {
            clearTimeout(this.captchaTimeouts.get(data.browserId));
        }

        // Set new timeout
        const timeout = setTimeout(() => {
            this.removeCaptchaFromQueue(data.browserId);
            this.addLogEntry('error', `Captcha timeout for browser ${data.browserId}`);
        }, 5 * 60 * 1000); // 5 minutes timeout

        this.captchaTimeouts.set(data.browserId, timeout);

        // Update or add to queue
        const existingIndex = this.captchaQueue.findIndex(item => item.browserId === data.browserId);
        if (existingIndex >= 0) {
            this.captchaQueue[existingIndex] = data;
            this.addLogEntry('info', `Updated captcha for browser ${data.browserId}`);
        } else {
            this.captchaQueue.push(data);
            this.addLogEntry('info', `Added new captcha for browser ${data.browserId}`);
        }

        this.showCaptchaSection();
        this.updateCaptchaDisplay();
    }

    handleCaptchaSubmitted(data) {
        if (data.success) {
            this.removeCaptchaFromQueue(data.browserId);
            this.addLogEntry('success', 'Captcha submitted successfully', data.browserId);

            // Re-enable input for next captcha
            this.captchaInput.disabled = false;
            this.captchaForm.querySelector('button[type="submit"]').disabled = false;

            // Load next captcha if available
            if (this.captchaQueue.length > 0) {
                this.updateCaptchaDisplay();
                // Focus on input field for next captcha
                this.captchaInput.focus();
            } else {
                this.hideCaptchaSection();
            }
        }
    }

    updateCaptchaDisplay() {
        const currentCaptcha = this.captchaQueue[0];
        if (currentCaptcha) {
            this.captchaSection.style.display = 'block';
            this.captchaConsumer.textContent = currentCaptcha.consumerNo;
            this.captchaBrowser.textContent = currentCaptcha.browserId;
            this.captchaImage.src = currentCaptcha.captchaImage;
            this.captchaImage.style.display = 'block';
            this.queueCount.textContent = this.captchaQueue.length.toString();
            
            // Enable input fields
            this.captchaInput.disabled = false;
            this.captchaForm.querySelector('button[type="submit"]').disabled = false;
        } else {
            this.hideCaptchaSection();
        }
    }

    removeCaptchaFromQueue(browserId) {
        const index = this.captchaQueue.findIndex(item => item.browserId === browserId);
        if (index >= 0) {
            this.captchaQueue.splice(index, 1);
            this.updateCaptchaDisplay();
        }

        // Clear timeout
        if (this.captchaTimeouts.has(browserId)) {
            clearTimeout(this.captchaTimeouts.get(browserId));
            this.captchaTimeouts.delete(browserId);
        }
    }

    handleCaptchaError(data) {
        // Re-enable input
        this.captchaInput.disabled = false;
        this.captchaForm.querySelector('button[type="submit"]').disabled = false;
        
        // Clear the input
        this.captchaInput.value = '';
        
        // Show error
        this.addLogEntry('error', `Captcha error: ${data.error}`, data.browserId);
        
        // Request new captcha image
        const currentCaptcha = this.captchaQueue[0];
        if (currentCaptcha) {
            this.socket.emit('reload-captcha', {
                sessionId: this.currentSessionId,
                browserId: currentCaptcha.browserId,
                consumerNo: currentCaptcha.consumerNo
            });
        }
    }

    handleConsumerProcessed(data) {
        if (data.sessionId !== this.currentSessionId) return;
        
        const browserId = data.result.browserId || 'unknown';
        this.updateBrowserStatus(browserId, 'available');

        if (data.result.error) {
            this.addLogEntry('error', `Failed to process ${data.consumerNo}: ${data.result.error}`, browserId);
        } else {
            this.addLogEntry('success', `Successfully processed ${data.consumerNo}`, browserId);
        }
    }

    handleProcessingComplete(data) {
        if (data.sessionId !== this.currentSessionId) return;

        this.addLogEntry('success', 'All consumers processed successfully!');
        
        // Enable download button
        this.downloadResults.disabled = false;
        this.downloadResults.style.display = 'block';
        
        this.showResultsSection();
        this.loadResultsSummary();
    }    handleExtractionComplete(data) {
        if (data.sessionId !== this.currentSessionId) {
            console.log(`Ignoring extraction-complete event for different session: ${data.sessionId}`);
            return;
        }
        
        // Enable download button
        this.downloadResults.disabled = false;
        this.downloadResults.style.display = 'block';
        
        // Update UI
        this.addLogEntry('success', 'All data extracted successfully! Ready for download.');
        this.showResultsSection();
        
        console.log(`Received extraction-complete event with autoDownload=${data.autoDownload}`);
        
        // Auto-trigger download if configured or by default
        if (data.autoDownload !== false) {
            this.addLogEntry('info', 'Automatically downloading results in 2 seconds...');
            console.log(`Auto-download triggered for session ${this.currentSessionId}`);
            
            // Slightly longer delay to ensure UI updates before download starts
            setTimeout(() => {
                this.addLogEntry('info', 'Starting automatic download now...');
                console.log(`Executing auto-download for session ${this.currentSessionId}`);
                this.handleDownloadResults();
            }, 2000);
        } else {
            console.log(`Auto-download disabled for session ${this.currentSessionId}, waiting for manual download`);
        }
    }

    handleProcessingError(data) {
        if (data.sessionId !== this.currentSessionId) return;

        this.addLogEntry('error', `Processing error: ${data.error}`);
    }

    updateBrowserStatus(browserId, status) {
        this.browserStatus.set(browserId, status);
        
        const browserElement = document.getElementById(browserId.replace('_', '-'));
        if (browserElement) {
            browserElement.className = `browser-item ${status}`;
            browserElement.querySelector('.browser-status-text').textContent = 
                status.charAt(0).toUpperCase() + status.slice(1);
        }
    }

    async loadResultsSummary() {
        try {
            const response = await fetch(`/status/${this.currentSessionId}`);
            const status = await response.json();
            
            this.totalProcessed.textContent = status.results || 0;
            // Note: We'll need to get success/fail counts from the backend
            // For now, showing total as processed
            this.successCount.textContent = status.results || 0;
            this.failCount.textContent = '0';
            
        } catch (error) {
            console.error('Error loading results summary:', error);
        }
    }    async handleDownloadResults(retryCount = 0) {
        try {
            const maxRetries = 3;
            this.addLogEntry('info', `Requesting download for session ${this.currentSessionId}${retryCount > 0 ? ` (Attempt ${retryCount + 1})` : ''}...`);
            
            const downloadUrl = `/download/${this.currentSessionId}`;
            console.log(`Downloading results from: ${downloadUrl} - Attempt ${retryCount + 1}`);
            
            // Add timestamp to avoid caching issues
            const timestampedUrl = `${downloadUrl}?t=${Date.now()}`;
            const response = await fetch(timestampedUrl);
            console.log('Download response status:', response.status, response.statusText);
            
            if (response.ok) {
                console.log('Download response received successfully, processing blob...');
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                console.log('Created object URL for download blob');
                
                // Get filename from response headers or use default
                const contentDisposition = response.headers.get('content-disposition');
                console.log('Content-Disposition header:', contentDisposition);
                let filename = `MGVCL_Results_${this.currentSessionId}.xlsx`;
                
                if (contentDisposition) {
                    const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
                    if (filenameMatch && filenameMatch[1]) {                        filename = filenameMatch[1].replace(/['"]/g, '');
                        console.log('Parsed filename from Content-Disposition:', filename);
                    }
                }
                
                this.addLogEntry('info', `Downloading file: ${filename}`);
                console.log(`Starting download of file: ${filename}`);
                
                // Create and click download link
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.style.display = 'none';
                document.body.appendChild(a);
                console.log('Download link created and appended to document');
                
                // Trigger download
                console.log('Triggering download click...');
                a.click();
                
                // Clean up
                setTimeout(() => {
                    window.URL.revokeObjectURL(url);
                    document.body.removeChild(a);
                    console.log('Download cleanup completed');
                    this.addLogEntry('success', 'Results downloaded successfully');
                }, 500);            } else {
                // Try to get error details
                let errorMessage = 'Download failed';
                try {
                    const errorData = await response.json();
                    
                    // Implement retry mechanism
                    if (retryCount < 3) {
                        console.log(`Download attempt ${retryCount + 1} failed, retrying in 3 seconds...`);
                        this.addLogEntry('warning', `Download attempt failed, retrying in 3 seconds...`);
                        
                        // Wait and retry
                        setTimeout(() => {
                            this.handleDownloadResults(retryCount + 1);
                        }, 3000);
                        return;
                    }
                    errorMessage = errorData.error || errorMessage;
                } catch (e) {
                    errorMessage += ` (Status: ${response.status})`;
                }
                throw new Error(errorMessage);
            }
        } catch (error) {
            console.error('Download error:', error);
            this.addLogEntry('error', `Download error: ${error.message}`);
        }
    }

    downloadTemplate() {
        // Download the Excel template from the server
        window.location.href = '/template';
    }

    showProcessingSection() {
        this.uploadSection.style.display = 'none';
        this.processingSection.style.display = 'block';
    }

    showCaptchaSection() {
        this.captchaSection.style.display = 'block';
    }

    hideCaptchaSection() {
        this.captchaSection.style.display = 'none';
    }

    showResultsSection() {
        this.processingSection.style.display = 'none';
        this.captchaSection.style.display = 'none';
        this.resultsSection.style.display = 'block';
    }

    resetApplication() {
        this.currentSessionId = null;
        this.captchaQueue = [];
        
        // Reset UI
        this.uploadSection.style.display = 'block';
        this.processingSection.style.display = 'none';
        this.captchaSection.style.display = 'none';
        this.resultsSection.style.display = 'none';
        
        // Reset form
        this.uploadForm.reset();
        this.fileInfo.style.display = 'none';
        
        // Reset browser status
        this.browserStatus.forEach((status, browserId) => {
            this.updateBrowserStatus(browserId, 'available');
        });
        
        this.addLogEntry('info', 'Application reset. Ready for new file upload.');
    }

    addLogEntry(type, message, browserId = '') {
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry ${type}`;
        
        const timestamp = new Date().toLocaleTimeString();
        const browserInfo = browserId ? ` [${browserId}]` : '';
        logEntry.innerHTML = `
            <span class="log-time">[${timestamp}]${browserInfo}</span>
            <span class="log-message">${message}</span>
        `;
        
        this.logContainer.appendChild(logEntry);
        this.logContainer.scrollTop = this.logContainer.scrollHeight;
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    handleReloadCaptcha() {
        // Get the current captcha info
        const currentCaptcha = this.captchaQueue[0];
        if (!currentCaptcha) return;
        // Emit reload-captcha event to backend
        this.socket.emit('reload-captcha', {
            sessionId: this.currentSessionId,
            browserId: currentCaptcha.browserId,
            consumerNo: currentCaptcha.consumerNo
        });
        this.addLogEntry('info', 'Requested captcha reload...', currentCaptcha.browserId);
    }
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new MGVCLApp();
});

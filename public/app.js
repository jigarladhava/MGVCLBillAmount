class MGVCLApp {
    constructor() {
        this.socket = io();
        this.currentSessionId = null;
        this.captchaQueue = [];
        this.browserStatus = new Map();
        
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
        this.captchaConsumer = document.getElementById('captchaConsumer');
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

    handleCaptchaSubmit() {
        const captchaText = this.captchaInput.value.trim();
        if (!captchaText) {
            this.addLogEntry('error', 'Please enter the captcha text');
            return;
        }

        const currentCaptcha = this.captchaQueue[0];
        if (currentCaptcha) {
            this.socket.emit('captcha-response', {
                sessionId: this.currentSessionId,
                captcha: captchaText,
                browserId: currentCaptcha.browserId
            });

            this.addLogEntry('success', `Captcha submitted for ${currentCaptcha.consumerNo}`);
            this.captchaInput.value = '';
        }
    }

    updateProcessingStatus(data) {
        if (data.sessionId !== this.currentSessionId) return;

        this.currentConsumer.textContent = data.consumerNo;
        this.currentBrowser.textContent = data.browserId;

        // Update browser status
        this.updateBrowserStatus(data.browserId, 'busy');

        this.addLogEntry('info', `Processing consumer: ${data.consumerNo} on ${data.browserId}`);
    }

    handleCaptchaRequired(data) {
        if (data.sessionId !== this.currentSessionId) return;

        // Add to captcha queue
        this.captchaQueue.push(data);
        this.updateCaptchaDisplay();

        this.addLogEntry('warning', `Captcha required for consumer: ${data.consumerNo}`);
    }

    updateCaptchaDisplay() {
        this.queueCount.textContent = this.captchaQueue.length;

        if (this.captchaQueue.length > 0) {
            const currentCaptcha = this.captchaQueue[0];
            
            this.captchaConsumer.textContent = currentCaptcha.consumerNo;
            this.captchaBrowser.textContent = currentCaptcha.browserId;
            this.captchaImage.src = currentCaptcha.captchaImage;
            this.captchaImage.style.display = 'block';
            
            this.showCaptchaSection();
            this.captchaInput.focus();
        } else {
            this.hideCaptchaSection();
        }
    }

    handleCaptchaSubmitted(data) {
        if (data.success) {
            // Remove processed captcha from queue
            this.captchaQueue.shift();
            this.updateCaptchaDisplay();
            
            this.addLogEntry('success', 'Captcha submitted successfully');
        }
    }

    handleCaptchaError(data) {
        this.addLogEntry('error', `Captcha error: ${data.error}`);
    }

    handleConsumerProcessed(data) {
        if (data.sessionId !== this.currentSessionId) return;

        // Release browser
        this.updateBrowserStatus(data.result.browserId || 'unknown', 'available');

        if (data.result.error) {
            this.addLogEntry('error', `Failed to process ${data.consumerNo}: ${data.result.error}`);
        } else {
            this.addLogEntry('success', `Successfully processed ${data.consumerNo}`);
        }
    }

    handleProcessingComplete(data) {
        if (data.sessionId !== this.currentSessionId) return;

        this.addLogEntry('success', 'All consumers processed successfully!');
        this.showResultsSection();
        this.loadResultsSummary();
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
    }

    handleDownloadResults() {
        if (this.currentSessionId) {
            window.location.href = `/download/${this.currentSessionId}`;
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

    addLogEntry(type, message) {
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry ${type}`;
        
        const timestamp = new Date().toLocaleTimeString();
        logEntry.innerHTML = `
            <span class="log-time">[${timestamp}]</span>
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
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new MGVCLApp();
});

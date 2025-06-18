const axios = require('axios');
const https = require('https');
const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');

/**
 * API Instance class representing a single MGVCL API session
 */
class ApiInstance {
    constructor(id) {
        this.id = id;
        this.baseUrl = 'https://mpay.guvnl.in';
        this.sessionCookie = null;
        this.currentConsumer = null;
        this.busy = false;
        this.captchaRequired = false;
        this.lastCaptchaRefresh = null;
        
        // Create axios instance with default configuration
        this.api = axios.create({
            httpsAgent: new https.Agent({
                rejectUnauthorized: false // This is needed as some government sites may have certificate issues
            }),
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-IN,en;q=0.9,gu;q=0.8'
            },
            maxRedirects: 5,
            timeout: 30000
        });
    }
    
    /**
     * Initialize a session with MGVCL
     * @returns {Promise<boolean>} Success status
     */
    async initialize() {
        try {
            console.log(`[API Instance ${this.id}] Initializing MGVCL session`);
            const response = await this.api.get(`${this.baseUrl}/paytm/QuickPay.php`, {
                params: {
                    company: 'MGVCL'
                }
            });

            // Extract session cookie
            const cookies = response.headers['set-cookie'] || [];
            const sessionCookie = cookies.find(cookie => cookie.includes('PHPSESSID'));
            
            if (!sessionCookie) {
                throw new Error('Failed to obtain session cookie');
            }

            this.sessionCookie = sessionCookie;
            console.log(`[API Instance ${this.id}] Session initialized with cookie:`, sessionCookie.split(';')[0]);
            
            return true;
        } catch (error) {
            console.error(`[API Instance ${this.id}] Error initializing session:`, error.message);
            return false;
        }
    }
    
    /**
     * Reset the API instance for reuse
     */
    async reset() {
        try {
            // Re-initialize session
            await this.initialize();
            
            // Clear state
            this.currentConsumer = null;
            this.busy = false;
            this.captchaRequired = false;
            this.lastCaptchaRefresh = null;
            
            return true;
        } catch (error) {
            console.error(`[API Instance ${this.id}] Error resetting:`, error.message);
            return false;
        }
    }
}

class ApiProcessor extends EventEmitter {
    constructor(maxInstances = 5) {
        super();
        this.maxInstances = maxInstances;
        this.baseUrl = 'https://mpay.guvnl.in';
        this.captchaRequests = new Map();
        this.instances = new Map();
        this.availableInstances = [];
        this.busyInstances = new Set();
        this.initialized = false;
        this.instanceQueue = []; // Queue for pending instance requests
        
        // Initialize API instances
        for (let i = 0; i < this.maxInstances; i++) {
            const instanceId = `api_${i}`;
            this.instances.set(instanceId, new ApiInstance(instanceId));
            this.availableInstances.push(instanceId);
        }
    }

    /**
     * Initialize all API instances
     * @returns {Promise<boolean>} Success status
     */
    async initialize() {
        if (this.initialized) {
            console.log('API instances already initialized');
            return true;
        }
        
        console.log(`Initializing ${this.maxInstances} API instances...`);
        
        let successCount = 0;
        
        for (const [instanceId, instance] of this.instances.entries()) {
            const success = await instance.initialize();
            if (success) {
                successCount++;
            }
        }
        
        this.initialized = (successCount > 0);
        console.log(`Initialized ${successCount}/${this.maxInstances} API instances`);
        
        // Start the cleanup interval
        this.startCleanupInterval();
        
        return this.initialized;
    }
    
    /**
     * Get an available API instance
     * @returns {Promise<string|null>} Instance ID or null if none available
     */
    async getAvailableInstance() {
        if (!this.initialized) {
            await this.initialize();
        }
        
        console.log(`Available API instances: ${this.availableInstances.length}, Busy instances: ${this.busyInstances.size}`);
        
        // Check if there's an available instance
        if (this.availableInstances.length === 0) {
            console.log('No available API instances, queuing request');
            // Return promise that resolves when an instance becomes available
            return new Promise((resolve) => {
                const timeoutId = setTimeout(() => {
                    const queueIndex = this.instanceQueue.indexOf(resolve);
                    if (queueIndex > -1) {
                        this.instanceQueue.splice(queueIndex, 1);
                        resolve(null); // Resolve with null to indicate timeout
                    }
                }, 2 * 60 * 1000); // 2 minute timeout
                
                // Add resolver function to queue
                this.instanceQueue.push((instanceId) => {
                    clearTimeout(timeoutId);
                    resolve(instanceId);
                });
            });
        }
        
        const instanceId = this.availableInstances.shift();
        this.busyInstances.add(instanceId);
        
        const instance = this.instances.get(instanceId);
        if (instance) {
            instance.busy = true;
            return instanceId;
        }
        
        return null;
    }
    
    /**
     * Release an API instance for reuse
     * @param {string} instanceId - ID of the instance to release
     */
    async releaseInstance(instanceId) {
        const instance = this.instances.get(instanceId);
        if (!instance) return;
        
        console.log(`Releasing API instance ${instanceId}`);
        
        try {
            // Reset the instance for reuse
            await instance.reset();
            
            // Update status
            instance.busy = false;
            instance.currentConsumer = null;
            instance.captchaRequired = false;
            
            // Remove from busy set
            this.busyInstances.delete(instanceId);
            
            // If there are pending requests in queue, process next request immediately
            if (this.instanceQueue.length > 0) {
                const nextRequest = this.instanceQueue.shift();
                instance.busy = true;
                this.busyInstances.add(instanceId);
                console.log(`[${instanceId}] Processing next request from queue, queue length: ${this.instanceQueue.length}`);
                nextRequest(instanceId);
            } else {
                // Add back to available list
                this.availableInstances.push(instanceId);
            }
            
            // Emit event that instance is available
            this.emit('instance-available', instanceId);
        } catch (error) {
            console.error(`Error releasing instance ${instanceId}:`, error);
            
            // Still mark as available even if reset fails
            instance.busy = false;
            this.busyInstances.delete(instanceId);
            this.availableInstances.push(instanceId);
        }
    }
    
    /**
     * Lock an API instance for captcha handling
     * @param {string} instanceId - ID of the API instance
     * @param {string} consumerNo - Consumer number
     */
    lockForCaptcha(instanceId, consumerNo) {
        const instance = this.instances.get(instanceId);
        if (!instance) return;
        
        instance.captchaRequired = true;
        instance.currentConsumer = consumerNo;
        instance.lastCaptchaRefresh = Date.now();
        
        // Add to captcha requests map
        this.captchaRequests.set(instanceId, {
            instanceId,
            consumerNo,
            timestamp: Date.now()
        });
    }
    
    /**
     * Unlock an API instance from captcha
     * @param {string} instanceId - ID of the API instance
     */
    unlockFromCaptcha(instanceId) {
        const instance = this.instances.get(instanceId);
        if (!instance) return;
        
        instance.captchaRequired = false;
        this.captchaRequests.delete(instanceId);
    }
    
    /**
     * Get captcha image for a consumer
     * @param {string} instanceId - ID of the API instance
     * @param {string} consumerNo - Consumer number
     * @returns {Promise<Object>} Captcha information including image and instance ID
     */
    async getCaptchaImage(instanceId, consumerNo) {
        const instance = this.instances.get(instanceId);
        if (!instance) {
            throw new Error(`API instance ${instanceId} not found`);
        }
        
        try {
            console.log(`[${instanceId}] Getting captcha for consumer ${consumerNo}`);
            
            // Add timestamp to avoid caching
            const timestamp = Date.now();
            const captchaUrl = `${this.baseUrl}/paytm/securimage/securimage_show.php?${timestamp}`;
            
            const response = await instance.api.get(captchaUrl, {
                headers: {
                    'Cookie': instance.sessionCookie,
                    'Referer': `${this.baseUrl}/paytm/QuickPay.php`
                },
                responseType: 'arraybuffer'
            });
            
            // Lock instance for captcha
            this.lockForCaptcha(instanceId, consumerNo);
            
            // Convert to base64 for sending to client
            const imageBase64 = Buffer.from(response.data, 'binary').toString('base64');
            
            return {
                instanceId,
                consumerNo,
                captchaImage: `data:image/png;base64,${imageBase64}`
            };
        } catch (error) {
            console.error(`[${instanceId}] Error getting captcha for consumer ${consumerNo}:`, error.message);
            throw error;
        }
    }
    
    /**
     * Refresh captcha for an instance
     * @param {string} instanceId - ID of the API instance
     * @returns {Promise<Object>} New captcha information
     */
    async refreshCaptcha(instanceId) {
        const instance = this.instances.get(instanceId);
        if (!instance || !instance.captchaRequired) {
            throw new Error('Invalid instance or captcha not required');
        }
        
        const consumerNo = instance.currentConsumer;
        
        try {
            // Simply get a new captcha
            return await this.getCaptchaImage(instanceId, consumerNo);
        } catch (error) {
            console.error(`[${instanceId}] Error refreshing captcha:`, error.message);
            throw error;
        }
    }
    
    /**
     * Submit captcha and get consumer details
     * @param {string} instanceId - ID of the API instance
     * @param {string} captchaText - Text entered by user
     * @returns {Promise<Object>} Consumer details
     */
    async submitCaptcha(instanceId, captchaText) {
        const instance = this.instances.get(instanceId);
        if (!instance || !instance.captchaRequired) {
            throw new Error('Invalid instance or captcha not required');
        }
        
        const consumerNo = instance.currentConsumer;
        
        try {
            console.log(`[${instanceId}] Submitting captcha for consumer ${consumerNo}`);
            
            const response = await instance.api.post(
                `${this.baseUrl}/paytmservices/GetConsStatus.php`, 
                JSON.stringify({
                    consno: consumerNo,
                    company: 'mgvcl',
                    cap_cod: captchaText
                }),
                {
                    headers: {
                        'Content-Type': 'application/json; charset=UTF-8',
                        'Cookie': instance.sessionCookie,
                        'Referer': `${this.baseUrl}/paytm/QuickPay.php`,
                        'Origin': this.baseUrl,
                        'X-Requested-With': 'XMLHttpRequest'
                    }
                }
            );
            
            try {
                const data = JSON.parse(response.data);
                
                if (data.v_status === 'Y') {
                    // Successfully got data, unlock from captcha
                    this.unlockFromCaptcha(instanceId);
                    
                    // Format the data to match our application's expected format
                    return {
                        consumerNo: data.v_cons_no,
                        name: data.v_cons_name.trim(),
                        circle: data.v_circle,
                        division: data.v_division,
                        subdivision: data.v_subdiv,
                        billAmount: parseFloat(data.v_bill_amt_assmt || 0),
                        billDate: data.v_bill_dt_assmt,
                        dueDate: data.v_due_dt_assmt,
                        billingPeriod: data.v_billing_period_assmt,
                        outstandingAmount: parseFloat(data.OutAmount || 0),
                        lastPaidAmount: data.last_paid_detail
                    };
                } else {
                    // Handle error cases
                    throw new Error(data.error_message || 'Invalid consumer number or captcha');
                }
            } catch (parseError) {
                console.error(`[${instanceId}] Error parsing response:`, parseError);
                console.error('Response body:', response.data);
                throw new Error('Failed to parse server response');
            }
        } catch (error) {
            console.error(`[${instanceId}] Error submitting captcha for consumer ${consumerNo}:`, error.message);
            throw error;
        }
    }
    
    /**
     * Check if an API instance is still valid for captcha handling
     * @param {string} instanceId - ID of the API instance
     * @param {string} consumerNo - Consumer number
     * @returns {boolean} True if valid, false otherwise
     */
    isCaptchaValid(instanceId, consumerNo) {
        const instance = this.instances.get(instanceId);
        if (!instance) return false;
        
        if (!instance.captchaRequired) return false;
        
        if (instance.currentConsumer !== consumerNo) return false;
        
        // Check if captcha is too old (5 minutes)
        if (Date.now() - instance.lastCaptchaRefresh > 5 * 60 * 1000) return false;
        
        return true;
    }
    
    /**
     * Get the current status of all API instances
     * @returns {Array} Array of instance status objects
     */
    getInstanceStatus() {
        const status = [];
        
        for (const [instanceId, instance] of this.instances.entries()) {
            status.push({
                instanceId,
                busy: instance.busy,
                currentConsumer: instance.currentConsumer,
                captchaRequired: instance.captchaRequired,
                lastCaptchaRefresh: instance.lastCaptchaRefresh
            });
        }
        
        return status;
    }
    
    /**
     * Clean up stale captcha requests
     * @returns {boolean} True if any requests were cleaned up
     */
    checkCaptchaLocks() {
        const currentTime = Date.now();
        const staleEntries = [];
        
        // Find stale entries
        for (const [instanceId, lockInfo] of this.captchaRequests.entries()) {
            const instance = this.instances.get(instanceId);
            
            // If instance doesn't exist, is not requiring captcha, or has been locked for too long
            if (!instance || 
                !instance.captchaRequired || 
                (currentTime - lockInfo.timestamp > 5 * 60 * 1000)) {
                
                staleEntries.push({
                    instanceId,
                    consumerNo: lockInfo.consumerNo
                });
                
                console.log(`Removing stale captcha lock for instance ${instanceId}, consumer ${lockInfo.consumerNo}`);
            }
        }
        
        // Remove stale entries
        for (const entry of staleEntries) {
            this.captchaRequests.delete(entry.instanceId);
            
            const instance = this.instances.get(entry.instanceId);
            if (instance) {
                instance.captchaRequired = false;
            }
            
            // Emit event so we can notify clients
            this.emit('captcha-obsolete', {
                instanceId: entry.instanceId,
                consumerNo: entry.consumerNo,
                message: 'Captcha is no longer valid (timed out or instance reassigned)'
            });
        }
        
        return staleEntries.length > 0;
    }
    
    /**
     * Periodically clean up stale captcha requests
     */
    startCleanupInterval() {
        // Clean up requests older than 5 minutes
        this.cleanupInterval = setInterval(() => {
            const removed = this.checkCaptchaLocks();
            if (removed) {
                console.log('Cleaned up stale API captcha entries');
            }
        }, 30000); // Check every 30 seconds
    }
      /**
     * Close all API instances and clean up resources
     */
    async closeAll() {
        console.log('Shutting down all API instances');
        
        // Clear the cleanup interval
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        
        // Clear all maps and arrays
        this.captchaRequests.clear();
        this.instances.clear();
        this.availableInstances = [];
        this.busyInstances.clear();
        this.instanceQueue = [];
        this.initialized = false;
        
        console.log('All API instances shut down');
    }

    /**
     * Submit captcha for a request ID and get consumer details
     * This is the main method used by server.js
     * @param {string} requestId - Request ID (same as instance ID) 
     * @param {string} captchaText - Captcha text entered by user
     * @returns {Promise<Object>} Consumer details
     */
    async submitCaptchaAndGetDetails(requestId, captchaText) {
        // Find the instance from the request ID
        const instance = this.instances.get(requestId);
        if (!instance) {
            throw new Error(`Invalid request ID: ${requestId}`);
        }
        
        if (!instance.captchaRequired || !instance.currentConsumer) {
            throw new Error('No captcha request active for this instance');
        }
        
        try {
            // Submit captcha and get consumer details
            return await this.submitCaptcha(requestId, captchaText);
        } finally {
            // Always release the instance after processing
            await this.releaseInstance(requestId);
        }
    }

    /**
     * Get a captcha for a consumer
     * Main method used by server.js
     * @param {string} consumerNo - Consumer number
     * @returns {Promise<Object>} Captcha request data including image and requestId
     */
    async getCaptchaForConsumer(consumerNo) {
        // Get an available instance
        const instanceId = await this.getAvailableInstance();
        if (!instanceId) {
            throw new Error('No API instances available');
        }
        
        try {
            // Get captcha image for the consumer
            const captchaData = await this.getCaptchaImage(instanceId, consumerNo);
            
            return {
                requestId: instanceId,  // Use instanceId as requestId for tracking
                consumerNo,
                captchaImage: captchaData.captchaImage
            };
        } catch (error) {
            // Release the instance on error
            await this.releaseInstance(instanceId);
            throw error;
        }
    }
}

module.exports = ApiProcessor;

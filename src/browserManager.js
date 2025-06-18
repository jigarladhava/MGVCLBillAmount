const { chromium } = require('playwright');
const EventEmitter = require('events');

class BrowserManager extends EventEmitter {
    constructor(maxBrowsers = 5) {
        super();
        this.maxBrowsers = maxBrowsers;
        this.browsers = new Map();
        this.availableBrowsers = [];
        this.busyBrowsers = new Set();
        this.initialized = false;
        this.captchaLocks = new Map();
        this.browserQueue = []; // Add queue for pending browser requests
        this.totalConsumers = 0;
        this.completedExtractions = 0;
    }

    async initialize() {
        if (this.initialized) {
            console.log('Browsers already initialized');
            return;
        }

        // Use static lock to prevent multiple initialization
        if (BrowserManager._initializing) {
            console.log('Browser initialization in progress, waiting...');
            await BrowserManager._initializationPromise;
            return;
        }

        BrowserManager._initializing = true;
        BrowserManager._initializationPromise = (async () => {
            try {
                console.log(`Initializing ${this.maxBrowsers} browser instances...`);
                for (let i = 0; i < this.maxBrowsers; i++) {
                    const browserId = `browser_${i}`;
                    if (!this.browsers.has(browserId)) {
                        const browser = await chromium.launch({
                            headless: false,
                            args: ['--no-sandbox', '--disable-setuid-sandbox']
                        });
                        
                        const context = await browser.newContext({
                            viewport: { width: 1280, height: 720 },
                            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        });
                        
                        const page = await context.newPage();
                        
                        this.browsers.set(browserId, {
                            browser,
                            context,
                            page,
                            busy: false,
                            currentConsumer: null,
                            captchaRequired: false,
                            lastCaptchaRefresh: null
                        });
                        
                        this.availableBrowsers.push(browserId);
                    }
                }
                this.initialized = true;
            } finally {
                BrowserManager._initializing = false;
            }
        })();

        await BrowserManager._initializationPromise;
    }

    async getAvailableBrowser() {
        if (!this.initialized) {
            await this.initialize();
        }

        // Check if there's an available browser
        if (this.availableBrowsers.length === 0) {
            // Return promise that resolves when a browser becomes available
            return new Promise((resolve) => {
                this.browserQueue.push(resolve);
            });
        }

        const browserId = this.availableBrowsers.shift();
        this.busyBrowsers.add(browserId);
        const browserData = this.browsers.get(browserId);
        browserData.busy = true;
        return browserId;
    }

    releaseBrowser(browserId) {
        const browserData = this.browsers.get(browserId);
        if (!browserData) return;

        // Clear browser state
        browserData.busy = false;
        browserData.currentConsumer = null;
        browserData.captchaRequired = false;
        this.busyBrowsers.delete(browserId);
        this.captchaLocks.delete(browserId);

        // If there are pending requests, assign this browser to the next one
        if (this.browserQueue.length > 0) {
            const nextRequest = this.browserQueue.shift();
            browserData.busy = true;
            this.busyBrowsers.add(browserId);
            nextRequest(browserId);
        } else {
            this.availableBrowsers.push(browserId);
        }
    }

    lockForCaptcha(browserId, consumerNo) {
        const browserData = this.browsers.get(browserId);
        if (browserData) {
            browserData.captchaRequired = true;
            browserData.currentConsumer = consumerNo;
            this.captchaLocks.set(browserId, {
                timestamp: Date.now(),
                consumerNo
            });
        }
    }

    unlockFromCaptcha(browserId) {
        const browserData = this.browsers.get(browserId);
        if (browserData) {
            browserData.captchaRequired = false;
            this.captchaLocks.delete(browserId);
        }
    }

    getBrowserStatus() {
        const status = [];
        for (const [browserId, browserData] of this.browsers) {
            status.push({
                browserId,
                busy: browserData.busy,
                currentConsumer: browserData.currentConsumer,
                captchaRequired: browserData.captchaRequired
            });
        }
        return status;
    }

    async navigateToMGVCL(browserId) {
        const browserData = this.browsers.get(browserId);
        if (!browserData) throw new Error('Browser not found');
        
        const { page } = browserData;
        
        try {
            await page.goto('https://mpay.guvnl.in/paytm/QuickPay.php', {
                waitUntil: 'networkidle',
                timeout: 30000
            });
            
            // Wait for page to load completely
            await page.waitForTimeout(2000);
            
        } catch (error) {
            console.error(`Navigation error for ${browserId}:`, error);
            throw error;
        }
    }

    async selectCompany(browserId, companyName = 'MGVCL') {
        const browserData = this.browsers.get(browserId);
        if (!browserData) throw new Error('Browser not found');

        const { page } = browserData;

        try {
            // Wait for company dropdown to be available
            await page.waitForSelector('select', { timeout: 10000 });

            // Select MGVCL from the dropdown
            await page.selectOption('select', { label: companyName });

            // Wait for the selection to take effect
            await page.waitForTimeout(1000);

        } catch (error) {
            console.error(`Company selection error for ${browserId}:`, error);
            throw error;
        }
    }

    async enterConsumerNumber(browserId, consumerNo) {
        const browserData = this.browsers.get(browserId);
        if (!browserData) throw new Error('Browser not found');

        const { page } = browserData;

        try {
            // Wait for the specific consumer number input field
            const consumerInputSelector = 'input#consnumber';
            await page.waitForSelector(consumerInputSelector, { timeout: 10000 });

            // Clear and enter consumer number
            await page.fill(consumerInputSelector, consumerNo);

            // Wait for input to be processed
            await page.waitForTimeout(500);

            console.log(`Entered consumer number ${consumerNo} in field #consnumber`);

        } catch (error) {
            console.error(`Consumer number entry error for ${browserId}:`, error);
            throw error;
        }
    }

    async isCaptchaRequired(browserId) {
        const browserData = this.browsers.get(browserId);
        if (!browserData) throw new Error('Browser not found');

        const { page } = browserData;

        try {
            // Check if captcha image exists using the exact selector
            const captchaExists = await page.locator('img#captcha').count() > 0;
            return captchaExists;

        } catch (error) {
            console.error(`Captcha check error for ${browserId}:`, error);
            return false;
        }
    }

    async getCaptchaImage(browserId) {
        const browserData = this.browsers.get(browserId);
        if (!browserData) throw new Error('Browser not found');

        const { page } = browserData;

        try {
            // Wait for captcha image using the exact selector and ensure it is visible
            await page.waitForSelector('img#captcha', { timeout: 5000, state: 'visible' });
            // Wait for the image to be fully loaded
            await page.evaluate(() => {
                const img = document.querySelector('img#captcha');
                return new Promise((resolve) => {
                    if (img && img.complete) {
                        resolve();
                    } else if (img) {
                        img.onload = resolve;
                        img.onerror = resolve;
                    } else {
                        resolve();
                    }
                });
            });
            // Add a small delay to ensure rendering
            await page.waitForTimeout(300);
            // Get captcha image as base64 screenshot
            const captchaElement = page.locator('img#captcha');
            let captchaImage = await captchaElement.screenshot({ encoding: 'base64' });
            // Ensure captchaImage is a string
            if (Buffer.isBuffer(captchaImage)) {
                captchaImage = captchaImage.toString('base64');
            }
            captchaImage = String(captchaImage).replace(/[^A-Za-z0-9+/=]/g, '');
            return `data:image/png;base64,${captchaImage}`;
        } catch (error) {
            console.error(`Captcha image error for ${browserId}:`, error);
            throw error;
        }
    }

    async refreshCaptcha(browserId) {
        const browserData = this.browsers.get(browserId);
        if (!browserData) throw new Error('Browser not found');
        
        try {
            await browserData.page.evaluate(() => {
                const img = document.getElementById('captcha');
                if (img) {
                    const timestamp = new Date().getTime();
                    img.src = './securimage/securimage_show.php?' + timestamp;
                }
                const input = document.getElementById('cap_code');
                if (input) input.value = '';
            });
            
            // Wait for new image to load
            await browserData.page.waitForTimeout(1000);
            browserData.lastCaptchaRefresh = Date.now();
            
            return true;
        } catch (error) {
            console.error(`[${browserId}] Error refreshing captcha:`, error);
            throw error;
        }
    }

    async submitCaptcha(browserId, captchaText) {
        const browserData = this.browsers.get(browserId);
        if (!browserData || !browserData.captchaRequired) {
            throw new Error('Invalid browser or no captcha required');
        }

        try {
            console.log(`[${browserId}] Submitting captcha...`);
            
            // Clear existing captcha input
            await browserData.page.evaluate(() => {
                const input = document.getElementById('cap_code');
                if (input) input.value = '';
            });
            
            // Fill in new captcha text
            await browserData.page.fill('#cap_code', captchaText);
            
            // Click submit button using direct element query
            await browserData.page.evaluate(() => {
                const submitBtn = document.querySelector('input[value*="Check Consumer No."]');
                if (submitBtn) submitBtn.click();
            });
            
            // Wait for response with longer timeout and check both conditions
            const result = await browserData.page.waitForFunction(() => {
                const billDetails = document.getElementById('detailconsnumber');
                const errorModal = document.getElementById('invalidcaptchmodal');
                const consumerName = document.getElementById('ConsumerName');
                
                return {
                    success: billDetails?.style.display !== 'none' && 
                            consumerName?.value !== undefined && 
                            consumerName?.value !== '',
                    error: errorModal?.classList.contains('in')
                };
            }, { timeout: 10000 });

            const { success, error } = await result.jsonValue();

            if (success) {
                // Bill details shown - captcha was correct
                browserData.captchaRequired = false;
                browserData.lastCaptchaRefresh = null;
                console.log(`[${browserId}] Captcha accepted, bill details visible`);
                return true;
            }
            
            if (error) {
                console.log(`[${browserId}] Invalid captcha detected`);
                await this.refreshCaptcha(browserId);
                throw new Error('Invalid captcha');
            }

            return false;
        } catch (error) {
            console.error(`[${browserId}] Error submitting captcha:`, error);
            throw error;
        }
    }

    async submitAndGetResults(browserId) {
        const browserData = this.browsers.get(browserId);
        if (!browserData) throw new Error('Browser not found');

        const { page } = browserData;

        try {
            // Add retry mechanism with delay
            let retries = 0;
            const maxRetries = 3;
            
            while (retries < maxRetries) {
                // Check if bill details are visible and populated
                const detailsVisible = await page.evaluate(() => {
                    const details = document.getElementById('detailconsnumber');
                    const consumerName = document.getElementById('ConsumerName');
                    return details?.style.display !== 'none' && 
                           consumerName?.value !== undefined && 
                           consumerName?.value !== '';
                });

                if (detailsVisible) {
                    console.log(`[${browserId}] Extracting billing data...`);
                    return await this.extractBillingData(page);
                }

                retries++;
                if (retries < maxRetries) {
                    console.log(`[${browserId}] Waiting for bill details to load (attempt ${retries})...`);
                    await page.waitForTimeout(2000); // Wait 2 seconds between checks
                }
            }

            throw new Error('Bill details not visible after retries');

        } catch (error) {
            console.error(`[${browserId}] Submit and results error:`, error);
            throw error;
        }
    }

    async extractBillingData(page) {
        try {
            // Wait for results table or content to load with longer timeout
            await page.waitForSelector('table.table-hover', { timeout: 10000 });
            await page.waitForTimeout(1000); // Extra wait for data to populate

            // Extract data based on the MGVCL page structure
            const data = await page.evaluate(() => {
                const result = {
                    consumerName: '',
                    consumerNo: '',
                    lastPaidDetail: '',
                    outstandingAmount: '',
                    billDate: '',
                    amountToPay: ''
                };

                // Find the main table with billing data
                const table = document.querySelector('table.table-hover');
                if (table) {
                    // Use a map of field labels to result keys for more reliable matching
                    const fieldMap = {
                        'Consumer Name': 'consumerName',
                        'CONSUMER NO.*': 'consumerNo',
                        'Last Paid Detail': 'lastPaidDetail',
                        'Outstanding Amount(Tentative)': 'outstandingAmount',
                        'Bill Date': 'billDate',
                        'Amount to Pay*': 'amountToPay'
                    };

                    // Process each row in the table
                    const rows = Array.from(table.querySelectorAll('tr'));
                    rows.forEach(row => {
                        const cells = row.querySelectorAll('td');
                        if (cells.length >= 3) {
                            const label = cells[1]?.innerText?.trim();
                            const input = cells[2]?.querySelector('input');
                            const value = input ? input.value?.trim() : cells[2]?.innerText?.trim();
                            
                            // Map the field to the corresponding result key
                            const resultKey = fieldMap[label];
                            if (resultKey && value) {
                                result[resultKey] = value;
                            }
                        }
                    });
                }

                // Double-check with direct ID selectors as fallback
                if (!result.consumerName) result.consumerName = document.getElementById('ConsumerName')?.value?.trim() || '';
                if (!result.consumerNo) result.consumerNo = document.getElementById('CUST_ID')?.value?.trim() || '';
                if (!result.lastPaidDetail) result.lastPaidDetail = document.getElementById('lastpaid')?.value?.trim() || '';
                if (!result.outstandingAmount) result.outstandingAmount = document.getElementById('billamt')?.value?.trim() || '';
                if (!result.billDate) result.billDate = document.getElementById('billdate')?.value?.trim() || '';
                if (!result.amountToPay) result.amountToPay = document.getElementById('payamount')?.value?.trim() || '';

                // Validate extraction
                const hasData = result.consumerName && result.consumerNo;
                if (!hasData) {
                    throw new Error('Failed to extract billing data');
                }

                return result;
            });

            // Add completion tracking
            this.completedExtractions = (this.completedExtractions || 0) + 1;
            if (this.completedExtractions === this.totalConsumers) {
                this.emit('extraction-complete');
            }

            return data;

        } catch (error) {
            console.error('Data extraction error:', error);
            throw error;
        }
    }

    setTotalConsumers(total) {
        this.totalConsumers = total;
        this.completedExtractions = 0;
    }

    async closeAll() {
        console.log('Closing all browsers...');
        
        for (const [browserId, browserData] of this.browsers) {
            try {
                await browserData.browser.close();
            } catch (error) {
                console.error(`Error closing browser ${browserId}:`, error);
            }
        }
        
        this.browsers.clear();
        this.availableBrowsers = [];
        this.busyBrowsers.clear();
        this.initialized = false;
        
        console.log('All browsers closed');
    }
}


// Add static properties
BrowserManager._initializing = false;
BrowserManager._initializationPromise = null;

module.exports = BrowserManager;

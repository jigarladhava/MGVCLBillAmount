const { chromium } = require('playwright');

class BrowserManager {
    constructor(maxBrowsers = 5) {
        this.maxBrowsers = maxBrowsers;
        this.browsers = new Map();
        this.availableBrowsers = [];
        this.busyBrowsers = new Set();
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) return;
        
        console.log(`Initializing ${this.maxBrowsers} browser instances...`);
        
        for (let i = 0; i < this.maxBrowsers; i++) {
            const browser = await chromium.launch({
                headless: false, // Set to true for production
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            
            const context = await browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            });
            
            const page = await context.newPage();
            
            const browserId = `browser_${i}`;
            this.browsers.set(browserId, {
                browser,
                context,
                page,
                busy: false
            });
            
            this.availableBrowsers.push(browserId);
        }
        
        this.initialized = true;
        console.log('All browsers initialized successfully');
    }

    async getAvailableBrowser() {
        if (!this.initialized) {
            await this.initialize();
        }
        
        // Wait for an available browser
        while (this.availableBrowsers.length === 0) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        const browserId = this.availableBrowsers.pop();
        this.busyBrowsers.add(browserId);
        this.browsers.get(browserId).busy = true;
        
        return browserId;
    }

    releaseBrowser(browserId) {
        if (this.busyBrowsers.has(browserId)) {
            this.busyBrowsers.delete(browserId);
            this.availableBrowsers.push(browserId);
            this.browsers.get(browserId).busy = false;
        }
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
            // Wait for captcha image using the exact selector
            await page.waitForSelector('img#captcha', { timeout: 5000 });

            // Get captcha image as base64
            const captchaElement = page.locator('img#captcha');
            const captchaImage = await captchaElement.screenshot({ encoding: 'base64' });

            return `data:image/png;base64,${captchaImage}`;

        } catch (error) {
            console.error(`Captcha image error for ${browserId}:`, error);
            throw error;
        }
    }

    async submitCaptcha(browserId, captchaText) {
        const browserData = this.browsers.get(browserId);
        if (!browserData) throw new Error('Browser not found');

        const { page } = browserData;

        try {
            // Use the exact captcha input field selector
            const captchaInputSelector = 'input#cap_code';
            await page.waitForSelector(captchaInputSelector, { timeout: 5000 });

            // Clear and enter captcha text
            await page.fill(captchaInputSelector, captchaText);
            await page.waitForTimeout(500);

            console.log(`Entered captcha: ${captchaText} in field #cap_code`);

        } catch (error) {
            console.error(`Captcha submission error for ${browserId}:`, error);
            throw error;
        }
    }

    async submitAndGetResults(browserId) {
        const browserData = this.browsers.get(browserId);
        if (!browserData) throw new Error('Browser not found');

        const { page } = browserData;

        try {
            // Click the submit button - look for the "Check Consumer No" button
            console.log('Clicking submit button...');
            await page.click('input[type="submit"]');

            // Wait for results to load - check for either success or error
            console.log('Waiting for response...');
            await page.waitForTimeout(5000);

            // Check for error alerts first
            const errorAlert = await page.locator('.alert, [id*="alert"], [class*="error"]').first();
            if (await errorAlert.count() > 0) {
                const errorText = await errorAlert.textContent();
                console.log('Error alert found:', errorText);
                if (errorText && errorText.toLowerCase().includes('invalid')) {
                    throw new Error(`Invalid consumer number or captcha: ${errorText}`);
                }
            }

            // Check for modal dialogs with error messages
            const modalAlert = await page.locator('.modal-body, .alert-danger').first();
            if (await modalAlert.count() > 0) {
                const modalText = await modalAlert.textContent();
                console.log('Modal alert found:', modalText);
                if (modalText && modalText.toLowerCase().includes('invalid')) {
                    throw new Error(`Invalid consumer number or captcha: ${modalText}`);
                }
            }

            console.log('Extracting billing data...');
            // Extract billing data
            const billingData = await this.extractBillingData(page);

            return billingData;

        } catch (error) {
            console.error(`Submit and results error for ${browserId}:`, error);
            throw error;
        }
    }

    async extractBillingData(page) {
        try {
            // Wait for results table or content to load
            await page.waitForTimeout(2000);

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

                // Look for the specific structure in MGVCL response
                // The data appears in a table format after successful submission

                // Try to find consumer name
                const consumerNameElement = document.querySelector('input[readonly], td:contains("Consumer Name"), th:contains("Consumer Name")');
                if (consumerNameElement) {
                    const nextElement = consumerNameElement.nextElementSibling || consumerNameElement.parentElement.nextElementSibling;
                    if (nextElement) {
                        result.consumerName = nextElement.textContent.trim();
                    }
                }

                // Try to extract from table structure
                const tables = document.querySelectorAll('table');
                tables.forEach(table => {
                    const rows = table.querySelectorAll('tr');
                    rows.forEach(row => {
                        const cells = row.querySelectorAll('td, th');
                        if (cells.length >= 2) {
                            const label = cells[0].textContent.toLowerCase().trim();
                            const value = cells[1].textContent.trim();

                            if (label.includes('consumer name')) {
                                result.consumerName = value;
                            } else if (label.includes('consumer no')) {
                                result.consumerNo = value;
                            } else if (label.includes('last paid')) {
                                result.lastPaidDetail = value;
                            } else if (label.includes('outstanding')) {
                                result.outstandingAmount = value;
                            } else if (label.includes('bill date')) {
                                result.billDate = value;
                            } else if (label.includes('amount to pay')) {
                                result.amountToPay = value;
                            }
                        }
                    });
                });

                // Also try to extract from input fields that might be populated
                const inputs = document.querySelectorAll('input[readonly], input[disabled]');
                inputs.forEach((input, index) => {
                    const value = input.value.trim();
                    if (value) {
                        // Try to identify the field based on nearby labels or position
                        const label = input.previousElementSibling || input.parentElement.previousElementSibling;
                        if (label) {
                            const labelText = label.textContent.toLowerCase();
                            if (labelText.includes('consumer name')) {
                                result.consumerName = value;
                            } else if (labelText.includes('amount')) {
                                result.amountToPay = value;
                            }
                        }
                    }
                });

                return result;
            });

            return data;

        } catch (error) {
            console.error('Data extraction error:', error);
            throw error;
        }
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

module.exports = BrowserManager;

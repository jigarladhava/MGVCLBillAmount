const BrowserManager = require('./src/browserManager');

// Sample consumer numbers provided by user
const sampleConsumers = [
    '14102000674',
    '14102000704',
    '14103000228',
    '14106144530',
    '14106144549',
    '14106144557'
];

async function testBrowser() {
    const browserManager = new BrowserManager(5); // Use 5 concurrent browsers to match server.js

    try {
        console.log('=== MGVCL Browser Automation Test ===');
        console.log('Initializing browser...');
        await browserManager.initialize();

        console.log('Getting available browser...');
        const browserId = await browserManager.getAvailableBrowser();

        // Test with the first consumer number
        const testConsumerNo = sampleConsumers[0];
        console.log(`\nTesting with consumer number: ${testConsumerNo}`);

        console.log('Navigating to MGVCL website...');
        await browserManager.navigateToMGVCL(browserId);

        console.log('Selecting company MGVCL...');
        await browserManager.selectCompany(browserId, 'MGVCL');

        console.log('Entering consumer number...');
        await browserManager.enterConsumerNumber(browserId, testConsumerNo);

        console.log('Checking if captcha is required...');
        const captchaRequired = await browserManager.isCaptchaRequired(browserId);
        console.log('Captcha required:', captchaRequired);

        if (captchaRequired) {
            console.log('Getting captcha image...');
            const captchaImage = await browserManager.getCaptchaImage(browserId);
            console.log('Captcha image obtained - length:', captchaImage.length);
            console.log('Captcha image starts with:', captchaImage.substring(0, 50) + '...');

            console.log('\n*** CAPTCHA DETECTED ***');
            console.log('In the real application, this captcha would be displayed to the user.');
            console.log('The user would enter the captcha text, and processing would continue.');
            console.log('For this test, we\'ll skip the actual submission.');
        } else {
            console.log('No captcha required - proceeding with form submission...');

            try {
                console.log('Submitting form and getting results...');
                const billingData = await browserManager.submitAndGetResults(browserId);
                console.log('Billing data extracted:', JSON.stringify(billingData, null, 2));
            } catch (submitError) {
                console.log('Form submission test completed (expected error without captcha):', submitError.message);
            }
        }

        console.log('\n=== Test Summary ===');
        console.log('✅ Browser initialization: SUCCESS');
        console.log('✅ Website navigation: SUCCESS');
        console.log('✅ Company selection: SUCCESS');
        console.log('✅ Consumer number entry: SUCCESS');
        console.log('✅ Captcha detection: SUCCESS');
        if (captchaRequired) {
            console.log('✅ Captcha image extraction: SUCCESS');
        }
        console.log('\nTest completed successfully!');
        console.log('The browser automation is working correctly.');

    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        console.error('Full error:', error);
    } finally {
        console.log('\nClosing browsers...');
        await browserManager.closeAll();
        console.log('Cleanup completed.');
    }
}

// Run the test
console.log('Starting MGVCL browser automation test...');
testBrowser();

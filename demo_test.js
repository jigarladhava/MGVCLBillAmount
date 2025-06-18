const BrowserManager = require('./src/browserManager');
const ExcelProcessor = require('./src/excelProcessor');

// Sample consumer numbers provided by user
const sampleConsumers = [
    '14102000674',
    '14102000704', 
    '14103000228'  // Testing with first 3 for demo
];

async function demonstrateSystem() {
    console.log('🚀 === MGVCL Bill Amount Extractor - Full System Demo ===\n');
    
    const browserManager = new BrowserManager(5); // Use 5 concurrent browsers to match server.js
    const excelProcessor = new ExcelProcessor();
    
    try {
        // Step 1: Initialize browsers
        console.log('📋 Step 1: Initializing browser instances...');
        await browserManager.initialize();
        console.log('✅ 5 browser instances initialized successfully\n');
        
        // Step 2: Create sample Excel file
        console.log('📋 Step 2: Creating sample Excel file...');
        const XLSX = require('xlsx');
        const data = [['Consumer Number'], ...sampleConsumers.map(num => [num])];
        const ws = XLSX.utils.aoa_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Consumers');
        XLSX.writeFile(wb, 'demo_consumers.xlsx');
        console.log('✅ Excel file created: demo_consumers.xlsx\n');
        
        // Step 3: Read consumer numbers from Excel
        console.log('📋 Step 3: Reading consumer numbers from Excel...');
        const consumerNumbers = await excelProcessor.readConsumerNumbers('demo_consumers.xlsx');
        console.log(`✅ Read ${consumerNumbers.length} consumer numbers:`, consumerNumbers, '\n');
        
        // Step 4: Process each consumer (demo mode - will stop at captcha)
        console.log('📋 Step 4: Processing consumers (Demo Mode)...\n');
        
        const results = [];
        
        for (let i = 0; i < Math.min(consumerNumbers.length, 2); i++) {
            const consumerNo = consumerNumbers[i];
            console.log(`🔄 Processing consumer ${i + 1}/${consumerNumbers.length}: ${consumerNo}`);
            
            try {
                // Get available browser
                const browserId = await browserManager.getAvailableBrowser();
                console.log(`   📱 Using browser: ${browserId}`);
                
                // Format consumer number
                const formattedConsumerNo = consumerNo.toString().padStart(11, '0');
                console.log(`   🔢 Formatted consumer number: ${formattedConsumerNo}`);
                
                // Navigate and fill form
                console.log('   🌐 Navigating to MGVCL website...');
                await browserManager.navigateToMGVCL(browserId);
                
                console.log('   🏢 Selecting company MGVCL...');
                await browserManager.selectCompany(browserId, 'MGVCL');
                
                console.log('   ⌨️  Entering consumer number...');
                await browserManager.enterConsumerNumber(browserId, formattedConsumerNo);
                
                // Check for captcha
                console.log('   🔍 Checking for captcha...');
                const captchaRequired = await browserManager.isCaptchaRequired(browserId);
                
                if (captchaRequired) {
                    console.log('   🖼️  Captcha detected! Getting captcha image...');
                    const captchaImage = await browserManager.getCaptchaImage(browserId);
                    console.log(`   ✅ Captcha image extracted (${captchaImage.length} characters)`);
                    
                    console.log('   ⏸️  DEMO MODE: Stopping here - In real usage, user would enter captcha');
                    console.log('   💡 The web interface would display this captcha for user input\n');
                    
                    results.push({
                        consumerNo: formattedConsumerNo,
                        status: 'Captcha Required',
                        captchaDetected: true
                    });
                } else {
                    console.log('   ✅ No captcha required - would proceed with submission');
                    results.push({
                        consumerNo: formattedConsumerNo,
                        status: 'Ready for Submission',
                        captchaDetected: false
                    });
                }
                
                // Release browser
                browserManager.releaseBrowser(browserId);
                console.log(`   🔓 Released browser: ${browserId}\n`);
                
            } catch (error) {
                console.error(`   ❌ Error processing ${consumerNo}:`, error.message);
                results.push({
                    consumerNo: consumerNo,
                    status: 'Error',
                    error: error.message
                });
            }
        }
        
        // Step 5: Generate results file
        console.log('📋 Step 5: Generating results file...');
        const outputPath = await excelProcessor.writeResults(results, 'demo_session');
        console.log(`✅ Results written to: ${outputPath}\n`);
        
        // Step 6: Display summary
        console.log('📊 === DEMO SUMMARY ===');
        console.log(`Total consumers processed: ${results.length}`);
        console.log(`Captcha required: ${results.filter(r => r.captchaDetected).length}`);
        console.log(`Ready for submission: ${results.filter(r => r.status === 'Ready for Submission').length}`);
        console.log(`Errors: ${results.filter(r => r.status === 'Error').length}`);
        
        console.log('\n🎯 === NEXT STEPS FOR REAL USAGE ===');
        console.log('1. Start the server: npm start');
        console.log('2. Open browser: http://localhost:3000');
        console.log('3. Upload the Excel file: demo_consumers.xlsx');
        console.log('4. Monitor progress and enter captchas when prompted');
        console.log('5. Download results when complete');
        
        console.log('\n✨ Demo completed successfully!');
        
    } catch (error) {
        console.error('\n❌ Demo failed:', error);
    } finally {
        console.log('\n🧹 Cleaning up...');
        await browserManager.closeAll();
        console.log('✅ Cleanup completed');
    }
}

// Run the demonstration
demonstrateSystem();

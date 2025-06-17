const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs-extra');

class ExcelProcessor {
    constructor() {
        this.resultsDir = './results';
        fs.ensureDirSync(this.resultsDir);
    }

    /**
     * Read consumer numbers from uploaded Excel file
     * @param {string} filePath - Path to the uploaded Excel file
     * @returns {Array} Array of consumer numbers
     */
    async readConsumerNumbers(filePath) {
        try {
            // Read the Excel file
            const workbook = XLSX.readFile(filePath);
            
            // Get the first worksheet
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            
            // Convert to JSON
            const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
            
            // Extract consumer numbers
            const consumerNumbers = [];
            
            // Skip header row and extract consumer numbers
            for (let i = 1; i < data.length; i++) {
                const row = data[i];
                if (row && row.length > 0) {
                    // Get the first column value (assuming consumer numbers are in first column)
                    const consumerNo = row[0];
                    if (consumerNo && consumerNo.toString().trim()) {
                        // Clean and validate consumer number
                        const cleanConsumerNo = consumerNo.toString().trim();
                        if (this.isValidConsumerNumber(cleanConsumerNo)) {
                            consumerNumbers.push(cleanConsumerNo);
                        }
                    }
                }
            }
            
            console.log(`Extracted ${consumerNumbers.length} consumer numbers from Excel file`);
            return consumerNumbers;
            
        } catch (error) {
            console.error('Error reading Excel file:', error);
            throw new Error(`Failed to read Excel file: ${error.message}`);
        }
    }

    /**
     * Validate consumer number format
     * @param {string} consumerNo - Consumer number to validate
     * @returns {boolean} True if valid
     */
    isValidConsumerNumber(consumerNo) {
        // Remove any non-numeric characters
        const numericOnly = consumerNo.replace(/\D/g, '');
        
        // Check if it's a valid number and has reasonable length (typically 8-12 digits)
        return numericOnly.length >= 6 && numericOnly.length <= 15;
    }

    /**
     * Format consumer number with leading zeros if needed
     * @param {string} consumerNo - Consumer number to format
     * @returns {string} Formatted consumer number
     */
    formatConsumerNumber(consumerNo) {
        const numericOnly = consumerNo.replace(/\D/g, '');
        // Pad with leading zeros to make it 11 digits if less than 11
        return numericOnly.length < 11 ? numericOnly.padStart(11, '0') : numericOnly;
    }

    /**
     * Write results to Excel file
     * @param {Array} results - Array of billing data results
     * @param {string} sessionId - Session ID for filename
     * @returns {string} Path to the created Excel file
     */
    async writeResults(results, sessionId) {
        try {
            // Prepare data for Excel
            const excelData = [];
            
            // Add header row
            excelData.push([
                'Consumer Name',
                'Consumer No.',
                'Last Paid Detail',
                'Outstanding Amount (Tentative)',
                'Bill Date',
                'Amount to Pay',
                'Status',
                'Error Message'
            ]);
            
            // Add data rows
            results.forEach(result => {
                if (result.error) {
                    // Error case
                    excelData.push([
                        '',
                        result.consumerNo || '',
                        '',
                        '',
                        '',
                        '',
                        'Error',
                        result.error
                    ]);
                } else {
                    // Success case
                    excelData.push([
                        result.consumerName || '',
                        result.consumerNo || '',
                        result.lastPaidDetail || '',
                        result.outstandingAmount || '',
                        result.billDate || '',
                        result.amountToPay || '',
                        'Success',
                        ''
                    ]);
                }
            });
            
            // Create workbook and worksheet
            const workbook = XLSX.utils.book_new();
            const worksheet = XLSX.utils.aoa_to_sheet(excelData);
            
            // Set column widths
            const columnWidths = [
                { wch: 25 }, // Consumer Name
                { wch: 15 }, // Consumer No.
                { wch: 20 }, // Last Paid Detail
                { wch: 20 }, // Outstanding Amount
                { wch: 15 }, // Bill Date
                { wch: 15 }, // Amount to Pay
                { wch: 10 }, // Status
                { wch: 30 }  // Error Message
            ];
            worksheet['!cols'] = columnWidths;
            
            // Add worksheet to workbook
            XLSX.utils.book_append_sheet(workbook, worksheet, 'MGVCL Billing Data');
            
            // Generate filename with timestamp
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `MGVCL_Results_${sessionId}_${timestamp}.xlsx`;
            const outputPath = path.join(this.resultsDir, filename);
            
            // Write file
            XLSX.writeFile(workbook, outputPath);
            
            console.log(`Results written to: ${outputPath}`);
            return outputPath;
            
        } catch (error) {
            console.error('Error writing Excel file:', error);
            throw new Error(`Failed to write Excel file: ${error.message}`);
        }
    }

    /**
     * Create sample Excel template for consumer numbers
     * @returns {string} Path to the created template file
     */
    async createSampleTemplate() {
        try {
            const templateData = [
                ['Consumer Number'],
                ['12345678901'],
                ['98765432109'],
                ['11223344556']
            ];
            
            const workbook = XLSX.utils.book_new();
            const worksheet = XLSX.utils.aoa_to_sheet(templateData);
            
            // Set column width
            worksheet['!cols'] = [{ wch: 20 }];
            
            XLSX.utils.book_append_sheet(workbook, worksheet, 'Consumer Numbers');
            
            const templatePath = path.join(this.resultsDir, 'consumer_numbers_template.xlsx');
            XLSX.writeFile(workbook, templatePath);
            
            return templatePath;
            
        } catch (error) {
            console.error('Error creating template:', error);
            throw error;
        }
    }

    /**
     * Get statistics from results
     * @param {Array} results - Array of results
     * @returns {Object} Statistics object
     */
    getStatistics(results) {
        const stats = {
            total: results.length,
            successful: 0,
            failed: 0,
            totalAmount: 0
        };
        
        results.forEach(result => {
            if (result.error) {
                stats.failed++;
            } else {
                stats.successful++;
                
                // Try to extract numeric amount from amountToPay
                if (result.amountToPay) {
                    const amount = parseFloat(result.amountToPay.replace(/[^\d.]/g, ''));
                    if (!isNaN(amount)) {
                        stats.totalAmount += amount;
                    }
                }
            }
        });
        
        return stats;
    }

    /**
     * Clean up old files
     * @param {number} maxAgeHours - Maximum age in hours
     */
    async cleanupOldFiles(maxAgeHours = 24) {
        try {
            const files = await fs.readdir(this.resultsDir);
            const now = Date.now();
            const maxAge = maxAgeHours * 60 * 60 * 1000; // Convert to milliseconds
            
            for (const file of files) {
                const filePath = path.join(this.resultsDir, file);
                const stats = await fs.stat(filePath);
                
                if (now - stats.mtime.getTime() > maxAge) {
                    await fs.remove(filePath);
                    console.log(`Cleaned up old file: ${file}`);
                }
            }
            
        } catch (error) {
            console.error('Error during cleanup:', error);
        }
    }
}

module.exports = ExcelProcessor;

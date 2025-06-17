# MGVCL Bill Amount Extractor

A Node.js application with web interface for extracting billing data from MGVCL (Madhya Gujarat Vij Company Limited) website using automated browser instances.

## Features

- **Multi-browser Support**: Handles up to 5 concurrent Playwright browser instances
- **Real-time Captcha Handling**: User can continuously enter captchas as required
- **Excel File Processing**: Upload Excel files with consumer numbers and download results
- **Web Interface**: Modern, responsive web UI for easy operation
- **Real-time Updates**: Live status updates and progress tracking
- **Error Handling**: Comprehensive error handling and logging

## Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- Windows/Linux/macOS

## Installation

1. Clone or download the project
2. Navigate to the project directory
3. Install dependencies:
   ```bash
   npm install
   ```
4. Install Playwright browsers:
   ```bash
   npx playwright install
   ```

## Usage

### Starting the Application

1. Start the server:
   ```bash
   npm start
   ```
2. Open your web browser and go to: `http://localhost:3000`

### Using the Web Interface

1. **Upload Excel File**: 
   - Click "Choose Excel File" and select your file
   - File should contain consumer numbers in the first column
   - Supported formats: .xlsx, .xls

2. **Processing**:
   - Click "Start Processing" to begin
   - The system will open up to 5 browser instances
   - Monitor progress in real-time

3. **Captcha Handling**:
   - When captcha is required, it will appear on the screen
   - Enter the captcha text and click "Submit"
   - Continue entering captchas as they appear

4. **Download Results**:
   - Once processing is complete, click "Download Results"
   - Results will be downloaded as an Excel file

### Excel File Format

Your input Excel file should have consumer numbers in the first column:

```
Consumer Number
12345678901
98765432109
11223344556
```

**Note**: Consumer numbers less than 11 digits will be automatically padded with leading zeros.

### Output Data

The application extracts the following information for each consumer:

- Consumer Name
- Consumer No.
- Last Paid Detail
- Outstanding Amount (Tentative)
- Bill Date
- Amount to Pay

## File Structure

```
├── server.js              # Main server file
├── src/
│   ├── browserManager.js  # Browser automation logic
│   └── excelProcessor.js  # Excel file handling
├── public/
│   ├── index.html         # Web interface
│   ├── styles.css         # Styling
│   └── app.js            # Frontend JavaScript
├── uploads/               # Uploaded files directory
├── results/               # Generated results directory
└── README.md             # This file
```

## API Endpoints

- `GET /` - Web interface
- `POST /upload` - Upload Excel file and start processing
- `GET /status/:sessionId` - Get processing status
- `GET /download/:sessionId` - Download results

## Browser Configuration

The application uses Playwright with Chromium browsers. Browsers are configured with:
- Non-headless mode (for captcha visibility)
- Standard viewport (1280x720)
- User agent spoofing for compatibility

## Error Handling

The application handles various error scenarios:
- Invalid consumer numbers
- Network timeouts
- Captcha failures
- File processing errors

All errors are logged and displayed in the web interface.

## Development

### Testing Browser Automation

Run the browser test script:
```bash
node test_browser.js
```

### Debugging

- Check browser console for frontend errors
- Monitor server logs for backend issues
- Use browser developer tools for network debugging

## Troubleshooting

### Common Issues

1. **Browsers not opening**: Ensure Playwright is properly installed
2. **Captcha not displaying**: Check network connectivity to MGVCL website
3. **File upload fails**: Verify file format and size
4. **Processing stuck**: Check for browser crashes or network issues

### Performance Tips

- Close unnecessary applications to free up memory
- Ensure stable internet connection
- Process smaller batches for better performance

## Security Notes

- The application runs browsers in non-headless mode for captcha handling
- No sensitive data is stored permanently
- Uploaded files are cleaned up after processing

## License

This project is for educational and legitimate business use only. Ensure compliance with MGVCL's terms of service.

## Support

For issues or questions, check the application logs and browser console for error messages.

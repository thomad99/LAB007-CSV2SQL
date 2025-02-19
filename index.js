const express = require('express');
const dotenv = require('dotenv');
const multer = require('multer');
const { parse } = require('csv-parse');
const fs = require('fs');
const path = require('path');
const pool = require('./config/database.js');

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Multer configuration for file upload
const upload = multer({ dest: 'uploads/' });

// Middleware
app.use(express.json());
app.use(express.static('public')); // Serve static files from public directory

// Routes
app.get('/api/status', (req, res) => {
  res.json({
    message: 'Welcome to CSV2POSTGRES Service',
    status: 'running'
  });
});

// Upload and process CSV route
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const results = [];
    fs.createReadStream(req.file.path)
      .pipe(parse({
        columns: true,
        skip_empty_lines: true
      }))
      .on('data', (data) => results.push(data))
      .on('end', async () => {
        try {
          // Assuming first row contains column names
          if (results.length > 0) {
            const columns = Object.keys(results[0]);
            const tableName = req.body.tableName || 'imported_data';

            // Create table if not exists
            const createTableQuery = `CREATE TABLE IF NOT EXISTS ${tableName} (
              ${columns.map(col => `"${col}" TEXT`).join(', ')}
            )`;
            await pool.query(createTableQuery);

            // Insert data
            for (const row of results) {
              const values = columns.map(col => row[col]);
              const insertQuery = `
                INSERT INTO ${tableName} (${columns.map(col => `"${col}"`).join(', ')})
                VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
              `;
              await pool.query(insertQuery, values);
            }

            // Clean up uploaded file
            fs.unlinkSync(req.file.path);

            res.json({
              message: 'CSV data successfully imported to PostgreSQL',
              rowsImported: results.length
            });
          }
        } catch (error) {
          console.error('Database error:', error);
          res.status(500).json({ error: 'Database operation failed' });
        }
      });
  } catch (error) {
    console.error('File processing error:', error);
    res.status(500).json({ error: 'File processing failed' });
  }
});

// Serve the HTML page for any other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(port, () => {
  console.log(`CSV2POSTGRES Service is running on port ${port}`);
}); 

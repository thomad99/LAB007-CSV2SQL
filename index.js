const express = require('express');
const dotenv = require('dotenv');
const multer = require('multer');
const { parse } = require('csv-parse');
const fs = require('fs');
const path = require('path');
const pool = require('./config/database.js');
const { Pool } = require('pg');

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

// Chat endpoint
app.post('/api/chat', async (req, res) => {
    const { query } = req.body;
    
    try {
        // Simple keyword-based query parsing
        const lowerQuery = query.toLowerCase();
        let sqlQuery = '';
        let params = [];

        if (lowerQuery.includes('sailor') && lowerQuery.includes('race')) {
            // Extract sailor name from query
            const nameMatch = query.match(/sailor\s+([A-Za-z\s]+)(?=\s+(?:do|perform|race))/i);
            if (nameMatch) {
                const sailorName = nameMatch[1].trim();
                sqlQuery = `
                    SELECT 
                        races.date,
                        races.name as race_name,
                        sailors.name as sailor_name,
                        results.position,
                        results.points
                    FROM results
                    JOIN races ON results.race_id = races.id
                    JOIN sailors ON results.sailor_id = sailors.id
                    WHERE LOWER(sailors.name) LIKE LOWER($1)
                    ORDER BY races.date DESC
                `;
                params = [`%${sailorName}%`];
            }
        }

        if (sqlQuery) {
            const result = await pool.query(sqlQuery, params);
            res.json({
                message: `Here are the results for your query:`,
                data: result.rows
            });
        } else {
            res.json({
                message: "I'm not sure how to answer that question. Try asking about a sailor's race results."
            });
        }
    } catch (error) {
        console.error('Chat query error:', error);
        res.status(500).json({ error: 'Failed to process your question' });
    }
});

// Update the root route to serve the chat interface
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

// Serve the HTML page for any other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(port, () => {
  console.log(`CSV2POSTGRES Service is running on port ${port}`);
}); 

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

// Define routes in correct order
// 1. API routes
app.get('/api/status', (req, res) => {
  res.json({
    message: 'Welcome to CSV2POSTGRES Service',
    status: 'running'
  });
});

app.post('/api/chat', async (req, res) => {
    const { query } = req.body;
    
    try {
        const lowerQuery = query.toLowerCase();
        let sqlQuery = '';
        let params = [];

        if (lowerQuery.includes('sailor') && lowerQuery.includes('race')) {
            // Extract sailor name from query
            const nameMatch = query.match(/sailor\s+([A-Za-z\s]+)(?=\s+(?:do|perform|race))/i);
            if (nameMatch) {
                const sailorName = nameMatch[1].trim();
                
                if (lowerQuery.includes('this year')) {
                    sqlQuery = `
                        SELECT 
                            TO_CHAR(races.date, 'YYYY-MM-DD') as race_date,
                            races.name as race_name,
                            sailors.name as sailor_name,
                            results.position,
                            results.points
                        FROM results
                        JOIN races ON results.race_id = races.id
                        JOIN sailors ON results.sailor_id = sailors.id
                        WHERE LOWER(sailors.name) LIKE LOWER($1)
                        AND EXTRACT(YEAR FROM races.date) = EXTRACT(YEAR FROM CURRENT_DATE)
                        ORDER BY races.date ASC
                    `;
                } else {
                    sqlQuery = `
                        SELECT 
                            TO_CHAR(races.date, 'YYYY-MM-DD') as race_date,
                            races.name as race_name,
                            sailors.name as sailor_name,
                            results.position,
                            results.points
                        FROM results
                        JOIN races ON results.race_id = races.id
                        JOIN sailors ON results.sailor_id = sailors.id
                        WHERE LOWER(sailors.name) LIKE LOWER($1)
                        ORDER BY races.date ASC
                    `;
                }
                params = [`%${sailorName}%`];
            }
        }

        if (sqlQuery) {
            const result = await pool.query(sqlQuery, params);
            let message = 'Here are the results for your query:';
            
            if (result.rows.length === 0) {
                message = 'No results found for your query.';
            } else if (result.rows[0].sailor_name) {
                const sailor = result.rows[0].sailor_name;
                const races = result.rows.length;
                const avgPosition = (result.rows.reduce((sum, row) => sum + parseInt(row.position), 0) / races).toFixed(1);
                message = `Found ${races} races for ${sailor}. Average position: ${avgPosition}`;
            }

            res.json({
                message,
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

// 2. File upload route
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

// 3. Page routes in specific order
app.get('/chat', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

app.get('/upload', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 4. Root route
app.get('/', (req, res) => {
    res.redirect('/chat');
});

// 5. Move catch-all route to the very end
app.get('*', (req, res) => {
    res.redirect('/'); // Redirect unknown routes to home
});

// Start server
app.listen(port, () => {
  console.log(`CSV2POSTGRES Service is running on port ${port}`);
}); 

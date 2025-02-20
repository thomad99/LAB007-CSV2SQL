const express = require('express');
const dotenv = require('dotenv');
const multer = require('multer');
const { parse } = require('csv-parse');
const fs = require('fs');
const path = require('path');
const pool = require('./config/database.js');
const OpenAI = require('openai');

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Multer configuration for file upload
const upload = multer({ dest: 'uploads/' });

// Middleware
app.use(express.json());
app.use(express.static('public')); // Serve static files from public directory

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Function to analyze query using GPT
async function analyzeQuery(query) {
    try {
        if (!process.env.OPENAI_API_KEY) {
            console.error('OpenAI API key is not set');
            throw new Error('OpenAI API key is not configured');
        }

        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                {
                    role: "system",
                    content: `You are a SQL query analyzer. Extract information from natural language queries about sailing races and results.
                    Return JSON with these fields:
                    - sailorName: the name of the sailor (if mentioned)
                    - timeFrame: "this_year", "specific_date", or "all_time"
                    - date: specific date if mentioned (YYYY-MM-DD format)
                    - queryType: "race_results", "performance_summary", or "ranking"
                    - additionalFilters: any other relevant filters mentioned`
                },
                {
                    role: "user",
                    content: query
                }
            ],
            temperature: 0.1,
        });

        return JSON.parse(completion.choices[0].message.content);
    } catch (error) {
        console.error('GPT Analysis error:', error);
        throw error; // Propagate the error with details
    }
}

// Function to generate SQL based on analysis
function generateSQL(analysis) {
    let baseQuery = `
        SELECT 
            TO_CHAR(races.date, 'YYYY-MM-DD') as race_date,
            races.name as race_name,
            sailors.name as sailor_name,
            results.position,
            results.points
        FROM results
        JOIN races ON results.race_id = races.id
        JOIN sailors ON results.sailor_id = sailors.id
        WHERE 1=1
    `;

    const params = [];
    let paramCount = 1;

    if (analysis.sailorName) {
        params.push(`%${analysis.sailorName}%`);
        baseQuery += `\nAND LOWER(sailors.name) LIKE LOWER($${paramCount++})`;
    }

    if (analysis.timeFrame === 'this_year') {
        baseQuery += `\nAND EXTRACT(YEAR FROM races.date) = EXTRACT(YEAR FROM CURRENT_DATE)`;
    } else if (analysis.timeFrame === 'specific_date') {
        params.push(analysis.date);
        baseQuery += `\nAND races.date = $${paramCount++}`;
    }

    baseQuery += '\nORDER BY races.date ASC';

    return { query: baseQuery, params };
}

// Define routes in correct order
// 1. API routes
app.get('/api/status', (req, res) => {
  res.json({
    message: 'Welcome to CSV2POSTGRES Service',
    status: 'running'
  });
});

app.post('/api/chat', async (req, res) => {
    console.log('Chat API called with query:', req.body.query);
    const { query } = req.body;
    
    try {
        // Verify OpenAI configuration
        if (!process.env.OPENAI_API_KEY) {
            throw new Error('OpenAI API key is not configured');
        }

        // Analyze query using GPT
        const analysis = await analyzeQuery(query);
        console.log('GPT Analysis:', analysis);

        if (!analysis) {
            return res.json({
                message: "I'm having trouble understanding your question. Could you rephrase it?"
            });
        }

        // Generate SQL based on analysis
        const { query: sqlQuery, params } = generateSQL(analysis);
        console.log('Generated SQL:', sqlQuery);
        console.log('Parameters:', params);

        // Execute query
        const result = await pool.query(sqlQuery, params);
        console.log('Query results:', result.rows.length, 'rows found');

        // Generate response
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

    } catch (error) {
        console.error('Chat query error:', error);
        res.status(500).json({ 
            error: 'Failed to process your question',
            details: error.message 
        });
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
app.get('/upload', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 4. Root route (serve chat page by default)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

// 5. Move catch-all route to the very end
app.get('*', (req, res) => {
    res.redirect('/');
});

// Start server
app.listen(port, () => {
  console.log(`CSV2POSTGRES Service is running on port ${port}`);
}); 

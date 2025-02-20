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
        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                {
                    role: "system",
                    content: `You are a SQL query analyzer for a sailing database. Extract information from natural language queries.
                    Return JSON with these fields:
                    - queryType: one of:
                        "winner" (for queries about who won a specific race)
                        "winners_list" (for queries about multiple race winners)
                        "most_wins" (for queries about who won the most)
                        "sailor_results" (for race results of a sailor)
                        "regatta_results" (for results of a specific regatta)
                        "team_results" (for results by yacht club)
                    - sailorName: the sailor's name if mentioned
                    - regattaName: the regatta/race name if mentioned
                    - yachtClub: the team/club name if mentioned
                    - year: specific year if mentioned (YYYY format)
                    - timeFrame: "this_year", "specific_year", or "all_time"
                    Example queries:
                    "Who won Sailfest 2024?" -> {"queryType": "winner", "regattaName": "Sailfest", "year": "2024"}
                    "Show me the winners of all races in 2024" -> {"queryType": "winners_list", "year": "2024"}
                    "who won the most races in 2023" -> {"queryType": "most_wins", "year": "2023"}
                    "show me all race results for John in 2024" -> {"queryType": "sailor_results", "sailorName": "John", "year": "2024"}
                    "What were the results from Sailfest?" -> {"queryType": "regatta_results", "regattaName": "Sailfest"}`
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
        throw error;
    }
}

// Function to generate SQL based on analysis
function generateSQL(analysis) {
    let baseQuery = '';
    const params = [];
    let paramCount = 1;

    switch (analysis.queryType) {
        case "most_wins":
            baseQuery = `
                SELECT 
                    skippers.name as skipper_name,
                    skippers.yacht_club,
                    COUNT(*) as wins,
                    array_agg(races.regatta_name) as races_won
                FROM results
                JOIN races ON results.race_id = races.id
                JOIN skippers ON results.skipper_id = skippers.id
                WHERE position = 1
            `;
            break;

        case "winners_list":
            baseQuery = `
                SELECT 
                    TO_CHAR(races.regatta_date, 'YYYY-MM-DD') as race_date,
                    races.regatta_name,
                    skippers.name as skipper_name,
                    skippers.yacht_club,
                    races.category
                FROM results
                JOIN races ON results.race_id = races.id
                JOIN skippers ON results.skipper_id = skippers.id
                WHERE position = 1
            `;
            break;

        default:
            baseQuery = `
                SELECT 
                    TO_CHAR(races.regatta_date, 'YYYY-MM-DD') as race_date,
                    races.regatta_name,
                    races.category,
                    races.boat_name,
                    races.sail_number,
                    skippers.name as skipper_name,
                    skippers.yacht_club,
                    results.position,
                    results.total_points
                FROM results
                JOIN races ON results.race_id = races.id
                JOIN skippers ON results.skipper_id = skippers.id
                WHERE 1=1
            `;
    }

    // Add specific conditions based on analysis
    if (analysis.sailorName) {
        params.push(`%${analysis.sailorName}%`);
        baseQuery += `\nAND LOWER(skippers.name) LIKE LOWER($${paramCount++})`;
    }

    if (analysis.regattaName) {
        params.push(`%${analysis.regattaName}%`);
        baseQuery += `\nAND LOWER(races.regatta_name) LIKE LOWER($${paramCount++})`;
    }

    if (analysis.year) {
        baseQuery += `\nAND EXTRACT(YEAR FROM races.regatta_date) = ${analysis.year}`;
    } else if (analysis.timeFrame === 'this_year') {
        baseQuery += `\nAND EXTRACT(YEAR FROM races.regatta_date) = EXTRACT(YEAR FROM CURRENT_DATE)`;
    }

    if (analysis.queryType === "winner") {
        baseQuery += `\nAND results.position = 1`;
    }

    // Add appropriate ordering
    switch (analysis.queryType) {
        case "most_wins":
            baseQuery += '\nGROUP BY skippers.name, skippers.yacht_club';
            baseQuery += '\nORDER BY wins DESC';
            break;
        case "winners_list":
            baseQuery += '\nORDER BY races.regatta_date DESC';
            break;
        default:
            baseQuery += '\nORDER BY races.regatta_date DESC, results.position ASC';
    }

    return { query: baseQuery, params };
}

// Add this function to create tables if they don't exist
async function initializeDatabase() {
    try {
        // Drop existing tables in correct order
        await pool.query(`
            DROP TABLE IF EXISTS results CASCADE;
            DROP TABLE IF EXISTS races CASCADE;
            DROP TABLE IF EXISTS skippers CASCADE;
        `);

        // Create new tables with nullable fields
        await pool.query(`
            CREATE TABLE IF NOT EXISTS races (
                id SERIAL PRIMARY KEY,
                regatta_name VARCHAR(100),
                regatta_date DATE,
                category VARCHAR(50),
                boat_name VARCHAR(100),
                sail_number VARCHAR(20)
            );

            CREATE TABLE IF NOT EXISTS skippers (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL UNIQUE,
                yacht_club VARCHAR(100)
            );

            CREATE TABLE IF NOT EXISTS results (
                id SERIAL PRIMARY KEY,
                race_id INTEGER REFERENCES races(id),
                skipper_id INTEGER REFERENCES skippers(id),
                position INTEGER,
                total_points DECIMAL(5,2)
            );
        `);
        console.log('Database tables initialized successfully');
    } catch (error) {
        console.error('Database initialization error:', error);
        throw error;
    }
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
                    for (const row of results) {
                        // First, ensure the skipper exists
                        const skipperResult = await pool.query(
                            'INSERT INTO skippers (name, yacht_club) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET yacht_club = EXCLUDED.yacht_club RETURNING id',
                            [row.Skipper || null, row.Yacht_Club || null]
                        );
                        const skipperId = skipperResult.rows[0].id;

                        // Then, create the race entry
                        const raceResult = await pool.query(
                            'INSERT INTO races (regatta_name, regatta_date, category, boat_name, sail_number) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                            [
                                row.Regatta_Name || null,
                                row.Regatta_Date || null,
                                row.Category || null,
                                row.Boat_Name || null,
                                row.Sail_Number || null
                            ]
                        );
                        const raceId = raceResult.rows[0].id;

                        // Handle empty numeric values
                        const position = row.Position ? parseInt(row.Position) : null;
                        const totalPoints = row.Total_Points ? parseFloat(row.Total_Points) : null;

                        // Finally, store the result
                        await pool.query(
                            'INSERT INTO results (race_id, skipper_id, position, total_points) VALUES ($1, $2, $3, $4)',
                            [raceId, skipperId, position, totalPoints]
                        );
                    }

                    // Clean up uploaded file
                    fs.unlinkSync(req.file.path);

                    res.json({
                        message: 'Regatta results successfully imported',
                        rowsImported: results.length
                    });
                } catch (error) {
                    console.error('Database error:', error);
                    res.status(500).json({ 
                        error: 'Database operation failed',
                        details: error.message 
                    });
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

// Call this function when the server starts
app.listen(port, async () => {
    try {
        await initializeDatabase();
        console.log(`CSV2POSTGRES Service is running on port ${port}`);
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}); 

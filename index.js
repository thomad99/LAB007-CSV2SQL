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

// Add this near the top of the file with other constants
const ENABLE_DB_WIPE = false; // Safety switch - must be manually enabled to allow any data deletion

// Add these safety functions
async function checkDatabaseHasData() {
    const result = await pool.query(`
        SELECT 
            (SELECT COUNT(*) FROM races) as race_count,
            (SELECT COUNT(*) FROM skippers) as skipper_count,
            (SELECT COUNT(*) FROM results) as result_count
    `);
    return result.rows[0];
}

async function backupTableData(tableName) {
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, "");
    const backupTable = `${tableName}_backup_${timestamp}`;
    await pool.query(`CREATE TABLE IF NOT EXISTS ${backupTable} AS SELECT * FROM ${tableName}`);
    return backupTable;
}

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
                        "winner" (for queries about race winners)
                        "sailor_search" (for finding/listing sailors)
                        "sailor_stats" (for sailor performance stats)
                        "team_members" (for listing team members)
                        "team_results" (for team performance)
                        "regatta_count" (for counting/listing regattas)
                        "regatta_results" (for specific regatta results)
                        "location_races" (for races at a location)
                        "database_status" (for database stats/freshness)
                        "performance_stats" (for rankings/performance analysis)
                    - sailorName: sailor's name if mentioned
                    - regattaName: regatta/event name if mentioned
                    - yachtClub: team/club name if mentioned
                    - location: race location if mentioned
                    - year: specific year if mentioned (YYYY format)
                    - position: specific position mentioned (e.g., "top 3", "first place")
                    - timeFrame: "this_year", "specific_year", "all_time", "recent"
                    Example queries:
                    "Show me all sailors in SYC" -> {"queryType": "team_members", "yachtClub": "SYC"}
                    "Who has the most wins?" -> {"queryType": "performance_stats", "timeFrame": "all_time"}
                    "Show me top 3 finishes for John" -> {"queryType": "sailor_stats", "sailorName": "John", "position": "3"}`
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
        case "sailor_stats":
            baseQuery = `
                SELECT 
                    s.name as sailor_name,
                    s.yacht_club,
                    COUNT(DISTINCT r.id) as total_races,
                    COUNT(DISTINCT CASE WHEN res.position = 1 THEN r.id END) as wins,
                    COUNT(DISTINCT CASE WHEN res.position <= 3 THEN r.id END) as podiums,
                    ROUND(AVG(res.position), 1) as avg_position,
                    MIN(res.position) as best_position,
                    array_agg(DISTINCT r.regatta_name) as regattas
                FROM skippers s
                LEFT JOIN results res ON s.id = res.skipper_id
                LEFT JOIN races r ON res.race_id = r.id
                WHERE 1=1
                GROUP BY s.id, s.name, s.yacht_club
            `;
            break;

        case "performance_stats":
            baseQuery = `
                WITH sailor_stats AS (
                    SELECT 
                        s.name,
                        s.yacht_club,
                        COUNT(DISTINCT r.id) as races,
                        COUNT(DISTINCT CASE WHEN res.position = 1 THEN r.id END) as wins,
                        ROUND(COUNT(DISTINCT CASE WHEN res.position = 1 THEN r.id END)::numeric / 
                              NULLIF(COUNT(DISTINCT r.id), 0) * 100, 1) as win_percentage
                    FROM skippers s
                    LEFT JOIN results res ON s.id = res.skipper_id
                    LEFT JOIN races r ON res.race_id = r.id
                    GROUP BY s.id, s.name, s.yacht_club
                )
                SELECT *
                FROM sailor_stats
                WHERE races > 0
                ORDER BY wins DESC, win_percentage DESC
            `;
            break;

        case "regatta_count":
            baseQuery = `
                SELECT 
                    COUNT(DISTINCT regatta_name) as regatta_count,
                    array_agg(DISTINCT regatta_name) as regatta_list
                FROM races
                WHERE 1=1
            `;
            break;

        case "sailor_search":
            baseQuery = `
                SELECT DISTINCT
                    skippers.name,
                    skippers.yacht_club,
                    COUNT(DISTINCT races.id) as total_races,
                    MIN(races.regatta_date) as first_race,
                    MAX(races.regatta_date) as last_race
                FROM skippers
                LEFT JOIN results ON skippers.id = results.skipper_id
                LEFT JOIN races ON results.race_id = races.id
                WHERE 1=1
                GROUP BY skippers.id, skippers.name, skippers.yacht_club
            `;
            break;

        case "database_status":
            baseQuery = `
                SELECT 
                    COUNT(DISTINCT regatta_name) as total_regattas,
                    COUNT(DISTINCT skippers.id) as total_sailors,
                    MIN(regatta_date) as earliest_race,
                    MAX(regatta_date) as latest_race,
                    COUNT(DISTINCT yacht_club) as total_clubs
                FROM races
                LEFT JOIN results ON races.id = results.race_id
                LEFT JOIN skippers ON results.skipper_id = skippers.id
            `;
            break;

        case "location_races":
            baseQuery = `
                SELECT 
                    regatta_name,
                    regatta_date,
                    COUNT(DISTINCT results.skipper_id) as participants
                FROM races
                LEFT JOIN results ON races.id = results.race_id
                WHERE 1=1
                GROUP BY regatta_name, regatta_date
                ORDER BY regatta_date DESC
            `;
            break;

        case "team_members":
            baseQuery = `
                SELECT 
                    skippers.name,
                    COUNT(DISTINCT races.id) as races_participated,
                    array_agg(DISTINCT races.regatta_name) as regattas,
                    MIN(results.position) as best_position
                FROM skippers
                LEFT JOIN results ON skippers.id = results.skipper_id
                LEFT JOIN races ON results.race_id = races.id
                WHERE 1=1
                GROUP BY skippers.id, skippers.name
                ORDER BY races_participated DESC
            `;
            break;

        case "team_results":
            baseQuery = `
                SELECT 
                    races.regatta_date,
                    races.regatta_name,
                    skippers.name as skipper,
                    results.position,
                    races.category
                FROM results
                JOIN races ON results.race_id = races.id
                JOIN skippers ON results.skipper_id = skippers.id
                WHERE 1=1
                ORDER BY races.regatta_date DESC, results.position ASC
            `;
            break;

        case "winner":
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
                    TO_CHAR(r.regatta_date, 'YYYY-MM-DD') as race_date,
                    r.regatta_name,
                    r.category,
                    s.name as skipper_name,
                    s.yacht_club,
                    res.position,
                    res.total_points
                FROM results res
                JOIN races r ON res.race_id = r.id
                JOIN skippers s ON res.skipper_id = s.id
                WHERE 1=1
            `;
    }

    // Add conditions
    if (analysis.sailorName) {
        params.push(`%${analysis.sailorName}%`);
        baseQuery += `\nAND LOWER(s.name) LIKE LOWER($${paramCount++})`;
    }

    if (analysis.yachtClub) {
        params.push(`%${analysis.yachtClub}%`);
        baseQuery += `\nAND LOWER(s.yacht_club) LIKE LOWER($${paramCount++})`;
    }

    if (analysis.position) {
        const pos = parseInt(analysis.position);
        if (!isNaN(pos)) {
            baseQuery += `\nAND res.position <= ${pos}`;
        }
    }

    if (analysis.regattaName) {
        params.push(`%${analysis.regattaName}%`);
        baseQuery += `\nAND LOWER(r.regatta_name) LIKE LOWER($${paramCount++})`;
    }

    if (analysis.location) {
        params.push(`%${analysis.location}%`);
        baseQuery += `\nAND LOWER(r.regatta_name) LIKE LOWER($${paramCount++})`;
    }

    if (analysis.year) {
        baseQuery += `\nAND EXTRACT(YEAR FROM races.regatta_date) = ${analysis.year}`;
    } else if (analysis.timeFrame === 'this_year') {
        baseQuery += `\nAND EXTRACT(YEAR FROM races.regatta_date) = EXTRACT(YEAR FROM CURRENT_DATE)`;
    }

    if (analysis.queryType === "winner") {
        baseQuery += `\nAND res.position = 1`;
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

// Update the initialization function with safeguards
async function initializeDatabase() {
    try {
        // First check if we have existing data
        const counts = await checkDatabaseHasData();
        const hasExistingData = counts.race_count > 0 || counts.skipper_count > 0 || counts.result_count > 0;

        if (hasExistingData) {
            console.log('⚠️ Database already contains data:', counts);
            console.log('✅ Skipping initialization to protect existing data');
            return;
        }

        // Only create tables if they don't exist - NEVER drop tables
        await pool.query(`
            CREATE TABLE IF NOT EXISTS races (
                id SERIAL PRIMARY KEY,
                regatta_name VARCHAR(100),
                regatta_date DATE,
                category VARCHAR(50),
                boat_name VARCHAR(100),
                sail_number VARCHAR(20),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS skippers (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL UNIQUE,
                yacht_club VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS results (
                id SERIAL PRIMARY KEY,
                race_id INTEGER REFERENCES races(id),
                skipper_id INTEGER REFERENCES skippers(id),
                position INTEGER,
                total_points DECIMAL(5,2),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Add triggers to update last_modified timestamp
        await pool.query(`
            CREATE OR REPLACE FUNCTION update_modified_column()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.last_modified = CURRENT_TIMESTAMP;
                RETURN NEW;
            END;
            $$ language 'plpgsql';

            DROP TRIGGER IF EXISTS update_races_modtime ON races;
            CREATE TRIGGER update_races_modtime
                BEFORE UPDATE ON races
                FOR EACH ROW
                EXECUTE FUNCTION update_modified_column();

            DROP TRIGGER IF EXISTS update_skippers_modtime ON skippers;
            CREATE TRIGGER update_skippers_modtime
                BEFORE UPDATE ON skippers
                FOR EACH ROW
                EXECUTE FUNCTION update_modified_column();

            DROP TRIGGER IF EXISTS update_results_modtime ON results;
            CREATE TRIGGER update_results_modtime
                BEFORE UPDATE ON results
                FOR EACH ROW
                EXECUTE FUNCTION update_modified_column();
        `);

        // Verify tables are empty (double-check)
        const finalCounts = await checkDatabaseHasData();
        console.log('✅ Database tables created successfully. Current counts:', finalCounts);

    } catch (error) {
        console.error('❌ Database initialization error:', error);
        throw error;
    }
}

// Add safety check before any potentially destructive operations
async function safetyCheck() {
    if (!ENABLE_DB_WIPE) {
        throw new Error('Database wipe protection is enabled. Set ENABLE_DB_WIPE to true to proceed.');
    }
    
    const counts = await checkDatabaseHasData();
    if (counts.race_count > 0 || counts.skipper_count > 0 || counts.result_count > 0) {
        // Create backups before proceeding
        const backups = await Promise.all([
            backupTableData('races'),
            backupTableData('skippers'),
            backupTableData('results')
        ]);
        console.log('Created backup tables:', backups);
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
    
    try {
        // First, verify data exists in the database
        const tableCheck = await pool.query(`
            SELECT 
                (SELECT COUNT(*) FROM races) as race_count,
                (SELECT COUNT(*) FROM skippers) as skipper_count,
                (SELECT COUNT(*) FROM results) as result_count
        `);
        console.log('Database table counts:', tableCheck.rows[0]);

        // Verify OpenAI configuration
        if (!process.env.OPENAI_API_KEY) {
            throw new Error('OpenAI API key is not configured');
        }

        // Analyze query using GPT
        const analysis = await analyzeQuery(req.body.query);
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
        console.log('Raw query results:', result.rows);

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

        // After executing the query, log the SQL and results
        console.log('Executing SQL:', sqlQuery);
        console.log('With parameters:', params);
        console.log('Query results:', result.rows.length, 'rows found');

        res.json({
            message,
            data: result.rows
        });

    } catch (error) {
        console.error('Detailed chat error:', error);
        res.status(500).json({ 
            error: 'Failed to process your question',
            details: error.message,
            stack: error.stack
        });
    }
});

// 2. File upload route
app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log('Starting file upload process');
    try {
        const results = [];
        fs.createReadStream(req.file.path)
            .pipe(parse({
                columns: true,
                skip_empty_lines: true
            }))
            .on('data', (data) => {
                console.log('Parsed row:', data);
                results.push(data);
            })
            .on('end', async () => {
                console.log(`Parsed ${results.length} rows from CSV`);
                try {
                    for (const row of results) {
                        // Log each row being processed
                        console.log('Processing row:', {
                            regatta: row.Regatta_Name,
                            date: row.Regatta_Date,
                            skipper: row.Skipper
                        });

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
                    console.log('Upload completed successfully');
                    res.json({
                        message: 'Regatta results successfully imported',
                        rowsImported: results.length
                    });
                } catch (error) {
                    console.error('Detailed upload error:', error);
                    res.status(500).json({ 
                        error: 'Database operation failed',
                        details: error.message,
                        stack: error.stack
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

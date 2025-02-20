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

// Add input validation helper
function validateInput(value, type = 'string') {
    if (value === null || value === undefined) return null;
    
    switch (type) {
        case 'year':
            const year = parseInt(value);
            if (isNaN(year) || year < 1900 || year > 2100) return null;
            return year;
        case 'position':
            const pos = parseInt(value);
            if (isNaN(pos) || pos < 1) return null;
            return pos;
        case 'string':
            return String(value).replace(/[%;]/g, '').trim();
        default:
            return null;
    }
}

// Function to analyze query using GPT
async function analyzeQuery(query) {
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                {
                    role: "system",
                    content: `You are a PostgreSQL query analyzer for a sailing race results database. Extract information from natural language queries.
                    Database schema:
                    - races: regatta_name, regatta_date, category, boat_name, sail_number
                    - skippers: name, yacht_club
                    - results: position, total_points (links races to skippers)

                    Common sailor name patterns to detect:
                    - "find sailor [name]" -> {"queryType": "sailor_search", "sailorName": "[name]"}
                    - "search for [name]" -> {"queryType": "sailor_search", "sailorName": "[name]"}
                    - "show me [name]'s results" -> {"queryType": "sailor_stats", "sailorName": "[name]"}
                    - "any sailor called [name]" -> {"queryType": "sailor_search", "sailorName": "[name]"}
                    - "sailor [name]" -> {"queryType": "sailor_search", "sailorName": "[name]"}
                    - "find [name]" -> {"queryType": "sailor_search", "sailorName": "[name]"}
                    
                    Always extract partial names too, e.g., "find John" should set sailorName: "John"
                    ...
                    Return JSON with these fields:
                    - queryType: one of:
                        "winner" (for who won specific races)
                        "winners_list" (for listing multiple winners)
                        "sailor_search" (for finding sailors by name/info)
                        "sailor_stats" (for sailor performance/history)
                        "team_members" (for listing yacht club members)
                        "team_results" (for yacht club performance)
                        "regatta_count" (for counting/listing regattas)
                        "regatta_results" (for specific regatta results)
                        "location_races" (for races at a location)
                        "database_status" (for database stats/freshness)
                        "performance_stats" (for rankings/performance)
                    - sailorName: sailor's name if mentioned
                    - regattaName: regatta/event name if mentioned
                    - yachtClub: team/club name if mentioned
                    - location: race location if mentioned
                    - year: specific year if mentioned
                    - position: position mentioned (e.g., "top 3", "first")
                    - timeFrame: "this_year", "specific_year", "all_time", "recent"

                    Common question patterns:
                    - "who won [regatta]" -> winner + regattaName
                    - "show me results for [sailor]" -> sailor_stats + sailorName
                    - "how many races in [location]" -> location_races + location
                    - "show sailors from [club]" -> team_members + yachtClub
                    - "what were the results of [regatta]" -> regatta_results + regattaName
                    - "how did [sailor] do in [regatta]" -> sailor_stats + sailorName + regattaName
                    - "who are the members of [club]" -> team_members + yachtClub
                    - "show all results for [club]" -> team_results + yachtClub
                    - "when was [regatta]" -> regatta_results + regattaName
                    - "how up to date is the database" -> database_status
                    - "list all sailors" -> sailor_search
                    - "show me the winners from [year]" -> winners_list + year
                    - "who has won the most races" -> performance_stats
                    - "what regattas happened in [year]" -> regatta_count + year
                    - "show me [sailor]'s best results" -> sailor_stats + sailorName + position`
                },
                {
                    role: "user",
                    content: query
                }
            ],
            temperature: 0.1,
        });

        // Add safety checks for the OpenAI response
        if (!completion?.choices?.[0]?.message?.content) {
            console.error('Invalid OpenAI response structure:', completion);
            throw new Error('Failed to get a valid response from OpenAI');
        }

        try {
            return JSON.parse(completion.choices[0].message.content);
        } catch (parseError) {
            console.error('Failed to parse OpenAI response:', completion.choices[0].message.content);
            throw new Error('Failed to parse the AI response as JSON');
        }

    } catch (error) {
        console.error('GPT Analysis error:', error);
        throw error;
    }
}

// Update generateSQL to use safer parameter handling
function generateSQL(analysis) {
    let baseQuery = '';
    const conditions = [];
    const params = [];
    const values = {};

    // Set the base query based on query type
    switch (analysis.queryType) {
        case "sailor_search":
            baseQuery = `
                SELECT DISTINCT
                    s.name,
                    s.yacht_club,
                    COUNT(DISTINCT r.id) as total_races,
                    COUNT(DISTINCT CASE WHEN res.position = 1 THEN r.id END) as wins,
                    MIN(res.position) as best_position,
                    MIN(r.regatta_date) as first_race,
                    MAX(r.regatta_date) as last_race
                FROM skippers s
                LEFT JOIN results res ON s.id = res.skipper_id
                LEFT JOIN races r ON res.race_id = r.id
                WHERE 1=1
            `;
            break;
        // ... other cases ...
    }

    // Validate inputs
    values.sailorName = validateInput(analysis.sailorName);
    values.yachtClub = validateInput(analysis.yachtClub);
    values.regattaName = validateInput(analysis.regattaName);
    values.location = validateInput(analysis.location);
    values.year = validateInput(analysis.year, 'year');
    values.position = validateInput(analysis.position, 'position');

    // Add conditions using parameterized queries
    if (values.sailorName) {
        params.push(`%${values.sailorName}%`);
        conditions.push(`LOWER(s.name) LIKE LOWER($${params.length})`);
    }

    if (values.yachtClub) {
        params.push(`%${values.yachtClub}%`);
        conditions.push(`LOWER(s.yacht_club) LIKE LOWER($${params.length})`);
    }

    if (values.position) {
        params.push(values.position);
        conditions.push(`res.position <= $${params.length}`);
    }

    if (values.regattaName) {
        params.push(`%${values.regattaName}%`);
        conditions.push(`LOWER(r.regatta_name) LIKE LOWER($${params.length})`);
    }

    if (values.location) {
        params.push(`%${values.location}%`);
        conditions.push(`LOWER(r.regatta_name) LIKE LOWER($${params.length})`);
    }

    if (values.year) {
        params.push(values.year);
        conditions.push(`EXTRACT(YEAR FROM races.regatta_date) = $${params.length}`);
    } else if (analysis.timeFrame === 'this_year') {
        conditions.push(`EXTRACT(YEAR FROM races.regatta_date) = EXTRACT(YEAR FROM CURRENT_DATE)`);
    }

    // Use parameterized query for position checks
    if (analysis.queryType === "winner") {
        conditions.push(`res.position = 1`);
    }

    // Add conditions safely
    if (conditions.length > 0) {
        baseQuery += `\nAND ${conditions.join('\nAND ')}`;
    }

    // Add GROUP BY for aggregates
    if (analysis.queryType === 'sailor_search') {
        baseQuery += '\nGROUP BY s.id, s.name, s.yacht_club';
    }

    // Add safe ordering
    const safeOrderBy = {
        "most_wins": "wins DESC",
        "winners_list": "races.regatta_date DESC",
        "sailor_search": "s.name ASC",
        "team_results": "races.regatta_date DESC, results.position ASC"
    };

    if (safeOrderBy[analysis.queryType]) {
        baseQuery += `\nORDER BY ${safeOrderBy[analysis.queryType]}`;
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

// Update bulkInsertData function to handle blank/missing values
async function bulkInsertData(rows) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Clean and validate data
        const cleanRows = rows.map(row => ({
            regattaName: row.Regatta_Name?.trim() || null,
            regattaDate: parseDate(row.Regatta_Date) || null,
            skipper: row.Skipper?.trim() || null,
            yachtClub: row.Yacht_Club?.trim() || null,
            category: row.Category?.trim() || null,
            boatName: row.Boat_Name?.trim() || null,
            sailNumber: row.Sail_Number?.trim() || null,
            position: row.Position ? parseInt(row.Position.toString().trim()) : null,
            totalPoints: row.Total_Points ? parseFloat(row.Total_Points.toString().trim()) : null
        }));

        // Get unique skippers
        const uniqueSkippers = [...new Set(cleanRows
            .filter(row => row.skipper)
            .map(row => row.skipper))];

        // Create skipper map
        const skipperMap = new Map();
        
        // Insert skippers one by one to handle duplicates properly
        for (const skipperName of uniqueSkippers) {
            const result = await client.query(
                `INSERT INTO skippers (name, yacht_club) 
                 VALUES ($1, $2)
                 ON CONFLICT (name) 
                 DO UPDATE SET yacht_club = COALESCE($2, skippers.yacht_club)
                 RETURNING id`,
                [
                    skipperName,
                    cleanRows.find(r => r.skipper === skipperName)?.yachtClub
                ]
            );
            skipperMap.set(skipperName, result.rows[0].id);
        }

        // Insert races and get their IDs
        const raceResults = await Promise.all(cleanRows.map(row => 
            client.query(
                `INSERT INTO races (regatta_name, regatta_date, category, boat_name, sail_number)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id`,
                [row.regattaName, row.regattaDate, row.category, row.boatName, row.sailNumber]
            )
        ));

        // Insert results using the skipper and race IDs
        await Promise.all(cleanRows.map((row, index) => {
            if (!row.position && !row.totalPoints) return Promise.resolve();
            return client.query(
                `INSERT INTO results (race_id, skipper_id, position, total_points)
                 VALUES ($1, $2, $3, $4)`,
                [
                    raceResults[index].rows[0].id,
                    row.skipper ? skipperMap.get(row.skipper) : null,
                    row.position,
                    row.totalPoints
                ]
            );
        }));

        await client.query('COMMIT');
        return cleanRows.length;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

// Add helper function for date parsing
function parseDate(dateStr) {
    if (!dateStr) return null;
    
    try {
        dateStr = dateStr.trim();
        let parsedDate;

        if (dateStr.includes('/')) {
            // Handle MM/DD/YYYY
            const [month, day, year] = dateStr.split('/');
            parsedDate = new Date(year, month - 1, day);
        } else if (dateStr.includes('-')) {
            // Handle YYYY-MM-DD
            parsedDate = new Date(dateStr);
        } else if (dateStr.match(/[A-Za-z]+/)) {
            // Handle written month format
            parsedDate = new Date(dateStr);
            if (isNaN(parsedDate.getTime())) {
                const match = dateStr.match(/([A-Za-z]+)\s+(\d+),?\s+(\d{4})/);
                if (match) {
                    const [_, month, day, year] = match;
                    parsedDate = new Date(`${month} ${day}, ${year}`);
                }
            }
        }

        return isNaN(parsedDate?.getTime()) ? null : parsedDate;
    } catch {
        return null;
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
                skip_empty_lines: true,
                trim: true
            }))
            .on('data', (data) => {
                results.push(data);
            })
            .on('end', async () => {
                console.log(`Parsed ${results.length} rows from CSV`);
                try {
                    // Validate CSV structure
                    if (results.length === 0) {
                        throw new Error('CSV file is empty');
                    }

                    // Validate required columns and data
                    for (const row of results) {
                        if (!row.Regatta_Name?.trim()) throw new Error(`Missing Regatta Name in row`);
                        if (!row.Skipper?.trim()) throw new Error(`Missing Skipper in row`);
                        if (!row.Regatta_Date?.trim()) throw new Error(`Missing Date in row`);

                        // Validate date
                        const dateStr = row.Regatta_Date.trim();
                        let parsedDate;
                        if (dateStr.includes('/')) {
                            const [month, day, year] = dateStr.split('/');
                            parsedDate = new Date(year, month - 1, day);
                        } else if (dateStr.includes('-')) {
                            parsedDate = new Date(dateStr);
                        } else if (dateStr.match(/[A-Za-z]+/)) {
                            parsedDate = new Date(dateStr);
                            if (isNaN(parsedDate.getTime())) {
                                const match = dateStr.match(/([A-Za-z]+)\s+(\d+),?\s+(\d{4})/);
                                if (match) {
                                    const [_, month, day, year] = match;
                                    parsedDate = new Date(`${month} ${day}, ${year}`);
                                }
                            }
                        }
                        if (isNaN(parsedDate?.getTime())) {
                            throw new Error(`Invalid date format: ${dateStr}`);
                        }
                    }

                    // Bulk insert all data
                    const rowsInserted = await bulkInsertData(results);

                    // Clean up
                    fs.unlinkSync(req.file.path);
                    console.log('Upload completed successfully');

                    res.json({
                        message: 'Regatta results successfully imported',
                        rowsImported: rowsInserted
                    });
                } catch (error) {
                    console.error('Upload error:', error);
                    res.status(500).json({ 
                        error: 'Upload failed',
                        details: error.message
                    });
                }
            });
    } catch (error) {
        console.error('File processing error:', error);
        res.status(500).json({ 
            error: 'File processing failed',
            details: error.message
        });
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

// Add this constant at the top of the file
const EXPECTED_CSV_FIELDS = {
    required: [],  // No strictly required fields
    optional: [
        'Regatta_Name',    // Name of the regatta event (can be blank)
        'Regatta_Date',    // Date in format: MM/DD/YYYY, YYYY-MM-DD, or "Month DD, YYYY" (can be blank)
        'Skipper',         // Skipper's full name (can be blank)
        'Yacht_Club',      // Club affiliation (can be blank)
        'Category',        // Race category/class (can be blank)
        'Boat_Name',       // Name of the boat (can be blank)
        'Sail_Number',     // Sail/registration number (can be blank)
        'Position',        // Finishing position (numeric, can be blank)
        'Total_Points'     // Points awarded (numeric, can be blank)
    ]
};

// Update the CSV validation to be more lenient
function validateCSVHeaders(firstRow) {
    // Check that at least some of the expected fields are present
    const validFields = EXPECTED_CSV_FIELDS.optional;
    const foundFields = Object.keys(firstRow).filter(field => validFields.includes(field));
    
    if (foundFields.length === 0) {
        throw new Error('CSV file does not contain any recognized columns. Expected some of: ' + validFields.join(', '));
    }
    
    // Warn about unexpected fields but don't error
    const unexpectedFields = Object.keys(firstRow).filter(field => !validFields.includes(field));
    if (unexpectedFields.length > 0) {
        console.warn(`Warning: Unexpected columns found: ${unexpectedFields.join(', ')}`);
    }
}

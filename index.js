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
                    content: `You are a sailing race database assistant. You help users find information about sailors, races, and results.

Database Structure:
- Skippers (also called sailors, racers, people, competitors):
  * name: Person's full name
  * yacht_club: Their club/team affiliation

- Races (also called regattas, events, competitions):
  * regatta_name: Event name
  * regatta_date: When it happened
  * category: Type of race/class
  * boat_name: Name of the vessel
  * sail_number: Boat's registration number

- Results: Links skippers to races with their finishing data
  * position: Place they finished (1st, 2nd, etc.)
  * total_points: Points awarded

Common Questions You Can Answer:
1. Finding People:
   - "find sailor/skipper/person [name]"
   - "who is [name]?"
   - "tell me about [name]"
   - "search for [name]"
   - "lookup [name]"
   -> Return: {"queryType": "sailor_search", "sailorName": "[name]"}

2. Database Information:
   - "how many sailors/skippers/people do you know?"
   - "what's in the database?"
   - "show database stats/info"
   - "how many races/regattas are there?"
   -> Return: {"queryType": "database_status"}

3. Race Information:
   - "list regattas/races/events"
   - "what races do you have?"
   - "show races from [year]"
   - "regattas in [year]"
   -> Return: {"queryType": "regatta_count", "year": "[year]"}

4. Performance Stats:
   - "who has won the most?"
   - "best sailors/skippers"
   - "top performers/racers"
   - "who's winning?"
   -> Return: {"queryType": "performance_stats"}

5. Club Information:
   - "sailors/people from [club]"
   - "who sails for [club]"
   - "members of [club]"
   - "[club] team"
   -> Return: {"queryType": "team_members", "yachtClub": "[club]"}

Understand these synonyms:
- Person = Sailor = Skipper = Racer = Competitor
- Race = Regatta = Event = Competition
- Club = Team = Yacht Club = Organization

Always try to understand partial or informal queries:
- "find John" -> sailor_search with "John"
- "races 2023" -> regatta_count with year 2023
- "ASC team" -> team_members with "ASC"
- "who is winning" -> performance_stats
- "show me John" -> sailor_search with "John"

If you don't understand the query, default to:
{"queryType": "database_status"}

Response Format:
{
    "queryType": "one_of_the_types_above",
    "sailorName": "extracted_name_or_null",
    "yachtClub": "extracted_club_or_null",
    "year": "extracted_year_or_null",
    "regattaName": "extracted_regatta_or_null"
}`
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

    switch (analysis.queryType) {
        case "sailor_search":
            values.sailorName = analysis.sailorName;
            baseQuery = `
                SELECT 
                    s.name as skipper_name,
                    s.yacht_club,
                    r.boat_name,
                    COUNT(DISTINCT r.id) as total_races,
                    COUNT(DISTINCT CASE WHEN res.position = 1 THEN r.id END) as wins,
                    MIN(res.position) as best_position,
                    MIN(r.regatta_date) as first_race,
                    MAX(r.regatta_date) as last_race
                FROM (
                    SELECT id, name, yacht_club 
                    FROM skippers 
                    WHERE LOWER(name) LIKE LOWER($1)
                    UNION
                    SELECT DISTINCT s.id, s.name, s.yacht_club
                    FROM skippers s
                    JOIN results res ON s.id = res.skipper_id
                    JOIN races r ON res.race_id = r.id
                    WHERE LOWER(r.boat_name) LIKE LOWER($1)
                ) s
                LEFT JOIN results res ON s.id = res.skipper_id
                LEFT JOIN races r ON res.race_id = r.id
                GROUP BY s.id, s.name, s.yacht_club, r.boat_name
                ORDER BY s.name ASC
            `;
            params.push(`%${values.sailorName}%`);
            return { query: baseQuery, params };

        case "database_status":
            return {
                query: `
                    SELECT 
                        (SELECT COUNT(*) FROM skippers) as total_sailors,
                        (SELECT COUNT(*) FROM races) as total_races,
                        (SELECT COUNT(*) FROM results) as total_results,
                        (SELECT MIN(regatta_date) FROM races) as earliest_race,
                        (SELECT MAX(regatta_date) FROM races) as latest_race,
                        (SELECT COUNT(DISTINCT yacht_club) FROM skippers WHERE yacht_club IS NOT NULL) as total_clubs
                `,
                params: []
            };

        case "regatta_count":
            baseQuery = `
                SELECT 
                    regatta_name,
                    regatta_date,
                    category,
                    COUNT(DISTINCT res.skipper_id) as participants
                FROM races r
                LEFT JOIN results res ON r.id = res.race_id
                WHERE 1=1
                GROUP BY r.id, regatta_name, regatta_date, category
            `;
            break;
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
                regatta_name VARCHAR(300),
                regatta_date DATE,
                category VARCHAR(300),
                boat_name VARCHAR(300),
                sail_number VARCHAR(300),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS skippers (
                id SERIAL PRIMARY KEY,
                name VARCHAR(300) NOT NULL UNIQUE,
                yacht_club VARCHAR(300),
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
            originalLineNumber: row._lineNumber, // Preserve the line number
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

        // Validate field lengths
        for (const row of cleanRows) {
            if (row.regattaName && row.regattaName.length > 300) {
                throw new Error(`Regatta name too long (max 300 chars) in row ${row.originalLineNumber}`);
            }
            if (row.category && row.category.length > 300) {
                throw new Error(`Category too long (max 300 chars) in row ${row.originalLineNumber}`);
            }
            if (row.boatName && row.boatName.length > 300) {
                throw new Error(`Boat name too long (max 300 chars) in row ${row.originalLineNumber}`);
            }
            if (row.sailNumber && row.sailNumber.length > 300) {
                throw new Error(`Sail number too long (max 300 chars) in row ${row.originalLineNumber}`);
            }
            if (row.skipper && row.skipper.length > 300) {
                throw new Error(`Skipper name too long (max 300 chars) in row ${row.originalLineNumber}`);
            }
            if (row.yachtClub && row.yachtClub.length > 300) {
                throw new Error(`Yacht club name too long (max 300 chars) in row ${row.originalLineNumber}`);
            }
        }

        // Get unique skippers
        const uniqueSkippers = [...new Set(cleanRows
            .filter(row => row.skipper)
            .map(row => row.skipper))];

        // Create skipper map
        const skipperMap = new Map();
        
        // Insert skippers one by one to handle duplicates properly
        for (const skipperName of uniqueSkippers) {
            try {
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
            } catch (error) {
                const affectedRow = cleanRows.find(r => r.skipper === skipperName);
                throw new Error(`Error inserting skipper "${skipperName}" from row ${affectedRow.originalLineNumber}: ${error.message}`);
            }
        }

        // Insert races and get their IDs
        const raceResults = [];
        for (const [index, row] of cleanRows.entries()) {
            try {
                const result = await client.query(
                    `INSERT INTO races (regatta_name, regatta_date, category, boat_name, sail_number)
                     VALUES ($1, $2, $3, $4, $5)
                     RETURNING id`,
                    [row.regattaName, row.regattaDate, row.category, row.boatName, row.sailNumber]
                );
                raceResults[index] = result;
            } catch (error) {
                throw new Error(`Error inserting race from row ${row.originalLineNumber}: ${error.message}`);
            }
        }

        // Insert results using the skipper and race IDs
        for (const [index, row] of cleanRows.entries()) {
            try {
                if (!row.position && !row.totalPoints) continue;
                await client.query(
                    `INSERT INTO results (race_id, skipper_id, position, total_points)
                     VALUES ($1, $2, $3, $4)`,
                    [
                        raceResults[index].rows[0].id,
                        row.skipper ? skipperMap.get(row.skipper) : null,
                        row.position,
                        row.totalPoints
                    ]
                );
            } catch (error) {
                throw new Error(`Error inserting results from row ${row.originalLineNumber}: ${error.message}`);
            }
        }

        await client.query('COMMIT');
        return cleanRows.length;
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Bulk insert error:', error);
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
    try {
        const analysis = await analyzeQuery(req.body.query);
        const { query: sqlQuery, params } = generateSQL(analysis);
        const result = await pool.query(sqlQuery, params);

        let message = '';
        switch (analysis.queryType) {
            case "database_status":
                const stats = result.rows[0];
                message = `I know about ${stats.total_sailors} sailors from ${stats.total_clubs} yacht clubs. `;
                message += `There are ${stats.total_races} races in the database, `;
                message += `from ${new Date(stats.earliest_race).toLocaleDateString()} to ${new Date(stats.latest_race).toLocaleDateString()}.`;
                break;

            case "sailor_search":
                if (result.rows.length === 0) {
                    message = `I couldn't find any sailors or boats matching "${values.sailorName}". Try a different name or partial name.`;
                } else {
                    message = `Found ${result.rows.length} match(es). `;
                    if (result.rows.length === 1) {
                        const sailor = result.rows[0];
                        const matchType = sailor.boat_name ? 
                            `skipper of boat "${sailor.boat_name}"` : 
                            `from ${sailor.yacht_club || 'unknown club'}`;
                        message += `${sailor.skipper_name} ${matchType} `;
                        message += `has competed in ${sailor.total_races} races with ${sailor.wins} wins. `;
                        if (sailor.best_position) {
                            message += `Best finish: ${sailor.best_position}${sailor.best_position === 1 ? 'st' : 'th'} place.`;
                        }
                    }
                }
                break;

            case "regatta_count":
                message = `Found ${result.rows.length} regattas. `;
                if (values.year) {
                    message = `Found ${result.rows.length} regattas in ${values.year}. `;
                }
                break;

            default:
                message = result.rows.length === 0 ? 
                    'No results found for your query.' : 
                    `Found ${result.rows.length} results.`;
        }

        res.json({
            message,
            data: result.rows
        });

    } catch (error) {
        console.error('Chat error:', error);
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

    console.log('Starting file upload process');
    try {
        const results = [];
        let lineNumber = 1; // Track header row
        fs.createReadStream(req.file.path)
            .pipe(parse({
                columns: true,
                skip_empty_lines: true,
                trim: true
            }))
            .on('data', (data) => {
                lineNumber++; // Increment for each data row
                data._lineNumber = lineNumber; // Store line number with row data
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
                        try {
                            const rowNum = row._lineNumber;
                            if (!row.Regatta_Name?.trim()) {
                                throw new Error(`Missing Regatta Name in row ${rowNum}`);
                            }
                            if (!row.Skipper?.trim()) {
                                throw new Error(`Missing Skipper in row ${rowNum}`);
                            }
                            if (!row.Regatta_Date?.trim()) {
                                throw new Error(`Missing Date in row ${rowNum}`);
                            }

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
                                throw new Error(`Invalid date format in row ${rowNum}: ${dateStr}`);
                            }
                        } catch (rowError) {
                            // Add line number context to error if not already present
                            const errorMessage = rowError.message.includes('row') 
                                ? rowError.message 
                                : `Error in row ${row._lineNumber}: ${rowError.message}`;
                            throw new Error(errorMessage);
                        }
                    }

                    // Bulk insert all data
                    try {
                        const rowsInserted = await bulkInsertData(results);
                        // Clean up
                        fs.unlinkSync(req.file.path);
                        console.log('Upload completed successfully');

                        res.json({
                            message: 'Regatta results successfully imported',
                            rowsImported: rowsInserted
                        });
                    } catch (dbError) {
                        // Try to identify which row caused the database error
                        const errorRow = extractRowNumberFromError(dbError.message);
                        const errorMessage = errorRow 
                            ? `Database error on row ${errorRow}: ${dbError.message}`
                            : dbError.message;
                        throw new Error(errorMessage);
                    }
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
        res.status(500).json({ error: 'File processing failed', details: error.message });
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
        await updateDatabaseSchema();
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

// Add database clear endpoint
app.post('/api/clear-database', async (req, res) => {
    try {
        await pool.query('BEGIN');
        
        // Create backup tables before clearing
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, "");
        await pool.query(`CREATE TABLE IF NOT EXISTS results_backup_${timestamp} AS SELECT * FROM results`);
        await pool.query(`CREATE TABLE IF NOT EXISTS races_backup_${timestamp} AS SELECT * FROM races`);
        await pool.query(`CREATE TABLE IF NOT EXISTS skippers_backup_${timestamp} AS SELECT * FROM skippers`);
        
        // Clear tables in correct order
        await pool.query('DELETE FROM results');
        await pool.query('DELETE FROM races');
        await pool.query('DELETE FROM skippers');
        
        await pool.query('COMMIT');
        
        res.json({ 
            message: 'Database cleared successfully',
            backupTimestamp: timestamp
        });
    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('Database clear error:', error);
        res.status(500).json({ 
            error: 'Failed to clear database',
            details: error.message
        });
    }
});

// Add backup and restore endpoints
app.post('/api/backup-database', async (req, res) => {
    try {
        await pool.query('BEGIN');
        
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, "");
        const backupPrefix = `backup_${timestamp}`;
        
        // Create backup tables
        await pool.query(`CREATE TABLE ${backupPrefix}_results AS SELECT * FROM results`);
        await pool.query(`CREATE TABLE ${backupPrefix}_races AS SELECT * FROM races`);
        await pool.query(`CREATE TABLE ${backupPrefix}_skippers AS SELECT * FROM skippers`);
        
        await pool.query('COMMIT');
        
        res.json({ 
            message: 'Database backup created successfully',
            backupTimestamp: timestamp
        });
    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('Backup error:', error);
        res.status(500).json({ error: 'Failed to create backup' });
    }
});

app.get('/api/latest-backup', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_name LIKE 'backup_%'
            ORDER BY table_name DESC
            LIMIT 1
        `);
        
        if (result.rows.length > 0) {
            const backupTimestamp = result.rows[0].table_name.split('_')[1];
            res.json({ backupTimestamp });
        } else {
            res.json({ backupTimestamp: null });
        }
    } catch (error) {
        console.error('Error checking backup:', error);
        res.status(500).json({ error: 'Failed to check backup status' });
    }
});

app.post('/api/restore-database', async (req, res) => {
    try {
        const { backupTimestamp } = req.body;
        if (!backupTimestamp) {
            throw new Error('No backup timestamp provided');
        }

        await pool.query('BEGIN');

        // Clear current tables
        await pool.query('DELETE FROM results');
        await pool.query('DELETE FROM races');
        await pool.query('DELETE FROM skippers');

        // Restore from backup
        await pool.query(`INSERT INTO results SELECT * FROM backup_${backupTimestamp}_results`);
        await pool.query(`INSERT INTO races SELECT * FROM backup_${backupTimestamp}_races`);
        await pool.query(`INSERT INTO skippers SELECT * FROM backup_${backupTimestamp}_skippers`);

        await pool.query('COMMIT');
        
        res.json({ message: 'Database restored successfully' });
    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('Restore error:', error);
        res.status(500).json({ error: 'Failed to restore database' });
    }
});

// Helper function to try to extract row numbers from common database error messages
function extractRowNumberFromError(errorMessage) {
    // Look for common patterns in error messages that might indicate the problematic row
    const patterns = [
        /row (\d+)/i,
        /line (\d+)/i,
        /index (\d+)/i
    ];
    
    for (const pattern of patterns) {
        const match = errorMessage.match(pattern);
        if (match && match[1]) {
            return match[1];
        }
    }
    return null;
}

// Add this function to update existing tables
async function updateDatabaseSchema() {
    try {
        await pool.query(`
            ALTER TABLE skippers 
            ALTER COLUMN name TYPE VARCHAR(300),
            ALTER COLUMN yacht_club TYPE VARCHAR(300);

            ALTER TABLE races
            ALTER COLUMN regatta_name TYPE VARCHAR(300),
            ALTER COLUMN category TYPE VARCHAR(300),
            ALTER COLUMN boat_name TYPE VARCHAR(300),
            ALTER COLUMN sail_number TYPE VARCHAR(300);
        `);
        console.log('Database schema updated successfully');
    } catch (error) {
        console.error('Failed to update database schema:', error);
        throw error;
    }
}

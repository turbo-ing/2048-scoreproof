import express from 'express';
import Database from 'better-sqlite3';
import multer from 'multer';
import cors from 'cors';
import path from 'path'; // Optional for file extension checks, etc.
import { JsonProof } from 'o1js';
import { verify2048Proof } from './zk';

// 1) Define the ScoreCount interface
interface ScoreCount {
  score: number;
  count: number;
}

// 2) Define your initial scores
const initialScores: ScoreCount[] = [
  { score: 131072, count: 0 },
  { score: 65536, count: 0 },
  { score: 32768, count: 0 },
  { score: 16384, count: 0 },
  { score: 8192, count: 0 },
  { score: 4096, count: 0 },
  { score: 2048, count: 0 },
  { score: 1024, count: 0 },
  { score: 512, count: 0 },
  { score: 256, count: 0 },
  { score: 128, count: 0 },
  { score: 64, count: 0 },
  { score: 32, count: 0 },
  { score: 16, count: 0 },
  { score: 8, count: 0 },
  { score: 4, count: 0 },
  { score: 2, count: 0 },
];

// 3) Open/Create the SQLite database
//    The `verbose` option logs SQL statements — optional for debugging
const db = new Database('scores.db', { verbose: console.log });

// 4) Initialize the database
function initDb() {
  // Create the scores table if it doesn't exist
  db.prepare(`
    CREATE TABLE IF NOT EXISTS scores (
      score INTEGER PRIMARY KEY,
      count INTEGER NOT NULL
    )
  `).run();

  // Create the proofs table if it doesn't exist
  // proofId is the unique identifier to prevent duplicate submissions
  db.prepare(`
    CREATE TABLE IF NOT EXISTS proofs (
      proofId TEXT PRIMARY KEY,
      proof TEXT,
      score INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Create index on created_at for faster sorting
  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_proofs_created_at ON proofs(created_at DESC)
  `).run();

  // Check if the scores table is empty
  const row = db.prepare(`SELECT COUNT(*) AS count FROM scores`).get() as { count: number };
  if (row.count === 0) {
    // Insert initial data
    const insertStmt = db.prepare(`
      INSERT INTO scores (score, count) VALUES (@score, @count)
    `);

    // Transaction for efficient bulk inserts
    const insertMany = db.transaction((items: ScoreCount[]) => {
      for (const item of items) {
        insertStmt.run(item);
      }
    });
    insertMany(initialScores);
  }
}

// Call initDb to create tables and seed initial scores if needed
initDb();

// 5) Create and configure the Express app
const app = express();

// Parse JSON bodies
app.use(express.json());

// CORS
app.use(cors())

// Setup Multer for file uploads
// This will store files in memory (i.e., req.file.buffer)
const upload = multer({ storage: multer.memoryStorage() });

// =============== GET: Return All Scores ===============
app.get('/scores', (req, res) => {
  try {
    const stmt = db.prepare(`
      SELECT score, count FROM scores ORDER BY score DESC
    `);
    const scores = stmt.all();
    res.json(scores);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch scores' });
  }
});

// =============== GET: Return All Proofs ===============
app.get('/proofs', (req, res) => {
  try {
    const stmt = db.prepare(`
      SELECT proofId, proof, score, created_at FROM proofs ORDER BY created_at DESC
    `);
    const proofs = stmt.all();
    res.json(proofs);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch proofs' });
  }
});

// =============== POST: Submit a Proof ===============
// The frontend will send a form-data request with "proof" as the file field.
// The text file must be in the format "<proofId>:<score>"
app.post('/scores/proof', upload.single('proof'), async (req, res) => {
  try {
    // 1) Make sure a file is provided
    if (!req.file) {
      res.status(400).json({ error: 'No proof file uploaded' });
      return
    }

    // 2) Read file content as text
    const content = req.file.buffer.toString('utf-8').trim();
    const proof: JsonProof = JSON.parse(content)

    // The expected format is "<proofId>:<score>"
    // Example: "abc123:2048"
    // const parts = content.split(':');
    // if (parts.length !== 2) {
    //   res.status(400).json({ error: 'Invalid proof file format' });
    //   return
    // }

    const [proofId, parsedScore] = await verify2048Proof(proof);

    if (!proofId || parsedScore == -1 || isNaN(parsedScore)) {
      res.status(400).json({ error: 'Invalid proof data' });
      return
    }

    // 3) Check if this proofId has already been submitted
    const existingProof = db
      .prepare('SELECT proofId FROM proofs WHERE proofId = ?')
      .get(proofId);

    if (existingProof) {
      res.status(400).json({ error: 'Proof already submitted' });
      return
    }

    // 4) Insert the new proof into the "proofs" table
    //    We only store proofId and the associated score in the DB
    db.prepare(`
      INSERT INTO proofs (proofId, proof, score)
      VALUES (?, ?, ?)
    `).run(proofId, content, parsedScore);

    // 5) Update or insert into the "scores" table
    //    Since we only increment count by 1, we do:
    //      count = count + 1 if the score exists
    //      or create a new row with count = 1 if it doesn't exist
    const scoreRow = db
      .prepare('SELECT score, count FROM scores WHERE score = ?')
      .get(parsedScore);

    if (scoreRow) {
      // Score already exists, increment count
      db.prepare(`
        UPDATE scores SET count = count + 1 WHERE score = ?
      `).run(parsedScore);
    } else {
      // Create a new score row
      db.prepare(`
        INSERT INTO scores (score, count) VALUES (?, 1)
      `).run(parsedScore);
    }

    // 6) Respond success
    res.status(201).json({ message: 'Proof verified and score updated', score: parsedScore });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to process proof' });
  }
});

// =============== Start the Server ===============
const PORT = process.env.PORT || 3939;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
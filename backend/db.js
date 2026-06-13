const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

let db = null;

async function getDb() {
  if (db) return db;
  
  const dbPath = path.join(__dirname, 'jobs.db');
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  // Create jobs table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      company TEXT NOT NULL,
      location TEXT,
      link TEXT,
      description TEXT,
      posted_date TEXT,
      status TEXT DEFAULT 'new',
      match_score INTEGER,
      missing_skills TEXT,
      resume_suggestions TEXT,
      cover_letter TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create settings table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Initialize settings with defaults if empty
  const defaultSettings = [
    { key: 'gemini_key', value: '' },
    { key: 'resume', value: '' },
    { key: 'keywords', value: JSON.stringify(["Frontend Developer", "React Developer", "Next.js Developer"]) },
    { key: 'location', value: 'India' },
    { key: 'experience', value: '2-5 years' }
  ];

  for (const setting of defaultSettings) {
    const row = await db.get('SELECT * FROM settings WHERE key = ?', [setting.key]);
    if (!row) {
      await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [setting.key, setting.value]);
    }
  }

  return db;
}

async function getJobs() {
  const database = await getDb();
  return database.all('SELECT * FROM jobs ORDER BY created_at DESC');
}

async function saveJob(job) {
  const database = await getDb();
  // Insert or ignore to prevent overwriting existing status/scores
  await database.run(
    `INSERT OR IGNORE INTO jobs (id, title, company, location, link, description, posted_date, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'new')`,
    [job.id, job.title, job.company, job.location, job.link, job.description, job.posted_date]
  );
}

async function updateJobStatus(id, status) {
  const database = await getDb();
  await database.run('UPDATE jobs SET status = ? WHERE id = ?', [status, id]);
}

async function updateJobAnalysis(id, analysis) {
  const database = await getDb();
  await database.run(
    `UPDATE jobs SET 
      match_score = ?, 
      missing_skills = ?, 
      resume_suggestions = ?, 
      cover_letter = ? 
     WHERE id = ?`,
    [
      analysis.matchScore,
      JSON.stringify(analysis.missingSkills || []),
      JSON.stringify(analysis.resumeSuggestions || []),
      analysis.coverLetter || '',
      id
    ]
  );
}

async function getSettings() {
  const database = await getDb();
  const rows = await database.all('SELECT * FROM settings');
  const config = {};
  rows.forEach(row => {
    try {
      config[row.key] = JSON.parse(row.value);
    } catch {
      config[row.key] = row.value;
    }
  });
  return config;
}

async function saveSettings(settings) {
  const database = await getDb();
  for (const [key, value] of Object.entries(settings)) {
    const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
    await database.run(
      'REPLACE INTO settings (key, value) VALUES (?, ?)',
      [key, stringValue]
    );
  }
}

module.exports = {
  getDb,
  getJobs,
  saveJob,
  updateJobStatus,
  updateJobAnalysis,
  getSettings,
  saveSettings
};

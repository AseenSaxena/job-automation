const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const db = require('./db');
const scraper = require('./scraper');
const ai = require('./ai');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// SSE Log Clients
let logHistory = [];
const sseClients = new Set();

function broadcastLog(message) {
  const logItem = {
    timestamp: new Date().toISOString(),
    message: message
  };
  logHistory.push(logItem);
  if (logHistory.length > 250) {
    logHistory.shift(); // Keep logs clean and bounded
  }
  
  sseClients.forEach(client => {
    client.write(`data: ${JSON.stringify(logItem)}\n\n`);
  });
}

// Clear logs helper
function clearLogs() {
  logHistory = [];
  broadcastLog("System logs cleared.");
}

// SSE Connection Endpoint
app.get('/api/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Add client
  sseClients.add(res);
  
  // Stream existing history first
  logHistory.forEach(log => {
    res.write(`data: ${JSON.stringify(log)}\n\n`);
  });

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// GET /api/login-status
app.get('/api/login-status', (req, res) => {
  const authenticated = fs.existsSync(scraper.authPath);
  res.json({ authenticated });
});

// POST /api/login-linkedin
app.post('/api/login-linkedin', async (req, res) => {
  res.json({ success: true, message: 'Headed login session launching in the background...' });
  
  clearLogs();
  broadcastLog('Initializing LinkedIn login helper...');
  
  try {
    const result = await scraper.runLinkedInLogin((msg) => broadcastLog(msg));
    if (result.success) {
      broadcastLog('SUCCESS: Login session captured and saved.');
    } else {
      broadcastLog(`ERROR: Login process did not complete. ${result.error || ''}`);
    }
  } catch (err) {
    broadcastLog(`EXCEPTION: ${err.message}`);
  }
});

// POST /api/scrape
app.post('/api/scrape', async (req, res) => {
  const { maxJobs } = req.body;
  res.json({ success: true, message: 'Job scraper task started in background...' });
  
  clearLogs();
  broadcastLog('Fetching search configuration from settings...');
  
  try {
    const settings = await db.getSettings();
    const keywords = settings.keywords || ["React Developer"];
    const location = settings.location || "India";
    const experience = settings.experience || "";
    
    broadcastLog(`Launching scraping for keywords: ${JSON.stringify(keywords)}`);
    
    // We scrape keywords sequentially
    const keywordList = Array.isArray(keywords) ? keywords : [keywords];
    
    for (const kw of keywordList) {
      broadcastLog(`--- Scraping keyword: "${kw}" ---`);
      await scraper.scrapeLinkedInJobs(
        kw, 
        location, 
        experience, 
        parseInt(maxJobs) || 8, 
        (msg) => broadcastLog(msg)
      );
    }
    broadcastLog('Scraping batch completed successfully!');
  } catch (err) {
    broadcastLog(`SCRAPER FAILURE: ${err.message}`);
  }
});

// GET /api/jobs
app.get('/api/jobs', async (req, res) => {
  try {
    const jobs = await db.getJobs();
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/jobs/:id
app.patch('/api/jobs/:id', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    await db.updateJobStatus(id, status);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/jobs/:id/analyze
app.post('/api/jobs/:id/analyze', async (req, res) => {
  const { id } = req.params;
  try {
    const analysis = await ai.analyzeJob(id);
    res.json({ success: true, analysis });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await db.getSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings
app.post('/api/settings', async (req, res) => {
  try {
    await db.saveSettings(req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server and preheat db
db.getDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error("Failed to initialize SQLite database:", err);
});

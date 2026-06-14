const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const multer = require('multer');
const { PDFParse } = require('pdf-parse');

const db = require('./db');
const upload = multer({ storage: multer.memoryStorage() });
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
  res.json({
    linkedin: fs.existsSync(scraper.getAuthPath('linkedin')),
    naukri: fs.existsSync(scraper.getAuthPath('naukri')),
    ziprecruiter: fs.existsSync(scraper.getAuthPath('ziprecruiter')),
    ycombinator: fs.existsSync(scraper.getAuthPath('ycombinator')),
    cutshort: fs.existsSync(scraper.getAuthPath('cutshort'))
  });
});

// POST /api/login-linkedin
app.post('/api/login-linkedin', async (req, res) => {
  res.json({ success: true, message: 'Headed login session launching in the background...' });
  
  clearLogs();
  broadcastLog('Initializing LinkedIn login helper...');
  
  try {
    const result = await scraper.runPortalLogin('linkedin', (msg) => broadcastLog(msg));
    if (result.success) {
      broadcastLog('SUCCESS: Login session captured.');
    } else {
      broadcastLog(`ERROR: Login process did not complete. ${result.error || ''}`);
    }
  } catch (err) {
    broadcastLog(`EXCEPTION: ${err.message}`);
  }
});

// POST /api/login-portal
app.post('/api/login-portal', async (req, res) => {
  const { portal } = req.body;
  if (!portal) {
    return res.status(400).json({ error: 'Portal parameter is required.' });
  }
  
  res.json({ success: true, message: `${portal} headed login session launching in the background...` });
  
  clearLogs();
  broadcastLog(`Initializing ${portal} login helper...`);
  
  try {
    const result = await scraper.runPortalLogin(portal, (msg) => broadcastLog(msg));
    if (result.success) {
      broadcastLog(`SUCCESS: ${portal} login session captured and saved.`);
    } else {
      broadcastLog(`ERROR: ${portal} login process did not complete. ${result.error || ''}`);
    }
  } catch (err) {
    broadcastLog(`EXCEPTION: ${err.message}`);
  }
});

// POST /api/scrape
app.post('/api/scrape', async (req, res) => {
  const { maxJobs, portals } = req.body;
  const targetPortals = Array.isArray(portals) && portals.length > 0 ? portals : ['linkedin'];
  
  res.json({ success: true, message: `Job scraper task started for portals: ${targetPortals.join(', ')}...` });
  
  clearLogs();
  broadcastLog('Fetching search configuration from settings...');
  
  try {
    const settings = await db.getSettings();
    const keywords = settings.keywords || ["React Developer"];
    const location = settings.location || "India";
    const experience = settings.experience || "";
    
    broadcastLog(`Launching scraping on portals: ${JSON.stringify(targetPortals)}`);
    
    const keywordList = Array.isArray(keywords) ? keywords : [keywords];
    
    for (const portal of targetPortals) {
      broadcastLog(`=== Scraping Portal: ${portal.toUpperCase()} ===`);
      for (const kw of keywordList) {
        broadcastLog(`--- Scraping keyword: "${kw}" on ${portal.toUpperCase()} ---`);
        try {
          await scraper.scrapeJobs(
            portal,
            kw, 
            location, 
            experience, 
            parseInt(maxJobs) || 8, 
            (msg) => broadcastLog(msg)
          );
        } catch (scrapErr) {
          broadcastLog(`ERROR on ${portal.toUpperCase()} scraping "${kw}": ${scrapErr.message}`);
        }
      }
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

// DELETE /api/jobs
app.delete('/api/jobs', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Invalid or empty job IDs array.' });
  }
  try {
    await db.deleteJobs(ids);
    res.json({ success: true, message: `Successfully deleted ${ids.length} jobs.` });
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

// POST /api/resume/upload
app.post('/api/resume/upload', upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }
    
    const dataBuffer = req.file.buffer;
    const parser = new PDFParse({ data: dataBuffer });
    const result = await parser.getText();
    const text = result.text;
    await parser.destroy();
    
    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'Could not extract any text from the PDF. Ensure it is not a scanned image PDF.' });
    }

    // Save to settings DB
    await db.saveSettings({ resume: text });
    
    res.json({ success: true, text });
  } catch (err) {
    console.error("PDF Parsing Error:", err);
    res.status(500).json({ error: 'Failed to parse PDF resume: ' + err.message });
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

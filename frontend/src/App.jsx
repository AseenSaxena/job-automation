import React, { useState, useEffect, useRef } from 'react';

function App() {
  const [currentTab, setCurrentTab] = useState('dashboard');
  const [jobs, setJobs] = useState([]);
  const [settings, setSettings] = useState({
    gemini_key: '',
    resume: '',
    keywords: [],
    location: '',
    experience: ''
  });
  const [keywordInput, setKeywordInput] = useState('');
  const [loginStatus, setLoginStatus] = useState(false);
  const [selectedJob, setSelectedJob] = useState(null);
  const [scraperLogs, setScraperLogs] = useState([]);
  const [maxJobsInput, setMaxJobsInput] = useState(10);
  const [scrapingActive, setScrapingActive] = useState(false);
  const [analyzingJobId, setAnalyzingJobId] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [saveStatus, setSaveStatus] = useState('');
  const [uploadingResume, setUploadingResume] = useState(false);

  const terminalEndRef = useRef(null);

  const API_URL = 'http://localhost:3001/api';

  // Fetch all initial data
  useEffect(() => {
    fetchJobs();
    fetchSettings();
    fetchLoginStatus();
  }, []);

  // Listen to SSE logs stream
  useEffect(() => {
    const eventSource = new EventSource(`${API_URL}/logs/stream`);
    
    eventSource.onmessage = (event) => {
      try {
        const logItem = JSON.parse(event.data);
        setScraperLogs((prev) => [...prev, logItem]);
        
        // Auto-scroll terminal
        if (terminalEndRef.current) {
          terminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }

        // Toggle scraping active state based on messages
        if (logItem.message.includes('Starting LinkedIn Job Search...')) {
          setScrapingActive(true);
        } else if (logItem.message.includes('Scraping batch completed') || logItem.message.includes('SCRAPER FAILURE') || logItem.message.includes('Could not load job list')) {
          setScrapingActive(false);
          fetchJobs(); // Refresh jobs list when finished
        }
      } catch (err) {
        console.error("Error parsing SSE message:", err);
      }
    };

    return () => {
      eventSource.close();
    };
  }, []);

  const fetchJobs = async () => {
    try {
      const res = await fetch(`${API_URL}/jobs`);
      const data = await res.json();
      setJobs(data);
    } catch (err) {
      console.error("Failed to fetch jobs:", err);
    }
  };

  const fetchSettings = async () => {
    try {
      const res = await fetch(`${API_URL}/settings`);
      const data = await res.json();
      setSettings(data);
      if (data.keywords) {
        setKeywordInput(Array.isArray(data.keywords) ? data.keywords.join(', ') : data.keywords);
      }
    } catch (err) {
      console.error("Failed to fetch settings:", err);
    }
  };

  const fetchLoginStatus = async () => {
    try {
      const res = await fetch(`${API_URL}/login-status`);
      const data = await res.json();
      setLoginStatus(data.authenticated);
    } catch (err) {
      console.error("Failed to fetch login status:", err);
    }
  };

  const handleResumePdfUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (file.type !== 'application/pdf') {
      alert('Please select a PDF file.');
      return;
    }

    setUploadingResume(true);
    const formData = new FormData();
    formData.append('resume', file);

    try {
      const res = await fetch(`${API_URL}/resume/upload`, {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (data.success) {
        setSettings(prev => ({ ...prev, resume: data.text }));
        alert('Resume uploaded and text extracted successfully!');
      } else {
        alert(`Failed to extract text: ${data.error}`);
      }
    } catch (err) {
      console.error(err);
      alert('Network error uploading resume.');
    } finally {
      setUploadingResume(false);
    }
  };

  const handleSaveSettings = async (e) => {
    e.preventDefault();
    setSaveStatus('Saving...');
    try {
      const parsedKeywords = keywordInput
        .split(',')
        .map(k => k.trim())
        .filter(k => k.length > 0);

      const payload = {
        ...settings,
        keywords: parsedKeywords
      };

      const res = await fetch(`${API_URL}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        setSettings(payload);
        setSaveStatus('Saved successfully!');
        setTimeout(() => setSaveStatus(''), 3000);
      } else {
        setSaveStatus('Error saving settings.');
      }
    } catch (err) {
      console.error(err);
      setSaveStatus('Network error.');
    }
  };

  const handleUpdateStatus = async (jobId, newStatus) => {
    try {
      const res = await fetch(`${API_URL}/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      const data = await res.json();
      if (data.success) {
        // Update local state
        setJobs(prev => prev.map(job => job.id === jobId ? { ...job, status: newStatus } : job));
        if (selectedJob && selectedJob.id === jobId) {
          setSelectedJob(prev => ({ ...prev, status: newStatus }));
        }
      }
    } catch (err) {
      console.error("Failed to update status:", err);
    }
  };

  const handleAnalyzeJob = async (jobId) => {
    setAnalyzingJobId(jobId);
    try {
      const res = await fetch(`${API_URL}/jobs/${jobId}/analyze`, {
        method: 'POST'
      });
      const data = await res.json();
      if (data.success) {
        // Refresh list
        await fetchJobs();
        // Update selected job modal if open
        const updatedJob = jobs.find(j => j.id === jobId);
        if (updatedJob) {
          const rehydrated = { 
            ...updatedJob, 
            match_score: data.analysis.matchScore,
            missing_skills: JSON.stringify(data.analysis.missingSkills),
            resume_suggestions: JSON.stringify(data.analysis.resumeSuggestions),
            cover_letter: data.analysis.coverLetter
          };
          // Update selectedJob
          setSelectedJob(rehydrated);
        }
      } else {
        alert(`Analysis failed: ${data.error}`);
      }
    } catch (err) {
      console.error(err);
      alert('Network error during analysis.');
    } finally {
      setAnalyzingJobId(null);
    }
  };

  const handleStartScrape = async () => {
    setScrapingActive(true);
    setScraperLogs([]); // Clear screen
    try {
      // Auto-save search parameters first so changes are used by the scraper
      const parsedKeywords = keywordInput
        .split(',')
        .map(k => k.trim())
        .filter(k => k.length > 0);

      const payload = {
        ...settings,
        keywords: parsedKeywords
      };

      await fetch(`${API_URL}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      setSettings(payload);

      const res = await fetch(`${API_URL}/scrape`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxJobs: maxJobsInput })
      });
      const data = await res.json();
      if (!data.success) {
        setScrapingActive(false);
      }
    } catch (err) {
      console.error(err);
      setScrapingActive(false);
    }
  };

  const handleLinkedInLogin = async () => {
    try {
      setScraperLogs([]); // Clear logs for login output
      setCurrentTab('search'); // Send user to search page to watch logs
      await fetch(`${API_URL}/login-linkedin`, { method: 'POST' });
    } catch (err) {
      console.error(err);
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    alert('Cover letter copied to clipboard!');
  };

  // Helper to format score coloring classes
  const getScoreClass = (score) => {
    if (score === null || score === undefined) return 'none';
    if (score >= 80) return 'high';
    if (score >= 60) return 'medium';
    return 'low';
  };

  // Filter jobs based on selected filter tab
  const filteredJobs = jobs.filter(job => {
    if (statusFilter === 'all') return true;
    return job.status === statusFilter;
  });

  // Calculate statistics
  const stats = {
    total: jobs.length,
    pending: jobs.filter(j => j.status === 'new' || j.status === 'interested').length,
    applied: jobs.filter(j => j.status === 'applied').length,
    highMatches: jobs.filter(j => j.match_score >= 80).length
  };

  return (
    <div className="app-container">
      {/* Sidebar Navigation */}
      <aside className="sidebar">
        <div>
          <div className="brand-section">
            <div className="brand-icon">J</div>
            <h1 className="brand-title">JobBot AI</h1>
          </div>
          
          <nav className="nav-links">
            <div 
              className={`nav-item ${currentTab === 'dashboard' ? 'active' : ''}`}
              onClick={() => setCurrentTab('dashboard')}
            >
              <span className="nav-icon">📊</span> Dashboard
            </div>
            <div 
              className={`nav-item ${currentTab === 'search' ? 'active' : ''}`}
              onClick={() => setCurrentTab('search')}
            >
              <span className="nav-icon">🔍</span> LinkedIn Bot Search
            </div>
            <div 
              className={`nav-item ${currentTab === 'login' ? 'active' : ''}`}
              onClick={() => setCurrentTab('login')}
            >
              <span className="nav-icon">🔑</span> LinkedIn Login Helper
            </div>
            <div 
              className={`nav-item ${currentTab === 'settings' ? 'active' : ''}`}
              onClick={() => setCurrentTab('settings')}
            >
              <span className="nav-icon">⚙️</span> Settings & Resume
            </div>
          </nav>
        </div>

        <div className="user-status">
          <div className={`status-indicator ${loginStatus ? 'online' : 'offline'}`}></div>
          <div>
            <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>LinkedIn Sync</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              {loginStatus ? 'Connected' : 'Session Expired / Not Setup'}
            </div>
          </div>
        </div>
      </aside>

      {/* Main Panel */}
      <main className="main-content">
        {/* Dashboard Tab */}
        {currentTab === 'dashboard' && (
          <div>
            <header className="page-header">
              <h2 className="page-title">Applications Dashboard</h2>
              <p className="page-subtitle">Track matching rates, review details, and manage job states.</p>
            </header>

            {/* Stats Row */}
            <div className="stats-grid">
              <div className="glass-panel stat-card primary">
                <span className="stat-label">Total Scraped</span>
                <span className="stat-value">{stats.total}</span>
              </div>
              <div className="glass-panel stat-card warning">
                <span className="stat-label">Pending Review</span>
                <span className="stat-value">{stats.pending}</span>
              </div>
              <div className="glass-panel stat-card success">
                <span className="stat-label">Applied</span>
                <span className="stat-value">{stats.applied}</span>
              </div>
              <div className="glass-panel stat-card secondary">
                <span className="stat-label">Match &gt; 80%</span>
                <span className="stat-value">{stats.highMatches}</span>
              </div>
            </div>

            {/* Actions & Filters Bar */}
            <div className="actions-bar">
              <div className="tabs-container">
                {['all', 'new', 'interested', 'applied', 'skipped', 'interviewing', 'rejected'].map(filter => (
                  <button 
                    key={filter} 
                    className={`tab-btn ${statusFilter === filter ? 'active' : ''}`}
                    onClick={() => setStatusFilter(filter)}
                  >
                    {filter.charAt(0).toUpperCase() + filter.slice(1)}
                  </button>
                ))}
              </div>

              <button className="btn btn-primary" onClick={() => setCurrentTab('search')}>
                🔍 Run New Search
              </button>
            </div>

            {/* Jobs List Grid */}
            <div className="jobs-list-container">
              {filteredJobs.length === 0 ? (
                <div className="glass-panel" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
                  No jobs found matching the selection filter. Try running a LinkedIn search.
                </div>
              ) : (
                filteredJobs.map(job => (
                  <div 
                    key={job.id} 
                    className="glass-panel job-card"
                    onClick={() => setSelectedJob(job)}
                  >
                    <div className="job-primary-info">
                      <div className="job-title-row">
                        <h3 className="job-title">{job.title}</h3>
                        <span className="job-company">{job.company}</span>
                      </div>
                      <div className="job-meta-row">
                        <span>📍 {job.location}</span>
                        <span>📅 Scraped: {job.posted_date}</span>
                      </div>
                    </div>

                    <div>
                      <span className={`badge badge-status-${job.status}`}>
                        {job.status}
                      </span>
                    </div>

                    <div>
                      <div className={`score-pill ${getScoreClass(job.match_score)}`}>
                        {job.match_score !== null ? `${job.match_score}%` : '—'}
                      </div>
                    </div>

                    <div onClick={(e) => e.stopPropagation()}>
                      {job.match_score === null ? (
                        <button 
                          className="btn btn-secondary" 
                          onClick={() => handleAnalyzeJob(job.id)}
                          disabled={analyzingJobId === job.id}
                        >
                          {analyzingJobId === job.id ? 'Scoring...' : '🤖 Score Match'}
                        </button>
                      ) : (
                        <button 
                          className="btn"
                          onClick={() => setSelectedJob(job)}
                        >
                          Details
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* LinkedIn Bot Search Tab */}
        {currentTab === 'search' && (
          <div>
            <header className="page-header">
              <h2 className="page-title">Scraper Control Center</h2>
              <p className="page-subtitle">Configure search params and execute the Playwright LinkedIn browser bot.</p>
            </header>

            <div className="scraper-layout">
              {/* Configuration panel */}
              <div className="glass-panel settings-group">
                <h3 style={{ fontFamily: 'Outfit' }}>Search parameters</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                  <div className="form-group">
                    <label htmlFor="keywords-quick">Keywords</label>
                    <input 
                      type="text" 
                      id="keywords-quick" 
                      value={keywordInput} 
                      onChange={(e) => setKeywordInput(e.target.value)}
                      placeholder="e.g. React, Frontend" 
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="location-quick">Location</label>
                    <input 
                      type="text" 
                      id="location-quick" 
                      value={settings.location || ''} 
                      onChange={(e) => setSettings({...settings, location: e.target.value})}
                      placeholder="e.g. India or Remote" 
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="experience-quick">Experience Filter</label>
                    <select 
                      id="experience-quick" 
                      value={settings.experience || ''} 
                      onChange={(e) => setSettings({...settings, experience: e.target.value})}
                    >
                      <option value="all">No Filter (All Levels)</option>
                      <option value="entry">Entry Level (0-2 years)</option>
                      <option value="associate">Associate / Mid Level (2-5 years)</option>
                      <option value="mid-senior">Mid-Senior / Senior (5+ years)</option>
                    </select>
                  </div>
                  <div className="form-group" style={{ marginTop: '0.5rem' }}>
                    <label htmlFor="maxJobs">Max Jobs to Scrape</label>
                    <input 
                      type="number" 
                      id="maxJobs" 
                      value={maxJobsInput} 
                      onChange={(e) => setMaxJobsInput(e.target.value)}
                      min="1" 
                      max="40" 
                    />
                  </div>
                  
                  <div className="form-group" style={{ marginTop: '0.5rem' }}>
                    <label>Resume Profile (PDF)</label>
                    <input 
                      type="file" 
                      id="resume-pdf-upload"
                      accept=".pdf"
                      onChange={handleResumePdfUpload}
                      disabled={uploadingResume}
                      style={{ display: 'none' }}
                    />
                    <label 
                      htmlFor="resume-pdf-upload" 
                      className="btn" 
                      style={{ display: 'flex', justifyContent: 'center', cursor: 'pointer', padding: '0.5rem 1rem', marginTop: '0.25rem', background: 'rgba(255,255,255,0.06)' }}
                    >
                      {uploadingResume ? '⏳ Parsing Resume PDF...' : '📄 Upload Resume PDF'}
                    </label>
                    {settings.resume ? (
                      <span style={{ fontSize: '0.75rem', color: '#10b981', marginTop: '0.25rem', textAlign: 'center', display: 'block' }}>
                        ✓ Extracted {settings.resume.length} characters
                      </span>
                    ) : (
                      <span style={{ fontSize: '0.75rem', color: '#ef4444', marginTop: '0.25rem', textAlign: 'center', display: 'block' }}>
                        ✗ No resume text configured
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', alignItems: 'center' }}>
                    <button 
                      className="btn" 
                      style={{ flex: 1, padding: '0.5rem', display: 'flex', justifyContent: 'center' }} 
                      onClick={handleSaveSettings}
                    >
                      💾 Save Parameters
                    </button>
                    {saveStatus && <span style={{ fontSize: '0.75rem', color: '#a78bfa', fontWeight: 600 }}>{saveStatus}</span>}
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1.5rem' }}>
                  <button 
                    className="btn btn-primary" 
                    onClick={handleStartScrape}
                    disabled={scrapingActive}
                  >
                    {scrapingActive ? '🤖 Scraping in Progress...' : '🚀 Start LinkedIn Scraper'}
                  </button>
                  <button 
                    className="btn" 
                    onClick={() => setScraperLogs([])}
                  >
                    🗑️ Clear Console
                  </button>
                </div>
              </div>

              {/* Console logs terminal */}
              <div className="terminal-container">
                <div className="terminal-header">
                  <div className="terminal-dot-group">
                    <span className="terminal-dot red"></span>
                    <span className="terminal-dot yellow"></span>
                    <span className="terminal-dot green"></span>
                  </div>
                  <div className="terminal-title">playwright-scraper-console.log</div>
                  <div></div>
                </div>
                <div className="terminal-body">
                  {scraperLogs.length === 0 ? (
                    <div style={{ color: 'var(--text-muted)' }}>Console idle. Launch a scraping session to stream real-time logs here.</div>
                  ) : (
                    scraperLogs.map((log, index) => {
                      let type = '';
                      if (log.message.includes('ERROR') || log.message.includes('SCRAPER FAILURE') || log.message.includes('EXCEPTION')) type = 'error';
                      else if (log.message.includes('SUCCESS') || log.message.includes('saved successfully') || log.message.includes('completed successfully')) type = 'success';
                      else if (log.message.includes('WARNING')) type = 'warning';
                      
                      return (
                        <div key={index} className={`log-entry ${type}`}>
                          {log.message}
                        </div>
                      );
                    })
                  )}
                  <div ref={terminalEndRef} />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* LinkedIn Login Helper Tab */}
        {currentTab === 'login' && (
          <div>
            <header className="page-header">
              <h2 className="page-title">LinkedIn Session Sync</h2>
              <p className="page-subtitle">Authenticate manually to save cookies and bypass scraper bot verification blockades.</p>
            </header>

            <div className="glass-panel login-panel">
              <div className="linkedin-logo">💼</div>
              <h3 style={{ fontSize: '1.5rem' }}>Bypass Security Walls</h3>
              <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, maxWidth: '500px' }}>
                LinkedIn utilizes anti-bot verifications (Captchas) during automated browser logins.
                To solve this, click the button below to open a <strong>headed browser session</strong>. 
                Login manually, complete any Multi-Factor Authentication, and then the system will capture and save your session state to <code>auth.json</code>.
              </p>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(255,255,255,0.05)', padding: '0.75rem 1.25rem', borderRadius: '10px' }}>
                <span className={`status-indicator ${loginStatus ? 'online' : 'offline'}`}></span>
                <span style={{ fontWeight: 600 }}>
                  Status: {loginStatus ? 'Authenticated session active (auth.json found)' : 'Unauthenticated'}
                </span>
              </div>

              <button className="btn btn-secondary" style={{ padding: '0.85rem 2rem', fontSize: '1rem' }} onClick={handleLinkedInLogin}>
                🔐 Launch Headed Browser for Manual Login
              </button>
            </div>
          </div>
        )}

        {/* Settings & Resume Tab */}
        {currentTab === 'settings' && (
          <div>
            <header className="page-header">
              <h2 className="page-title">System Settings</h2>
              <p className="page-subtitle">Configure search parameters and load your resume profile for local match scoring.</p>
            </header>

            <form onSubmit={handleSaveSettings} className="glass-panel settings-group">
              <div className="config-grid">
                {/* Left col: Scraper search configuration */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  <h3 style={{ borderBottom: '1px solid var(--panel-border)', paddingBottom: '0.5rem' }}>Search Config</h3>
                  
                  <div className="form-group">
                    <label htmlFor="keywords">Keywords (Comma-separated)</label>
                    <input 
                      type="text" 
                      id="keywords" 
                      value={keywordInput} 
                      onChange={(e) => setKeywordInput(e.target.value)}
                      placeholder="e.g. React Developer, Next.js Developer, Frontend Architect" 
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="location">Location</label>
                    <input 
                      type="text" 
                      id="location" 
                      value={settings.location || ''} 
                      onChange={(e) => setSettings({...settings, location: e.target.value})}
                      placeholder="e.g. India or Remote" 
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="experience">Experience Level Filter</label>
                    <select 
                      id="experience" 
                      value={settings.experience || ''} 
                      onChange={(e) => setSettings({...settings, experience: e.target.value})}
                    >
                      <option value="all">No Filter (All Levels)</option>
                      <option value="entry">Entry Level (0-2 years)</option>
                      <option value="associate">Associate / Mid Level (2-5 years)</option>
                      <option value="mid-senior">Mid-Senior / Senior (5+ years)</option>
                    </select>
                  </div>

                </div>

                {/* Right col: Resume text area */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  <h3 style={{ borderBottom: '1px solid var(--panel-border)', paddingBottom: '0.5rem' }}>Resume Text Profile</h3>
                  <div className="form-group" style={{ height: '100%' }}>
                    <label htmlFor="resumeText">Paste plain text resume</label>
                    <textarea 
                      id="resumeText" 
                      value={settings.resume || ''} 
                      onChange={(e) => setSettings({...settings, resume: e.target.value})}
                      placeholder="Paste your resume contents here. The local matching algorithm will use this text to score jobs and draft tailored cover letters."
                      style={{ height: '240px', flexGrow: 1 }}
                      required
                    />
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', borderTop: '1px solid var(--panel-border)', paddingTop: '1.5rem', marginTop: '1rem' }}>
                <button type="submit" className="btn btn-primary" style={{ padding: '0.75rem 2rem' }}>
                  💾 Save Configuration
                </button>
                {saveStatus && <span style={{ fontWeight: 600, color: '#a78bfa' }}>{saveStatus}</span>}
              </div>
            </form>
          </div>
        )}
      </main>

      {/* Slide-over Detail Drawer / Modal */}
      {selectedJob && (
        <div className="modal-overlay" onClick={() => setSelectedJob(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <header className="modal-header">
              <div>
                <h2 style={{ fontSize: '1.5rem', color: 'white' }}>{selectedJob.title}</h2>
                <div className="job-detail-card-meta">
                  <span style={{ color: '#a78bfa', fontWeight: 600 }}>🏢 {selectedJob.company}</span>
                  <span>📍 {selectedJob.location}</span>
                  <span>📅 {selectedJob.posted_date}</span>
                </div>
              </div>
              <button className="modal-close" onClick={() => setSelectedJob(null)}>
                &times;
              </button>
            </header>

            <div className="modal-body-layout">
              {/* Application Tracking Actions */}
              <div style={{ display: 'flex', gap: '0.75rem', borderBottom: '1px solid var(--panel-border)', paddingBottom: '1.25rem' }}>
                <button 
                  className={`btn ${selectedJob.status === 'interested' ? 'btn-primary' : ''}`}
                  onClick={() => handleUpdateStatus(selectedJob.id, 'interested')}
                >
                  ⭐ Star Interested
                </button>
                <button 
                  className={`btn ${selectedJob.status === 'applied' ? 'btn-secondary' : ''}`}
                  onClick={() => handleUpdateStatus(selectedJob.id, 'applied')}
                >
                  ✔️ Mark Applied
                </button>
                <button 
                  className={`btn ${selectedJob.status === 'interviewing' ? 'btn-primary' : ''}`}
                  style={selectedJob.status === 'interviewing' ? { background: 'var(--warning-glow)' } : {}}
                  onClick={() => handleUpdateStatus(selectedJob.id, 'interviewing')}
                >
                  📞 Interviewing
                </button>
                <button 
                  className={`btn ${selectedJob.status === 'skipped' ? 'btn-primary' : ''}`}
                  onClick={() => handleUpdateStatus(selectedJob.id, 'skipped')}
                >
                  🚫 Skip Role
                </button>
              </div>

              {/* Match Score Display */}
              <div className="modal-score-section">
                <div className={`score-pill ${getScoreClass(selectedJob.match_score)}`} style={{ width: '70px', height: '70px', fontSize: '1.3rem' }}>
                  {selectedJob.match_score !== null ? `${selectedJob.match_score}%` : '—'}
                </div>
                <div>
                  <h3 style={{ fontSize: '1.1rem' }}>Local Matching Score</h3>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginTop: '0.25rem' }}>
                    {selectedJob.match_score !== null 
                      ? `The local ATS-matching algorithm scored this job as a ${selectedJob.match_score}% match against your resume profile.`
                      : 'Run local match scoring to evaluate fit and retrieve resume optimization tips.'}
                  </p>
                  {selectedJob.match_score === null && (
                    <button 
                      className="btn btn-secondary" 
                      style={{ marginTop: '0.75rem' }}
                      onClick={() => handleAnalyzeJob(selectedJob.id)}
                      disabled={analyzingJobId === selectedJob.id}
                    >
                      {analyzingJobId === selectedJob.id ? 'Calculating match score...' : '🤖 Analyze and Score Match'}
                    </button>
                  )}
                </div>
              </div>

              {/* AI scoring details */}
              {selectedJob.match_score !== null && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.75rem' }}>
                  {/* Missing Skills */}
                  <div className="analysis-section">
                    <label>Missing or Weak Skills</label>
                    <div className="missing-skill-tags" style={{ marginTop: '0.25rem' }}>
                      {(() => {
                        try {
                          const skills = JSON.parse(selectedJob.missing_skills || '[]');
                          if (skills.length === 0) return <span style={{ color: 'var(--score-high)', fontSize: '0.9rem' }}>✦ None! You possess all primary requirements listed!</span>;
                          return skills.map((skill, idx) => (
                            <span key={idx} className="skill-tag">{skill}</span>
                          ));
                        } catch {
                          return <span style={{ color: 'var(--text-secondary)' }}>None identified.</span>;
                        }
                      })()}
                    </div>
                  </div>

                  {/* Suggestions */}
                  <div className="analysis-section">
                    <label>Resume Tailoring Recommendations</label>
                    <ul className="analysis-list" style={{ marginTop: '0.25rem' }}>
                      {(() => {
                        try {
                          const suggestions = JSON.parse(selectedJob.resume_suggestions || '[]');
                          if (suggestions.length === 0) return <li className="analysis-list-item" style={{ fontSize: '0.9rem' }}>No changes needed. Your resume matches perfectly.</li>;
                          return suggestions.map((sug, idx) => (
                            <li key={idx} className="analysis-list-item">{sug}</li>
                          ));
                        } catch {
                          return <li className="analysis-list-item">No suggestions.</li>;
                        }
                      })()}
                    </ul>
                  </div>

                  {/* Tailored Cover Letter */}
                  <div className="analysis-section">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <label>Generated Custom Cover Letter</label>
                      <button 
                        className="btn" 
                        style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}
                        onClick={() => copyToClipboard(selectedJob.cover_letter)}
                      >
                        📋 Copy Letter
                      </button>
                    </div>
                    <div className="cover-letter-box" style={{ marginTop: '0.5rem' }}>
                      {selectedJob.cover_letter || 'Cover letter generation failed or was empty.'}
                    </div>
                  </div>
                </div>
              )}

              {/* Job Description details */}
              <div className="analysis-section">
                <label>Full Job Description</label>
                <div className="description-text" style={{ marginTop: '0.5rem' }}>
                  {selectedJob.description}
                </div>
                <div style={{ marginTop: '0.75rem' }}>
                  <a 
                    href={selectedJob.link} 
                    target="_blank" 
                    rel="noopener noreferrer" 
                    className="btn btn-primary"
                    style={{ textDecoration: 'none' }}
                  >
                    🔗 View Job post on LinkedIn
                  </a>
                </div>
              </div>
            </div>

            <footer className="modal-footer">
              <button className="btn" onClick={() => setSelectedJob(null)}>
                Dismiss
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;

import React, { useState, useEffect, useRef } from 'react';

const parsePostedDate = (dateStr) => {
  if (!dateStr) return new Date(0);
  
  const now = new Date();
  const cleanStr = dateStr.trim().toLowerCase();
  
  // Try matching DD/MM/YYYY
  const dateParts = cleanStr.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (dateParts) {
    return new Date(parseInt(dateParts[3]), parseInt(dateParts[2]) - 1, parseInt(dateParts[1]));
  }
  
  // Try matching "X units ago"
  const numberMatch = cleanStr.match(/^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago/);
  if (numberMatch) {
    const val = parseInt(numberMatch[1], 10);
    const unit = numberMatch[2];
    const d = new Date(now);
    
    if (unit === 'minute') d.setMinutes(now.getMinutes() - val);
    else if (unit === 'hour') d.setHours(now.getHours() - val);
    else if (unit === 'day') d.setDate(now.getDate() - val);
    else if (unit === 'week') d.setDate(now.getDate() - val * 7);
    else if (unit === 'month') d.setMonth(now.getMonth() - val);
    else if (unit === 'year') d.setFullYear(now.getFullYear() - val);
    
    return d;
  }
  
  if (cleanStr.includes('today') || cleanStr.includes('just now') || cleanStr.includes('active now')) {
    return now;
  }
  if (cleanStr.includes('yesterday')) {
    const d = new Date(now);
    d.setDate(now.getDate() - 1);
    return d;
  }
  
  const parsed = Date.parse(dateStr);
  if (!isNaN(parsed)) {
    return new Date(parsed);
  }
  
  return new Date(0);
};

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
  const [loginStatus, setLoginStatus] = useState({
    linkedin: false,
    naukri: false,
    ziprecruiter: false,
    ycombinator: false,
    cutshort: false
  });
  const [selectedJob, setSelectedJob] = useState(null);
  const [scraperLogs, setScraperLogs] = useState([]);
  const [maxJobsInput, setMaxJobsInput] = useState(10);
  const [scrapingActive, setScrapingActive] = useState(false);
  const [analyzingJobId, setAnalyzingJobId] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [saveStatus, setSaveStatus] = useState('');
  const [uploadingResume, setUploadingResume] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedJobIds, setSelectedJobIds] = useState([]);
  const [scoreFilter, setScoreFilter] = useState('all');
  const [dateFilter, setDateFilter] = useState('all');
  const [sortBy, setSortBy] = useState('newest');
  const [selectedPortals, setSelectedPortals] = useState(['linkedin']);
  const [portalFilter, setPortalFilter] = useState('all');

  useEffect(() => {
    setSelectedJobIds([]);
  }, [statusFilter, scoreFilter, dateFilter, sortBy, portalFilter]);

  const handleTabClick = (tab) => {
    setCurrentTab(tab);
    setSidebarOpen(false);
  };

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
      setLoginStatus(data);
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

  const handleDeleteSelected = async () => {
    if (selectedJobIds.length === 0) return;
 
    try {
      const res = await fetch(`${API_URL}/jobs`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedJobIds })
      });
      const data = await res.json();
      if (data.success) {
        setSelectedJobIds([]);
        fetchJobs();
      } else {
        alert(`Failed to delete jobs: ${data.error}`);
      }
    } catch (err) {
      console.error(err);
      alert('Network error deleting jobs.');
    }
  };

  const handleDeleteSingle = async (jobId) => {
    try {
      const res = await fetch(`${API_URL}/jobs`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [jobId] })
      });
      const data = await res.json();
      if (data.success) {
        fetchJobs();
      } else {
        alert(`Failed to delete job: ${data.error}`);
      }
    } catch (err) {
      console.error(err);
      alert('Network error deleting job.');
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
        body: JSON.stringify({ maxJobs: maxJobsInput, portals: selectedPortals })
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

  const handlePortalLogin = async (portal) => {
    try {
      setScraperLogs([]); // Clear logs for login output
      setCurrentTab('search'); // Send user to search page to watch logs
      await fetch(`${API_URL}/login-portal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portal })
      });
    } catch (err) {
      console.error(err);
    }
  };

  const handleLinkedInLogin = () => handlePortalLogin('linkedin');

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

  // Filter and sort jobs based on tab, score threshold, date range, and sort preferences
  const processedJobs = jobs
    .filter(job => {
      // 1. Status Filter Tab
      if (statusFilter !== 'all' && job.status !== statusFilter) return false;

      // 2. Match Score Filter
      if (scoreFilter === 'high') {
        if (job.match_score === null || job.match_score < 80) return false;
      } else if (scoreFilter === 'medium') {
        if (job.match_score === null || job.match_score < 60 || job.match_score >= 80) return false;
      } else if (scoreFilter === 'low') {
        if (job.match_score === null || job.match_score >= 60) return false;
      } else if (scoreFilter === 'none') {
        if (job.match_score !== null) return false;
      }

      // 3. Date Posted Filter
      if (dateFilter !== 'all') {
        const postedDate = parsePostedDate(job.posted_date);
        const now = new Date();
        const diffTime = Math.abs(now - postedDate);
        const diffHours = diffTime / (1000 * 60 * 60);

        if (dateFilter === '24h' && diffHours > 24) return false;
        if (dateFilter === 'week' && diffHours > 24 * 7) return false;
        if (dateFilter === 'month' && diffHours > 24 * 30) return false;
      }

      // 4. Portal Filter
      if (portalFilter !== 'all' && (job.portal || 'linkedin') !== portalFilter) return false;

      return true;
    })
    .sort((a, b) => {
      if (sortBy === 'newest') {
        return parsePostedDate(b.posted_date) - parsePostedDate(a.posted_date);
      } else if (sortBy === 'oldest') {
        return parsePostedDate(a.posted_date) - parsePostedDate(b.posted_date);
      } else if (sortBy === 'highest_match') {
        const scoreA = a.match_score !== null ? a.match_score : -1;
        const scoreB = b.match_score !== null ? b.match_score : -1;
        return scoreB - scoreA;
      } else if (sortBy === 'lowest_match') {
        const scoreA = a.match_score !== null ? a.match_score : 999;
        const scoreB = b.match_score !== null ? b.match_score : 999;
        return scoreA - scoreB;
      }
      return 0;
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
      {/* Mobile Header */}
      <header className="mobile-header">
        <button className="hamburger-btn" onClick={() => setSidebarOpen(true)}>
          ☰
        </button>
        <div className="mobile-brand">
          <div className="brand-icon" style={{ width: '30px', height: '30px', fontSize: '0.9rem', borderRadius: '6px' }}>J</div>
          <span className="brand-title" style={{ fontSize: '1.1rem' }}>JobBot AI</span>
        </div>
      </header>

      {/* Sidebar Overlay */}
      {sidebarOpen && (
        <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar Navigation */}
      <aside className={`sidebar ${sidebarOpen ? 'mobile-open' : ''}`}>
        <div>
          <div className="brand-section">
            <div className="brand-icon">J</div>
            <h1 className="brand-title">JobBot AI</h1>
          </div>
          
          <nav className="nav-links">
            <div 
              className={`nav-item ${currentTab === 'dashboard' ? 'active' : ''}`}
              onClick={() => handleTabClick('dashboard')}
            >
              <span className="nav-icon">📊</span> Dashboard
            </div>
            <div 
              className={`nav-item ${currentTab === 'search' ? 'active' : ''}`}
              onClick={() => handleTabClick('search')}
            >
              <span className="nav-icon">🔍</span> Job Bot Search
            </div>
            <div 
              className={`nav-item ${currentTab === 'login' ? 'active' : ''}`}
              onClick={() => handleTabClick('login')}
            >
              <span className="nav-icon">🔑</span> Job Portal Login Helper
            </div>
            <div 
              className={`nav-item ${currentTab === 'settings' ? 'active' : ''}`}
              onClick={() => handleTabClick('settings')}
            >
              <span className="nav-icon">⚙️</span> Settings & Resume
            </div>
          </nav>
        </div>

        <div className="user-status">
          <div className={`status-indicator ${Object.values(loginStatus).filter(Boolean).length > 0 ? 'online' : 'offline'}`}></div>
          <div>
            <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>Portal Sync Status</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              {Object.values(loginStatus).filter(Boolean).length} / 5 Active
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

            {/* Sorting and Filtering controls */}
            <div className="filter-sort-bar">
              <div className="filter-group">
                <div className="control-item">
                  <label htmlFor="score-filter-select">Score Match</label>
                  <select 
                    id="score-filter-select"
                    value={scoreFilter} 
                    onChange={(e) => setScoreFilter(e.target.value)}
                  >
                    <option value="all">All Match Scores</option>
                    <option value="high">High Match (≥ 80%)</option>
                    <option value="medium">Medium Match (60% - 79%)</option>
                    <option value="low">Low Match (&lt; 60%)</option>
                    <option value="none">Unanalyzed (No Score)</option>
                  </select>
                </div>
                
                <div className="control-item">
                  <label htmlFor="date-filter-select">Date Posted</label>
                  <select 
                    id="date-filter-select"
                    value={dateFilter} 
                    onChange={(e) => setDateFilter(e.target.value)}
                  >
                    <option value="all">All Dates</option>
                    <option value="24h">Past 24 Hours</option>
                    <option value="week">Past Week</option>
                    <option value="month">Past Month</option>
                  </select>
                </div>

                <div className="control-item">
                  <label htmlFor="portal-filter-select">Portal</label>
                  <select 
                    id="portal-filter-select"
                    value={portalFilter} 
                    onChange={(e) => setPortalFilter(e.target.value)}
                  >
                    <option value="all">All Portals</option>
                    <option value="linkedin">LinkedIn</option>
                    <option value="naukri">Naukri</option>
                    <option value="ziprecruiter">ZipRecruiter</option>
                    <option value="ycombinator">YCombinator</option>
                    <option value="cutshort">Cutshort</option>
                  </select>
                </div>
              </div>

              <div className="sort-group">
                <div className="control-item">
                  <label htmlFor="sort-select">Sort By</label>
                  <select 
                    id="sort-select"
                    value={sortBy} 
                    onChange={(e) => setSortBy(e.target.value)}
                  >
                    <option value="newest">Newest Posted</option>
                    <option value="oldest">Oldest Posted</option>
                    <option value="highest_match">Highest Match Score</option>
                    <option value="lowest_match">Lowest Match Score</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Bulk Actions Bar */}
            {processedJobs.length > 0 && (
              <div className="bulk-actions-bar">
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <input 
                    type="checkbox" 
                    id="select-all-checkbox"
                    checked={processedJobs.length > 0 && selectedJobIds.length === processedJobs.length}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedJobIds(processedJobs.map(j => j.id));
                      } else {
                        setSelectedJobIds([]);
                      }
                    }}
                    style={{ cursor: 'pointer', width: '18px', height: '18px' }}
                  />
                  <label htmlFor="select-all-checkbox" style={{ cursor: 'pointer', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                    Select All ({processedJobs.length} jobs)
                  </label>
                </div>

                {selectedJobIds.length > 0 && (
                  <button 
                    className="btn btn-danger" 
                    onClick={handleDeleteSelected}
                    style={{ padding: '0.5rem 1rem', fontSize: '0.875rem' }}
                  >
                    🗑️ Delete Selected ({selectedJobIds.length})
                  </button>
                )}
              </div>
            )}

            {/* Jobs List Grid */}
            <div className="jobs-list-container">
              {processedJobs.length === 0 ? (
                <div className="glass-panel" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
                  No jobs found matching the selection filter. Try running a LinkedIn search.
                </div>
              ) : (
                processedJobs.map(job => (
                  <div 
                    key={job.id} 
                    className="glass-panel job-card"
                    onClick={() => setSelectedJob(job)}
                  >
                    <div onClick={(e) => e.stopPropagation()} className="job-card-checkbox-wrapper">
                      <input 
                        type="checkbox"
                        checked={selectedJobIds.includes(job.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedJobIds(prev => [...prev, job.id]);
                          } else {
                            setSelectedJobIds(prev => prev.filter(id => id !== job.id));
                          }
                        }}
                        style={{ cursor: 'pointer', width: '18px', height: '18px' }}
                      />
                    </div>
                    <div className="job-primary-info">
                      <div className="job-title-row">
                        <h3 className="job-title">{job.title}</h3>
                        <span className="job-company">{job.company}</span>
                      </div>
                      <div className="job-meta-row">
                        <span>📍 {job.location}</span>
                        {job.experience && job.experience !== 'Not Specified' && (
                          <span>💼 {job.experience}</span>
                        )}
                        <span>📅 {job.posted_date}</span>
                      </div>
                    </div>

                    <div className="job-card-badge-wrapper" style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', alignItems: 'flex-start' }}>
                      <span className={`badge badge-status-${job.status}`}>
                        {job.status}
                      </span>
                      <span className="badge" style={{ 
                        background: (job.portal || 'linkedin') === 'linkedin' ? 'rgba(10, 102, 194, 0.15)' :
                                    (job.portal || 'linkedin') === 'naukri' ? 'rgba(74, 144, 226, 0.15)' :
                                    (job.portal || 'linkedin') === 'ziprecruiter' ? 'rgba(0, 204, 102, 0.15)' :
                                    (job.portal || 'linkedin') === 'ycombinator' ? 'rgba(255, 102, 0, 0.15)' :
                                    'rgba(185, 28, 28, 0.15)',
                        color: (job.portal || 'linkedin') === 'linkedin' ? '#0a66c2' :
                               (job.portal || 'linkedin') === 'naukri' ? '#4a90e2' :
                               (job.portal || 'linkedin') === 'ziprecruiter' ? '#00cc66' :
                               (job.portal || 'linkedin') === 'ycombinator' ? '#ff6600' :
                               '#f87171',
                        border: (job.portal || 'linkedin') === 'linkedin' ? '1px solid rgba(10, 102, 194, 0.3)' :
                                (job.portal || 'linkedin') === 'naukri' ? '1px solid rgba(74, 144, 226, 0.3)' :
                                (job.portal || 'linkedin') === 'ziprecruiter' ? '1px solid rgba(0, 204, 102, 0.3)' :
                                (job.portal || 'linkedin') === 'ycombinator' ? '1px solid rgba(255, 102, 0, 0.3)' :
                                '1px solid rgba(185, 28, 28, 0.3)',
                        textTransform: 'capitalize'
                      }}>
                        🔑 {job.portal || 'linkedin'}
                      </span>
                    </div>

                    <div className="job-card-score-wrapper">
                      <div className={`score-pill ${getScoreClass(job.match_score)}`}>
                        {job.match_score !== null ? `${job.match_score}%` : '—'}
                      </div>
                    </div>

                    <div onClick={(e) => e.stopPropagation()} className="job-card-actions-wrapper">
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
                      <button 
                        className="btn btn-danger" 
                        onClick={() => handleDeleteSingle(job.id)}
                        title="Delete Job"
                      >
                        Delete
                      </button>
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
              <p className="page-subtitle">Configure search params and execute the multi-portal browser scraping bots.</p>
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
                  
                  <div className="form-group" style={{ marginTop: '0.75rem' }}>
                    <label>Target Job Portals</label>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.5rem', marginTop: '0.25rem', padding: '0.75rem', background: 'rgba(0,0,0,0.15)', borderRadius: '8px', border: '1px solid var(--panel-border)' }}>
                      {['linkedin', 'naukri', 'ziprecruiter', 'ycombinator', 'cutshort'].map(p => (
                        <label key={p} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', textTransform: 'capitalize', fontSize: '0.8rem', fontWeight: 500, color: 'var(--text-primary)' }}>
                          <input 
                            type="checkbox" 
                            checked={selectedPortals.includes(p)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedPortals([...selectedPortals, p]);
                              } else {
                                setSelectedPortals(selectedPortals.filter(x => x !== p));
                              }
                            }}
                            style={{ cursor: 'pointer', width: '14px', height: '14px', margin: 0 }}
                          />
                          {p === 'ycombinator' ? 'YCombinator' : p}
                        </label>
                      ))}
                    </div>
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
                    {scrapingActive ? '🤖 Scraping in Progress...' : '🚀 Start Scraper Bot'}
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

        {/* Job Portal Login Helper Tab */}
        {currentTab === 'login' && (
          <div>
            <header className="page-header">
              <h2 className="page-title">Job Portal Login Helper</h2>
              <p className="page-subtitle">Sync manual authentication cookies for any portal to bypass scraper bot security blockades.</p>
            </header>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
              {[
                { id: 'linkedin', name: 'LinkedIn', url: 'https://www.linkedin.com', logo: '/linkedin-logo.png', color: '#0a66c2' },
                { id: 'naukri', name: 'Naukri', url: 'https://www.naukri.com', logo: '/naukari-logo.png', color: '#4a90e2' },
                { id: 'ziprecruiter', name: 'ZipRecruiter', url: 'https://www.ziprecruiter.com', logo: '/ziprecruiter-logo.png', color: '#00cc66' },
                { id: 'ycombinator', name: 'YCombinator', url: 'https://www.ycombinator.com', logo: '/ycombinator-logo.png', color: '#ff6600' },
                { id: 'cutshort', name: 'Cutshort', url: 'https://cutshort.io', logo: '/cutshort-logo.png', color: '#b91c1c' }
              ].map(portal => {
                const isActive = loginStatus[portal.id];
                return (
                  <div key={portal.id} className="glass-panel" style={{ padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.25rem', alignItems: 'center', textAlign: 'center' }}>
                    <div style={{
                      width: '72px', height: '72px', borderRadius: '18px',
                      background: 'rgba(255,255,255,0.06)',
                      border: `1px solid ${portal.color}44`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      boxShadow: `0 0 20px ${portal.color}33`,
                      overflow: 'hidden',
                      padding: '10px'
                    }}>
                      <img
                        src={portal.logo}
                        alt={`${portal.name} logo`}
                        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                      />
                    </div>
                    <div>
                      <h3 style={{ fontSize: '1.25rem', marginBottom: '0.25rem' }}>{portal.name}</h3>
                      <a href={portal.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textDecoration: 'none' }}>
                        {portal.url.replace('https://', '')} ↗
                      </a>
                    </div>
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      Launch headed browser to log in manually and save session cookies to bypass security checks.
                    </p>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(255,255,255,0.05)', padding: '0.5rem 1rem', borderRadius: '8px', fontSize: '0.85rem', width: '100%', justifyContent: 'center' }}>
                      <span className={`status-indicator ${isActive ? 'online' : 'offline'}`}></span>
                      <span style={{ fontWeight: 600 }}>
                        {isActive ? 'Session Active' : 'Unauthenticated'}
                      </span>
                    </div>

                    <button 
                      className="btn btn-secondary" 
                      style={{ width: '100%', justifyContent: 'center', padding: '0.75rem', fontSize: '0.9rem', border: '1px solid rgba(255, 255, 255, 0.1)' }}
                      onClick={() => handlePortalLogin(portal.id)}
                    >
                      🔐 Launch Login
                    </button>
                  </div>
                );
              })}
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
                  <span style={{ textTransform: 'capitalize', fontWeight: 600, color: '#f3f4f6' }}>🔑 {selectedJob.portal || 'linkedin'}</span>
                  <span>📍 {selectedJob.location}</span>
                  {selectedJob.experience && selectedJob.experience !== 'Not Specified' && (
                    <span>💼 {selectedJob.experience}</span>
                  )}
                  <span>📅 {selectedJob.posted_date}</span>
                </div>
              </div>
              <button className="modal-close" onClick={() => setSelectedJob(null)}>
                &times;
              </button>
            </header>

            <div className="modal-body-layout">
              {/* Application Tracking Actions */}
              <div className="modal-action-buttons">
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

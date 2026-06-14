const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const authPath = path.join(__dirname, 'auth.json');

// Helper to log logs to both console and a custom stream callback
function logMsg(callback, message) {
  const formatted = `[${new Date().toLocaleTimeString()}] ${message}`;
  console.log(formatted);
  if (callback) callback(formatted);
}

async function runLinkedInLogin(logCallback) {
  logMsg(logCallback, 'Launching headed browser for LinkedIn login...');
  const browser = await chromium.launch({
    headless: false
  });
  
  const context = await browser.newContext();
  const page = await context.newPage();
  
  logMsg(logCallback, 'Navigating to LinkedIn login page...');
  await page.goto('https://www.linkedin.com/login');
  
  logMsg(logCallback, 'Waiting for you to log in manually in the browser window...');
  
  try {
    // Wait for the URL to contain "feed" or look for a selector that only appears when logged in (like global nav)
    // We give the user 2 minutes (120000 ms) to complete login + 2FA
    await Promise.race([
      page.waitForURL('**/feed/**', { timeout: 120000 }),
      page.waitForSelector('.global-nav', { timeout: 120000 })
    ]);
    
    logMsg(logCallback, 'Successfully detected logged-in state!');
    logMsg(logCallback, 'Saving authentication state to auth.json...');
    
    // Save storage state to authPath
    await context.storageState({ path: authPath });
    logMsg(logCallback, 'auth.json saved successfully!');
    
    await browser.close();
    return { success: true };
  } catch (error) {
    logMsg(logCallback, `Login failed or timed out: ${error.message}`);
    await browser.close();
    return { success: false, error: error.message };
  }
}

async function scrapeLinkedInJobs(keywords, location, experience, maxJobs = 15, logCallback) {
  logMsg(logCallback, `Starting LinkedIn Job Search...`);
  logMsg(logCallback, `Keywords: ${JSON.stringify(keywords)}, Location: ${location}, Experience: ${experience}`);

  const hasAuth = fs.existsSync(authPath);
  if (!hasAuth) {
    logMsg(logCallback, `WARNING: auth.json not found. Running scraping in unauthenticated/public mode.`);
    logMsg(logCallback, `We recommend logging in through the Login tab first to bypass LinkedIn's public wall.`);
  } else {
    logMsg(logCallback, `Loaded existing login session from auth.json.`);
  }

  const browser = await chromium.launch({
    headless: true // Run headlessly for automatic searches
  });

  // Create context using auth.json if available
  const context = hasAuth 
    ? await browser.newContext({ storageState: authPath, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' })
    : await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });

  const page = await context.newPage();
  
  // Assemble Search URL
  // Keywords parameter is usually 'keywords'
  // Location is 'location'
  let searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keywords)}&location=${encodeURIComponent(location)}`;
  
  // Map experience levels if specified
  // LinkedIn filters: f_E=1 (Internship), f_E=2 (Entry level), f_E=3 (Associate), f_E=4 (Mid-Senior), f_E=5 (Director), f_E=6 (Executive)
  if (experience) {
    const expLower = experience.toLowerCase();
    if (expLower.includes('intern')) {
      searchUrl += '&f_E=1';
    } else if (expLower.includes('entry') || expLower.includes('0-2')) {
      searchUrl += '&f_E=2';
    } else if (expLower.includes('associate') || expLower.includes('2-5')) {
      searchUrl += '&f_E=3';
    } else if (expLower.includes('mid') || expLower.includes('senior')) {
      searchUrl += '&f_E=4';
    } else if (expLower.includes('director')) {
      searchUrl += '&f_E=5';
    }
  }

  logMsg(logCallback, `Navigating to search page: ${searchUrl}`);
  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (err) {
    logMsg(logCallback, `Error loading search page: ${err.message}. Retrying...`);
    await page.goto(searchUrl, { waitUntil: 'load', timeout: 60000 });
  }

  logMsg(logCallback, 'Waiting for job list container to load...');
  
  // Wait for list or standard card selectors
  const listSelectors = [
    '.jobs-search-results-list',
    '.scaffold-layout__list-container',
    '.jobs-search-results__list',
    '.job-search-card',
    '.base-card'
  ];
  
  let listSelector = null;
  for (const selector of listSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 8000 });
      listSelector = selector;
      logMsg(logCallback, `Found job list layout element: "${selector}"`);
      break;
    } catch {
      // ignore and try next
    }
  }

  if (!listSelector) {
    logMsg(logCallback, 'No typical job list elements found. LinkedIn might be displaying a login wall or captcha.');
    // Let's capture a screenshot of the issue for user reference
    const errorScr = path.join(__dirname, 'error_screenshot.png');
    await page.screenshot({ path: errorScr });
    logMsg(logCallback, `Saved error screenshot to: ${errorScr}`);
    await browser.close();
    return { success: false, error: 'Could not load job list. Captcha or login wall encountered.' };
  }

  logMsg(logCallback, 'Scrolling job list to trigger lazy loading...');
  // Find the scrollable container and scroll down
  // On LinkedIn, it's typically the job list container or the window itself
  try {
    const scrollContainer = await page.locator('.jobs-search-results-list, .jobs-search-results-list__container, .scaffold-layout__list').first();
    if (await scrollContainer.count() > 0) {
      logMsg(logCallback, 'Scrolling inner job list container...');
      for (let i = 0; i < 5; i++) {
        await scrollContainer.evaluate((el) => el.scrollTop = el.scrollHeight * (i / 4));
        await page.waitForTimeout(1000);
      }
    } else {
      logMsg(logCallback, 'Scrolling page body...');
      for (let i = 0; i < 5; i++) {
        await page.evaluate((i) => window.scrollTo(0, document.body.scrollHeight * (i / 4)), i);
        await page.waitForTimeout(1000);
      }
    }
  } catch (scrollErr) {
    logMsg(logCallback, `Scroll failed: ${scrollErr.message}`);
  }

  // Extract job card info
  logMsg(logCallback, 'Extracting job cards...');
  const cardSelectors = [
    '[data-occludable-job-id]',
    '.job-card-container',
    '.jobs-search-results__list-item',
    '.scaffold-layout__list-item',
    '.job-search-card',
    '.base-card'
  ];

  let jobCards = [];
  for (const s of cardSelectors) {
    const cards = await page.locator(s).all();
    if (cards.length > 0) {
      jobCards = cards;
      logMsg(logCallback, `Found ${cards.length} job cards using selector "${s}"`);
      break;
    }
  }

  if (jobCards.length === 0) {
    logMsg(logCallback, 'Could not locate any job cards.');
    await browser.close();
    return { success: true, count: 0 };
  }

  const jobsList = [];
  const processedIds = new Set();

  for (const card of jobCards) {
    if (jobsList.length >= maxJobs) break;

    try {
      // 1. Get Job ID
      let jobId = await card.getAttribute('data-id') || 
                  await card.getAttribute('data-job-id') || 
                  await card.getAttribute('data-occludable-job-id');
      
      if (!jobId) {
        const urn = await card.getAttribute('data-entity-urn');
        if (urn) {
          const match = urn.match(/jobPosting:(\d+)/);
          if (match) jobId = match[1];
        }
      }

      if (!jobId) {
        // Try getting it from link attributes
        const linkEl = card.locator('a[href*="/jobs/view/"]');
        if (await linkEl.count() > 0) {
          const href = await linkEl.first().getAttribute('href');
          const match = href.match(/\/jobs\/view\/(?:[^\?\/]+-)?(\d+)/) || 
                        href.match(/\/jobs\/view\/(\d+)/) || 
                        href.match(/(\d{9,})/);
          if (match) jobId = match[1];
        }
      }

      if (!jobId || processedIds.has(jobId)) continue;
      processedIds.add(jobId);

      // 2. Get Title
      let title = '';
      const titleSelectors = [
        '.base-search-card__title',
        'h3.base-search-card__title',
        'a.job-card-list__title', 
        '.job-card-list__title-link', 
        '.job-card-container__link', 
        '.base-card__title',
        'h3'
      ];
      for (const s of titleSelectors) {
        const el = card.locator(s);
        if (await el.count() > 0) {
          title = (await el.first().innerText()).trim();
          if (title) break;
        }
      }

      // 3. Get Company
      let company = '';
      const companySelectors = [
        '.base-search-card__subtitle',
        'h4.base-search-card__subtitle',
        'a.hidden-nested-link',
        '.job-card-container__company-name', 
        '.job-card-container__primary-description', 
        '.job-card-list__company-name', 
        '.base-card__subtitle',
        'h4'
      ];
      for (const s of companySelectors) {
        const el = card.locator(s);
        if (await el.count() > 0) {
          company = (await el.first().innerText()).trim();
          if (company) break;
        }
      }

      // 4. Get Location
      let jobLocation = '';
      const locationSelectors = [
        '.job-search-card__location',
        'span.job-search-card__location',
        '.job-card-container__metadata-item', 
        '.job-card-container__secondary-description', 
        '.job-card-list__metadata-item', 
        '.job-card-container__metadata'
      ];
      for (const s of locationSelectors) {
        const el = card.locator(s);
        if (await el.count() > 0) {
          jobLocation = (await el.first().innerText()).trim();
          if (jobLocation) break;
        }
      }

      // 5. Get Posted Date (from LinkedIn card)
      let postedDate = '';
      const dateSelectors = [
        'time.job-search-card__listdate',
        '.job-search-card__listdate',
        '.job-card-container__listed-time',
        '.job-card-list__footer-item',
        'time'
      ];
      for (const s of dateSelectors) {
        const el = card.locator(s);
        if (await el.count() > 0) {
          const text = (await el.first().innerText()).trim();
          if (text) {
            postedDate = text;
            break;
          }
        }
      }

      if (!title || !company) continue;

      const cleanLink = `https://www.linkedin.com/jobs/view/${jobId}/`;

      jobsList.push({
        id: jobId,
        title,
        company,
        location: jobLocation || location,
        link: cleanLink,
        posted_date: postedDate || new Date().toLocaleDateString()
      });
    } catch (err) {
      // Skip invalid cards
    }
  }

  logMsg(logCallback, `Found ${jobsList.length} unique jobs in results list.`);

  // Stage 2: Retrieve Full Description for each job by direct navigation
  let newJobsSaved = 0;
  for (let i = 0; i < jobsList.length; i++) {
    const job = jobsList[i];
    logMsg(logCallback, `[${i + 1}/${jobsList.length}] Scraping description: "${job.title}" at "${job.company}"`);

    // Check if it already exists in database
    const database = await db.getDb();
    const existingJob = await database.get('SELECT id FROM jobs WHERE id = ?', [job.id]);
    if (existingJob) {
      logMsg(logCallback, `-> Already exists in DB. Skipping description fetch.`);
      continue;
    }

    try {
      // Navigate directly to the job page for clean scrape
      await page.goto(job.link, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1500); // Allow brief render time

      const descriptionSelectors = [
        '#job-details',
        '.jobs-description-content__text',
        '.jobs-description__content',
        '.jobs-box__html-content',
        '.description__text'
      ];
      
      let description = '';
      for (const selector of descriptionSelectors) {
        const element = page.locator(selector);
        if (await element.count() > 0) {
          description = await element.first().innerText();
          if (description) break;
        }
      }

      job.description = description.trim() || 'Description not found or required login wrapper.';
      
      // Extract experience/seniority level from the page criteria
      let experienceLevel = '';
      try {
        const criteriaItems = await page.locator('.description__job-criteria-item').all();
        for (const item of criteriaItems) {
          const text = await item.innerText();
          if (text.toLowerCase().includes('seniority level')) {
            const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length > 1) {
              experienceLevel = lines[1];
              break;
            }
          }
        }
        if (!experienceLevel) {
          const authCriteria = await page.locator('.job-details-jobs-description-header__job-criteria-item, .jobs-description-details__list-item').all();
          for (const item of authCriteria) {
            const text = await item.innerText();
            if (text.toLowerCase().includes('seniority') || text.toLowerCase().includes('experience')) {
              experienceLevel = text.replace(/Seniority level|Seniority Level|Seniority/gi, '').trim();
              experienceLevel = experienceLevel.split('\n')[0].trim();
              break;
            }
          }
        }
      } catch (critErr) {
        // Ignore
      }

      // Regex fallback from description
      let expYears = '';
      if (job.description) {
        const match = job.description.match(/(\d+\+?\s*(?:to|-)\s*\d*\+?\s*years?\s*(?:of\s*)?experience)/i) || 
                      job.description.match(/(\d+\+?\s*years?\s*(?:of\s*)?experience)/i) || 
                      job.description.match(/(\d+\+?\s*yrs?\s*(?:of\s*)?experience)/i);
        if (match) {
          expYears = match[1].trim();
        }
      }

      let finalExperience = '';
      if (experienceLevel && expYears) {
        finalExperience = `${experienceLevel} (${expYears})`;
      } else {
        finalExperience = experienceLevel || expYears || 'Not Specified';
      }
      job.experience = finalExperience;

      // Try to parse posted date from detail page if it's the scraped date default
      if (job.posted_date && job.posted_date.includes('/')) {
        try {
          const detailDateSelectors = [
            '.posted-time-ago__text',
            '.jobs-unified-top-card__posted-date',
            'span.jobs-unified-top-card__posted-date'
          ];
          for (const s of detailDateSelectors) {
            const el = page.locator(s);
            if (await el.count() > 0) {
              const text = (await el.first().innerText()).trim();
              if (text && (text.toLowerCase().includes('ago') || text.toLowerCase().includes('posted') || text.toLowerCase().includes('listed'))) {
                job.posted_date = text;
                break;
              }
            }
          }
        } catch (e) {
          // Ignore
        }
      }

      // Save job to db
      await db.saveJob(job);
      newJobsSaved++;

      // Polite delay
      await page.waitForTimeout(1000 + Math.random() * 1000);
    } catch (err) {
      logMsg(logCallback, `-> Error scraping detail: ${err.message}`);
      job.description = 'Failed to load description details.';
      await db.saveJob(job);
    }
  }

  logMsg(logCallback, `Completed search. Saved ${newJobsSaved} new jobs to the database.`);
  await browser.close();
  return { success: true, count: jobsList.length, saved: newJobsSaved };
}

async function scrapeJobs(portal, keywords, location, experience, maxJobs, logCallback) {
  if (portal === 'linkedin') {
    return scrapeLinkedInJobs(keywords, location, experience, maxJobs, logCallback);
  } else if (portal === 'naukri') {
    return scrapeNaukriJobs(keywords, location, experience, maxJobs, logCallback);
  } else if (portal === 'ziprecruiter') {
    return scrapeZipRecruiterJobs(keywords, location, experience, maxJobs, logCallback);
  } else if (portal === 'ycombinator') {
    return scrapeYCombinatorJobs(keywords, location, experience, maxJobs, logCallback);
  } else if (portal === 'cutshort') {
    return scrapeCutshortJobs(keywords, location, experience, maxJobs, logCallback);
  } else {
    throw new Error(`Unsupported scraper portal: ${portal}`);
  }
}

const getAuthPath = (portal) => {
  if (portal === 'linkedin') {
    const oldPath = path.join(__dirname, 'auth.json');
    if (fs.existsSync(oldPath)) {
      return oldPath;
    }
    return path.join(__dirname, 'auth_linkedin.json');
  }
  return path.join(__dirname, `auth_${portal}.json`);
};

async function runPortalLogin(portal, logCallback) {
  const portalNames = {
    linkedin: 'LinkedIn',
    naukri: 'Naukri',
    ziprecruiter: 'ZipRecruiter',
    ycombinator: 'YCombinator',
    cutshort: 'Cutshort'
  };
  const portalUrls = {
    linkedin: 'https://www.linkedin.com/login',
    naukri: 'https://www.naukri.com/nlogin/login',
    ziprecruiter: 'https://www.ziprecruiter.com/candidate/login',
    ycombinator: 'https://www.workatastartup.com/users/sign_in',
    cutshort: 'https://cutshort.io/login'
  };

  const name = portalNames[portal] || portal;
  const url = portalUrls[portal];

  if (!url) {
    throw new Error(`Unsupported portal: ${portal}`);
  }

  logMsg(logCallback, `Launching headed browser for ${name} login...`);
  const browser = await chromium.launch({
    headless: false
  });
  
  const context = await browser.newContext();
  const page = await context.newPage();
  
  logMsg(logCallback, `Navigating to ${name} login page...`);
  await page.goto(url);
  
  logMsg(logCallback, `Waiting for you to log in manually in the browser window...`);
  
  try {
    if (portal === 'linkedin') {
      await Promise.race([
        page.waitForURL('**/feed/**', { timeout: 120000 }),
        page.waitForSelector('.global-nav', { timeout: 120000 })
      ]);
    } else if (portal === 'naukri') {
      await Promise.race([
        page.waitForURL('**/homepage**', { timeout: 120000 }),
        page.waitForSelector('.nI-gD-profile-icon-wrap, .nProfile, a[href*="logout"]', { timeout: 120000 })
      ]);
    } else if (portal === 'ziprecruiter') {
      await Promise.race([
        page.waitForURL('**/candidate/**', { timeout: 120000 }),
        page.waitForSelector('.profile-icon, .nav-profile, a[href*="logout"]', { timeout: 120000 })
      ]);
    } else if (portal === 'ycombinator') {
      await Promise.race([
        page.waitForURL('**/candidate/**', { timeout: 120000 }),
        page.waitForURL('**/jobs/**', { timeout: 120000 }),
        page.waitForSelector('.profile-nav, .user-avatar, a[href*="logout"], a[href*="sign_out"]', { timeout: 120000 })
      ]);
    } else if (portal === 'cutshort') {
      await Promise.race([
        page.waitForURL('**/dashboard/**', { timeout: 120000 }),
        page.waitForSelector('.user-profile-menu, .profile-image, a[href*="logout"]', { timeout: 120000 })
      ]);
    }
    
    logMsg(logCallback, `Successfully detected logged-in state for ${name}!`);
    const pPath = getAuthPath(portal);
    logMsg(logCallback, `Saving authentication state to auth_${portal}.json...`);
    
    await context.storageState({ path: pPath });
    logMsg(logCallback, `auth_${portal}.json saved successfully!`);
    
    await browser.close();
    return { success: true };
  } catch (error) {
    logMsg(logCallback, `Login failed or timed out: ${error.message}`);
    await browser.close();
    return { success: false, error: error.message };
  }
}

async function scrapeNaukriJobs(keywords, location, experience, maxJobs = 15, logCallback) {
  logMsg(logCallback, `Starting Naukri Job Search...`);
  logMsg(logCallback, `Keywords: ${JSON.stringify(keywords)}, Location: ${location}`);

  const aPath = getAuthPath('naukri');
  const hasAuth = fs.existsSync(aPath);
  if (!hasAuth) {
    logMsg(logCallback, `WARNING: auth_naukri.json not found. Running scraping in unauthenticated/public mode.`);
  } else {
    logMsg(logCallback, `Loaded existing login session from auth_naukri.json.`);
  }

  const browser = await chromium.launch({ headless: true });
  const context = hasAuth 
    ? await browser.newContext({ storageState: aPath, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' })
    : await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });

  const page = await context.newPage();
  const cleanLoc = location ? location.toLowerCase().replace(/\s+/g, '-') : 'india';
  const cleanKW = keywords ? keywords.toLowerCase().replace(/\s+/g, '-') : 'jobs';
  let searchUrl = `https://www.naukri.com/${cleanKW}-jobs-in-${cleanLoc}?k=${encodeURIComponent(keywords)}&l=${encodeURIComponent(location)}`;

  logMsg(logCallback, `Navigating to search page: ${searchUrl}`);
  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (err) {
    logMsg(logCallback, `Error loading search page: ${err.message}. Retrying...`);
    await page.goto(searchUrl, { waitUntil: 'load', timeout: 60000 });
  }

  logMsg(logCallback, 'Waiting for job list container to load...');
  try {
    await page.waitForSelector('.list, .srp-job-tuple, .jobTuple', { timeout: 15000 });
  } catch {
    logMsg(logCallback, 'Naukri list selectors not found. Triggering fallback simulator...');
    await browser.close();
    return simulatePortalJobs('naukri', keywords, location, experience, maxJobs, logCallback);
  }

  const cardSelectors = ['.srp-job-tuple', '.jobTuple', '.job-tuple', '[data-job-id]'];
  let jobCards = [];
  for (const s of cardSelectors) {
    const cards = await page.locator(s).all();
    if (cards.length > 0) {
      jobCards = cards;
      logMsg(logCallback, `Found ${cards.length} Naukri job cards using selector "${s}"`);
      break;
    }
  }

  const jobsList = [];
  const processedIds = new Set();

  for (const card of jobCards) {
    if (jobsList.length >= maxJobs) break;
    try {
      let title = '';
      const titleEl = card.locator('a.title, .title');
      if (await titleEl.count() > 0) title = (await titleEl.first().innerText()).trim();

      let link = '';
      if (await titleEl.count() > 0) link = await titleEl.first().getAttribute('href');

      if (!title || !link) continue;

      let jobId = '';
      const idMatch = link.match(/-(\d+)(?:\?|$)/) || link.match(/job-listings-.*-(\d+)/);
      if (idMatch) jobId = 'naukri_' + idMatch[1];
      else jobId = 'naukri_' + Buffer.from(link).toString('base64').substring(0, 16);

      if (processedIds.has(jobId)) continue;
      processedIds.add(jobId);

      let company = 'Naukri Recruiter';
      const compEl = card.locator('.comp-name-link, .compName, .company');
      if (await compEl.count() > 0) company = (await compEl.first().innerText()).trim();

      let jobLocation = location;
      const locEl = card.locator('.locWdth, .location, .loc');
      if (await locEl.count() > 0) jobLocation = (await locEl.first().innerText()).trim();

      let postedDate = 'Recently';
      const dateEl = card.locator('.posted, .date, .job-post-day');
      if (await dateEl.count() > 0) postedDate = (await dateEl.first().innerText()).trim();

      let descSnippet = '';
      const descEl = card.locator('.job-description, .desc');
      if (await descEl.count() > 0) descSnippet = (await descEl.first().innerText()).trim();

      let jobExperience = experience || 'Not Specified';
      const expEl = card.locator('.expWdth, .exp, .experience');
      if (await expEl.count() > 0) jobExperience = (await expEl.first().innerText()).trim();

      jobsList.push({
        id: jobId,
        title,
        company,
        location: jobLocation,
        link,
        posted_date: postedDate,
        description: descSnippet || 'Details available on portal.',
        experience: jobExperience,
        portal: 'naukri'
      });
    } catch (cardErr) {
      // skip card
    }
  }

  let newJobsSaved = 0;
  for (const job of jobsList) {
    const database = await db.getDb();
    const existingJob = await database.get('SELECT id FROM jobs WHERE id = ?', [job.id]);
    if (existingJob) continue;

    await db.saveJob(job);
    newJobsSaved++;
  }

  logMsg(logCallback, `Completed Naukri search. Saved ${newJobsSaved} new jobs to the database.`);
  await browser.close();
  return { success: true, count: jobsList.length, saved: newJobsSaved };
}

async function scrapeZipRecruiterJobs(keywords, location, experience, maxJobs = 15, logCallback) {
  logMsg(logCallback, `Starting ZipRecruiter Job Search...`);
  logMsg(logCallback, `Keywords: ${JSON.stringify(keywords)}, Location: ${location}`);

  const aPath = getAuthPath('ziprecruiter');
  const hasAuth = fs.existsSync(aPath);
  
  const browser = await chromium.launch({ headless: true });
  const context = hasAuth 
    ? await browser.newContext({ storageState: aPath, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' })
    : await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });

  const page = await context.newPage();
  const searchUrl = `https://www.ziprecruiter.com/jobs-search?search=${encodeURIComponent(keywords)}&location=${encodeURIComponent(location || 'United States')}`;

  logMsg(logCallback, `Navigating to ZipRecruiter: ${searchUrl}`);
  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('.job_result, .job-result-item, .job_content', { timeout: 10000 });
  } catch {
    logMsg(logCallback, 'ZipRecruiter list elements not loaded. Triggering fallback simulator...');
    await browser.close();
    return simulatePortalJobs('ziprecruiter', keywords, location, experience, maxJobs, logCallback);
  }

  const jobCards = await page.locator('.job_result, .job-result-item, .job_content').all();
  logMsg(logCallback, `Found ${jobCards.length} ZipRecruiter cards.`);

  const jobsList = [];
  const processedIds = new Set();

  for (const card of jobCards) {
    if (jobsList.length >= maxJobs) break;
    try {
      let title = '';
      const titleEl = card.locator('.job_title, h2.title, a.job_title');
      if (await titleEl.count() > 0) title = (await titleEl.first().innerText()).trim();

      let link = '';
      const linkEl = card.locator('a.job_link, .job_title a, a');
      if (await linkEl.count() > 0) link = await linkEl.first().getAttribute('href');

      if (!title || !link) continue;

      let jobId = 'zip_' + Buffer.from(link).toString('base64').substring(0, 16);
      if (processedIds.has(jobId)) continue;
      processedIds.add(jobId);

      let company = 'ZipRecruiter Recruiter';
      const compEl = card.locator('.company_name, .company');
      if (await compEl.count() > 0) company = (await compEl.first().innerText()).trim();

      let jobLocation = location || 'United States';
      const locEl = card.locator('.job_location, .location');
      if (await locEl.count() > 0) jobLocation = (await locEl.first().innerText()).trim();

      let postedDate = 'Recently';
      const dateEl = card.locator('.date, .posted');
      if (await dateEl.count() > 0) postedDate = (await dateEl.first().innerText()).trim();

      let snippet = '';
      const snipEl = card.locator('.job_snippet, .snippet, p');
      if (await snipEl.count() > 0) snippet = (await snipEl.first().innerText()).trim();

      jobsList.push({
        id: jobId,
        title,
        company,
        location: jobLocation,
        link,
        posted_date: postedDate,
        description: snippet || 'Details available on ZipRecruiter portal.',
        experience: experience || 'Not Specified',
        portal: 'ziprecruiter'
      });
    } catch (e) {}
  }

  let savedCount = 0;
  for (const job of jobsList) {
    const database = await db.getDb();
    const existing = await database.get('SELECT id FROM jobs WHERE id = ?', [job.id]);
    if (!existing) {
      await db.saveJob(job);
      savedCount++;
    }
  }

  logMsg(logCallback, `ZipRecruiter scraper finished. Saved ${savedCount} new jobs.`);
  await browser.close();
  return { success: true, count: jobsList.length, saved: savedCount };
}

async function scrapeYCombinatorJobs(keywords, location, experience, maxJobs = 15, logCallback) {
  logMsg(logCallback, `Starting YCombinator Job Search...`);
  logMsg(logCallback, `Keywords: ${JSON.stringify(keywords)}`);

  const aPath = getAuthPath('ycombinator');
  const hasAuth = fs.existsSync(aPath);
  
  const browser = await chromium.launch({ headless: true });
  const context = hasAuth 
    ? await browser.newContext({ storageState: aPath })
    : await browser.newContext();

  const page = await context.newPage();
  const searchUrl = `https://www.workatastartup.com/jobs?query=${encodeURIComponent(keywords)}`;

  logMsg(logCallback, `Navigating to YCombinator Work at a Startup: ${searchUrl}`);
  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('.job-card, .job-row, div.mb-4.border-b, .job-post', { timeout: 10000 });
  } catch {
    logMsg(logCallback, 'YCombinator jobs page did not return records. Triggering fallback simulator...');
    await browser.close();
    return simulatePortalJobs('ycombinator', keywords, location, experience, maxJobs, logCallback);
  }

  const jobCards = await page.locator('.job-card, .job-row, div.mb-4.border-b, .job-post').all();
  logMsg(logCallback, `Found ${jobCards.length} YC Job cards.`);

  const jobsList = [];
  const processedIds = new Set();

  for (const card of jobCards) {
    if (jobsList.length >= maxJobs) break;
    try {
      let title = '';
      const titleEl = card.locator('a.job-name, .job-title, h4');
      if (await titleEl.count() > 0) title = (await titleEl.first().innerText()).trim();

      let link = '';
      const linkEl = card.locator('a[href*="/jobs/"], a');
      if (await linkEl.count() > 0) {
        const relative = await linkEl.first().getAttribute('href');
        link = relative.startsWith('/') ? `https://www.workatastartup.com${relative}` : relative;
      }

      if (!title || !link) continue;

      let jobId = 'yc_' + Buffer.from(link).toString('base64').substring(0, 16);
      if (processedIds.has(jobId)) continue;
      processedIds.add(jobId);

      let company = 'YC Startup';
      const compEl = card.locator('a.company-name, .company-name, h3');
      if (await compEl.count() > 0) company = (await compEl.first().innerText()).trim();

      let jobLocation = location || 'Remote / USA';
      const locEl = card.locator('.location, .job-location');
      if (await locEl.count() > 0) jobLocation = (await locEl.first().innerText()).trim();

      let postedDate = 'Recently';
      const dateEl = card.locator('.posted-date, span.text-muted');
      if (await dateEl.count() > 0) postedDate = (await dateEl.first().innerText()).trim();

      let snippet = 'Exciting role at a YC startup.';
      const descEl = card.locator('.job-description, p');
      if (await descEl.count() > 0) snippet = (await descEl.first().innerText()).trim();

      jobsList.push({
        id: jobId,
        title,
        company,
        location: jobLocation,
        link,
        posted_date: postedDate,
        description: snippet,
        experience: experience || 'Not Specified',
        portal: 'ycombinator'
      });
    } catch (e) {}
  }

  let savedCount = 0;
  for (const job of jobsList) {
    const database = await db.getDb();
    const existing = await database.get('SELECT id FROM jobs WHERE id = ?', [job.id]);
    if (!existing) {
      await db.saveJob(job);
      savedCount++;
    }
  }

  logMsg(logCallback, `YCombinator scraper finished. Saved ${savedCount} new jobs.`);
  await browser.close();
  return { success: true, count: jobsList.length, saved: savedCount };
}

async function scrapeCutshortJobs(keywords, location, experience, maxJobs = 15, logCallback) {
  logMsg(logCallback, `Starting Cutshort Job Search...`);
  logMsg(logCallback, `Keywords: ${JSON.stringify(keywords)}`);

  const aPath = getAuthPath('cutshort');
  const hasAuth = fs.existsSync(aPath);
  
  const browser = await chromium.launch({ headless: true });
  const context = hasAuth 
    ? await browser.newContext({ storageState: aPath })
    : await browser.newContext();

  const page = await context.newPage();
  const searchUrl = `https://cutshort.io/jobs?search=${encodeURIComponent(keywords)}`;

  logMsg(logCallback, `Navigating to Cutshort: ${searchUrl}`);
  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('.job-card, .job-list-card, div[class*="JobCard"]', { timeout: 10000 });
  } catch {
    logMsg(logCallback, 'Cutshort jobs page did not return records. Triggering fallback simulator...');
    await browser.close();
    return simulatePortalJobs('cutshort', keywords, location, experience, maxJobs, logCallback);
  }

  const jobCards = await page.locator('.job-card, .job-list-card, div[class*="JobCard"]').all();
  logMsg(logCallback, `Found ${jobCards.length} Cutshort Job cards.`);

  const jobsList = [];
  const processedIds = new Set();

  for (const card of jobCards) {
    if (jobsList.length >= maxJobs) break;
    try {
      let title = '';
      const titleEl = card.locator('h3, .job-title');
      if (await titleEl.count() > 0) title = (await titleEl.first().innerText()).trim();

      let link = '';
      const linkEl = card.locator('a[href*="/job/"], a');
      if (await linkEl.count() > 0) {
        const relative = await linkEl.first().getAttribute('href');
        link = relative.startsWith('/') ? `https://cutshort.io${relative}` : relative;
      }

      if (!title || !link) continue;

      let jobId = 'cutshort_' + Buffer.from(link).toString('base64').substring(0, 16);
      if (processedIds.has(jobId)) continue;
      processedIds.add(jobId);

      let company = 'Cutshort Partner';
      const compEl = card.locator('.company-name, .company, h4');
      if (await compEl.count() > 0) company = (await compEl.first().innerText()).trim();

      let jobLocation = location || 'India';
      const locEl = card.locator('.location, .job-location');
      if (await locEl.count() > 0) jobLocation = (await locEl.first().innerText()).trim();

      let postedDate = 'Recently';
      const dateEl = card.locator('.posted-date, span.text-muted');
      if (await dateEl.count() > 0) postedDate = (await dateEl.first().innerText()).trim();

      let snippet = 'Details on Cutshort portal.';
      const descEl = card.locator('.job-description, p');
      if (await descEl.count() > 0) snippet = (await descEl.first().innerText()).trim();

      jobsList.push({
        id: jobId,
        title,
        company,
        location: jobLocation,
        link,
        posted_date: postedDate,
        description: snippet,
        experience: experience || 'Not Specified',
        portal: 'cutshort'
      });
    } catch (e) {}
  }

  let savedCount = 0;
  for (const job of jobsList) {
    const database = await db.getDb();
    const existing = await database.get('SELECT id FROM jobs WHERE id = ?', [job.id]);
    if (!existing) {
      await db.saveJob(job);
      savedCount++;
    }
  }

  logMsg(logCallback, `Cutshort scraper finished. Saved ${savedCount} new jobs.`);
  await browser.close();
  return { success: true, count: jobsList.length, saved: savedCount };
}

async function simulatePortalJobs(portal, keywords, location, experience, maxJobs, logCallback) {
  logMsg(logCallback, `Simulation Mode: Generating demo job postings for ${portal}...`);
  const jobsList = [];
  const database = await db.getDb();
  
  const techNames = keywords ? keywords.split(',') : ['React Developer'];
  const primaryTech = techNames[0].trim();
  
  const portalTitles = {
    naukri: [
      `${primaryTech} Developer`,
      `Senior ${primaryTech} Engineer`,
      `Lead ${primaryTech} Architect`,
      `Full Stack Engineer (${primaryTech}/Node)`
    ],
    ziprecruiter: [
      `Software Engineer - ${primaryTech}`,
      `${primaryTech} Specialist`,
      `Junior Developer (${primaryTech})`,
      `Principal Front-End Developer`
    ],
    ycombinator: [
      `Early Stage Full-Stack Engineer (${primaryTech})`,
      `Founding Engineer - ${primaryTech} & Next.js`,
      `Senior UI Engineer`,
      `Front-End Engineer (YC W26)`
    ],
    cutshort: [
      `${primaryTech} UI Developer`,
      `Product Engineer - Frontend`,
      `Senior frontend developer (Remote)`,
      `SDE 2 - Frontend`
    ]
  };

  const portalCompanies = {
    naukri: ['TCS', 'Infosys', 'Capgemini', 'Wipro', 'Cognizant'],
    ziprecruiter: ['TechCorp Solutions', 'Staffing Inc.', 'Apex Systems', 'CyberCoders'],
    ycombinator: ['Linear (YC W12)', 'Retool (YC S17)', 'Brex (YC W17)', 'Razorpay (YC W15)'],
    cutshort: ['Simpl', 'Razorpay', 'Jio', 'Unacademy', 'Groww']
  };

  const titles = portalTitles[portal] || [`${primaryTech} Engineer`];
  const companies = portalCompanies[portal] || ['InnovateTech'];

  for (let i = 0; i < maxJobs; i++) {
    const jobId = `${portal}_sim_${Date.now()}_${i}`;
    const title = titles[i % titles.length];
    const company = companies[i % companies.length];
    const jobLoc = location || 'Remote';
    const cleanLink = portal === 'ycombinator' 
      ? `https://www.workatastartup.com/jobs/${1000 + i}`
      : portal === 'cutshort'
      ? `https://cutshort.io/job/simulated-job-${1000 + i}`
      : `https://www.${portal}.com/job/details-${1000 + i}`;
      
    const expReq = experience || `${(i % 3) + 1}-${(i % 3) + 4} years`;
    const daysAgo = i * 2 + 1;
    const posted_date = daysAgo === 1 ? '1 day ago' : `${daysAgo} days ago`;

    const description = `We are looking for a skilled ${title} to join our team. 
    
Key Requirements:
- Hands-on experience with ${primaryTech} and modern web stacks.
- Solid understanding of state management, responsive designs, and clean coding standards.
- Experience with testing frameworks and build tools.
- Excellent communication and collaboration skills.

This is a simulated ${portal} job listing for demonstration and UI rendering.`;

    const job = {
      id: jobId,
      title,
      company,
      location: jobLoc,
      link: cleanLink,
      description,
      posted_date,
      experience: expReq,
      portal
    };

    const existingJob = await database.get('SELECT id FROM jobs WHERE id = ?', [job.id]);
    if (!existingJob) {
      await db.saveJob(job);
      jobsList.push(job);
    }
  }

  logMsg(logCallback, `Simulation completed. Generated and saved ${jobsList.length} jobs.`);
  return { success: true, count: jobsList.length, saved: jobsList.length };
}

module.exports = {
  runLinkedInLogin,
  runPortalLogin,
  scrapeLinkedInJobs,
  scrapeNaukriJobs,
  scrapeZipRecruiterJobs,
  scrapeYCombinatorJobs,
  scrapeCutshortJobs,
  scrapeJobs,
  getAuthPath,
  authPath
};

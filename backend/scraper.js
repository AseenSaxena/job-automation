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

      if (!title || !company) continue;

      const cleanLink = `https://www.linkedin.com/jobs/view/${jobId}/`;

      jobsList.push({
        id: jobId,
        title,
        company,
        location: jobLocation || location,
        link: cleanLink,
        posted_date: new Date().toLocaleDateString()
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

module.exports = {
  runLinkedInLogin,
  scrapeLinkedInJobs,
  authPath
};

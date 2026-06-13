const db = require('./db');

// Predefined catalog of core technical skills for keyword matching
const COMMON_SKILLS = [
  'react', 'angular', 'vue', 'next.js', 'nextjs', 'nuxt', 'svelte', 'solidjs',
  'javascript', 'typescript', 'js', 'ts', 'html', 'css', 'sass', 'less', 'tailwind', 'bootstrap',
  'node.js', 'nodejs', 'node', 'express', 'nest.js', 'nestjs', 'graphql', 'rest api', 'restful api',
  'redux', 'mobx', 'zustand', 'context api', 'webpack', 'vite', 'git', 'github', 'docker', 'kubernetes',
  'aws', 'azure', 'gcp', 'sql', 'mysql', 'postgresql', 'sqlite', 'mongodb', 'redis', 'firebase', 'prisma',
  'jest', 'mocha', 'cypress', 'playwright', 'testing library', 'ci/cd', 'devops', 'websockets', 'agile'
];

async function analyzeJob(jobId) {
  const settings = await db.getSettings();
  const resume = settings.resume || '';

  if (!resume || resume.trim().length === 0) {
    throw new Error('Resume text is missing. Please upload a resume PDF or write text in settings first.');
  }

  // Get job details from DB
  const database = await db.getDb();
  const job = await database.get('SELECT * FROM jobs WHERE id = ?', [jobId]);
  
  if (!job) {
    throw new Error('Job not found.');
  }

  const jobDescLower = job.description.toLowerCase();
  const resumeLower = resume.toLowerCase();

  // Find overlapping skills
  const jobSkills = [];
  const resumeSkills = [];

  COMMON_SKILLS.forEach(skill => {
    // Escape special characters for regex matching
    const escapedSkill = skill.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const skillRegex = new RegExp(`\\b${escapedSkill}\\b`, 'i');
    
    // Check if skill is in job description
    if (skillRegex.test(jobDescLower)) {
      jobSkills.push(skill);
      // Check if skill is also in resume
      if (skillRegex.test(resumeLower)) {
        resumeSkills.push(skill);
      }
    }
  });

  // Calculate Match Score (ATS-Style keyword overlap)
  let matchScore = 70; // default base score
  const missingSkills = [];

  if (jobSkills.length > 0) {
    const matchedCount = resumeSkills.length;
    matchScore = Math.round((matchedCount / jobSkills.length) * 100);
    
    // Determine missing skills
    jobSkills.forEach(skill => {
      if (!resumeSkills.includes(skill)) {
        // Capitalize for display
        const displaySkill = skill.split('.').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('.');
        missingSkills.push(displaySkill);
      }
    });
  } else {
    // Fallback: check general keyword match
    const words = jobDescLower.split(/\W+/).filter(w => w.length > 4);
    const uniqueWords = [...new Set(words)];
    let matchCount = 0;
    uniqueWords.forEach(w => {
      if (resumeLower.includes(w)) matchCount++;
    });
    matchScore = uniqueWords.length > 0 ? Math.round((matchCount / uniqueWords.length) * 100) : 75;
  }

  // Clamp score between 0 and 100
  matchScore = Math.min(100, Math.max(10, matchScore));

  // Generate suggestions based on missing keywords
  const resumeSuggestions = [];
  if (missingSkills.length > 0) {
    missingSkills.slice(0, 3).forEach(skill => {
      resumeSuggestions.push(`Add a project or bullet point highlighting your experience with "${skill}".`);
    });
    resumeSuggestions.push(`Mention key terms like ${missingSkills.slice(0, 4).join(', ')} directly in your skills section.`);
  } else {
    resumeSuggestions.push("Your resume matches the core technical stack perfectly!");
  }
  resumeSuggestions.push("Quantify your accomplishments (e.g., 'improved page speeds by 30%', 'reduced loading times') rather than just listing tasks.");

  // Extract Name from Resume (assumes first line might contain the candidate's name)
  const resumeLines = resume.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  let candidateName = '[Your Name]';
  if (resumeLines.length > 0) {
    const firstLine = resumeLines[0];
    if (firstLine.split(/\s+/).length <= 4 && !firstLine.includes('@') && !firstLine.includes('http')) {
      candidateName = firstLine;
    }
  }

  // Format skills for cover letter
  const skillsListText = resumeSkills.length > 0 
    ? resumeSkills.slice(0, 5).map(s => s.split('.').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('.')).join(', ')
    : 'modern web development standards';

  // Generate Template Cover Letter
  const coverLetter = `Dear Hiring Team at ${job.company},

I am writing to express my enthusiastic interest in the ${job.title} position at your company. Based on my technical background and experience in designing user-focused software applications, I am confident in my ability to hit the ground running and add immediate value.

The technical requirements outlined in your job posting match my experience well. In my previous work, I have designed, developed, and maintained applications using ${skillsListText}. I focus on writing clean, modular, and performance-optimized code while collaborating in agile team environments to deliver high-quality outcomes.

Specifically, I bring:
- Strong experience building interactive front-end layouts and robust logic flows.
- Proven capability in API integration, state management, and debugging complex software components.
- A user-centric design approach focused on maximizing page responsiveness and usability.

I am particularly excited about the chance to join ${job.company} because of your team's commitment to building premium digital experiences. I welcome the opportunity to discuss my qualifications and how my skill set can support your team's goals.

Thank you for your time and consideration.

Sincerely,

${candidateName}
(as matching your profile)`;

  const analysis = {
    matchScore,
    missingSkills,
    resumeSuggestions,
    coverLetter
  };

  // Save analysis to DB
  await db.updateJobAnalysis(jobId, analysis);

  return analysis;
}

module.exports = {
  analyzeJob
};

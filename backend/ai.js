const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./db');

async function analyzeJob(jobId) {
  const settings = await db.getSettings();
  const apiKey = settings.gemini_key;
  const resume = settings.resume;

  if (!apiKey) {
    throw new Error('Gemini API key is missing. Please add it in settings.');
  }
  if (!resume) {
    throw new Error('Resume text is missing. Please add it in settings.');
  }

  // Get job details from DB
  const database = await db.getDb();
  const job = await database.get('SELECT * FROM jobs WHERE id = ?', [jobId]);
  
  if (!job) {
    throw new Error('Job not found.');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  // Using gemini-1.5-flash as it is fast, cheap, and very capable of resume scoring
  const model = genAI.getGenerativeModel({ 
    model: 'gemini-1.5-flash',
    generationConfig: {
      responseMimeType: "application/json"
    }
  });

  const prompt = `
You are an expert technical recruiter and resume writer. 
Compare the user's resume with the job description below.
Determine the fit, identify missing skills, suggest improvements, and draft a high-impact, custom cover letter.

Resume:
"""
${resume}
"""

Job Description (Title: "${job.title}" at "${job.company}"):
"""
${job.description}
"""

You must respond with a JSON object containing exactly the following structure:
{
  "matchScore": 85, // An integer between 0 and 100
  "missingSkills": ["Tailwind CSS", "GraphQL"], // Array of technologies/skills mentioned in job desc but missing/weak in resume
  "resumeSuggestions": ["Add experience with Next.js App router under your recent project", "Highlight React performance optimization techniques"], // Concrete suggestions for editing resume to fit this role
  "coverLetter": "Dear Hiring Manager... (A compelling, professional 200-300 word cover letter showcasing relevant achievements from the resume matching the job requirements)"
}
`;

  const result = await model.generateContent(prompt);
  const responseText = result.response.text();
  
  let analysis;
  try {
    analysis = JSON.parse(responseText);
  } catch (err) {
    console.error("Failed to parse Gemini response as JSON. Raw response:", responseText);
    throw new Error("Invalid response from Gemini AI: " + err.message);
  }

  // Ensure fields are correctly typed/present
  analysis.matchScore = Math.min(100, Math.max(0, parseInt(analysis.matchScore) || 0));
  analysis.missingSkills = Array.isArray(analysis.missingSkills) ? analysis.missingSkills : [];
  analysis.resumeSuggestions = Array.isArray(analysis.resumeSuggestions) ? analysis.resumeSuggestions : [];
  analysis.coverLetter = typeof analysis.coverLetter === 'string' ? analysis.coverLetter : '';

  // Save analysis to DB
  await db.updateJobAnalysis(jobId, analysis);

  return analysis;
}

module.exports = {
  analyzeJob
};

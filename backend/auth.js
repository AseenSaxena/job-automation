const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'jobbot_secret_key_change_in_production';
const JWT_EXPIRES = '7d';

// Register a new user
async function register(name, email, password) {
  const db = await getDb();

  // Check if email already taken
  const existing = await db.get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
  if (existing) {
    throw new Error('An account with this email already exists.');
  }

  const password_hash = await bcrypt.hash(password, 12);
  const result = await db.run(
    'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
    [name.trim(), email.toLowerCase().trim(), password_hash]
  );

  const user = await db.get('SELECT id, name, email, created_at FROM users WHERE id = ?', [result.lastID]);
  const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES });

  return { user, token };
}

// Login an existing user
async function login(email, password) {
  const db = await getDb();

  const user = await db.get('SELECT * FROM users WHERE email = ?', [email.toLowerCase().trim()]);
  if (!user) {
    throw new Error('No account found with that email address.');
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    throw new Error('Incorrect password.');
  }

  const { password_hash, ...safeUser } = user;
  const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES });

  return { user: safeUser, token };
}

// Middleware to protect routes
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer <token>

  if (!token) {
    return res.status(401).json({ error: 'Authentication required. Please log in.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.userEmail = decoded.email;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
  }
}

// Get user profile by id
async function getUser(userId) {
  const db = await getDb();
  return db.get('SELECT id, name, email, created_at FROM users WHERE id = ?', [userId]);
}

module.exports = { register, login, requireAuth, getUser };

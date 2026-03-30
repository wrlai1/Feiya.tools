/**
 * Local development server — mirrors the Vercel API functions.
 * Run with: node server.cjs
 * Vite proxies /api/* to this server on port 3001.
 */
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { neon }  = require('@neondatabase/serverless');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');

const app  = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDB() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set in .env');
  return neon(url);
}

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET not set in .env');
  return s;
}

function verifyToken(authHeader, secret) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  try { return jwt.verify(authHeader.slice(7), secret); } catch { return null; }
}

function requireAdmin(authHeader, secret) {
  const p = verifyToken(authHeader, secret);
  return p?.role === 'admin' ? p : null;
}

async function ensureUsersTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'user',
      created_by    TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

async function seedAdminIfNeeded(sql) {
  const rows = await sql`SELECT COUNT(*)::int AS count FROM users`;
  if (rows[0].count === 0) {
    const hash = await bcrypt.hash('feiya2026', 10);
    await sql`
      INSERT INTO users (username, password_hash, role, created_by)
      VALUES ('admin', ${hash}, 'admin', 'system')
      ON CONFLICT (username) DO NOTHING
    `;
    console.log('  ✓ Seeded default admin user (admin / feiya2026)');
  }
}

// ─── POST /api/auth ───────────────────────────────────────────────────────────

app.post('/api/auth', async (req, res) => {
  const action = req.query.action;
  try {
    const sql    = getDB();
    const secret = getSecret();
    await ensureUsersTable(sql);
    await seedAdminIfNeeded(sql);

    if (action === 'login') {
      const { username, password } = req.body || {};
      if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
      const rows = await sql`SELECT * FROM users WHERE username = ${username.trim()}`;
      const user = rows[0];
      if (!user) return res.status(401).json({ error: 'Invalid username or password' });
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Invalid username or password' });
      const token = jwt.sign({ userId: user.id, username: user.username, role: user.role }, secret, { expiresIn: '7d' });
      return res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
    }

    if (action === 'verify') {
      const payload = verifyToken(req.headers.authorization, secret);
      if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
      const rows = await sql`SELECT id, username, role FROM users WHERE id = ${payload.userId}`;
      if (!rows[0]) return res.status(401).json({ error: 'User not found' });
      return res.json({ user: rows[0] });
    }

    if (action === 'change-password') {
      const payload = verifyToken(req.headers.authorization, secret);
      if (!payload) return res.status(401).json({ error: 'Not authenticated' });
      const { currentPassword, newPassword } = req.body || {};
      if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
      if (newPassword.length < 6) return res.status(400).json({ error: 'Min 6 characters' });
      const rows = await sql`SELECT * FROM users WHERE id = ${payload.userId}`;
      if (!rows[0]) return res.status(404).json({ error: 'User not found' });
      const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
      if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
      const hash = await bcrypt.hash(newPassword, 10);
      await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${payload.userId}`;
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[/api/auth]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── /api/users ───────────────────────────────────────────────────────────────

app.get('/api/users', async (req, res) => {
  try {
    const sql    = getDB();
    const secret = getSecret();
    const admin  = requireAdmin(req.headers.authorization, secret);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });
    const rows = await sql`SELECT id, username, role, created_by, created_at FROM users ORDER BY created_at ASC`;
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', async (req, res) => {
  try {
    const sql    = getDB();
    const secret = getSecret();
    const admin  = requireAdmin(req.headers.authorization, secret);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });
    const { username, password, role = 'user' } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (password.length < 6) return res.status(400).json({ error: 'Min 6 characters' });
    const hash = await bcrypt.hash(password, 10);
    const rows = await sql`
      INSERT INTO users (username, password_hash, role, created_by)
      VALUES (${username.trim().toLowerCase()}, ${hash}, ${role}, ${admin.username})
      RETURNING id, username, role, created_by, created_at
    `;
    return res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    return res.status(500).json({ error: err.message });
  }
});

app.patch('/api/users', async (req, res) => {
  try {
    const sql    = getDB();
    const secret = getSecret();
    const admin  = requireAdmin(req.headers.authorization, secret);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });
    const userId = parseInt(req.query.id, 10);
    if (!userId) return res.status(400).json({ error: 'User id required' });
    const { password, role } = req.body || {};
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${userId}`;
    }
    if (role) await sql`UPDATE users SET role = ${role} WHERE id = ${userId}`;
    const rows = await sql`SELECT id, username, role, created_by, created_at FROM users WHERE id = ${userId}`;
    return res.json(rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users', async (req, res) => {
  try {
    const sql    = getDB();
    const secret = getSecret();
    const admin  = requireAdmin(req.headers.authorization, secret);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });
    const userId = parseInt(req.query.id, 10);
    if (!userId) return res.status(400).json({ error: 'User id required' });
    if (userId === admin.userId) return res.status(400).json({ error: 'Cannot delete yourself' });
    await sql`DELETE FROM users WHERE id = ${userId}`;
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── /api/app-data ────────────────────────────────────────────────────────────

async function ensureAppDataTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS app_data (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

app.get('/api/app-data', async (req, res) => {
  try {
    const sql  = getDB();
    const type = req.query.type;
    if (!['inventory', 'tracking'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
    await ensureAppDataTable(sql);
    const rows = await sql`SELECT value, updated_at FROM app_data WHERE key = ${type}`;
    if (!rows[0]) return res.json({ rows: [], updatedAt: null, fileName: null });
    const stored = rows[0].value;
    return res.json(Array.isArray(stored) ? { rows: stored, updatedAt: rows[0].updated_at, fileName: null } : stored);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post('/api/app-data', async (req, res) => {
  try {
    const sql = getDB();
    const { type, data, fileName, updatedAt } = req.body || {};
    if (!['inventory', 'tracking'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
    await ensureAppDataTable(sql);
    const wrapper = JSON.stringify({ rows: data, fileName: fileName || null, updatedAt: updatedAt || new Date().toISOString() });
    await sql`
      INSERT INTO app_data (key, value, updated_at) VALUES (${type}, ${wrapper}::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
    return res.json({ ok: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.delete('/api/app-data', async (req, res) => {
  try {
    const sql  = getDB();
    const type = req.query.type;
    await ensureAppDataTable(sql);
    await sql`DELETE FROM app_data WHERE key = ${type}`;
    return res.json({ ok: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ─── /api/chat-messages ───────────────────────────────────────────────────────

async function ensureChatTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      text       TEXT NOT NULL,
      edited     BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited BOOLEAN DEFAULT FALSE`;
  await sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`;
}

app.get('/api/chat-messages', async (req, res) => {
  try {
    const sql = getDB();
    await ensureChatTable(sql);
    const rows = await sql`SELECT id, name, text, edited, created_at, updated_at FROM chat_messages ORDER BY created_at ASC`;
    return res.json(rows);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post('/api/chat-messages', async (req, res) => {
  try {
    const sql = getDB();
    const { name, text } = req.body || {};
    if (!name || !text) return res.status(400).json({ error: 'name and text required' });
    await ensureChatTable(sql);
    const rows = await sql`INSERT INTO chat_messages (name, text) VALUES (${name}, ${text}) RETURNING id, name, text, edited, created_at, updated_at`;
    return res.json(rows[0]);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.patch('/api/chat-messages', async (req, res) => {
  try {
    const sql = getDB();
    const id  = parseInt(req.query.id, 10);
    const { text } = req.body || {};
    if (!id || !text) return res.status(400).json({ error: 'id and text required' });
    await ensureChatTable(sql);
    const rows = await sql`UPDATE chat_messages SET text=${text}, edited=TRUE, updated_at=NOW() WHERE id=${id} RETURNING id, name, text, edited, created_at, updated_at`;
    return res.json(rows[0]);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.delete('/api/chat-messages', async (req, res) => {
  try {
    const sql = getDB();
    const id  = req.query.id ? parseInt(req.query.id, 10) : null;
    await ensureChatTable(sql);
    if (id) await sql`DELETE FROM chat_messages WHERE id=${id}`;
    else    await sql`DELETE FROM chat_messages`;
    return res.json({ ok: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  Feiya ERP dev API  →  http://localhost:${PORT}`);
  console.log(`  Proxied from Vite  →  http://localhost:5173\n`);
});

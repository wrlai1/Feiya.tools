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

// ─── /api/auto-deduct ─────────────────────────────────────────────────────────

async function ensureDeductLogTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS deduct_log (
      id          SERIAL PRIMARY KEY,
      txn_type    TEXT NOT NULL,
      source_name TEXT,
      applied_by  TEXT NOT NULL,
      row_count   INTEGER NOT NULL DEFAULT 0,
      total_qty   INTEGER NOT NULL DEFAULT 0,
      applied_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

app.all('/api/auto-deduct', async (req, res) => {
  try {
    const sql     = getDB();
    const secret  = getSecret();
    const payload = verifyToken(req.headers.authorization, secret);
    if (!payload) return res.status(401).json({ error: 'Not authenticated' });
    const isAdmin = payload.role === 'admin';
    const action  = req.query.action;

    // Ensure app_data table
    await sql`CREATE TABLE IF NOT EXISTS app_data (
      key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW()
    )`;

    if (req.method === 'GET' && action === 'config') {
      const rows = await sql`SELECT value->>'fileName' AS file_name, updated_at FROM app_data WHERE key = 'autodeduct_template'`;
      return res.json({ template_exists: rows.length > 0, template_name: rows[0]?.file_name || null, updated_at: rows[0]?.updated_at || null });
    }

    if (req.method === 'GET' && action === 'template') {
      const rows = await sql`SELECT value FROM app_data WHERE key = 'autodeduct_template'`;
      if (!rows[0]) return res.status(404).json({ error: 'No template uploaded yet' });
      return res.json(rows[0].value);
    }

    if (req.method === 'POST' && action === 'upload-template') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      const { rows, fileName } = req.body || {};
      if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows array required' });
      const value = JSON.stringify({ rows, fileName: fileName || 'template.csv', uploadedAt: new Date().toISOString(), uploadedBy: payload.username });
      await sql`INSERT INTO app_data (key, value, updated_at) VALUES ('autodeduct_template', ${value}::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`;
      return res.json({ ok: true, count: rows.length });
    }

    if (req.method === 'POST' && action === 'apply') {
      await ensureDeductLogTable(sql);
      const { filledRows = [], txnType = 'sales', sourceName = '' } = req.body || {};
      const rowCount = filledRows.length;
      const totalQty = filledRows.reduce((s, r) => s + (parseInt(r.QTY, 10) || 0), 0);
      await sql`INSERT INTO deduct_log (txn_type, source_name, applied_by, row_count, total_qty) VALUES (${txnType}, ${sourceName}, ${payload.username}, ${rowCount}, ${totalQty})`;
      return res.json({ ok: true, totalQty, rowCount });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[/api/auto-deduct]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── /api/timeclock ───────────────────────────────────────────────────────────

async function ensureTimeTables(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS time_punches (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      username    TEXT NOT NULL,
      type        TEXT NOT NULL,
      punched_at  TIMESTAMPTZ DEFAULT NOW(),
      note        TEXT,
      edited_by   TEXT,
      original_at TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS time_periods (
      id         SERIAL PRIMARY KEY,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      reset_by   TEXT NOT NULL,
      label      TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

async function getTimePeriodStart(sql) {
  const rows = await sql`SELECT started_at FROM time_periods ORDER BY created_at DESC LIMIT 1`;
  return rows[0]?.started_at || new Date(0).toISOString();
}

app.all('/api/timeclock', async (req, res) => {
  try {
    const sql     = getDB();
    const secret  = getSecret();
    const payload = verifyToken(req.headers.authorization, secret);
    if (!payload) return res.status(401).json({ error: 'Not authenticated' });
    const isAdmin = payload.role === 'admin';
    const action  = req.query.action;

    await ensureTimeTables(sql);
    const periodStart = await getTimePeriodStart(sql);

    // POST punch
    if (req.method === 'POST' && action === 'punch') {
      const { type, note } = req.body || {};
      const valid = ['clock_in', 'clock_out', 'break_start', 'break_end'];
      if (!valid.includes(type)) return res.status(400).json({ error: 'Invalid punch type' });
      const last = await sql`
        SELECT type FROM time_punches
        WHERE user_id = ${payload.userId} AND punched_at >= ${periodStart}
        ORDER BY punched_at DESC LIMIT 1
      `;
      const lastType = last[0]?.type || null;
      if (type === 'clock_in' && (lastType === 'clock_in' || lastType === 'break_start' || lastType === 'break_end'))
        return res.status(400).json({ error: 'Already clocked in' });
      if ((type === 'clock_out' || type === 'break_start') && (!lastType || lastType === 'clock_out'))
        return res.status(400).json({ error: 'You are not clocked in' });
      if (type === 'break_start' && lastType === 'break_start')
        return res.status(400).json({ error: 'Already on break' });
      if (type === 'break_end' && lastType !== 'break_start')
        return res.status(400).json({ error: 'Not on break' });
      if (type === 'clock_out' && lastType === 'break_start')
        return res.status(400).json({ error: 'End your break before clocking out' });
      const rows = await sql`
        INSERT INTO time_punches (user_id, username, type, note)
        VALUES (${payload.userId}, ${payload.username}, ${type}, ${note || null})
        RETURNING *
      `;
      return res.json(rows[0]);
    }

    // GET my
    if (req.method === 'GET' && action === 'my') {
      const rows = await sql`
        SELECT * FROM time_punches
        WHERE user_id = ${payload.userId} AND punched_at >= ${periodStart}
        ORDER BY punched_at ASC
      `;
      return res.json({ punches: rows, periodStart });
    }

    // GET all (admin)
    if (req.method === 'GET' && action === 'all') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      const rows = await sql`
        SELECT * FROM time_punches
        WHERE punched_at >= ${periodStart}
        ORDER BY username ASC, punched_at ASC
      `;
      return res.json({ punches: rows, periodStart });
    }

    // GET export (admin)
    if (req.method === 'GET' && action === 'export') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      const from = req.query.from || periodStart;
      const to   = req.query.to   || new Date().toISOString();
      const rows = await sql`
        SELECT * FROM time_punches
        WHERE punched_at >= ${from} AND punched_at <= ${to}
        ORDER BY username ASC, punched_at ASC
      `;
      return res.json({ punches: rows, from, to });
    }

    // PATCH edit punch (admin)
    if (req.method === 'PATCH') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      const punchId = parseInt(req.query.id, 10);
      if (!punchId) return res.status(400).json({ error: 'Punch id required' });
      const { punched_at, note } = req.body || {};
      const orig = await sql`SELECT * FROM time_punches WHERE id = ${punchId}`;
      if (!orig[0]) return res.status(404).json({ error: 'Punch not found' });
      const rows = await sql`
        UPDATE time_punches SET
          punched_at  = ${punched_at  || orig[0].punched_at},
          note        = ${note !== undefined ? note : orig[0].note},
          edited_by   = ${payload.username},
          original_at = COALESCE(original_at, ${orig[0].punched_at})
        WHERE id = ${punchId} RETURNING *
      `;
      return res.json(rows[0]);
    }

    // DELETE punch (admin)
    if (req.method === 'DELETE' && req.query.id) {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      await sql`DELETE FROM time_punches WHERE id = ${parseInt(req.query.id, 10)}`;
      return res.json({ ok: true });
    }

    // POST reset (admin)
    if (req.method === 'POST' && action === 'reset') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      const { label } = req.body || {};
      const rows = await sql`
        INSERT INTO time_periods (reset_by, label)
        VALUES (${payload.username}, ${label || null})
        RETURNING *
      `;
      return res.json(rows[0]);
    }

    // GET periods (admin)
    if (req.method === 'GET' && action === 'periods') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      const rows = await sql`SELECT * FROM time_periods ORDER BY created_at DESC LIMIT 24`;
      return res.json(rows);
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[/api/timeclock]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  Feiya ERP dev API  →  http://localhost:${PORT}`);
  console.log(`  Proxied from Vite  →  http://localhost:5173\n`);
});

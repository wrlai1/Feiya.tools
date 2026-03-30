import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const DEFAULT_ADMIN = { username: 'admin', password: 'feiya2026', role: 'admin' };

async function ensureTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      username    TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'user',
      created_by  TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

async function seedAdminIfNeeded(sql) {
  const rows = await sql`SELECT COUNT(*)::int AS count FROM users`;
  if (rows[0].count === 0) {
    const hash = await bcrypt.hash(DEFAULT_ADMIN.password, 10);
    await sql`
      INSERT INTO users (username, password_hash, role, created_by)
      VALUES (${DEFAULT_ADMIN.username}, ${hash}, ${DEFAULT_ADMIN.role}, 'system')
      ON CONFLICT (username) DO NOTHING
    `;
  }
}

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET not configured');
  return s;
}

function verifyToken(authHeader, secret) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  try { return jwt.verify(authHeader.slice(7), secret); } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return res.status(500).json({ error: 'DATABASE_URL not configured' });

  let secret;
  try { secret = getSecret(); } catch (e) { return res.status(500).json({ error: e.message }); }

  const sql = neon(dbUrl);
  const action = req.query.action;

  try {
    await ensureTable(sql);
    await seedAdminIfNeeded(sql);

    // ── Login ──────────────────────────────────────────────────────────────
    if (action === 'login') {
      const { username, password } = req.body || {};
      if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

      const rows = await sql`SELECT * FROM users WHERE username = ${username.trim()}`;
      const user = rows[0];
      if (!user) return res.status(401).json({ error: 'Invalid username or password' });

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

      const token = jwt.sign(
        { userId: user.id, username: user.username, role: user.role },
        secret,
        { expiresIn: '7d' }
      );
      return res.status(200).json({ token, user: { id: user.id, username: user.username, role: user.role } });
    }

    // ── Verify token ───────────────────────────────────────────────────────
    if (action === 'verify') {
      const payload = verifyToken(req.headers.authorization, secret);
      if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
      const rows = await sql`SELECT id, username, role FROM users WHERE id = ${payload.userId}`;
      if (!rows[0]) return res.status(401).json({ error: 'User not found' });
      return res.status(200).json({ user: rows[0] });
    }

    // ── Change own password ────────────────────────────────────────────────
    if (action === 'change-password') {
      const payload = verifyToken(req.headers.authorization, secret);
      if (!payload) return res.status(401).json({ error: 'Not authenticated' });

      const { currentPassword, newPassword } = req.body || {};
      if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
      if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

      const rows = await sql`SELECT * FROM users WHERE id = ${payload.userId}`;
      const user = rows[0];
      if (!user) return res.status(404).json({ error: 'User not found' });

      const valid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

      const newHash = await bcrypt.hash(newPassword, 10);
      await sql`UPDATE users SET password_hash = ${newHash} WHERE id = ${payload.userId}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

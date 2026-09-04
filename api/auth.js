import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import authentication from '../lib/authentication.cjs';
import userPermissions from '../lib/userPermissions.cjs';

const { authenticateUser } = authentication;
const { normalizeUserPermissions } = userPermissions;

async function ensureTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      username    TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'user',
      auth_version INTEGER NOT NULL DEFAULT 0,
      attendance_access BOOLEAN NOT NULL DEFAULT FALSE,
      created_by  TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS attendance_access BOOLEAN NOT NULL DEFAULT FALSE`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '["inventory_check_view"]'::jsonb`;
}

async function seedAdminIfNeeded(sql) {
  const rows = await sql`SELECT COUNT(*)::int AS count FROM users`;
  if (rows[0].count === 0) {
    const password = String(process.env.INITIAL_ADMIN_PASSWORD || '');
    if (password.length < 12) {
      throw new Error('No users exist. Set INITIAL_ADMIN_PASSWORD to a private password of at least 12 characters, then retry.');
    }
    const username = String(process.env.INITIAL_ADMIN_USERNAME || 'admin').trim().toLowerCase();
    if (!username) throw new Error('INITIAL_ADMIN_USERNAME cannot be blank');
    const hash = await bcrypt.hash(password, 10);
    await sql`
      INSERT INTO users (username, password_hash, role, created_by)
      VALUES (${username}, ${hash}, 'admin', 'system')
      ON CONFLICT (username) DO NOTHING
    `;
  }
}

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET not configured');
  return s;
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
      const normalizedUsername = typeof username === 'string' ? username.trim().toLowerCase() : '';
      if (!normalizedUsername || typeof password !== 'string' || !password) {
        return res.status(400).json({ error: 'Username and password required' });
      }

      const rows = await sql`SELECT * FROM users WHERE username = ${normalizedUsername}`;
      const user = rows[0];
      if (!user) return res.status(401).json({ error: 'Invalid username or password' });

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

      const token = jwt.sign(
        {
          userId: user.id,
          username: user.username,
          role: user.role,
          authVersion: Number(user.auth_version || 0),
        },
        secret,
        { expiresIn: '7d' }
      );
      return res.status(200).json({
        token,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          attendanceAccess: Boolean(user.attendance_access),
          permissions: normalizeUserPermissions(user.permissions),
        },
      });
    }

    // ── Verify token ───────────────────────────────────────────────────────
    if (action === 'verify') {
      const currentUser = await authenticateUser(sql, req.headers.authorization, secret);
      if (!currentUser) return res.status(401).json({ error: 'Invalid or expired token' });
      return res.status(200).json({
        user: {
          id: currentUser.userId,
          username: currentUser.username,
          role: currentUser.role,
          attendanceAccess: currentUser.attendanceAccess,
          permissions: currentUser.permissions,
        },
      });
    }

    // ── Change own password ────────────────────────────────────────────────
    if (action === 'change-password') {
      const currentUser = await authenticateUser(sql, req.headers.authorization, secret);
      if (!currentUser) return res.status(401).json({ error: 'Not authenticated' });

      const { currentPassword, newPassword } = req.body || {};
      if (typeof currentPassword !== 'string' || typeof newPassword !== 'string'
        || !currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Both passwords required' });
      }
      if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

      const rows = await sql`SELECT * FROM users WHERE id = ${currentUser.userId}`;
      const user = rows[0];
      if (!user) return res.status(404).json({ error: 'User not found' });

      const valid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

      const newHash = await bcrypt.hash(newPassword, 10);
      const updated = await sql`
        UPDATE users
        SET password_hash = ${newHash}, auth_version = auth_version + 1
        WHERE id = ${currentUser.userId}
        RETURNING id, username, role, auth_version
      `;
      const nextUser = updated[0];
      const token = jwt.sign(
        {
          userId: nextUser.id,
          username: nextUser.username,
          role: nextUser.role,
          authVersion: Number(nextUser.auth_version),
        },
        secret,
        { expiresIn: '7d' },
      );
      return res.status(200).json({ ok: true, token });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

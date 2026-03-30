import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

function verifyToken(authHeader, secret) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  try { return jwt.verify(authHeader.slice(7), secret); } catch { return null; }
}

async function ensureTables(sql) {
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

async function getPeriodStart(sql) {
  const rows = await sql`SELECT started_at FROM time_periods ORDER BY created_at DESC LIMIT 1`;
  return rows[0]?.started_at || new Date(0).toISOString();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const dbUrl  = process.env.DATABASE_URL;
  const secret = process.env.JWT_SECRET;
  if (!dbUrl || !secret) return res.status(500).json({ error: 'Server not configured' });

  const payload = verifyToken(req.headers.authorization, secret);
  if (!payload) return res.status(401).json({ error: 'Not authenticated' });

  const sql     = neon(dbUrl);
  const action  = req.query.action;
  const isAdmin = payload.role === 'admin';

  try {
    await ensureTables(sql);
    const periodStart = await getPeriodStart(sql);

    // ── POST ?action=punch ─────────────────────────────────────────────────
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

      if (type === 'clock_in'    && (lastType === 'clock_in' || lastType === 'break_start' || lastType === 'break_end'))
        return res.status(400).json({ error: 'Already clocked in' });
      if ((type === 'clock_out' || type === 'break_start') && (!lastType || lastType === 'clock_out'))
        return res.status(400).json({ error: 'You are not clocked in' });
      if (type === 'break_start' && lastType === 'break_start')
        return res.status(400).json({ error: 'Already on break' });
      if (type === 'break_end'   && lastType !== 'break_start')
        return res.status(400).json({ error: 'Not on break' });
      if (type === 'clock_out'   && lastType === 'break_start')
        return res.status(400).json({ error: 'End your break before clocking out' });

      const rows = await sql`
        INSERT INTO time_punches (user_id, username, type, note)
        VALUES (${payload.userId}, ${payload.username}, ${type}, ${note || null})
        RETURNING *
      `;
      return res.status(200).json(rows[0]);
    }

    // ── GET ?action=my ─────────────────────────────────────────────────────
    if (req.method === 'GET' && action === 'my') {
      const rows = await sql`
        SELECT * FROM time_punches
        WHERE user_id = ${payload.userId} AND punched_at >= ${periodStart}
        ORDER BY punched_at ASC
      `;
      return res.status(200).json({ punches: rows, periodStart });
    }

    // ── GET ?action=all (admin) ────────────────────────────────────────────
    if (req.method === 'GET' && action === 'all') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      const rows = await sql`
        SELECT * FROM time_punches
        WHERE punched_at >= ${periodStart}
        ORDER BY username ASC, punched_at ASC
      `;
      return res.status(200).json({ punches: rows, periodStart });
    }

    // ── GET ?action=export&from=&to= (admin) ──────────────────────────────
    if (req.method === 'GET' && action === 'export') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      const from = req.query.from || periodStart;
      const to   = req.query.to   || new Date().toISOString();
      const rows = await sql`
        SELECT * FROM time_punches
        WHERE punched_at >= ${from} AND punched_at <= ${to}
        ORDER BY username ASC, punched_at ASC
      `;
      return res.status(200).json({ punches: rows, from, to });
    }

    // ── PATCH ?id= (admin: edit punch time/note) ──────────────────────────
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
      return res.status(200).json(rows[0]);
    }

    // ── DELETE ?id= (admin) ───────────────────────────────────────────────
    if (req.method === 'DELETE' && req.query.id) {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      await sql`DELETE FROM time_punches WHERE id = ${parseInt(req.query.id, 10)}`;
      return res.status(200).json({ ok: true });
    }

    // ── POST ?action=reset (admin: start new period) ──────────────────────
    if (req.method === 'POST' && action === 'reset') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      const { label } = req.body || {};
      const rows = await sql`
        INSERT INTO time_periods (reset_by, label)
        VALUES (${payload.username}, ${label || null})
        RETURNING *
      `;
      return res.status(200).json(rows[0]);
    }

    // ── GET ?action=periods (admin) ───────────────────────────────────────
    if (req.method === 'GET' && action === 'periods') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      const rows = await sql`SELECT * FROM time_periods ORDER BY created_at DESC LIMIT 24`;
      return res.status(200).json(rows);
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

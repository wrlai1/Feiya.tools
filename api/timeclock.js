import { neon } from '@neondatabase/serverless';
import authentication from '../lib/authentication.cjs';

const { authenticateUser } = authentication;

const ACTIVE_PUNCH_TYPES = new Set(['clock_in', 'break_start', 'break_end']);

export function activeShiftUsers(latestPunches = []) {
  return latestPunches.filter((punch) => ACTIVE_PUNCH_TYPES.has(punch?.type));
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

  const sql     = neon(dbUrl);
  const action  = req.query.action;

  try {
    const payload = await authenticateUser(sql, req.headers.authorization, secret);
    if (!payload) return res.status(401).json({ error: 'Not authenticated' });
    const isAdmin = payload.role === 'admin';
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

      const results = await sql.transaction((txn) => [
        txn`SELECT pg_advisory_xact_lock(hashtext('timeclock-state'))`,
        txn`
          WITH latest AS (
            SELECT type
            FROM time_punches
            WHERE user_id = ${payload.userId} AND punched_at >= ${periodStart}
            ORDER BY punched_at DESC, id DESC
            LIMIT 1
          )
          SELECT 1 / CASE
            WHEN ${type} = 'clock_in'
              AND COALESCE((SELECT type FROM latest), 'clock_out') = 'clock_out' THEN 1
            WHEN ${type} IN ('clock_out', 'break_start')
              AND (SELECT type FROM latest) IN ('clock_in', 'break_end') THEN 1
            WHEN ${type} = 'break_end'
              AND (SELECT type FROM latest) = 'break_start' THEN 1
            ELSE 0
          END AS state_valid
        `,
        txn`
          INSERT INTO time_punches (user_id, username, type, note)
          VALUES (${payload.userId}, ${payload.username}, ${type}, ${note || null})
          RETURNING *
        `,
      ], { isolationLevel: 'Serializable' });
      return res.status(200).json(results[2][0]);
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
      const fromDate = new Date(req.query.from || periodStart);
      const toDate   = new Date(req.query.to || Date.now());
      if (!Number.isFinite(fromDate.getTime()) || !Number.isFinite(toDate.getTime())) {
        return res.status(400).json({ error: 'Invalid export date range' });
      }
      if (fromDate > toDate) {
        return res.status(400).json({ error: 'Export start must be before export end' });
      }
      const from = fromDate.toISOString();
      const to   = toDate.toISOString();
      const rows = await sql`
        SELECT * FROM time_punches
        WHERE punched_at >= ${from} AND punched_at <= ${to}
        ORDER BY username ASC, punched_at ASC
      `;
      const contextPunches = await sql`
        WITH latest_before AS (
          SELECT DISTINCT ON (user_id) *
          FROM time_punches
          WHERE punched_at < ${from}
          ORDER BY user_id, punched_at DESC, id DESC
        ),
        relevant_users AS (
          SELECT DISTINCT user_id
          FROM time_punches
          WHERE punched_at >= ${from} AND punched_at <= ${to}
          UNION
          SELECT user_id
          FROM latest_before
          WHERE type IN ('clock_in', 'break_start', 'break_end')
        ),
        before_context AS (
          SELECT latest_before.*, 'before'::text AS context_position
          FROM latest_before
          JOIN relevant_users USING (user_id)
        ),
        after_context AS (
          SELECT DISTINCT ON (p.user_id)
            p.*, 'after'::text AS context_position
          FROM time_punches p
          JOIN relevant_users USING (user_id)
          WHERE p.punched_at > ${to}
          ORDER BY p.user_id, p.punched_at ASC, p.id ASC
        )
        SELECT * FROM before_context
        UNION ALL
        SELECT * FROM after_context
        ORDER BY username ASC, punched_at ASC
      `;
      return res.status(200).json({ punches: rows, contextPunches, from, to });
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
      const latestPunches = await sql`
        SELECT DISTINCT ON (user_id)
          user_id, username, type, punched_at
        FROM time_punches
        WHERE punched_at >= ${periodStart}
        ORDER BY user_id, punched_at DESC, id DESC
      `;
      const activeUsers = activeShiftUsers(latestPunches);
      if (activeUsers.length > 0) {
        const employeeLabel = activeUsers.length === 1 ? 'employee is' : 'employees are';
        return res.status(409).json({
          error: `Cannot reset while ${activeUsers.length} ${employeeLabel} still clocked in or on break.`,
          code: 'active_shifts',
          activeUsers,
        });
      }
      const { label } = req.body || {};
      const results = await sql.transaction((txn) => [
        txn`SELECT pg_advisory_xact_lock(hashtext('timeclock-state'))`,
        txn`
          WITH latest AS (
            SELECT DISTINCT ON (user_id) user_id, type
            FROM time_punches
            WHERE punched_at >= ${periodStart}
            ORDER BY user_id, punched_at DESC, id DESC
          )
          SELECT 1 / CASE
            WHEN COUNT(*) FILTER (WHERE type IN ('clock_in', 'break_start', 'break_end')) = 0 THEN 1
            ELSE 0
          END AS reset_valid
          FROM latest
        `,
        txn`
          INSERT INTO time_periods (reset_by, label)
          VALUES (${payload.username}, ${label || null})
          RETURNING *
        `,
      ], { isolationLevel: 'Serializable' });
      return res.status(200).json(results[2][0]);
    }

    // ── GET ?action=periods (admin) ───────────────────────────────────────
    if (req.method === 'GET' && action === 'periods') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      const rows = await sql`SELECT * FROM time_periods ORDER BY created_at DESC LIMIT 24`;
      return res.status(200).json(rows);
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    if (/division by zero|could not serialize/i.test(err.message)) {
      return res.status(409).json({ error: 'Clock state changed while this action was being saved. Refresh and try again.' });
    }
    return res.status(500).json({ error: err.message });
  }
}

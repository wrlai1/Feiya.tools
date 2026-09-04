import { neon } from '@neondatabase/serverless';
import authentication from '../lib/authentication.cjs';
import userPermissions from '../lib/userPermissions.cjs';

const { authenticateUser } = authentication;
const { userCanAccessAppData } = userPermissions;

function storedRevision(value) {
  const revision = Number(value?.revision);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 1;
}

async function ensureTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS app_data (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const url = process.env.DATABASE_URL;
  if (!url) return res.status(500).json({ error: 'DATABASE_URL not configured' });

  const sql = neon(url);
  const type = req.query.type || req.body?.type;

  if (!type || !['inventory', 'tracking'].includes(type)) {
    return res.status(400).json({ error: 'type must be inventory or tracking' });
  }

  try {
    const payload = await authenticateUser(sql, req.headers.authorization, process.env.JWT_SECRET);
    if (!payload) return res.status(401).json({ error: 'Not authenticated' });
    if (!userCanAccessAppData(payload, type, req.method)) {
      return res.status(403).json({
        error: req.method === 'GET'
          ? 'Inventory Check access required'
          : 'Inventory Check edit access required',
      });
    }
    if (type !== 'inventory' && req.method !== 'GET' && payload.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    await ensureTable(sql);

    if (req.method === 'GET') {
      const rows = await sql`SELECT value, updated_at FROM app_data WHERE key = ${type}`;
      if (!rows[0]) return res.status(200).json({ rows: [], updatedAt: null, fileName: null, revision: 0 });
      const stored = rows[0].value;
      if (Array.isArray(stored)) {
        return res.status(200).json({
          rows: stored,
          updatedAt: rows[0].updated_at,
          fileName: null,
          revision: 1,
        });
      }
      return res.status(200).json({ ...stored, revision: storedRevision(stored) });
    }

    if (req.method === 'POST') {
      const { data, fileName, expectedRevision: rawExpectedRevision } = req.body || {};
      if (!Array.isArray(data)) return res.status(400).json({ error: 'data must be an array' });
      const expectedRevision = Number(rawExpectedRevision);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        return res.status(400).json({ error: 'expectedRevision must be a whole number of 0 or more' });
      }
      const revision = expectedRevision + 1;
      const wrapper = {
        rows: data,
        fileName: fileName || null,
        updatedAt: new Date().toISOString(),
        revision,
      };
      const jsonVal = JSON.stringify(wrapper);
      const saved = await sql`
        INSERT INTO app_data (key, value, updated_at)
        SELECT ${type}, ${jsonVal}::jsonb, NOW()
        WHERE ${expectedRevision} = 0
           OR EXISTS (SELECT 1 FROM app_data WHERE key = ${type})
        ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = NOW()
        WHERE COALESCE((app_data.value->>'revision')::int, 1) = ${expectedRevision}
        RETURNING value
      `;
      if (!saved.length) {
        return res.status(409).json({ error: 'This shared data changed after you opened it. Refresh before saving so another user\'s changes are not overwritten.' });
      }
      return res.status(200).json({ ok: true, revision, updatedAt: wrapper.updatedAt });
    }

    if (req.method === 'DELETE') {
      const expectedRevision = Number(req.query.expectedRevision ?? req.body?.expectedRevision);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        return res.status(400).json({ error: 'expectedRevision must be a whole number of 0 or more' });
      }
      const deleted = await sql`
        DELETE FROM app_data
        WHERE key = ${type}
          AND COALESCE((value->>'revision')::int, 1) = ${expectedRevision}
        RETURNING key
      `;
      if (!deleted.length && expectedRevision !== 0) {
        return res.status(409).json({ error: 'This shared data changed after you opened it. Refresh before clearing it.' });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

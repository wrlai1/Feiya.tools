const { neon } = require('@neondatabase/serverless');

async function ensureTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS app_data (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const url = process.env.DATABASE_URL;
  if (!url) {
    return res.status(500).json({ error: 'DATABASE_URL not configured' });
  }

  const sql = neon(url);
  const type = req.query.type || req.body?.type;

  if (!type || !['inventory', 'tracking'].includes(type)) {
    return res.status(400).json({ error: 'type must be inventory or tracking' });
  }

  try {
    await ensureTable(sql);

    // GET — return stored data + metadata
    if (req.method === 'GET') {
      const rows = await sql`SELECT value, updated_at FROM app_data WHERE key = ${type}`;
      if (!rows[0]) {
        return res.status(200).json({ rows: [], updatedAt: null, fileName: null });
      }
      const stored = rows[0].value;
      if (Array.isArray(stored)) {
        return res.status(200).json({ rows: stored, updatedAt: rows[0].updated_at, fileName: null });
      }
      return res.status(200).json(stored);
    }

    // POST — store data with metadata wrapper
    if (req.method === 'POST') {
      const { data, fileName, updatedAt } = req.body || {};
      if (!Array.isArray(data)) {
        return res.status(400).json({ error: 'data must be an array' });
      }
      const wrapper = {
        rows: data,
        fileName: fileName || null,
        updatedAt: updatedAt || new Date().toISOString(),
      };
      const jsonVal = JSON.stringify(wrapper);
      await sql`
        INSERT INTO app_data (key, value, updated_at)
        VALUES (${type}, ${jsonVal}::jsonb, NOW())
        ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = NOW()
      `;
      return res.status(200).json({ ok: true });
    }

    // DELETE — clear data for a type
    if (req.method === 'DELETE') {
      await sql`DELETE FROM app_data WHERE key = ${type}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

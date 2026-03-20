const { neon } = require('@neondatabase/serverless');

async function ensureTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      text TEXT NOT NULL,
      edited BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited BOOLEAN DEFAULT FALSE`;
  await sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const url = process.env.DATABASE_URL;
  if (!url) {
    return res.status(500).json({ error: 'DATABASE_URL not configured' });
  }

  const sql = neon(url);
  const messageId = req.query.id ? parseInt(req.query.id, 10) : null;

  try {
    await ensureTable(sql);

    // GET — fetch all messages
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, name, text, edited, created_at, updated_at
        FROM chat_messages
        ORDER BY created_at ASC
      `;
      return res.status(200).json(rows);
    }

    // POST — send a new message
    if (req.method === 'POST') {
      const { name, text } = req.body || {};
      if (!name || !text) {
        return res.status(400).json({ error: 'name and text are required' });
      }
      const rows = await sql`
        INSERT INTO chat_messages (name, text)
        VALUES (${name}, ${text})
        RETURNING id, name, text, edited, created_at, updated_at
      `;
      return res.status(200).json(rows[0]);
    }

    // PATCH ?id=X — edit a specific message
    if (req.method === 'PATCH') {
      if (!messageId) {
        return res.status(400).json({ error: 'id is required' });
      }
      const { text } = req.body || {};
      if (!text) {
        return res.status(400).json({ error: 'text is required' });
      }
      const rows = await sql`
        UPDATE chat_messages
        SET text = ${text}, edited = TRUE, updated_at = NOW()
        WHERE id = ${messageId}
        RETURNING id, name, text, edited, created_at, updated_at
      `;
      if (rows.length === 0) {
        return res.status(404).json({ error: 'Message not found' });
      }
      return res.status(200).json(rows[0]);
    }

    // DELETE ?id=X — delete one; DELETE (no id) — clear all
    if (req.method === 'DELETE') {
      if (messageId) {
        await sql`DELETE FROM chat_messages WHERE id = ${messageId}`;
      } else {
        await sql`DELETE FROM chat_messages`;
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

import { neon } from '@neondatabase/serverless';
import authentication from '../lib/authentication.cjs';

const { authenticateUser } = authentication;

async function ensureTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id SERIAL PRIMARY KEY,
      author_user_id INTEGER,
      name TEXT NOT NULL,
      text TEXT NOT NULL,
      edited BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited BOOLEAN DEFAULT FALSE`;
  await sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`;
  await sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS author_user_id INTEGER`;
  await sql`
    UPDATE chat_messages messages
    SET author_user_id = users.id
    FROM users
    WHERE messages.author_user_id IS NULL
      AND LOWER(messages.name) = LOWER(users.username)
  `;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const url = process.env.DATABASE_URL;
  if (!url) return res.status(500).json({ error: 'DATABASE_URL not configured' });

  const sql = neon(url);
  const messageId = req.query.id ? parseInt(req.query.id, 10) : null;

  try {
    const payload = await authenticateUser(sql, req.headers.authorization, process.env.JWT_SECRET);
    if (!payload) return res.status(401).json({ error: 'Not authenticated' });

    await ensureTable(sql);

    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, name, text, edited, created_at, updated_at
        FROM chat_messages ORDER BY created_at ASC
      `;
      return res.status(200).json(rows);
    }

    if (req.method === 'POST') {
      const text = String(req.body?.text || '').trim();
      if (!text) return res.status(400).json({ error: 'text is required' });
      if (text.length > 5000) return res.status(400).json({ error: 'Message is too long' });
      const rows = await sql`
        INSERT INTO chat_messages (author_user_id, name, text)
        VALUES (${payload.userId}, ${payload.username}, ${text})
        RETURNING id, name, text, edited, created_at, updated_at
      `;
      return res.status(200).json(rows[0]);
    }

    if (req.method === 'PATCH') {
      if (!messageId) return res.status(400).json({ error: 'id is required' });
      const text = String(req.body?.text || '').trim();
      if (!text) return res.status(400).json({ error: 'text is required' });
      if (text.length > 5000) return res.status(400).json({ error: 'Message is too long' });
      const rows = await sql`
        UPDATE chat_messages SET text = ${text}, edited = TRUE, updated_at = NOW()
        WHERE id = ${messageId}
          AND (
            ${payload.role === 'admin'}
            OR author_user_id = ${payload.userId}
            OR (author_user_id IS NULL AND LOWER(name) = LOWER(${payload.username}))
          )
        RETURNING id, name, text, edited, created_at, updated_at
      `;
      if (rows.length === 0) return res.status(404).json({ error: 'Message not found or you cannot edit it' });
      return res.status(200).json(rows[0]);
    }

    if (req.method === 'DELETE') {
      if (messageId) {
        const rows = await sql`
          DELETE FROM chat_messages
          WHERE id = ${messageId}
            AND (
              ${payload.role === 'admin'}
              OR author_user_id = ${payload.userId}
              OR (author_user_id IS NULL AND LOWER(name) = LOWER(${payload.username}))
            )
          RETURNING id
        `;
        if (!rows.length) return res.status(404).json({ error: 'Message not found or you cannot delete it' });
      } else {
        if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
        await sql`DELETE FROM chat_messages`;
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

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
  // Safe migrations for existing tables
  await sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited BOOLEAN DEFAULT FALSE`;
  await sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`;
}

exports.handler = async (event) => {
  const url = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
  if (!url) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'DATABASE_URL not configured' }),
    };
  }

  const sql = neon(url);
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...headers,
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    };
  }

  try {
    await ensureTable(sql);

    const messageId = event.queryStringParameters?.id
      ? parseInt(event.queryStringParameters.id, 10)
      : null;

    // GET — fetch all messages
    if (event.httpMethod === 'GET') {
      const rows = await sql`
        SELECT id, name, text, edited, created_at, updated_at
        FROM chat_messages
        ORDER BY created_at ASC
      `;
      return { statusCode: 200, headers, body: JSON.stringify(rows) };
    }

    // POST — send a new message
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { name, text } = body;
      if (!name || !text) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'name and text are required' }),
        };
      }
      const rows = await sql`
        INSERT INTO chat_messages (name, text)
        VALUES (${name}, ${text})
        RETURNING id, name, text, edited, created_at, updated_at
      `;
      return { statusCode: 200, headers, body: JSON.stringify(rows[0]) };
    }

    // PATCH ?id=X — edit a specific message
    if (event.httpMethod === 'PATCH') {
      if (!messageId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'id is required' }) };
      }
      const body = JSON.parse(event.body || '{}');
      const { text } = body;
      if (!text) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'text is required' }) };
      }
      const rows = await sql`
        UPDATE chat_messages
        SET text = ${text}, edited = TRUE, updated_at = NOW()
        WHERE id = ${messageId}
        RETURNING id, name, text, edited, created_at, updated_at
      `;
      if (rows.length === 0) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Message not found' }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify(rows[0]) };
    }

    // DELETE ?id=X — delete one message; DELETE (no id) — clear all
    if (event.httpMethod === 'DELETE') {
      if (messageId) {
        await sql`DELETE FROM chat_messages WHERE id = ${messageId}`;
      } else {
        await sql`DELETE FROM chat_messages`;
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

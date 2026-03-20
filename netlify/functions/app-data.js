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
        'Access-Control-Allow-Methods': 'GET, POST, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    };
  }

  const type =
    event.queryStringParameters?.type ||
    (event.body ? JSON.parse(event.body || '{}').type : null);

  if (!type || !['inventory', 'tracking'].includes(type)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'type must be inventory or tracking' }),
    };
  }

  try {
    await ensureTable(sql);

    // GET — return stored data + metadata
    if (event.httpMethod === 'GET') {
      const rows = await sql`SELECT value, updated_at FROM app_data WHERE key = ${type}`;
      if (!rows[0]) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ rows: [], updatedAt: null, fileName: null }),
        };
      }
      const stored = rows[0].value;
      // Support legacy format (plain array) and new wrapper format
      if (Array.isArray(stored)) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            rows: stored,
            updatedAt: rows[0].updated_at,
            fileName: null,
          }),
        };
      }
      return { statusCode: 200, headers, body: JSON.stringify(stored) };
    }

    // POST — store data with metadata wrapper
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { data, fileName, updatedAt } = body;
      if (!Array.isArray(data)) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'data must be an array' }),
        };
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
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // DELETE — clear data for a type
    if (event.httpMethod === 'DELETE') {
      await sql`DELETE FROM app_data WHERE key = ${type}`;
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

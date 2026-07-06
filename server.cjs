/**
 * Local development server — mirrors the Vercel API functions.
 * Run with: node server.cjs
 * Vite proxies /api/* to this server on port 3001.
 */
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { neon }  = require('@neondatabase/serverless');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');

const app  = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDB() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set in .env');
  return neon(url);
}

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET not set in .env');
  return s;
}

function verifyToken(authHeader, secret) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  try { return jwt.verify(authHeader.slice(7), secret); } catch { return null; }
}

function requireAdmin(authHeader, secret) {
  const p = verifyToken(authHeader, secret);
  return p?.role === 'admin' ? p : null;
}

async function ensureUsersTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'user',
      created_by    TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

async function seedAdminIfNeeded(sql) {
  const rows = await sql`SELECT COUNT(*)::int AS count FROM users`;
  if (rows[0].count === 0) {
    const hash = await bcrypt.hash('feiya2026', 10);
    await sql`
      INSERT INTO users (username, password_hash, role, created_by)
      VALUES ('admin', ${hash}, 'admin', 'system')
      ON CONFLICT (username) DO NOTHING
    `;
    console.log('  ✓ Seeded default admin user (admin / feiya2026)');
  }
}

// ─── POST /api/auth ───────────────────────────────────────────────────────────

app.post('/api/auth', async (req, res) => {
  const action = req.query.action;
  try {
    const sql    = getDB();
    const secret = getSecret();
    await ensureUsersTable(sql);
    await seedAdminIfNeeded(sql);

    if (action === 'login') {
      const { username, password } = req.body || {};
      if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
      const rows = await sql`SELECT * FROM users WHERE username = ${username.trim()}`;
      const user = rows[0];
      if (!user) return res.status(401).json({ error: 'Invalid username or password' });
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Invalid username or password' });
      const token = jwt.sign({ userId: user.id, username: user.username, role: user.role }, secret, { expiresIn: '7d' });
      return res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
    }

    if (action === 'verify') {
      const payload = verifyToken(req.headers.authorization, secret);
      if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
      const rows = await sql`SELECT id, username, role FROM users WHERE id = ${payload.userId}`;
      if (!rows[0]) return res.status(401).json({ error: 'User not found' });
      return res.json({ user: rows[0] });
    }

    if (action === 'change-password') {
      const payload = verifyToken(req.headers.authorization, secret);
      if (!payload) return res.status(401).json({ error: 'Not authenticated' });
      const { currentPassword, newPassword } = req.body || {};
      if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
      if (newPassword.length < 6) return res.status(400).json({ error: 'Min 6 characters' });
      const rows = await sql`SELECT * FROM users WHERE id = ${payload.userId}`;
      if (!rows[0]) return res.status(404).json({ error: 'User not found' });
      const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
      if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
      const hash = await bcrypt.hash(newPassword, 10);
      await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${payload.userId}`;
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[/api/auth]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── /api/users ───────────────────────────────────────────────────────────────

app.get('/api/users', async (req, res) => {
  try {
    const sql    = getDB();
    const secret = getSecret();
    const admin  = requireAdmin(req.headers.authorization, secret);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });
    const rows = await sql`SELECT id, username, role, created_by, created_at FROM users ORDER BY created_at ASC`;
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', async (req, res) => {
  try {
    const sql    = getDB();
    const secret = getSecret();
    const admin  = requireAdmin(req.headers.authorization, secret);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });
    const { username, password, role = 'user' } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (password.length < 6) return res.status(400).json({ error: 'Min 6 characters' });
    const hash = await bcrypt.hash(password, 10);
    const rows = await sql`
      INSERT INTO users (username, password_hash, role, created_by)
      VALUES (${username.trim().toLowerCase()}, ${hash}, ${role}, ${admin.username})
      RETURNING id, username, role, created_by, created_at
    `;
    return res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    return res.status(500).json({ error: err.message });
  }
});

app.patch('/api/users', async (req, res) => {
  try {
    const sql    = getDB();
    const secret = getSecret();
    const admin  = requireAdmin(req.headers.authorization, secret);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });
    const userId = parseInt(req.query.id, 10);
    if (!userId) return res.status(400).json({ error: 'User id required' });
    const { password, role } = req.body || {};
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${userId}`;
    }
    if (role) await sql`UPDATE users SET role = ${role} WHERE id = ${userId}`;
    const rows = await sql`SELECT id, username, role, created_by, created_at FROM users WHERE id = ${userId}`;
    return res.json(rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users', async (req, res) => {
  try {
    const sql    = getDB();
    const secret = getSecret();
    const admin  = requireAdmin(req.headers.authorization, secret);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });
    const userId = parseInt(req.query.id, 10);
    if (!userId) return res.status(400).json({ error: 'User id required' });
    if (userId === admin.userId) return res.status(400).json({ error: 'Cannot delete yourself' });
    await sql`DELETE FROM users WHERE id = ${userId}`;
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── /api/app-data ────────────────────────────────────────────────────────────

async function ensureAppDataTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS app_data (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

app.get('/api/app-data', async (req, res) => {
  try {
    const sql  = getDB();
    const type = req.query.type;
    if (!['inventory', 'tracking'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
    await ensureAppDataTable(sql);
    const rows = await sql`SELECT value, updated_at FROM app_data WHERE key = ${type}`;
    if (!rows[0]) return res.json({ rows: [], updatedAt: null, fileName: null });
    const stored = rows[0].value;
    return res.json(Array.isArray(stored) ? { rows: stored, updatedAt: rows[0].updated_at, fileName: null } : stored);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post('/api/app-data', async (req, res) => {
  try {
    const sql = getDB();
    const { type, data, fileName, updatedAt } = req.body || {};
    if (!['inventory', 'tracking'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
    await ensureAppDataTable(sql);
    const wrapper = JSON.stringify({ rows: data, fileName: fileName || null, updatedAt: updatedAt || new Date().toISOString() });
    await sql`
      INSERT INTO app_data (key, value, updated_at) VALUES (${type}, ${wrapper}::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
    return res.json({ ok: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.delete('/api/app-data', async (req, res) => {
  try {
    const sql  = getDB();
    const type = req.query.type;
    await ensureAppDataTable(sql);
    await sql`DELETE FROM app_data WHERE key = ${type}`;
    return res.json({ ok: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ─── /api/custom-metrics ──────────────────────────────────────────────────────
// Per-account user-defined ratio metrics (Analytics page).

async function ensureCustomMetricsTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS custom_metrics (
      id          TEXT NOT NULL,
      username    TEXT NOT NULL,
      label       TEXT NOT NULL,
      numerator   TEXT NOT NULL,
      denominator TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'number',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (username, id)
    )
  `;
}

app.all('/api/custom-metrics', async (req, res) => {
  try {
    const sql     = getDB();
    const payload = verifyToken(req.headers.authorization, getSecret());
    if (!payload) return res.status(401).json({ error: 'Not authenticated' });
    const username = payload.username;
    await ensureCustomMetricsTable(sql);

    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, label, numerator, denominator, type
        FROM custom_metrics WHERE username = ${username} ORDER BY created_at
      `;
      return res.json({ metrics: rows });
    }

    if (req.method === 'POST') {
      const { id, label, numerator, denominator, type } = req.body || {};
      if (!id || !label || !numerator || !denominator) {
        return res.status(400).json({ error: 'id, label, numerator and denominator are required' });
      }
      const safeType = ['percent', 'number', 'ratio', 'currency'].includes(type) ? type : 'number';
      await sql`
        INSERT INTO custom_metrics (id, username, label, numerator, denominator, type)
        VALUES (${id}, ${username}, ${label}, ${numerator}, ${denominator}, ${safeType})
        ON CONFLICT (username, id) DO UPDATE SET
          label = EXCLUDED.label, numerator = EXCLUDED.numerator,
          denominator = EXCLUDED.denominator, type = EXCLUDED.type
      `;
      return res.json({ ok: true, metric: { id, label, numerator, denominator, type: safeType } });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id is required' });
      await sql`DELETE FROM custom_metrics WHERE username = ${username} AND id = ${id}`;
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ─── /api/analytics-store ─────────────────────────────────────────────────────
// Per-account stores + daily analytics data. One saved upload = one day.

function analyticsDayString(value) {
  if (!value) return '';
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

async function ensureAnalyticsStoreTables(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS analytics_stores (
      username   TEXT NOT NULL,
      name       TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (username, name)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS analytics_store_days (
      username   TEXT NOT NULL,
      store      TEXT NOT NULL,
      day        DATE NOT NULL,
      file_name  TEXT,
      rows       JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (username, store, day)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS analytics_store_products (
      username   TEXT NOT NULL,
      store      TEXT NOT NULL,
      spu        TEXT NOT NULL,
      data       JSONB NOT NULL,
      file_name  TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (username, store, spu)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS analytics_store_settings (
      username   TEXT NOT NULL,
      store      TEXT NOT NULL,
      data       JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (username, store)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS analytics_store_events (
      id         BIGSERIAL PRIMARY KEY,
      username   TEXT NOT NULL,
      actor      TEXT NOT NULL,
      store      TEXT,
      action     TEXT NOT NULL,
      summary    TEXT,
      details    JSONB,
      snapshot   JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

async function recordAnalyticsEvent(sql, username, actor, store, action, summary, details = {}, snapshot = null) {
  const detailsJson = JSON.stringify(details || {});
  const snapshotJson = snapshot ? JSON.stringify(snapshot) : null;
  await sql`
    INSERT INTO analytics_store_events (username, actor, store, action, summary, details, snapshot)
    VALUES (${username}, ${actor}, ${store || null}, ${action}, ${summary || null}, ${detailsJson}::jsonb, ${snapshotJson}::jsonb)
  `;
}

async function restoreAnalyticsSnapshot(sql, username, snapshot) {
  if (!snapshot?.type) return { restored: 0 };

  if (snapshot.type === 'days') {
    let restored = 0;
    for (const item of snapshot.days || []) {
      const rowsJson = JSON.stringify(item.rows || []);
      await sql`
        INSERT INTO analytics_store_days (username, store, day, file_name, rows, updated_at)
        VALUES (${username}, ${snapshot.store}, ${item.day}, ${item.fileName || null}, ${rowsJson}::jsonb, NOW())
        ON CONFLICT (username, store, day)
        DO UPDATE SET rows = EXCLUDED.rows, file_name = EXCLUDED.file_name, updated_at = NOW()
      `;
      restored += 1;
    }
    return { restored };
  }

  if (snapshot.type === 'day') {
    if (snapshot.previous) {
      const rowsJson = JSON.stringify(snapshot.previous.rows || []);
      await sql`
        INSERT INTO analytics_store_days (username, store, day, file_name, rows, updated_at)
        VALUES (${username}, ${snapshot.store}, ${snapshot.day}, ${snapshot.previous.fileName || null}, ${rowsJson}::jsonb, NOW())
        ON CONFLICT (username, store, day)
        DO UPDATE SET rows = EXCLUDED.rows, file_name = EXCLUDED.file_name, updated_at = NOW()
      `;
      return { restored: 1 };
    }
    await sql`DELETE FROM analytics_store_days WHERE username = ${username} AND store = ${snapshot.store} AND day = ${snapshot.day}`;
    return { restored: 0 };
  }

  if (snapshot.type === 'products') {
    await sql`DELETE FROM analytics_store_products WHERE username = ${username} AND store = ${snapshot.store}`;
    for (const product of snapshot.products || []) {
      const spu = String(product?.spu || product?.data?.spu || '').trim();
      const data = product?.data || product;
      if (!spu || !data) continue;
      const json = JSON.stringify(data);
      await sql`
        INSERT INTO analytics_store_products (username, store, spu, data, file_name, updated_at)
        VALUES (${username}, ${snapshot.store}, ${spu}, ${json}::jsonb, ${product.fileName || null}, NOW())
        ON CONFLICT (username, store, spu)
        DO UPDATE SET data = EXCLUDED.data, file_name = EXCLUDED.file_name, updated_at = NOW()
      `;
    }
    return { restored: (snapshot.products || []).length };
  }

  if (snapshot.type === 'settings') {
    if (snapshot.previous) {
      const json = JSON.stringify(snapshot.previous.data || {});
      await sql`
        INSERT INTO analytics_store_settings (username, store, data, updated_at)
        VALUES (${username}, ${snapshot.store}, ${json}::jsonb, NOW())
        ON CONFLICT (username, store)
        DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
      `;
      return { restored: 1 };
    }
    await sql`DELETE FROM analytics_store_settings WHERE username = ${username} AND store = ${snapshot.store}`;
    return { restored: 0 };
  }

  if (snapshot.type === 'store') {
    await sql`INSERT INTO analytics_stores (username, name) VALUES (${username}, ${snapshot.store}) ON CONFLICT DO NOTHING`;
    await restoreAnalyticsSnapshot(sql, username, { type: 'days', store: snapshot.store, days: snapshot.days || [] });
    await restoreAnalyticsSnapshot(sql, username, { type: 'products', store: snapshot.store, products: snapshot.products || [] });
    if (snapshot.settings) {
      await restoreAnalyticsSnapshot(sql, username, { type: 'settings', store: snapshot.store, previous: snapshot.settings });
    }
    return { restored: 1 };
  }

  return { restored: 0 };
}

app.all('/api/analytics-store', async (req, res) => {
  try {
    const sql     = getDB();
    const payload = verifyToken(req.headers.authorization, getSecret());
    if (!payload) return res.status(401).json({ error: 'Not authenticated' });
    const actor = payload.username;
    const username = payload.role === 'admin' ? 'admin' : payload.username;
    const action   = req.query.action;
    await ensureAnalyticsStoreTables(sql);

    if (req.method === 'GET' && action === 'stores') {
      const rows = await sql`
        SELECT s.name, COUNT(d.day)::int AS days, MIN(d.day) AS first_day, MAX(d.day) AS last_day
        FROM analytics_stores s
        LEFT JOIN analytics_store_days d ON d.username = s.username AND d.store = s.name
        WHERE s.username = ${username}
        GROUP BY s.name ORDER BY s.name
      `;
      return res.json({ stores: rows });
    }

    if (req.method === 'POST' && action === 'create-store') {
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name is required' });
      await sql`INSERT INTO analytics_stores (username, name) VALUES (${username}, ${name}) ON CONFLICT DO NOTHING`;
      await recordAnalyticsEvent(sql, username, actor, name, 'create-store', `Created store ${name}`, { store: name });
      return res.json({ ok: true, name });
    }

    if (req.method === 'DELETE' && action === 'delete-store') {
      const name = String(req.query.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name is required' });
      const dayRows = await sql`
        SELECT day, file_name, rows FROM analytics_store_days
        WHERE username = ${username} AND store = ${name}
        ORDER BY day
      `;
      const productRows = await sql`
        SELECT spu, data, file_name FROM analytics_store_products
        WHERE username = ${username} AND store = ${name}
        ORDER BY spu
      `;
      const settingRows = await sql`
        SELECT data FROM analytics_store_settings
        WHERE username = ${username} AND store = ${name}
        LIMIT 1
      `;
      const snapshot = {
        type: 'store',
        store: name,
        days: dayRows.map((d) => ({ day: analyticsDayString(d.day), fileName: d.file_name, rows: Array.isArray(d.rows) ? d.rows : [] })),
        products: productRows.map((p) => ({ spu: p.spu, data: p.data, fileName: p.file_name })),
        settings: settingRows[0] ? { data: settingRows[0].data } : null,
      };
      await sql`DELETE FROM analytics_store_days WHERE username = ${username} AND store = ${name}`;
      await sql`DELETE FROM analytics_store_products WHERE username = ${username} AND store = ${name}`;
      await sql`DELETE FROM analytics_store_settings WHERE username = ${username} AND store = ${name}`;
      await sql`DELETE FROM analytics_stores WHERE username = ${username} AND name = ${name}`;
      await recordAnalyticsEvent(sql, username, actor, name, 'delete-store', `Deleted store ${name}`, {
        store: name,
        days: snapshot.days.length,
        products: snapshot.products.length,
      }, snapshot);
      return res.json({ ok: true });
    }

    if (req.method === 'GET' && action === 'products') {
      const store = String(req.query.store || '').trim();
      if (!store) return res.status(400).json({ error: 'store is required' });
      const rows = await sql`
        SELECT data FROM analytics_store_products
        WHERE username = ${username} AND store = ${store}
        ORDER BY data->>'sku', spu
      `;
      return res.json({ products: rows.map((r) => r.data) });
    }

    if (req.method === 'POST' && action === 'save-products') {
      const { store, products, fileName } = req.body || {};
      const name = String(store || '').trim();
      if (!name || !Array.isArray(products)) return res.status(400).json({ error: 'store and products are required' });
      const previousProducts = await sql`
        SELECT spu, data, file_name FROM analytics_store_products
        WHERE username = ${username} AND store = ${name}
        ORDER BY spu
      `;
      await sql`INSERT INTO analytics_stores (username, name) VALUES (${username}, ${name}) ON CONFLICT DO NOTHING`;
      await sql`DELETE FROM analytics_store_products WHERE username = ${username} AND store = ${name}`;
      for (const product of products) {
        const spu = String(product?.spu || '').trim();
        if (!spu) continue;
        const json = JSON.stringify({ ...product, store: product.store || name, spu });
        await sql`
          INSERT INTO analytics_store_products (username, store, spu, data, file_name, updated_at)
          VALUES (${username}, ${name}, ${spu}, ${json}::jsonb, ${fileName || null}, NOW())
          ON CONFLICT (username, store, spu)
          DO UPDATE SET data = EXCLUDED.data, file_name = EXCLUDED.file_name, updated_at = NOW()
        `;
      }
      await recordAnalyticsEvent(sql, username, actor, name, 'save-products', `Saved ${products.length} product catalog rows`, {
        store: name,
        fileName: fileName || null,
        count: products.length,
      }, {
        type: 'products',
        store: name,
        products: previousProducts.map((p) => ({ spu: p.spu, data: p.data, fileName: p.file_name })),
      });
      return res.json({ ok: true, count: products.length });
    }

    if (req.method === 'GET' && action === 'settings') {
      const store = String(req.query.store || '__global__').trim() || '__global__';
      const rows = await sql`
        SELECT data FROM analytics_store_settings
        WHERE username = ${username} AND (store = ${store} OR store = '__global__')
        ORDER BY CASE WHEN store = ${store} THEN 0 ELSE 1 END
        LIMIT 1
      `;
      return res.json({ settings: rows[0]?.data || null });
    }

    if (req.method === 'POST' && action === 'save-settings') {
      const { store, settings } = req.body || {};
      const name = String(store || '__global__').trim() || '__global__';
      if (!settings || typeof settings !== 'object') return res.status(400).json({ error: 'settings are required' });
      const previousSettings = await sql`
        SELECT data FROM analytics_store_settings
        WHERE username = ${username} AND store = ${name}
        LIMIT 1
      `;
      const json = JSON.stringify(settings);
      await sql`
        INSERT INTO analytics_store_settings (username, store, data, updated_at)
        VALUES (${username}, ${name}, ${json}::jsonb, NOW())
        ON CONFLICT (username, store)
        DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
      `;
      await recordAnalyticsEvent(sql, username, actor, name, 'save-settings', `Saved analytics settings for ${name}`, {
        store: name,
      }, {
        type: 'settings',
        store: name,
        previous: previousSettings[0] ? { data: previousSettings[0].data } : null,
      });
      return res.json({ ok: true, settings });
    }

    if (req.method === 'POST' && action === 'save-day') {
      const { store, day, fileName, rows } = req.body || {};
      const name = String(store || '').trim();
      if (!name || !day || !Array.isArray(rows)) return res.status(400).json({ error: 'store, day and rows are required' });
      const previousDay = await sql`
        SELECT day, file_name, rows FROM analytics_store_days
        WHERE username = ${username} AND store = ${name} AND day = ${day}
        LIMIT 1
      `;
      await sql`INSERT INTO analytics_stores (username, name) VALUES (${username}, ${name}) ON CONFLICT DO NOTHING`;
      const json = JSON.stringify(rows);
      await sql`
        INSERT INTO analytics_store_days (username, store, day, file_name, rows, updated_at)
        VALUES (${username}, ${name}, ${day}, ${fileName || null}, ${json}::jsonb, NOW())
        ON CONFLICT (username, store, day) DO UPDATE SET rows = EXCLUDED.rows, file_name = EXCLUDED.file_name, updated_at = NOW()
      `;
      await recordAnalyticsEvent(sql, username, actor, name, 'save-day', `Saved ${rows.length} rows for ${name} on ${day}`, {
        store: name,
        day,
        fileName: fileName || null,
        rows: rows.length,
      }, {
        type: 'day',
        store: name,
        day,
        previous: previousDay[0]
          ? { day: analyticsDayString(previousDay[0].day), fileName: previousDay[0].file_name, rows: Array.isArray(previousDay[0].rows) ? previousDay[0].rows : [] }
          : null,
      });
      return res.json({ ok: true });
    }

    if (req.method === 'GET' && action === 'range') {
      const store = String(req.query.store || '').trim();
      const { from, to } = req.query;
      if (!store || !from || !to) return res.status(400).json({ error: 'store, from and to are required' });
      const days = await sql`
        SELECT day, file_name, rows FROM analytics_store_days
        WHERE username = ${username} AND store = ${store} AND day >= ${from} AND day <= ${to}
        ORDER BY day
      `;
      const rows = [], summary = [];
      for (const d of days) {
        const dayStr = d.day instanceof Date ? d.day.toISOString().slice(0, 10) : String(d.day).slice(0, 10);
        const dayRows = Array.isArray(d.rows) ? d.rows : [];
        summary.push({ day: dayStr, fileName: d.file_name, rowCount: dayRows.length });
        for (const r of dayRows) rows.push({ ...r, date: dayStr });
      }
      return res.json({ days: summary, rows });
    }

    if (req.method === 'DELETE' && action === 'delete-day') {
      const store = String(req.query.store || '').trim();
      const day   = req.query.day;
      if (!store || !day) return res.status(400).json({ error: 'store and day are required' });
      const dayRows = await sql`
        SELECT day, file_name, rows FROM analytics_store_days
        WHERE username = ${username} AND store = ${store} AND day = ${day}
      `;
      await sql`DELETE FROM analytics_store_days WHERE username = ${username} AND store = ${store} AND day = ${day}`;
      const snapshotDays = dayRows.map((d) => ({ day: analyticsDayString(d.day), fileName: d.file_name, rows: Array.isArray(d.rows) ? d.rows : [] }));
      await recordAnalyticsEvent(sql, username, actor, store, 'delete-day', `Deleted ${store} data on ${day}`, {
        store,
        from: day,
        to: day,
        days: snapshotDays.length,
        rows: snapshotDays.reduce((total, d) => total + d.rows.length, 0),
      }, { type: 'days', store, days: snapshotDays });
      return res.json({ ok: true });
    }

    if (req.method === 'DELETE' && action === 'delete-range') {
      const store = String(req.query.store || '').trim();
      const { from, to } = req.query;
      if (!store || !from || !to) return res.status(400).json({ error: 'store, from and to are required' });
      const dayRows = await sql`
        SELECT day, file_name, rows FROM analytics_store_days
        WHERE username = ${username} AND store = ${store} AND day >= ${from} AND day <= ${to}
        ORDER BY day
      `;
      const snapshotDays = dayRows.map((d) => ({ day: analyticsDayString(d.day), fileName: d.file_name, rows: Array.isArray(d.rows) ? d.rows : [] }));
      await sql`
        DELETE FROM analytics_store_days
        WHERE username = ${username} AND store = ${store} AND day >= ${from} AND day <= ${to}
      `;
      const rowCount = snapshotDays.reduce((total, d) => total + d.rows.length, 0);
      await recordAnalyticsEvent(sql, username, actor, store, 'delete-range', `Deleted ${snapshotDays.length} saved days from ${store}`, {
        store,
        from,
        to,
        days: snapshotDays.length,
        rows: rowCount,
      }, { type: 'days', store, days: snapshotDays });
      return res.json({ ok: true, days: snapshotDays.length, rows: rowCount });
    }

    if (req.method === 'GET' && action === 'events') {
      const store = String(req.query.store || '').trim();
      const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 100);
      const rows = store
        ? await sql`
            SELECT id, actor, store, action, summary, details, created_at, snapshot IS NOT NULL AS restorable
            FROM analytics_store_events
            WHERE username = ${username} AND store = ${store}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `
        : await sql`
            SELECT id, actor, store, action, summary, details, created_at, snapshot IS NOT NULL AS restorable
            FROM analytics_store_events
            WHERE username = ${username}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
      return res.json({ events: rows });
    }

    if (req.method === 'POST' && action === 'restore-event') {
      const eventId = Number(req.body?.eventId);
      if (!eventId) return res.status(400).json({ error: 'eventId is required' });
      const rows = await sql`
        SELECT id, store, action, summary, snapshot
        FROM analytics_store_events
        WHERE username = ${username} AND id = ${eventId}
        LIMIT 1
      `;
      const event = rows[0];
      if (!event?.snapshot) return res.status(400).json({ error: 'This event has no restore snapshot' });
      const result = await restoreAnalyticsSnapshot(sql, username, event.snapshot);
      await recordAnalyticsEvent(sql, username, actor, event.store, 'restore-event', `Restored event #${eventId}`, {
        eventId,
        restoredFrom: event.action,
        restored: result.restored,
      }, null);
      return res.json({ ok: true, ...result });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ─── /api/chat-messages ───────────────────────────────────────────────────────

async function ensureChatTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      text       TEXT NOT NULL,
      edited     BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited BOOLEAN DEFAULT FALSE`;
  await sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`;
}

app.get('/api/chat-messages', async (req, res) => {
  try {
    const sql = getDB();
    await ensureChatTable(sql);
    const rows = await sql`SELECT id, name, text, edited, created_at, updated_at FROM chat_messages ORDER BY created_at ASC`;
    return res.json(rows);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post('/api/chat-messages', async (req, res) => {
  try {
    const sql = getDB();
    const { name, text } = req.body || {};
    if (!name || !text) return res.status(400).json({ error: 'name and text required' });
    await ensureChatTable(sql);
    const rows = await sql`INSERT INTO chat_messages (name, text) VALUES (${name}, ${text}) RETURNING id, name, text, edited, created_at, updated_at`;
    return res.json(rows[0]);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.patch('/api/chat-messages', async (req, res) => {
  try {
    const sql = getDB();
    const id  = parseInt(req.query.id, 10);
    const { text } = req.body || {};
    if (!id || !text) return res.status(400).json({ error: 'id and text required' });
    await ensureChatTable(sql);
    const rows = await sql`UPDATE chat_messages SET text=${text}, edited=TRUE, updated_at=NOW() WHERE id=${id} RETURNING id, name, text, edited, created_at, updated_at`;
    return res.json(rows[0]);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.delete('/api/chat-messages', async (req, res) => {
  try {
    const sql = getDB();
    const id  = req.query.id ? parseInt(req.query.id, 10) : null;
    await ensureChatTable(sql);
    if (id) await sql`DELETE FROM chat_messages WHERE id=${id}`;
    else    await sql`DELETE FROM chat_messages`;
    return res.json({ ok: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ─── /api/auto-deduct ─────────────────────────────────────────────────────────

async function ensureDeductLogTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS deduct_log (
      id          SERIAL PRIMARY KEY,
      txn_type    TEXT NOT NULL,
      source_name TEXT,
      applied_by  TEXT NOT NULL,
      row_count   INTEGER NOT NULL DEFAULT 0,
      total_qty   INTEGER NOT NULL DEFAULT 0,
      applied_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

app.all('/api/auto-deduct', async (req, res) => {
  try {
    const sql     = getDB();
    const secret  = getSecret();
    const payload = verifyToken(req.headers.authorization, secret);
    if (!payload) return res.status(401).json({ error: 'Not authenticated' });
    const isAdmin = payload.role === 'admin';
    const action  = req.query.action;

    // Ensure app_data table
    await sql`CREATE TABLE IF NOT EXISTS app_data (
      key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW()
    )`;

    if (req.method === 'GET' && action === 'config') {
      const rows = await sql`SELECT value->>'fileName' AS file_name, updated_at FROM app_data WHERE key = 'autodeduct_template'`;
      return res.json({ template_exists: rows.length > 0, template_name: rows[0]?.file_name || null, updated_at: rows[0]?.updated_at || null });
    }

    if (req.method === 'GET' && action === 'template') {
      const rows = await sql`SELECT value FROM app_data WHERE key = 'autodeduct_template'`;
      if (!rows[0]) return res.status(404).json({ error: 'No template uploaded yet' });
      return res.json(rows[0].value);
    }

    if (req.method === 'GET' && action === 'aliases') {
      const rows = await sql`SELECT value FROM app_data WHERE key = 'autodeduct_aliases'`;
      return res.json({ aliases: rows[0]?.value?.aliases || {} });
    }

    if (req.method === 'POST' && action === 'upload-template') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      const { rows, fileName } = req.body || {};
      if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows array required' });
      const value = JSON.stringify({ rows, fileName: fileName || 'template.csv', uploadedAt: new Date().toISOString(), uploadedBy: payload.username });
      await sql`INSERT INTO app_data (key, value, updated_at) VALUES ('autodeduct_template', ${value}::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`;
      return res.json({ ok: true, count: rows.length });
    }

    if (req.method === 'POST' && action === 'save-aliases') {
      const { aliases } = req.body || {};
      if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) return res.status(400).json({ error: 'aliases object required' });
      const value = JSON.stringify({ aliases, updatedAt: new Date().toISOString(), updatedBy: payload.username });
      await sql`INSERT INTO app_data (key, value, updated_at) VALUES ('autodeduct_aliases', ${value}::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`;
      return res.json({ ok: true, count: Object.keys(aliases).length });
    }

    if (req.method === 'POST' && action === 'apply') {
      await ensureDeductLogTable(sql);
      const { filledRows = [], txnType = 'sales', sourceName = '' } = req.body || {};
      const rowCount = filledRows.length;
      const totalQty = filledRows.reduce((s, r) => s + (parseInt(r.QTY, 10) || 0), 0);
      await sql`INSERT INTO deduct_log (txn_type, source_name, applied_by, row_count, total_qty) VALUES (${txnType}, ${sourceName}, ${payload.username}, ${rowCount}, ${totalQty})`;
      return res.json({ ok: true, totalQty, rowCount });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[/api/auto-deduct]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── /api/timeclock ───────────────────────────────────────────────────────────

async function ensureTimeTables(sql) {
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

async function getTimePeriodStart(sql) {
  const rows = await sql`SELECT started_at FROM time_periods ORDER BY created_at DESC LIMIT 1`;
  return rows[0]?.started_at || new Date(0).toISOString();
}

app.all('/api/timeclock', async (req, res) => {
  try {
    const sql     = getDB();
    const secret  = getSecret();
    const payload = verifyToken(req.headers.authorization, secret);
    if (!payload) return res.status(401).json({ error: 'Not authenticated' });
    const isAdmin = payload.role === 'admin';
    const action  = req.query.action;

    await ensureTimeTables(sql);
    const periodStart = await getTimePeriodStart(sql);

    // POST punch
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
      if (type === 'clock_in' && (lastType === 'clock_in' || lastType === 'break_start' || lastType === 'break_end'))
        return res.status(400).json({ error: 'Already clocked in' });
      if ((type === 'clock_out' || type === 'break_start') && (!lastType || lastType === 'clock_out'))
        return res.status(400).json({ error: 'You are not clocked in' });
      if (type === 'break_start' && lastType === 'break_start')
        return res.status(400).json({ error: 'Already on break' });
      if (type === 'break_end' && lastType !== 'break_start')
        return res.status(400).json({ error: 'Not on break' });
      if (type === 'clock_out' && lastType === 'break_start')
        return res.status(400).json({ error: 'End your break before clocking out' });
      const rows = await sql`
        INSERT INTO time_punches (user_id, username, type, note)
        VALUES (${payload.userId}, ${payload.username}, ${type}, ${note || null})
        RETURNING *
      `;
      return res.json(rows[0]);
    }

    // GET my
    if (req.method === 'GET' && action === 'my') {
      const rows = await sql`
        SELECT * FROM time_punches
        WHERE user_id = ${payload.userId} AND punched_at >= ${periodStart}
        ORDER BY punched_at ASC
      `;
      return res.json({ punches: rows, periodStart });
    }

    // GET all (admin)
    if (req.method === 'GET' && action === 'all') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      const rows = await sql`
        SELECT * FROM time_punches
        WHERE punched_at >= ${periodStart}
        ORDER BY username ASC, punched_at ASC
      `;
      return res.json({ punches: rows, periodStart });
    }

    // GET export (admin)
    if (req.method === 'GET' && action === 'export') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      const from = req.query.from || periodStart;
      const to   = req.query.to   || new Date().toISOString();
      const rows = await sql`
        SELECT * FROM time_punches
        WHERE punched_at >= ${from} AND punched_at <= ${to}
        ORDER BY username ASC, punched_at ASC
      `;
      return res.json({ punches: rows, from, to });
    }

    // PATCH edit punch (admin)
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
      return res.json(rows[0]);
    }

    // DELETE punch (admin)
    if (req.method === 'DELETE' && req.query.id) {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      await sql`DELETE FROM time_punches WHERE id = ${parseInt(req.query.id, 10)}`;
      return res.json({ ok: true });
    }

    // POST reset (admin)
    if (req.method === 'POST' && action === 'reset') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      const { label } = req.body || {};
      const rows = await sql`
        INSERT INTO time_periods (reset_by, label)
        VALUES (${payload.username}, ${label || null})
        RETURNING *
      `;
      return res.json(rows[0]);
    }

    // GET periods (admin)
    if (req.method === 'GET' && action === 'periods') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      const rows = await sql`SELECT * FROM time_periods ORDER BY created_at DESC LIMIT 24`;
      return res.json(rows);
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[/api/timeclock]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── /api/inventory-balance ───────────────────────────────────────────────────

const MAX_SNAPSHOTS_INV = 5;

async function ensureInventoryTables(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS inventory_balance (
      id         SERIAL PRIMARY KEY,
      style      TEXT NOT NULL,
      color      TEXT NOT NULL,
      size       TEXT NOT NULL,
      quantity   INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(style, color, size)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS inventory_transactions (
      id               SERIAL PRIMARY KEY,
      transaction_type TEXT NOT NULL,
      source_file      TEXT,
      applied_units    INTEGER DEFAULT 0,
      applied_by       TEXT NOT NULL,
      applied_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS inventory_snapshots (
      id          SERIAL PRIMARY KEY,
      label       TEXT,
      source_name TEXT,
      data        JSONB NOT NULL DEFAULT '[]'::jsonb,
      total_rows  INTEGER DEFAULT 0,
      total_units INTEGER DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

async function saveInventorySnapshot(sql, label, sourceName = '') {
  const rows = await sql`SELECT style, color, size, quantity FROM inventory_balance ORDER BY style, color, size`;
  const totalUnits = rows.reduce((s, r) => s + (r.quantity || 0), 0);
  await sql`
    INSERT INTO inventory_snapshots (label, source_name, data, total_rows, total_units)
    VALUES (${label}, ${sourceName}, ${JSON.stringify(rows)}::jsonb, ${rows.length}, ${totalUnits})
  `;
  await sql`
    DELETE FROM inventory_snapshots
    WHERE id NOT IN (
      SELECT id FROM inventory_snapshots ORDER BY created_at DESC LIMIT ${MAX_SNAPSHOTS_INV}
    )
  `;
}

function formatInventoryRows(rows) {
  return rows.map(r => ({
    id:       r.id,
    Style:    r.style,
    Color:    r.color,
    Size:     r.size,
    Quantity: r.quantity,
    style_n:  r.style,
    color_n:  r.color,
    size_n:   r.size,
  }));
}

function calcInventoryStats(rows) {
  const totalUnits  = rows.reduce((s, r) => s + (Number(r.quantity) || 0), 0);
  const skusInStock = rows.filter(r => r.quantity > 0).length;
  const skusZero    = rows.filter(r => r.quantity <= 0).length;
  return { total_units: totalUnits, skus_in_stock: skusInStock, skus_zero: skusZero };
}

app.all('/api/inventory-balance', async (req, res) => {
  try {
    const sql     = getDB();
    const secret  = getSecret();
    const payload = verifyToken(req.headers.authorization, secret);
    if (!payload) return res.status(401).json({ error: 'Not authenticated' });

    const isAdmin = payload.role === 'admin';
    const action  = req.query.action;

    await ensureInventoryTables(sql);

    // GET list
    if (req.method === 'GET' && action === 'list') {
      const rows = await sql`SELECT id, style, color, size, quantity FROM inventory_balance ORDER BY style, color, size`;
      return res.json({ initialized: rows.length > 0, rows: formatInventoryRows(rows), ...calcInventoryStats(rows) });
    }

    // POST init
    if (req.method === 'POST' && action === 'init') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      const { rows, sourceName = '' } = req.body || {};
      if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows array required' });

      await saveInventorySnapshot(sql, 'pre_init', sourceName);
      await sql`DELETE FROM inventory_balance`;

      for (const r of rows) {
        const style = String(r.Style || r.style || '').trim();
        const color = String(r.Color || r.color || '').trim();
        const size  = String(r.Size  || r.size  || '').trim();
        const qty   = parseInt(r.Quantity || r.quantity || 0, 10) || 0;
        if (!style || !color || !size) continue;
        await sql`
          INSERT INTO inventory_balance (style, color, size, quantity)
          VALUES (${style}, ${color}, ${size}, ${qty})
          ON CONFLICT (style, color, size)
          DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = NOW()
        `;
      }

      const [stat] = await sql`SELECT COUNT(*)::int AS c, COALESCE(SUM(quantity),0)::int AS u FROM inventory_balance`;
      return res.json({ ok: true, total_rows: stat.c, total_units: stat.u });
    }

    // PATCH edit
    if (req.method === 'PATCH' && action === 'edit') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ error: 'id required' });
      const { quantity } = req.body || {};
      if (quantity === undefined || quantity === null) return res.status(400).json({ error: 'quantity required' });

      const [old] = await sql`SELECT quantity FROM inventory_balance WHERE id = ${id}`;
      if (!old) return res.status(404).json({ error: 'Row not found' });

      await sql`UPDATE inventory_balance SET quantity = ${quantity}, updated_at = NOW() WHERE id = ${id}`;
      return res.json({ ok: true, old_quantity: old.quantity, new_quantity: quantity });
    }

    // POST add-rows
    if (req.method === 'POST' && action === 'add-rows') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      const { rows } = req.body || {};
      if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows required' });

      let added = 0;
      for (const r of rows) {
        const style = String(r.Style || r.style || '').trim();
        const color = String(r.Color || r.color || '').trim();
        const size  = String(r.Size  || r.size  || '').trim();
        const qty   = parseInt(r.Quantity || r.quantity || 0, 10) || 0;
        if (!style || !color || !size) continue;
        const result = await sql`
          INSERT INTO inventory_balance (style, color, size, quantity)
          VALUES (${style}, ${color}, ${size}, ${qty})
          ON CONFLICT (style, color, size) DO NOTHING
          RETURNING id
        `;
        if (result.length) added++;
      }
      return res.json({ ok: true, added });
    }

    // DELETE remove-rows
    if (req.method === 'DELETE' && action === 'remove-rows') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      const { ids } = req.body || {};
      if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });

      await saveInventorySnapshot(sql, 'pre_remove');
      await sql`DELETE FROM inventory_balance WHERE id = ANY(${ids}::int[])`;
      return res.json({ ok: true, removed: ids.length });
    }

    // POST reset
    if (req.method === 'POST' && action === 'reset') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      await saveInventorySnapshot(sql, 'pre_reset');
      await sql`UPDATE inventory_balance SET quantity = 0, updated_at = NOW()`;
      return res.json({ ok: true });
    }

    // POST apply
    if (req.method === 'POST' && action === 'apply') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      const { filledRows = [], txnType = 'sales', sourceName = '' } = req.body || {};

      await saveInventorySnapshot(sql, txnType, sourceName);

      let appliedUnits = 0;
      for (const r of filledRows) {
        const qty = parseInt(r.QTY, 10) || 0;
        if (!qty) continue;

        if (txnType === 'sales') {
          await sql`
            UPDATE inventory_balance
            SET quantity   = GREATEST(0, quantity - ${qty}),
                updated_at = NOW()
            WHERE style = ${String(r.STYLE)} AND color = ${String(r.COLOR)} AND size = ${String(r.SIZE)}
          `;
        } else {
          await sql`
            UPDATE inventory_balance
            SET quantity   = quantity + ${qty},
                updated_at = NOW()
            WHERE style = ${String(r.STYLE)} AND color = ${String(r.COLOR)} AND size = ${String(r.SIZE)}
          `;
        }
        appliedUnits += qty;
      }

      await sql`
        INSERT INTO inventory_transactions (transaction_type, source_file, applied_units, applied_by)
        VALUES (${txnType}, ${sourceName}, ${appliedUnits}, ${payload.username})
      `;
      return res.json({ ok: true, applied_units: appliedUnits });
    }

    // GET transactions
    if (req.method === 'GET' && action === 'transactions') {
      const rows = await sql`
        SELECT id, transaction_type, source_file, applied_units, applied_by, applied_at
        FROM inventory_transactions
        ORDER BY applied_at DESC LIMIT 50
      `;
      return res.json({
        transactions: rows.map(r => ({ ...r, timestamp: new Date(r.applied_at).toLocaleString() })),
      });
    }

    // GET history
    if (req.method === 'GET' && action === 'history') {
      const rows = await sql`
        SELECT id, label, source_name, total_rows, total_units, created_at
        FROM inventory_snapshots ORDER BY created_at DESC LIMIT ${MAX_SNAPSHOTS_INV}
      `;
      return res.json({
        snapshots: rows.map(r => ({
          id:          r.id,
          label:       r.label,
          source_name: r.source_name,
          total_rows:  r.total_rows,
          total_units: r.total_units,
          timestamp:   new Date(r.created_at).toLocaleString(),
        })),
      });
    }

    // POST restore
    if (req.method === 'POST' && action === 'restore') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      const snapId = parseInt(req.query.id, 10);
      if (!snapId) return res.status(400).json({ error: 'id required' });

      const [snap] = await sql`SELECT data FROM inventory_snapshots WHERE id = ${snapId}`;
      if (!snap) return res.status(404).json({ error: 'Snapshot not found' });

      await saveInventorySnapshot(sql, 'pre_restore');
      await sql`DELETE FROM inventory_balance`;

      for (const r of snap.data) {
        await sql`
          INSERT INTO inventory_balance (style, color, size, quantity)
          VALUES (${r.style}, ${r.color}, ${r.size}, ${r.quantity})
          ON CONFLICT (style, color, size)
          DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = NOW()
        `;
      }

      const [stat] = await sql`SELECT COALESCE(SUM(quantity),0)::int AS u FROM inventory_balance`;
      return res.json({ ok: true, total_units: stat.u });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[/api/inventory-balance]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  Feiya ERP dev API  →  http://localhost:${PORT}`);
  console.log(`  Proxied from Vite  →  http://localhost:5173\n`);
});

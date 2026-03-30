import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

function requireAdmin(authHeader, secret) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const p = jwt.verify(authHeader.slice(7), secret);
    return p.role === 'admin' ? p : null;
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const dbUrl = process.env.DATABASE_URL;
  const secret = process.env.JWT_SECRET;
  if (!dbUrl || !secret) return res.status(500).json({ error: 'Server not configured' });

  const admin = requireAdmin(req.headers.authorization, secret);
  if (!admin) return res.status(403).json({ error: 'Admin access required' });

  const sql = neon(dbUrl);
  const userId = req.query.id ? parseInt(req.query.id, 10) : null;

  try {
    // ── List all users ─────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, username, role, created_by, created_at
        FROM users ORDER BY created_at ASC
      `;
      return res.status(200).json(rows);
    }

    // ── Create user ────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const { username, password, role = 'user' } = req.body || {};
      if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
      if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Role must be admin or user' });
      if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

      const hash = await bcrypt.hash(password, 10);
      const rows = await sql`
        INSERT INTO users (username, password_hash, role, created_by)
        VALUES (${username.trim().toLowerCase()}, ${hash}, ${role}, ${admin.username})
        RETURNING id, username, role, created_by, created_at
      `;
      return res.status(200).json(rows[0]);
    }

    // ── Reset password or change role ──────────────────────────────────────
    if (req.method === 'PATCH') {
      if (!userId) return res.status(400).json({ error: 'User id required' });
      const { password, role } = req.body || {};

      if (password) {
        if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
        const hash = await bcrypt.hash(password, 10);
        await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${userId}`;
      }
      if (role) {
        if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
        await sql`UPDATE users SET role = ${role} WHERE id = ${userId}`;
      }
      const rows = await sql`SELECT id, username, role, created_by, created_at FROM users WHERE id = ${userId}`;
      if (!rows[0]) return res.status(404).json({ error: 'User not found' });
      return res.status(200).json(rows[0]);
    }

    // ── Delete user ────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      if (!userId) return res.status(400).json({ error: 'User id required' });
      if (userId === admin.userId) return res.status(400).json({ error: 'You cannot delete your own account' });
      await sql`DELETE FROM users WHERE id = ${userId}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    return res.status(500).json({ error: err.message });
  }
}

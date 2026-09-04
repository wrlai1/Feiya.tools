import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
import authentication from '../lib/authentication.cjs';
import userPermissions from '../lib/userPermissions.cjs';

const { authenticateUser } = authentication;
const {
  INVENTORY_CHECK_VIEW,
  isValidUserPermissions,
  normalizeUserPermissions,
} = userPermissions;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const dbUrl = process.env.DATABASE_URL;
  const secret = process.env.JWT_SECRET;
  if (!dbUrl || !secret) return res.status(500).json({ error: 'Server not configured' });

  const sql = neon(dbUrl);
  const rawUserId = req.query.id;
  const userId = /^\d+$/.test(String(rawUserId || '')) ? Number(rawUserId) : null;

  try {
    const admin = await authenticateUser(sql, req.headers.authorization, secret);
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS attendance_access BOOLEAN NOT NULL DEFAULT FALSE`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '["inventory_check_view"]'::jsonb`;
    // ── List all users ─────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, username, role, attendance_access, permissions, created_by, created_at
        FROM users ORDER BY created_at ASC
      `;
      return res.status(200).json(rows.map((user) => ({
        ...user,
        permissions: normalizeUserPermissions(user.permissions),
      })));
    }

    // ── Create user ────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const {
        username,
        password,
        role = 'user',
        attendanceAccess = false,
        permissions = [INVENTORY_CHECK_VIEW],
      } = req.body || {};
      const normalizedUsername = typeof username === 'string' ? username.trim().toLowerCase() : '';
      if (!normalizedUsername || typeof password !== 'string' || !password) {
        return res.status(400).json({ error: 'Username and password required' });
      }
      if (normalizedUsername.length > 100) return res.status(400).json({ error: 'Username is too long' });
      if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Role must be admin or user' });
      if (!isValidUserPermissions(permissions)) return res.status(400).json({ error: 'Invalid permissions' });
      if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

      const hash = await bcrypt.hash(password, 10);
      const normalizedPermissions = normalizeUserPermissions(permissions);
      const rows = await sql`
        INSERT INTO users (username, password_hash, role, attendance_access, permissions, created_by)
        VALUES (
          ${normalizedUsername}, ${hash}, ${role}, ${Boolean(attendanceAccess)},
          ${JSON.stringify(normalizedPermissions)}::jsonb, ${admin.username}
        )
        RETURNING id, username, role, attendance_access, permissions, created_by, created_at
      `;
      return res.status(200).json({
        ...rows[0],
        permissions: normalizeUserPermissions(rows[0].permissions),
      });
    }

    // ── Reset password or change role ──────────────────────────────────────
    if (req.method === 'PATCH') {
      if (!userId) return res.status(400).json({ error: 'User id required' });
      const { password, role, attendanceAccess, permissions } = req.body || {};
      const hasPassword = Object.prototype.hasOwnProperty.call(req.body || {}, 'password');
      const hasRole = Object.prototype.hasOwnProperty.call(req.body || {}, 'role');
      const hasAttendanceAccess = Object.prototype.hasOwnProperty.call(req.body || {}, 'attendanceAccess');
      const hasPermissions = Object.prototype.hasOwnProperty.call(req.body || {}, 'permissions');

      if (!hasPassword && !hasRole && !hasAttendanceAccess && !hasPermissions) {
        return res.status(400).json({ error: 'Password, role, attendance access, or permissions required' });
      }
      if (hasPassword && (typeof password !== 'string' || password.length < 6)) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }
      if (hasRole && !['admin', 'user'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
      }
      if (hasPermissions && !isValidUserPermissions(permissions)) {
        return res.status(400).json({ error: 'Invalid permissions' });
      }

      if (userId === admin.userId && (hasPassword || (hasRole && role !== 'admin'))) {
        return res.status(400).json({ error: 'Use Change Password for your own account; you cannot remove your own admin access' });
      }

      const hash = hasPassword ? await bcrypt.hash(password, 10) : null;
      const normalizedPermissions = hasPermissions ? normalizeUserPermissions(permissions) : [];
      const demotingAdmin = hasRole && role === 'user';
      const results = await sql.transaction((txn) => [
        txn`SELECT pg_advisory_xact_lock(hashtext('users-admin-write'))`,
        txn`
          SELECT 1 / CASE
            WHEN ${demotingAdmin}
              AND EXISTS (SELECT 1 FROM users WHERE id = ${userId} AND role = 'admin')
              AND (SELECT COUNT(*) FROM users WHERE role = 'admin') <= 1
            THEN 0 ELSE 1
          END AS admin_guard
        `,
        txn`
          UPDATE users
          SET password_hash = CASE WHEN ${hasPassword} THEN ${hash} ELSE password_hash END,
              role = CASE WHEN ${hasRole} THEN ${role || null} ELSE role END,
              attendance_access = CASE
                WHEN ${hasAttendanceAccess} THEN ${Boolean(attendanceAccess)}
                ELSE attendance_access
              END,
              permissions = CASE
                WHEN ${hasPermissions} THEN ${JSON.stringify(normalizedPermissions)}::jsonb
                ELSE permissions
              END,
              auth_version = auth_version + CASE
                WHEN ${hasPassword} OR (${hasRole} AND role IS DISTINCT FROM ${role || null}) THEN 1
                ELSE 0
              END
          WHERE id = ${userId}
          RETURNING id, username, role, attendance_access, permissions, created_by, created_at
        `,
      ], { isolationLevel: 'Serializable' });
      if (!results[2][0]) return res.status(404).json({ error: 'User not found' });
      return res.status(200).json({
        ...results[2][0],
        permissions: normalizeUserPermissions(results[2][0].permissions),
      });
    }

    // ── Delete user ────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      if (!userId) return res.status(400).json({ error: 'User id required' });
      if (userId === admin.userId) return res.status(400).json({ error: 'You cannot delete your own account' });
      const results = await sql.transaction((txn) => [
        txn`SELECT pg_advisory_xact_lock(hashtext('users-admin-write'))`,
        txn`
          SELECT 1 / CASE
            WHEN EXISTS (SELECT 1 FROM users WHERE id = ${userId} AND role = 'admin')
              AND (SELECT COUNT(*) FROM users WHERE role = 'admin') <= 1
            THEN 0 ELSE 1
          END AS admin_guard
        `,
        txn`DELETE FROM users WHERE id = ${userId} RETURNING id`,
      ], { isolationLevel: 'Serializable' });
      if (!results[2][0]) return res.status(404).json({ error: 'User not found' });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    if (/division by zero/.test(err.message)) {
      return res.status(409).json({ error: 'At least one administrator account must remain' });
    }
    if (/could not serialize/i.test(err.message)) {
      return res.status(409).json({ error: 'User access changed at the same time. Refresh and try again.' });
    }
    return res.status(500).json({ error: err.message });
  }
}

const jwt = require('jsonwebtoken')
const { normalizeUserPermissions } = require('./userPermissions.cjs')

let authSchemaReady

async function ensureAuthenticationSchema(sql) {
  if (!authSchemaReady) {
    authSchemaReady = sql`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0
    `.then(() => sql`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '["inventory_check_view"]'::jsonb
    `).catch((error) => {
      authSchemaReady = null
      throw error
    })
  }
  await authSchemaReady
}

function verifyToken(authHeader, secret) {
  if (!authHeader?.startsWith('Bearer ') || !secret) return null
  try {
    return jwt.verify(authHeader.slice(7), secret)
  } catch {
    return null
  }
}

async function authenticateUser(sql, authHeader, secret) {
  const token = verifyToken(authHeader, secret)
  const userId = Number(token?.userId)
  if (!Number.isSafeInteger(userId) || userId <= 0) return null

  await ensureAuthenticationSchema(sql)

  const rows = await sql`
    SELECT id, username, role, permissions, COALESCE(auth_version, 0)::int AS auth_version
    FROM users
    WHERE id = ${userId}
    LIMIT 1
  `
  const user = rows[0]
  if (!user) return null
  if (Number(token.authVersion || 0) !== Number(user.auth_version || 0)) return null

  return {
    userId: Number(user.id),
    username: user.username,
    role: user.role,
    permissions: normalizeUserPermissions(user.permissions),
    authVersion: Number(user.auth_version || 0),
  }
}

module.exports = {
  authenticateUser,
  ensureAuthenticationSchema,
  verifyToken,
}

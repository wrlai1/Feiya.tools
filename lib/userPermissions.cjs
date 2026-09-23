const INVENTORY_CHECK_VIEW = 'inventory_check_view'
const INVENTORY_CHECK_EDIT = 'inventory_check_edit'
const USER_PERMISSION_KEYS = [INVENTORY_CHECK_VIEW, INVENTORY_CHECK_EDIT]

function isValidUserPermissions(value) {
  return Array.isArray(value)
    && value.every((permission) => USER_PERMISSION_KEYS.includes(permission))
}

function normalizeUserPermissions(value) {
  const selected = new Set(
    (Array.isArray(value) ? value : []).filter((permission) =>
      USER_PERMISSION_KEYS.includes(permission),
    ),
  )
  if (selected.has(INVENTORY_CHECK_EDIT)) selected.add(INVENTORY_CHECK_VIEW)
  return USER_PERMISSION_KEYS.filter((permission) => selected.has(permission))
}

function userHasPermission(user, permission) {
  return user?.role === 'admin'
    || normalizeUserPermissions(user?.permissions).includes(permission)
}

function userCanAccessAppData(user, type, method) {
  if (type !== 'inventory') return true
  return userHasPermission(
    user,
    method === 'GET' ? INVENTORY_CHECK_VIEW : INVENTORY_CHECK_EDIT,
  )
}

module.exports = {
  INVENTORY_CHECK_EDIT,
  INVENTORY_CHECK_VIEW,
  USER_PERMISSION_KEYS,
  isValidUserPermissions,
  normalizeUserPermissions,
  userCanAccessAppData,
  userHasPermission,
}

export const INVENTORY_CHECK_VIEW = 'inventory_check_view'
export const INVENTORY_CHECK_EDIT = 'inventory_check_edit'
export const USER_PERMISSION_KEYS = [INVENTORY_CHECK_VIEW, INVENTORY_CHECK_EDIT]

export function normalizeUserPermissions(value) {
  const selected = new Set(
    (Array.isArray(value) ? value : []).filter((permission) =>
      USER_PERMISSION_KEYS.includes(permission),
    ),
  )
  if (selected.has(INVENTORY_CHECK_EDIT)) selected.add(INVENTORY_CHECK_VIEW)
  return USER_PERMISSION_KEYS.filter((permission) => selected.has(permission))
}

export function userHasPermission(user, permission) {
  return user?.role === 'admin'
    || normalizeUserPermissions(user?.permissions).includes(permission)
}

export default {
  INVENTORY_CHECK_EDIT,
  INVENTORY_CHECK_VIEW,
  USER_PERMISSION_KEYS,
  normalizeUserPermissions,
  userHasPermission,
}

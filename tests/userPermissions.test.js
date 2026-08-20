import test from 'node:test'
import assert from 'node:assert/strict'

import userPermissions from '../lib/userPermissions.cjs'

const {
  INVENTORY_CHECK_EDIT,
  INVENTORY_CHECK_VIEW,
  isValidUserPermissions,
  normalizeUserPermissions,
  userCanAccessAppData,
  userHasPermission,
} = userPermissions

test('Inventory Check edit permission always includes view permission', () => {
  assert.deepEqual(normalizeUserPermissions([INVENTORY_CHECK_EDIT]), [
    INVENTORY_CHECK_VIEW,
    INVENTORY_CHECK_EDIT,
  ])
})

test('unknown user permissions are rejected', () => {
  assert.equal(isValidUserPermissions([INVENTORY_CHECK_VIEW]), true)
  assert.equal(isValidUserPermissions(['inventory_check_delete']), false)
  assert.equal(isValidUserPermissions('inventory_check_view'), false)
})

test('view-only users can read Inventory Check but cannot change it', () => {
  const user = { role: 'user', permissions: [INVENTORY_CHECK_VIEW] }
  assert.equal(userCanAccessAppData(user, 'inventory', 'GET'), true)
  assert.equal(userCanAccessAppData(user, 'inventory', 'POST'), false)
  assert.equal(userCanAccessAppData(user, 'inventory', 'DELETE'), false)
})

test('edit users and Admin can change Inventory Check', () => {
  const editor = { role: 'user', permissions: [INVENTORY_CHECK_EDIT] }
  assert.equal(userHasPermission(editor, INVENTORY_CHECK_VIEW), true)
  assert.equal(userCanAccessAppData(editor, 'inventory', 'POST'), true)
  assert.equal(userCanAccessAppData({ role: 'admin', permissions: [] }, 'inventory', 'DELETE'), true)
})

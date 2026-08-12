import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import returnPackageSafety from '../lib/returnPackageSafety.cjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const API_SOURCE = readFileSync(`${ROOT}/api/returns.js`, 'utf8')
const UI_SOURCE = readFileSync(`${ROOT}/src/pages/ReturnsReceiving.jsx`, 'utf8')

const {
  isFinalReturnStatus,
  normalizeManualReturnDraft,
  normalizeReturnItemResolutionMode,
  resolveReturnPackageItems,
  returnWorkflowActions,
} = returnPackageSafety

function actionBlock(action) {
  const marker = `action === '${action}'`
  const start = API_SOURCE.indexOf(marker)
  assert.notEqual(start, -1, `Missing returns API action: ${action}`)
  const next = API_SOURCE.indexOf("\n    if (req.method", start + marker.length)
  return API_SOURCE.slice(start, next === -1 ? API_SOURCE.length : next)
}

function assertContainsAll(source, values, message) {
  for (const value of values) {
    assert.ok(source.includes(value), `${message}: ${value}`)
  }
}

test('every non-final return state and role has at least one safe exit', () => {
  assert.equal(
    typeof returnWorkflowActions,
    'function',
    'returnPackageSafety must expose the workflow policy used by UI and API',
  )

  const scenarios = [
    {
      state: { status: 'pending', role: 'worker', requiresItemResolution: false, hasItems: true },
      expected: ['confirm_all_good', 'send_admin_review'],
    },
    {
      state: { status: 'pending', role: 'worker', requiresItemResolution: true },
      expected: ['send_admin_review'],
    },
    {
      state: { status: 'pending', role: 'admin', requiresItemResolution: false, hasItems: true },
      expected: ['confirm', 'remap_sku', 'reassign_store', 'close_not_ours', 'close_cancelled'],
    },
    {
      state: { status: 'pending', role: 'admin', requiresItemResolution: true },
      expected: ['resolve_replace', 'resolve_append', 'reassign_store', 'close_not_ours', 'close_cancelled'],
    },
    {
      state: { status: 'needs_review', role: 'worker', requiresItemResolution: true },
      expected: ['send_admin_review'],
    },
    {
      state: { status: 'needs_review', role: 'worker', requiresItemResolution: false, hasItems: true },
      expected: ['send_admin_review'],
    },
    {
      state: { status: 'needs_review', role: 'admin', requiresItemResolution: false, hasItems: true },
      expected: ['confirm', 'remap_sku', 'reassign_store', 'close_not_ours', 'close_cancelled'],
    },
    {
      state: { status: 'needs_review', role: 'admin', requiresItemResolution: true, hasItems: true },
      expected: ['resolve_keep_existing', 'resolve_replace', 'resolve_append', 'remap_sku', 'reassign_store', 'close_not_ours', 'close_cancelled'],
    },
  ]

  for (const { state, expected } of scenarios) {
    const actions = returnWorkflowActions(state)
    assert.ok(Array.isArray(actions) && actions.length > 0, `${state.role} is stuck in ${state.status}`)
    for (const action of expected) {
      assert.ok(actions.includes(action), `${state.role}/${state.status} is missing ${action}`)
    }
    if (state.role !== 'admin') {
      for (const adminAction of ['close_cancelled', 'close_not_ours', 'reassign_store', 'remap_sku']) {
        assert.ok(!actions.includes(adminAction), `${adminAction} leaked to ${state.role}/${state.status}`)
      }
    }
    if (state.role === 'admin' && !state.hasItems) {
      assert.ok(!actions.includes('remap_sku'), 'an empty package cannot remap a nonexistent SKU')
    }
  }
})

test('an Admin-created manual unresolved return is not a pending dead end', () => {
  const draft = normalizeManualReturnDraft({
    trackingNumber: 'MANUAL-ADMIN-1',
    storeName: 'House',
    storeKey: 'house',
    username: 'admin',
    isAdmin: true,
  })
  assert.equal(draft.status, 'needs_review')
  assert.equal(draft.requires_item_resolution, true)
  const actions = returnWorkflowActions({
    status: draft.status,
    role: 'admin',
    requiresItemResolution: draft.requires_item_resolution,
    hasItems: false,
  })
  assertContainsAll(actions, [
    'resolve_replace',
    'resolve_append',
    'reassign_store',
    'close_not_ours',
    'close_cancelled',
  ], 'Admin manual return has no recovery path')
  assert.ok(!actions.includes('resolve_keep_existing'), 'an empty package cannot keep nonexistent items')
})

test('item resolution has explicit keep and replace semantics', () => {
  assert.equal(normalizeReturnItemResolutionMode(' KEEP_EXISTING '), 'keep_existing')
  assert.throws(() => normalizeReturnItemResolutionMode(''), /choose/i)

  const existing = [{
    sku_id: 'OLD-SKU',
    sku_code: 'OLD-CODE',
    style: 'A100',
    color: 'Black',
    size: 'M',
    expected_qty: 1,
    source_qty: 1,
  }]
  const replacement = [{
    sku_id: 'NEW-SKU',
    sku_code: 'NEW-CODE',
    style: 'B200',
    color: 'Navy',
    size: 'L',
    expected_qty: 2,
    source_qty: 2,
  }]
  assert.deepEqual(resolveReturnPackageItems(existing, [], 'keep_existing'), existing)
  assert.throws(
    () => resolveReturnPackageItems(existing, replacement, 'keep_existing'),
    /cannot include new/i,
  )
  assert.deepEqual(resolveReturnPackageItems(existing, replacement, 'replace'), replacement)
  assert.deepEqual(
    resolveReturnPackageItems(existing, replacement, 'append').map((item) => item.sku_id),
    ['OLD-SKU', 'NEW-SKU'],
  )

  const block = actionBlock('resolve-items')
  assertContainsAll(
    block,
    [
      'req.body?.mode',
      'normalizeReturnItemResolutionMode',
      'resolveReturnPackageItems',
      'keep_existing',
      'replace',
    ],
    'resolve-items must require an explicit resolution mode',
  )
  assert.match(
    block,
    /resolveReturnPackageItems\s*\([\s\S]*?resolutionMode\s*\)/,
    'the validated mode must control how existing and resolved items are combined',
  )
  assert.doesNotMatch(
    block,
    /const items = mergeReturnPackageItems\(pkg\.items, resolvedItems\)/,
    'replace must not silently append the replacement to the old package items',
  )
})

test('cancelled is final, but corrected needs_review packages remain importable', () => {
  assert.equal(typeof isFinalReturnStatus, 'function')
  for (const status of ['received', 'discrepancy', 'rejected', 'cancelled']) {
    assert.equal(isFinalReturnStatus(status), true, `${status} must be final`)
  }
  for (const status of ['pending', 'needs_review', 'processing']) {
    assert.equal(isFinalReturnStatus(status), false, `${status} must remain recoverable`)
  }
  for (const status of ['received', 'discrepancy', 'rejected', 'cancelled', 'processing']) {
    for (const role of ['worker', 'admin']) {
      assert.deepEqual(
        returnWorkflowActions({ status, role, requiresItemResolution: true, hasItems: true }),
        [],
        `${role} must not mutate ${status}`,
      )
    }
  }

  const block = actionBlock('import')
  assert.doesNotMatch(block, /WHERE packages\.status <> 'pending'/)
  assertContainsAll(
    block,
    ['needs_review', 'cancelled', 'openKeys', 'finalKeys', 'updated_open_packages', 'skipped_final'],
    'corrected open packages and final packages are not distinguished',
  )
})

test('resolve-items claims a mutable package before deleting its old items', () => {
  const block = actionBlock('resolve-items')
  const claimMatch = block.match(/SET status = '(?:resolving|processing)'/)
  const claim = claimMatch?.index ?? -1
  const deletion = block.indexOf('DELETE FROM return_package_items')
  assert.notEqual(claim, -1, 'resolve-items must claim the package')
  assert.notEqual(deletion, -1, 'replace mode must delete the old package items')
  assert.ok(claim < deletion, 'claim must happen before destructive item replacement')
  assert.match(
    block.slice(claim, deletion),
    /status\s*=\s*'needs_review'|status\s*=\s*\$\{pkg\.status\}|status\s+IN\s*\([^)]*pending[^)]*needs_review|status\s*=\s*ANY/,
  )
})

test('close, store reassignment, and SKU remap are Admin-only and reject final packages', () => {
  for (const action of ['close-package', 'reassign-store', 'remap-sku']) {
    const block = actionBlock(action)
    assert.match(block, /payload\.role !== 'admin'/, `${action} must be Admin-only`)
    assert.match(
      block,
      /isFinalReturnStatus|FINAL_RETURN_STATUSES|\['pending', 'needs_review'\]\.includes/,
      `${action} must reject final states`,
    )
    assert.match(block, /409/, `${action} must reject a stale/final mutation`)
  }
})

test('Admin Review list supports bounded pagination and server-side search', () => {
  const block = actionBlock('list')
  assertContainsAll(block, ['limit', 'offset'], 'list pagination is incomplete')
  assert.match(block, /search|query|ILIKE/i)
  assert.match(block, /has_more|next_offset/)
  assert.match(block, /Math\.min|LEAST|MAX_.*LIMIT|LIST_LIMIT/)
})

test('return Store choices come only from the canonical Analytics Store list', () => {
  const block = actionBlock('stores')
  assert.match(block, /keys AS \(\s*SELECT store_key FROM analytics_names\s*\)/)
  assert.doesNotMatch(
    block,
    /keys AS \([\s\S]*?SELECT store_key FROM (?:product_counts|order_counts)[\s\S]*?\)/,
    'catalog or order-only Store names must not become return routing choices',
  )
})

test('closed-without-inventory packages do not create false integrity failures', () => {
  const block = actionBlock('integrity')
  assert.match(
    block,
    /status IN \('received', 'discrepancy'\)[\s\S]*?active_transactions, 0\) <> 1/,
    'warehouse-confirmed returns must require exactly one inventory transaction',
  )
  assert.match(
    block,
    /status IN \('rejected', 'cancelled'\)[\s\S]*?active_transactions, 0\) > 1/,
    'Not Ours and cancelled packages may safely close without an inventory transaction',
  )
})

test('return UI exposes recovery controls instead of terminal error panels', () => {
  assertContainsAll(UI_SOURCE, [
    'Retry Stores',
    'Retry inventory choices',
    'Undo skip',
    'Cancel package',
    'Mark entire package Not Ours',
    'Search Admin Review',
    'Load more',
    'Keep identified products',
    'Replace from original PO',
    'Change Store',
  ], 'Missing return workflow recovery control')
})

test('manifest decisions are reversible before upload', () => {
  assertContainsAll(UI_SOURCE, [
    'undoManifestSkip',
    'editManifestStoreDecision',
    'editManifestTrackingDecision',
  ], 'Manifest decision cannot be corrected')
})

test('tracking lookup aborts or ignores stale responses', () => {
  assertContainsAll(UI_SOURCE, ['lookupRequestRef', 'AbortController'], 'Lookup request guard is incomplete')
  assert.match(UI_SOURCE, /requestId|request_id|sequence|lookupRequestRef\.current/)
  assert.match(UI_SOURCE, /abort\(\)/)
  assert.match(
    UI_SOURCE,
    /lookupRequestRef\.current[^\n]*(?:!==|===)[^\n]*request|request[^\n]*(?:!==|===)[^\n]*lookupRequestRef\.current/,
  )
})

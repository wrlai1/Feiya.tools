import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSkuReturnManifestRows } from '../src/utils/returnImportEngine.js'

test('an exact original-order snapshot overrides a conflicting current return catalog quantity', () => {
  const result = parseSkuReturnManifestRows([{
    '订单号 PO': 'PO-211-16248586977912511-D01',
    'SKU ID': '96082199654',
    '运单号 Tracking Number': '383043740250',
  }], [{
    store_name: 'Medley',
    store_key: 'medley',
    sku_id: '96082199654',
    sku_code: '5020055PeachSkin12',
    status: 'ready',
    components: [{ style: '5020055', color: 'PEACH SKIN', size: '12', qty: 2 }],
  }], [{
    order_number: 'PO-211-16248586977912511',
    store_name: 'Medley',
    store_key: 'medley',
    items: [{
      sku_id: '96082199654',
      sku_code: '5020055PeachSkin12',
      quantity: 1,
      catalog_status: 'ready',
      catalog_store_name: 'Medley',
      catalog_store_key: 'medley',
      catalog_components: [{ style: '5020055', color: 'PEACH SKIN', size: '12', qty: 1 }],
    }],
  }])

  assert.equal(result.needsReview.length, 0)
  assert.equal(result.packages[0].expectedUnits, 1)
  assert.deepEqual(result.packages[0].items, [{
    skuId: '96082199654',
    skuCode: '5020055PeachSkin12',
    style: '5020055',
    color: 'PEACH SKIN',
    size: '12',
    expectedQty: 1,
    sourceQty: 1,
  }])
})

import { resolveStyleName } from './styleNames.js'
import exportSizes from '../../lib/inventoryExportSizes.cjs'

const text = value => String(value ?? '').trim()
const norm = value => text(value).toUpperCase()
const sizeKey = value => norm(value).replace(/^([1-5])XL$/, '$1X')
export const receiptSkuKey = (style, color, size) => [norm(style), norm(color), sizeKey(size)].join('|')
export const sortReceiptRows = (a, b) => a.style.localeCompare(b.style, undefined, { numeric: true }) || a.color.localeCompare(b.color, undefined, { numeric: true }) || exportSizes.compareExportSizes(a.size, b.size)

export function parseInventoryReceiptRows(source, inventory, styleAliases = {}) {
  if (!Array.isArray(source) || source.length > 10000) throw new Error('请上传不超过 10000 行的入库模板')
  const read = (row, names) => {
    const keys = Object.keys(row).filter(key => names.includes(text(key).toLowerCase()))
    if (keys.length > 1) throw new Error('模板存在重复列，请保留一组款式、颜色、尺码、入库数量列')
    return keys.length ? row[keys[0]] : undefined
  }
  const styles = [...new Set(inventory.map(row => row.Style))]
  const known = new Map()
  for (const row of inventory) {
    const key = receiptSkuKey(row.Style, row.Color, row.Size)
    if (!known.has(key)) known.set(key, [])
    known.get(key).push(row)
  }
  const seen = new Set(), additions = []
  for (const [index, row] of source.entries()) {
    const rowNumber = Number.isInteger(row.__rowNum__) ? row.__rowNum__ + 1 : index + 2
    const value = read(row, ['received quantity', '入库数量', '本次入库数量'])
    if (value == null) throw new Error('缺少 Received Quantity（本次入库数量）列，请使用下载的模板')
    if (text(value) === '') continue
    const quantity = Number(value)
    if (!['string', 'number'].includes(typeof value) || !Number.isSafeInteger(quantity) || quantity < 0 || quantity > 2147483647) throw new Error(`Row ${rowNumber}: 入库数量必须是非负整数`)
    if (!quantity) continue
    const style = resolveStyleName(text(read(row, ['style', '款式', '款号'])), styleAliases)
    const color = text(read(row, ['color', '颜色']))
    const size = norm(read(row, ['size', '尺码']))
    const missing = [['款式', style], ['颜色', color], ['尺码', size]].filter(([, value]) => !value).map(([label]) => label)
    if (missing.length) throw new Error(`Row ${rowNumber}: 缺少${missing.join('、')}，请补充该行`)
    const candidates = styles.filter(candidate => norm(candidate) === norm(style))
    const chosen = styles.includes(style) ? style : candidates.length === 1 ? candidates[0] : null
    if (!chosen) throw new Error(`Row ${rowNumber}: 款式 ${style} ${candidates.length ? '对应多个库存款式，请使用完整款号' : '不存在于库存，请先添加该款式'}`)
    const matches = (known.get(receiptSkuKey(chosen, color, size)) || []).filter(item => item.Style === chosen)
    const exact = matches.filter(item => item.Color === color && item.Size === size)
    const current = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null
    if (matches.length && !current) throw new Error(`Row ${rowNumber}: 颜色和尺码对应多个库存行，请核对完整名称`)
    const sizes = [...new Set(inventory.filter(item => item.Style === chosen && sizeKey(item.Size) === sizeKey(size)).map(item => item.Size))].sort()
    if (!sizes.length) throw new Error(`Row ${rowNumber}: 尺码 ${size} 不属于款式 ${chosen}，请核对模板`)
    const sku = receiptSkuKey(chosen, color, size)
    if (seen.has(sku)) throw new Error(`Row ${rowNumber}: 款式、颜色和尺码重复`)
    seen.add(sku)
    additions.push({ id: current?.id ?? null, style: current?.Style || chosen, color: current?.Color || color, size: current?.Size || sizes[0], quantity, current: current ? current.RawQuantity ?? current.Quantity : 0, isNew: !current })
  }
  if (!additions.length) throw new Error('请在 Received Quantity 栏填写本次入库数量')
  if (additions.reduce((sum, row) => sum + row.quantity, 0) > 2147483647) throw new Error('本次入库总量超出库存数量限制')
  return additions.sort(sortReceiptRows)
}

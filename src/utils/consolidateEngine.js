/**
 * Consolidate engine — 把原始订单导出（Style + Quantity 两列）合并成
 * (style, color, size, QTY) 的 consolidated 表。移植自 consolidate_skus.py，
 * 并修复：前导零才扩展、补齐 2/4/18-24/R 尺码、纯数字尺码守卫、W 码归大码、
 * 数量列别名。
 *
 * consolidateRows(rows) → { consolidated, needsReview, stats }
 */

// 长后缀优先：PXL 先于 XL，14W 先于 14，10P 先于 10。
const SIZE_SUFFIXES = [
  '24W', '22W', '20W', '18W', '16W', '14W',
  '16P', '14P', '12P', '10P', '8P', '6P',
  '16R', '14R', '12R', '10R', '8R', '6R',
  'PXL', 'PL', 'PM', 'PS',
  '3XL', '2XL', '1XL', 'XXL', 'XL', 'XXS', 'XS',
  '3X', '2X', '1X',
  '24', '22', '20', '18', '16', '14', '12', '10', '8', '6', '4', '2',
  'L', 'M', 'S',
].sort((a, b) => b.length - a.length)

const PLUS_SIZES = new Set(['1X', '2X', '3X', '1XL', '2XL', '3XL', 'XXL'])

// 直接映射（在任何扩展之前检查）
const STYLE_NORMALIZE = {
  '0070': '5020070',
  '50070': '5020070',
  '50077': '5010077',
  '70015': '5010015-PLUS',
  '5010071': '5020071',
  '7010015': '5010015-PLUS',
  '5010109': 'M022 Missy',
  '7010109': 'M022 PLUS',
  '11006': '1106',
  '5020077': '5010077',
  '5028766': '8766',
  '6026015': '6015',
}

// TEMU petite labels run one size larger than the physical inventory labels.
const IMPORT_SIZE_NORMALIZE = { PS: 'PS', PM: 'PS', PL: 'PM', PXL: 'PL' }

function normalizeImportedSize(size) {
  const raw = String(size || '').trim()
  return IMPORT_SIZE_NORMALIZE[raw.toUpperCase()] || raw
}

// 真实的 4 位款号，绝不扩展（前导零规则外的双保险）
const NO_EXPAND_STYLES = new Set(['8766', '6015', '1542', '1106'])

// 款号本身带尾字母的（字母不属于颜色）
const KNOWN_STYLE_OVERRIDES = ['853106X']

// 款号别名：前缀编码了剪裁款型 → (标准款号, 颜色前缀)
const STYLE_ALIAS_WITH_COLOR_PREFIX = {
  NS95401: ['95401', 'Short'],
  N95401: ['95401', 'Capri'],
}

// set 行展开：一行套装 → 每个颜色一行（同尺码同数量）
const SET_EXPANSIONS = {
  53058: { set: ['white', 'mid denim', 'light denim'] },
}

function expandStyleBySize(style, size) {
  // 只扩展**前导零**的 4 位款号（0055/0066/0069…）。1542、8766 这类真实
  // 4 位款号不能碰 —— 无条件扩展是老版本的 bug。
  if (!/^0\d{3}$/.test(style)) return style
  if (NO_EXPAND_STYLES.has(style)) return style
  const su = size.toUpperCase()
  let prefix = '5'                                   // Missy
  if (su.includes('P')) prefix = '6'                 // Petite
  else if (PLUS_SIZES.has(su) || /\dW$/.test(su)) prefix = '7'  // Plus（W 码也是大码）
  return prefix + '02' + style
}

function resolveStyle(style, size) {
  if (STYLE_NORMALIZE[style]) return STYLE_NORMALIZE[style]
  return expandStyleBySize(style, size)
}

export function parseStyleColorSize(raw) {
  const s = String(raw ?? '').trim()

  let style = ''
  let rest = s
  const known = KNOWN_STYLE_OVERRIDES
    .slice().sort((a, b) => b.length - a.length)
    .find((k) => s.toUpperCase().startsWith(k.toUpperCase()))
  if (known) {
    style = s.slice(0, known.length)
    rest = s.slice(known.length).trim()
  } else {
    const m = s.match(/^([A-Za-z]*\d+)(.*)$/)
    if (!m) return { style: '', color: s, size: '', issue: 'no_leading_digits' }
    style = m[1]
    rest = m[2].trim()
  }

  // "gingham size 10" → "gingham 10"
  rest = rest.replace(/\bsize\s+(\d+)\b/gi, '$1').trim()

  let size = ''
  let color = rest
  for (const suf of SIZE_SUFFIXES) {
    if (!rest.toUpperCase().endsWith(suf.toUpperCase())) continue
    // 纯数字尺码守卫：前一个字符必须是字母或空格，防止吃掉颜色里的数字
    // （如 "DarkDenim#2" 的 2、"denim2" 会匹配，但 "#2" 不会）。
    if (/^\d+$/.test(suf)) {
      const before = rest[rest.length - suf.length - 1]
      if (before !== undefined && !/[A-Za-z\s]/.test(before)) continue
    }
    size = rest.slice(rest.length - suf.length)
    color = rest.slice(0, rest.length - suf.length)
    break
  }

  color = color.trim().toLowerCase()

  const issues = []
  if (rest === '') issues.push('missing_color_size')
  if (size === '') issues.push('no_size_suffix_match')
  if (color === '' && size !== '') issues.push('empty_color')

  return { style, color, size, issue: issues.join(';') }
}

/** 找列名（大小写不敏感 + 别名） */
function findKey(row, target, aliases = []) {
  const keys = Object.keys(row)
  const wanted = [target, ...aliases].map((x) => x.toLowerCase())
  return keys.find((k) => wanted.includes(k.trim().toLowerCase()))
}

/**
 * rows: 解析好的对象数组（须含 Style/SKU 列 + Quantity/Qty/数量 列）
 */
export function consolidateRows(rows) {
  if (!rows.length) throw new Error('文件是空的')
  const styleKey = findKey(rows[0], 'Style', ['SKU', 'SKU货号'])
  const qtyKey = findKey(rows[0], 'Quantity', ['Qty', 'QTY', '数量', '件数', '应履约件数'])
  if (!styleKey) throw new Error('找不到 Style/SKU 列')
  if (!qtyKey) throw new Error('找不到 Quantity/Qty/数量 列')

  const origTotal = rows.reduce((s, r) => s + (Number(r[qtyKey]) || 0), 0)

  // 解析每一行
  let parsed = rows.map((r) => {
    const rawStyle = String(r[styleKey] ?? '').trim()
    const qty = Number(r[qtyKey]) || 0
    const p = parseStyleColorSize(rawStyle)
    return { rawStyle, qty, ...p }
  })

  // 别名款号：改款号 + 颜色加前缀
  for (const [alias, [normStyle, colorPrefix]] of Object.entries(STYLE_ALIAS_WITH_COLOR_PREFIX)) {
    for (const p of parsed) {
      if (p.style.toUpperCase() === alias.toUpperCase()) {
        p.color = `${colorPrefix} ${p.color}`.trim().toLowerCase()
        p.style = normStyle
      }
    }
  }

  // 95401 特殊处理：short/capri 从颜色挪进款号；结尾 gh → gingham
  for (const p of parsed) {
    if (p.style.toUpperCase() === '95401') {
      for (const cut of ['short', 'capri']) {
        if (p.color.startsWith(cut)) {
          p.style = '95401' + cut
          p.color = p.color.slice(cut.length).trim()
          break
        }
      }
    }
    if (p.style.toLowerCase().startsWith('95401')) {
      p.color = p.color.replace(/gh$/, 'gingham')
    }
  }

  // 款号归一化/扩展
  for (const p of parsed) {
    p.size = normalizeImportedSize(p.size)
    p.style = resolveStyle(p.style, p.size)
  }

  // set 展开
  const expanded = []
  for (const p of parsed) {
    const map = SET_EXPANSIONS[p.style]
    const colors = map && map[p.color.trim().toLowerCase()]
    if (colors) {
      for (const color of colors) expanded.push({ ...p, color, issue: '' })
    } else {
      expanded.push(p)
    }
  }
  parsed = expanded

  // 合并：按 (style,color,size) 汇总
  const groups = new Map()
  for (const p of parsed) {
    const k = `${p.style}||${p.color}||${p.size}`
    const g = groups.get(k) || { style: p.style, color: p.color, size: p.size, QTY: 0 }
    g.QTY += p.qty
    groups.set(k, g)
  }
  const consolidated = [...groups.values()].sort((a, b) => {
    const na = Number(a.style), nb = Number(b.style)
    const sa = Number.isFinite(na) ? na : 1e12, sb = Number.isFinite(nb) ? nb : 1e12
    return sa - sb || a.color.localeCompare(b.color) || a.size.localeCompare(b.size)
  })

  // needs review：带 issue 的行，按 (rawStyle, style, color, size, issue) 汇总
  const reviewMap = new Map()
  for (const p of parsed) {
    if (!p.issue) continue
    const k = `${p.rawStyle}||${p.style}||${p.color}||${p.size}||${p.issue}`
    const g = reviewMap.get(k) || { raw_style: p.rawStyle, style: p.style, color: p.color, size: p.size, parse_issue: p.issue, QTY: 0 }
    g.QTY += p.qty
    reviewMap.set(k, g)
  }
  const needsReview = [...reviewMap.values()]
    .sort((a, b) => a.parse_issue.localeCompare(b.parse_issue) || a.raw_style.localeCompare(b.raw_style))

  const newTotal = consolidated.reduce((s, r) => s + r.QTY, 0)
  const expandedTotal = parsed.reduce((s, r) => s + r.qty, 0)

  return {
    consolidated,
    needsReview,
    stats: {
      origRows: rows.length,
      origTotal,
      expandedTotal,
      newTotal,
      qtyOk: Math.abs(expandedTotal - newTotal) < 1e-9,
      reviewRows: needsReview.length,
    },
  }
}

/** 简单 CSV 序列化（带引号转义） */
export function toCSV(rows, headers) {
  const q = (v) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [headers.join(','), ...rows.map((r) => headers.map((h) => q(r[h])).join(','))].join('\n')
}

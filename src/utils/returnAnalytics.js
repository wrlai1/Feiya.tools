const REASON_CATEGORIES = {
  too_big_long: { label: 'Too big / too long', labelZh: '太大 / 太长' },
  too_small_short: { label: 'Too small / too short', labelZh: '太小 / 太短' },
  fit_other: { label: 'Other fit issue', labelZh: '其他不合身' },
  quality_damage: { label: 'Quality / damage', labelZh: '质量 / 破损' },
  wrong_item: { label: 'Wrong item', labelZh: '发错商品' },
  appearance_material: { label: 'Color / appearance / material', labelZh: '颜色 / 外观 / 材质' },
  changed_mind: { label: 'Did not like / changed mind', labelZh: '不喜欢 / 改变主意' },
  delivery: { label: 'Delivery issue', labelZh: '物流问题' },
  mixed: { label: 'Multiple reasons', labelZh: '多个原因' },
  other: { label: 'Other stated reason', labelZh: '其他已填原因' },
  not_provided: { label: 'Reason not provided', labelZh: '未填原因' },
}

function cleanReasonValues(values) {
  const list = Array.isArray(values) ? values : [values]
  return [...new Set(list.map((value) => String(value || '').trim()).filter(Boolean))]
}

function classifyReasonText(value) {
  const text = String(value || '').trim().toLowerCase()
  if (!text) return ''
  if (/(太大|太长|过大|过长|偏大|偏长|宽松|腰围大|裤腿长|too\s*(big|large|long)|oversiz|loose|demasiado\s*(grande|larg)|muy\s*(grande|larg))/.test(text)) {
    return 'too_big_long'
  }
  if (/(太小|太短|过小|过短|偏小|偏短|紧身|太紧|过紧|too\s*(small|short|tight)|demasiado\s*(peque|cort|ajust)|muy\s*(peque|cort|ajust))/.test(text)) {
    return 'too_small_short'
  }
  if (/(不合身|尺码不合适|版型不合适|does(?:n't| not)\s*fit|did(?:n't| not)\s*fit|fit\s*issue|no\s*queda\s*bien)/.test(text)) {
    return 'fit_other'
  }
  if (/(质量|破损|损坏|瑕疵|开线|脱线|拉链|污渍|掉色|破洞|damage|defect|quality|broken|stain|hole|zipper|damaged|defectuos)/.test(text)) {
    return 'quality_damage'
  }
  if (/(发错|错货|错误商品|不是我买|wrong\s*item|incorrect\s*item|producto\s*(equivocado|incorrecto))/.test(text)) {
    return 'wrong_item'
  }
  if (/(色差|颜色|图片|描述不符|材质|面料|透明|color|colour|photo|picture|description|fabric|material|imagen|descripci)/.test(text)) {
    return 'appearance_material'
  }
  if (/(不喜欢|不想要|改变主意|不需要|don't\s*like|did\s*not\s*like|changed\s*mind|no\s*me\s*gusta)/.test(text)) {
    return 'changed_mind'
  }
  if (/(晚到|延迟|物流|运输|delivery|shipping|arrived\s*late|entrega|env[ií]o)/.test(text)) {
    return 'delivery'
  }
  return 'other'
}

export function categorizeReturnReason(returnReasons, buyerRemarks) {
  const reasons = cleanReasonValues(returnReasons)
  const remarks = cleanReasonValues(buyerRemarks)
  if (!reasons.length && !remarks.length) return 'not_provided'

  const statedCategories = new Set(reasons.map(classifyReasonText).filter(Boolean))
  const specificStated = [...statedCategories].filter((category) => category !== 'other')
  if (specificStated.length === 1 && specificStated[0] !== 'fit_other') return specificStated[0]
  if (specificStated.length > 1) return 'mixed'

  const detailCategories = new Set(remarks.map(classifyReasonText).filter(Boolean))
  const specificDetails = [...detailCategories].filter((category) => category !== 'other')
  if (specificDetails.length === 1) return specificDetails[0]
  if (specificDetails.length > 1) return 'mixed'
  if (specificStated.length === 1) return specificStated[0]
  return 'other'
}

export function summarizeReturnReasonEvents(events) {
  const groups = new Map()
  let attributedQty = 0
  const addReason = (quantity, reasons, remarks) => {
    if (!Number.isFinite(quantity) || quantity <= 0) return
    const category = categorizeReturnReason(reasons, remarks)
    const current = groups.get(category) || { category, quantity: 0, examples: [] }
    current.quantity += quantity
    for (const example of [...reasons, ...remarks]) {
      if (!current.examples.includes(example) && current.examples.length < 3) {
        current.examples.push(example)
      }
    }
    groups.set(category, current)
    attributedQty += quantity
  }
  for (const event of Array.isArray(events) ? events : []) {
    const reasonDetails = Array.isArray(event?.reason_details)
      ? event.reason_details
      : Array.isArray(event?.reasonDetails) ? event.reasonDetails : []
    if (reasonDetails.length) {
      for (const detail of reasonDetails) {
        addReason(
          Number(detail.quantity || 0),
          cleanReasonValues(detail.return_reason ?? detail.returnReason),
          cleanReasonValues(detail.buyer_remark ?? detail.buyerRemark),
        )
      }
      continue
    }
    const quantity = Number(event?.returned_qty ?? event?.returnedQty ?? 0)
    const reasons = cleanReasonValues(event.return_reasons ?? event.returnReasons)
    const remarks = cleanReasonValues(event.buyer_remarks ?? event.buyerRemarks)
    addReason(quantity, reasons, remarks)
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      label: REASON_CATEGORIES[group.category]?.label || REASON_CATEGORIES.other.label,
      label_zh: REASON_CATEGORIES[group.category]?.labelZh || REASON_CATEGORIES.other.labelZh,
      share: attributedQty > 0 ? Number((group.quantity * 100 / attributedQty).toFixed(2)) : 0,
    }))
    .sort((left, right) => right.quantity - left.quantity || left.label.localeCompare(right.label))
}

export function enrichProductSkuReasonAnalytics(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const returnedQty = Number(row.returned_qty || 0)
    const attributedQty = Number(row.reason_attributed_qty || 0)
    const reasonBreakdown = summarizeReturnReasonEvents(row.reason_events)
    const { reason_events: reasonEvents, ...safeRow } = row
    return {
      ...safeRow,
      reason_breakdown: reasonBreakdown,
      reason_coverage_pct: returnedQty > 0
        ? Number((Math.min(attributedQty, returnedQty) * 100 / returnedQty).toFixed(2))
        : null,
      reason_unattributed_qty: Math.max(returnedQty - attributedQty, 0),
    }
  })
}

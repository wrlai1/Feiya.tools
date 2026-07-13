function number(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function count(value) {
  return Math.round(number(value)).toLocaleString('en-US')
}

function money(value) {
  return '$' + number(value).toLocaleString('en-US', { maximumFractionDigits: 0 })
}

function pct(value) {
  return (number(value) * 100).toFixed(1) + '%'
}

function ratio(value) {
  return number(value).toFixed(2) + 'x'
}

function normalizedKey(value) {
  return String(value || '').trim().toLowerCase()
}

function median(values) {
  const sorted = values.map(number).sort((a, b) => a - b)
  if (!sorted.length) return 0
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function downgradeConfidence(value) {
  if (value === 'high') return 'medium'
  return 'low'
}

function productConfidence(product, settings, dataComplete) {
  const enoughImpressions = number(product.impressions) >= number(settings.minImpressions)
  const enoughClicks = number(product.clicks) >= number(settings.minClicks)
  let level = enoughImpressions && enoughClicks ? 'high' : enoughImpressions || enoughClicks ? 'medium' : 'low'
  if (!dataComplete) level = downgradeConfidence(level)
  if (product.isNewProduct && level !== 'low') level = downgradeConfidence(level)
  const reasons = [enoughImpressions && enoughClicks
    ? `已有 ${count(product.impressions)} 曝光和 ${count(product.clicks)} 点击，样本足够判断。`
    : enoughImpressions || enoughClicks
      ? `已有 ${count(product.impressions)} 曝光和 ${count(product.clicks)} 点击，方向可判断但仍需复查。`
      : `只有 ${count(product.impressions)} 曝光和 ${count(product.clicks)} 点击，样本不足以确认根因。`]
  if (!dataComplete) reasons.push('当前范围有缺失日期，可信度已降低一级。')
  if (product.isNewProduct) reasons.push('这是新品，历史基准较少，可信度已降低一级。')
  return { level, reason: reasons.join(' ') }
}

function productMetrics(product, previous, peer, bestOtherStore) {
  const metrics = [
    ['Units', count(product.units)],
    ['Impressions', count(product.impressions)],
    ['Clicks', count(product.clicks)],
    ['CTR', pct(product.ctr)],
    ['Cart rate', pct(product.cartRate)],
    ['CVR', pct(product.conversionRate)],
    ['Spend', money(product.spend)],
    ['ROAS', ratio(product.roas)],
  ]
  if (previous) metrics.push(['Previous units', count(previous.units)])
  if (peer?.units) metrics.push(['Store median units', count(peer.units)])
  if (bestOtherStore) metrics.push([`${bestOtherStore.store} units`, count(bestOtherStore.units)])
  if (product.frontPrice != null) metrics.push(['Front price', money(product.frontPrice)])
  if (product.couponPrice != null) metrics.push(['Coupon price', money(product.couponPrice)])
  if (product.grossMargin != null) metrics.push(['Gross margin', pct(product.grossMargin)])
  if (product.isNewProduct) metrics.push(['Lifecycle', 'New product'])
  return metrics
}

function periodComparison(product, previous) {
  if (!previous || number(previous.units) <= 0) return null
  const unitsChange = (number(product.units) - number(previous.units)) / number(previous.units)
  return {
    unitsChange,
    unitsText: `${count(previous.units)} -> ${count(product.units)} units (${unitsChange >= 0 ? '+' : ''}${(unitsChange * 100).toFixed(0)}%)`,
    factors: [
      { key: 'impressions', label: '曝光', ratio: number(previous.impressions) ? number(product.impressions) / number(previous.impressions) : 1 },
      { key: 'ctr', label: 'CTR', ratio: number(previous.ctr) ? number(product.ctr) / number(previous.ctr) : 1 },
      { key: 'conversion', label: 'CVR', ratio: number(previous.conversionRate) ? number(product.conversionRate) / number(previous.conversionRate) : 1 },
    ].sort((a, b) => a.ratio - b.ratio),
  }
}

function crossStoreContext(product, crossStoreProducts, activeStore) {
  const productSpu = normalizedKey(product.spu)
  const currentStore = normalizedKey(activeStore)
  const matches = (crossStoreProducts || [])
    .filter((row) => normalizedKey(row.spu) === productSpu && normalizedKey(row.store) !== currentStore)
    .sort((a, b) => number(b.units) - number(a.units))
  const best = matches[0] || null
  const materiallyBetter = best && number(best.units) >= Math.max(number(product.units) * 1.5, number(product.units) + 2)
  return { best, materiallyBetter, matches }
}

function decisionBase(product, previous, peer, crossStore, settings, dataComplete, previousDataComplete) {
  const confidence = productConfidence(product, settings, dataComplete)
  const comparison = dataComplete && previousDataComplete ? periodComparison(product, previous) : null
  const label = product.sku || product.spu
  const evidence = []
  if (comparison) evidence.push(`前一周期对比：${comparison.unitsText}`)
  if (peer?.units) evidence.push(`店内款式中位数为 ${count(peer.units)} units，当前为 ${count(product.units)}。`)
  if (crossStore.materiallyBetter) {
    evidence.push(`同SPU在 ${crossStore.best.store} 销售 ${count(crossStore.best.units)} units，当前店铺为 ${count(product.units)}。`)
  }
  return {
    product: { spu: product.spu, sku: product.sku, label, productName: product.productName },
    confidence,
    comparison,
    evidence,
    metrics: productMetrics(product, previous, peer, crossStore.best),
    possibleCauses: [],
    priority: 0,
    estimateUnits: null,
  }
}

function reviewThreshold(product, settings) {
  const remainingImpressions = Math.max(0, number(settings.minImpressions) - number(product.impressions))
  const remainingClicks = Math.max(0, number(settings.minClicks) - number(product.clicks))
  if (remainingImpressions > 0 && remainingClicks > 0) {
    return `累计再获得 ${count(remainingImpressions)} 曝光或 ${count(remainingClicks)} 点击后重新判断。`
  }
  return `只改一项，观察2天或新增 ${count(settings.minClicks)} 点击后复查。`
}

function estimatedLostUnits(product, settings) {
  const orderUnits = number(product.orders) > 0 ? number(product.units) / number(product.orders) : 1
  const clickGap = Math.max(0, number(settings.ctrTarget) - number(product.ctr)) * number(product.impressions)
  const conversion = Math.max(number(product.conversionRate), number(settings.conversionTarget))
  return Math.round(clickGap * conversion * orderUnits)
}

function finalizeProductDecision(item, crossStore) {
  if (crossStore.materiallyBetter) {
    item.priority += 25
    item.possibleCauses.push(`当前店铺执行差异：同SPU在 ${crossStore.best.store} 表现明显更好`)
  }
  return item
}

function buildProductDecision(product, context) {
  const { previous, peer, crossStore, settings, dataComplete, previousDataComplete } = context
  const item = decisionBase(product, previous, peer, crossStore, settings, dataComplete, previousDataComplete)
  const impressions = number(product.impressions)
  const clicks = number(product.clicks)
  const orders = number(product.orders)
  const spend = number(product.spend)
  const units = number(product.units)
  const ctr = number(product.ctr)
  const cartRate = number(product.cartRate)
  const cvr = number(product.conversionRate)
  const roas = number(product.roas)
  const enoughImpressions = impressions >= number(settings.minImpressions)
  const enoughClicks = clicks >= number(settings.minClicks)
  const lowSales = units < number(settings.targetUnits)
  const periodDrop = item.comparison && item.comparison.unitsChange <= -0.3 && number(previous?.units) >= number(settings.targetUnits)
  const biggestDrop = periodDrop ? item.comparison.factors[0] : null

  if (spend >= number(settings.stopLossSpend) && orders === 0) {
    item.type = 'spend-no-order'
    item.severity = 'bad'
    item.decision = '先降预算，停止继续放量'
    item.cause = enoughImpressions && ctr < number(settings.ctrTarget)
      ? '花费已经达到止损线，问题首先出现在点击阶段：有曝光，但用户点击意愿不足。'
      : enoughClicks && cartRate < number(settings.cartRateTarget)
        ? '花费已经达到止损线，点击样本足够，但进入页面后加购不足。'
        : enoughClicks
          ? '花费已经达到止损线，点击样本足够但没有成交，问题更可能在价格或成交条件。'
          : '花费已经达到止损线但点击样本仍少，当前流量效率不足，不能继续无上限测试。'
    item.possibleCauses = enoughImpressions && ctr < number(settings.ctrTarget)
      ? ['主图或标题吸引力不足', '价格在曝光位置缺乏竞争力', '流量人群不够精准']
      : ['最终价格或Coupon不足', '详情页没有承接点击预期', '评价、运费、交期或尺码颜色影响成交']
    item.action = '把预算降回测试水平；根据漏斗最先掉下来的环节，只修改一项。'
    item.avoid = '不要一边提高预算，一边同时修改主图、价格和页面。'
    item.review = reviewThreshold(product, settings)
    item.priority = 400 + spend / Math.max(1, number(settings.stopLossSpend)) * 20
    return finalizeProductDecision(item, crossStore)
  }

  if (periodDrop && biggestDrop?.ratio < 0.8) {
    item.type = `period-drop-${biggestDrop.key}`
    item.severity = biggestDrop.ratio < 0.5 ? 'bad' : 'warn'
    if (biggestDrop.key === 'impressions') {
      item.decision = '先恢复有效曝光'
      item.cause = `销量比前一周期下降，三个漏斗因素中曝光降幅最大，主要问题发生在流量入口。`
      item.possibleCauses = ['预算或投放量减少', '排名或自然流量下降', '活动结束或流量分配变化']
      item.action = cvr >= number(settings.conversionTarget) ? '保持页面和价格稳定，小幅恢复有效流量。' : '先确认流量下降原因，不要在转化未验证前大幅加预算。'
      item.avoid = '不要因为销量下降就立刻降价，当前证据首先指向曝光变化。'
    } else if (biggestDrop.key === 'ctr') {
      item.decision = '先测试主图和标题'
      item.cause = '销量下降时曝光相对稳定，但CTR降幅最大，问题主要发生在点击之前。'
      item.possibleCauses = ['主图吸引力下降', '标题与流量关键词不匹配', '竞品价格或视觉优势增强']
      item.action = '保持预算和最终价格稳定，优先测试一版主图或标题。'
      item.avoid = '不要同时更改价格，否则无法确认CTR变化来自素材还是价格。'
      item.estimateUnits = estimatedLostUnits(product, settings)
    } else {
      item.decision = '先检查价格和成交条件'
      item.cause = '曝光和点击仍在，但CVR降幅最大，销量损失主要发生在点击之后。'
      item.possibleCauses = ['最终价格或Coupon变化', '详情页、评价或商品承接变弱', '运费、交期、尺码颜色或库存影响下单']
      item.action = '先核对下降前后的售价、Coupon和页面状态，再选择一个变量调整。'
      item.avoid = '不要先增加流量，当前点击后的成交效率正在下降。'
    }
    item.review = '保持其他变量不变，观察2天并与前一周期同口径复查。'
    item.priority = 300 + Math.abs(item.comparison.unitsChange) * 50 + spend
    return finalizeProductDecision(item, crossStore)
  }

  if (enoughImpressions && ctr < number(settings.ctrTarget)) {
    item.type = 'low-ctr'
    item.severity = spend >= number(settings.stopLossSpend) * 0.6 ? 'bad' : 'warn'
    item.decision = '先测试主图和标题'
    item.cause = `曝光已经足够，但CTR ${pct(ctr)}低于目标 ${pct(settings.ctrTarget)}，销量损失首先发生在点击之前。`
    item.possibleCauses = ['主图或标题吸引力不足', '价格展示缺乏竞争力', '流量关键词与商品不匹配']
    item.action = '保持预算、详情页和最终价格稳定，只测试一版主图或标题。'
    item.avoid = '不要同时修改价格和页面，避免无法判断是哪项带来变化。'
    item.review = reviewThreshold(product, settings)
    item.estimateUnits = estimatedLostUnits(product, settings)
    item.priority = 260 + impressions / Math.max(1, number(settings.minImpressions)) * 10 + spend
    return finalizeProductDecision(item, crossStore)
  }

  if (enoughClicks && cartRate < number(settings.cartRateTarget)) {
    item.type = 'low-cart'
    item.severity = 'warn'
    item.decision = '先检查价格展示与详情页'
    item.cause = `点击样本已经足够，但加购率 ${pct(cartRate)}低于目标 ${pct(settings.cartRateTarget)}，用户点进来后兴趣没有继续。`
    item.possibleCauses = ['广告承诺与详情页不一致', '价格或卖点不足', '商品图、尺码或描述没有解决购买疑问']
    item.action = '对照高转化款，先检查首屏价格、卖点、图片和尺码信息。'
    item.avoid = '不要先扩大流量，当前页面还没有有效承接现有点击。'
    item.review = reviewThreshold(product, settings)
    item.priority = 240 + clicks / Math.max(1, number(settings.minClicks)) * 10 + spend
    return finalizeProductDecision(item, crossStore)
  }

  if (enoughClicks && cartRate >= number(settings.cartRateTarget) && cvr < number(settings.conversionTarget)) {
    item.type = 'cart-no-order'
    item.severity = 'bad'
    item.decision = '先检查最终价格、Coupon和成交条件'
    item.cause = `加购率 ${pct(cartRate)}已达标，但CVR只有 ${pct(cvr)}，用户有兴趣却没有完成付款。`
    item.possibleCauses = ['Coupon后价格不够有吸引力', '运费、交期或结账条件影响付款', '尺码颜色、库存或评价造成犹豫']
    item.action = '核对最终成交价、Coupon、运费和可售选项，优先修复一个明确阻力。'
    item.avoid = '不要优先换主图，用户已经点击并加购，问题发生在更后面。'
    item.review = reviewThreshold(product, settings)
    item.priority = 280 + clicks / Math.max(1, number(settings.minClicks)) * 10 + spend
    return finalizeProductDecision(item, crossStore)
  }

  if (orders > 0 && spend > 0 && roas < number(settings.roasTarget) * 0.6) {
    item.type = 'low-roas'
    item.severity = 'bad'
    item.decision = '降低低效预算，先保住利润'
    item.cause = `已经有订单，但ROAS ${ratio(roas)}明显低于目标 ${ratio(settings.roasTarget)}，当前问题是获客成本而不是完全卖不动。`
    item.possibleCauses = ['流量成本过高', '客单价或Unit数量不足', '低效流量占比过高', '毛利无法覆盖当前获客成本']
    item.action = '保留能成交的流量，先削减低效预算，并核对价格、Unit数量和毛利空间。'
    item.avoid = '不要整款直接停掉，也不要平均降低所有流量。'
    item.review = '调整预算后观察2天，确认ROAS改善且订单没有同步大幅下降。'
    item.priority = 320 + spend
    return finalizeProductDecision(item, crossStore)
  }

  const trafficBenchmark = Math.max(number(settings.minImpressions), number(peer?.impressions) * 0.6)
  if (lowSales && impressions < trafficBenchmark && cvr >= number(settings.conversionTarget)) {
    item.type = 'low-traffic'
    item.severity = 'watch'
    item.decision = '小幅增加曝光测试'
    item.cause = `点击后的CVR ${pct(cvr)}达到目标，但曝光只有 ${count(impressions)}，更像是缺少流量而不是页面卖不动。`
    item.possibleCauses = ['预算或流量分配不足', '自然排名较低', '新品仍在积累曝光']
    item.action = '保持素材、价格和页面不变，小幅增加有效曝光。'
    item.avoid = '不要在转化正常时同时改主图和价格。'
    item.review = reviewThreshold(product, settings)
    item.priority = 170 + cvr * 100
    return finalizeProductDecision(item, crossStore)
  }

  if (lowSales && (!enoughImpressions || !enoughClicks)) {
    item.type = 'insufficient-data'
    item.severity = 'watch'
    item.decision = '继续观察，暂不修改'
    item.cause = `销量偏低，但曝光或点击还没达到判断量，现阶段无法可靠区分流量、素材和转化问题。`
    item.possibleCauses = ['样本量不足', '新品仍在冷启动', '当前日期范围过短']
    item.action = '保持主要变量不变，先积累到最低曝光或点击判断量。'
    item.avoid = '不要因为少量数据频繁改图、改价或停掉产品。'
    item.review = reviewThreshold(product, settings)
    item.priority = 80 + spend
    return finalizeProductDecision(item, crossStore)
  }

  return null
}

export function buildSmartDecisions({
  products = [],
  previousProducts = [],
  crossStoreProducts = [],
  activeStore = '',
  missingDays = [],
  previousMissingDays = null,
  totals = {},
  trends = [],
  settings = {},
}) {
  const previousMap = new Map(previousProducts.map((product) => [normalizedKey(product.spu), product]))
  const peer = {
    units: median(products.map((product) => product.units)),
    impressions: median(products.map((product) => product.impressions)),
    ctr: median(products.map((product) => product.ctr)),
    conversionRate: median(products.map((product) => product.conversionRate)),
  }
  const dataComplete = missingDays.length === 0
  const previousDataComplete = Array.isArray(previousMissingDays) && previousMissingDays.length === 0
  const productItems = products
    .map((product) => buildProductDecision(product, {
      previous: previousMap.get(normalizedKey(product.spu)),
      peer,
      crossStore: crossStoreContext(product, crossStoreProducts, activeStore),
      settings,
      dataComplete,
      previousDataComplete,
    }))
    .filter(Boolean)

  const items = []
  if (missingDays.length || previousMissingDays?.length) {
    const missingParts = []
    if (missingDays.length) missingParts.push(`当前周期 ${missingDays.length} 天`)
    if (previousMissingDays?.length) missingParts.push(`前一周期 ${previousMissingDays.length} 天`)
    const missingExamples = [...missingDays, ...(previousMissingDays || [])]
    items.push({
      type: 'missing-data',
      severity: 'warn',
      decision: '先补齐数据，再调整商品',
      title: `${missingParts.join('、')}没有上传数据`,
      cause: `缺少 ${missingExamples.slice(0, 6).join(', ')}${missingExamples.length > 6 ? ' 等日期' : ''}，趋势和周期比较可能被低估。`,
      confidence: { level: 'low', reason: '当前周期不完整时会降低产品判断可信度；前一周期不完整时不会使用历史下降判断。' },
      evidence: missingParts.map((part) => `${part}缺失。`),
      possibleCauses: ['尚未上传当日数据', '店铺更新日期不同步'],
      action: '先上传缺失日期，再重新查看 Smart Decision。',
      avoid: '不要根据不完整周期大幅改预算或停款。',
      review: '数据补齐后系统会自动重新计算。',
      daily: missingExamples.slice(0, 10).map((day) => ({ day, status: 'Missing' })),
      priority: 1000000,
    })
  }

  items.push(...productItems.sort((a, b) => b.priority - a.priority))

  const sortedTrends = [...trends].sort((a, b) => String(a.day).localeCompare(String(b.day)))
  const last = sortedTrends.at(-1)
  const previousDay = sortedTrends.at(-2)
  if (last && previousDay && number(previousDay.units) > 0 && number(last.units) < number(previousDay.units) * 0.6) {
    const factors = [
      ['曝光', number(previousDay.impressions) ? number(last.impressions) / number(previousDay.impressions) : 1],
      ['CTR', number(previousDay.ctr) ? number(last.ctr) / number(previousDay.ctr) : 1],
      ['CVR', number(previousDay.conversionRate) ? number(last.conversionRate) / number(previousDay.conversionRate) : 1],
    ].sort((a, b) => a[1] - b[1])
    items.push({
      type: 'store-daily-drop',
      severity: 'warn',
      decision: `先检查全店${factors[0][0]}变化`,
      title: `${last.day} 全店销量明显下降`,
      cause: `${count(previousDay.units)} -> ${count(last.units)} units，${factors[0][0]}是漏斗中降幅最大的因素。`,
      confidence: { level: dataComplete ? 'medium' : 'low', reason: dataComplete ? '基于连续两天同口径数据，需要再观察一天确认。' : '当前范围有缺失日期。' },
      evidence: [`曝光 ${count(previousDay.impressions)} -> ${count(last.impressions)}`, `CTR ${pct(previousDay.ctr)} -> ${pct(last.ctr)}`, `CVR ${pct(previousDay.conversionRate)} -> ${pct(last.conversionRate)}`],
      action: '先确认当天是否有预算、活动、价格或流量变化，再定位受影响最大的SPU。',
      avoid: '不要对所有商品统一降价或停投。',
      review: '查看下一天数据是否恢复，并在SPU Focus确认主要拖累款。',
      daily: [previousDay, last],
      priority: 210,
    })
  }

  if (number(totals.spend) >= number(settings.stopLossSpend) && number(totals.roas) < number(settings.roasTarget) * 0.6) {
    const storeConfidence = !dataComplete
      ? 'low'
      : number(totals.spend) >= number(settings.stopLossSpend) * 3 && number(totals.orders) >= 3
        ? 'high'
        : 'medium'
    items.push({
      type: 'store-low-roas',
      severity: 'bad',
      decision: '先处理高花费低回报的款',
      title: '当前时间范围全店ROAS偏低',
      cause: `全店ROAS ${ratio(totals.roas)}，低于目标 ${ratio(settings.roasTarget)}。`,
      confidence: { level: storeConfidence, reason: `基于 ${money(totals.spend)} 花费和 ${count(totals.orders)} 个订单；样本越多，判断越可靠。` },
      evidence: [`Spend ${money(totals.spend)}`, `Revenue ${money(totals.revenue)}`, `Orders ${count(totals.orders)}`, `Units ${count(totals.units)}`],
      action: '优先处理本区域列出的高花费、低转化SPU，保留ROAS好的款。',
      avoid: '不要平均降低所有商品预算。',
      review: '调整后观察2天的全店ROAS和订单变化。',
      priority: 350 + number(totals.spend),
    })
  }

  return items.sort((a, b) => b.priority - a.priority).slice(0, 12)
}

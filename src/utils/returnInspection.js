function toCount(value, label) {
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0 || count > 9999) {
    throw new Error(`${label} must be a whole number between 0 and 9999`)
  }
  return count
}

export function summarizeReturnInspection(lines) {
  const normalized = (lines || []).map((line) => {
    const expectedQty = toCount(line.expectedQty, 'Expected quantity')
    const goodQty = toCount(line.goodQty, 'Good quantity')
    const damagedQty = toCount(line.damagedQty, 'Damaged quantity')
    const notOursQty = toCount(line.notOursQty, 'Not ours quantity')
    if (goodQty + damagedQty + notOursQty > expectedQty) {
      throw new Error('The selected outcomes cannot exceed the expected quantity')
    }
    return { expectedQty, goodQty, damagedQty, notOursQty }
  })

  const totals = normalized.reduce((result, line) => ({
    expectedUnits: result.expectedUnits + line.expectedQty,
    actualUnits: result.actualUnits + line.goodQty + line.damagedQty,
    restockUnits: result.restockUnits + line.goodQty,
    damagedUnits: result.damagedUnits + line.damagedQty,
    notOursUnits: result.notOursUnits + line.notOursQty,
    categorizedUnits: result.categorizedUnits + line.goodQty + line.damagedQty + line.notOursQty,
  }), {
    expectedUnits: 0,
    actualUnits: 0,
    restockUnits: 0,
    damagedUnits: 0,
    notOursUnits: 0,
    categorizedUnits: 0,
  })

  const hasDiscrepancy = normalized.some((line) =>
    line.goodQty + line.damagedQty + line.notOursQty !== line.expectedQty
    || line.damagedQty > 0
    || line.notOursQty > 0
  )
  const status = totals.notOursUnits > 0 && totals.actualUnits === 0
    ? 'rejected'
    : hasDiscrepancy ? 'discrepancy' : 'received'

  return {
    ...totals,
    missingUnits: totals.expectedUnits - totals.categorizedUnits,
    hasDiscrepancy,
    status,
  }
}

const FEDEX_GROUND_BARCODE_PATTERN = /^96\d{32}$/

export function identifyTrackingNumber(value) {
  const normalized = String(value || '').trim().replace(/\s+/g, '').toUpperCase()
  const isFedExGroundBarcode = FEDEX_GROUND_BARCODE_PATTERN.test(normalized)

  return {
    carrier: isFedExGroundBarcode ? 'FedEx Ground' : '',
    key: isFedExGroundBarcode ? normalized.slice(-12) : normalized,
  }
}

export function normalizeTracking(value) {
  return identifyTrackingNumber(value).key
}

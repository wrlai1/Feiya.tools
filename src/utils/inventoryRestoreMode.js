const FULL_INVENTORY_RESTORE_LABELS = new Set(['pre_init', 'pre_replace'])

export function inventoryRestoreMode(label) {
  return FULL_INVENTORY_RESTORE_LABELS.has(String(label || '')) ? 'full' : 'quantities'
}

export function inventoryRestoreUsesQuantities(label, requestedMode = '') {
  return String(requestedMode || '') === 'quantities' || inventoryRestoreMode(label) !== 'full'
}

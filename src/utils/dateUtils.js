import {
  formatDistanceToNow,
  format,
  isToday,
  isYesterday,
  parseISO,
} from 'date-fns'

/**
 * Format a date as relative time ("2 min ago", "3 hours ago")
 */
export function relativeTime(date) {
  const d = typeof date === 'string' ? parseISO(date) : date
  return formatDistanceToNow(d, { addSuffix: true })
}

/**
 * Format a date for display in messages
 * Shows "Today HH:mm", "Yesterday HH:mm", or "MMM d, HH:mm"
 */
export function formatMessageTime(date) {
  const d = typeof date === 'string' ? parseISO(date) : date
  if (isToday(d)) return `Today ${format(d, 'HH:mm')}`
  if (isYesterday(d)) return `Yesterday ${format(d, 'HH:mm')}`
  return format(d, 'MMM d, HH:mm')
}

/**
 * Format for "Last updated" display
 */
export function formatLastUpdated(date) {
  if (!date) return 'Never'
  const d = typeof date === 'string' ? parseISO(date) : new Date(date)
  return format(d, 'MMM d, yyyy HH:mm')
}

/**
 * Get a greeting based on current hour
 */
export function getGreeting() {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

/**
 * Format ISO string for display
 */
export function formatDate(dateStr) {
  if (!dateStr) return ''
  const d = typeof dateStr === 'string' ? new Date(dateStr) : dateStr
  return format(d, 'MMM d, yyyy HH:mm')
}

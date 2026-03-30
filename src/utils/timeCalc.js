/**
 * Pure helpers for calculating work hours from punch arrays.
 * Punches must be sorted by punched_at ASC.
 */

export function getStatus(punches) {
  if (!punches?.length) return 'not_started'
  const last = punches[punches.length - 1]
  if (last.type === 'clock_in' || last.type === 'break_end') return 'clocked_in'
  if (last.type === 'break_start') return 'on_break'
  return 'clocked_out'
}

export function getLastClockIn(punches) {
  for (let i = punches.length - 1; i >= 0; i--) {
    if (punches[i].type === 'clock_in') return new Date(punches[i].punched_at)
  }
  return null
}

/** Total worked hours from an array of punches (includes ongoing shift). */
export function calcHours(punches) {
  let totalMs      = 0
  let clockInTime  = null
  let breakStartMs = null
  let breakMs      = 0

  for (const p of punches) {
    const t = new Date(p.punched_at).getTime()
    switch (p.type) {
      case 'clock_in':
        clockInTime  = t
        breakMs      = 0
        breakStartMs = null
        break
      case 'break_start':
        breakStartMs = t
        break
      case 'break_end':
        if (breakStartMs != null) { breakMs += t - breakStartMs; breakStartMs = null }
        break
      case 'clock_out':
        if (clockInTime != null) {
          totalMs    += Math.max(0, t - clockInTime - breakMs)
          clockInTime = null
          breakMs     = 0
        }
        break
    }
  }

  // Ongoing shift
  if (clockInTime != null) {
    const now         = Date.now()
    const liveBreak   = breakStartMs != null ? now - breakStartMs : 0
    totalMs          += Math.max(0, now - clockInTime - breakMs - liveBreak)
  }

  return totalMs / 3_600_000 // → hours (float)
}

export function formatHours(h) {
  if (!h || h < 0) return '0h 0m'
  const hours = Math.floor(h)
  const mins  = Math.round((h - hours) * 60)
  if (hours === 0) return `${mins}m`
  return `${hours}h ${mins}m`
}

export function isMissedPunch(punches) {
  if (getStatus(punches) !== 'clocked_in') return false
  const t = getLastClockIn(punches)
  if (!t) return false
  return (Date.now() - t.getTime()) > 12 * 3_600_000
}

export function filterToday(punches) {
  const start = new Date(); start.setHours(0, 0, 0, 0)
  return punches.filter(p => new Date(p.punched_at) >= start)
}

export function filterThisWeek(punches) {
  const now   = new Date()
  const start = new Date(now)
  start.setDate(now.getDate() - now.getDay())
  start.setHours(0, 0, 0, 0)
  return punches.filter(p => new Date(p.punched_at) >= start)
}

/** Group a flat punch array by username → { username: [punches] } */
export function groupByUser(punches) {
  const map = {}
  for (const p of punches) {
    if (!map[p.username]) map[p.username] = []
    map[p.username].push(p)
  }
  return map
}

export const STATUS_LABEL = {
  clocked_in:  'Clocked In',
  on_break:    'On Break',
  clocked_out: 'Clocked Out',
  not_started: 'Not Started',
}

export const PUNCH_LABEL = {
  clock_in:    'Clock In',
  clock_out:   'Clock Out',
  break_start: 'Break Start',
  break_end:   'Break End',
}

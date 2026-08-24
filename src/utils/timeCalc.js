/**
 * Pure helpers for calculating work hours from punch arrays.
 * Hour calculations sort a copy by punched_at before pairing shifts.
 */

const filteredRangeByPunches = new WeakMap()

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

/**
 * Total worked hours clipped to a time range. Shifts are paired before the
 * range is applied so a clock-in before midnight still contributes work after
 * midnight. An open shift is counted through rangeEndMs.
 */
export function calcHoursInRange(punches, rangeStartMs, rangeEndMs) {
  const startMs = Number.isFinite(rangeStartMs) ? rangeStartMs : -Infinity
  const endMs = Number.isFinite(rangeEndMs) ? rangeEndMs : Date.now()
  if (endMs <= startMs) return 0

  const sortedPunches = [...(punches || [])]
    .map((punch) => ({ punch, time: new Date(punch?.punched_at).getTime() }))
    .filter(({ time }) => Number.isFinite(time))
    .sort((a, b) => a.time - b.time)

  let totalMs = 0
  let onShift = false
  let workingFromMs = null
  let firstPunchIndex = 0

  // A range export only needs the immediately preceding punch to restore the
  // employee's state at the boundary. This also avoids counting older shifts.
  if (Number.isFinite(startMs)) {
    while (
      firstPunchIndex < sortedPunches.length
      && sortedPunches[firstPunchIndex].time < startMs
    ) {
      firstPunchIndex += 1
    }
    const previousPunch = sortedPunches[firstPunchIndex - 1]?.punch
    if (previousPunch?.type === 'clock_in' || previousPunch?.type === 'break_end') {
      onShift = true
      workingFromMs = startMs
    } else if (previousPunch?.type === 'break_start') {
      onShift = true
    }
  }

  const addWorkedInterval = (fromMs, toMs) => {
    const clippedStart = Math.max(fromMs, startMs)
    const clippedEnd = Math.min(toMs, endMs)
    if (clippedEnd > clippedStart) totalMs += clippedEnd - clippedStart
  }

  for (let index = firstPunchIndex; index < sortedPunches.length; index += 1) {
    const { punch, time } = sortedPunches[index]
    switch (punch.type) {
      case 'clock_in':
        if (!onShift) {
          onShift = true
          workingFromMs = time
        }
        break
      case 'break_start':
        if (onShift && workingFromMs != null) {
          addWorkedInterval(workingFromMs, time)
          workingFromMs = null
        }
        break
      case 'break_end':
        if (onShift && workingFromMs == null) workingFromMs = time
        break
      case 'clock_out':
        if (onShift) {
          if (workingFromMs != null) addWorkedInterval(workingFromMs, time)
          onShift = false
          workingFromMs = null
        }
        break
    }
  }

  if (onShift && workingFromMs != null) addWorkedInterval(workingFromMs, endMs)

  return totalMs / 3_600_000
}

/** Total worked hours from an array of punches (includes ongoing shift). */
export function calcHours(punches, nowMs = Date.now()) {
  const filteredRange = filteredRangeByPunches.get(punches)
  if (filteredRange) {
    return calcHoursInRange(filteredRange.source, filteredRange.startMs, nowMs)
  }
  return calcHoursInRange(punches, -Infinity, nowMs)
}

export function formatHours(h) {
  if (!h || h < 0) return '0h 0m'
  const hours = Math.floor(h)
  const mins  = Math.round((h - hours) * 60)
  if (hours === 0) return `${mins}m`
  return `${hours}h ${mins}m`
}

/** Format an instant for a datetime-local input without changing its timezone. */
export function toLocalDateTimeInput(value) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const pad = (part) => String(part).padStart(2, '0')
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ].join('T')
}

export function isMissedPunch(punches) {
  if (getStatus(punches) !== 'clocked_in') return false
  const t = getLastClockIn(punches)
  if (!t) return false
  return (Date.now() - t.getTime()) > 12 * 3_600_000
}

export function filterToday(punches, nowMs = Date.now()) {
  const start = new Date(nowMs); start.setHours(0, 0, 0, 0)
  const source = punches || []
  const filtered = source.filter(p => new Date(p.punched_at) >= start)
  filteredRangeByPunches.set(filtered, { source, startMs: start.getTime() })
  return filtered
}

export function filterThisWeek(punches, nowMs = Date.now()) {
  const now   = new Date(nowMs)
  const start = new Date(now)
  start.setDate(now.getDate() - now.getDay())
  start.setHours(0, 0, 0, 0)
  const source = punches || []
  const filtered = source.filter(p => new Date(p.punched_at) >= start)
  filteredRangeByPunches.set(filtered, { source, startMs: start.getTime() })
  return filtered
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

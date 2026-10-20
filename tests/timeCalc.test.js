import test from 'node:test'
import assert from 'node:assert/strict'

import {
  calcCompletedHoursInRange,
  calcHours,
  calcHoursInRange,
  filterThisWeek,
  filterToday,
  formatHours,
  toLocalDateTimeInput,
} from '../src/utils/timeCalc.js'

function punch(type, year, month, day, hour, minute = 0) {
  return {
    type,
    punched_at: new Date(year, month - 1, day, hour, minute).toISOString(),
  }
}

test('editing a punch keeps the same instant when its displayed local time is unchanged', () => {
  const original = '2026-07-31T14:00:00.000Z'
  assert.equal(new Date(toLocalDateTimeInput(original)).toISOString(), original)
})

test('today hours retain work after midnight when clock-in happened yesterday', () => {
  const nowMs = new Date(2026, 6, 31, 12).getTime()
  const punches = [
    punch('clock_in', 2026, 7, 30, 23),
    punch('clock_out', 2026, 7, 31, 1),
  ]

  const todayPunches = filterToday(punches, nowMs)

  assert.equal(todayPunches.length, 1)
  assert.equal(todayPunches[0].type, 'clock_out')
  assert.equal(calcHours(todayPunches, nowMs), 1)
})

test('week hours retain work after the Sunday boundary', () => {
  const nowMs = new Date(2026, 6, 26, 12).getTime()
  const punches = [
    punch('clock_in', 2026, 7, 25, 23),
    punch('clock_out', 2026, 7, 26, 2),
  ]

  const weekPunches = filterThisWeek(punches, nowMs)

  assert.equal(weekPunches.length, 1)
  assert.equal(calcHours(weekPunches, nowMs), 2)
})

test('range clipping pairs breaks before calculating worked hours', () => {
  const punches = [
    punch('clock_in', 2026, 7, 30, 23),
    punch('break_start', 2026, 7, 30, 23, 30),
    punch('break_end', 2026, 7, 31, 0, 30),
    punch('clock_out', 2026, 7, 31, 2),
  ]

  const startMs = new Date(2026, 6, 31, 0).getTime()
  const endMs = new Date(2026, 6, 31, 3).getTime()

  assert.equal(calcHoursInRange(punches, startMs, endMs), 1.5)
})

test('an ongoing break does not add time through the range end', () => {
  const punches = [
    punch('clock_in', 2026, 7, 31, 8),
    punch('break_start', 2026, 7, 31, 10),
  ]

  const startMs = new Date(2026, 6, 31, 0).getTime()
  const endMs = new Date(2026, 6, 31, 12).getTime()

  assert.equal(calcHoursInRange(punches, startMs, endMs), 2)
})

test('report hours exclude an open shift instead of accumulating until now', () => {
  const punches = [punch('clock_in', 2026, 7, 1, 8)]
  const startMs = new Date(2026, 6, 1, 0).getTime()
  const endMs = new Date(2026, 7, 1, 0).getTime()

  assert.equal(calcCompletedHoursInRange(punches, startMs, endMs), 0)
})

test('report hours exclude the entire incomplete shift, including time before a break', () => {
  const punches = [
    punch('clock_in', 2026, 7, 31, 8),
    punch('break_start', 2026, 7, 31, 12),
  ]
  const startMs = new Date(2026, 6, 31, 0).getTime()
  const endMs = new Date(2026, 6, 31, 23, 59).getTime()

  assert.equal(calcCompletedHoursInRange(punches, startMs, endMs), 0)
})

test('report hours count a completed shift clipped to the selected range', () => {
  const punches = [
    punch('clock_in', 2026, 7, 30, 23),
    punch('clock_out', 2026, 7, 31, 2),
  ]
  const startMs = new Date(2026, 6, 31, 0).getTime()
  const endMs = new Date(2026, 6, 31, 23, 59).getTime()

  assert.equal(calcCompletedHoursInRange(punches, startMs, endMs), 2)
})

test('a new clock-in discards an older incomplete shift', () => {
  const punches = [
    punch('clock_in', 2026, 7, 31, 8),
    punch('clock_in', 2026, 8, 3, 8),
    punch('clock_out', 2026, 8, 3, 16),
  ]
  const startMs = new Date(2026, 7, 1, 0).getTime()
  const endMs = new Date(2026, 8, 1, 0).getTime()

  assert.equal(calcCompletedHoursInRange(punches, startMs, endMs), 8)
})

test('formatted report hours carry 60 rounded minutes into the next hour', () => {
  assert.equal(formatHours(155.9972), '156h 0m')
})

test('export range restores working state from the adjacent punch before the window', () => {
  const punches = [
    punch('break_end', 2026, 7, 30, 23),
    punch('clock_out', 2026, 8, 1, 1),
  ]

  const startMs = new Date(2026, 6, 31, 0).getTime()
  const endMs = new Date(2026, 7, 1, 0).getTime()

  assert.equal(calcHoursInRange(punches, startMs, endMs), 24)
})

test('export range restores an ongoing break without counting it as work', () => {
  const punches = [
    punch('break_start', 2026, 7, 30, 23),
    punch('break_end', 2026, 8, 1, 1),
  ]

  const startMs = new Date(2026, 6, 31, 0).getTime()
  const endMs = new Date(2026, 7, 1, 0).getTime()

  assert.equal(calcHoursInRange(punches, startMs, endMs), 0)
})

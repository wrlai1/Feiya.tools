import test from 'node:test'
import assert from 'node:assert/strict'

import { activeShiftUsers } from '../api/timeclock.js'

test('period reset treats working and break states as active shifts', () => {
  const latestPunches = [
    { user_id: 1, username: 'Clocked In', type: 'clock_in' },
    { user_id: 2, username: 'On Break', type: 'break_start' },
    { user_id: 3, username: 'Back From Break', type: 'break_end' },
    { user_id: 4, username: 'Finished', type: 'clock_out' },
  ]

  assert.deepEqual(
    activeShiftUsers(latestPunches).map((punch) => punch.user_id),
    [1, 2, 3],
  )
})

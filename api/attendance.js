import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import authentication from '../lib/authentication.cjs';
import {
  DEFAULT_ATTENDANCE_SETTINGS,
  buildAttendanceSummary,
  calculateAttendanceDays,
  filterAttendanceRecordsByDates,
  parseAttendanceFiles,
  partitionAttendanceDuplicates,
  standardMinutesForSchedule,
} from '../src/utils/factoryAttendance.js';

const { authenticateUser } = authentication;

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function settingsFromRow(row = {}) {
  return {
    timezone: row.timezone || DEFAULT_ATTENDANCE_SETTINGS.timezone,
    weekdayStart: String(row.weekday_start || DEFAULT_ATTENDANCE_SETTINGS.weekdayStart).slice(0, 5),
    weekdayEnd: String(row.weekday_end || DEFAULT_ATTENDANCE_SETTINGS.weekdayEnd).slice(0, 5),
    weekdayStandardMinutes: Number(row.weekday_standard_minutes ?? DEFAULT_ATTENDANCE_SETTINGS.weekdayStandardMinutes),
    saturdayStart: String(row.saturday_start || DEFAULT_ATTENDANCE_SETTINGS.saturdayStart).slice(0, 5),
    saturdayEnd: String(row.saturday_end || DEFAULT_ATTENDANCE_SETTINGS.saturdayEnd).slice(0, 5),
    saturdayStandardMinutes: Number(row.saturday_standard_minutes ?? DEFAULT_ATTENDANCE_SETTINGS.saturdayStandardMinutes),
    payrollStandardMinutes: Number(row.payroll_standard_minutes ?? DEFAULT_ATTENDANCE_SETTINGS.payrollStandardMinutes),
    hourlyAdjustmentRate: Number(row.hourly_adjustment_rate ?? DEFAULT_ATTENDANCE_SETTINGS.hourlyAdjustmentRate),
    fulltimeDailyRate: Number(row.fulltime_daily_rate ?? DEFAULT_ATTENDANCE_SETTINGS.fulltimeDailyRate),
    fulltimeBonus: Number(row.fulltime_bonus ?? DEFAULT_ATTENDANCE_SETTINGS.fulltimeBonus),
  };
}

function employeeFromRow(row) {
  return {
    employeeCode: Number(row.employee_code),
    name: row.name,
    department: row.department,
    dailyPayment: row.daily_payment == null ? null : Number(row.daily_payment),
    bonusEligible: Boolean(row.bonus_eligible),
    rateEffectiveFrom: row.rate_effective_from || null,
  };
}

async function ensureTables(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_settings (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      timezone TEXT NOT NULL DEFAULT 'America/Guatemala',
      weekday_start TIME NOT NULL DEFAULT '07:00',
      weekday_end TIME NOT NULL DEFAULT '18:00',
      weekday_standard_minutes INTEGER NOT NULL DEFAULT 600,
      saturday_start TIME NOT NULL DEFAULT '07:00',
      saturday_end TIME NOT NULL DEFAULT '12:00',
      saturday_standard_minutes INTEGER NOT NULL DEFAULT 300,
      payroll_standard_minutes INTEGER NOT NULL DEFAULT 5400,
      hourly_adjustment_rate NUMERIC(10,2) NOT NULL DEFAULT 20,
      fulltime_daily_rate NUMERIC(10,2) NOT NULL DEFAULT 107.37,
      fulltime_bonus NUMERIC(10,2) NOT NULL DEFAULT 125,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`INSERT INTO attendance_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_employees (
      employee_code INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      department TEXT,
      daily_payment NUMERIC(10,2),
      bonus_eligible BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_employee_rates (
      id BIGSERIAL PRIMARY KEY,
      employee_code INTEGER NOT NULL REFERENCES attendance_employees(employee_code) ON DELETE CASCADE,
      effective_from DATE NOT NULL,
      daily_payment NUMERIC(10,2),
      bonus_eligible BOOLEAN NOT NULL DEFAULT FALSE,
      updated_by TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (employee_code, effective_from)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_imports (
      id BIGSERIAL PRIMARY KEY,
      file_name TEXT NOT NULL,
      file_hash TEXT UNIQUE NOT NULL,
      record_count INTEGER NOT NULL,
      inserted_count INTEGER NOT NULL DEFAULT 0,
      uploaded_by TEXT NOT NULL,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      date_from DATE,
      date_to DATE,
      source_files JSONB NOT NULL DEFAULT '[]'::jsonb,
      duplicate_details JSONB NOT NULL DEFAULT '[]'::jsonb,
      date_schedules JSONB NOT NULL DEFAULT '[]'::jsonb,
      reverted_by TEXT,
      reverted_at TIMESTAMPTZ
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_punches (
      id BIGSERIAL PRIMARY KEY,
      employee_code INTEGER NOT NULL REFERENCES attendance_employees(employee_code),
      name TEXT NOT NULL,
      department TEXT,
      punched_at TIMESTAMP NOT NULL,
      raw_timestamp TEXT,
      device_id INTEGER NOT NULL DEFAULT 0,
      import_id BIGINT NOT NULL REFERENCES attendance_imports(id),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (employee_code, punched_at, device_id)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_day_reviews (
      employee_code INTEGER NOT NULL REFERENCES attendance_employees(employee_code),
      work_date DATE NOT NULL,
      confirmed BOOLEAN NOT NULL DEFAULT FALSE,
      adjusted_minutes NUMERIC(10,2),
      late BOOLEAN NOT NULL DEFAULT FALSE,
      early BOOLEAN NOT NULL DEFAULT FALSE,
      note TEXT,
      updated_by TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (employee_code, work_date)
    )
  `;
  await sql`ALTER TABLE attendance_day_reviews ADD COLUMN IF NOT EXISTS late BOOLEAN NOT NULL DEFAULT FALSE`;
  await sql`ALTER TABLE attendance_day_reviews ADD COLUMN IF NOT EXISTS early BOOLEAN NOT NULL DEFAULT FALSE`;
  await sql`ALTER TABLE attendance_imports ADD COLUMN IF NOT EXISTS reverted_by TEXT`;
  await sql`ALTER TABLE attendance_imports ADD COLUMN IF NOT EXISTS reverted_at TIMESTAMPTZ`;
  await sql`ALTER TABLE attendance_imports ADD COLUMN IF NOT EXISTS date_from DATE`;
  await sql`ALTER TABLE attendance_imports ADD COLUMN IF NOT EXISTS date_to DATE`;
  await sql`ALTER TABLE attendance_imports ADD COLUMN IF NOT EXISTS source_files JSONB NOT NULL DEFAULT '[]'::jsonb`;
  await sql`ALTER TABLE attendance_imports ADD COLUMN IF NOT EXISTS duplicate_details JSONB NOT NULL DEFAULT '[]'::jsonb`;
  await sql`ALTER TABLE attendance_imports ADD COLUMN IF NOT EXISTS date_schedules JSONB NOT NULL DEFAULT '[]'::jsonb`;
  await sql`ALTER TABLE attendance_punches ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE`;
  await sql`ALTER TABLE attendance_imports DROP CONSTRAINT IF EXISTS attendance_imports_file_hash_key`;
  await sql`ALTER TABLE attendance_punches DROP CONSTRAINT IF EXISTS attendance_punches_employee_code_punched_at_device_id_key`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS attendance_imports_active_hash_idx ON attendance_imports (file_hash) WHERE reverted_at IS NULL`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS attendance_punches_active_key_idx ON attendance_punches (employee_code, punched_at, device_id) WHERE active`;
  await sql`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY employee_code, punched_at ORDER BY id) AS position
      FROM attendance_punches WHERE active
    )
    UPDATE attendance_punches SET active = FALSE
    WHERE id IN (SELECT id FROM ranked WHERE position > 1)
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS attendance_punches_active_time_idx ON attendance_punches (employee_code, punched_at) WHERE active`;
}

async function loadDashboard(sql, from, to) {
  const [settingsRows, punchRows, reviewRows, employeeRows, importRows, scheduleRows] = await Promise.all([
    sql`SELECT * FROM attendance_settings WHERE id = 1`,
    sql`
      SELECT employee_code, name, department,
             TO_CHAR(punched_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS punched_at,
             raw_timestamp, device_id, import_id
      FROM attendance_punches
      WHERE active
        AND punched_at >= CAST(${from} AS date)
        AND punched_at < CAST(${to} AS date) + INTERVAL '1 day'
      ORDER BY punched_at ASC, employee_code ASC
    `,
    sql`
      SELECT employee_code, work_date::text, confirmed, adjusted_minutes, late, early, note, updated_by, updated_at
      FROM attendance_day_reviews
      WHERE work_date >= CAST(${from} AS date) AND work_date <= CAST(${to} AS date)
    `,
    sql`
      WITH selected_rates AS (
        SELECT DISTINCT ON (employee_code)
          employee_code, daily_payment, bonus_eligible, effective_from
        FROM attendance_employee_rates
        WHERE effective_from <= CAST(${to} AS date)
        ORDER BY employee_code, effective_from DESC, id DESC
      )
      SELECT e.employee_code, e.name, e.department,
             CASE
               WHEN r.employee_code IS NOT NULL THEN r.daily_payment
               WHEN EXISTS (SELECT 1 FROM attendance_employee_rates ar WHERE ar.employee_code = e.employee_code) THEN NULL
               ELSE e.daily_payment
             END AS daily_payment,
             CASE
               WHEN r.employee_code IS NOT NULL THEN r.bonus_eligible
               WHEN EXISTS (SELECT 1 FROM attendance_employee_rates ar WHERE ar.employee_code = e.employee_code) THEN FALSE
               ELSE e.bonus_eligible
             END AS bonus_eligible,
             r.effective_from::text AS rate_effective_from
      FROM attendance_employees e
      LEFT JOIN selected_rates r USING (employee_code)
      ORDER BY e.employee_code
    `,
    sql`
      SELECT id, file_name, record_count, inserted_count, uploaded_by, uploaded_at,
             date_from::text, date_to::text, source_files, duplicate_details, date_schedules, reverted_by, reverted_at
      FROM attendance_imports ORDER BY uploaded_at DESC LIMIT 50
    `,
    sql`
      SELECT date_schedules
      FROM attendance_imports
      WHERE reverted_at IS NULL
        AND date_to >= CAST(${from} AS date)
        AND date_from <= CAST(${to} AS date)
      ORDER BY uploaded_at ASC, id ASC
    `,
  ]);

  const settings = settingsFromRow(settingsRows[0]);
  const punches = punchRows.map((row) => ({
    employeeCode: Number(row.employee_code),
    name: row.name,
    department: row.department,
    punchedAt: row.punched_at,
    rawTimestamp: row.raw_timestamp,
    deviceId: Number(row.device_id),
    importId: Number(row.import_id),
  }));
  const reviews = reviewRows.map((row) => ({
    employeeCode: Number(row.employee_code),
    workDate: row.work_date,
    confirmed: Boolean(row.confirmed),
    adjustedMinutes: row.adjusted_minutes == null ? null : Number(row.adjusted_minutes),
    late: Boolean(row.late),
    early: Boolean(row.early),
    note: row.note,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  }));
  const employees = employeeRows.map(employeeFromRow);
  const dateSchedules = new Map();
  for (const row of scheduleRows) {
    for (const schedule of row.date_schedules || []) dateSchedules.set(schedule.workDate, schedule);
  }
  const days = calculateAttendanceDays(punches, settings, reviews, [...dateSchedules.values()]);
  return {
    from,
    to,
    settings,
    employees,
    punches,
    days,
    summary: buildAttendanceSummary(days, employees),
    imports: importRows,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const dbUrl = process.env.DATABASE_URL;
  const secret = process.env.JWT_SECRET;
  if (!dbUrl || !secret) return res.status(500).json({ error: 'Server not configured' });
  const sql = neon(dbUrl);

  try {
    const user = await authenticateUser(sql, req.headers.authorization, secret);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    if (user.role !== 'admin' && !user.attendanceAccess) {
      return res.status(403).json({ error: 'Attendance access required' });
    }
    await ensureTables(sql);
    const action = String(req.query.action || 'dashboard');

    if (req.method === 'GET' && action === 'dashboard') {
      const from = String(req.query.from || '');
      const to = String(req.query.to || '');
      if (!validDate(from) || !validDate(to) || from > to) return res.status(400).json({ error: 'Valid date range required' });
      return res.status(200).json(await loadDashboard(sql, from, to));
    }

    if (req.method === 'POST' && action === 'import') {
      const submittedFiles = Array.isArray(req.body?.files)
        ? req.body.files
        : [{ fileName: req.body?.fileName, content: req.body?.content }];
      const files = submittedFiles.map((file) => ({
        fileName: String(file?.fileName || '').trim(),
        content: String(file?.content || ''),
      }));
      if (!files.length || files.length > 3 || files.some((file) => !file.fileName || !file.content)) {
        return res.status(400).json({ error: 'Select between one and three attendance TXT files' });
      }
      if (files.some((file) => file.content.length > 4_000_000) || files.reduce((sum, file) => sum + file.content.length, 0) > 12_000_000) {
        return res.status(413).json({ error: 'One or more attendance files are too large' });
      }
      const sourceFiles = files.map((file) => file.fileName);
      const fileName = sourceFiles.length === 1 ? sourceFiles[0] : `${sourceFiles.length} files: ${sourceFiles.join(', ')}`;
      const contentHashes = files.map((file) => createHash('sha256').update(file.content).digest('hex')).sort();
      const parsedRecords = parseAttendanceFiles(files);
      const availableDates = [...new Set(parsedRecords.map((record) => record.punchedAt.slice(0, 10)))].sort();
      const submittedSchedules = Array.isArray(req.body?.dateSchedules) ? req.body.dateSchedules : [];
      const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
      const scheduleByDate = new Map();
      for (const schedule of submittedSchedules) {
        const workDate = String(schedule?.workDate || '');
        const endTime = String(schedule?.endTime || '').slice(0, 5);
        if (!validDate(workDate) || !timePattern.test(endTime) || scheduleByDate.has(workDate)) {
          return res.status(400).json({ error: 'Choose one valid end time for every attendance date' });
        }
        scheduleByDate.set(workDate, endTime);
      }
      if (!scheduleByDate.size || [...scheduleByDate.keys()].some((date) => !availableDates.includes(date))) {
        return res.status(400).json({ error: 'Keep at least one valid date found in the TXT files' });
      }
      const dateSchedules = [...scheduleByDate.keys()].sort().map((workDate) => {
        const endTime = scheduleByDate.get(workDate);
        const standardMinutes = standardMinutesForSchedule(workDate, endTime);
        return { workDate, startTime: '07:00', endTime, standardMinutes };
      });
      if (dateSchedules.some((schedule) => !Number.isFinite(schedule.standardMinutes) || schedule.standardMinutes <= 0)) {
        return res.status(400).json({ error: 'Every selected end time must produce a positive workday after 07:00' });
      }
      const records = filterAttendanceRecordsByDates(parsedRecords, scheduleByDate.keys());
      const recordDates = records.map((record) => record.punchedAt.slice(0, 10)).sort();
      const dateFrom = recordDates[0];
      const dateTo = recordDates.at(-1);
      const hash = createHash('sha256').update(`${contentHashes.join('|')}|${JSON.stringify(dateSchedules)}`).digest('hex');
      const preliminary = partitionAttendanceDuplicates(records);
      const lookupJson = JSON.stringify(preliminary.accepted.map((record) => ({
        employee_code: record.employeeCode,
        punched_at: record.punchedAt,
        device_id: record.deviceId,
      })));
      const existingPunches = await sql`
        SELECT p.employee_code, TO_CHAR(p.punched_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS punched_at, p.device_id
        FROM attendance_punches p
        JOIN jsonb_to_recordset(${lookupJson}::jsonb)
         AS x(employee_code INTEGER, punched_at TEXT, device_id INTEGER)
          ON p.employee_code = x.employee_code
         AND p.punched_at = CAST(x.punched_at AS timestamp)
        WHERE p.active
      `;
      const existingKeys = new Set(existingPunches.map((record) => (
        `${Number(record.employee_code)}|${record.punched_at}`
      )));
      const { accepted: newRecords, duplicates: duplicateDetails } = partitionAttendanceDuplicates(records, existingKeys);
      const activeFile = await sql`
        SELECT id, file_name, uploaded_at FROM attendance_imports
        WHERE file_hash = ${hash} AND reverted_at IS NULL
      `;
      if (activeFile[0]) {
        return res.status(200).json({
          importId: Number(activeFile[0].id), records: records.length, inserted: 0,
          duplicates: records.length, duplicateDetails, exactFileDuplicate: true,
          existing: activeFile[0], dateFrom, dateTo, sourceFiles, dateSchedules,
        });
      }
      const employeeMap = new Map();
      for (const record of records) {
        const current = employeeMap.get(record.employeeCode);
        const usefulDepartment = record.department && !/^Not Set/i.test(record.department);
        if (!current || usefulDepartment) employeeMap.set(record.employeeCode, record);
      }
      const employeeJson = JSON.stringify([...employeeMap.values()].map((record) => ({
        employee_code: record.employeeCode,
        name: record.name,
        department: record.department,
      })));
      await sql`
        INSERT INTO attendance_employees (employee_code, name, department)
        SELECT employee_code, name, department
        FROM jsonb_to_recordset(${employeeJson}::jsonb)
          AS x(employee_code INTEGER, name TEXT, department TEXT)
        ON CONFLICT (employee_code) DO UPDATE SET
          name = EXCLUDED.name,
          department = CASE
            WHEN EXCLUDED.department = '' OR EXCLUDED.department ILIKE 'Not Set%' THEN attendance_employees.department
            ELSE EXCLUDED.department
          END,
          updated_at = NOW()
      `;

      const imports = await sql`
        INSERT INTO attendance_imports (
          file_name, file_hash, record_count, uploaded_by, date_from, date_to, source_files, duplicate_details, date_schedules
        )
        VALUES (
          ${fileName}, ${hash}, ${records.length}, ${user.username}, ${dateFrom}, ${dateTo},
          ${JSON.stringify(sourceFiles)}::jsonb,
          ${JSON.stringify(duplicateDetails)}::jsonb,
          ${JSON.stringify(dateSchedules)}::jsonb
        )
        RETURNING id
      `;
      const importId = Number(imports[0].id);
      const punchJson = JSON.stringify(newRecords.map((record) => ({
        employee_code: record.employeeCode,
        name: record.name,
        department: record.department,
        punched_at: record.punchedAt,
        raw_timestamp: record.rawTimestamp,
        device_id: record.deviceId,
      })));
      const inserted = await sql`
        INSERT INTO attendance_punches (
          employee_code, name, department, punched_at, raw_timestamp, device_id, import_id
        )
        SELECT employee_code, name, department, CAST(punched_at AS timestamp), raw_timestamp, device_id, ${importId}
        FROM jsonb_to_recordset(${punchJson}::jsonb)
          AS x(employee_code INTEGER, name TEXT, department TEXT, punched_at TEXT, raw_timestamp TEXT, device_id INTEGER)
        ON CONFLICT (employee_code, punched_at) WHERE active DO NOTHING
        RETURNING id
      `;
      await sql`UPDATE attendance_imports SET inserted_count = ${inserted.length} WHERE id = ${importId}`;
      return res.status(200).json({
        importId, records: records.length, inserted: inserted.length,
        duplicates: records.length - inserted.length, duplicateDetails, dateFrom, dateTo, sourceFiles, dateSchedules,
      });
    }

    if (req.method === 'PATCH' && action === 'rollback-import') {
      const importId = Number(req.body?.importId);
      if (!Number.isSafeInteger(importId)) return res.status(400).json({ error: 'Import version required' });
      const reverted = await sql`
        WITH reverted AS (
          UPDATE attendance_imports
          SET reverted_by = ${user.username}, reverted_at = NOW()
          WHERE id = ${importId} AND reverted_at IS NULL
            AND id = (
              SELECT id FROM attendance_imports
              WHERE reverted_at IS NULL
              ORDER BY uploaded_at DESC, id DESC
              LIMIT 1
            )
          RETURNING id
        ), deactivated AS (
          UPDATE attendance_punches
          SET active = FALSE
          WHERE import_id IN (SELECT id FROM reverted) AND active
          RETURNING id
        )
        SELECT (SELECT id FROM reverted) AS import_id,
               (SELECT COUNT(*)::int FROM deactivated) AS removed_count
      `;
      if (!reverted[0]?.import_id) return res.status(409).json({ error: 'Only the latest active import can be rolled back' });
      return res.status(200).json({ ok: true, removedPunches: Number(reverted[0].removed_count) });
    }

    if (req.method === 'PATCH' && action === 'review') {
      const employeeCode = Number(req.body?.employeeCode);
      const workDate = String(req.body?.workDate || '');
      const adjustedMinutes = Number(req.body?.adjustedMinutes);
      const late = Boolean(req.body?.late);
      const early = Boolean(req.body?.early);
      const note = String(req.body?.note || '').trim();
      if (!Number.isSafeInteger(employeeCode) || !validDate(workDate)) return res.status(400).json({ error: 'Employee and date required' });
      if (!Number.isFinite(adjustedMinutes) || adjustedMinutes < 0 || adjustedMinutes > 1440) {
        return res.status(400).json({ error: 'Adjusted work time must be between 0 and 24 hours' });
      }
      await sql`
        INSERT INTO attendance_day_reviews (
          employee_code, work_date, confirmed, adjusted_minutes, late, early, note, updated_by
        ) VALUES (${employeeCode}, ${workDate}, TRUE, ${adjustedMinutes}, ${late}, ${early}, ${note || null}, ${user.username})
        ON CONFLICT (employee_code, work_date) DO UPDATE SET
          confirmed = TRUE,
          adjusted_minutes = EXCLUDED.adjusted_minutes,
          late = EXCLUDED.late,
          early = EXCLUDED.early,
          note = EXCLUDED.note,
          updated_by = EXCLUDED.updated_by,
          updated_at = NOW()
      `;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'PATCH' && action === 'employee') {
      if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
      const employeeCode = Number(req.body?.employeeCode);
      const dailyPayment = Number(req.body?.dailyPayment);
      const effectiveFrom = String(req.body?.effectiveFrom || '');
      if (!Number.isSafeInteger(employeeCode) || !Number.isFinite(dailyPayment) || dailyPayment < 0 || !validDate(effectiveFrom)) {
        return res.status(400).json({ error: 'Employee, rate, and effective date required' });
      }
      const attendanceSettings = await sql`SELECT fulltime_daily_rate FROM attendance_settings WHERE id = 1`;
      const bonusEligible = Number(dailyPayment) === Number(attendanceSettings[0]?.fulltime_daily_rate);
      const updated = await sql`
        UPDATE attendance_employees SET
          daily_payment = ${dailyPayment}, bonus_eligible = ${bonusEligible}, updated_at = NOW()
        WHERE employee_code = ${employeeCode}
        RETURNING employee_code
      `;
      if (!updated[0]) return res.status(404).json({ error: 'Employee not found' });
      await sql`
        INSERT INTO attendance_employee_rates (
          employee_code, effective_from, daily_payment, bonus_eligible, updated_by
        ) VALUES (${employeeCode}, ${effectiveFrom}, ${dailyPayment}, ${bonusEligible}, ${user.username})
        ON CONFLICT (employee_code, effective_from) DO UPDATE SET
          daily_payment = EXCLUDED.daily_payment,
          bonus_eligible = EXCLUDED.bonus_eligible,
          updated_by = EXCLUDED.updated_by,
          updated_at = NOW()
      `;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'PATCH' && action === 'settings') {
      if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
      const next = { ...DEFAULT_ATTENDANCE_SETTINGS, ...(req.body || {}) };
      const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (![next.weekdayStart, next.weekdayEnd, next.saturdayStart, next.saturdayEnd].every((value) => timePattern.test(String(value)))) {
        return res.status(400).json({ error: 'Schedule times must use HH:MM' });
      }
      const numericKeys = ['weekdayStandardMinutes', 'saturdayStandardMinutes', 'payrollStandardMinutes', 'hourlyAdjustmentRate', 'fulltimeDailyRate', 'fulltimeBonus'];
      if (numericKeys.some((key) => !Number.isFinite(Number(next[key])) || Number(next[key]) < 0)) {
        return res.status(400).json({ error: 'Settings must be positive numbers' });
      }
      await sql`
        UPDATE attendance_settings SET
          timezone = 'America/Guatemala',
          weekday_start = ${next.weekdayStart}, weekday_end = ${next.weekdayEnd},
          weekday_standard_minutes = ${Number(next.weekdayStandardMinutes)},
          saturday_start = ${next.saturdayStart}, saturday_end = ${next.saturdayEnd},
          saturday_standard_minutes = ${Number(next.saturdayStandardMinutes)},
          payroll_standard_minutes = ${Number(next.payrollStandardMinutes)},
          hourly_adjustment_rate = ${Number(next.hourlyAdjustmentRate)},
          fulltime_daily_rate = ${Number(next.fulltimeDailyRate)},
          fulltime_bonus = ${Number(next.fulltimeBonus)},
          updated_by = ${user.username}, updated_at = NOW()
        WHERE id = 1
      `;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'This attendance file or record already exists' });
    return res.status(500).json({ error: error.message });
  }
}

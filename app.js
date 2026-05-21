require('dotenv').config();
const reports = require('./reports');
const express    = require('express');
const axios      = require('axios');
const { Pool }   = require('pg');
const cron       = require('node-cron');

const app  = express();
const port = process.env.PORT || 10000;

const APP_DOMAIN    = process.env.APP_DOMAIN           || 'bitrixbot-bnnd.onrender.com';
const BITRIX_DOMAIN = process.env.BITRIX_DOMAIN        || '';
const CLIENT_ID     = process.env.BITRIX_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.BITRIX_CLIENT_SECRET || '';
const OFFICE_LAT    = parseFloat(process.env.OFFICE_LAT    || '');
const OFFICE_LON    = parseFloat(process.env.OFFICE_LON    || '');
const OFFICE_RADIUS = parseInt(process.env.OFFICE_RADIUS   || '100');
// Второй офис/филиал (опционально — если не заданы, не используется)
const OFFICE2_LAT   = process.env.OFFICE2_LAT ? parseFloat(process.env.OFFICE2_LAT) : null;
const OFFICE2_LON   = process.env.OFFICE2_LON ? parseFloat(process.env.OFFICE2_LON) : null;
const OFFICE2_NAME  = process.env.OFFICE2_NAME || 'Филиал';
const OFFICE3_LAT   = process.env.OFFICE3_LAT ? parseFloat(process.env.OFFICE3_LAT) : null;
const OFFICE3_LON   = process.env.OFFICE3_LON ? parseFloat(process.env.OFFICE3_LON) : null;
const OFFICE3_NAME  = process.env.OFFICE3_NAME || 'Офис 3';
const OFFICE4_LAT   = process.env.OFFICE4_LAT ? parseFloat(process.env.OFFICE4_LAT) : null;
const OFFICE4_LON   = process.env.OFFICE4_LON ? parseFloat(process.env.OFFICE4_LON) : null;
const OFFICE4_NAME  = process.env.OFFICE4_NAME || 'Офис 4';
const MANAGER_ID    = process.env.MANAGER_USER_ID          || '1';
const reportEmailsRaw = process.env.REPORT_EMAIL || '';
const reportEmails = reportEmailsRaw.split(',').map(e => e.trim()).filter(e => e);

const smtpConfig = {
    smtpUser:    process.env.SMTP_USER   || '',
    brevoApiKey: process.env.BREVO_API_KEY || '',
    reportEmails,   // ← теперь массив
};

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
    await pool.query(`CREATE TABLE IF NOT EXISTS portals (
        domain TEXT PRIMARY KEY, access_token TEXT NOT NULL,
        refresh_token TEXT, bot_id TEXT, client_endpoint TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, user_name TEXT,
        domain TEXT, type TEXT NOT NULL, timestamp TIMESTAMPTZ DEFAULT NOW(),
        latitude REAL, longitude REAL, in_office INTEGER DEFAULT 0)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS geo_tokens (
        token TEXT PRIMARY KEY, user_id TEXT NOT NULL, user_name TEXT,
        dialog_id TEXT NOT NULL, bot_id TEXT NOT NULL, domain TEXT NOT NULL,
        access_token TEXT NOT NULL, type TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS admins (
        user_id TEXT PRIMARY KEY, user_name TEXT,
        added_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS schedules (
        id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, user_name TEXT NOT NULL,
        status TEXT NOT NULL, date_from DATE NOT NULL, date_to DATE NOT NULL,
        comment TEXT, created_by TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS pending_input (
        user_id TEXT PRIMARY KEY, action TEXT NOT NULL, step TEXT,
        data JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS employees (
        user_id TEXT PRIMARY KEY, user_name TEXT NOT NULL, domain TEXT,
        dialog_id TEXT,
        first_seen TIMESTAMPTZ DEFAULT NOW(), last_seen TIMESTAMPTZ DEFAULT NOW())`);
    // Добавляем колонку dialog_id если её нет (для существующих БД)
    await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS dialog_id TEXT`);
    // Таблица типов рабочих графиков (5/2, 4/2, 2/2)
    await pool.query(`CREATE TABLE IF NOT EXISTS employee_work_schedules (
 user_id TEXT PRIMARY KEY,
 user_name TEXT NOT NULL,
 schedule_type TEXT NOT NULL,
 cycle_start DATE NOT NULL,
 date_end DATE,
 assigned_by TEXT,
 assigned_at TIMESTAMPTZ DEFAULT NOW(),
 updated_at TIMESTAMPTZ DEFAULT NOW()
)`);
// Миграции для существующих БД
await pool.query(`ALTER TABLE employee_work_schedules ADD COLUMN IF NOT EXISTS date_end DATE`);
await pool.query(`ALTER TABLE employee_work_schedules ADD COLUMN IF NOT EXISTS assigned_by TEXT`);
await pool.query(`ALTER TABLE employee_work_schedules ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ DEFAULT NOW()`);
await pool.query(`ALTER TABLE employee_work_schedules ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

    
        // ─── Audit log ────────────────────────────────────────────────────────────────
await pool.query(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    ts TIMESTAMPTZ DEFAULT NOW(),

    action TEXT NOT NULL,                 -- тип действия (admin_add, schedule_add, ...)
    actor_user_id TEXT,                   -- кто сделал
    actor_user_name TEXT,

    target_user_id TEXT,                  -- над кем/чем
    target_user_name TEXT,

    domain TEXT,                          -- портал
    details JSONB DEFAULT '{}'            -- доп. поля (id записи, даты, комментарий и т.д.)
  )
`);

await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts DESC)`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_user_id)`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action)`);

    console.log('✅ БД инициализирована');
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    console.log(`📍 ${new Date().toISOString()} ${req.method} ${req.url}`);
    next();
});

// ─── Утилиты ──────────────────────────────────────────────────────────────────

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function checkOffice(lat, lon) {
    // Собираем все офисы из переменных окружения
    const offices = [
        { lat: OFFICE_LAT, lon: OFFICE_LON, name: 'Офис' },
    ];
    
    if (OFFICE2_LAT && OFFICE2_LON) offices.push({ lat: OFFICE2_LAT, lon: OFFICE2_LON, name: OFFICE2_NAME || 'Филиал' });
    if (OFFICE3_LAT && OFFICE3_LON) offices.push({ lat: OFFICE3_LAT, lon: OFFICE3_LON, name: OFFICE3_NAME || 'Офис 3' });
    if (OFFICE4_LAT && OFFICE4_LON) offices.push({ lat: OFFICE4_LAT, lon: OFFICE4_LON, name: OFFICE4_NAME || 'Офис 4' });
    // можно добавить и OFFICE5... и так далее
    
    for (const office of offices) {
        const distance = getDistance(lat, lon, office.lat, office.lon);
        if (distance <= OFFICE_RADIUS) {
            return { inOffice: true, officeName: office.name };
        }
    }
    return { inOffice: false, officeName: null };
}
function makeToken() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h} ч ${m} мин`;
}

// Формирует отчёт по отметкам за последние days дней
async function getUserHistory(userId, days) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days + 1);
    startDate.setHours(0,0,0,0);
    endDate.setHours(23,59,59,999);

    const { rows } = await pool.query(`
        SELECT type, timestamp
        FROM attendance
        WHERE user_id = $1
          AND timestamp >= $2
          AND timestamp <= $3
        ORDER BY timestamp
    `, [userId, startDate, endDate]);

    // Группируем по дням (по дате в Екатеринбурге)
    const dayMap = new Map(); // key: YYYY-MM-DD, value: { inTime, outTime, totalSeconds }
    for (const row of rows) {
        const ts = new Date(row.timestamp);
        const dateStr = ts.toLocaleDateString('sv-SE', { timeZone: 'Asia/Yekaterinburg' });
        if (!dayMap.has(dateStr)) dayMap.set(dateStr, { inTime: null, outTime: null, totalSeconds: 0 });
        const entry = dayMap.get(dateStr);
        if (row.type === 'in') {
            entry.inTime = ts;
        } else if (row.type === 'out' && entry.inTime) {
            entry.totalSeconds += (ts - entry.inTime) / 1000;
            entry.inTime = null; // сбрасываем, чтобы не дублировать
        }
    }

    // Преобразуем в массив и сортируем по дате
    const daysArray = Array.from(dayMap.entries()).map(([date, data]) => ({
        date,
        hours: data.totalSeconds / 3600,
    })).sort((a,b) => a.date.localeCompare(b.date));

    return daysArray;
}

function formatHistoryText(daysArray, periodLabel) {
    if (!daysArray.length) return `📊 За ${periodLabel} нет данных об отработанных часах.`;

    const maxHours = 8; // норма часов в день
    const barLength = 10; // максимальная длина графика в символах

    let text = `📊 История за ${periodLabel}\n\n`;
    text += `📅 Дата          Часы   График (${maxHours}ч)\n`;

    for (const day of daysArray) {
        const hours = day.hours;
        const dateRu = new Date(day.date).toLocaleDateString('ru-RU');
        const hoursStr = hours.toFixed(1).padStart(5, ' ');
        const filled = Math.min(barLength, Math.round((hours / maxHours) * barLength));
        const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);
        text += `${dateRu}   ${hoursStr} ч   ${bar}\n`;
    }

    const totalHours = daysArray.reduce((sum, d) => sum + d.hours, 0);
    const avgHours = (totalHours / daysArray.length).toFixed(1);
    text += `\n📌 Итого: ${totalHours.toFixed(1)} ч за ${daysArray.length} дн. (сред. ${avgHours} ч/день)`;

    return text;
}

async function getMonthWorkSeconds(userId) {
    const { rows } = await pool.query(`
        SELECT type, timestamp
        FROM attendance
        WHERE user_id = $1
          AND date_trunc('month', timestamp) = date_trunc('month', NOW())
        ORDER BY timestamp
    `, [userId]);

    let total = 0;
    let lastIn = null;

    for (const r of rows) {
        if (r.type === 'in') {
            lastIn = new Date(r.timestamp);
        } else if (r.type === 'out' && lastIn) {
            total += (new Date(r.timestamp) - lastIn) / 1000;
            lastIn = null;
        }
    }

    return total;
}

function tzTime(ts) {
    return new Date(ts).toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', timeZone:'Asia/Yekaterinburg' });
}

function todaySV() {
    return new Date().toLocaleDateString('sv-SE', { timeZone:'Asia/Yekaterinburg' });
}

function parseDate(str) {
    const m = str.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (!m) return null;
    const d = new Date(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0,10);
}

const SCHED_LABELS = {
    vacation:   '🏖 Отпуск',
    sick:       '🤒 Больничный',
    dayoff:     '📅 Выходной',
    remote:     '🏠 Удалённо',
    business:   '✈️ Командировка',
    work_sched: '🗓 Выходной по графику',
};

// ─── Типы рабочих графиков ────────────────────────────────────────────────────

const WORK_SCHEDULE_TYPES = {
    '5/2': { label: '5/2 (Пн–Пт)',            workDays: 5, restDays: 2 },
    '4/2': { label: '4/2 (4 раб. + 2 вых.)',  workDays: 4, restDays: 2 },
    '2/2': { label: '2/2 (2 раб. + 2 вых.)',  workDays: 2, restDays: 2 },
};

/**
 * Является ли дата выходным по типу графика.
 * scheduleType: '5/2' | '4/2' | '2/2'
 * cycleStart:   YYYY-MM-DD — первый рабочий день цикла (для 4/2 и 2/2)
 * date:         YYYY-MM-DD или Date
 */
function isRestDayBySchedule(scheduleType, cycleStart, date) {
    if (!WORK_SCHEDULE_TYPES[scheduleType]) return false;
    const checkDate = new Date(date);
    checkDate.setHours(0, 0, 0, 0);

    if (scheduleType === '5/2') {
        const dow = checkDate.getDay();
        return dow === 0 || dow === 6;
    }

    const { workDays, restDays } = WORK_SCHEDULE_TYPES[scheduleType];
    const cycleLen  = workDays + restDays;
    const startDate = new Date(cycleStart);
    startDate.setHours(0, 0, 0, 0);
    const diffDays     = Math.round((checkDate - startDate) / 86400000);
    const posInCycle   = ((diffDays % cycleLen) + cycleLen) % cycleLen;
    return posInCycle >= workDays;
}

/** Получить тип графика сотрудника из БД */
async function getEmpWorkSchedule(userId, checkDate = null) {
    const today = checkDate || todaySV();
    const { rows } = await pool.query(`
        SELECT * FROM employee_work_schedules 
        WHERE user_id = $1 
          AND (date_end IS NULL OR date_end >= $2)
    `, [String(userId), today]);
    return rows[0] || null;
}

/** Статус дня для сотрудника: { isRest, scheduleType, label } | null */
async function getWorkScheduleStatus(userId, date) {
    const checkDate = date || todaySV();
    const ws = await getEmpWorkSchedule(userId, checkDate);
    if (!ws) return null;
    const rest = isRestDayBySchedule(ws.schedule_type, ws.cycle_start, checkDate);
    return {
        isRest: rest,
        scheduleType: ws.schedule_type,
        label: rest ? `🗓 Выходной по графику (${ws.schedule_type})` : null,
    };
}

async function getWorkDaysInPeriod(userId, startDate, endDate) {
    const ws = await getEmpWorkSchedule(userId);
    const scheduleType = ws?.schedule_type || null; // null = нет графика
    const cycleStart = ws?.cycle_start || startDate;
    
    const start = new Date(startDate);
    const end = new Date(endDate);
    const dates = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        dates.push(d.toLocaleDateString('sv-SE'));
    }
    
    let totalWorkDays = 0;
    let attendedDays = 0;
    let vacationDays = 0, sickDays = 0, dayoffDays = 0, remoteDays = 0, businessDays = 0;
    let lateDays = 0;
    
    // Получаем расписание (отпуска, больничные) за период
    const { rows: schedRows } = await pool.query(`
        SELECT status, date_from, date_to FROM schedules
        WHERE user_id = $1
          AND date_from <= $2 AND date_to >= $3
    `, [userId, endDate, startDate]);
    
    // Карта расписаний
    const schedMap = new Map();
    for (const s of schedRows) {
        let d = new Date(s.date_from);
        while (d <= new Date(s.date_to)) {
            schedMap.set(d.toLocaleDateString('sv-SE'), s.status);
            d.setDate(d.getDate() + 1);
        }
    }
    
    // Получаем отметки
    const { rows: marks } = await pool.query(`
        SELECT type, timestamp, in_office
        FROM attendance
        WHERE user_id = $1
          AND timestamp >= $2 AND timestamp <= $3
        ORDER BY timestamp
    `, [userId, startDate, endDate]);
    
    // Группируем отметки по дням
    const dayMarks = new Map();
    for (const m of marks) {
        const dateStr = new Date(m.timestamp).toLocaleDateString('sv-SE', { timeZone: 'Asia/Yekaterinburg' });
        if (!dayMarks.has(dateStr)) dayMarks.set(dateStr, { inTime: null, outTime: null, inOffice: 0 });
        const entry = dayMarks.get(dateStr);
        if (m.type === 'in') {
            entry.inTime = m.timestamp;
            entry.inOffice = m.in_office;
        } else if (m.type === 'out') {
            entry.outTime = m.timestamp;
        }
    }
    
    for (const date of dates) {
        // Проверяем, является ли день рабочим по графику
        let isWorkDay = true;
        
        if (scheduleType === '5/2') {
            // Для графика 5/2 суббота и воскресенье — выходные
            isWorkDay = !isRestDayBySchedule(scheduleType, cycleStart, date);
        }
        // Для графиков 4/2, 2/2 или отсутствия графика — все дни считаем рабочими
        
        if (!isWorkDay) continue;
        
        totalWorkDays++;
        
        const schedStatus = schedMap.get(date);
        if (schedStatus === 'vacation') { vacationDays++; continue; }
        if (schedStatus === 'sick') { sickDays++; continue; }
        if (schedStatus === 'dayoff') { dayoffDays++; continue; }
        if (schedStatus === 'remote') { remoteDays++; continue; }
        if (schedStatus === 'business') { businessDays++; continue; }
        
        const mark = dayMarks.get(date);
        if (mark?.inTime) {
            attendedDays++;
            const inHour = new Date(mark.inTime).getHours();
            const inMin = new Date(mark.inTime).getMinutes();
            // Опоздание: после 9:10
            if (inHour > 9 || (inHour === 9 && inMin > 10)) lateDays++;
        }
    }
    
    return {
        totalWorkDays,
        attendedDays,
        vacationDays,
        sickDays,
        dayoffDays,
        remoteDays,
        businessDays,
        lateDays,
        attendanceRate: totalWorkDays > 0 ? Math.round(attendedDays / totalWorkDays * 100) : 0
    };
}

/** Пакетная проверка: Map userId → { isRest, scheduleType } */
async function getBatchWorkScheduleStatus(userIds, date) {
    if (!userIds.length) return new Map();
    const { rows } = await pool.query(
        `SELECT * FROM employee_work_schedules WHERE user_id = ANY($1)`, [userIds.map(String)]);
    const result = new Map();
    for (const ws of rows) {
        const rest = isRestDayBySchedule(ws.schedule_type, ws.cycle_start, date || todaySV());
        result.set(ws.user_id, { isRest: rest, scheduleType: ws.schedule_type });
    }
    return result;
}

/** Пакетная проверка по диапазону дат: Map userId → { scheduleType, days: Map<date,bool> } */
async function getBatchWorkScheduleForDates(userIds, dates) {
    if (!userIds.length || !dates.length) return new Map();
    const { rows } = await pool.query(
        `SELECT * FROM employee_work_schedules WHERE user_id = ANY($1)`, [userIds.map(String)]);
    const result = new Map();
    for (const ws of rows) {
        const dayMap = new Map();
        for (const d of dates) dayMap.set(d, isRestDayBySchedule(ws.schedule_type, ws.cycle_start, d));
        result.set(ws.user_id, { scheduleType: ws.schedule_type, days: dayMap });
    }
    return result;
}

/** Назначить/обновить тип графика сотрудника */
async function setEmpWorkSchedule(userId, userName, scheduleType, cycleStart, dateEnd, assignedBy) {
    await pool.query(`
        INSERT INTO employee_work_schedules (user_id, user_name, schedule_type, cycle_start, date_end, assigned_by, assigned_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())
        ON CONFLICT (user_id) DO UPDATE SET
            user_name = EXCLUDED.user_name,
            schedule_type = EXCLUDED.schedule_type,
            cycle_start = EXCLUDED.cycle_start,
            date_end = EXCLUDED.date_end,
            assigned_by = EXCLUDED.assigned_by,
            updated_at = NOW()
    `, [String(userId), userName, scheduleType, cycleStart, dateEnd || null, assignedBy || null]);
}

/** Удалить тип графика у сотрудника */
async function removeEmpWorkSchedule(userId) {
    const { rowCount } = await pool.query(
        `DELETE FROM employee_work_schedules WHERE user_id=$1`, [String(userId)]);
    return rowCount > 0;
}

/** Все назначенные типы графиков */
async function getAllEmpWorkSchedules() {
    const { rows } = await pool.query(`SELECT * FROM employee_work_schedules ORDER BY user_name`);
    return rows;
}

function formatWorkScheduleInfo(ws) {
    if (!ws) return 'Не назначен';
    const info   = WORK_SCHEDULE_TYPES[ws.schedule_type];
    const startRu = new Date(ws.cycle_start).toLocaleDateString('ru-RU');
    return `${info?.label || ws.schedule_type} (цикл с ${startRu})`;
}

async function shouldSendReminder(userId) {
    const today = todaySV();
    
    // 1. Проверяем расписание (отпуск, больничный, выходной)
    const sched = await getActiveSchedule(userId);
    if (sched && ['vacation', 'sick', 'dayoff'].includes(sched.status)) {
        console.log(`📅 ${userId} — сегодня на расписании (${sched.status}), напоминание не нужно`);
        return false;
    }
    
    // 2. Проверяем тип рабочего графика
    const wsStatus = await getWorkScheduleStatus(userId, today);
    
    // 3. Если есть график и сегодня выходной — не отправляем
    if (wsStatus && wsStatus.isRest) {
        console.log(`📅 ${userId} — выходной по графику ${wsStatus.scheduleType}, напоминание не нужно`);
        return false;
    }
    
    // 4. Если графика нет — отправляем каждый день (включая субботу и воскресенье)
    // 5. Если график есть и сегодня рабочий день — отправляем
    
    return true;
}

// ─── Администраторы ───────────────────────────────────────────────────────────
// ─── Audit util ───────────────────────────────────────────────────────────────
async function logAudit(action, actor, target = null, details = {}, domain = null) {
  const actorId = actor?.id != null ? String(actor.id) : null;
  const actorName = actor?.name || null;

  const targetId = target?.id != null ? String(target.id) : null;
  const targetName = target?.name || null;

  try {
    await pool.query(
      `INSERT INTO audit_log(action, actor_user_id, actor_user_name, target_user_id, target_user_name, domain, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        action,
        actorId,
        actorName,
        targetId,
        targetName,
        domain,
        JSON.stringify(details || {})
      ]
    );
  } catch (e) {
    console.error('❌ logAudit error:', e.message);
  }
}
async function isAdmin(userId) {
    if (String(userId) === String(MANAGER_ID)) return true;
    const { rows } = await pool.query(`SELECT 1 FROM admins WHERE user_id=$1`, [String(userId)]);
    return rows.length > 0;
}

async function addAdmin(userId, userName) {
    await pool.query(
        `INSERT INTO admins (user_id, user_name) VALUES ($1,$2)
         ON CONFLICT (user_id) DO UPDATE SET user_name=EXCLUDED.user_name, added_at=NOW()`,
        [String(userId), userName]);
}

async function removeAdmin(userId) {
    if (String(userId) === String(MANAGER_ID)) return;
    await pool.query(`DELETE FROM admins WHERE user_id=$1`, [String(userId)]);
}

async function listAdmins() {
    const { rows } = await pool.query(`SELECT user_id, user_name FROM admins ORDER BY added_at`);
    return rows;
}

// ─── Проверка активного режима администратора ──────────────────────────────
async function isInAdminMode(userId) {
    const { rows } = await pool.query(
        `SELECT 1 FROM pending_input 
         WHERE user_id=$1 AND action='admin_session'`, 
        [String(userId)]
    );
    return rows.length > 0;
}

// Обновляет время сессии чтобы крон её не удалил
async function touchAdminSession(userId) {
    await pool.query(
        `UPDATE pending_input SET created_at=NOW() 
         WHERE user_id=$1 AND action='admin_session'`,
        [String(userId)]
    );
}

// ─── Ожидание ввода ───────────────────────────────────────────────────────────

async function setPending(userId, action, step, data = {}) {
    await pool.query(
        `INSERT INTO pending_input (user_id,action,step,data,created_at)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (user_id) DO UPDATE SET action=EXCLUDED.action, step=EXCLUDED.step, data=EXCLUDED.data, created_at=NOW()`,
        [String(userId), action, step, JSON.stringify(data)]);
}

async function getPending(userId) {
    const { rows } = await pool.query(`SELECT * FROM pending_input WHERE user_id=$1`, [String(userId)]);
    return rows[0] || null;
}

async function clearPending(userId) {
    await pool.query(`DELETE FROM pending_input WHERE user_id=$1`, [String(userId)]);
}

// ─── Посещаемость ─────────────────────────────────────────────────────────────

async function getLastMark(userId) {
    const { rows } = await pool.query(
        `SELECT type, timestamp FROM attendance
         WHERE user_id=$1
           AND (timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date=(NOW() AT TIME ZONE 'Asia/Yekaterinburg')::date
         ORDER BY timestamp DESC LIMIT 1`, [userId]);
    return rows[0] || null;
}

async function hasMarkedToday(userId) {
    const { rows } = await pool.query(
        `SELECT 1 FROM attendance
         WHERE user_id=$1
           AND (timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date=(NOW() AT TIME ZONE 'Asia/Yekaterinburg')::date
         LIMIT 1`, [userId]);
    return rows.length > 0;
}

async function getTodayMarks(userId) {
    const { rows } = await pool.query(
        `SELECT type, timestamp, in_office FROM attendance
         WHERE user_id=$1
           AND (timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date=(NOW() AT TIME ZONE 'Asia/Yekaterinburg')::date
         ORDER BY timestamp`, [userId]);
    return rows;
}

// ─── Расписание ───────────────────────────────────────────────────────────────

async function getActiveSchedule(userId) {
    const today = todaySV();
    const { rows } = await pool.query(
        `SELECT * FROM schedules WHERE user_id=$1 AND date_from<=$2 AND date_to>=$2 ORDER BY created_at DESC LIMIT 1`,
        [String(userId), today]);
    return rows[0] || null;
}

async function getSchedulesToday() {
    const today = todaySV();
    const { rows } = await pool.query(
        `SELECT * FROM schedules WHERE date_from<=$1 AND date_to>=$1 ORDER BY user_name`, [today]);
    return rows;
}

// ─── Реестр сотрудников ───────────────────────────────────────────────────────

// dialog_id сохраняем чтобы потом слать уведомления в чат бота
async function registerEmployee(userId, userName, domain, dialogId) {
    await pool.query(
        `INSERT INTO employees (user_id, user_name, domain, dialog_id, first_seen, last_seen)
         VALUES ($1,$2,$3,$4,NOW(),NOW())
         ON CONFLICT (user_id) DO UPDATE SET
             user_name  = EXCLUDED.user_name,
             dialog_id  = COALESCE(EXCLUDED.dialog_id, employees.dialog_id),
             last_seen  = NOW()`,
        [String(userId), userName, domain, dialogId || null]);
}

async function getEmployeeDialogId(userId) {
    const { rows } = await pool.query(`SELECT dialog_id FROM employees WHERE user_id=$1`, [String(userId)]);
    return rows[0]?.dialog_id || null;
}

async function syncAllEmployees(domain, accessToken) {
    try {
        let start = 0, total = 0;
        do {
            const resp = await callBitrix(domain, accessToken, 'user.get', { ACTIVE: true, start });
            if (!resp?.result?.length) break;
            for (const u of resp.result) {
                const name = `${u.NAME || ''} ${u.LAST_NAME || ''}`.trim();
                if (name) await registerEmployee(String(u.ID), name, domain, null);
            }
            total = resp.total || 0;
            start += resp.result.length;
        } while (start < total);
        console.log(`✅ Синхронизировано сотрудников: ${start}`);
        return start;
    } catch (err) {
        console.error('❌ syncAllEmployees:', err.message);
        return 0;
    }
}

// ─── Bitrix24: поиск пользователей ────────────────────────────────────────────

async function searchBitrixUsers(domain, accessToken, query) {
    let users = [];
    const r1 = await callBitrix(domain, accessToken, 'user.search', { NAME: query, ACTIVE: true });
    if (r1?.result?.length) users = r1.result;
    if (!users.length) {
        const r2 = await callBitrix(domain, accessToken, 'user.search', { LAST_NAME: query, ACTIVE: true });
        if (r2?.result?.length) users = r2.result;
    }
    return users.map(u => ({
        id:   String(u.ID),
        name: `${u.NAME || ''} ${u.LAST_NAME || ''}`.trim(),
    }));
}

async function getBitrixUser(domain, accessToken, userId) {
    const resp = await callBitrix(domain, accessToken, 'user.get', { ID: userId });
    if (resp?.result?.length) {
        const u = resp.result[0];
        return { id: String(u.ID), name: `${u.NAME || ''} ${u.LAST_NAME || ''}`.trim() };
    }
    return null;
}

// ─── Приветствие ──────────────────────────────────────────────────────────────

function buildGreeting(userName, firstName, adminMode, alreadyMarked) {
    const hour = parseInt(new Date().toLocaleString('ru-RU', { hour:'numeric', hour12:false, timeZone:'Asia/Yekaterinburg' }));
    let timeEmoji, timeGreeting;
    if      (hour >= 5  && hour < 12) { timeEmoji = '🌅'; timeGreeting = 'Доброе утро'; }
    else if (hour >= 12 && hour < 17) { timeEmoji = '☀️';  timeGreeting = 'Добрый день'; }
    else if (hour >= 17 && hour < 22) { timeEmoji = '🌆'; timeGreeting = 'Добрый вечер'; }
    else                               { timeEmoji = '🌙'; timeGreeting = 'Доброй ночи'; }

    const name = firstName || (userName ? userName.split(' ')[0] : 'друг');

    if (adminMode) {
        return (
            `${timeEmoji} ${timeGreeting}, ${name}! 👋\n\n` +
            `🔐 Вы в режиме администратора.\n\n` +
            `📌 Что доступно:\n` +
            `• 📋 Отчёты — приход/уход сотрудников\n` +
            `• 👥 Кто в офисе — онлайн-список\n` +
            `• 🗓  Расписание — отпуска, больничные, выходные\n` +
            `• 👤 Управление — добавить/удалить администратора\n` + 
            `• 📊 Графики работы — настроить графики сотрудникам\n` +
            `• 📤 Отчёт на почту — файл Excel с отчётом\n\n` +
            `⬇️ Выбирай действие:`
        );
    }
    if (alreadyMarked) {
        return (
            `${timeEmoji} ${timeGreeting}, ${name}! 👋\n\n` +
            `✅ Ты уже отмечался сегодня — всё зафиксировано!\n\n` +
            `Если нужно посмотреть свои отметки или уйти — кнопки ниже 👇`
        );
    }
    return (
        `${timeEmoji} ${timeGreeting}, ${name}! Рад тебя видеть 😊\n\n` +
        `Я твой помощник по учёту рабочего времени.\n` +
        `Не забудь отметиться — это займёт всего пару секунд! ⏱\n\n` +
        `📌 Что я умею:\n` +
        `• ✅ Пришёл — зафиксировать начало дня\n` +
        `• 🚪 Ушёл — зафиксировать конец дня\n` +
        `• 📊 Статус — посмотреть свои отметки\n` +
        `• ❓ Помощь — справка\n\n` +
        `⬇️ Выбирай нужное действие:`
    );
}

// ─── Клавиатуры ───────────────────────────────────────────────────────────────

function kbMain() {
    return [
        { TEXT:'✅ Пришёл',  COMMAND:'arrived', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#29b36b', TEXT_COLOR:'#ffffff' },
        { TEXT:'🚪 Ушёл',   COMMAND:'left',    COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#e05c5c', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'📊 Статус', COMMAND:'status',  COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#5b8def', TEXT_COLOR:'#ffffff' },
        { TEXT:'❓ Помощь', COMMAND:'help',    COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#888888', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'📈 История', COMMAND:'history_menu', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#f39c12', TEXT_COLOR:'#ffffff' },
    ];
}

function kbMainAdmin() {
    return [
        { TEXT:'✅ Пришёл',  COMMAND:'arrived', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#29b36b', TEXT_COLOR:'#ffffff' },
        { TEXT:'🚪 Ушёл',   COMMAND:'left',    COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#e05c5c', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'📊 Статус', COMMAND:'status',  COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#5b8def', TEXT_COLOR:'#ffffff' },
        { TEXT:'❓ Помощь', COMMAND:'help',    COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#888888', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'🔐 Режим администратора', COMMAND:'admin_enter', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#7b4fa6', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'📈 История', COMMAND:'history_menu', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#f39c12', TEXT_COLOR:'#ffffff' },
    ];
}

function kbAdmin() {
    return [
        { TEXT:'📋 Отчёт сегодня',   COMMAND:'report_today', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#5b8def', TEXT_COLOR:'#ffffff' },
        { TEXT:'📅 Отчёт за неделю', COMMAND:'report_week',  COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#5b8def', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'📆 Отчёт за месяц',  COMMAND:'report_month', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#3a7bd5', TEXT_COLOR:'#ffffff' },
        { TEXT:'👥 Кто в офисе',     COMMAND:'who_in',       COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#29b36b', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'🗓 Расписание',       COMMAND:'schedule',     COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#e07b29', TEXT_COLOR:'#ffffff' },
        { TEXT:'📊 Графики работы',   COMMAND:'work_sched',   COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#6a4c9c', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'👤 Управление',       COMMAND:'admin_manage', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#7b4fa6', TEXT_COLOR:'#ffffff' },
        { TEXT:'📤 Отчёт на почту',   COMMAND:'send_report',  COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#2e7d32', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TYPE:'NEWLINE' },
        { TEXT:'🧹 Удалить отметки', COMMAND:'att_delete', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#c0392b', TEXT_COLOR:'#ffffff' },
 { TEXT:'🧾 Журнал действий', COMMAND:'audit', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#34495e', TEXT_COLOR:'#ffffff' },
        { TEXT:'🔓 Выйти из админа',  COMMAND:'admin_logout', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#888888', TEXT_COLOR:'#ffffff' },
    ];
}

function kbWorkSched() {
    return [
        { TEXT:'➕ Назначить график', COMMAND:'ws_assign', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#29b36b', TEXT_COLOR:'#ffffff' },
        { TEXT:'📋 Список графиков',  COMMAND:'ws_list',   COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#5b8def', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'👥 Массово',          COMMAND:'ws_bulk',   COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#7b4fa6', TEXT_COLOR:'#ffffff' },
        { TEXT:'❌ Удалить график',   COMMAND:'ws_remove', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#c0392b', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'◀️ Назад',            COMMAND:'admin_back', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#555555', TEXT_COLOR:'#ffffff' },
    ];
}

function kbWorkSchedType() {
    const colors = ['#5b8def','#3a7bd5','#2d8cff'];
    const btns = Object.keys(WORK_SCHEDULE_TYPES).map((type, i) => ({
        TEXT: WORK_SCHEDULE_TYPES[type].label, COMMAND: `ws_type_${type.replace('/','_')}`,
        COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR: colors[i] || '#5b8def', TEXT_COLOR:'#ffffff',
    }));
    btns.push({ TYPE:'NEWLINE' });
    btns.push({ TEXT:'❌ Отмена', COMMAND:'cancel_input', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#888888', TEXT_COLOR:'#ffffff' });
    return btns;
}

function kbSchedule() {
    return [
        { TEXT:'🏖 Отпуск',         COMMAND:'sched_vacation', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#f4a724', TEXT_COLOR:'#ffffff' },
        { TEXT:'🤒 Больничный',     COMMAND:'sched_sick',     COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#e05c5c', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'📅 Выходной',       COMMAND:'sched_dayoff',   COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#888888', TEXT_COLOR:'#ffffff' },
        { TEXT:'🏠 Удалённо',       COMMAND:'sched_remote',   COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#5b8def', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'✈️ Командировка',   COMMAND:'sched_business', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#3a7bd5', TEXT_COLOR:'#ffffff' },
        { TEXT:'📋 Список',         COMMAND:'sched_list',     COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#29b36b', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'👥 Массово',         COMMAND:'sched_bulk',    COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#7b4fa6', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'🗑 Удалить запись',  COMMAND:'sched_delete',  COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#c0392b', TEXT_COLOR:'#ffffff' },
        { TEXT:'◀️ Назад',           COMMAND:'admin_back',    COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#555555', TEXT_COLOR:'#ffffff' },
    ];
}

// ─── Клавиатуры для массового создания расписания ─────────────────────────────
function kbBulkAddMore(selectedUsers) {
    const btns = [];
    if ((selectedUsers || []).length < 20) {
        btns.push({ TEXT:'➕ Добавить ещё', COMMAND:'bulk_add_more', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#29b36b', TEXT_COLOR:'#ffffff' });
    }
    btns.push({ TEXT:'✅ Готово — выбрать тип', COMMAND:'bulk_done_select', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#3a7bd5', TEXT_COLOR:'#ffffff' });
    btns.push({ TYPE:'NEWLINE' });
    btns.push({ TEXT:'❌ Отмена', COMMAND:'cancel_input', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#888888', TEXT_COLOR:'#ffffff' });
    return btns;
}

function kbBulkConflict() {
    return [
        { TEXT:'✅ Перезаписать конфликты', COMMAND:'bulk_sched_overwrite', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#e07b29', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'⏭ Пропустить конфликты',   COMMAND:'bulk_sched_skip',      COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#5b8def', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'❌ Отмена',                 COMMAND:'cancel_input',          COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#888888', TEXT_COLOR:'#ffffff' },
    ];
}

function kbBulkStatus() {
    return [
        { TEXT:'🏖 Отпуск',       COMMAND:'bulk_status_vacation', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#f4a724', TEXT_COLOR:'#ffffff' },
        { TEXT:'🤒 Больничный',   COMMAND:'bulk_status_sick',     COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#e05c5c', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'📅 Выходной',     COMMAND:'bulk_status_dayoff',   COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#888888', TEXT_COLOR:'#ffffff' },
        { TEXT:'🏠 Удалённо',     COMMAND:'bulk_status_remote',   COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#5b8def', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'✈️ Командировка', COMMAND:'bulk_status_business', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#3a7bd5', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'❌ Отмена',       COMMAND:'cancel_input',          COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#888888', TEXT_COLOR:'#ffffff' },
    ];
}

// ─── Клавиатура массового назначения графиков ─────────────────────────────────
function kbWsBulkAddMore(selectedUsers) {
    const btns = [];
    if ((selectedUsers || []).length < 20) {
        btns.push({ TEXT:'➕ Добавить ещё', COMMAND:'ws_bulk_add_more', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#29b36b', TEXT_COLOR:'#ffffff' });
    }
    btns.push({ TEXT:'✅ Готово — выбрать график', COMMAND:'ws_bulk_done_select', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#3a7bd5', TEXT_COLOR:'#ffffff' });
    btns.push({ TYPE:'NEWLINE' });
    btns.push({ TEXT:'❌ Отмена', COMMAND:'cancel_input', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#888888', TEXT_COLOR:'#ffffff' });
    return btns;
}

function kbWsBulkConflict() {
    return [
        { TEXT:'✅ Перезаписать конфликты', COMMAND:'ws_bulk_overwrite', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#e07b29', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'⏭ Пропустить конфликты',   COMMAND:'ws_bulk_skip',      COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#5b8def', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'❌ Отмена',                 COMMAND:'cancel_input',       COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#888888', TEXT_COLOR:'#ffffff' },
    ];
}

function kbWorkSchedTypeBulk() {
    const colors = ['#5b8def','#3a7bd5','#2d8cff'];
    const btns = Object.keys(WORK_SCHEDULE_TYPES).map((type, i) => ({
        TEXT: WORK_SCHEDULE_TYPES[type].label,
        COMMAND: `ws_bulk_type_${type.replace('/','_')}`,
        COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR: colors[i] || '#5b8def', TEXT_COLOR:'#ffffff',
    }));
    btns.push({ TYPE:'NEWLINE' });
    btns.push({ TEXT:'❌ Отмена', COMMAND:'cancel_input', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#888888', TEXT_COLOR:'#ffffff' });
    return btns;
}

// ─── Утилиты массового расписания ─────────────────────────────────────────────

async function checkBulkConflicts(userIds, dateFrom, dateTo) {
    if (!userIds.length) return new Map();
    const { rows } = await pool.query(`
        SELECT id, user_id, user_name, status, date_from, date_to
        FROM schedules
        WHERE user_id = ANY($1)
          AND date_from <= $2
          AND date_to   >= $3
        ORDER BY user_id, date_from
    `, [userIds.map(String), dateTo, dateFrom]);
    const map = new Map();
    for (const r of rows) {
        if (!map.has(r.user_id)) map.set(r.user_id, []);
        map.get(r.user_id).push(r);
    }
    return map;
}

async function insertBulkSchedule(employees, status, dateFrom, dateTo, comment, createdBy, conflictMap, overwriteUserIds) {
    const skipped = [];
    const created = [];
    for (const emp of employees) {
        const uid = String(emp.id);
        const conflicts = conflictMap.get(uid) || [];
        if (conflicts.length > 0 && !overwriteUserIds.includes(uid)) {
            skipped.push(emp.name);
            continue;
        }
        if (conflicts.length > 0) {
            const conflictIds = conflicts.map(c => c.id);
            await pool.query(`DELETE FROM schedules WHERE id = ANY($1)`, [conflictIds]);
        }
        await pool.query(
            `INSERT INTO schedules (user_id, user_name, status, date_from, date_to, comment, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [uid, emp.name, status, dateFrom, dateTo, comment || null, String(createdBy)]
        );
        created.push(emp.name);
    }
    return { created, skipped };
}

function kbAdminManage() {
    return [
        { TEXT:'➕ Добавить админа', COMMAND:'admin_add',    COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#29b36b', TEXT_COLOR:'#ffffff' },
        { TEXT:'➖ Удалить админа',  COMMAND:'admin_remove', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#e05c5c', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'📋 Список админов',  COMMAND:'admin_list',   COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#5b8def', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'◀️ Назад',           COMMAND:'admin_back',   COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#555555', TEXT_COLOR:'#ffffff' },
    ];
}

function kbEmailPeriod() {
    return [
        { TEXT:'📋 Сегодня', COMMAND:'email_today', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#5b8def', TEXT_COLOR:'#ffffff' },
        { TEXT:'📅 Неделя',  COMMAND:'email_week',  COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#5b8def', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'📆 Месяц',   COMMAND:'email_month', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#3a7bd5', TEXT_COLOR:'#ffffff' },
        { TEXT:'◀️ Назад',   COMMAND:'admin_back',  COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#555555', TEXT_COLOR:'#ffffff' },
    ];
}

function kbGeo(url, type) {
    return [
        { TEXT: type === 'in' ? '📍 Подтвердить приход' : '📍 Подтвердить уход',
          LINK: url, DISPLAY: 'LINE', BG_COLOR: '#2d8cff', TEXT_COLOR: '#ffffff' },
        { TYPE: 'NEWLINE' },
        { TEXT: '◀️ Назад', COMMAND: 'menu', COMMAND_PARAMS: '', DISPLAY: 'LINE', BG_COLOR: '#888888', TEXT_COLOR: '#ffffff' },
    ];
}

function kbCancel() {
    return [
        { TEXT:'❌ Отмена', COMMAND:'cancel_input', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#888888', TEXT_COLOR:'#ffffff' },
    ];
}

function kbUserSelect(users) {
    const btns = [];
    users.slice(0, 5).forEach((u, i) => {
        if (i > 0 && i % 2 === 0) btns.push({ TYPE:'NEWLINE' });
        btns.push({ TEXT: u.name, COMMAND: `select_user_${i}`, COMMAND_PARAMS: '', DISPLAY: 'LINE', BG_COLOR: '#5b8def', TEXT_COLOR: '#ffffff' });
    });
    btns.push({ TYPE:'NEWLINE' });
    btns.push({ TEXT:'🔍 Искать снова', COMMAND:'sched_search_again', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#e07b29', TEXT_COLOR:'#ffffff' });
    btns.push({ TEXT:'❌ Отмена',       COMMAND:'cancel_input',       COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#888888', TEXT_COLOR:'#ffffff' });
    return btns;
}

async function mainKb(userId) {
    return (await isAdmin(userId)) ? kbMainAdmin() : kbMain();
}

function kbMorningReminder() {
    return [
        { TEXT:'✅ Пришёл', COMMAND:'arrived', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#29b36b', TEXT_COLOR:'#ffffff' }
    ];
}

function kbEveningReminder() {
    return [
        { TEXT:'🚪 Ушёл', COMMAND:'left', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#e05c5c', TEXT_COLOR:'#ffffff' }
    ];
}

function kbHistoryPeriod() {
    return [
        { TEXT:'📅 За неделю', COMMAND:'history_week', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#5b8def', TEXT_COLOR:'#ffffff' },
        { TEXT:'📆 За месяц',  COMMAND:'history_month', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#3a7bd5', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'◀️ Назад',     COMMAND:'menu', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#888888', TEXT_COLOR:'#ffffff' },
    ];
}

// ─── Excel / Email — делегируем в reports.js ─────────────────────────────────

async function buildExcelReport(period) {
    return reports.buildExcelReport(pool, period);
}

async function sendReportByEmail(period) {
    return reports.sendReportByEmail(pool, period, smtpConfig);
}

// ─── БД: порталы, посещаемость, токены ───────────────────────────────────────

async function savePortal(domain, accessToken, refreshToken, botId, clientEndpoint) {
    await pool.query(
        `INSERT INTO portals (domain,access_token,refresh_token,bot_id,client_endpoint,updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (domain) DO UPDATE SET
             access_token    = EXCLUDED.access_token,
             refresh_token   = COALESCE(NULLIF($3,''), portals.refresh_token),
             bot_id          = COALESCE(NULLIF($4,''), portals.bot_id),
             client_endpoint = COALESCE(NULLIF($5,''), portals.client_endpoint),
             updated_at      = NOW()`,
        [domain, accessToken, refreshToken||'', botId||'', clientEndpoint||'']);
}

async function getPortal(domain) {
    const { rows } = await pool.query(`SELECT * FROM portals WHERE domain=$1`, [domain]);
    return rows[0] || null;
}

// Возвращает данные первого активного портала (домен, токен, botId)
async function getActivePortal() {
    const { rows } = await pool.query(`
        SELECT domain, access_token, bot_id 
        FROM portals 
        ORDER BY updated_at DESC 
        LIMIT 1
    `);
    if (!rows.length) throw new Error('Нет зарегистрированного портала');
    return { domain: rows[0].domain, accessToken: rows[0].access_token, botId: rows[0].bot_id };
}

async function morningReminder() {
    try {
        const { domain, accessToken, botId } = await getActivePortal();
        const today = todaySV();

        const { rows: employees } = await pool.query(`
            SELECT user_id, user_name, dialog_id
            FROM employees
            WHERE dialog_id IS NOT NULL
        `);

        for (const emp of employees) {
            // Уже отметился?
            const { rows: marked } = await pool.query(`
                SELECT 1 FROM attendance
                WHERE user_id = $1
                  AND (timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date = $2::date
                LIMIT 1
            `, [emp.user_id, today]);
            if (marked.length > 0) continue;
            
            // Проверяем, нужно ли отправлять напоминание
            const shouldSend = await shouldSendReminder(emp.user_id);
            if (!shouldSend) continue;

            const message = `🌅 Доброе утро! Не забудь отметить приход на работе.`;
            await notifyUserInBotChat(domain, accessToken, botId, emp.user_id, message, kbMorningReminder());
            console.log(`📨 Напоминание отправлено ${emp.user_name}`);
        }
    } catch (err) {
        console.error('❌ morningReminder:', err.message);
    }
}

async function eveningReminder() {
    try {
        const { domain, accessToken, botId } = await getActivePortal();
        const today = todaySV();

        const { rows: needRemind } = await pool.query(`
            SELECT DISTINCT a.user_id, e.user_name
            FROM attendance a
            JOIN employees e ON e.user_id = a.user_id
            WHERE (a.timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date = $1::date
              AND a.type = 'in'
              AND NOT EXISTS (
                  SELECT 1 FROM attendance a2
                  WHERE a2.user_id = a.user_id
                    AND a2.type = 'out'
                    AND (a2.timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date = $1::date
              )
        `, [today]);

        for (const emp of needRemind) {
            // Проверяем, нужно ли отправлять напоминание
            const shouldSend = await shouldSendReminder(emp.user_id);
            if (!shouldSend) continue;

            const message = `🌆 Рабочий день подходит к концу. Не забудь отметить уход.`;
            await notifyUserInBotChat(domain, accessToken, botId, emp.user_id, message, kbEveningReminder());
            console.log(`📨 Напоминание об уходе → ${emp.user_name}`);
        }
    } catch (err) {
        console.error('❌ eveningReminder:', err.message);
    }
}

async function saveAttendance(userId, userName, domain, type, lat, lon, inOffice, isRemote = false) {
    const { rows } = await pool.query(
        `INSERT INTO attendance (user_id,user_name,domain,type,latitude,longitude,in_office)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [userId, userName, domain, type, lat, lon, isRemote ? 0 : (inOffice ? 1 : 0)]
    );
    return rows[0].id;
}

async function saveGeoToken(token, userId, userName, dialogId, botId, domain, accessToken, type) {
    await pool.query(
        `INSERT INTO geo_tokens (token,user_id,user_name,dialog_id,bot_id,domain,access_token,type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (token) DO UPDATE SET
             user_id=EXCLUDED.user_id, user_name=EXCLUDED.user_name,
             dialog_id=EXCLUDED.dialog_id, bot_id=EXCLUDED.bot_id,
             domain=EXCLUDED.domain, access_token=EXCLUDED.access_token,
             type=EXCLUDED.type, created_at=NOW()`,
        [token, userId, userName, dialogId, botId, domain, accessToken, type]);
}

async function popGeoToken(token) {
    const { rows } = await pool.query(`DELETE FROM geo_tokens WHERE token=$1 RETURNING *`, [token]);
    return rows[0] || null;
}

// ─── Bitrix24 API ─────────────────────────────────────────────────────────────

async function doRefreshToken(domain, rToken) {
    try {
        const resp = await axios.get('https://oauth.bitrix24.tech/oauth/token/', {
            params: { grant_type:'refresh_token', client_id:CLIENT_ID, client_secret:CLIENT_SECRET, refresh_token:rToken }
        });
        if (resp.data?.access_token) {
            await savePortal(domain, resp.data.access_token, resp.data.refresh_token, '', '');
            return resp.data.access_token;
        }
    } catch(err) { console.error('❌ refresh token:', err.message); }
    return null;
}

async function callBitrix(domain, accessToken, method, params = {}) {
    try {
        const resp = await axios.post(
            `https://${domain}/rest/${method}`, params,
            { params: { auth: accessToken }, timeout: 10000 });
        return resp.data;
    } catch(err) {
        if (err.response?.data?.error === 'expired_token') {
            const portal = await getPortal(domain);
            if (portal?.refresh_token) {
                const newToken = await doRefreshToken(domain, portal.refresh_token);
                if (newToken) return callBitrix(domain, newToken, method, params);
            }
        }
        console.error(`❌ Bitrix API [${method}]:`, err.response?.data || err.message);
        return null;
    }
}

async function sendMessage(domain, accessToken, botId, dialogId, message, keyboard) {
    const params = { BOT_ID:botId, DIALOG_ID:dialogId, MESSAGE:message };
    if (keyboard?.length) params.KEYBOARD = keyboard;
    const r = await callBitrix(domain, accessToken, 'imbot.message.add', params);
    if (r?.result === false) console.error('❌ imbot.message.add failed:', JSON.stringify(r));
    return r;
}

async function sendMessageWithRetry(domain, accessToken, botId, dialogId, message, keyboard, retries = 2) {
    let currentToken = accessToken;
    
    for (let i = 0; i < retries; i++) {
        const result = await sendMessage(domain, currentToken, botId, dialogId, message, keyboard);
        
        // Если успешно — возвращаем результат
        if (result?.result !== false) return result;
        
        // Если ошибка — пробуем обновить токен
        console.log(`🔄 Попытка ${i + 1} не удалась, обновляем токен...`);
        
        const portal = await getPortal(domain);
        if (portal?.refresh_token) {
            const newToken = await doRefreshToken(domain, portal.refresh_token);
            if (newToken) {
                currentToken = newToken;
                console.log(`✅ Токен обновлён, повторяем попытку ${i + 2}`);
                continue;
            }
        }
        
        // Если обновить не удалось — ждём и пробуем ещё раз
        await new Promise(r => setTimeout(r, 1000));
    }
    
    console.error(`❌ Не удалось отправить сообщение после ${retries} попыток`);
    return null;
}

async function checkAllTokens() {
    const { rows: portals } = await pool.query(`SELECT domain, access_token, refresh_token, updated_at FROM portals`);
    
    for (const portal of portals) {
        try {
            // Проверяем токен простым запросом
            const resp = await axios.get(`https://${portal.domain}/rest/profile`, {
                params: { auth: portal.access_token },
                timeout: 5000
            });
            
            if (resp.data?.error === 'expired_token' && portal.refresh_token) {
                console.log(`🔄 Обновляем токен для ${portal.domain}`);
                const newToken = await doRefreshToken(portal.domain, portal.refresh_token);
                if (newToken) {
                    console.log(`✅ Токен обновлён для ${portal.domain}`);
                } else {
                    console.error(`❌ Не удалось обновить токен для ${portal.domain}`);
                }
            } else if (resp.data?.result) {
                console.log(`✅ Токен валиден для ${portal.domain}`);
            }
        } catch (err) {
            console.error(`❌ Ошибка проверки токена ${portal.domain}:`, err.message);
        }
    }
}

async function selfHealing() {
    try {
        // Проверяем, жив ли бот (отвечает ли /health)
        const response = await axios.get(`http://localhost:${port}/health`, { timeout: 5000 });
        if (response.data?.ok !== true) {
            console.error('⚠️ Бот не отвечает на /health');
            await notifyAdmin('⚠️ Бот не отвечает на health check, требуется перезагрузка');
            process.exit(1); // Render перезапустит
        }
        
        // Проверяем подключение к БД
        await pool.query('SELECT 1');
        
        // Проверяем токены
        await checkAllTokens();
        
        console.log('✅ Self-healing check passed');
    } catch (err) {
        console.error('❌ Self-healing check failed:', err.message);
        await notifyAdmin(`❌ Self-healing ошибка: ${err.message}`);
        process.exit(1);
    }
}

cron.schedule('*/30 * * * *', async () => {
    console.log('🔄 Health check и auto-recovery');
    await selfHealing();
});

// Уведомление сотруднику в его личный чат с ботом.
// dialog_id берём из таблицы employees — он сохраняется при первом открытии чата.
async function notifyUserInBotChat(domain, accessToken, botId, targetUserId, message, keyboard = null) {
    const dialogId = await getEmployeeDialogId(targetUserId);
    if (!dialogId) {
        console.warn(`⚠️ notifyUser: нет dialog_id для user ${targetUserId} — сотрудник ещё не открывал чат с ботом`);
        return null;
    }
    console.log(`📣 notifyUser → userId=${targetUserId}, dialog=${dialogId}`);
    return sendMessageWithRetry(domain, accessToken, botId, dialogId, message, keyboard);
}

// ─── Регистрация команд ───────────────────────────────────────────────────────

async function registerCommands(domain, accessToken, botId) {
    const handlerUrl = `https://${APP_DOMAIN}/imbot`;
    const cmds = [
        { cmd:'arrived',            title:'Пришёл' },
        { cmd:'left',               title:'Ушёл' },
        { cmd:'status',             title:'Статус' },
        { cmd:'help',               title:'Помощь' },
        { cmd:'menu',               title:'Меню' },
        { cmd:'admin_enter',        title:'Режим администратора' },
        { cmd:'admin_logout',       title:'Выйти из админа' },
        { cmd:'admin_back',         title:'Назад' },
        { cmd:'cancel_input',       title:'Отмена' },
        { cmd:'report_today',       title:'Отчёт сегодня' },
        { cmd:'report_week',        title:'Отчёт за неделю' },
        { cmd:'report_month',       title:'Отчёт за месяц' },
        { cmd:'who_in',             title:'Кто в офисе' },
        { cmd:'send_report',        title:'Отчёт на почту' },
        { cmd:'email_today',        title:'Email сегодня' },
        { cmd:'email_week',         title:'Email неделя' },
        { cmd:'email_month',        title:'Email месяц' },
        { cmd:'schedule',           title:'Расписание' },
        { cmd:'sched_vacation',     title:'Отпуск' },
        { cmd:'sched_sick',         title:'Больничный' },
        { cmd:'sched_dayoff',       title:'Выходной' },
        { cmd:'sched_remote',       title:'Удалённо' },
        { cmd:'sched_business',     title:'Командировка' },
        { cmd:'sched_list',         title:'Список расписания' },
        { cmd:'sched_delete',       title:'Удалить запись' },
        { cmd:'sched_search_again', title:'Искать снова' },
        { cmd:'select_user_0',      title:'Выбрать сотрудника 1' },
        { cmd:'select_user_1',      title:'Выбрать сотрудника 2' },
        { cmd:'select_user_2',      title:'Выбрать сотрудника 3' },
        { cmd:'select_user_3',      title:'Выбрать сотрудника 4' },
        { cmd:'select_user_4',      title:'Выбрать сотрудника 5' },
        { cmd:'admin_manage',       title:'Управление' },
        { cmd:'admin_add',          title:'Добавить админа' },
        { cmd:'admin_remove',       title:'Удалить админа' },
        { cmd:'admin_list',         title:'Список админов' },
        { cmd:'work_sched',         title:'Графики работы' },
        { cmd:'ws_list',            title:'Список графиков' },
        { cmd:'ws_assign',          title:'Назначить график' },
        { cmd:'ws_remove',          title:'Удалить график' },
        { cmd:'ws_type_5_2',        title:'График 5/2' },
        { cmd:'ws_type_4_2',        title:'График 4/2' },
        { cmd:'ws_type_2_2',        title:'График 2/2' },
        { cmd:'ws_select_0',        title:'Выбрать сотрудника 1' },
        { cmd:'ws_select_1',        title:'Выбрать сотрудника 2' },
        { cmd:'ws_select_2',        title:'Выбрать сотрудника 3' },
        { cmd:'ws_select_3',        title:'Выбрать сотрудника 4' },
        { cmd:'ws_select_4',        title:'Выбрать сотрудника 5' },
        { cmd:'history_week',        title:'История за неделю' },
        { cmd:'history_month',       title:'История за месяц' },
        { cmd:'history_menu',        title:'История' },
        { cmd:'ws_bulk',              title:'Массовое назначение графика' },
        { cmd:'ws_bulk_add_more',     title:'Добавить ещё сотрудника (график)' },
        { cmd:'ws_bulk_done_select',  title:'Завершить выбор (график)' },
        { cmd:'ws_bulk_type_5_2',     title:'График 5/2 массово' },
        { cmd:'ws_bulk_type_4_2',     title:'График 4/2 массово' },
        { cmd:'ws_bulk_type_2_2',     title:'График 2/2 массово' },
        { cmd:'ws_bulk_overwrite',    title:'Перезаписать конфликты графиков' },
        { cmd:'ws_bulk_skip',         title:'Пропустить конфликты графиков' },
        { cmd:'ws_bulk_select_0',     title:'Выбор сотрудника 1 (график)' },
        { cmd:'ws_bulk_select_1',     title:'Выбор сотрудника 2 (график)' },
        { cmd:'ws_bulk_select_2',     title:'Выбор сотрудника 3 (график)' },
        { cmd:'ws_bulk_select_3',     title:'Выбор сотрудника 4 (график)' },
        { cmd:'ws_bulk_select_4',     title:'Выбор сотрудника 5 (график)' },
        { cmd:'sched_bulk',          title:'Массовое расписание' },
        { cmd:'bulk_add_more',       title:'Добавить ещё сотрудника' },
        { cmd:'bulk_done_select',    title:'Завершить выбор сотрудников' },
        { cmd:'bulk_status_vacation',title:'Массово: отпуск' },
        { cmd:'bulk_status_sick',    title:'Массово: больничный' },
        { cmd:'bulk_status_dayoff',  title:'Массово: выходной' },
        { cmd:'bulk_status_remote',  title:'Массово: удалённо' },
        { cmd:'bulk_status_business',title:'Массово: командировка' },
        { cmd:'bulk_sched_overwrite',title:'Перезаписать конфликты' },
        { cmd:'bulk_sched_skip',     title:'Пропустить конфликты' },
        { cmd:'bulk_select_user_0',  title:'Массово: сотрудник 1' },
        { cmd:'bulk_select_user_1',  title:'Массово: сотрудник 2' },
        { cmd:'bulk_select_user_2',  title:'Массово: сотрудник 3' },
        { cmd:'bulk_select_user_3',  title:'Массово: сотрудник 4' },
        { cmd:'bulk_select_user_4',  title:'Массово: сотрудник 5' },
        { cmd:'audit', title:'Журнал действий' },
 { cmd:'att_delete', title:'Удалить отметки' },
    ];
    for (const c of cmds) {
        const r = await callBitrix(domain, accessToken, 'imbot.command.register', {
            BOT_ID: botId, COMMAND: c.cmd, HIDDEN: 'Y', EXTRANET_SUPPORT: 'N',
            EVENT_COMMAND_ADD: handlerUrl,
            LANG: [{ LANGUAGE_ID:'ru', TITLE:c.title, PARAMS:'' }, { LANGUAGE_ID:'en', TITLE:c.title, PARAMS:'' }],
        });
        console.log(`📎 command [${c.cmd}]:`, r?.result ? '✅' : '❌');
    }
}

async function registerBot(domain, accessToken, existingBotId) {
    const handlerUrl = `https://${APP_DOMAIN}/imbot`;
    if (existingBotId) {
        await callBitrix(domain, accessToken, 'imbot.unregister', { BOT_ID: existingBotId });
        await new Promise(r => setTimeout(r, 1500));
    }
    const resp = await callBitrix(domain, accessToken, 'imbot.register', {
        CODE:'attendance_bot', TYPE:'H',
        EVENT_MESSAGE_ADD: handlerUrl, EVENT_WELCOME_MESSAGE: handlerUrl, EVENT_BOT_DELETE: handlerUrl,
        PROPERTIES: { NAME:'Учёт времени', COLOR:'GREEN', DESCRIPTION:'Бот учёта присутствия', WORK_POSITION:'Помощник HR' }
    });
    const botId = String(resp?.result || '');
    if (botId) {
        console.log('✅ Бот зарегистрирован, ID:', botId);
        await registerCommands(domain, accessToken, botId);
    } else {
        console.error('❌ Ошибка регистрации:', JSON.stringify(resp));
    }
    return botId;
}

async function notifyAdmin(message, isError = true) {
    const { domain, accessToken, botId } = await getActivePortal();
    const adminId = MANAGER_ID;
    
    const dialogId = await getEmployeeDialogId(adminId);
    if (!dialogId) {
        console.warn('⚠️ Нет dialog_id для админа');
        return;
    }
    
    const icon = isError ? '🔴 ОШИБКА' : '⚠️ ВНИМАНИЕ';
    const fullMessage = `${icon}\n\n${message}\n\n📅 ${new Date().toLocaleString('ru-RU')}`;
    
    await sendMessage(domain, accessToken, botId, dialogId, fullMessage, null);
}

async function reportLateArrivals() {
    const today = todaySV();
    
    const { rows: lateArrivals } = await pool.query(`
        SELECT user_name, MIN(timestamp) as first_in
        FROM attendance
        WHERE (timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date = $1
          AND type = 'in'
          AND EXTRACT(HOUR FROM timestamp AT TIME ZONE 'Asia/Yekaterinburg') > 9
        GROUP BY user_name
        ORDER BY first_in
    `, [today]);
    
    if (lateArrivals.length === 0) return;
    
    let message = `⏰ ОПОЗДАНИЯ ЗА СЕГОДНЯ (${lateArrivals.length} чел.)\n\n`;
    for (const l of lateArrivals) {
        message += `• ${l.user_name} — в ${tzTime(l.first_in)}\n`;
    }
    
    await notifyAdmin(message, false);
}

async function reportNotMarked() {
    const today = todaySV();
    
    const { rows: allEmps } = await pool.query(`SELECT user_id, user_name FROM employees`);
    const { rows: marked } = await pool.query(`
        SELECT DISTINCT user_id FROM attendance
        WHERE (timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date = $1
    `, [today]);
    
    const markedIds = new Set(marked.map(m => m.user_id));
    const notMarked = allEmps.filter(e => !markedIds.has(e.user_id));
    
    if (notMarked.length === 0) return;
    
    let message = `❌ НЕ ОТМЕТИЛИСЬ УТРОМ (${notMarked.length} чел.)\n\n`;
    notMarked.forEach(e => { message += `• ${e.user_name}\n`; });
    message += `\nПожалуйста, напомните сотрудникам отметить приход.`;
    
    await notifyAdmin(message, false);
}

async function reportNotClosed() {
    const today = todaySV();
    
    const { rows: notClosed } = await pool.query(`
        SELECT user_name, MIN(timestamp) as first_in
        FROM attendance
        WHERE (timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date = $1
          AND type = 'in'
        GROUP BY user_name
        HAVING MAX(CASE WHEN type='out' THEN 1 ELSE 0 END) = 0
        ORDER BY first_in
    `, [today]);
    
    if (notClosed.length === 0) return;
    
    let message = `🚪 НЕ ЗАКРЫЛИ СМЕНУ (${notClosed.length} чел.)\n\n`;
    for (const n of notClosed) {
        message += `• ${n.user_name} (пришёл в ${tzTime(n.first_in)})\n`;
    }
    message += `\nРекомендуется напомнить сотрудникам отметить уход.`;
    
    await notifyAdmin(message, false);
}

// Отчёт об опозданиях в 10:30 Ект = 5:30 UTC
cron.schedule('30 5 * * *', async () => {
    await reportLateArrivals();
});

// Отчёт о неотметившихся в 12:00 Ект = 7:00 UTC
cron.schedule('0 7 * * *', async () => {
    await reportNotMarked();
});

// Отчёт о незакрытых сменах в 20:30 Ект = 15:30 UTC
cron.schedule('30 15 * * *', async () => {
    await reportNotClosed();
});

// ═════════════════════════════════════════════════════════════════════════════
//  МАРШРУТЫ
// ═════════════════════════════════════════════════════════════════════════════

app.post('/install', async (req, res) => {
    const AUTH_ID    = req.body.AUTH_ID    || req.body.auth_id    || '';
    const REFRESH_ID = req.body.REFRESH_ID || req.body.refresh_id || '';
    const ENDPOINT   = req.body.SERVER_ENDPOINT || req.body.server_endpoint || '';
    const domain     = req.body.DOMAIN || req.body.domain || req.query.DOMAIN || req.query.domain || '';

    if (AUTH_ID && domain) {
        const botsResp = await callBitrix(domain, AUTH_ID, 'imbot.bot.list', {});
        const ourBot   = Object.values(botsResp?.result || {}).find(b => b.CODE === 'attendance_bot');
        if (ourBot) {
            const existingId = String(ourBot.ID);
            await savePortal(domain, AUTH_ID, REFRESH_ID, existingId, ENDPOINT);
            await registerCommands(domain, AUTH_ID, existingId);
        } else {
            await savePortal(domain, AUTH_ID, REFRESH_ID, '', ENDPOINT);
            const botId = await registerBot(domain, AUTH_ID, null);
            if (botId) await savePortal(domain, AUTH_ID, REFRESH_ID, botId, ENDPOINT);
        }
    }

    res.send(`<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Учёт времени</title>
<script src="//api.bitrix24.com/api/v1/"></script>
<style>body{font-family:Arial,sans-serif;background:#f0f4ff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#fff;border-radius:16px;padding:40px;text-align:center;max-width:480px;width:90%;box-shadow:0 8px 24px rgba(0,0,0,.1)}
h1{color:#2e7d32;margin-bottom:16px}p{color:#555;line-height:1.6}</style></head>
<body><div class="card"><h1>🤖 Бот "Учёт времени" установлен!</h1>
<p>Найдите бота в списке чатов Битрикс24.<br>Бот управляется кнопками.</p></div>
<script>BX24.init(function(){BX24.installFinish();});</script></body></html>`);
});

app.get('/geo', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).send('Токен не найден');
    const safeToken = token.replace(/['"\\<>]/g, '');
    res.send(`<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Отметка присутствия</title>
<style>*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#f0f4ff;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#fff;border-radius:24px;padding:48px 32px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.12);max-width:340px;width:90%}
.icon{font-size:56px;margin-bottom:20px}h2{font-size:22px;color:#1a1a2e;margin-bottom:8px}p{font-size:14px;color:#666;line-height:1.5}
.spinner{width:40px;height:40px;margin:16px auto;border:4px solid #e0e0e0;border-top-color:#2d8cff;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}</style></head>
<body><div class="card"><div class="icon" id="icon">📍</div>
<h2 id="title">Определяем местоположение...</h2>
<div class="spinner" id="spinner"></div>
<p id="msg">Разрешите доступ к геолокации когда браузер спросит</p></div>
<script>
function done(icon,title,msg){
    document.getElementById('icon').textContent=icon;
    document.getElementById('title').textContent=title;
    document.getElementById('msg').textContent=msg;
    document.getElementById('spinner').style.display='none';
}
if(!navigator.geolocation){done('❌','Нет поддержки','Попробуйте Chrome или Safari');}
else{navigator.geolocation.getCurrentPosition(
    function(pos){
        done('⏳','Отправляем данные...','Подождите немного...');
        fetch('/confirm-geo',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({token:'${safeToken}',lat:pos.coords.latitude,lon:pos.coords.longitude})})
        .then(r=>r.json()).then(d=>{
            if(d.ok){done('✅','Отметка принята!','Готово! Можно закрыть эту страницу 😊');}
            else{done('❌','Ошибка',d.error||'Попробуйте ещё раз');}
            setTimeout(()=>window.close(),3000);
        }).catch(()=>done('❌','Ошибка сети','Проверьте подключение к интернету'));
    },
    function(err){
        var msgs={1:'Вы запретили геолокацию — разрешите в настройках.',2:'Не удалось определить местоположение.',3:'Превышено время ожидания.'};
        done('❌','Геолокация недоступна',msgs[err.code]||'Ошибка: '+err.message);
    },
    {timeout:15000,enableHighAccuracy:true,maximumAge:0});
}
</script></body></html>`);
});
// В app.js — добавить одну строку
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.post('/confirm-geo', async (req, res) => {
    const { token, lat, lon } = req.body;
    if (!token || lat == null || lon == null) return res.json({ ok:false, error:'Неверные данные' });

    const rec = await popGeoToken(token);
    if (!rec) return res.json({ ok:false, error:'Ссылка устарела или уже использована. Запроси новую в боте!' });

    const sched = await getActiveSchedule(rec.user_id);
const isRemote = sched && sched.status === 'remote';
    const { inOffice, officeName } = checkOffice(lat, lon);
    // Проверяем именно режим, а не просто права — иначе всем админам покажутся кнопки
    const userInAdminMode = await isInAdminMode(rec.user_id);
    const kb = userInAdminMode ? kbAdmin() : kbMain();

    if (!inOffice && !isRemote) {
        const hint = OFFICE2_LAT !== null
            ? `У вас два офиса — проверьте, что вы рядом с одним из них.`
            : `Подойдите ближе к зданию и попробуйте снова 🏢`;
        await sendMessage(rec.domain, rec.access_token, rec.bot_id, rec.dialog_id,
            `❌ Отметка ${rec.type === 'in' ? 'прихода' : 'ухода'} не принята!\n\n` +
            `📍 Вы находитесь вне радиуса офиса (${OFFICE_RADIUS} м).\n${hint}`, kb);
        return res.json({ ok:false, error:'Вы вне офиса. Отметка не принята.' });
    }

    const time = new Date().toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', timeZone:'Asia/Yekaterinburg' });
    await saveAttendance(rec.user_id, rec.user_name, rec.domain, rec.type, lat, lon, inOffice, isRemote);

    let text;
    if (rec.type === 'in') {
        text = `✅ Приход зафиксирован в ${time}!\n📍 ${officeName}\n\nУдачного рабочего дня! 💪`;
    } else {
        text = `🚪 Уход зафиксирован в ${time}!\n📍 ${officeName}`;
        const marks  = await getTodayMarks(rec.user_id);
        const inMark = marks.filter(m => m.type === 'in').at(-1);
        if (inMark) {
            const diff = (Date.now() - new Date(inMark.timestamp)) / 1000;
            text += `\n⏱ Отработано сегодня: ${formatDuration(diff)}`;
        }
        text += `\n\nОтличная работа — хорошего вечера! 🌆`;
    }

    await sendMessage(rec.domain, rec.access_token, rec.bot_id, rec.dialog_id, text, kb);
    res.json({ ok:true, in_office:true });
});

app.post('/imbot', async (req, res) => {
    res.json({ result:'ok' });
    try {
        const body  = req.body;
        console.log('🔍 RAW BODY:', JSON.stringify(body).slice(0, 500));
        const event = body.event || body.EVENT;
        const data  = body.data  || body.DATA  || {};
        const auth  = body.auth  || body.AUTH  || {};
        if (!event) return;

        const params  = data.PARAMS  || data.params  || {};
        const cmdData = data.COMMAND || data.command || {};

        const MESSAGE      = params.MESSAGE      || params.message      || '';
        const DIALOG_ID    = params.DIALOG_ID    || params.dialog_id    || cmdData.DIALOG_ID || '';
        const BOT_ID       = params.BOT_ID       || params.bot_id       || cmdData.BOT_ID    || '';
        const FROM_USER_ID = params.FROM_USER_ID || params.from_user_id || cmdData.USER_ID   || '';
        const USER_NAME    = params.USER_NAME    || params.user_name    || '';
        const FIRST_NAME   = data.USER?.FIRST_NAME || data.USER?.first_name || '';

        const COMMAND  = (cmdData.COMMAND || cmdData.command || '').toLowerCase().trim();
        const cleanMsg = MESSAGE.toLowerCase().trim();
        const msgCmd   = cleanMsg.startsWith('/') ? cleanMsg.slice(1).trim() : cleanMsg;
        const action   = COMMAND || msgCmd;

        const domain    = auth.domain || auth.DOMAIN || BITRIX_DOMAIN;
        let authToken   = auth.access_token || auth.ACCESS_TOKEN || '';
        const firstName = FIRST_NAME || (USER_NAME ? USER_NAME.split(' ')[0] : '');
        const userName  = USER_NAME || firstName || `Пользователь ${FROM_USER_ID}`;
        const geoUrl    = `https://${APP_DOMAIN}/geo`;

        if (domain && authToken) {
            const existing = await getPortal(domain);
            await savePortal(domain, authToken, existing?.refresh_token, BOT_ID || existing?.bot_id, existing?.client_endpoint);
        }
        if (!authToken) {
            const portal = await getPortal(domain);
            if (portal) authToken = portal.access_token;
            else { console.error('❌ Нет токена:', domain); return; }
        }

        const portal = await getPortal(domain);
        const botId  = BOT_ID || portal?.bot_id;
        if (!botId) { console.error('❌ Нет bot_id:', domain); return; }

        // Подтягиваем реальное имя из Битрикс24 если не пришло
        let resolvedName = userName;
        if (FROM_USER_ID && (!USER_NAME || USER_NAME.startsWith('Пользователь'))) {
            const b24user = await getBitrixUser(domain, authToken, FROM_USER_ID);
            if (b24user?.name) resolvedName = b24user.name;
        }

        // Регистрируем сотрудника + сохраняем dialog_id для будущих уведомлений
        if (FROM_USER_ID && resolvedName && DIALOG_ID) {
            await registerEmployee(FROM_USER_ID, resolvedName, domain, DIALOG_ID);
        }

        const userIsAdmin = await isAdmin(FROM_USER_ID);
        const pending     = await getPending(FROM_USER_ID);
        // Admin-флоу, которые доступны только администраторам
        const ADMIN_ACTIONS = new Set([
            'admin_session', 'ws_bulk', 'bulk_schedule',
            'ws_assign', 'ws_remove', 'schedule_add', 'schedule_delete',
            'admin_add', 'admin_remove',
        ]);
        const inAdminMode = userIsAdmin && (
            pending?.action === 'admin_session' ||
            (pending?.data?.adminSession === true && ADMIN_ACTIONS.has(pending?.action))
        );
        const kb = inAdminMode ? kbAdmin() : await mainKb(FROM_USER_ID);

        // Продлеваем сессию при каждом действии администратора
        if (inAdminMode) await touchAdminSession(FROM_USER_ID);

        if (event === 'ONIMBOTJOINCHAT') {
            const marked = await hasMarkedToday(FROM_USER_ID);
            await sendMessage(domain, authToken, botId, DIALOG_ID, buildGreeting(resolvedName, firstName, inAdminMode, marked), kb);
            return;
        }

        if (event !== 'ONIMBOTMESSAGEADD' && event !== 'ONIMCOMMANDADD') return;

        // Многошаговые диалоги
        if (pending && pending.action !== 'admin_session' && action !== 'cancel_input' && event === 'ONIMBOTMESSAGEADD') {
            await handlePendingInput(domain, authToken, botId, DIALOG_ID, FROM_USER_ID, resolvedName, MESSAGE, pending);
            return;
        }

        // Выбор сотрудника из списка поиска
        if (action.startsWith('select_user_') && pending?.action === 'schedule_select_user') {
            const idx  = parseInt(action.replace('select_user_', ''));
            const sel  = (pending.data.foundUsers || [])[idx];
            if (!sel) { await sendMessage(domain, authToken, botId, DIALOG_ID, `⚠️ Сотрудник не найден.`, kbCancel()); return; }
 // Выбор сотрудника для удаления отметок
 if (action.startsWith('select_user_') && pending?.action === 'att_delete_select_user') {
 const idx = parseInt(action.replace('select_user_', ''));
 const sel = (pending.data.foundUsers || [])[idx];
 if (!sel) { await sendMessage(domain, authToken, botId, DIALOG_ID, `⚠️ Сотрудник не найден.`, kbCancel()); return; }
 await setPending(FROM_USER_ID, 'att_delete', 'pick_date', { ...pending.data, targetUserId: sel.id, targetUserName: sel.name, adminSession: true });
 await sendMessage(domain, authToken, botId, DIALOG_ID, `👤 Сотрудник: ${sel.name}

📅 Введи дату (ДД.ММ.ГГГГ), за которую удалить отметки:`, kbCancel());
 return;
 }

            await setPending(FROM_USER_ID, 'schedule_add', 'date_from', { ...pending.data, userId: sel.id, userName: sel.name, adminSession: true });
            await sendMessage(domain, authToken, botId, DIALOG_ID, `👤 Сотрудник: ${sel.name}\n\n📅 Введи дату начала в формате ДД.ММ.ГГГГ:`, kbCancel());
            return;
        }

        if (action === 'sched_search_again' && pending?.data?.status) {
            await setPending(FROM_USER_ID, 'schedule_add', 'search_user', { status: pending.data.status, adminSession: true });
            await sendMessage(domain, authToken, botId, DIALOG_ID, `🔍 Введи имя или фамилию сотрудника для поиска:`, kbCancel());
            return;
        }

        if (action === 'cancel_input') {
            // Сохраняем флаг adminMode ДО очистки pending
            const wasInAdminMode = inAdminMode;
            await clearPending(FROM_USER_ID);
            // Восстанавливаем admin_session если был в режиме администратора
                if (wasInAdminMode) {
                    await setPending(FROM_USER_ID, 'admin_session', 'active');
                    await sendMessage(domain, authToken, botId, DIALOG_ID, 
                    `❌ Действие отменено.\n\n🔐 Режим администратора`, kbAdmin());
                 } else {
                    await sendMessage(domain, authToken, botId, DIALOG_ID, 
                    `❌ Действие отменено.`, await mainKb(FROM_USER_ID));
                }
            return;
        }

        if (action === 'admin_enter') {
            if (!userIsAdmin) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 У вас нет прав администратора.`, kb); return; }
            await setPending(FROM_USER_ID, 'admin_session', 'active');
            await sendMessage(domain, authToken, botId, DIALOG_ID, buildGreeting(resolvedName, firstName, true, false), kbAdmin());
            return;
        }

        if (action === 'admin_logout') {
            // Явный выход — только по этой команде
            await clearPending(FROM_USER_ID);
            const marked = await hasMarkedToday(FROM_USER_ID);
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `🔓 Вы вышли из режима администратора.\n\n` +
                buildGreeting(resolvedName, firstName, false, marked),
                await mainKb(FROM_USER_ID));
             return;
        }

        if (action === 'admin_back') {
            // Назад — возврат в меню администратора, НЕ выход из режима
            if (inAdminMode) {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                 `🔐 Режим администратора\n\n⬇️ Выбирай действие:`,
                kbAdmin());
            } else {
                const marked = await hasMarkedToday(FROM_USER_ID);
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                     buildGreeting(resolvedName, firstName, false, marked),
                        await mainKb(FROM_USER_ID));
         }
        return;
        }

        if (action === 'arrived' || action === 'пришел' || action === 'пришёл') {
            const lastMark = await getLastMark(FROM_USER_ID);
            if (lastMark && lastMark.type === 'in') {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `⚠️ Уже есть активная отметка прихода!\nСначала нажми "🚪 Ушёл", чтобы закрыть прошлую смену.`, kb);
                return;
            }
            const sched = await getActiveSchedule(FROM_USER_ID);

            // ✅ ЕСЛИ УДАЛЁНКА — БЕЗ ГЕОЛОКАЦИИ
if (sched && sched.status === 'remote') {
    await saveAttendance(FROM_USER_ID, resolvedName, domain, 'in', null, null, false, true);

    const time = new Date().toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Yekaterinburg'
    });

    await sendMessage(domain, authToken, botId, DIALOG_ID,
        `🏠 Начало работы (удалённо) в ${time}\n\nХорошего дня 💻`, kb);

    return;
}

            if (sched && ['vacation','sick','dayoff'].includes(sched.status)) {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `ℹ️ По расписанию у вас сегодня: ${SCHED_LABELS[sched.status]}\nЕсли всё верно — ссылка для отметки ниже 👇`, null);
            }
            const token = makeToken();
            await saveGeoToken(token, FROM_USER_ID, resolvedName, DIALOG_ID, botId, domain, authToken, 'in');
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `📍 Нажми кнопку ниже, чтобы подтвердить приход.\n⏰ Ссылка действует 10 минут!`,
                kbGeo(`${geoUrl}?token=${token}`, 'in'));

        } else if (action === 'left' || action === 'ушел' || action === 'ушёл') {
            const lastMark = await getLastMark(FROM_USER_ID);
            const sched = await getActiveSchedule(FROM_USER_ID);

if (sched && sched.status === 'remote') {
    await saveAttendance(FROM_USER_ID, resolvedName, domain, 'out', null, null, false, true);

    const time = new Date().toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Yekaterinburg'
    });

    await sendMessage(domain, authToken, botId, DIALOG_ID,
        `🏠 Завершение работы (удалённо) в ${time}`, kb);

    return;
}
            if (!lastMark || lastMark.type !== 'in') {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `⚠️ Нет активной отметки прихода!\nСначала нажми "✅ Пришёл", чтобы начать рабочий день.`, kb);
                return;
            }
            const token = makeToken();
            await saveGeoToken(token, FROM_USER_ID, resolvedName, DIALOG_ID, botId, domain, authToken, 'out');
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `📍 Нажми кнопку ниже, чтобы подтвердить уход.\n⏰ Ссылка действует 10 минут!`,
                kbGeo(`${geoUrl}?token=${token}`, 'out'));

        } else if (action === 'status' || action === 'статус') {
            const marks = await getTodayMarks(FROM_USER_ID);
            if (!marks.length) {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `📊 Сегодня отметок пока нет.\n\nНажми "✅ Пришёл" чтобы начать рабочий день! 👇`, kb);
                return;
            }
            let totalSeconds = 0, lastInTime = null, lastType = null;
            const lines = [];
            for (const mark of marks) {
                const ts  = new Date(mark.timestamp);
                const lbl = mark.type === 'in' ? '✅ Приход' : '🚪 Уход';
                const loc = mark.in_office === 1 ? '📍 В офисе' : '🏠 Удалённо';
                if (mark.type === 'in') {
                    lastInTime = ts; lastType = 'in';
                    lines.push(`${lbl} в ${tzTime(mark.timestamp)} — ${loc}`);
                } else {
                    if (lastType === 'in' && lastInTime) {
                        const diff = (ts - lastInTime) / 1000;
                        totalSeconds += diff;
                        lines.push(`${lbl} в ${tzTime(mark.timestamp)} — ${loc} (${formatDuration(diff)})`);
                    } else {
                        lines.push(`${lbl} в ${tzTime(mark.timestamp)} — ${loc}`);
                    }
                    lastType = 'out'; lastInTime = null;
                }
            }
            if (lastType === 'in') lines.push('⏳ Смена ещё не закрыта');
            const totalStr = totalSeconds > 0 ? `\n\n⏱ Итого в офисе: ${formatDuration(totalSeconds)}` : '';
            const monthSeconds = await getMonthWorkSeconds(FROM_USER_ID);
const monthHours = Math.floor(monthSeconds / 3600);

const norm = 160;
const left = Math.max(0, norm - monthHours);

const progressText =
    `\n\n📅 За месяц:\n` +
    `⏱ Отработано: ${monthHours} ч\n` +
    `📊 Осталось: ${left} ч до нормы`;
            await sendMessage(domain, authToken, botId, DIALOG_ID, `📊 Твои отметки за сегодня:\n\n${lines.join('\n')}${totalStr}${progressText}`, kb);

        } else if (action === 'help' || action === 'помощь') {
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `🤖 Бот учёта рабочего времени\n\n` +
                `✅ Пришёл — отметить начало рабочего дня\n` +
                `🚪 Ушёл — отметить конец рабочего дня\n` +
                `📊 Статус — посмотреть свои отметки за сегодня\n\n` +
                `После нажатия кнопки откроется страница для подтверждения геолокации.\n` +
                `⏰ Ссылка действует 10 минут!`, kb);

        } else if (action === 'menu' || action === 'назад' || action === 'меню') {
            await sendMessage(domain, authToken, botId, DIALOG_ID, `👇 Выбери нужное действие:`, kb);

        } else if (action === 'history_menu') {
            await sendMessage(domain, authToken, botId, DIALOG_ID,
             `📈 Выбери период для просмотра истории отметок и отработанных часов:`,
              kbHistoryPeriod());

        } else if (action === 'history_week') {
            const days = 7;
            const history = await getUserHistory(FROM_USER_ID, days);
            const text = formatHistoryText(history, `последние ${days} дней`);
            await sendMessage(domain, authToken, botId, DIALOG_ID, text, kb);

        } else if (action === 'history_month') {
            const days = 30;
            const history = await getUserHistory(FROM_USER_ID, days);
            const text = formatHistoryText(history, `последние ${days} дней`);
            await sendMessage(domain, authToken, botId, DIALOG_ID, text, kb);

        } else if (action === 'report_today') {
    if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
    const today = todaySV();
    
    // Получаем всех сотрудников
    const { rows: allEmps } = await pool.query(`SELECT user_id, user_name FROM employees ORDER BY user_name`);
    
    let presentList = [];
    let absentList = [];
    let vacationList = [];
    let sickList = [];
    let dayoffList = [];
    let remoteList = [];
    
    for (const emp of allEmps) {
        const stats = await getWorkDaysInPeriod(emp.user_id, today, today);
        
        if (stats.vacationDays > 0) {
            vacationList.push(emp.user_name);
        } else if (stats.sickDays > 0) {
            sickList.push(emp.user_name);
        } else if (stats.dayoffDays > 0) {
            dayoffList.push(emp.user_name);
        } else if (stats.remoteDays > 0) {
            remoteList.push(emp.user_name);
        } else if (stats.attendedDays > 0) {
            presentList.push({ name: emp.user_name, late: stats.lateDays > 0 });
        } else if (stats.totalWorkDays > 0) {
            absentList.push(emp.user_name);
        }
    }
    
    let text = `📋 ОТЧЁТ ЗА ${new Date().toLocaleDateString('ru-RU')}\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    
    if (presentList.length) {
        text += `✅ ПРИСУТСТВУЮТ (${presentList.length} чел.)\n`;
        presentList.forEach(p => {
            text += `  • ${p.name}${p.late ? ' ⚠️ опоздание' : ''}\n`;
        });
        text += `\n`;
    }
    
    if (remoteList.length) {
        text += `🏠 УДАЛЁННО (${remoteList.length} чел.)\n`;
        remoteList.forEach(r => { text += `  • ${r}\n`; });
        text += `\n`;
    }
    
    if (vacationList.length) {
        text += `🏖 В ОТПУСКЕ (${vacationList.length} чел.)\n`;
        vacationList.forEach(v => { text += `  • ${v}\n`; });
        text += `\n`;
    }
    
    if (sickList.length) {
        text += `🤒 БОЛЬНИЧНЫЙ (${sickList.length} чел.)\n`;
        sickList.forEach(s => { text += `  • ${s}\n`; });
        text += `\n`;
    }
    
    if (dayoffList.length) {
        text += `📅 ВЫХОДНОЙ (${dayoffList.length} чел.)\n`;
        dayoffList.forEach(d => { text += `  • ${d}\n`; });
        text += `\n`;
    }
    
    if (absentList.length) {
        text += `❌ НЕ ОТМЕТИЛИСЬ (${absentList.length} чел.)\n`;
        absentList.forEach(a => { text += `  • ${a}\n`; });
        text += `\n`;
    }
    
    text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `📊 ВСЕГО: ${allEmps.length} чел.`;
    
    await sendMessage(domain, authToken, botId, DIALOG_ID, text, kbAdmin());


        } else if (action === 'report_week') {
    if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
    
    const endDate = todaySV();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 6);
    const startDateStr = startDate.toLocaleDateString('sv-SE');
    
    const { rows: allEmps } = await pool.query(`SELECT user_id, user_name FROM employees ORDER BY user_name`);
    
    let reportLines = [];
    let teamTotalWorkDays = 0;
    let teamAttendedDays = 0;
    
    for (const emp of allEmps) {
        const stats = await getWorkDaysInPeriod(emp.user_id, startDateStr, endDate);
        teamTotalWorkDays += stats.totalWorkDays;
        teamAttendedDays += stats.attendedDays;
        
        let statusIcon = '';
        if (stats.attendedDays === stats.totalWorkDays && stats.totalWorkDays > 0) statusIcon = '✅';
        else if (stats.attendedDays === 0 && stats.totalWorkDays > 0) statusIcon = '❌';
        else if (stats.attendedDays > 0) statusIcon = '⚠️';
        else statusIcon = '⚪';
        
        reportLines.push({
            name: emp.user_name,
            icon: statusIcon,
            attended: stats.attendedDays,
            total: stats.totalWorkDays,
            vacation: stats.vacationDays,
            sick: stats.sickDays,
            remote: stats.remoteDays
        });
    }
    
    reportLines.sort((a, b) => b.attended - a.attended);
    
    let text = `📅 ОТЧЁТ ЗА НЕДЕЛЮ (${startDate.toLocaleDateString('ru-RU')} – ${new Date().toLocaleDateString('ru-RU')})\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    
    for (const r of reportLines) {
        text += `${r.icon} ${r.name}\n`;
        text += `   📊 явка: ${r.attended}/${r.total} дн. (${r.total > 0 ? Math.round(r.attended/r.total*100) : 0}%)\n`;
        if (r.vacation > 0) text += `   🏖 отпуск: ${r.vacation} дн.\n`;
        if (r.sick > 0) text += `   🤒 больничный: ${r.sick} дн.\n`;
        if (r.remote > 0) text += `   🏠 удалённо: ${r.remote} дн.\n`;
        text += `\n`;
    }
    
    text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    const teamRate = teamTotalWorkDays > 0 ? Math.round(teamAttendedDays / teamTotalWorkDays * 100) : 0;
    text += `📊 ПО КОМАНДЕ: явка ${teamRate}% (${teamAttendedDays}/${teamTotalWorkDays} дн.)`;
    
    await sendMessage(domain, authToken, botId, DIALOG_ID, text, kbAdmin());


        } else if (action === 'report_month') {
    if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
    
    const endDate = todaySV();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 29);
    const startDateStr = startDate.toLocaleDateString('sv-SE');
    
    const { rows: allEmps } = await pool.query(`SELECT user_id, user_name FROM employees ORDER BY user_name`);
    
    let bestEmp = null;
    let worstEmp = null;
    let teamTotalWorkDays = 0;
    let teamAttendedDays = 0;
    let teamLateDays = 0;
    
    let reportLines = [];
    
    for (const emp of allEmps) {
        const stats = await getWorkDaysInPeriod(emp.user_id, startDateStr, endDate);
        teamTotalWorkDays += stats.totalWorkDays;
        teamAttendedDays += stats.attendedDays;
        teamLateDays += stats.lateDays;
        
        const rate = stats.totalWorkDays > 0 ? Math.round(stats.attendedDays / stats.totalWorkDays * 100) : 0;
        
        let grade = '';
        if (rate >= 95) grade = '🏆 ОТЛИЧНО';
        else if (rate >= 85) grade = '✅ ХОРОШО';
        else if (rate >= 70) grade = '⚠️ ДОПУСТИМО';
        else grade = '❌ КРИТИЧНО';
        
        reportLines.push({
            name: emp.user_name,
            rate,
            attended: stats.attendedDays,
            total: stats.totalWorkDays,
            late: stats.lateDays,
            grade
        });
        
        if (!bestEmp || rate > bestEmp.rate) bestEmp = { name: emp.user_name, rate };
        if (!worstEmp || rate < worstEmp.rate) worstEmp = { name: emp.user_name, rate };
    }
    
    reportLines.sort((a, b) => b.rate - a.rate);
    
    let text = `📆 ОТЧЁТ ЗА МЕСЯЦ\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    
    for (const r of reportLines) {
        text += `${r.grade} ${r.name}\n`;
        text += `   📊 явка: ${r.attended}/${r.total} дн. (${r.rate}%)\n`;
        if (r.late > 0) text += `   ⏰ опозданий: ${r.late}\n`;
        text += `\n`;
    }
    
    text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    const teamRate = teamTotalWorkDays > 0 ? Math.round(teamAttendedDays / teamTotalWorkDays * 100) : 0;
    text += `📊 ПО КОМАНДЕ:\n`;
    text += `   • явка: ${teamRate}% (${teamAttendedDays}/${teamTotalWorkDays} дн.)\n`;
    text += `   • опозданий: ${teamLateDays}\n`;
    text += `   • лучший: ${bestEmp?.name || '—'} (${bestEmp?.rate || 0}%)\n`;
    text += `   • худший: ${worstEmp?.name || '—'} (${worstEmp?.rate || 0}%)`;
    
    await sendMessage(domain, authToken, botId, DIALOG_ID, text, kbAdmin());

        } else if (action === 'who_in') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const { rows } = await pool.query(`
    SELECT user_name, user_id, MIN(CASE WHEN type='in' THEN timestamp END) as in_time
    FROM attendance
    WHERE (timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date = (NOW() AT TIME ZONE 'Asia/Yekaterinburg')::date
      AND in_office = 1
    GROUP BY user_id, user_name 
    HAVING MAX(CASE WHEN type='out' THEN 1 ELSE 0 END) = 0 
    ORDER BY user_name
`);
            let text = `👥 Сейчас в офисе — ${rows.length} чел.:\n\n`;
            rows.length ? rows.forEach(r => { text += `• ${r.user_name||r.user_id} (с ${r.in_time ? tzTime(r.in_time) : '?'})\n`; })
                        : text += `Сейчас никого нет в офисе.`;
            await sendMessage(domain, authToken, botId, DIALOG_ID, text, kbAdmin());

        } else if (action === 'send_report') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            await sendMessage(domain, authToken, botId, DIALOG_ID, `📤 Выбери период — отчёт Excel придёт на почту ko******vk.com:`, kbEmailPeriod());

        } else if (action === 'email_today' || action === 'email_week' || action === 'email_month') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            await sendMessage(domain, authToken, botId, DIALOG_ID, `⏳ Формирую Excel-отчёт и отправляю на почту...`, kbAdmin());
            const result = await sendReportByEmail(action.replace('email_', ''));
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                result.ok ? `✅ Отчёт успешно отправлен!\n📧 ${smtpConfig.reportEmails}`
                          : `❌ Не удалось отправить отчёт.\n\n_${result.error}_`, kbAdmin());

        } else if (action === 'schedule') {
            
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            await sendMessage(domain, authToken, botId, DIALOG_ID, `🗓 Управление расписанием\n\nДобавь событие или посмотри список:`, kbSchedule());
        } else if (action === 'work_sched') {
   // if (!inAdminMode) {
//     await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb);
//     return;
// }
    

    const allWs = await getAllEmpWorkSchedules();

    let text = `📊 Управление типами рабочих графиков\n\n`;
    text += allWs.length 
        ? `👥 Назначено: ${allWs.length} чел.\n\n` 
        : `Графики пока не назначены.\n\n`;

    text += `Выбери действие:`;

    await sendMessage(domain, authToken, botId, DIALOG_ID, text, kbWorkSched());

        } else if (action === 'ws_bulk') {
            console.log(`[ws_bulk] inAdminMode=${inAdminMode} userIsAdmin=${userIsAdmin} pending=${pending?.action}`);
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            await setPending(FROM_USER_ID, 'ws_bulk', 'search_users', { adminSession: true, selectedUsers: [] });
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `👥 Массовое назначение графика работы\n\n` +
                `🔍 Шаг 1: Поиск сотрудников\n\n` +
                `Введи имя или фамилию сотрудника.\n` +
                `После каждого выбора можно добавить следующего.`,
                kbCancel());

        } else if (action === 'ws_bulk_add_more') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const p = await getPending(FROM_USER_ID);
            if (!p || p.action !== 'ws_bulk') return;
            await setPending(FROM_USER_ID, 'ws_bulk', 'search_users', { ...p.data });
            const names = (p.data.selectedUsers || []).map(u => `• ${u.name}`).join('\n');
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `✅ Уже выбраны (${p.data.selectedUsers.length}):\n${names}\n\n🔍 Введи имя следующего сотрудника:`,
                kbCancel());

        } else if (action === 'ws_bulk_done_select') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const p = await getPending(FROM_USER_ID);
            if (!p || p.action !== 'ws_bulk') return;
            if (!p.data.selectedUsers?.length) {
                await sendMessage(domain, authToken, botId, DIALOG_ID, `⚠️ Не выбран ни один сотрудник. Введи имя:`, kbCancel());
                return;
            }
            await setPending(FROM_USER_ID, 'ws_bulk', 'pick_type', { ...p.data });
            const names = p.data.selectedUsers.map(u => `• ${u.name}`).join('\n');
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `👥 Выбрано сотрудников: ${p.data.selectedUsers.length}\n${names}\n\n` +
                `📊 Шаг 2: Выбери тип рабочего графика:`,
                kbWorkSchedTypeBulk());

        } else if (/^ws_bulk_type_/.test(action)) {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const p = await getPending(FROM_USER_ID);
            if (!p || p.action !== 'ws_bulk' || p.step !== 'pick_type') return;
            const type = action.replace('ws_bulk_type_', '').replace('_', '/');
            if (!WORK_SCHEDULE_TYPES[type]) {
                await sendMessage(domain, authToken, botId, DIALOG_ID, `⚠️ Неизвестный тип. Попробуй снова.`, kbWorkSchedType());
                return;
            }
            if (type === '5/2') {
                const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Yekaterinburg' });
                await setPending(FROM_USER_ID, 'ws_bulk', 'date_end', { ...p.data, scheduleType: type, cycleStart: today });
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `📊 График: ${WORK_SCHEDULE_TYPES[type].label}\n\n` +
                    `📅 Шаг 3: Введи дату окончания графика (ДД.ММ.ГГГГ) или *-* если бессрочно:`,
                    kbCancel());
            } else {
                await setPending(FROM_USER_ID, 'ws_bulk', 'cycle_start', { ...p.data, scheduleType: type });
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `📊 График: ${WORK_SCHEDULE_TYPES[type].label}\n\n` +
                    `📅 Шаг 3: Введи дату первого рабочего дня цикла (ДД.ММ.ГГГГ):`,
                    kbCancel());
            }

        } else if (/^ws_bulk_select_\d$/.test(action)) {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const p = await getPending(FROM_USER_ID);
            if (!p || p.action !== 'ws_bulk') return;
            const idx = parseInt(action.replace('ws_bulk_select_', ''));
            const sel = (p.data.foundUsers || [])[idx];
            if (!sel) { await sendMessage(domain, authToken, botId, DIALOG_ID, `⚠️ Сотрудник не найден.`, kbCancel()); return; }
            const already = (p.data.selectedUsers || []).find(u => String(u.id) === String(sel.id));
            if (already) {
                await sendMessage(domain, authToken, botId, DIALOG_ID, `ℹ️ ${sel.name} уже в списке.`, kbWsBulkAddMore(p.data.selectedUsers));
                return;
            }
            const updatedUsers = [...(p.data.selectedUsers || []), { id: sel.id, name: sel.name }];
            await setPending(FROM_USER_ID, 'ws_bulk', 'adding_users', { ...p.data, selectedUsers: updatedUsers, foundUsers: [] });
            const names = updatedUsers.map(u => `• ${u.name}`).join('\n');
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `✅ Добавлен: ${sel.name}\n\n👥 Выбрано (${updatedUsers.length}):\n${names}\n\nЧто дальше?`,
                kbWsBulkAddMore(updatedUsers));

        } else if (action === 'ws_bulk_overwrite') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const p = await getPending(FROM_USER_ID);
            if (!p || p.action !== 'ws_bulk' || p.step !== 'confirm_conflicts') return;
            const { selectedUsers, scheduleType, cycleStart, dateEnd } = p.data;
            const overwriteIds = selectedUsers.map(u => String(u.id));
            // Удаляем конфликтующие и назначаем всем
            await pool.query(`DELETE FROM employee_work_schedules WHERE user_id = ANY($1)`, [overwriteIds]);
            const results = [];
            for (const emp of selectedUsers) {
                await setEmpWorkSchedule(String(emp.id), emp.name, scheduleType, cycleStart, dateEnd || null, String(FROM_USER_ID));
                results.push(emp.name);
                const notifyText = `📊 Вам назначен новый график работы\n\n` +
                    `${WORK_SCHEDULE_TYPES[scheduleType]?.label || scheduleType}\n` +
                    (dateEnd ? `📅 До: ${new Date(dateEnd).toLocaleDateString('ru-RU')}` : `📅 Бессрочно`) +
                    `\n\nНазначено администратором.`;
                await notifyUserInBotChat(domain, authToken, botId, emp.id, notifyText);
            }
            await clearPending(FROM_USER_ID);
            await setPending(FROM_USER_ID, 'admin_session', 'active');
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `✅ График назначен (конфликты перезаписаны)\n\n` +
                `📊 ${WORK_SCHEDULE_TYPES[scheduleType]?.label || scheduleType}\n` +
                (dateEnd ? `📅 До: ${new Date(dateEnd).toLocaleDateString('ru-RU')}\n` : `📅 Бессрочно\n`) +
                `\n✅ Назначено: ${results.length} чел.\n${results.map(n => `  • ${n}`).join('\n')}`,
                kbWorkSched());

        } else if (action === 'ws_bulk_skip') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const p = await getPending(FROM_USER_ID);
            if (!p || p.action !== 'ws_bulk' || p.step !== 'confirm_conflicts') return;
            const { selectedUsers, scheduleType, cycleStart, dateEnd, conflictUserIds } = p.data;
            const created = [];
            const skipped = [];
            for (const emp of selectedUsers) {
                if ((conflictUserIds || []).includes(String(emp.id))) {
                    skipped.push(emp.name);
                    continue;
                }
                await setEmpWorkSchedule(String(emp.id), emp.name, scheduleType, cycleStart, dateEnd || null, String(FROM_USER_ID));
                created.push(emp.name);
                const notifyText = `📊 Вам назначен новый график работы\n\n` +
                    `${WORK_SCHEDULE_TYPES[scheduleType]?.label || scheduleType}\n` +
                    (dateEnd ? `📅 До: ${new Date(dateEnd).toLocaleDateString('ru-RU')}` : `📅 Бессрочно`) +
                    `\n\nНазначено администратором.`;
                await notifyUserInBotChat(domain, authToken, botId, emp.id, notifyText);
            }
            await clearPending(FROM_USER_ID);
            await setPending(FROM_USER_ID, 'admin_session', 'active');
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `✅ График назначен (конфликты пропущены)\n\n` +
                `📊 ${WORK_SCHEDULE_TYPES[scheduleType]?.label || scheduleType}\n` +
                (dateEnd ? `📅 До: ${new Date(dateEnd).toLocaleDateString('ru-RU')}\n` : `📅 Бессрочно\n`) +
                `\n✅ Назначено: ${created.length} чел.\n${created.map(n => `  • ${n}`).join('\n')}` +
                (skipped.length ? `\n\n⏭ Пропущено: ${skipped.length} чел.\n${skipped.map(n => `  • ${n}`).join('\n')}` : ''),
                kbWorkSched());

        } else if (action === 'sched_bulk') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            await setPending(FROM_USER_ID, 'bulk_schedule', 'search_users', { adminSession: true, selectedUsers: [] });
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `👥 Массовое создание расписания\n\n` +
                `🔍 Шаг 1: Поиск сотрудников\n\n` +
                `Введи имя или фамилию сотрудника.\n` +
                `После каждого выбора можно добавить следующего.`,
                kbCancel());

        } else if (action === 'bulk_add_more') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const p = await getPending(FROM_USER_ID);
            if (!p || p.action !== 'bulk_schedule') return;
            await setPending(FROM_USER_ID, 'bulk_schedule', 'search_users', { ...p.data });
            const names = (p.data.selectedUsers || []).map(u => `• ${u.name}`).join('\n');
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `✅ Уже выбраны (${p.data.selectedUsers.length}):\n${names}\n\n🔍 Введи имя следующего сотрудника:`,
                kbCancel());

        } else if (action === 'bulk_done_select') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const p = await getPending(FROM_USER_ID);
            if (!p || p.action !== 'bulk_schedule') return;
            if (!p.data.selectedUsers?.length) {
                await sendMessage(domain, authToken, botId, DIALOG_ID, `⚠️ Не выбран ни один сотрудник. Введи имя:`, kbCancel());
                return;
            }
            await setPending(FROM_USER_ID, 'bulk_schedule', 'pick_status', { ...p.data });
            const names = p.data.selectedUsers.map(u => `• ${u.name}`).join('\n');
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `👥 Выбрано сотрудников: ${p.data.selectedUsers.length}\n${names}\n\n` +
                `📋 Шаг 2: Выбери тип расписания:`,
                kbBulkStatus());

        } else if (/^bulk_status_/.test(action)) {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const p = await getPending(FROM_USER_ID);
            if (!p || p.action !== 'bulk_schedule' || p.step !== 'pick_status') return;
            const statusMap2 = { bulk_status_vacation:'vacation', bulk_status_sick:'sick', bulk_status_dayoff:'dayoff', bulk_status_remote:'remote', bulk_status_business:'business' };
            const status = statusMap2[action];
            if (!status) { await sendMessage(domain, authToken, botId, DIALOG_ID, `⚠️ Неизвестный тип. Попробуй снова.`, kbBulkStatus()); return; }
            await setPending(FROM_USER_ID, 'bulk_schedule', 'date_from', { ...p.data, status });
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `📋 Тип: ${SCHED_LABELS[status]}\n\n📅 Шаг 3: Введи дату начала (ДД.ММ.ГГГГ):`,
                kbCancel());

        } else if (/^bulk_select_user_\d$/.test(action)) {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const p = await getPending(FROM_USER_ID);
            if (!p || p.action !== 'bulk_schedule') return;
            const idx = parseInt(action.replace('bulk_select_user_', ''));
            const sel = (p.data.foundUsers || [])[idx];
            if (!sel) { await sendMessage(domain, authToken, botId, DIALOG_ID, `⚠️ Сотрудник не найден.`, kbCancel()); return; }
            const already = (p.data.selectedUsers || []).find(u => String(u.id) === String(sel.id));
            if (already) {
                await sendMessage(domain, authToken, botId, DIALOG_ID, `ℹ️ ${sel.name} уже в списке.`, kbBulkAddMore(p.data.selectedUsers));
                return;
            }
            const updatedUsers = [...(p.data.selectedUsers || []), { id: sel.id, name: sel.name }];
            await setPending(FROM_USER_ID, 'bulk_schedule', 'adding_users', { ...p.data, selectedUsers: updatedUsers, foundUsers: [] });
            const names = updatedUsers.map(u => `• ${u.name}`).join('\n');
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `✅ Добавлен: ${sel.name}\n\n👥 Выбрано (${updatedUsers.length}):\n${names}\n\nЧто дальше?`,
                kbBulkAddMore(updatedUsers));

        } else if (action === 'bulk_sched_overwrite') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const p = await getPending(FROM_USER_ID);
            if (!p || p.action !== 'bulk_schedule' || p.step !== 'confirm_conflicts') return;
            const { selectedUsers, status, dateFrom, dateTo, comment } = p.data;
            const userIds = selectedUsers.map(u => String(u.id));
            const conflictMapRaw = await checkBulkConflicts(userIds, dateFrom, dateTo);
            const { created } = await insertBulkSchedule(selectedUsers, status, dateFrom, dateTo, comment, FROM_USER_ID, conflictMapRaw, userIds);
            await clearPending(FROM_USER_ID);
            await setPending(FROM_USER_ID, 'admin_session', 'active');
            const from = new Date(dateFrom).toLocaleDateString('ru-RU');
            const to   = new Date(dateTo).toLocaleDateString('ru-RU');
            for (const emp of selectedUsers.filter(u => created.includes(u.name))) {
                const notifyText = `📅 Вам назначено расписание\n\n${SCHED_LABELS[status]}\n📅 ${from} — ${to}` +
                    (comment ? `\n💬 ${comment}` : '') + `\n\nИнформация внесена администратором.`;
                await notifyUserInBotChat(domain, authToken, botId, emp.id, notifyText);
            }
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `✅ Расписание создано (конфликты перезаписаны)!\n\n` +
                `📋 ${SCHED_LABELS[status]}: ${from} — ${to}\n` +
                (comment ? `💬 ${comment}\n` : '') +
                `\n✅ Создано: ${created.length} чел.\n${created.map(n=>`  • ${n}`).join('\n')}`,
                kbSchedule());

        } else if (action === 'bulk_sched_skip') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const p = await getPending(FROM_USER_ID);
            if (!p || p.action !== 'bulk_schedule' || p.step !== 'confirm_conflicts') return;
            const { selectedUsers, status, dateFrom, dateTo, comment } = p.data;
            const userIds = selectedUsers.map(u => String(u.id));
            const conflictMapRaw = await checkBulkConflicts(userIds, dateFrom, dateTo);
            const { created, skipped } = await insertBulkSchedule(selectedUsers, status, dateFrom, dateTo, comment, FROM_USER_ID, conflictMapRaw, []);
            await clearPending(FROM_USER_ID);
            await setPending(FROM_USER_ID, 'admin_session', 'active');
            const from = new Date(dateFrom).toLocaleDateString('ru-RU');
            const to   = new Date(dateTo).toLocaleDateString('ru-RU');
            for (const emp of selectedUsers.filter(u => created.includes(u.name))) {
                const notifyText = `📅 Вам назначено расписание\n\n${SCHED_LABELS[status]}\n📅 ${from} — ${to}` +
                    (comment ? `\n💬 ${comment}` : '') + `\n\nИнформация внесена администратором.`;
                await notifyUserInBotChat(domain, authToken, botId, emp.id, notifyText);
            }
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `✅ Расписание создано (конфликты пропущены)!\n\n` +
                `📋 ${SCHED_LABELS[status]}: ${from} — ${to}\n` +
                (comment ? `💬 ${comment}\n` : '') +
                `\n✅ Создано: ${created.length} чел.\n${created.map(n=>`  • ${n}`).join('\n')}` +
                (skipped.length ? `\n\n⏭ Пропущено: ${skipped.length} чел.\n${skipped.map(n=>`  • ${n}`).join('\n')}` : ''),
                kbSchedule());

        } else if (['sched_vacation','sched_sick','sched_dayoff','sched_remote','sched_business'].includes(action)) {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const statusMap = { sched_vacation:'vacation', sched_sick:'sick', sched_dayoff:'dayoff', sched_remote:'remote', sched_business:'business' };
            const status = statusMap[action];
            await setPending(FROM_USER_ID, 'schedule_add', 'search_user', { status, adminSession:true });
            await sendMessage(domain, authToken, botId, DIALOG_ID, `${SCHED_LABELS[status]} — добавление записи\n\n🔍 Введи имя или фамилию сотрудника:`, kbCancel());

        } else if (action === 'sched_list') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const { rows } = await pool.query(`SELECT * FROM schedules WHERE date_to>=CURRENT_DATE ORDER BY date_from, user_name`);
            let text = `📋 Актуальное расписание:\n\n`;
            rows.length ? rows.forEach(r => {
                text += `• [${r.id}] ${r.user_name}: ${SCHED_LABELS[r.status]||r.status}\n  📅 ${new Date(r.date_from).toLocaleDateString('ru-RU')} — ${new Date(r.date_to).toLocaleDateString('ru-RU')}`;
                if (r.comment) text += `\n  💬 ${r.comment}`;
                text += `\n`;
            }) : text += `Активных записей нет.`;
            await sendMessage(domain, authToken, botId, DIALOG_ID, text, kbSchedule());

        } else if (action === 'sched_delete') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            await setPending(FROM_USER_ID, 'schedule_delete', 'id', { adminSession:true });
            await sendMessage(domain, authToken, botId, DIALOG_ID, `🗑 Введи ID записи (цифру в [скобках] из списка):`, kbCancel());

        } else if (action === 'admin_manage') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            await sendMessage(domain, authToken, botId, DIALOG_ID, `👤 Управление администраторами`, kbAdminManage());

        } else if (action === 'admin_list') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const admins = await listAdmins();
            let text = `📋 Список администраторов:\n\n👑 ID ${MANAGER_ID} — главный администратор\n`;
            admins.forEach(a => { text += `• ${a.user_name||'Без имени'} (ID: ${a.user_id})\n`; });
            if (!admins.length) text += `\nДополнительных администраторов нет.`;
            await sendMessage(domain, authToken, botId, DIALOG_ID, text, kbAdminManage());
        
        } else if (action === 'audit') {
            if (!inAdminMode) {
                await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа. Войдите в режим администратора.`, kb);
                return;
            }

            const { rows } = await pool.query(`
                SELECT ts, action, actor_user_name, actor_user_id, target_user_name, target_user_id, details
                FROM audit_log
                WHERE ts >= NOW() - INTERVAL '30 days'
                ORDER BY ts DESC
                LIMIT 80
            `);

            if (!rows.length) {
                await sendMessage(domain, authToken, botId, DIALOG_ID, `🧾 Журнал действий пуст за последние 30 дней.`, kbAdmin());
                return;
            }

            const ACTION_LABELS = {
                admin_add: '➕ Добавление администратора',
                admin_remove: '➖ Удаление администратора',

                schedule_add: '🗓 Добавление расписания',
                schedule_delete: '🗑 Удаление записи расписания',
                schedule_bulk_add: '👥 Массовое расписание',

                work_schedule_assign: '📊 Назначение графика',
                work_schedule_remove: '❌ Удаление графика',
                work_schedule_bulk_assign: '👥 Массовое назначение графиков',

                attendance_delete: '🧹 Удаление отметок'
            };

            let text = `🧾 Журнал действий администраторов (последние 30 дней)\n`;
            text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

            for (const r of rows) {
                const ts = new Date(r.ts).toLocaleString('ru-RU', { timeZone: 'Asia/Yekaterinburg' });
                const label = ACTION_LABELS[r.action] || r.action;

                const who = r.actor_user_name ? `${r.actor_user_name} (ID ${r.actor_user_id})` : `(ID ${r.actor_user_id || '—'})`;
                const target = r.target_user_name ? ` → ${r.target_user_name} (ID ${r.target_user_id})` : '';

            let extra = '';
            try {
                const d = r.details || {};
                if (d && Object.keys(d).length) extra = `\n   • ${JSON.stringify(d)}`;
            } catch (_) {}

                text += `🕒 ${ts}\n`;
                text += `✅ ${label}\n`;
                text += `👤 ${who}${target}${extra}\n\n`;
             }

            await sendMessage(domain, authToken, botId, DIALOG_ID, text, kbAdmin());
        return;
            
        
 } else if (action === 'att_delete') {
 if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
 await setPending(FROM_USER_ID, 'att_delete', 'search_user', { adminSession: true });
 await sendMessage(domain, authToken, botId, DIALOG_ID,
 `🧹 Удаление отметок

🔍 Введи имя или фамилию сотрудника:`,
 kbCancel());
 return;
} else if (action === 'admin_add') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            await setPending(FROM_USER_ID, 'admin_add', 'user_id', { adminSession:true });
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `➕ Добавление администратора\n\nВведи ID пользователя Битрикс24:\nНайти в профиле: /company/personal/user/*123*/`, kbCancel());

        } else if (action === 'admin_remove') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const admins = await listAdmins();
            if (!admins.length) { await sendMessage(domain, authToken, botId, DIALOG_ID, `ℹ️ Дополнительных администраторов нет.`, kbAdminManage()); return; }
            await setPending(FROM_USER_ID, 'admin_remove', 'user_id', { adminSession:true });
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `➖ Удаление администратора\n\n${admins.map(a=>`• ${a.user_name||'Без имени'} — ID: ${a.user_id}`).join('\n')}\n\nВведи ID для удаления:`, kbCancel());

        }else if (action === 'ws_list') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const allWs = await getAllEmpWorkSchedules();
            let text = `📋 Типы рабочих графиков:\n\n`;
            if (allWs.length) {
                allWs.forEach(ws => { text += `• ${ws.user_name}: ${formatWorkScheduleInfo(ws)}\n`; });
            } else {
                text += `Нет назначенных графиков.\nВсем применяется стандартная логика (пн–пт рабочие).`;
            }
            await sendMessage(domain, authToken, botId, DIALOG_ID, text, kbWorkSched());

        } else if (action === 'ws_assign') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            await setPending(FROM_USER_ID, 'ws_assign', 'search_user', { adminSession:true });
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `➕ Назначение типа рабочего графика\n\n🔍 Введи имя или фамилию сотрудника:`, kbCancel());

        } else if (action === 'ws_remove') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            await setPending(FROM_USER_ID, 'ws_remove', 'search_user', { adminSession:true });
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `❌ Удаление типа рабочего графика\n\n🔍 Введи имя или фамилию сотрудника:`, kbCancel());

} else if (
    /^ws_type_/.test(action) &&
    pending?.action === 'ws_assign' &&
    pending?.step === 'pick_type'){
    // Команда: ws_type_5_2 / ws_type_4_2 / ws_type_2_2
    const type = action.replace('ws_type_', '').replace('_', '/');
    if (!WORK_SCHEDULE_TYPES[type]) {
        await sendMessage(domain, authToken, botId, DIALOG_ID, `⚠️ Неизвестный тип. Попробуй снова.`, kbWorkSched());
        return;
    }
    const data = pending.data;
    
    if (type === '5/2') {
        // Для 5/2 опорная дата не нужна — сохраняем сегодня
        const today = new Date().toLocaleDateString('sv-SE', { timeZone:'Asia/Yekaterinburg' });
        // Переходим к вопросу о дате окончания
        await setPending(FROM_USER_ID, 'ws_assign', 'date_end', { 
            ...data, 
            scheduleType: type, 
            cycleStart: today 
        });
        await sendMessage(domain, authToken, botId, DIALOG_ID,
            `📊 График: ${WORK_SCHEDULE_TYPES[type].label}\n\n` +
            `📅 Введи дату окончания графика (ДД.ММ.ГГГГ) или *-* если бессрочно:`,
            kbCancel());
    } else {
        // Для 4/2 и 2/2 сначала запрашиваем дату начала цикла
        await setPending(FROM_USER_ID, 'ws_assign', 'cycle_start', { ...data, scheduleType: type });
        await sendMessage(domain, authToken, botId, DIALOG_ID,
            `📊 График: ${WORK_SCHEDULE_TYPES[type].label}\n\n` +
            `📅 Введи дату первого рабочего дня цикла (ДД.ММ.ГГГГ):\n\n` +
            `Пример: если цикл начался в понедельник — введи дату того понедельника.`,
            kbCancel());
    }
    return;
} else if (/^ws_select_/.test(action) && pending?.action === 'ws_assign') {
            const idx = parseInt(action.replace('ws_select_', ''));
            const sel = (pending.data.foundUsers || [])[idx];
            if (!sel) { await sendMessage(domain, authToken, botId, DIALOG_ID, `⚠️ Сотрудник не найден.`, kbCancel()); return; }
            await setPending(FROM_USER_ID, 'ws_assign', 'pick_type', { ...pending.data, userId: sel.id, userName: sel.name });
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `👤 Сотрудник: ${sel.name}\n\n📊 Выбери тип рабочего графика:`, kbWorkSchedType());

        } else if (/^ws_select_/.test(action) && pending?.action === 'ws_remove') {
            const idx = parseInt(action.replace('ws_select_', ''));
            const sel = (pending.data.foundUsers || [])[idx];
            if (!sel) { await sendMessage(domain, authToken, botId, DIALOG_ID, `⚠️ Сотрудник не найден.`, kbCancel()); return; }
            const removed = await removeEmpWorkSchedule(sel.id);
            await clearPending(FROM_USER_ID);
            await setPending(FROM_USER_ID, 'admin_session', 'active');
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                removed ? `✅ График сотрудника ${sel.name} удалён.` : `ℹ️ У ${sel.name} не был назначен тип графика.`,
                kbWorkSched());

        } else {
            const greetings = ['привет','hello','hi','хай','здравствуй','здравствуйте','добрый день','добрый вечер','доброе утро','добрый','ку','хэй','салют','даров','дарова'];
            if (greetings.some(g => msgCmd.includes(g) || cleanMsg.includes(g))) {
                const marked = await hasMarkedToday(FROM_USER_ID);
                await sendMessage(domain, authToken, botId, DIALOG_ID, buildGreeting(resolvedName, firstName, inAdminMode, marked), kb);
            } else {
                await sendMessage(domain, authToken, botId, DIALOG_ID, `❓ Не понимаю «${MESSAGE || COMMAND}».\nВоспользуйся кнопками ниже 👇`, kb);
            }
        }
    } catch(err) {
        console.error('❌ /imbot error:', err.message, err.stack);
    }
});

// ─── Многошаговые диалоги ─────────────────────────────────────────────────────

async function handlePendingInput(domain, authToken, botId, dialogId, userId, userName, message, pending) {
    const { action, step, data } = pending;
    const val = message.trim();

    async function done(text, kb) {
        await clearPending(userId);
        if (data.adminSession) await setPending(userId, 'admin_session', 'active');
        await sendMessage(domain, authToken, botId, dialogId, text, kb || kbAdmin());
    }

    if (action === 'admin_add') {
        const newId = val.replace(/\D/g,'');
        if (!newId) { await sendMessage(domain, authToken, botId, dialogId, `⚠️ Введи числовой ID, например: *123*`, kbCancel()); return; }
        const b24user = await getBitrixUser(domain, authToken, newId);
        const newName = b24user?.name || `Пользователь ${newId}`;
        await addAdmin(newId, newName);
        await logAudit('admin_add',{ id: userId, name: userName },{ id: newId, name: newName },{},domain);
        await done(`✅ ${newName} (ID ${newId}) теперь администратор!\n\nЕму стала доступна кнопка "🔐 Режим администратора".`, kbAdminManage());
        return;
    }

    if (action === 'admin_remove') {
        const remId = val.replace(/\D/g,'');
        if (!remId) { await sendMessage(domain, authToken, botId, dialogId, `⚠️ Введи числовой ID:`, kbCancel()); return; }
        if (String(remId) === String(MANAGER_ID)) { await done(`🚫 Нельзя удалить главного администратора!`, kbAdminManage()); return; }
        await removeAdmin(remId);
        await logAudit('admin_remove',{ id: userId, name: userName },{ id: remId, name: null },{},domain);
        await done(`✅ Пользователь ID ${remId} удалён из администраторов.`, kbAdminManage());
        return;
    }

    // ── Массовое назначение графиков: поиск сотрудников ─────────────────────────
    if (action === 'ws_bulk' && step === 'search_users') {
        await sendMessage(domain, authToken, botId, dialogId, `🔍 Ищу "${val}"...`, null);
        const users = await searchBitrixUsers(domain, authToken, val);
        if (!users.length) {
            await sendMessage(domain, authToken, botId, dialogId, `❌ Сотрудник не найден. Попробуй другое имя:`, kbCancel());
            return;
        }
        if (users.length === 1) {
            const already = (data.selectedUsers || []).find(u => String(u.id) === String(users[0].id));
            if (already) {
                await sendMessage(domain, authToken, botId, dialogId, `ℹ️ ${users[0].name} уже в списке.`, kbWsBulkAddMore(data.selectedUsers));
                return;
            }
            const updatedUsers = [...(data.selectedUsers || []), { id: users[0].id, name: users[0].name }];
            await setPending(userId, 'ws_bulk', 'adding_users', { ...data, selectedUsers: updatedUsers });
            const names = updatedUsers.map(u => `• ${u.name}`).join('\n');
            await sendMessage(domain, authToken, botId, dialogId,
                `✅ Добавлен: ${users[0].name}\n\n👥 Выбрано (${updatedUsers.length}):\n${names}\n\nЧто дальше?`,
                kbWsBulkAddMore(updatedUsers));
            return;
        }
        await setPending(userId, 'ws_bulk', 'search_users', { ...data, foundUsers: users });
        const kbSel = [];
        users.slice(0, 5).forEach((u, i) => {
            if (i > 0 && i % 2 === 0) kbSel.push({ TYPE:'NEWLINE' });
            kbSel.push({ TEXT: u.name, COMMAND: `ws_bulk_select_${i}`, COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#5b8def', TEXT_COLOR:'#ffffff' });
        });
        kbSel.push({ TYPE:'NEWLINE' });
        kbSel.push({ TEXT:'❌ Отмена', COMMAND:'cancel_input', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#888888', TEXT_COLOR:'#ffffff' });
        await sendMessage(domain, authToken, botId, dialogId,
            `🔍 Найдено несколько:\n${users.slice(0,5).map((u,i) => `${i+1}. ${u.name}`).join('\n')}\n\nВыбери нужного:`,
            kbSel);
        return;
    }

    // ── Массовое назначение графиков: дата начала цикла ─────────────────────────
    if (action === 'ws_bulk' && step === 'cycle_start') {
        const d = parseDate(val);
        if (!d) { await sendMessage(domain, authToken, botId, dialogId, `⚠️ Неверный формат. Введи ДД.ММ.ГГГГ:`, kbCancel()); return; }
        await setPending(userId, 'ws_bulk', 'date_end', { ...data, cycleStart: d });
        await sendMessage(domain, authToken, botId, dialogId,
            `✅ Начало цикла: ${val}\n\n📅 Введи дату окончания графика (ДД.ММ.ГГГГ) или *-* если бессрочно:`,
            kbCancel());
        return;
    }

    // ── Массовое назначение графиков: дата окончания → проверка конфликтов ──────
    if (action === 'ws_bulk' && step === 'date_end') {
        let dateEnd = null;
        if (val !== '-' && val !== '—') {
            dateEnd = parseDate(val);
            if (!dateEnd) { await sendMessage(domain, authToken, botId, dialogId, `⚠️ Неверный формат. Введи ДД.ММ.ГГГГ или *-*:`, kbCancel()); return; }
        }
        const { selectedUsers, scheduleType, cycleStart } = data;
        const userIds = selectedUsers.map(u => String(u.id));

        // Проверяем кто уже имеет график
        const { rows: existing } = await pool.query(
            `SELECT user_id FROM employee_work_schedules WHERE user_id = ANY($1)`,
            [userIds]
        );
        const conflictUserIds = existing.map(r => String(r.user_id));
        const conflictNames = selectedUsers
            .filter(u => conflictUserIds.includes(String(u.id)))
            .map(u => `• ${u.name}`);

        if (conflictNames.length === 0) {
            // Конфликтов нет — сразу назначаем всем
            const created = [];
            for (const emp of selectedUsers) {
                await setEmpWorkSchedule(String(emp.id), emp.name, scheduleType, cycleStart, dateEnd, String(userId));
                created.push(emp.name);
                const notifyText = `📊 Вам назначен новый график работы\n\n` +
                    `${WORK_SCHEDULE_TYPES[scheduleType]?.label || scheduleType}\n` +
                    (dateEnd ? `📅 До: ${new Date(dateEnd).toLocaleDateString('ru-RU')}` : `📅 Бессрочно`) +
                    `\n\nНазначено администратором.`;
                await notifyUserInBotChat(domain, authToken, botId, emp.id, notifyText);
            }
            await clearPending(userId);
            if (data.adminSession) await setPending(userId, 'admin_session', 'active');
            await sendMessage(domain, authToken, botId, dialogId,
                `✅ График назначен!\n\n` +
                `📊 ${WORK_SCHEDULE_TYPES[scheduleType]?.label || scheduleType}\n` +
                (dateEnd ? `📅 До: ${new Date(dateEnd).toLocaleDateString('ru-RU')}\n` : `📅 Бессрочно\n`) +
                `\n✅ Назначено: ${created.length} чел.\n${created.map(n => `  • ${n}`).join('\n')}`,
                kbWorkSched());
            return;
        }

        // Есть конфликты — спрашиваем
        await setPending(userId, 'ws_bulk', 'confirm_conflicts', {
            ...data, dateEnd, conflictUserIds
        });
        await sendMessage(domain, authToken, botId, dialogId,
            `⚠️ У ${conflictNames.length} сотр. уже есть назначенный график:\n\n` +
            `${conflictNames.join('\n')}\n\n` +
            `Что сделать с конфликтами?`,
            kbWsBulkConflict());
        return;
    }

    // ── Массовое расписание: поиск сотрудников ──────────────────────────────────
    if (action === 'bulk_schedule' && step === 'search_users') {
        await sendMessage(domain, authToken, botId, dialogId, `🔍 Ищу "${val}"...`, null);
        const users = await searchBitrixUsers(domain, authToken, val);
        if (!users.length) {
            await sendMessage(domain, authToken, botId, dialogId, `❌ Сотрудник не найден. Попробуй другое имя:`, kbCancel());
            return;
        }
        if (users.length === 1) {
            const already = (data.selectedUsers || []).find(u => String(u.id) === String(users[0].id));
            if (already) {
                await sendMessage(domain, authToken, botId, dialogId, `ℹ️ ${users[0].name} уже в списке.`, kbBulkAddMore(data.selectedUsers));
                return;
            }
            const updatedUsers = [...(data.selectedUsers || []), { id: users[0].id, name: users[0].name }];
            await setPending(userId, 'bulk_schedule', 'adding_users', { ...data, selectedUsers: updatedUsers });
            const names = updatedUsers.map(u => `• ${u.name}`).join('\n');
            await sendMessage(domain, authToken, botId, dialogId,
                `✅ Добавлен: ${users[0].name}\n\n👥 Выбрано (${updatedUsers.length}):\n${names}\n\nЧто дальше?`,
                kbBulkAddMore(updatedUsers));
            return;
        }
        await setPending(userId, 'bulk_schedule', 'search_users', { ...data, foundUsers: users });
        const kbSel = [];
        users.slice(0, 5).forEach((u, i) => {
            if (i > 0 && i % 2 === 0) kbSel.push({ TYPE:'NEWLINE' });
            kbSel.push({ TEXT: u.name, COMMAND: `bulk_select_user_${i}`, COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#5b8def', TEXT_COLOR:'#ffffff' });
        });
        kbSel.push({ TYPE:'NEWLINE' });
        kbSel.push({ TEXT:'❌ Отмена', COMMAND:'cancel_input', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#888888', TEXT_COLOR:'#ffffff' });
        await sendMessage(domain, authToken, botId, dialogId,
            `🔍 Найдено несколько:\n${users.slice(0,5).map((u,i)=>`${i+1}. ${u.name}`).join('\n')}\n\nВыбери нужного:`,
            kbSel);
        return;
    }

    // ── Массовое расписание: ввод даты начала ───────────────────────────────────
    if (action === 'bulk_schedule' && step === 'date_from') {
        const d = parseDate(val);
        if (!d) { await sendMessage(domain, authToken, botId, dialogId, `⚠️ Неверный формат. Введи ДД.ММ.ГГГГ:`, kbCancel()); return; }
        await setPending(userId, 'bulk_schedule', 'date_to', { ...data, dateFrom: d });
        await sendMessage(domain, authToken, botId, dialogId, `✅ Начало: ${val}\n\n📅 Шаг 4: Введи дату окончания:`, kbCancel());
        return;
    }

    // ── Массовое расписание: ввод даты окончания ────────────────────────────────
    if (action === 'bulk_schedule' && step === 'date_to') {
        const d = parseDate(val);
        if (!d) { await sendMessage(domain, authToken, botId, dialogId, `⚠️ Неверный формат. Введи ДД.ММ.ГГГГ:`, kbCancel()); return; }
        if (d < data.dateFrom) { await sendMessage(domain, authToken, botId, dialogId, `⚠️ Дата окончания не может быть раньше даты начала. Введи снова:`, kbCancel()); return; }
        await setPending(userId, 'bulk_schedule', 'comment', { ...data, dateTo: d });
        await sendMessage(domain, authToken, botId, dialogId, `✅ Окончание: ${val}\n\n💬 Введи комментарий (или *-* если не нужен):`, kbCancel());
        return;
    }

    // ── Массовое расписание: комментарий → проверка конфликтов ─────────────────
    if (action === 'bulk_schedule' && step === 'comment') {
        const comment = (val === '-' || val === '—') ? null : val;
        const { selectedUsers, status, dateFrom, dateTo } = data;
        const userIds = selectedUsers.map(u => String(u.id));

        const conflictMapRaw = await checkBulkConflicts(userIds, dateFrom, dateTo);

        const conflictMapObj = {};
        for (const [uid, conflicts] of conflictMapRaw.entries()) {
            conflictMapObj[uid] = conflicts;
        }

        const conflictNames = selectedUsers
            .filter(u => conflictMapRaw.has(String(u.id)))
            .map(u => {
                const cs = conflictMapRaw.get(String(u.id));
                return `• ${u.name}: ${cs.map(c => `${SCHED_LABELS[c.status]||c.status} (${new Date(c.date_from).toLocaleDateString('ru-RU')}–${new Date(c.date_to).toLocaleDateString('ru-RU')})`).join(', ')}`;
            });

        const from = new Date(dateFrom).toLocaleDateString('ru-RU');
        const to   = new Date(dateTo).toLocaleDateString('ru-RU');

        if (conflictNames.length === 0) {
            const { created } = await insertBulkSchedule(
                selectedUsers, status, dateFrom, dateTo, comment,
                userId, conflictMapRaw, userIds
            );
            
            await logAudit('schedule_bulk_add', { id: FROM_USER_ID, name: resolvedName }, null,
                {mode: 'skip', status, date_from: dateFrom, date_to: dateTo, comment: comment || null, created, skipped},
            domain);

            await clearPending(userId);
            if (data.adminSession) await setPending(userId, 'admin_session', 'active');
            for (const emp of selectedUsers.filter(u => created.includes(u.name))) {
                const notifyText = `📅 Вам назначено расписание\n\n${SCHED_LABELS[status]}\n📅 ${from} — ${to}` +
                    (comment ? `\n💬 ${comment}` : '') + `\n\nИнформация внесена администратором.`;
                await notifyUserInBotChat(domain, authToken, botId, emp.id, notifyText);
            }
            await sendMessage(domain, authToken, botId, dialogId,
                `✅ Расписание создано!\n\n` +
                `📋 ${SCHED_LABELS[status]}: ${from} — ${to}\n` +
                (comment ? `💬 ${comment}\n` : '') +
                `\n✅ Создано: ${created.length} чел.\n${created.map(n=>`  • ${n}`).join('\n')}`,
                kbSchedule());
            return;
        }

        await setPending(userId, 'bulk_schedule', 'confirm_conflicts', {
            ...data, comment, conflictMap: conflictMapObj
        });
        await sendMessage(domain, authToken, botId, dialogId,
            `⚠️ Обнаружены конфликты расписания!\n\n` +
            `Для ${conflictNames.length} сотр. уже есть записи на ${from} — ${to}:\n\n` +
            `${conflictNames.join('\n')}\n\n` +
            `Что сделать с конфликтами?`,
            kbBulkConflict());
        return;
    }

    
 // ── Удаление отметок (attendance): поиск сотрудника ─────────────────────────
 if (action === 'att_delete' && step === 'search_user') {
 const users = await searchBitrixUsers(domain, authToken, val);
 if (!users.length) {
 await sendMessage(domain, authToken, botId, dialogId, `❌ Сотрудник "${val}" не найден. Попробуй другое имя:`, kbCancel());
 return;
 }
 if (users.length === 1) {
 await setPending(userId, 'att_delete', 'pick_date', { ...data, targetUserId: users[0].id, targetUserName: users[0].name, adminSession: true });
 await sendMessage(domain, authToken, botId, dialogId, `👤 Найден: ${users[0].name}

📅 Введи дату (ДД.ММ.ГГГГ), за которую удалить отметки:`, kbCancel());
 return;
 }
await setPending(userId, 'att_delete_select_user', 'pick', { ...data, foundUsers: users, adminSession: true });

const list = users
  .slice(0, 5)
  .map((u, i) => `${i + 1}. ${u.name}`)
  .join('\n');

await sendMessage(
  domain, authToken, botId, dialogId,
  `🔍 Найдено несколько сотрудников — выбери нужного:\n\n${list}`,
  kbUserSelect(users)
);

return;
 }

 // ── Удаление отметок: ввод даты и удаление ─────────────────────────────────
 if (action === 'att_delete' && step === 'pick_date') {
 const d = parseDate(val);
 if (!d) {
 await sendMessage(domain, authToken, botId, dialogId, `⚠️ Неверный формат. Введи ДД.ММ.ГГГГ:`, kbCancel());
 return;
 }
 const { rowCount } = await pool.query(`
 DELETE FROM attendance
 WHERE user_id = $1
 AND (timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date = $2::date
 `, [String(data.targetUserId), d]);

 // ЛОГИРОВАНИЕ УДАЛЕНИЯ ОТМЕТОК
 await logAudit('attendance_delete',
 { id: userId, name: userName },
 { id: data.targetUserId, name: data.targetUserName },
 { date: d, deleted_rows: rowCount },
 domain);

 await clearPending(userId);
 if (data.adminSession) await setPending(userId, 'admin_session', 'active');
 await sendMessage(domain, authToken, botId, dialogId,
 rowCount ? `✅ Удалено отметок: ${rowCount}
👤 ${data.targetUserName}
📅 Дата: ${val}` : `ℹ️ За ${val} у ${data.targetUserName} не было отметок.`,
 kbAdmin());
 return;
 }

if (action === 'schedule_add' && step === 'search_user') {
        const users = await searchBitrixUsers(domain, authToken, val);
        if (!users.length) {
            await sendMessage(domain, authToken, botId, dialogId, `❌ Сотрудник "${val}" не найден.\n\nПопробуй другое имя:`, kbCancel());
            return;
        }
        if (users.length === 1) {
            await setPending(userId, 'schedule_add', 'date_from', { ...data, userId: users[0].id, userName: users[0].name });
            await sendMessage(domain, authToken, botId, dialogId, `👤 Найден: ${users[0].name}\n\n📅 Введи дату начала в формате ДД.ММ.ГГГГ:`, kbCancel());
            return;
        }
        await setPending(userId, 'schedule_select_user', 'pick', { ...data, foundUsers: users });
        await sendMessage(domain, authToken, botId, dialogId,
            `🔍 Найдено несколько сотрудников — выбери нужного:\n\n${users.slice(0,5).map((u,i)=>`${i+1}. ${u.name}`).join('\n')}`,
            kbUserSelect(users));
        return;
    }

    if (action === 'schedule_add' && step === 'date_from') {
        const d = parseDate(val);
        if (!d) { await sendMessage(domain, authToken, botId, dialogId, `⚠️ Неверный формат. Введи ДД.ММ.ГГГГ, например: 15.03.2025`, kbCancel()); return; }
        await setPending(userId, 'schedule_add', 'date_to', { ...data, dateFrom: d });
        await sendMessage(domain, authToken, botId, dialogId, `✅ Начало: ${val}\n\n📅 Введи дату окончания:`, kbCancel());
        return;
    }

    if (action === 'schedule_add' && step === 'date_to') {
        const d = parseDate(val);
        if (!d) { await sendMessage(domain, authToken, botId, dialogId, `⚠️ Неверный формат. Введи ДД.ММ.ГГГГ:`, kbCancel()); return; }
        await setPending(userId, 'schedule_add', 'comment', { ...data, dateTo: d });
        await sendMessage(domain, authToken, botId, dialogId, `✅ Окончание: ${val}\n\n💬 Введи комментарий (или *-* если не нужен):`, kbCancel());
        return;
    }

    
    if (action === 'schedule_add' && step === 'comment') {
        const comment = (val === '-' || val === '—') ? null : val;
        const ins = await pool.query(
            `INSERT INTO schedules (user_id,user_name,status,date_from,date_to,comment,created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
             RETURNING id`,
            [data.userId, data.userName, data.status, data.dateFrom, data.dateTo, comment, userId]);

        const schedId = ins.rows?.[0]?.id;
        await logAudit(
            'schedule_add',
            { id: userId, name: userName },
            { id: data.userId, name: data.userName },
            {
                schedule_id: schedId,
                status: data.status,
                date_from: data.dateFrom,
                date_to: data.dateTo,
                comment: comment || null
            },
        domain);

        const from = new Date(data.dateFrom).toLocaleDateString('ru-RU');
        const to = new Date(data.dateTo).toLocaleDateString('ru-RU');
        const label = SCHED_LABELS[data.status];

        await done(
            `✅ Запись добавлена в расписание!\n\n👤 ${data.userName}\n📋 ${label}\n📅 ${from} — ${to}` +
            (comment ? `\n💬 ${comment}` : ''),
                kbSchedule());


        if (data.userId) {
            const portal = await getPortal(domain);
            if (portal?.bot_id) {
                const notifyText = `📅 Вам назначено расписание\n\n${label}\n📅 ${from} — ${to}` +
                    (comment ? `\n💬 ${comment}` : '') + `\n\nИнформация внесена администратором.`;
                const sent = await notifyUserInBotChat(domain, authToken, portal.bot_id, data.userId, notifyText);
                if (!sent) {
                    console.warn(`⚠️ Сотрудник ${data.userName} (ID=${data.userId}) ещё не открывал чат с ботом — уведомление не отправлено`);
                }
            }
        }
        return;
    }

    if (action === 'schedule_delete' && step === 'id') {
        const id = parseInt(val);
        if (!id) { await sendMessage(domain, authToken, botId, dialogId, `⚠️ Введи числовой ID записи:`, kbCancel()); return; }
        const before = await pool.query(`SELECT * FROM schedules WHERE id=$1`, [id]);
        const rec = before.rows?.[0] || null;
        const { rowCount } = await pool.query(`DELETE FROM schedules WHERE id=$1`, [id]);
        await done(rowCount ? `✅ Запись #${id} удалена.` : `❌ Запись #${id} не найдена.`, kbSchedule());
        if (rowCount && rec) {
        await logAudit(
            'schedule_delete',
            { id: userId, name: userName },
            { id: rec.user_id, name: rec.user_name },
            { schedule_id: id, status: rec.status, date_from: rec.date_from, date_to: rec.date_to, comment: rec.comment || null },
            domain);
    }
        return;
    }

    // ── Назначение типа графика: поиск сотрудника ──
    if (action === 'ws_assign' && step === 'search_user') {
        await sendMessage(domain, authToken, botId, dialogId, `🔍 Ищу "${val}"...`, null);
        const users = await searchBitrixUsers(domain, authToken, val);
        if (!users.length) {
            await sendMessage(domain, authToken, botId, dialogId, `❌ Сотрудник "${val}" не найден. Попробуй другое имя:`, kbCancel());
            return;
        }

        if (users.length === 1) {
            await setPending(userId, 'ws_assign', 'pick_type', { ...data, userId: users[0].id, userName: users[0].name });
            await sendMessage(domain, authToken, botId, dialogId,
                `👤 Найден: ${users[0].name}\n\n📊 Выбери тип рабочего графика:`, kbWorkSchedType());
            return;
        }
        await setPending(userId, 'ws_assign', 'pick_user_then_type', { ...data, foundUsers: users });
        const btns = users.slice(0, 5).flatMap((u, i) => {
            const line = (i > 0 && i % 2 === 0) ? [{ TYPE:'NEWLINE' }] : [];
            return [...line, { TEXT: u.name, COMMAND: `ws_select_${i}`, COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#5b8def', TEXT_COLOR:'#ffffff' }];
        }).concat([{ TYPE:'NEWLINE' }, { TEXT:'❌ Отмена', COMMAND:'cancel_input', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#888888', TEXT_COLOR:'#ffffff' }]);
        await sendMessage(domain, authToken, botId, dialogId,
            `🔍 Найдено несколько:\n${users.slice(0,5).map((u,i)=>`${i+1}. ${u.name}`).join('\n')}\n\nВыбери:`, btns);
        return;
    }

    // ── Назначение типа графика: ввод даты начала цикла (для 4/2 и 2/2) ──
    if (action === 'ws_assign' && step === 'cycle_start') {
        const d = parseDate(val);
        if (!d) {
            await sendMessage(domain, authToken, botId, dialogId, 
                `⚠️ Неверный формат. Введи ДД.ММ.ГГГГ, например: 01.04.2026`, 
                kbCancel());
            return;
        }
        
        // Сохраняем cycleStart и переходим к вопросу о дате окончания
        await setPending(userId, 'ws_assign', 'date_end', { 
            ...data, 
            scheduleType: data.scheduleType, 
            cycleStart: d 
        });
        
        await sendMessage(domain, authToken, botId, dialogId,
            `📅 Начало цикла: ${val}\n\n` +
            `📅 Введи дату окончания графика (ДД.ММ.ГГГГ) или *-* если бессрочно:`,
            kbCancel());
        return;
    }

    // ── Назначение типа графика: ввод даты окончания ──
    if (action === 'ws_assign' && step === 'date_end') {
        let dateEnd = null;
        if (val !== '-' && val !== '—') {
            dateEnd = parseDate(val);
            if (!dateEnd) {
                await sendMessage(domain, authToken, botId, dialogId, 
                    `⚠️ Неверный формат. Введи ДД.ММ.ГГГГ или *-* для бессрочного графика:`, 
                    kbCancel());
                return;
            }
        }
        
        const typeInfo = WORK_SCHEDULE_TYPES[data.scheduleType];
        const startRu = new Date(data.cycleStart).toLocaleDateString('ru-RU');
        const endRu = dateEnd ? new Date(dateEnd).toLocaleDateString('ru-RU') : 'бессрочно';
        
        await setEmpWorkSchedule(data.userId, data.userName, data.scheduleType, data.cycleStart, dateEnd, userId);
        await logAudit('work_schedule_assign',{ id: userId, name: userName },{ id: data.userId, name: data.userName },{ schedule_type: data.scheduleType, cycle_start: data.cycleStart, date_end: dateEnd || null },domain);
        await clearPending(userId);
        if (data.adminSession) await setPending(userId, 'admin_session', 'active');
        
        await sendMessage(domain, authToken, botId, dialogId,
            `✅ График назначен!\n\n👤 ${data.userName}\n📊 ${typeInfo.label}\n📅 Начало цикла: ${startRu}\n📅 Окончание: ${endRu}\n\nВыходные дни будут корректно учтены в отчётах и напоминаниях.`,
            kbWorkSched());
        return;
    }

    // ── Удаление типа графика: поиск сотрудника ──
    if (action === 'ws_remove' && step === 'search_user') {
        await sendMessage(domain, authToken, botId, dialogId, `🔍 Ищу "${val}"...`, null);
        const users = await searchBitrixUsers(domain, authToken, val);
        if (!users.length) {
            await sendMessage(domain, authToken, botId, dialogId, `❌ Сотрудник "${val}" не найден. Попробуй другое имя:`, kbCancel());
            return;
        }
        if (users.length === 1) {
            const removed = await removeEmpWorkSchedule(users[0].id);
            await done(
                removed ? `✅ График сотрудника ${users[0].name} удалён.` : `ℹ️ У ${users[0].name} не был назначен тип графика.`,
                kbWorkSched());
            return;
        }
        
        if (removed) {
            await logAudit('work_schedule_remove', { id: FROM_USER_ID, name: resolvedName },{ id: sel.id, name: sel.name }, {}, domain);
        }

        await setPending(userId, 'ws_remove', 'pick_user', { ...data, foundUsers: users });
        const btns = users.slice(0, 5).flatMap((u, i) => {
            const line = (i > 0 && i % 2 === 0) ? [{ TYPE:'NEWLINE' }] : [];
            return [...line, { TEXT: u.name, COMMAND: `ws_select_${i}`, COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#e05c5c', TEXT_COLOR:'#ffffff' }];
        }).concat([{ TYPE:'NEWLINE' }, { TEXT:'❌ Отмена', COMMAND:'cancel_input', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#888888', TEXT_COLOR:'#ffffff' }]);
        await sendMessage(domain, authToken, botId, dialogId,
            `🔍 Найдено несколько:\n${users.slice(0,5).map((u,i)=>`${i+1}. ${u.name}`).join('\n')}\n\nВыбери сотрудника для удаления графика:`, btns);
        return;
    }

    await clearPending(userId);
    if (pending.data?.adminSession) await setPending(userId, 'admin_session', 'active');
    await sendMessage(domain, authToken, botId, dialogId, `⚠️ Что-то пошло не так. Начни заново.`, kbAdmin());
}


// ─── Вспомогательные маршруты ─────────────────────────────────────────────────

app.get('/', (req, res) => {
    res.send(`<h1>🤖 Бот учёта рабочего времени</h1><ul>
    <li><a href="/status">Статус</a></li>
    <li><a href="/debug">Debug</a></li>
    <li><a href="/sync-employees">🔄 Синхронизировать сотрудников из Битрикс24</a></li>
    <li><a href="/register-commands">Зарегистрировать команды</a></li>
    <li><a href="/reinstall-bot">Перерегистрировать бота</a></li>
    <li><a href="/test-bot">Тест бота</a></li></ul>`);
});

app.get('/status', async (req, res) => {
    const { rows } = await pool.query(`SELECT domain, bot_id, updated_at FROM portals`);
    res.json({ ok:true, service:'v14', portals:rows, time:new Date().toISOString(),
        env:{ app_domain:APP_DOMAIN, office:`${OFFICE_LAT},${OFFICE_LON}`, radius:OFFICE_RADIUS,
              office2: OFFICE2_LAT ? `${OFFICE2_LAT},${OFFICE2_LON} (${OFFICE2_NAME})` : 'не задан',
              manager:MANAGER_ID, report_email:smtpConfig.reportEmails, smtp:`${smtpConfig.smtpHost}:${smtpConfig.smtpPort}`, smtp_ready:!!(smtpConfig.smtpUser&&smtpConfig.smtpPass) } });
});

app.get('/debug', async (req, res) => {
    const domain = req.query.domain || BITRIX_DOMAIN;
    const portal = await getPortal(domain);
    const { rows: admins }    = await pool.query(`SELECT user_id, user_name, added_at FROM admins`);
    const { rows: schedules } = await pool.query(`SELECT * FROM schedules WHERE date_to>=CURRENT_DATE ORDER BY date_from`);
    const { rows: employees } = await pool.query(`SELECT user_id, user_name, dialog_id, last_seen FROM employees ORDER BY user_name`);
    res.json({ domain, portal_in_db:!!portal,
        data: portal ? { bot_id:portal.bot_id, token:portal.access_token?.slice(0,12)+'...', updated:portal.updated_at } : null,
        admins, active_schedules:schedules, employees });
});

app.get('/register-commands', async (req, res) => {
    const domain = req.query.domain || BITRIX_DOMAIN;
    const portal = await getPortal(domain);
    if (!portal || !portal.bot_id) return res.json({ ok:false, error:'Портал или bot_id не найден.' });
    await registerCommands(domain, portal.access_token, portal.bot_id);
    res.json({ ok:true, message:`✅ Команды зарегистрированы для бота ID=${portal.bot_id}.` });
});

app.get('/reinstall-bot', async (req, res) => {
    const domain = req.query.domain || BITRIX_DOMAIN;
    const portal = await getPortal(domain);
    if (!portal) return res.json({ ok:false, error:'Портал не найден.' });
    const log = [];
    const profile = await callBitrix(domain, portal.access_token, 'profile', {});
    log.push({ profile: profile?.result ? '✅ токен валидный' : '❌ невалидный' });
    if (!profile?.result) {
        if (!portal.refresh_token) return res.json({ ok:false, log, error:'Нет refresh_token.' });
        const newToken = await doRefreshToken(domain, portal.refresh_token);
        log.push({ refresh: newToken ? '✅ обновлён' : '❌ не удалось' });
        if (!newToken) return res.json({ ok:false, log, error:'Нажми "Переустановить" в Битрикс24.' });
    }
    const fresh = await getPortal(domain);
    const botId = await registerBot(domain, fresh.access_token, fresh.bot_id || null);
    if (botId) { await savePortal(domain, fresh.access_token, fresh.refresh_token, botId, fresh.client_endpoint); log.push({ bot:`✅ ID=${botId}` }); }
    res.json({ ok:!!botId, log, bot_id:botId });
});

app.get('/test-bot', async (req, res) => {
    const domain = req.query.domain || BITRIX_DOMAIN;
    const portal = await getPortal(domain);
    if (!portal) return res.json({ ok:false, error:'Портал не найден.' });
    const profile   = await callBitrix(domain, portal.access_token, 'profile', {});
    const bots      = await callBitrix(domain, portal.access_token, 'imbot.bot.list', {});
    const { rows: admins }    = await pool.query(`SELECT user_id, user_name FROM admins`);
    const { rows: employees } = await pool.query(`SELECT user_id, user_name, dialog_id FROM employees ORDER BY user_name`);
    res.json({ bot_id:portal.bot_id,
        profile_check: profile?.result ? `✅ ${profile.result.NAME} ${profile.result.LAST_NAME}` : '❌',
        bots_in_b24: bots?.result||null, admins_in_db:admins, employees_in_db:employees,
        smtp:`${smtpConfig.smtpHost}:${smtpConfig.smtpPort}`, smtp_ready:!!(smtpConfig.smtpUser&&smtpConfig.smtpPass), report_email:smtpConfig.reportEmails });
});

app.get('/sync-employees', async (req, res) => {
    const domain = req.query.domain || BITRIX_DOMAIN;
    const portal = await getPortal(domain);
    if (!portal) return res.json({ ok:false, error:'Портал не найден.' });
    const count = await syncAllEmployees(domain, portal.access_token);
    const { rows } = await pool.query(`SELECT user_id, user_name, dialog_id FROM employees ORDER BY user_name`);
    res.json({ ok:true, synced:count, employees:rows });
});

// ─── Очистка ──────────────────────────────────────────────────────────────────


cron.schedule('*/15 * * * *', async () => {
    await pool.query(`DELETE FROM geo_tokens WHERE created_at < NOW()-INTERVAL '15 minutes'`);
    // Удаляем незавершённые диалоги (не admin_session)
    await pool.query(`DELETE FROM pending_input 
        WHERE action != 'admin_session' 
          AND created_at < NOW()-INTERVAL '30 minutes'`);
    // admin_session не трогаем — она продлевается через touchAdminSession при каждом действии
    // Но если сессия совсем старая (8+ часов) — считаем её брошенной
    await pool.query(`DELETE FROM pending_input 
        WHERE action = 'admin_session' 
          AND created_at < NOW()-INTERVAL '8 hours'`);
    console.log('🧹 Очистка');
});

// Утро в 9:00 Екатеринбург = 4:00 UTC — КАЖДЫЙ ДЕНЬ
cron.schedule('0 4 * * *', async () => {
    console.log('⏰ Утреннее напоминание');
    await morningReminder();
}, { timezone: 'UTC' });

// Вечер в 18:00 Екатеринбург = 13:00 UTC — КАЖДЫЙ ДЕНЬ
cron.schedule('0 13 * * *', async () => {
    console.log('⏰ Вечернее напоминание об уходе');
    await eveningReminder();
}, { timezone: 'UTC' });

// ─── Запуск ───────────────────────────────────────────────────────────────────

initDB().then(() => {
    app.listen(port, '0.0.0.0', () => {
        console.log(`🚀 https://${APP_DOMAIN}`);
        console.log(`📍 Офис 1: ${OFFICE_LAT}, ${OFFICE_LON} (${OFFICE_RADIUS}м)`);
        if (OFFICE2_LAT) console.log(`📍 Офис 2: ${OFFICE2_LAT}, ${OFFICE2_LON} — ${OFFICE2_NAME}`);
        console.log(`🆔 Менеджер: ${MANAGER_ID}`);
        console.log(`📧 ${smtpConfig.reportEmails} | SMTP: ${smtpConfig.smtpUser ? `✅ ${smtpConfig.smtpHost}:${smtpConfig.smtpPort}` : '❌ не настроен'}`);
        console.log('=== ✅ READY ===');
    });
    reports.scheduleCronReports(pool, smtpConfig);
}).catch(err => {
    console.error('❌ БД:', err.message);
    process.exit(1);
});
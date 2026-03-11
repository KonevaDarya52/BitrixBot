require('dotenv').config();
const express    = require('express');
const axios      = require('axios');
const { Pool }   = require('pg');
const cron       = require('node-cron');
const ExcelJS    = require('exceljs');
const nodemailer = require('nodemailer');
const os         = require('os');
const path       = require('path');
const fs         = require('fs');

const app  = express();
const port = process.env.PORT || 10000;

const APP_DOMAIN    = process.env.APP_DOMAIN           || 'bitrixbot-bnnd.onrender.com';
const BITRIX_DOMAIN = process.env.BITRIX_DOMAIN        || 'b24-cviqlp.bitrix24.ru';
const CLIENT_ID     = process.env.BITRIX_CLIENT_ID     || 'local.699ef5d96dc8a3.90486015';
const CLIENT_SECRET = process.env.BITRIX_CLIENT_SECRET || 'mBn7t9j3UF53bEOpp0fQ5S5favymHeguNh1d72U4E0KOaNb3kQ';
const OFFICE_LAT    = parseFloat(process.env.OFFICE_LAT    || '57.151929');
const OFFICE_LON    = parseFloat(process.env.OFFICE_LON    || '65.592076');
const OFFICE_RADIUS = parseInt(process.env.OFFICE_RADIUS   || '100');
const MANAGER_ID    = process.env.MANAGER_USER_ID          || '1';

const REPORT_EMAIL = process.env.REPORT_EMAIL || 'koneva_dashenka06@vk.com';

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.mail.ru';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587');
const SMTP_USER = process.env.SMTP_USER || 'koneva_dashenka06@vk.com';
const SMTP_PASS = process.env.SMTP_PASS || '83lo xagi noto hima';

// ─── PostgreSQL ───────────────────────────────────────────────────────────────
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
        user_id TEXT PRIMARY KEY,
        user_name TEXT,
        added_at TIMESTAMPTZ DEFAULT NOW())`);

    await pool.query(`CREATE TABLE IF NOT EXISTS schedules (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        status TEXT NOT NULL,
        date_from DATE NOT NULL,
        date_to DATE NOT NULL,
        comment TEXT,
        created_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW())`);

    await pool.query(`CREATE TABLE IF NOT EXISTS pending_input (
        user_id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        step TEXT,
        data JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW())`);

    await pool.query(`CREATE TABLE IF NOT EXISTS employees (
        user_id TEXT PRIMARY KEY,
        user_name TEXT NOT NULL,
        domain TEXT,
        first_seen TIMESTAMPTZ DEFAULT NOW(),
        last_seen TIMESTAMPTZ DEFAULT NOW())`);

    console.log('✅ БД инициализирована');
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    console.log(`📍 ${new Date().toISOString()} ${req.method} ${req.url}`);
    next();
});


function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function makeToken() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h} ч ${m} мин`;
}

function tzTime(ts) {
    return new Date(ts).toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', timeZone:'Asia/Yekaterinburg' });
}

function tzDate(ts) {
    return new Date(ts).toLocaleDateString('ru-RU', { timeZone:'Asia/Yekaterinburg' });
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
    vacation: '🏖 Отпуск',
    sick:     '🤒 Больничный',
    dayoff:   '📅 Выходной',
    remote:   '🏠 Удалённо',
    business: '✈️ Командировка',
};


async function isAdmin(userId) {
    if (String(userId) === String(MANAGER_ID)) return true;
    const { rows } = await pool.query(`SELECT 1 FROM admins WHERE user_id = $1`, [String(userId)]);
    return rows.length > 0;
}

async function addAdmin(userId, userName) {
    await pool.query(
        `INSERT INTO admins (user_id, user_name)
         VALUES ($1,$2)
         ON CONFLICT (user_id) DO UPDATE SET user_name=EXCLUDED.user_name, added_at=NOW()`,
        [String(userId), userName]
    );
}

async function removeAdmin(userId) {
    if (String(userId) === String(MANAGER_ID)) return;
    await pool.query(`DELETE FROM admins WHERE user_id = $1`, [String(userId)]);
}

async function listAdmins() {
    const { rows } = await pool.query(`SELECT user_id, user_name FROM admins ORDER BY added_at`);
    return rows;
}


async function setPending(userId, action, step, data = {}) {
    await pool.query(
        `INSERT INTO pending_input (user_id,action,step,data,created_at)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (user_id) DO UPDATE SET action=EXCLUDED.action, step=EXCLUDED.step, data=EXCLUDED.data, created_at=NOW()`,
        [String(userId), action, step, JSON.stringify(data)]
    );
}

async function getPending(userId) {
    const { rows } = await pool.query(`SELECT * FROM pending_input WHERE user_id=$1`, [String(userId)]);
    return rows[0] || null;
}

async function clearPending(userId) {
    await pool.query(`DELETE FROM pending_input WHERE user_id=$1`, [String(userId)]);
}


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

async function registerEmployee(userId, userName, domain) {
    if (!userId || !userName) return;
    await pool.query(
        `INSERT INTO employees (user_id, user_name, domain, first_seen, last_seen)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (user_id) DO UPDATE SET
             user_name = EXCLUDED.user_name,
             last_seen = NOW()`,
        [String(userId), userName, domain]
    );
}

async function syncAllEmployees(domain, accessToken) {
    try {
        let start = 0, total = 0;
        do {
            const resp = await callBitrix(domain, accessToken, 'user.get', {
                ACTIVE: true,
                start,
            });
            if (!resp?.result?.length) break;
            for (const u of resp.result) {
                const name = `${u.NAME || ''} ${u.LAST_NAME || ''}`.trim();
                if (name) await registerEmployee(String(u.ID), name, domain);
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

async function searchBitrixUsers(domain, accessToken, query) {
    const resp = await callBitrix(domain, accessToken, 'user.search', {
        NAME: query,
        ACTIVE: true,
    });
    let users = [];
    if (resp?.result && Array.isArray(resp.result)) {
        users = resp.result;
    }
    if (!users.length) {
        const resp2 = await callBitrix(domain, accessToken, 'user.search', {
            LAST_NAME: query,
            ACTIVE: true,
        });
        if (resp2?.result && Array.isArray(resp2.result)) {
            users = resp2.result;
        }
    }
    return users.map(u => ({
        id:   String(u.ID),
        name: `${u.NAME || ''} ${u.LAST_NAME || ''}`.trim(),
        dept: u.UF_DEPARTMENT ? String(u.UF_DEPARTMENT) : '',
    }));
}

async function getBitrixUser(domain, accessToken, userId) {
    const resp = await callBitrix(domain, accessToken, 'user.get', { ID: userId });
    if (resp?.result && resp.result.length) {
        const u = resp.result[0];
        return {
            id:   String(u.ID),
            name: `${u.NAME || ''} ${u.LAST_NAME || ''}`.trim(),
        };
    }
    return null;
}

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
            `🔐 Вы в режиме *администратора*.\n\n` +
            `📌 Что доступно:\n` +
            `• 📋 Отчёты — приход/уход сотрудников\n` +
            `• 👥 Кто в офисе — онлайн-список\n` +
            `• 🗓 Расписание — отпуска, больничные, выходные\n` +
            `• 👤 Управление — добавить/удалить администратора\n` +
            `• 📤 Отчёт на почту — Excel на почту\n\n` +
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

function kbMain() {
    return [
        { TEXT:'✅ Пришёл',  COMMAND:'arrived', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#29b36b', TEXT_COLOR:'#ffffff' },
        { TEXT:'🚪 Ушёл',   COMMAND:'left',    COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#e05c5c', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'📊 Статус', COMMAND:'status',  COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#5b8def', TEXT_COLOR:'#ffffff' },
        { TEXT:'❓ Помощь', COMMAND:'help',    COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#888888', TEXT_COLOR:'#ffffff' },
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
        { TEXT:'👤 Управление',       COMMAND:'admin_manage', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#7b4fa6', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'📤 Отчёт на почту',   COMMAND:'send_report',  COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#2e7d32', TEXT_COLOR:'#ffffff' },
        { TEXT:'🔓 Выйти из админа',  COMMAND:'admin_logout', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#888888', TEXT_COLOR:'#ffffff' },
    ];
}

function kbSchedule() {
    return [
        { TEXT:'🏖 Отпуск',       COMMAND:'sched_vacation', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#f4a724', TEXT_COLOR:'#ffffff' },
        { TEXT:'🤒 Больничный',   COMMAND:'sched_sick',     COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#e05c5c', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'📅 Выходной',     COMMAND:'sched_dayoff',   COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#888888', TEXT_COLOR:'#ffffff' },
        { TEXT:'🏠 Удалённо',     COMMAND:'sched_remote',   COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#5b8def', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'✈️ Командировка', COMMAND:'sched_business', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#3a7bd5', TEXT_COLOR:'#ffffff' },
        { TEXT:'📋 Список',       COMMAND:'sched_list',     COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#29b36b', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'🗑 Удалить запись', COMMAND:'sched_delete', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#c0392b', TEXT_COLOR:'#ffffff' },
        { TEXT:'◀️ Назад',         COMMAND:'admin_back',    COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#555555', TEXT_COLOR:'#ffffff' },
    ];
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
        { TEXT:'📋 Сегодня',  COMMAND:'email_today', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#5b8def', TEXT_COLOR:'#ffffff' },
        { TEXT:'📅 Неделя',   COMMAND:'email_week',  COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#5b8def', TEXT_COLOR:'#ffffff' },
        { TYPE:'NEWLINE' },
        { TEXT:'📆 Месяц',    COMMAND:'email_month', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#3a7bd5', TEXT_COLOR:'#ffffff' },
        { TEXT:'◀️ Назад',    COMMAND:'admin_back',  COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#555555', TEXT_COLOR:'#ffffff' },
    ];
}

function kbGeo(url, type) {
    return [
        {
            TEXT: type === 'in' ? '📍 Подтвердить приход' : '📍 Подтвердить уход',
            LINK: url, DISPLAY: 'LINE', BG_COLOR: '#2d8cff', TEXT_COLOR: '#ffffff'
        },
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
        btns.push({
            TEXT: u.name,
            COMMAND: `select_user_${i}`,
            COMMAND_PARAMS: '',
            DISPLAY: 'LINE',
            BG_COLOR: '#5b8def',
            TEXT_COLOR: '#ffffff',
        });
    });
    btns.push({ TYPE:'NEWLINE' });
    btns.push({ TEXT:'🔍 Искать снова', COMMAND:'sched_search_again', COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#e07b29', TEXT_COLOR:'#ffffff' });
    btns.push({ TEXT:'❌ Отмена',       COMMAND:'cancel_input',       COMMAND_PARAMS:'', DISPLAY:'LINE', BG_COLOR:'#888888', TEXT_COLOR:'#ffffff' });
    return btns;
}

async function mainKb(userId) {
    return (await isAdmin(userId)) ? kbMainAdmin() : kbMain();
}

async function buildExcelReport(period) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Бот учёта рабочего времени';

    let title, sheetData;
    const today = todaySV();

    if (period === 'today') {
        title = `Отчёт за ${new Date().toLocaleDateString('ru-RU')}`;
        const { rows } = await pool.query(`
            SELECT user_name, user_id,
                MIN(CASE WHEN type='in'  THEN timestamp END) as in_time,
                MAX(CASE WHEN type='out' THEN timestamp END) as out_time,
                COUNT(CASE WHEN type='in' THEN 1 END) as entries
            FROM attendance
            WHERE (timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date = $1::date
            GROUP BY user_id, user_name ORDER BY user_name`, [today]);
        sheetData = rows.map(r => ({
            name:   r.user_name || r.user_id,
            in:     r.in_time  ? tzTime(r.in_time)  : '—',
            out:    r.out_time ? tzTime(r.out_time) : '🟢 в офисе',
            status: r.out_time ? '✅ Ушёл' : '🟢 В офисе',
        }));
    } else if (period === 'week') {
        title = 'Отчёт за 7 дней';
        const { rows } = await pool.query(`
            SELECT user_name, user_id,
                COUNT(DISTINCT (timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date) as days
            FROM attendance WHERE type='in' AND timestamp >= NOW()-INTERVAL '7 days'
            GROUP BY user_id, user_name ORDER BY user_name`);
        sheetData = rows.map(r => ({ name: r.user_name || r.user_id, days: Number(r.days) }));
    } else {
        title = 'Отчёт за 30 дней';
        const { rows } = await pool.query(`
            SELECT user_name, user_id,
                COUNT(DISTINCT (timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date) as days
            FROM attendance WHERE type='in' AND timestamp >= NOW()-INTERVAL '30 days'
            GROUP BY user_id, user_name ORDER BY days DESC`);
        sheetData = rows.map(r => ({ name: r.user_name || r.user_id, days: Number(r.days) }));
    }

    const sheet = workbook.addWorksheet('Отметки');

    sheet.mergeCells('A1:E1');
    const titleCell = sheet.getCell('A1');
    titleCell.value = title;
    titleCell.font  = { bold: true, size: 14, color: { argb: 'FF1a1a2e' } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    titleCell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFe8f0fe' } };
    sheet.getRow(1).height = 28;
    sheet.addRow([]);

    let headers;
    if (period === 'today') {
        headers = ['Сотрудник', 'Приход', 'Уход', 'Статус'];
    } else {
        headers = ['Сотрудник', 'Рабочих дней'];
    }
    const headerRow = sheet.addRow(headers);
    headerRow.eachCell(cell => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF2D8CFF' } };
        cell.alignment = { horizontal:'center', vertical:'middle' };
        cell.border = { bottom: { style:'thin', color:{ argb:'FF1a6ad4' } } };
    });
    headerRow.height = 22;

    sheetData.forEach((r, i) => {
        let row;
        if (period === 'today') {
            row = sheet.addRow([r.name, r.in, r.out, r.status]);
        } else {
            row = sheet.addRow([r.name, r.days]);
        }
        if (i % 2 === 0) {
            row.eachCell(cell => {
                cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFf5f8ff' } };
            });
        }
        row.eachCell(cell => { cell.alignment = { vertical:'middle' }; });
        row.height = 20;
    });

    const schedRows = await pool.query(
        `SELECT * FROM schedules WHERE date_to >= $1 ORDER BY date_from, user_name`, [today]);
    if (schedRows.rows.length) {
        const sheet2 = workbook.addWorksheet('Расписание');
        sheet2.mergeCells('A1:E1');
        const t2 = sheet2.getCell('A1');
        t2.value = 'Расписание сотрудников';
        t2.font  = { bold:true, size:13 };
        t2.alignment = { horizontal:'center' };
        t2.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFfff3e0' } };
        sheet2.getRow(1).height = 26;
        sheet2.addRow([]);
        const sh2 = sheet2.addRow(['Сотрудник', 'Статус', 'Дата начала', 'Дата конца', 'Комментарий']);
        sh2.eachCell(cell => {
            cell.font = { bold:true, color:{ argb:'FFFFFFFF' } };
            cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFE07B29' } };
            cell.alignment = { horizontal:'center' };
        });
        schedRows.rows.forEach((r, i) => {
            const row = sheet2.addRow([
                r.user_name,
                SCHED_LABELS[r.status] || r.status,
                new Date(r.date_from).toLocaleDateString('ru-RU'),
                new Date(r.date_to).toLocaleDateString('ru-RU'),
                r.comment || '',
            ]);
            if (i % 2 === 0) row.eachCell(c => { c.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFfff8f0' } }; });
        });
        sheet2.columns = [{ width:24 },{ width:18 },{ width:16 },{ width:16 },{ width:30 }];
    }

    if (period === 'today') {
        sheet.columns = [{ width:26 },{ width:12 },{ width:14 },{ width:16 }];
    } else {
        sheet.columns = [{ width:26 },{ width:16 }];
    }

    const tmpFile = path.join(os.tmpdir(), `report_${period}_${Date.now()}.xlsx`);
    await workbook.xlsx.writeFile(tmpFile);
    return { file: tmpFile, title };
}

async function sendReportByEmail(period) {
    if (!SMTP_USER || !SMTP_PASS) {
        return { ok:false, error:'SMTP не настроен. Добавь SMTP_USER и SMTP_PASS в переменные окружения на Render.' };
    }
    try {
        const { file, title } = await buildExcelReport(period);

        const transporter = nodemailer.createTransport({
            host:   SMTP_HOST,
            port:   SMTP_PORT,
            secure: SMTP_PORT === 587,
            auth:   { user: SMTP_USER, pass: SMTP_PASS },
            tls:    { rejectUnauthorized: false },
            connectionTimeout: 15000,
            greetingTimeout:   10000,
            socketTimeout:     20000,
        });

        await transporter.sendMail({
            from:        `"Учёт времени" <${SMTP_USER}>`,
            to:          REPORT_EMAIL,
            subject:     `📊 ${title}`,
            text:        `Автоматический отчёт от бота учёта рабочего времени.\nПериод: ${title}`,
            attachments: [{ filename: `${title}.xlsx`, path: file }],
        });

        try { fs.unlinkSync(file); } catch(_) {}
        return { ok:true };
    } catch(err) {
        console.error('❌ Email error:', err.message);
        return { ok:false, error: err.message };
    }
}

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
        [domain, accessToken, refreshToken||'', botId||'', clientEndpoint||'']
    );
}

async function getPortal(domain) {
    const { rows } = await pool.query(`SELECT * FROM portals WHERE domain=$1`, [domain]);
    return rows[0] || null;
}

async function saveAttendance(userId, userName, domain, type, lat, lon, inOffice) {
    const { rows } = await pool.query(
        `INSERT INTO attendance (user_id,user_name,domain,type,latitude,longitude,in_office)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [userId, userName, domain, type, lat, lon, inOffice ? 1 : 0]
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
        [token, userId, userName, dialogId, botId, domain, accessToken, type]
    );
}

async function popGeoToken(token) {
    const { rows } = await pool.query(`DELETE FROM geo_tokens WHERE token=$1 RETURNING *`, [token]);
    return rows[0] || null;
}

async function doRefreshToken(domain, rToken) {
    try {
        const resp = await axios.get('https://oauth.bitrix24.tech/oauth/token/', {
            params: { grant_type:'refresh_token', client_id:CLIENT_ID, client_secret:CLIENT_SECRET, refresh_token:rToken }
        });
        if (resp.data?.access_token) {
            await savePortal(domain, resp.data.access_token, resp.data.refresh_token, '', '');
            console.log('🔄 Токен обновлён для', domain);
            return resp.data.access_token;
        }
    } catch(err) { console.error('❌ refresh token:', err.message); }
    return null;
}

async function callBitrix(domain, accessToken, method, params = {}) {
    try {
        const resp = await axios.post(
            `https://${domain}/rest/${method}`, params,
            { params: { auth: accessToken }, timeout: 10000 }
        );
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
    console.log(`📤 sendMessage → bot=${botId}, dialog=${dialogId}`);
    const params = { BOT_ID:botId, DIALOG_ID:dialogId, MESSAGE:message };
    if (keyboard && keyboard.length) params.KEYBOARD = keyboard;
    const r = await callBitrix(domain, accessToken, 'imbot.message.add', params);
    if (r && r.result === false) console.error('❌ imbot.message.add failed:', JSON.stringify(r));
    return r;
}
async function notifyUser(domain, accessToken, botId, targetUserId, message) {
    const dialogId = `U${targetUserId}`;
    console.log(`📣 notifyUser → userId=${targetUserId}, dialog=${dialogId}`);
    return sendMessage(domain, accessToken, botId, dialogId, message, null);
}

async function registerCommands(domain, accessToken, botId) {
    const handlerUrl = `https://${APP_DOMAIN}/imbot`;
    const cmds = [
        { cmd:'arrived',          title:'Пришёл' },
        { cmd:'left',             title:'Ушёл' },
        { cmd:'status',           title:'Статус' },
        { cmd:'help',             title:'Помощь' },
        { cmd:'menu',             title:'Меню' },
        { cmd:'admin_enter',      title:'Режим администратора' },
        { cmd:'admin_logout',     title:'Выйти из админа' },
        { cmd:'admin_back',       title:'Назад' },
        { cmd:'cancel_input',     title:'Отмена' },
        { cmd:'report_today',     title:'Отчёт сегодня' },
        { cmd:'report_week',      title:'Отчёт за неделю' },
        { cmd:'report_month',     title:'Отчёт за месяц' },
        { cmd:'who_in',           title:'Кто в офисе' },
        { cmd:'send_report',      title:'Отчёт на почту' },
        { cmd:'email_today',      title:'Email сегодня' },
        { cmd:'email_week',       title:'Email неделя' },
        { cmd:'email_month',      title:'Email месяц' },
        { cmd:'schedule',         title:'Расписание' },
        { cmd:'sched_vacation',   title:'Отпуск' },
        { cmd:'sched_sick',       title:'Больничный' },
        { cmd:'sched_dayoff',     title:'Выходной' },
        { cmd:'sched_remote',     title:'Удалённо' },
        { cmd:'sched_business',   title:'Командировка' },
        { cmd:'sched_list',       title:'Список расписания' },
        { cmd:'sched_delete',     title:'Удалить запись' },
        { cmd:'sched_search_again', title:'Искать снова' },
        { cmd:'select_user_0',    title:'Выбрать сотрудника 1' },
        { cmd:'select_user_1',    title:'Выбрать сотрудника 2' },
        { cmd:'select_user_2',    title:'Выбрать сотрудника 3' },
        { cmd:'select_user_3',    title:'Выбрать сотрудника 4' },
        { cmd:'select_user_4',    title:'Выбрать сотрудника 5' },
        { cmd:'admin_manage',     title:'Управление' },
        { cmd:'admin_add',        title:'Добавить админа' },
        { cmd:'admin_remove',     title:'Удалить админа' },
        { cmd:'admin_list',       title:'Список админов' },
    ];
    for (const c of cmds) {
        const r = await callBitrix(domain, accessToken, 'imbot.command.register', {
            BOT_ID: botId, COMMAND: c.cmd,
            HIDDEN: 'Y', EXTRANET_SUPPORT: 'N',
            EVENT_COMMAND_ADD: handlerUrl,
            LANG: [
                { LANGUAGE_ID:'ru', TITLE:c.title, PARAMS:'' },
                { LANGUAGE_ID:'en', TITLE:c.title, PARAMS:'' },
            ],
        });
        console.log(`📎 command.register [${c.cmd}]:`, r?.result ? '✅' : ('❌ ' + JSON.stringify(r)));
    }
}

async function registerBot(domain, accessToken, existingBotId) {
    const handlerUrl = `https://${APP_DOMAIN}/imbot`;
    if (existingBotId) {
        console.log(`🗑 Удаляем бота ID=${existingBotId}...`);
        await callBitrix(domain, accessToken, 'imbot.unregister', { BOT_ID: existingBotId });
        await new Promise(r => setTimeout(r, 1500));
    }
    const resp = await callBitrix(domain, accessToken, 'imbot.register', {
        CODE:'attendance_bot', TYPE:'H',
        EVENT_MESSAGE_ADD:     handlerUrl,
        EVENT_WELCOME_MESSAGE: handlerUrl,
        EVENT_BOT_DELETE:      handlerUrl,
        PROPERTIES: {
            NAME:'Учёт времени', COLOR:'GREEN',
            DESCRIPTION:'Бот учёта присутствия', WORK_POSITION:'Помощник HR'
        }
    });
    const botId = String(resp?.result || '');
    if (botId) {
        console.log('✅ Бот зарегистрирован, ID:', botId);
        await registerCommands(domain, accessToken, botId);
    } else {
        console.error('❌ Ошибка регистрации бота:', JSON.stringify(resp));
    }
    return botId;
}

app.post('/install', async (req, res) => {
    console.log('📥 POST /install body:', JSON.stringify(req.body));
    const AUTH_ID         = req.body.AUTH_ID    || req.body.auth_id    || '';
    const REFRESH_ID      = req.body.REFRESH_ID || req.body.refresh_id || '';
    const SERVER_ENDPOINT = req.body.SERVER_ENDPOINT || req.body.server_endpoint || '';
    const domain          = req.body.DOMAIN || req.body.domain || req.query.DOMAIN || req.query.domain || '';

    if (AUTH_ID && domain) {
        const botsResp = await callBitrix(domain, AUTH_ID, 'imbot.bot.list', {});
        const botsArr  = Object.values(botsResp?.result || {});
        const ourBot   = botsArr.find(b => b.CODE === 'attendance_bot');
        if (ourBot) {
            const existingBotId = String(ourBot.ID);
            console.log(`✅ Бот уже есть (ID=${existingBotId})`);
            await savePortal(domain, AUTH_ID, REFRESH_ID, existingBotId, SERVER_ENDPOINT);
            await registerCommands(domain, AUTH_ID, existingBotId);
        } else {
            console.log('🤖 Регистрируем бота...');
            await savePortal(domain, AUTH_ID, REFRESH_ID, '', SERVER_ENDPOINT);
            const botId = await registerBot(domain, AUTH_ID, null);
            if (botId) await savePortal(domain, AUTH_ID, REFRESH_ID, botId, SERVER_ENDPOINT);
        }
    }

    res.send(`<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Учёт времени</title>
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
        .then(function(r){return r.json();})
        .then(function(d){
            if(d.ok){done('✅','Отметка принята!','Готово! Можно закрыть эту страницу 😊');}
            else{done('❌','Ошибка',d.error||'Попробуйте ещё раз');}
            setTimeout(function(){window.close();},3000);
        }).catch(function(){done('❌','Ошибка сети','Проверьте подключение к интернету');});
    },
    function(err){
        var msgs={1:'Вы запретили геолокацию — разрешите в настройках браузера.',2:'Не удалось определить местоположение.',3:'Превышено время ожидания.'};
        done('❌','Геолокация недоступна',msgs[err.code]||'Ошибка: '+err.message);
    },
    {timeout:15000,enableHighAccuracy:true,maximumAge:0}
);}
</script></body></html>`);
});

app.post('/confirm-geo', async (req, res) => {
    const { token, lat, lon } = req.body;
    if (!token || lat == null || lon == null)
        return res.json({ ok:false, error:'Неверные данные' });

    const rec = await popGeoToken(token);
    if (!rec)
        return res.json({ ok:false, error:'Ссылка устарела или уже использована. Запроси новую в боте!' });

    const inOffice    = getDistance(lat, lon, OFFICE_LAT, OFFICE_LON) <= OFFICE_RADIUS;
    const userIsAdmin = await isAdmin(rec.user_id);
    const kb          = userIsAdmin ? kbAdmin() : kbMain();

    if (!inOffice) {
        await sendMessage(rec.domain, rec.access_token, rec.bot_id, rec.dialog_id,
            `❌ Отметка ${rec.type === 'in' ? 'прихода' : 'ухода'} не принята!\n\n` +
            `📍 Вы находитесь вне радиуса офиса (${OFFICE_RADIUS} м).\n` +
            `Подойдите ближе к зданию и попробуйте снова 🏢`, kb);
        return res.json({ ok:false, error:'Вы вне офиса. Отметка не принята.' });
    }

    const typeLabel = rec.type === 'in' ? 'Приход' : 'Уход';
    const time      = new Date().toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', timeZone:'Asia/Yekaterinburg' });

    await saveAttendance(rec.user_id, rec.user_name, rec.domain, rec.type, lat, lon, true);

    let text;
    if (rec.type === 'in') {
        text = `✅ *Приход зафиксирован в ${time}!*\n📍 Вы в офисе\n\nУдачного рабочего дня! 💪`;
    } else {
        text = `🚪 *Уход зафиксирован в ${time}!*\n📍 Вы в офисе`;
        const marks   = await getTodayMarks(rec.user_id);
        const inMarks = marks.filter(m => m.type === 'in');
        const inMark  = inMarks[inMarks.length - 1];
        if (inMark) {
            const diff = (Date.now() - new Date(inMark.timestamp)) / 1000;
            text += `\n⏱ Отработано сегодня: *${formatDuration(diff)}*`;
        }
        text += `\n\nОтличная работа — хорошего вечера! 🌆`;
    }

    await sendMessage(rec.domain, rec.access_token, rec.bot_id, rec.dialog_id, text, kb);
    console.log(`✅ ${rec.user_name} — ${typeLabel} в ${time}`);
    res.json({ ok:true, in_office:true });
});

app.post('/imbot', async (req, res) => {
    res.json({ result:'ok' });
    try {
        const body  = req.body;
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

        const domain    = auth.domain       || auth.DOMAIN       || BITRIX_DOMAIN;
        let authToken   = auth.access_token || auth.ACCESS_TOKEN || '';
        const firstName = FIRST_NAME || (USER_NAME ? USER_NAME.split(' ')[0] : '');
        const userName  = USER_NAME || firstName || `Пользователь ${FROM_USER_ID}`;
        const geoUrl    = `https://${APP_DOMAIN}/geo`;

        console.log(`📨 event=${event} user=${userName}(${FROM_USER_ID}) cmd="${COMMAND}" msg="${MESSAGE}"`);

        if (domain && authToken) {
            const existing = await getPortal(domain);
            await savePortal(domain, authToken, existing?.refresh_token,
                BOT_ID || existing?.bot_id, existing?.client_endpoint);
        }
        if (!authToken) {
            const portal = await getPortal(domain);
            if (portal) authToken = portal.access_token;
            else { console.error('❌ Нет токена:', domain); return; }
        }

        const portal = await getPortal(domain);
        const botId  = BOT_ID || portal?.bot_id;
        if (!botId) { console.error('❌ Нет bot_id:', domain); return; }

        let resolvedName = userName;
        if (FROM_USER_ID && (!USER_NAME || USER_NAME.startsWith('Пользователь'))) {
            const b24user = await getBitrixUser(domain, authToken, FROM_USER_ID);
            if (b24user?.name) resolvedName = b24user.name;
        }

        if (FROM_USER_ID && resolvedName) {
            await registerEmployee(FROM_USER_ID, resolvedName, domain);
        }

        const userIsAdmin = await isAdmin(FROM_USER_ID);
        const pending     = await getPending(FROM_USER_ID);
        const inAdminMode = userIsAdmin && (pending?.action === 'admin_session');
        const kb = inAdminMode ? kbAdmin() : await mainKb(FROM_USER_ID);

        if (event === 'ONIMBOTJOINCHAT') {
            const marked = await hasMarkedToday(FROM_USER_ID);
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                buildGreeting(resolvedName, firstName, inAdminMode, marked), kb);
            return;
        }

        if (event !== 'ONIMBOTMESSAGEADD' && event !== 'ONIMCOMMANDADD') return;

        if (pending && pending.action !== 'admin_session' && action !== 'cancel_input'
            && event === 'ONIMBOTMESSAGEADD') {
            await handlePendingInput(domain, authToken, botId, DIALOG_ID,
                FROM_USER_ID, resolvedName, MESSAGE, pending);
            return;
        }

        if (action.startsWith('select_user_') && pending?.action === 'schedule_select_user') {
            const idx   = parseInt(action.replace('select_user_', ''));
            const users = pending.data.foundUsers || [];
            const sel   = users[idx];
            if (!sel) {
                await sendMessage(domain, authToken, botId, DIALOG_ID, `⚠️ Сотрудник не найден.`, kbCancel());
                return;
            }
            await setPending(FROM_USER_ID, 'schedule_add', 'date_from', {
                ...pending.data,
                userId:   sel.id,
                userName: sel.name,
                adminSession: true,
            });
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `👤 Сотрудник: *${sel.name}*\n\n📅 Введи дату *начала* в формате *ДД.ММ.ГГГГ*:`,
                kbCancel());
            return;
        }
        if (action === 'sched_search_again' && pending?.data?.status) {
            await setPending(FROM_USER_ID, 'schedule_add', 'search_user', {
                status: pending.data.status, adminSession: true
            });
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `🔍 Введи имя или фамилию сотрудника для поиска:`, kbCancel());
            return;
        }

        if (action === 'cancel_input') {
            await clearPending(FROM_USER_ID);
            if (inAdminMode) await setPending(FROM_USER_ID, 'admin_session', 'active');
            await sendMessage(domain, authToken, botId, DIALOG_ID, `❌ Действие отменено.`, kb);
            return;
        }
        if (action === 'admin_enter') {
            if (!userIsAdmin) {
                await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 У вас нет прав администратора.`, kb);
                return;
            }
            await setPending(FROM_USER_ID, 'admin_session', 'active');
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                buildGreeting(resolvedName, firstName, true, false), kbAdmin());
            return;
        }
        if (action === 'admin_logout' || action === 'admin_back') {
            await clearPending(FROM_USER_ID);
            const marked = await hasMarkedToday(FROM_USER_ID);
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `✅ Вы вышли из режима администратора.\n\n` +
                buildGreeting(resolvedName, firstName, false, marked),
                await mainKb(FROM_USER_ID));
            return;
        }
        if (action === 'arrived' || action === 'пришел' || action === 'пришёл') {
            const lastMark = await getLastMark(FROM_USER_ID);
            if (lastMark && lastMark.type === 'in') {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `⚠️ Уже есть активная отметка прихода!\nСначала нажми *"🚪 Ушёл"*, чтобы закрыть прошлую смену.`, kb);
                return;
            }
            const sched = await getActiveSchedule(FROM_USER_ID);
            if (sched && ['vacation','sick','dayoff'].includes(sched.status)) {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `ℹ️ По расписанию у вас сегодня: *${SCHED_LABELS[sched.status]}*\n` +
                    `Если всё верно — ссылка для отметки ниже 👇`, null);
            }
            const token = makeToken();
            await saveGeoToken(token, FROM_USER_ID, resolvedName, DIALOG_ID, botId, domain, authToken, 'in');
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `📍 Отлично! Нажми кнопку ниже, чтобы подтвердить приход.\n\n` +
                `⏰ *Ссылка действует всего 10 минут — не затягивай!* ⚡️`,
                kbGeo(`${geoUrl}?token=${token}`, 'in'));

        } else if (action === 'left' || action === 'ушел' || action === 'ушёл') {
            const lastMark = await getLastMark(FROM_USER_ID);
            if (!lastMark || lastMark.type !== 'in') {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `⚠️ Нет активной отметки прихода!\nСначала нажми *"✅ Пришёл"*, чтобы начать рабочий день.`, kb);
                return;
            }
            const token = makeToken();
            await saveGeoToken(token, FROM_USER_ID, resolvedName, DIALOG_ID, botId, domain, authToken, 'out');
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `📍 Уже уходишь? Нажми кнопку ниже, чтобы подтвердить уход.\n\n` +
                `⏰ *Ссылка действует всего 10 минут — не закрывай бот!* ⚡️`,
                kbGeo(`${geoUrl}?token=${token}`, 'out'));
        } else if (action === 'status' || action === 'статус') {
            const marks = await getTodayMarks(FROM_USER_ID);
            if (!marks.length) {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `📊 Сегодня отметок пока нет.\n\nНажми *"✅ Пришёл"* чтобы начать рабочий день! 👇`, kb);
                return;
            }
            let totalSeconds = 0, lastInTime = null, lastType = null;
            const lines = [];
            for (const mark of marks) {
                const ts   = new Date(mark.timestamp);
                const tStr = tzTime(mark.timestamp);
                const lbl  = mark.type === 'in' ? '✅ Приход' : '🚪 Уход';
                const loc  = mark.in_office ? '📍 В офисе' : '⚠️ Вне офиса';
                if (mark.type === 'in') {
                    lastInTime = ts; lastType = 'in';
                    lines.push(`${lbl} в ${tStr} — ${loc}`);
                } else {
                    if (lastType === 'in' && lastInTime) {
                        const diff = (ts - lastInTime) / 1000;
                        totalSeconds += diff;
                        lines.push(`${lbl} в ${tStr} — ${loc} (${formatDuration(diff)})`);
                    } else {
                        lines.push(`${lbl} в ${tStr} — ${loc}`);
                    }
                    lastType = 'out'; lastInTime = null;
                }
            }
            if (lastType === 'in') lines.push('⏳ Смена ещё не закрыта');
            const totalStr = totalSeconds > 0 ? `\n\n⏱ *Итого в офисе: ${formatDuration(totalSeconds)}*` : '';
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `📊 *Твои отметки за сегодня:*\n\n${lines.join('\n')}${totalStr}`, kb);

        } else if (action === 'help' || action === 'помощь') {
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `🤖 *Бот учёта рабочего времени*\n\n` +
                `✅ *Пришёл* — отметить начало рабочего дня\n` +
                `🚪 *Ушёл* — отметить конец рабочего дня\n` +
                `📊 *Статус* — посмотреть свои отметки за сегодня\n\n` +
                `После нажатия кнопки откроется страница для подтверждения геолокации.\n` +
                `⏰ *Ссылка действует 10 минут!*`, kb);
        } else if (action === 'menu' || action === 'назад' || action === 'меню') {
            await sendMessage(domain, authToken, botId, DIALOG_ID, `👇 Выбери нужное действие:`, kb);

        } else if (action === 'report_today') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const today = todaySV();
            const { rows: present } = await pool.query(`
                SELECT user_name, user_id,
                    MIN(CASE WHEN type='in'  THEN timestamp END) as in_time,
                    MAX(CASE WHEN type='out' THEN timestamp END) as out_time
                FROM attendance
                WHERE (timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date = $1::date
                GROUP BY user_id, user_name ORDER BY user_name`, [today]);
            const { rows: allEmps } = await pool.query(`SELECT user_id, user_name FROM employees ORDER BY user_name`);
            const schedToday   = await getSchedulesToday();
            const schedUserIds = new Set(schedToday.map(r => r.user_id));
            const presentIds   = new Set(present.map(r => r.user_id));
            const absent       = allEmps.filter(e => !presentIds.has(e.user_id) && !schedUserIds.has(e.user_id));

            let text = `📋 *Отчёт за ${new Date().toLocaleDateString('ru-RU')}*\n\n`;
            if (present.length) {
                text += `✅ *Явились (${present.length} чел.):*\n`;
                present.forEach(r => {
                    const i = r.in_time  ? tzTime(r.in_time)  : '?';
                    const o = r.out_time ? tzTime(r.out_time) : '🟢 в офисе';
                    text += `• ${r.user_name || r.user_id}: ${i} → ${o}\n`;
                });
            } else { text += `Сегодня отметок нет.\n`; }
            if (schedToday.length) {
                text += `\n📅 *По расписанию:*\n`;
                schedToday.forEach(r => { text += `• ${r.user_name}: ${SCHED_LABELS[r.status] || r.status}\n`; });
            }
            if (absent.length) {
                text += `\n❌ *Не отметились (${absent.length} чел.):*\n`;
                absent.forEach(r => { text += `• ${r.user_name}\n`; });
            }
            await sendMessage(domain, authToken, botId, DIALOG_ID, text, kbAdmin());

        } else if (action === 'report_week') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const { rows } = await pool.query(`
                SELECT e.user_name, e.user_id,
                    COUNT(DISTINCT (a.timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date) as days
                FROM employees e
                LEFT JOIN attendance a ON a.user_id = e.user_id
                    AND a.type = 'in'
                    AND a.timestamp >= NOW()-INTERVAL '7 days'
                GROUP BY e.user_id, e.user_name ORDER BY days DESC, e.user_name`);
            let text = `📅 *Отчёт за 7 дней*\n\n`;
            if (rows.length) rows.forEach(r => {
                const d = Number(r.days);
                const mark = d === 0 ? '❌' : d < 3 ? '⚠️' : '✅';
                text += `${mark} ${r.user_name}: ${d} раб. дн.\n`;
            });
            else text += `Нет зарегистрированных сотрудников.`;
            await sendMessage(domain, authToken, botId, DIALOG_ID, text, kbAdmin());

        } else if (action === 'report_month') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const { rows } = await pool.query(`
                SELECT e.user_name, e.user_id,
                    COUNT(DISTINCT (a.timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date) as days
                FROM employees e
                LEFT JOIN attendance a ON a.user_id = e.user_id
                    AND a.type = 'in'
                    AND a.timestamp >= NOW()-INTERVAL '30 days'
                GROUP BY e.user_id, e.user_name ORDER BY days DESC, e.user_name`);
            let text = `📆 *Отчёт за 30 дней*\n\n`;
            if (rows.length) rows.forEach(r => {
                const d = Number(r.days);
                const mark = d === 0 ? '❌' : d < 10 ? '⚠️' : '✅';
                text += `${mark} ${r.user_name}: ${d} раб. дн.\n`;
            });
            else text += `Нет зарегистрированных сотрудников.`;
            await sendMessage(domain, authToken, botId, DIALOG_ID, text, kbAdmin());

        } else if (action === 'who_in') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const { rows } = await pool.query(`
                SELECT user_name, user_id,
                    MIN(CASE WHEN type='in' THEN timestamp END) as in_time
                FROM attendance
                WHERE (timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date=(NOW() AT TIME ZONE 'Asia/Yekaterinburg')::date
                GROUP BY user_id, user_name
                HAVING MAX(CASE WHEN type='out' THEN 1 ELSE 0 END)=0
                ORDER BY user_name`);
            let text = `👥 *Сейчас в офисе — ${rows.length} чел.:*\n\n`;
            if (rows.length) {
                rows.forEach(r => {
                    const t = r.in_time ? tzTime(r.in_time) : '?';
                    text += `• ${r.user_name || r.user_id} (с ${t})\n`;
                });
            } else { text += `Сейчас никого нет в офисе.`; }
            await sendMessage(domain, authToken, botId, DIALOG_ID, text, kbAdmin());

        } else if (action === 'send_report') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `📤 Выбери период — отчёт Excel придёт на *${REPORT_EMAIL}*:`,
                kbEmailPeriod());

        } else if (action === 'email_today' || action === 'email_week' || action === 'email_month') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `⏳ Формирую Excel-отчёт и отправляю на почту...`, kbAdmin());
            const period = action.replace('email_', '');
            const result = await sendReportByEmail(period);
            if (result.ok) {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `✅ *Отчёт успешно отправлен!*\n📧 ${REPORT_EMAIL}`, kbAdmin());
            } else {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `❌ Не удалось отправить отчёт.\n\n_${result.error}_\n\n` +
                    `💡 Проверь переменные SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASS на Render.`,
                    kbAdmin());
            }
        } else if (action === 'schedule') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `🗓 *Управление расписанием*\n\nДобавь событие для сотрудника или посмотри текущий список:`,
                kbSchedule());

        } else if (['sched_vacation','sched_sick','sched_dayoff','sched_remote','sched_business'].includes(action)) {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const statusMap = {
                sched_vacation:'vacation', sched_sick:'sick', sched_dayoff:'dayoff',
                sched_remote:'remote', sched_business:'business'
            };
            const status = statusMap[action];
            // ИСПРАВЛЕНИЕ 5: поиск сотрудника через API вместо ввода просто имени
            await setPending(FROM_USER_ID, 'schedule_add', 'search_user', { status, adminSession:true });
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `${SCHED_LABELS[status]} — *добавление записи*\n\n` +
                `🔍 Введи имя или фамилию сотрудника для поиска:`, kbCancel());

        } else if (action === 'sched_list') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const { rows } = await pool.query(
                `SELECT * FROM schedules WHERE date_to >= CURRENT_DATE ORDER BY date_from, user_name`);
            let text = `📋 *Актуальное расписание:*\n\n`;
            if (rows.length) {
                rows.forEach(r => {
                    const from = new Date(r.date_from).toLocaleDateString('ru-RU');
                    const to   = new Date(r.date_to).toLocaleDateString('ru-RU');
                    text += `• [${r.id}] ${r.user_name}: ${SCHED_LABELS[r.status] || r.status}\n  📅 ${from} — ${to}`;
                    if (r.comment) text += `\n  💬 ${r.comment}`;
                    text += `\n`;
                });
            } else { text += `Активных записей нет.`; }
            await sendMessage(domain, authToken, botId, DIALOG_ID, text, kbSchedule());

        } else if (action === 'sched_delete') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            await setPending(FROM_USER_ID, 'schedule_delete', 'id', { adminSession:true });
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `🗑 *Удаление записи расписания*\n\nВведи *ID записи* (цифру в [скобках] из списка):`,
                kbCancel());
        } else if (action === 'admin_manage') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `👤 *Управление администраторами*\n\nДобавь или удали администратора бота:`,
                kbAdminManage());

        } else if (action === 'admin_list') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const admins = await listAdmins();
            let text = `📋 *Список администраторов:*\n\n`;
            text += `👑 ID ${MANAGER_ID} — главный администратор\n`;
            if (admins.length) {
                admins.forEach(a => { text += `• ${a.user_name || 'Без имени'} (ID: ${a.user_id})\n`; });
            } else { text += `\nДополнительных администраторов нет.`; }
            await sendMessage(domain, authToken, botId, DIALOG_ID, text, kbAdminManage());

        } else if (action === 'admin_add') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            await setPending(FROM_USER_ID, 'admin_add', 'user_id', { adminSession:true });
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `➕ *Добавление администратора*\n\n` +
                `Введи *ID пользователя* Битрикс24:\n\n` +
                `_Найти ID можно в профиле сотрудника в адресной строке: /company/personal/user/*123*/_`,
                kbCancel());

        } else if (action === 'admin_remove') {
            if (!inAdminMode) { await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb); return; }
            const admins = await listAdmins();
            if (!admins.length) {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `ℹ️ Дополнительных администраторов нет.`, kbAdminManage());
                return;
            }
            const list = admins.map(a => `• ${a.user_name || 'Без имени'} — ID: ${a.user_id}`).join('\n');
            await setPending(FROM_USER_ID, 'admin_remove', 'user_id', { adminSession:true });
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `➖ *Удаление администратора*\n\nТекущие администраторы:\n${list}\n\n` +
                `Введи *ID* пользователя для удаления:`,
                kbCancel());

        // ── НЕИЗВЕСТНОЕ / ПРИВЕТСТВИЕ ─────────────────────────────────────────
        } else {
            const greetings = ['привет','hello','hi','хай','здравствуй','здравствуйте',
                               'добрый день','добрый вечер','доброе утро','добрый',
                               'ку','хэй','салют','даров','дарова'];
            if (greetings.some(g => msgCmd.includes(g) || cleanMsg.includes(g))) {
                const marked = await hasMarkedToday(FROM_USER_ID);
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    buildGreeting(resolvedName, firstName, inAdminMode, marked), kb);
            } else {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `❓ Не понимаю «${MESSAGE || COMMAND}».\nВоспользуйся кнопками ниже 👇`, kb);
            }
        }

    } catch(err) {
        console.error('❌ /imbot error:', err.message, err.stack);
    }
});
async function handlePendingInput(domain, authToken, botId, dialogId, userId, userName, message, pending) {
    const { action, step, data } = pending;
    const val = message.trim();

    async function done(text, kb) {
        await clearPending(userId);
        if (data.adminSession) await setPending(userId, 'admin_session', 'active');
        await sendMessage(domain, authToken, botId, dialogId, text, kb || kbAdmin());
    }

    // ── Добавить администратора ───────────────────────────────────────────────
    if (action === 'admin_add') {
        const newId = val.replace(/\D/g,'');
        if (!newId) {
            await sendMessage(domain, authToken, botId, dialogId,
                `⚠️ Введи числовой ID (только цифры), например: *123*`, kbCancel());
            return;
        }
        // Подтягиваем имя нового админа из Битрикс24
        const b24user = await getBitrixUser(domain, authToken, newId);
        const newName = b24user?.name || `Пользователь ${newId}`;
        await addAdmin(newId, newName);
        await done(
            `✅ *${newName} (ID ${newId}) теперь администратор!*\n\n` +
            `Ему стала доступна кнопка *"🔐 Режим администратора"*.`,
            kbAdminManage());
        return;
    }

    // ── Удалить администратора ────────────────────────────────────────────────
    if (action === 'admin_remove') {
        const remId = val.replace(/\D/g,'');
        if (!remId) {
            await sendMessage(domain, authToken, botId, dialogId,
                `⚠️ Введи числовой ID пользователя:`, kbCancel());
            return;
        }
        if (String(remId) === String(MANAGER_ID)) {
            await done(`🚫 Нельзя удалить главного администратора!`, kbAdminManage());
            return;
        }
        await removeAdmin(remId);
        await done(`✅ Пользователь ID ${remId} *удалён из администраторов*.`, kbAdminManage());
        return;
    }

    // ── ИСПРАВЛЕНИЕ 5: поиск сотрудника по имени через Битрикс24 API ─────────
    if (action === 'schedule_add' && step === 'search_user') {
        await sendMessage(domain, authToken, botId, dialogId,
            `🔍 Ищу сотрудника *"${val}"*...`, null);

        const users = await searchBitrixUsers(domain, authToken, val);

        if (!users.length) {
            await sendMessage(domain, authToken, botId, dialogId,
                `❌ Сотрудник *"${val}"* не найден в Битрикс24.\n\nПопробуй другое имя:`,
                kbCancel());
            return;
        }

        if (users.length === 1) {
            // Единственный результат — сразу переходим к дате
            await setPending(userId, 'schedule_add', 'date_from', {
                ...data,
                userId:   users[0].id,
                userName: users[0].name,
            });
            await sendMessage(domain, authToken, botId, dialogId,
                `👤 Найден сотрудник: *${users[0].name}*\n\n📅 Введи дату *начала* в формате *ДД.ММ.ГГГГ*:`,
                kbCancel());
            return;
        }

        // Несколько вариантов — показываем кнопки выбора
        await setPending(userId, 'schedule_select_user', 'pick', {
            ...data,
            foundUsers: users,
        });
        const names = users.slice(0, 5).map((u, i) => `${i+1}. ${u.name}`).join('\n');
        await sendMessage(domain, authToken, botId, dialogId,
            `🔍 Найдено несколько сотрудников — выбери нужного:\n\n${names}`,
            kbUserSelect(users));
        return;
    }

    // ── Добавить расписание: шаг — дата начала ────────────────────────────────
    if (action === 'schedule_add' && step === 'date_from') {
        const d = parseDate(val);
        if (!d) {
            await sendMessage(domain, authToken, botId, dialogId,
                `⚠️ Неверный формат. Введи дату в формате *ДД.ММ.ГГГГ*, например: *15.03.2025*`, kbCancel());
            return;
        }
        await setPending(userId, 'schedule_add', 'date_to', { ...data, dateFrom: d });
        await sendMessage(domain, authToken, botId, dialogId,
            `✅ Начало: *${val}*\n\n📅 Введи дату *окончания* в формате *ДД.ММ.ГГГГ*:`, kbCancel());
        return;
    }

    // ── Добавить расписание: шаг — дата окончания ─────────────────────────────
    if (action === 'schedule_add' && step === 'date_to') {
        const d = parseDate(val);
        if (!d) {
            await sendMessage(domain, authToken, botId, dialogId,
                `⚠️ Неверный формат. Введи дату в формате *ДД.ММ.ГГГГ*:`, kbCancel());
            return;
        }
        await setPending(userId, 'schedule_add', 'comment', { ...data, dateTo: d });
        await sendMessage(domain, authToken, botId, dialogId,
            `✅ Окончание: *${val}*\n\n💬 Введи комментарий (или напиши *-* если не нужен):`, kbCancel());
        return;
    }

    // ── Добавить расписание: сохранение + ИСПРАВЛЕНИЕ 4: уведомление ──────────
    if (action === 'schedule_add' && step === 'comment') {
        const comment = (val === '-' || val === '—') ? null : val;

        await pool.query(
            `INSERT INTO schedules (user_id,user_name,status,date_from,date_to,comment,created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [data.userId, data.userName, data.status, data.dateFrom, data.dateTo, comment, userId]
        );

        const from = new Date(data.dateFrom).toLocaleDateString('ru-RU');
        const to   = new Date(data.dateTo).toLocaleDateString('ru-RU');
        const label = SCHED_LABELS[data.status];

        await done(
            `✅ *Запись добавлена в расписание!*\n\n` +
            `👤 ${data.userName}\n` +
            `📋 ${label}\n` +
            `📅 ${from} — ${to}` +
            (comment ? `\n💬 ${comment}` : ''),
            kbSchedule());

        // ИСПРАВЛЕНИЕ 4: отправить уведомление сотруднику
        // data.userId — реальный Битрикс24 ID (из поиска API)
        if (data.userId && !data.userId.startsWith('user_')) {
            const portal = await getPortal(domain);
            const bId    = portal?.bot_id;
            if (bId) {
                const notifyText =
                    `📅 *Вам назначено расписание*\n\n` +
                    `${label}\n` +
                    `📅 ${from} — ${to}` +
                    (comment ? `\n💬 ${comment}` : '') +
                    `\n\n_Информация внесена администратором._`;
                await notifyUser(domain, authToken, bId, data.userId, notifyText);
                console.log(`📣 Уведомление отправлено сотруднику ID=${data.userId}`);
            }
        }
        return;
    }

    if (action === 'schedule_delete' && step === 'id') {
        const id = parseInt(val);
        if (!id) {
            await sendMessage(domain, authToken, botId, dialogId,
                `⚠️ Введи числовой ID записи:`, kbCancel());
            return;
        }
        const { rowCount } = await pool.query(`DELETE FROM schedules WHERE id=$1`, [id]);
        if (rowCount) {
            await done(`✅ Запись #${id} удалена из расписания.`, kbSchedule());
        } else {
            await done(`❌ Запись #${id} не найдена.`, kbSchedule());
        }
        return;
    }

    // Неизвестное состояние
    await clearPending(userId);
    if (pending.data?.adminSession) await setPending(userId, 'admin_session', 'active');
    await sendMessage(domain, authToken, botId, dialogId, `⚠️ Что-то пошло не так. Начни заново.`, kbAdmin());
}


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
    res.json({ ok:true, service:'v13-employees', portals:rows, time:new Date().toISOString(),
        env:{ app_domain:APP_DOMAIN, office:`${OFFICE_LAT},${OFFICE_LON}`,
              radius:OFFICE_RADIUS, manager:MANAGER_ID, report_email:REPORT_EMAIL,
              smtp_ready: !!(SMTP_USER && SMTP_PASS), smtp_port: SMTP_PORT } });
});

app.get('/debug', async (req, res) => {
    const domain = req.query.domain || BITRIX_DOMAIN;
    const portal = await getPortal(domain);
    const { rows: admins }    = await pool.query(`SELECT user_id, user_name, added_at FROM admins`);
    const { rows: schedules } = await pool.query(`SELECT * FROM schedules WHERE date_to >= CURRENT_DATE ORDER BY date_from`);
    res.json({ domain, portal_in_db:!!portal,
        data: portal ? { bot_id:portal.bot_id, token:portal.access_token?.slice(0,12)+'...', updated:portal.updated_at } : null,
        admins, active_schedules: schedules });
});

app.get('/register-commands', async (req, res) => {
    const domain = req.query.domain || BITRIX_DOMAIN;
    const portal = await getPortal(domain);
    if (!portal)        return res.json({ ok:false, error:'Портал не найден.' });
    if (!portal.bot_id) return res.json({ ok:false, error:'bot_id не найден.' });
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
        if (portal.refresh_token) {
            const newToken = await doRefreshToken(domain, portal.refresh_token);
            log.push({ refresh: newToken ? '✅ обновлён' : '❌ не удалось' });
            if (!newToken) return res.json({ ok:false, log, error:'Нажми "Переустановить" в Битрикс24.' });
        } else {
            return res.json({ ok:false, log, error:'Нет refresh_token.' });
        }
    }
    const fresh  = await getPortal(domain);
    const botId  = await registerBot(domain, fresh.access_token, fresh.bot_id || null);
    if (botId) {
        await savePortal(domain, fresh.access_token, fresh.refresh_token, botId, fresh.client_endpoint);
        log.push({ bot:`✅ ID=${botId}` });
    }
    res.json({ ok:!!botId, log, bot_id:botId });
});

app.get('/test-bot', async (req, res) => {
    const domain = req.query.domain || BITRIX_DOMAIN;
    const portal = await getPortal(domain);
    if (!portal) return res.json({ ok:false, error:'Портал не найден.' });
    const profile = await callBitrix(domain, portal.access_token, 'profile', {});
    const bots    = await callBitrix(domain, portal.access_token, 'imbot.bot.list', {});
    const { rows: admins }    = await pool.query(`SELECT user_id, user_name FROM admins`);
    const { rows: employees } = await pool.query(`SELECT user_id, user_name FROM employees ORDER BY user_name`);
    res.json({
        bot_id:        portal.bot_id,
        profile_check: profile?.result ? `✅ ${profile.result.NAME} ${profile.result.LAST_NAME}` : '❌',
        bots_in_b24:   bots?.result || null,
        admins_in_db:  admins,
        employees_in_db: employees,
        smtp_ready:    !!(SMTP_USER && SMTP_PASS),
        smtp_port:     SMTP_PORT,
        report_email:  REPORT_EMAIL,
    });
});
app.get('/sync-employees', async (req, res) => {
    const domain = req.query.domain || BITRIX_DOMAIN;
    const portal = await getPortal(domain);
    if (!portal) return res.json({ ok:false, error:'Портал не найден.' });
    const count = await syncAllEmployees(domain, portal.access_token);
    const { rows } = await pool.query(`SELECT user_id, user_name FROM employees ORDER BY user_name`);
    res.json({ ok:true, synced: count, employees: rows });
});
cron.schedule('*/15 * * * *', async () => {
    await pool.query(`DELETE FROM geo_tokens WHERE created_at < NOW()-INTERVAL '15 minutes'`);
    await pool.query(`DELETE FROM pending_input WHERE action != 'admin_session' AND created_at < NOW()-INTERVAL '30 minutes'`);
    console.log('🧹 Очистка токенов и pending');
});

initDB().then(() => {
    app.listen(port, '0.0.0.0', () => {
        console.log(`🚀 Сервер: https://${APP_DOMAIN}`);
        console.log(`📍 Офис: ${OFFICE_LAT}, ${OFFICE_LON} (${OFFICE_RADIUS}м)`);
        console.log(`🆔 Менеджер: ${MANAGER_ID}`);
        console.log(`📧 Email: ${REPORT_EMAIL}`);
        console.log(`📨 SMTP: ${SMTP_USER ? `✅ ${SMTP_HOST}:${SMTP_PORT}` : '❌ не настроен'}`);
        console.log('=== ✅ READY ===');
    });
}).catch(err => {
    console.error('❌ Ошибка подключения к БД:', err.message);
    process.exit(1);
});
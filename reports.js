// reports.js — модуль отчётов: Excel + Email + авто-рассылка
// Подключать в app.js: const reports = require('./reports');

'use strict';

const ExcelJS    = require('exceljs');
const nodemailer = require('nodemailer');
const dns        = require('dns').promises;
const os         = require('os');
const fs         = require('fs');
const path       = require('path');
const cron       = require('node-cron');

// ─── Цвета палитры ────────────────────────────────────────────────────────────
const C = {
    headerBg:   'FF2D8CFF',
    headerText: 'FFFFFFFF',
    titleBg:    'FFE8F0FE',
    titleText:  'FF1A1A2E',
    rowEven:    'FFF5F8FF',
    rowOdd:     'FFFFFFFF',
    greenBg:    'FFE8F8EE',
    redBg:      'FFFCE8E8',
    yellowBg:   'FFFFF8E1',
    schedBg:    'FFFFF3E0',
    schedHeader:'FFE07B29',
    border:     'FFCFD8EA',
};

// ─── Метки статусов расписания ────────────────────────────────────────────────
const SCHED_LABELS = {
    vacation: '🏖 Отпуск',
    sick:     '🤒 Больничный',
    dayoff:   '📅 Выходной',
    remote:   '🏠 Удалённо',
    business: '✈️ Командировка',
};

// ─── Утилиты времени ─────────────────────────────────────────────────────────
function tzTime(ts) {
    return new Date(ts).toLocaleTimeString('ru-RU', {
        hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Yekaterinburg',
    });
}
function tzDate(ts) {
    return new Date(ts).toLocaleDateString('ru-RU', {
        timeZone: 'Asia/Yekaterinburg',
    });
}
function todaySV() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Yekaterinburg' });
}
function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h} ч ${m} мин`;
}

// ─── Стилизация ячейки ────────────────────────────────────────────────────────
function styleCell(cell, { bold = false, color = null, bg = null, align = 'left', wrap = false, size = 11 } = {}) {
    cell.font = { name: 'Calibri', size, bold, color: color ? { argb: color } : undefined };
    if (bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
    cell.alignment = { horizontal: align, vertical: 'middle', wrapText: wrap };
    cell.border = {
        top:    { style: 'thin', color: { argb: C.border } },
        bottom: { style: 'thin', color: { argb: C.border } },
        left:   { style: 'thin', color: { argb: C.border } },
        right:  { style: 'thin', color: { argb: C.border } },
    };
}

// ─── Строка заголовка таблицы ─────────────────────────────────────────────────
function addTableHeader(sheet, cols) {
    const row = sheet.addRow(cols.map(c => c.title));
    row.height = 24;
    row.eachCell(cell => {
        styleCell(cell, { bold: true, color: C.headerText, bg: C.headerBg, align: 'center', size: 11 });
    });
    return row;
}

// ─── Данные строки с зеброй ───────────────────────────────────────────────────
function addDataRow(sheet, values, idx, rowBg = null) {
    const row = sheet.addRow(values);
    row.height = 20;
    const bg = rowBg || (idx % 2 === 0 ? C.rowEven : C.rowOdd);
    row.eachCell((cell, ci) => {
        styleCell(cell, { bg, align: ci === 1 ? 'left' : 'center' });
    });
    return row;
}

// ─── Лист "Сегодня" ───────────────────────────────────────────────────────────
async function buildTodaySheet(workbook, pool) {
    const today = todaySV();
    const dateRu = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Yekaterinburg' });

    const { rows: present } = await pool.query(`
        SELECT user_name, user_id,
            MIN(CASE WHEN type='in'  THEN timestamp END) as in_time,
            MAX(CASE WHEN type='out' THEN timestamp END) as out_time,
            SUM(CASE WHEN type='out' THEN 0 ELSE 0 END)  as dummy
        FROM attendance
        WHERE (timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date = $1::date
        GROUP BY user_id, user_name
        ORDER BY user_name
    `, [today]);

    // Считаем отработанное время для каждого
    for (const r of present) {
        if (r.in_time && r.out_time) {
            r.duration = formatDuration((new Date(r.out_time) - new Date(r.in_time)) / 1000);
        } else if (r.in_time) {
            r.duration = formatDuration((Date.now() - new Date(r.in_time)) / 1000) + ' (ещё в офисе)';
        } else {
            r.duration = '—';
        }
    }

    const { rows: allEmps }  = await pool.query(`SELECT user_id, user_name FROM employees ORDER BY user_name`);
    const schedToday          = await getSchedulesToday(pool, today);
    const schedIds            = new Set(schedToday.map(r => r.user_id));
    const presentIds          = new Set(present.map(r => r.user_id));
    const absent              = allEmps.filter(e => !presentIds.has(e.user_id) && !schedIds.has(e.user_id));

    const sheet = workbook.addWorksheet('Сегодня', { properties: { tabColor: { argb: 'FF29B36B' } } });
    sheet.views = [{ state: 'frozen', ySplit: 3 }];

    // Заголовок
    sheet.mergeCells('A1:F1');
    const title = sheet.getCell('A1');
    title.value = `📋 Отчёт посещаемости — ${dateRu}`;
    styleCell(title, { bold: true, bg: C.titleBg, color: C.titleText, align: 'center', size: 14 });
    sheet.getRow(1).height = 32;
    sheet.addRow([]);

    // Сводка
    const summary = sheet.addRow([
        `✅ Явились: ${present.length}`,
        `🟢 В офисе: ${present.filter(r => !r.out_time).length}`,
        `📅 По расписанию: ${schedToday.length}`,
        `❌ Отсутствуют: ${absent.length}`,
        `👥 Всего: ${allEmps.length}`,
        '',
    ]);
    summary.height = 22;
    summary.eachCell(cell => styleCell(cell, { bg: 'FFF0F4FF', bold: true, align: 'center' }));
    sheet.addRow([]);

    // Колонки
    const cols = [
        { title: 'Сотрудник',      key: 'name',     width: 28 },
        { title: 'Приход',         key: 'in',        width: 12 },
        { title: 'Уход',           key: 'out',       width: 12 },
        { title: 'Отработано',     key: 'duration',  width: 24 },
        { title: 'Статус',         key: 'status',    width: 22 },
        { title: 'Нарушение',      key: 'issue',     width: 20 },
    ];
    sheet.columns = cols.map(c => ({ key: c.key, width: c.width }));
    addTableHeader(sheet, cols);

    let idx = 0;
    const WORK_START_HOUR = 9; // настрой под себя

    // Явились
    for (const r of present) {
        const inHour = r.in_time ? new Date(r.in_time).toLocaleString('ru-RU', { hour: 'numeric', timeZone: 'Asia/Yekaterinburg' }) : null;
        const late   = inHour && parseInt(inHour) >= WORK_START_HOUR + 1;
        const status = r.out_time ? '✅ Ушёл'    : '🟢 В офисе';
        const issue  = late       ? '⚠️ Опоздание' : '';
        const bg     = late       ? C.yellowBg   : (idx % 2 === 0 ? C.rowEven : C.rowOdd);

        const row = sheet.addRow([
            r.user_name || r.user_id,
            r.in_time  ? tzTime(r.in_time)  : '—',
            r.out_time ? tzTime(r.out_time) : '—',
            r.duration,
            status,
            issue,
        ]);
        row.height = 20;
        row.eachCell((cell, ci) => styleCell(cell, { bg, align: ci === 1 ? 'left' : 'center' }));
        idx++;
    }

    // По расписанию
    for (const r of schedToday) {
        const row = sheet.addRow([r.user_name, '—', '—', '—', SCHED_LABELS[r.status] || r.status, '']);
        row.height = 20;
        row.eachCell((cell, ci) => styleCell(cell, { bg: C.schedBg, align: ci === 1 ? 'left' : 'center' }));
        idx++;
    }

    // Отсутствуют
    for (const r of absent) {
        const row = sheet.addRow([r.user_name, '—', '—', '—', '❌ Не отметился', '⚠️ Отсутствие']);
        row.height = 20;
        row.eachCell((cell, ci) => styleCell(cell, { bg: C.redBg, align: ci === 1 ? 'left' : 'center' }));
        idx++;
    }

    return sheet;
}

// ─── Лист "Неделя / Месяц" ────────────────────────────────────────────────────
async function buildPeriodSheet(workbook, pool, days) {
    const label     = days === 7 ? 'Неделя (7 дней)' : 'Месяц (30 дней)';
    const interval  = days === 7 ? '7 days' : '30 days';
    const workDays  = days === 7 ? 5 : 22;  // ожидаемые рабочие дни (приближённо)

    const { rows } = await pool.query(`
        SELECT e.user_name, e.user_id,
            COUNT(DISTINCT (a.timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date) as days_present,
            MIN(CASE WHEN a.type='in' THEN (a.timestamp AT TIME ZONE 'Asia/Yekaterinburg') END) as earliest_arrival,
            MAX(CASE WHEN a.type='in' THEN (a.timestamp AT TIME ZONE 'Asia/Yekaterinburg') END) as latest_arrival
        FROM employees e
        LEFT JOIN attendance a
            ON a.user_id = e.user_id
            AND a.type = 'in'
            AND a.timestamp >= NOW() - INTERVAL '${interval}'
        GROUP BY e.user_id, e.user_name
        ORDER BY days_present DESC, e.user_name
    `);

    const sheet = workbook.addWorksheet(label, {
        properties: { tabColor: { argb: days === 7 ? 'FF5B8DEF' : 'FF3A7BD5' } },
    });
    sheet.views = [{ state: 'frozen', ySplit: 3 }];

    sheet.mergeCells('A1:E1');
    const title = sheet.getCell('A1');
    title.value = `📅 ${label} — ${new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Yekaterinburg' })}`;
    styleCell(title, { bold: true, bg: C.titleBg, color: C.titleText, align: 'center', size: 14 });
    sheet.getRow(1).height = 32;
    sheet.addRow([]);

    const cols = [
        { title: 'Сотрудник',          width: 28 },
        { title: 'Дней присутствия',   width: 20 },
        { title: `Из ${workDays} раб.`,width: 18 },
        { title: '% явки',             width: 14 },
        { title: 'Оценка',             width: 18 },
    ];
    sheet.columns = cols.map(c => ({ width: c.width }));
    addTableHeader(sheet, cols);

    rows.forEach((r, i) => {
        const d    = Number(r.days_present);
        const pct  = Math.round((d / workDays) * 100);
        const grade = pct >= 90 ? '✅ Отлично' : pct >= 70 ? '⚠️ Допустимо' : '❌ Нарушения';
        const bg    = pct >= 90 ? C.greenBg   : pct >= 70 ? C.yellowBg    : C.redBg;

        const row = sheet.addRow([r.user_name || r.user_id, d, workDays, `${pct}%`, grade]);
        row.height = 20;
        row.eachCell((cell, ci) => styleCell(cell, { bg, align: ci === 1 ? 'left' : 'center' }));
    });

    return sheet;
}

// ─── Лист "Расписание" ────────────────────────────────────────────────────────
async function buildScheduleSheet(workbook, pool) {
    const today = todaySV();
    const { rows } = await pool.query(
        `SELECT * FROM schedules WHERE date_to >= $1 ORDER BY date_from, user_name`, [today]);
    if (!rows.length) return null;

    const sheet = workbook.addWorksheet('Расписание', {
        properties: { tabColor: { argb: 'FFE07B29' } },
    });

    sheet.mergeCells('A1:F1');
    const title = sheet.getCell('A1');
    title.value = '🗓 Актуальное расписание сотрудников';
    styleCell(title, { bold: true, bg: C.schedBg, color: C.titleText, align: 'center', size: 13 });
    sheet.getRow(1).height = 28;
    sheet.addRow([]);

    const cols = [
        { title: 'Сотрудник',   width: 26 },
        { title: 'Статус',      width: 20 },
        { title: 'Начало',      width: 16 },
        { title: 'Конец',       width: 16 },
        { title: 'Дней',        width: 10 },
        { title: 'Комментарий', width: 34 },
    ];
    sheet.columns = cols.map(c => ({ width: c.width }));
    addTableHeader(sheet, cols);

    rows.forEach((r, i) => {
        const from = new Date(r.date_from);
        const to   = new Date(r.date_to);
        const days = Math.round((to - from) / 86400000) + 1;
        const row  = sheet.addRow([
            r.user_name,
            SCHED_LABELS[r.status] || r.status,
            from.toLocaleDateString('ru-RU'),
            to.toLocaleDateString('ru-RU'),
            days,
            r.comment || '',
        ]);
        row.height = 20;
        row.eachCell((cell, ci) => styleCell(cell, {
            bg: i % 2 === 0 ? C.schedBg : C.rowOdd,
            align: ci === 1 ? 'left' : 'center',
        }));
    });

    return sheet;
}

// ─── Вспомогательная функция: расписание на сегодня ──────────────────────────
async function getSchedulesToday(pool, today) {
    const { rows } = await pool.query(
        `SELECT * FROM schedules WHERE date_from <= $1 AND date_to >= $1 ORDER BY user_name`, [today]);
    return rows;
}

// ═════════════════════════════════════════════════════════════════════════════
//  ГЛАВНАЯ ФУНКЦИЯ: собрать Excel-книгу
//  period: 'today' | 'week' | 'month' | 'full' (all sheets)
// ═════════════════════════════════════════════════════════════════════════════
async function buildExcelReport(pool, period = 'today') {
    const workbook = new ExcelJS.Workbook();
    workbook.creator  = 'Бот учёта рабочего времени';
    workbook.created  = new Date();
    workbook.modified = new Date();

    if (period === 'today' || period === 'full') {
        await buildTodaySheet(workbook, pool);
    }
    if (period === 'week' || period === 'full') {
        await buildPeriodSheet(workbook, pool, 7);
    }
    if (period === 'month' || period === 'full') {
        await buildPeriodSheet(workbook, pool, 30);
    }
    // Лист расписания — всегда в "full", или отдельно в today
    if (period === 'today' || period === 'full') {
        await buildScheduleSheet(workbook, pool);
    }

    // Убеждаемся что есть хотя бы один лист
    if (workbook.worksheets.length === 0) {
        workbook.addWorksheet('Нет данных').addRow(['Нет данных за период']);
    }

    const labels = { today: 'Сегодня', week: 'Неделя', month: 'Месяц', full: 'Полный' };
    const dateStr = new Date().toLocaleDateString('ru-RU').replace(/\./g, '-');
    const fname   = `Отчёт_${labels[period] || period}_${dateStr}.xlsx`;
    const tmpFile = path.join(os.tmpdir(), fname);

    await workbook.xlsx.writeFile(tmpFile);
    return { file: tmpFile, name: fname, label: labels[period] || period };
}

// ═════════════════════════════════════════════════════════════════════════════
//  ОТПРАВКА EMAIL
// ═════════════════════════════════════════════════════════════════════════════
async function sendReportByEmail(pool, period, config) {
    const { smtpHost, smtpPort, smtpUser, smtpPass, reportEmail } = config;

    if (!smtpUser || !smtpPass) {
        return { ok: false, error: 'SMTP не настроен: нет SMTP_USER или SMTP_PASS' };
    }
    if (!reportEmail) {
        return { ok: false, error: 'Не задан REPORT_EMAIL — куда отправлять?' };
    }

    try {
        const { file, name, label } = await buildExcelReport(pool, period);

        // Резолвим в IPv4 (важно для Render.com / Heroku — иначе ENETUNREACH через IPv6)
        let smtpIp = smtpHost;
        try {
            const result = await dns.lookup(smtpHost, { family: 4 });
            smtpIp = result.address;
            console.log(`📧 SMTP: ${smtpHost} → ${smtpIp}:${smtpPort}`);
        } catch (e) {
            console.warn(`⚠️ DNS lookup failed (${e.message}), используем hostname`);
        }

        const transporter = nodemailer.createTransport({
            host:              smtpIp,
            port:              smtpPort,
            secure:            smtpPort === 465,
            auth:              { user: smtpUser, pass: smtpPass },
            tls:               { rejectUnauthorized: false, servername: smtpHost },
            connectionTimeout: 20000,
            greetingTimeout:   15000,
            socketTimeout:     30000,
            family:            4,
        });

        const dateRu = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Yekaterinburg' });
        await transporter.sendMail({
            from:    `"🤖 Учёт времени" <${smtpUser}>`,
            to:      reportEmail,
            subject: `📊 Отчёт посещаемости — ${label} — ${dateRu}`,
            html: `
                <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
                    <div style="background:#2D8CFF;color:white;padding:20px;border-radius:8px 8px 0 0">
                        <h2 style="margin:0">📊 Отчёт посещаемости</h2>
                        <p style="margin:4px 0 0;opacity:.9">${label} · ${dateRu}</p>
                    </div>
                    <div style="background:#f9f9f9;padding:20px;border:1px solid #e0e0e0;border-radius:0 0 8px 8px">
                        <p>Автоматический отчёт от бота учёта рабочего времени.</p>
                        <p>Файл Excel с данными прикреплён к письму.</p>
                        <p style="color:#888;font-size:12px;margin-top:20px">
                            Отправлено: ${new Date().toLocaleString('ru-RU', { timeZone:'Asia/Yekaterinburg' })}
                        </p>
                    </div>
                </div>`,
            attachments: [{ filename: name, path: file }],
        });

        // Удаляем временный файл
        try { fs.unlinkSync(file); } catch (_) {}

        console.log(`✅ Отчёт "${label}" отправлен на ${reportEmail}`);
        return { ok: true, label, email: reportEmail };

    } catch (err) {
        console.error('❌ Email error:', err.message);
        return { ok: false, error: err.message };
    }
}

// ═════════════════════════════════════════════════════════════════════════════
//  АВТОМАТИЧЕСКИЕ ОТЧЁТЫ ПО КРОНУ
//  Вызывать один раз при старте: reports.scheduleCronReports(pool, config)
// ═════════════════════════════════════════════════════════════════════════════
function scheduleCronReports(pool, config, sendMessageFn) {
    // Ежедневный отчёт в 19:00 по Екатеринбургу (= 14:00 UTC)
    cron.schedule('0 14 * * 1-5', async () => {
        console.log('⏰ Автоотчёт: ежедневный (пн–пт 19:00 Ект)');
        const result = await sendReportByEmail(pool, 'today', config);
        if (!result.ok) {
            console.error('❌ Автоотчёт не отправлен:', result.error);
        }
    }, { timezone: 'UTC' });

    // Еженедельный отчёт — в пятницу в 18:00 (= 13:00 UTC)
    cron.schedule('0 13 * * 5', async () => {
        console.log('⏰ Автоотчёт: недельный (пятница 18:00 Ект)');
        const result = await sendReportByEmail(pool, 'week', config);
        if (!result.ok) {
            console.error('❌ Недельный отчёт не отправлен:', result.error);
        }
    }, { timezone: 'UTC' });

    // Месячный отчёт — последний рабочий день месяца в 17:30 (= 12:30 UTC)
    // Упрощённо: 28-е число (безопасно для всех месяцев)
    cron.schedule('30 12 28 * *', async () => {
        console.log('⏰ Автоотчёт: месячный (28-е числа 17:30 Ект)');
        const result = await sendReportByEmail(pool, 'full', config);
        if (!result.ok) {
            console.error('❌ Месячный отчёт не отправлен:', result.error);
        }
    }, { timezone: 'UTC' });

    console.log('📅 Авто-отчёты по расписанию активированы');
}

// ═════════════════════════════════════════════════════════════════════════════
//  ЭКСПОРТ
// ═════════════════════════════════════════════════════════════════════════════
module.exports = {
    buildExcelReport,
    sendReportByEmail,
    scheduleCronReports,
};

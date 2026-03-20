// reports.js — модуль отчётов: Excel + Email + авто-рассылка
// Подключать в app.js: const reports = require('./reports');

'use strict';

const ExcelJS    = require('exceljs');
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

// ─── Вспомогательная: форматировать секунды → "Xч Yмин" ──────────────────────
function fmtSec(sec) {
    if (!sec || sec <= 0) return '—';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}ч ${m}мин`;
}

// ─── Вспомогательная: диапазон дат ───────────────────────────────────────────
function dateRange(days) {
    const dates = [];
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        dates.push(d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Yekaterinburg' }));
    }
    return dates;
}

// ─── Лист "Неделя" ────────────────────────────────────────────────────────────
// Сетка: строки = сотрудники, столбцы = дни недели + сводная статистика
async function buildWeekSheet(workbook, pool) {
    const WORK_START_HOUR = 9;
    const days = 7;
    const interval = '7 days';

    // Все даты за период (включая выходные — отфильтруем визуально)
    const allDates = dateRange(days); // ['2026-03-15', ...]

    // Посещаемость по каждому сотруднику за каждый день
    const { rows: rawData } = await pool.query(`
        SELECT
            e.user_id, e.user_name,
            (a.timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date AS day,
            MIN(CASE WHEN a.type='in'  THEN (a.timestamp AT TIME ZONE 'Asia/Yekaterinburg') END) AS in_time,
            MAX(CASE WHEN a.type='out' THEN (a.timestamp AT TIME ZONE 'Asia/Yekaterinburg') END) AS out_time
        FROM employees e
        LEFT JOIN attendance a
            ON a.user_id = e.user_id
            AND a.timestamp >= NOW() - INTERVAL '${interval}'
        GROUP BY e.user_id, e.user_name, day
        ORDER BY e.user_name, day
    `);

    const { rows: allEmps } = await pool.query(`SELECT user_id, user_name FROM employees ORDER BY user_name`);

    // Расписание (отпуск / больничный и т.д.)
    const { rows: schedRows } = await pool.query(`
        SELECT user_id, status, date_from, date_to
        FROM schedules
        WHERE date_from <= NOW() AND date_to >= NOW() - INTERVAL '${interval}'
    `);

    // Сборка: empMap[user_id][date] = { in_time, out_time }
    const empMap = {};
    for (const e of allEmps) empMap[e.user_id] = { user_name: e.user_name, days: {} };
    for (const r of rawData) {
        if (!empMap[r.user_id]) continue;
        const dStr = r.day ? new Date(r.day).toLocaleDateString('sv-SE') : null;
        if (dStr) empMap[r.user_id].days[dStr] = { in: r.in_time, out: r.out_time };
    }

    // Расписание: schedMap[user_id][date] = status
    const schedMap = {};
    for (const s of schedRows) {
        if (!schedMap[s.user_id]) schedMap[s.user_id] = {};
        let d = new Date(s.date_from);
        while (d <= new Date(s.date_to)) {
            schedMap[s.user_id][d.toLocaleDateString('sv-SE')] = s.status;
            d.setDate(d.getDate() + 1);
        }
    }

    // ── Рабочие дни (пн–пт) ──
    const workDates = allDates.filter(d => {
        const wd = new Date(d).getDay();
        return wd >= 1 && wd <= 5;
    });
    const workDaysCount = workDates.length;

    const dayNames = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
    const monthNames = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];

    // Даты для заголовков
    const dateLabels = workDates.map(d => {
        const dt = new Date(d);
        return `${dayNames[dt.getDay()]} ${dt.getDate()} ${monthNames[dt.getMonth()]}`;
    });

    // Колонки: имя + день*N + итого статистика
    const totalCols = 1 + workDates.length + 7; // имя + дни + 7 итоговых столбцов
    const colLetters = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R'];

    const sheetLabel = `Неделя (${workDaysCount} р.дн.)`;
    const sheet = workbook.addWorksheet(sheetLabel, {
        properties: { tabColor: { argb: 'FF5B8DEF' } },
    });
    sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 5 }];

    // ── Строка 1: заголовок ──
    const lastCol = colLetters[totalCols - 1];
    sheet.mergeCells(`A1:${lastCol}1`);
    const titleCell = sheet.getCell('A1');
    const fromLabel = new Date(workDates[0]).toLocaleDateString('ru-RU');
    const toLabel   = new Date(workDates[workDates.length - 1]).toLocaleDateString('ru-RU');
    titleCell.value = `📅 Недельный отчёт посещаемости — ${fromLabel} – ${toLabel}`;
    styleCell(titleCell, { bold: true, bg: C.titleBg, color: C.titleText, align: 'center', size: 14 });
    sheet.getRow(1).height = 32;

    // ── Строка 2: пустая ──
    sheet.addRow([]);

    // ── Строки 3–4: двухуровневый заголовок ──
    // Строка 3: группировки (Сотрудник | Дни недели | Итоговая статистика)
    const r3 = sheet.getRow(3);
    r3.height = 20;
    // Мержим "Сотрудник"
    sheet.mergeCells(`A3:A4`);
    styleCell(sheet.getCell('A3'), { bold: true, color: C.headerText, bg: C.headerBg, align: 'center', size: 11 });
    sheet.getCell('A3').value = 'Сотрудник';

    // Мержим "Дни недели"
    const dayStart = 'B';
    const dayEnd   = colLetters[workDates.length]; // B..F для 5 дней
    sheet.mergeCells(`${dayStart}3:${dayEnd}3`);
    styleCell(sheet.getCell(`${dayStart}3`), { bold: true, color: C.headerText, bg: 'FF5B8DEF', align: 'center', size: 11 });
    sheet.getCell(`${dayStart}3`).value = '📆 Дни недели';

    // Мержим "Итоговая статистика"
    const statStart = colLetters[1 + workDates.length];
    sheet.mergeCells(`${statStart}3:${lastCol}3`);
    styleCell(sheet.getCell(`${statStart}3`), { bold: true, color: C.headerText, bg: 'FF3A7BD5', align: 'center', size: 11 });
    sheet.getCell(`${statStart}3`).value = '📊 Итоговая статистика';

    // Строка 4: подзаголовки дней и статистик
    const r4 = sheet.getRow(4);
    r4.height = 22;
    workDates.forEach((d, i) => {
        const cell = r4.getCell(2 + i);
        cell.value = dateLabels[i];
        styleCell(cell, { bold: true, color: C.headerText, bg: 'FF5B8DEF', align: 'center', size: 10 });
    });
    const statHeaders = ['Явок', `Из ${workDaysCount}`, '% явки', 'Опозданий', 'Ср. приход', 'Ср. часов/день', 'Оценка'];
    statHeaders.forEach((h, i) => {
        const cell = r4.getCell(2 + workDates.length + i);
        cell.value = h;
        styleCell(cell, { bold: true, color: C.headerText, bg: 'FF3A7BD5', align: 'center', size: 10 });
    });

    // ── Строка 5: сводка по команде ──
    let teamPresent = 0, teamLate = 0, teamAbsent = 0, teamArrSec = 0, teamArrCount = 0;
    // (посчитаем после строк сотрудников)

    // Ширины столбцов
    sheet.getColumn(1).width = 28;
    workDates.forEach((_, i) => { sheet.getColumn(2 + i).width = 16; });
    sheet.getColumn(2 + workDates.length + 0).width = 10;
    sheet.getColumn(2 + workDates.length + 1).width = 10;
    sheet.getColumn(2 + workDates.length + 2).width = 10;
    sheet.getColumn(2 + workDates.length + 3).width = 13;
    sheet.getColumn(2 + workDates.length + 4).width = 14;
    sheet.getColumn(2 + workDates.length + 5).width = 16;
    sheet.getColumn(2 + workDates.length + 6).width = 18;

    // ── Строки сотрудников ──
    const SCHED_DISPLAY = {
        vacation: '🏖 Отпуск', sick: '🤒 Больничный',
        dayoff: '📅 Выходной', remote: '🏠 Удалённо', business: '✈️ Командировка',
    };

    let rowIdx = 0;
    const teamStatsRows = []; // для сводки

    for (const emp of allEmps) {
        const uid = emp.user_id;
        const daysData = empMap[uid]?.days || {};
        const sched    = schedMap[uid] || {};

        let daysPresent = 0, lateCount = 0;
        let totalWorkSec = 0, arrivalSecSum = 0, arrivalCount = 0;
        let earliestArr = null, latestArr = null;

        const rowValues = [emp.user_name];

        for (const d of workDates) {
            const rec = daysData[d];
            const schedStatus = sched[d];

            if (schedStatus) {
                rowValues.push(SCHED_DISPLAY[schedStatus] || schedStatus);
            } else if (rec?.in) {
                const inDt = new Date(rec.in);
                const inHour = inDt.getHours();
                const inMin  = inDt.getMinutes();
                const timeStr = `${String(inHour).padStart(2,'0')}:${String(inMin).padStart(2,'0')}`;
                const isLate  = inHour > WORK_START_HOUR || (inHour === WORK_START_HOUR && inMin > 10);

                rowValues.push(isLate ? `⚠️ ${timeStr}` : `✅ ${timeStr}`);
                daysPresent++;
                if (isLate) lateCount++;

                const arrSec = inHour * 3600 + inMin * 60;
                arrivalSecSum += arrSec;
                arrivalCount++;
                if (!earliestArr || arrSec < earliestArr) earliestArr = arrSec;
                if (!latestArr   || arrSec > latestArr)   latestArr   = arrSec;

                if (rec.out) {
                    totalWorkSec += (new Date(rec.out) - inDt) / 1000;
                }
            } else {
                rowValues.push('—');
            }
        }

        const pct   = workDaysCount > 0 ? Math.round((daysPresent / workDaysCount) * 100) : 0;
        const avgArr = arrivalCount > 0 ? arrivalSecSum / arrivalCount : null;
        const avgArrStr = avgArr !== null
            ? `${String(Math.floor(avgArr / 3600)).padStart(2,'0')}:${String(Math.floor((avgArr % 3600) / 60)).padStart(2,'0')}`
            : '—';
        const avgWorkSec = daysPresent > 0 ? totalWorkSec / daysPresent : 0;
        const grade = pct >= 90 ? '✅ Отлично' : pct >= 70 ? '⚠️ Допустимо' : lateCount >= 3 ? '⚠️ Опоздания' : '❌ Нарушения';

        rowValues.push(daysPresent, workDaysCount, `${pct}%`, lateCount, avgArrStr, fmtSec(avgWorkSec), grade);

        const bg = pct >= 90 ? C.greenBg : pct >= 70 ? C.rowEven : lateCount >= 3 ? C.yellowBg : C.redBg;
        const dataRow = sheet.addRow(rowValues);
        dataRow.height = 20;

        dataRow.eachCell((cell, ci) => {
            const isDay = ci >= 2 && ci <= 1 + workDates.length;
            const val   = String(cell.value || '');
            let cellBg  = bg;
            if (isDay) {
                if (val.startsWith('✅')) cellBg = C.greenBg;
                else if (val.startsWith('⚠️')) cellBg = C.yellowBg;
                else if (val === '—') cellBg = C.redBg;
                else if (val.includes('Отпуск') || val.includes('Больничный') || val.includes('Удалённо') || val.includes('Командировка') || val.includes('Выходной')) cellBg = C.schedBg;
            }
            styleCell(cell, { bg: cellBg, align: ci === 1 ? 'left' : 'center', size: 10 });
        });

        teamPresent += daysPresent;
        teamLate    += lateCount;
        if (arrivalCount > 0) { teamArrSec += arrivalSecSum / arrivalCount; teamArrCount++; }
        teamStatsRows.push({ pct, grade });
        rowIdx++;
    }

    // ── Строка 5 (сводка команды) — вставляем ПОСЛЕ заголовков ──
    // Вставляем строку 5 перед данными (у нас строки 1–4 уже заполнены, данные с 5-й)
    // Добавим её в самом конце как "Итого"
    sheet.addRow([]); // разделитель
    const teamRow = sheet.addRow([
        '📊 ИТОГО ПО КОМАНДЕ',
        ...workDates.map(() => ''),
        teamPresent,
        allEmps.length * workDaysCount,
        allEmps.length > 0 ? `${Math.round(teamPresent / (allEmps.length * workDaysCount) * 100)}%` : '—',
        teamLate,
        teamArrCount > 0 ? (() => { const s = teamArrSec / teamArrCount; return `${String(Math.floor(s / 3600)).padStart(2,'0')}:${String(Math.floor((s % 3600) / 60)).padStart(2,'0')}`; })() : '—',
        '—', '—',
    ]);
    teamRow.height = 22;
    teamRow.eachCell((cell, ci) => {
        styleCell(cell, { bold: true, bg: C.titleBg, color: C.titleText, align: ci === 1 ? 'left' : 'center', size: 11 });
    });

    return sheet;
}

// ─── Лист "Месяц" ─────────────────────────────────────────────────────────────
// Полная статистика: явка, опоздания, часы, динамика по неделям
async function buildMonthSheet(workbook, pool) {
    const WORK_START_HOUR = 9;
    const days     = 30;
    const interval = '30 days';

    // Все данные за месяц
    const { rows: rawData } = await pool.query(`
        SELECT
            e.user_id, e.user_name,
            (a.timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date AS day,
            MIN(CASE WHEN a.type='in'  THEN (a.timestamp AT TIME ZONE 'Asia/Yekaterinburg') END) AS in_time,
            MAX(CASE WHEN a.type='out' THEN (a.timestamp AT TIME ZONE 'Asia/Yekaterinburg') END) AS out_time
        FROM employees e
        LEFT JOIN attendance a
            ON a.user_id = e.user_id
            AND a.timestamp >= NOW() - INTERVAL '${interval}'
        GROUP BY e.user_id, e.user_name, day
        ORDER BY e.user_name, day
    `);

    const { rows: allEmps } = await pool.query(`SELECT user_id, user_name FROM employees ORDER BY user_name`);
    const { rows: schedRows } = await pool.query(`
        SELECT user_id, status, date_from, date_to
        FROM schedules
        WHERE date_from <= NOW() AND date_to >= NOW() - INTERVAL '${interval}'
    `);

    // Сборка данных
    const empMap = {};
    for (const e of allEmps) empMap[e.user_id] = { user_name: e.user_name, days: {} };
    for (const r of rawData) {
        if (!empMap[r.user_id]) continue;
        const dStr = r.day ? new Date(r.day).toLocaleDateString('sv-SE') : null;
        if (dStr) empMap[r.user_id].days[dStr] = { in: r.in_time, out: r.out_time };
    }

    // Расписание
    const schedMap = {};
    for (const s of schedRows) {
        if (!schedMap[s.user_id]) schedMap[s.user_id] = {};
        let d = new Date(s.date_from);
        while (d <= new Date(s.date_to)) {
            schedMap[s.user_id][d.toLocaleDateString('sv-SE')] = s.status;
            d.setDate(d.getDate() + 1);
        }
    }

    // Рабочие дни (пн–пт) за период
    const allDates  = dateRange(days);
    const workDates = allDates.filter(d => { const w = new Date(d).getDay(); return w >= 1 && w <= 5; });
    const workDaysCount = workDates.length;

    // Разбивка по неделям (для детализации)
    const weeks = [];
    for (let i = 0; i < workDates.length; i += 5) {
        weeks.push(workDates.slice(i, i + 5));
    }

    // ── Создаём лист ──
    const fromLabel = new Date(workDates[0]).toLocaleDateString('ru-RU');
    const toLabel   = new Date(workDates[workDates.length - 1]).toLocaleDateString('ru-RU');
    const sheetLabel = `Месяц (${workDaysCount} р.дн.)`;

    const sheet = workbook.addWorksheet(sheetLabel, {
        properties: { tabColor: { argb: 'FF3A7BD5' } },
    });
    sheet.views = [{ state: 'frozen', ySplit: 6 }];

    // ── Заголовок ──
    const TOTAL_COLS = 11;
    sheet.mergeCells(`A1:K1`);
    const titleCell = sheet.getCell('A1');
    titleCell.value = `🗓 Месячный отчёт посещаемости — ${fromLabel} – ${toLabel}`;
    styleCell(titleCell, { bold: true, bg: C.titleBg, color: C.titleText, align: 'center', size: 14 });
    sheet.getRow(1).height = 32;
    sheet.addRow([]);

    // ── Строка 3: группы столбцов ──
    sheet.mergeCells('A3:A4');
    styleCell(sheet.getCell('A3'), { bold: true, color: C.headerText, bg: C.headerBg, align: 'center', size: 11 });
    sheet.getCell('A3').value = 'Сотрудник';

    sheet.mergeCells('B3:E3');
    styleCell(sheet.getCell('B3'), { bold: true, color: C.headerText, bg: 'FF3A7BD5', align: 'center', size: 11 });
    sheet.getCell('B3').value = '📋 Посещаемость';

    sheet.mergeCells('F3:I3');
    styleCell(sheet.getCell('F3'), { bold: true, color: C.headerText, bg: 'FF5B8DEF', align: 'center', size: 11 });
    sheet.getCell('F3').value = '⏱ Время работы';

    sheet.mergeCells('J3:K3');
    styleCell(sheet.getCell('J3'), { bold: true, color: C.headerText, bg: 'FF2D8CFF', align: 'center', size: 11 });
    sheet.getCell('J3').value = '🏆 Итог';

    // ── Строка 4: подзаголовки ──
    const subHeaders = [
        '', // A — уже смержена
        'Явок', `Из ${workDaysCount}`, '% явки', 'Пропусков',
        'Опозданий', 'Ср. приход', 'Ранний', 'Поздний',
        'Итого часов', 'Оценка',
    ];
    const subBgs = [
        '', 'FF3A7BD5','FF3A7BD5','FF3A7BD5','FF3A7BD5',
        'FF5B8DEF','FF5B8DEF','FF5B8DEF','FF5B8DEF',
        'FF2D8CFF','FF2D8CFF',
    ];
    const r4 = sheet.getRow(4);
    r4.height = 22;
    subHeaders.forEach((h, i) => {
        if (i === 0) return; // A уже смержена
        const cell = r4.getCell(i + 1);
        cell.value = h;
        styleCell(cell, { bold: true, color: C.headerText, bg: subBgs[i], align: 'center', size: 10 });
    });

    // ── Ширины ──
    sheet.getColumn(1).width = 28;
    [10, 10, 10, 12, 13, 14, 12, 12, 14, 20].forEach((w, i) => { sheet.getColumn(2 + i).width = w; });

    sheet.addRow([]); // строка 5 — пустая перед данными

    // ── Данные сотрудников ──
    const SCHED_LABELS_M = { vacation: '🏖', sick: '🤒', dayoff: '📅', remote: '🏠', business: '✈️' };

    let bestEmp = null, worstEmp = null;

    for (const emp of allEmps) {
        const uid   = emp.user_id;
        const dData = empMap[uid]?.days || {};
        const sched = schedMap[uid]  || {};

        let daysPresent = 0, lateCount = 0, absCount = 0;
        let totalWorkSec = 0, arrSecSum = 0, arrCount = 0;
        let earliestSec = null, latestSec = null;
        let schedDays = 0;

        for (const d of workDates) {
            const rec   = dData[d];
            const schSt = sched[d];

            if (schSt) {
                schedDays++;
            } else if (rec?.in) {
                const inDt   = new Date(rec.in);
                const inH    = inDt.getHours();
                const inM    = inDt.getMinutes();
                const arrSec = inH * 3600 + inM * 60;
                const isLate = inH > WORK_START_HOUR || (inH === WORK_START_HOUR && inM > 10);

                daysPresent++;
                if (isLate) lateCount++;

                arrSecSum += arrSec;
                arrCount++;
                if (earliestSec === null || arrSec < earliestSec) earliestSec = arrSec;
                if (latestSec   === null || arrSec > latestSec)   latestSec   = arrSec;

                if (rec.out) {
                    totalWorkSec += Math.max(0, (new Date(rec.out) - inDt) / 1000);
                }
            } else {
                absCount++;
            }
        }

        const effectiveDays = workDaysCount - schedDays;
        const pct = effectiveDays > 0 ? Math.round(daysPresent / effectiveDays * 100) : null;

        const avgArr = arrCount > 0 ? arrSecSum / arrCount : null;
        const fmtT   = (sec) => sec !== null
            ? `${String(Math.floor(sec/3600)).padStart(2,'0')}:${String(Math.floor((sec%3600)/60)).padStart(2,'0')}`
            : '—';

        const avgWorkSec = daysPresent > 0 ? totalWorkSec / daysPresent : 0;
        const totalHours = (totalWorkSec / 3600).toFixed(1);

        let grade;
        if (pct === null) {
            const allSched = Object.values(sched);
            grade = `${[...new Set(allSched.map(s => SCHED_LABELS_M[s] || s))].join(' ')} Весь период`;
        } else if (pct >= 90 && lateCount === 0) grade = '✅ Отлично';
        else if (pct >= 90)   grade = '✅ Хорошо';
        else if (pct >= 80)   grade = lateCount >= 5 ? '⚠️ Опоздания' : '⚠️ Допустимо';
        else if (pct >= 60)   grade = '⚠️ Нарушения';
        else                   grade = '❌ Критично';

        const bg = pct === null ? C.schedBg
            : pct >= 90 ? (lateCount === 0 ? C.greenBg : C.rowEven)
            : pct >= 70 ? C.yellowBg
            : C.redBg;

        const row = sheet.addRow([
            emp.user_name,
            pct !== null ? daysPresent : '—',
            pct !== null ? effectiveDays : '—',
            pct !== null ? `${pct}%` : '—',
            pct !== null ? absCount : '—',
            pct !== null ? lateCount : '—',
            fmtT(avgArr),
            fmtT(earliestSec),
            fmtT(latestSec),
            pct !== null ? `${totalHours} ч` : '—',
            grade,
        ]);
        row.height = 20;
        row.eachCell((cell, ci) => styleCell(cell, { bg, align: ci === 1 ? 'left' : 'center', size: 10 }));

        if (pct !== null) {
            if (!bestEmp  || pct > bestEmp.pct)  bestEmp  = { name: emp.user_name, pct };
            if (!worstEmp || pct < worstEmp.pct) worstEmp = { name: emp.user_name, pct };
        }
    }

    // ── Итоговая строка команды ──
    sheet.addRow([]);
    const sumRows = sheet._rows.filter(r => r && r.getCell(4).value && String(r.getCell(4).value).endsWith('%'));
    const teamPcts = sumRows.map(r => parseInt(r.getCell(4).value));
    const teamAvgPct = teamPcts.length ? Math.round(teamPcts.reduce((a, b) => a + b, 0) / teamPcts.length) : 0;
    const teamRow = sheet.addRow([
        '📊 ИТОГО ПО КОМАНДЕ', '', '', `${teamAvgPct}%`, '', '', '', '', '', '', `${bestEmp?.name || '—'} (лучший)`,
    ]);
    teamRow.height = 22;
    teamRow.eachCell((cell, ci) => {
        styleCell(cell, { bold: true, bg: C.titleBg, color: C.titleText, align: ci === 1 ? 'left' : 'center', size: 11 });
    });

    // ── Блок: детализация по неделям (новый раздел ниже) ──
    sheet.addRow([]);
    sheet.addRow([]);
    const weekSectionTitle = sheet.addRow(['📆 Детализация по неделям', '', '', '', '', '', '', '', '', '', '']);
    sheet.mergeCells(`A${weekSectionTitle.number}:K${weekSectionTitle.number}`);
    styleCell(sheet.getCell(`A${weekSectionTitle.number}`), { bold: true, bg: C.titleBg, color: C.titleText, align: 'center', size: 12 });
    weekSectionTitle.height = 26;

    // Заголовки недельной детализации
    const wkHeader = sheet.addRow(['Сотрудник', ...weeks.map((w, i) => {
        const f = new Date(w[0]).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
        const t = new Date(w[w.length-1]).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
        return `Нед.${i+1} ${f}–${t}`;
    })]);
    wkHeader.height = 20;
    wkHeader.eachCell(cell => styleCell(cell, { bold: true, color: C.headerText, bg: 'FF3A7BD5', align: 'center', size: 10 }));
    wkHeader.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };

    // Данные по неделям
    for (const emp of allEmps) {
        const uid   = emp.user_id;
        const dData = empMap[uid]?.days || {};
        const sched = schedMap[uid]  || {};

        const weekStats = weeks.map(wk => {
            let p = 0, l = 0;
            for (const d of wk) {
                if (sched[d]) continue;
                if (dData[d]?.in) {
                    p++;
                    const inDt = new Date(dData[d].in);
                    const inH  = inDt.getHours();
                    const inM  = inDt.getMinutes();
                    if (inH > WORK_START_HOUR || (inH === WORK_START_HOUR && inM > 10)) l++;
                }
            }
            const total = wk.filter(d => !sched[d]).length;
            const pct   = total > 0 ? Math.round(p / total * 100) : null;
            if (pct === null) return '—';
            const lStr = l > 0 ? ` / ${l}⚠️` : '';
            return `${p}/${total} (${pct}%${lStr})`;
        });

        const wkRow = sheet.addRow([emp.user_name, ...weekStats]);
        wkRow.height = 18;
        wkRow.eachCell((cell, ci) => {
            const val = String(cell.value || '');
            let bg = ci % 2 === 0 ? C.rowEven : C.rowOdd;
            if (ci > 1) {
                const m = val.match(/\((\d+)%/);
                if (m) {
                    const p = parseInt(m[1]);
                    bg = p >= 90 ? C.greenBg : p >= 70 ? C.yellowBg : C.redBg;
                }
            }
            styleCell(cell, { bg, align: ci === 1 ? 'left' : 'center', size: 10 });
        });
    }

    return sheet;
}

// ─── Лист "Неделя / Месяц" (обёртка для совместимости) ───────────────────────
async function buildPeriodSheet(workbook, pool, days) {
    if (days === 7)  return buildWeekSheet(workbook, pool);
    if (days === 30) return buildMonthSheet(workbook, pool);
    // Fallback — старый лёгкий вариант
    const label = `Период ${days} дн.`;
    const sheet = workbook.addWorksheet(label);
    sheet.addRow([`Отчёт за ${days} дней`]);
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
//  ОТПРАВКА EMAIL — через Brevo HTTP API (работает на Render.com)
//  Render блокирует SMTP-порты, поэтому используем HTTPS-запрос к API Brevo
// ═════════════════════════════════════════════════════════════════════════════
async function sendReportByEmail(pool, period, config) {
    const { smtpUser, brevoApiKey, reportEmail } = config;

    if (!brevoApiKey) {
        return { ok: false, error: 'Не задан BREVO_API_KEY' };
    }
    if (!reportEmail) {
        return { ok: false, error: 'Не задан REPORT_EMAIL — куда отправлять?' };
    }

    try {
        const { file, name, label } = await buildExcelReport(pool, period);

        // Читаем файл и кодируем в base64 для вложения
        const fileBuffer  = fs.readFileSync(file);
        const fileBase64  = fileBuffer.toString('base64');

        const dateRu = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Yekaterinburg' });
        const senderEmail = smtpUser || 'bot@brevo.com';

        // HTTP POST запрос к Brevo API — не использует SMTP-порты
        const axios = require('axios');
        const response = await axios.post(
            'https://api.brevo.com/v3/smtp/email',
            {
                sender:  { name: '🤖 Учёт времени', email: senderEmail },
                to:      [{ email: reportEmail }],
                subject: `Отчёт посещаемости — ${label} — ${dateRu}`,
                htmlContent: `
                    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
                        <div style="background:#2D8CFF;color:white;padding:20px;border-radius:8px 8px 0 0">
                            <h2 style="margin:0">Отчёт посещаемости</h2>
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
                attachment: [{ content: fileBase64, name }],
            },
            {
                headers: {
                    'api-key':      brevoApiKey,
                    'Content-Type': 'application/json',
                },
                timeout: 30000,
            }
        );

        // Удаляем временный файл
        try { fs.unlinkSync(file); } catch (_) {}

        console.log(`✅ Отчёт "${label}" отправлен на ${reportEmail} (Brevo API, статус ${response.status})`);
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
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
    dayOffBg:   'FFF0F0F0',
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

// ─── Типы рабочих графиков ────────────────────────────────────────────────────
const WORK_SCHEDULE_TYPES = {
    '5/2': { label: '5/2 (Пн–Пт)', workDays: 5, restDays: 2 },
    '4/2': { label: '4/2 (4 раб. + 2 вых.)', workDays: 4, restDays: 2 },
    '2/2': { label: '2/2 (2 раб. + 2 вых.)', workDays: 2, restDays: 2 },
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

// ─── Проверка, является ли день рабочим по графику ───────────────────────────
function isWorkDayBySchedule(scheduleType, cycleStart, date) {
    if (!scheduleType) return true; // нет графика — все дни рабочие
    if (scheduleType === '5/2') {
        const dow = new Date(date).getDay();
        return dow !== 0 && dow !== 6;
    }
    const workDays = WORK_SCHEDULE_TYPES[scheduleType].workDays;
    const startDate = new Date(cycleStart);
    startDate.setHours(0, 0, 0, 0);
    const checkDate = new Date(date);
    checkDate.setHours(0, 0, 0, 0);
    const diffDays = Math.floor((checkDate - startDate) / 86400000);
    const cycleLen = workDays + WORK_SCHEDULE_TYPES[scheduleType].restDays;
    const posInCycle = ((diffDays % cycleLen) + cycleLen) % cycleLen;
    return posInCycle < workDays;
}

// ─── Загрузить все графики сотрудников в Map ─────────────────────────────────
async function loadWorkSchedulesMap(pool) {
    const { rows } = await pool.query(`
        SELECT user_id, schedule_type, cycle_start, date_end
        FROM employee_work_schedules
        WHERE date_end IS NULL OR date_end >= CURRENT_DATE
    `);
    const map = new Map();
    for (const ws of rows) {
        map.set(String(ws.user_id), {          
            scheduleType: ws.schedule_type,
            cycleStart: ws.cycle_start,
            label: WORK_SCHEDULE_TYPES[ws.schedule_type]?.label || ws.schedule_type
        });
    }
    return map;
}

// ─── Лист "Сегодня" ───────────────────────────────────────────────────────────
async function buildTodaySheet(workbook, pool) {
    const today = todaySV();
    const dateRu = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Yekaterinburg' });

    const { rows: present } = await pool.query(`
        SELECT user_name, user_id,
            MIN(CASE WHEN type='in'  THEN timestamp END) as in_time,
            MAX(CASE WHEN type='out' THEN timestamp END) as out_time
        FROM attendance
        WHERE (timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date = $1::date
        GROUP BY user_id, user_name
        ORDER BY user_name
    `, [today]);

    for (const r of present) {
        if (r.in_time && r.out_time) {
            r.duration = formatDuration((new Date(r.out_time) - new Date(r.in_time)) / 1000);
        } else if (r.in_time) {
            r.duration = formatDuration((Date.now() - new Date(r.in_time)) / 1000) + ' (ещё в офисе)';
        } else {
            r.duration = '—';
        }
    }

    const { rows: allEmps } = await pool.query(`SELECT user_id, user_name FROM employees ORDER BY user_name`);
    const schedToday = await getSchedulesToday(pool, today);
    const schedIds = new Set(schedToday.map(r => r.user_id));
    const presentIds = new Set(present.map(r => r.user_id));
    
    // Загружаем графики
    const workSchedulesMap = await loadWorkSchedulesMap(pool);
    const isWorkDayMap = new Map();
    const isVacationOrSickIds = new Set();
    
    for (const emp of allEmps) {
        const ws = workSchedulesMap.get(String(emp.user_id));
        const isWorkDay = isWorkDayBySchedule(ws?.scheduleType, ws?.cycleStart, today);
        isWorkDayMap.set(emp.user_id, isWorkDay);
        
        // Проверяем, не в отпуске/больничном ли сотрудник
        if (schedIds.has(emp.user_id)) {
            const schedInfo = schedToday.find(s => s.user_id === emp.user_id);
            if (schedInfo && ['vacation', 'sick', 'dayoff'].includes(schedInfo.status)) {
                isVacationOrSickIds.add(emp.user_id);
            }
        }
    }
    
    const absent = allEmps.filter(e => !presentIds.has(e.user_id) && !schedIds.has(e.user_id));

    const sheet = workbook.addWorksheet('Сегодня', { properties: { tabColor: { argb: 'FF29B36B' } } });
    sheet.views = [{ state: 'frozen', ySplit: 3 }];

    sheet.mergeCells('A1:H1');
    const title = sheet.getCell('A1');
    title.value = `📋 Отчёт посещаемости — ${dateRu}`;
    styleCell(title, { bold: true, bg: C.titleBg, color: C.titleText, align: 'center', size: 14 });
    sheet.getRow(1).height = 32;
    sheet.addRow([]);

    const summary = sheet.addRow([
        `✅ Явились: ${present.length}`,
        `🟢 В офисе: ${present.filter(r => !r.out_time).length}`,
        `📅 По расписанию: ${schedToday.length}`,
        `❌ Отсутствуют: ${absent.filter(e => isWorkDayMap.get(e.user_id)).length}`,
        `🚫 Выходной: ${absent.filter(e => !isWorkDayMap.get(e.user_id) && !isVacationOrSickIds.has(e.user_id)).length}`,
        `👥 Всего: ${allEmps.length}`,
        '', ''
    ]);
    summary.height = 22;
    summary.eachCell(cell => styleCell(cell, { bg: 'FFF0F4FF', bold: true, align: 'center' }));
    sheet.addRow([]);

    const cols = [
        { title: 'Сотрудник', key: 'name', width: 28 },
        { title: 'График', key: 'sched', width: 14 },
        { title: 'Приход', key: 'in', width: 12 },
        { title: 'Уход', key: 'out', width: 12 },
        { title: 'Отработано', key: 'duration', width: 24 },
        { title: 'Статус', key: 'status', width: 22 },
        { title: 'Нарушение', key: 'issue', width: 20 },
    ];
    sheet.columns = cols.map(c => ({ key: c.key, width: c.width }));
    addTableHeader(sheet, cols);

    let idx = 0;
    const WORK_START_HOUR = 9;

    for (const r of present) {
        const inHour = r.in_time ? new Date(r.in_time).toLocaleString('ru-RU', { hour: 'numeric', timeZone: 'Asia/Yekaterinburg' }) : null;
        const late = inHour && parseInt(inHour) >= WORK_START_HOUR + 1;
        const status = r.out_time ? '✅ Ушёл' : '🟢 В офисе';
        const issue = late ? '⚠️ Опоздание' : '';
        const ws = workSchedulesMap.get(r.user_id);
        const schedLabel = ws?.scheduleType || '—';
        const bg = late ? C.yellowBg : (idx % 2 === 0 ? C.rowEven : C.rowOdd);
        const row = sheet.addRow([
            r.user_name,
            schedLabel,
            r.in_time ? tzTime(r.in_time) : '—',
            r.out_time ? tzTime(r.out_time) : '—',
            r.duration,
            status,
            issue
        ]);
        row.height = 20;
        row.eachCell((cell, ci) => styleCell(cell, { bg, align: ci === 1 ? 'left' : 'center' }));
        idx++;
    }

    for (const r of schedToday) {
        const ws = workSchedulesMap.get(r.user_id);
        const schedLabel = ws?.scheduleType || '—';
        const row = sheet.addRow([
            r.user_name,
            schedLabel,
            '—', '—', '—',
            SCHED_LABELS[r.status] || r.status,
            ''
        ]);
        row.height = 20;
        row.eachCell((cell, ci) => styleCell(cell, { bg: C.schedBg, align: ci === 1 ? 'left' : 'center' }));
        idx++;
    }

    for (const r of absent) {
        const isWorkDay = isWorkDayMap.get(r.user_id);
        const isOnSchedule = isVacationOrSickIds.has(r.user_id);
        const ws = workSchedulesMap.get(r.user_id);
        const schedLabel = ws?.scheduleType || '—';
        
        let status, issue, bg;
        if (isWorkDay) {
            status = '❌ Не отметился';
            issue = '⚠️ Отсутствие';
            bg = C.redBg;
        } else if (isOnSchedule) {
            status = '📅 По расписанию';
            issue = '';
            bg = C.schedBg;
        } else {
            status = '🚫 Выходной';
            issue = '';
            bg = C.dayOffBg;
        }
        
        const row = sheet.addRow([
            r.user_name,
            schedLabel,
            '—', '—', '—',
            status,
            issue
        ]);
        row.height = 20;
        row.eachCell((cell, ci) => styleCell(cell, { bg, align: ci === 1 ? 'left' : 'center' }));
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

// ─── Лист "Неделя" с учётом графиков ─────────────────────────────────────────
async function buildWeekSheet(workbook, pool) {
    const WORK_START_HOUR = 9;
    const WORK_START_MINUTE = 10;
    const days = 7;
    const interval = '7 days';

    const allDates = dateRange(days);
    const workSchedulesMap = await loadWorkSchedulesMap(pool);

    const { rows: rawData } = await pool.query(`
        SELECT
            e.user_id, e.user_name,
            (a.timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date AS day,
            MIN(CASE WHEN a.type='in' THEN (a.timestamp AT TIME ZONE 'Asia/Yekaterinburg') END) AS in_time,
            MAX(CASE WHEN a.type='out' THEN (a.timestamp AT TIME ZONE 'Asia/Yekaterinburg') END) AS out_time
        FROM employees e
        LEFT JOIN attendance a ON a.user_id = e.user_id
            AND a.timestamp >= NOW() - INTERVAL '7 days'
        GROUP BY e.user_id, e.user_name, day
        ORDER BY e.user_name, day
    `);

    const { rows: allEmps } = await pool.query(`SELECT user_id, user_name FROM employees ORDER BY user_name`);

    const { rows: schedRows } = await pool.query(`
        SELECT user_id, status, date_from, date_to
        FROM schedules
        WHERE date_from <= NOW() AND date_to >= NOW() - INTERVAL '${interval}'
    `);

    // Построение карт данных
    const empMap = {};
    for (const e of allEmps) empMap[e.user_id] = { user_name: e.user_name, days: {} };
    for (const r of rawData) {
        if (!empMap[r.user_id]) continue;
        const dStr = r.day ? new Date(r.day).toLocaleDateString('sv-SE') : null;
        if (dStr) empMap[r.user_id].days[dStr] = { in: r.in_time, out: r.out_time };
    }

    const schedMap = {};
    for (const s of schedRows) {
        if (!schedMap[s.user_id]) schedMap[s.user_id] = {};
        let d = new Date(s.date_from);
        const endDate = new Date(s.date_to);
        while (d <= endDate) {
            schedMap[s.user_id][d.toLocaleDateString('sv-SE')] = s.status;
            d.setDate(d.getDate() + 1);
        }
    }

    const dayNames = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    const monthNames = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
    const dateLabels = allDates.map(d => {
        const dt = new Date(d);
        return `${dayNames[dt.getDay()]} ${dt.getDate()} ${monthNames[dt.getMonth()]}`;
    });

    const totalCols = 1 + allDates.length + 8; // +8 для статистики с графиком
    const colLetters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R'];
    const sheetLabel = `Неделя (7 дн.)`;
    const sheet = workbook.addWorksheet(sheetLabel, { properties: { tabColor: { argb: 'FF5B8DEF' } } });
    sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 5 }];

    const lastCol = colLetters[totalCols - 1];
    sheet.mergeCells(`A1:${lastCol}1`);
    const titleCell = sheet.getCell('A1');
    const fromLabel = new Date(allDates[0]).toLocaleDateString('ru-RU');
    const toLabel = new Date(allDates[allDates.length - 1]).toLocaleDateString('ru-RU');
    titleCell.value = `📅 Недельный отчёт посещаемости — ${fromLabel} – ${toLabel}`;
    styleCell(titleCell, { bold: true, bg: C.titleBg, color: C.titleText, align: 'center', size: 14 });
    sheet.getRow(1).height = 32;
    sheet.addRow([]);

    // Строка 3 - группировка колонок
    const r3 = sheet.getRow(3);
    r3.height = 20;
    sheet.mergeCells(`A3:A4`);
    styleCell(sheet.getCell('A3'), { bold: true, color: C.headerText, bg: C.headerBg, align: 'center', size: 11 });
    sheet.getCell('A3').value = 'Сотрудник';

    const dayStart = 'B';
    const dayEnd = colLetters[allDates.length];
    sheet.mergeCells(`${dayStart}3:${dayEnd}3`);
    styleCell(sheet.getCell(`${dayStart}3`), { bold: true, color: C.headerText, bg: 'FF5B8DEF', align: 'center', size: 11 });
    sheet.getCell(`${dayStart}3`).value = '📆 Дни недели';

    const statStart = colLetters[1 + allDates.length];
    sheet.mergeCells(`${statStart}3:${lastCol}3`);
    styleCell(sheet.getCell(`${statStart}3`), { bold: true, color: C.headerText, bg: 'FF3A7BD5', align: 'center', size: 11 });
    sheet.getCell(`${statStart}3`).value = '📊 Итоговая статистика';

    // Строка 4 - подзаголовки
    const r4 = sheet.getRow(4);
    r4.height = 22;
    allDates.forEach((d, i) => {
        const cell = r4.getCell(2 + i);
        cell.value = dateLabels[i];
        styleCell(cell, { bold: true, color: C.headerText, bg: 'FF5B8DEF', align: 'center', size: 10 });
    });
    const statHeaders = ['Явок', 'Из дн.', '% явки', 'Опозданий', 'Ср. приход', 'Ср. часов/день', 'График', 'Оценка'];
    statHeaders.forEach((h, i) => {
        const cell = r4.getCell(2 + allDates.length + i);
        cell.value = h;
        styleCell(cell, { bold: true, color: C.headerText, bg: 'FF3A7BD5', align: 'center', size: 10 });
    });

    // Установка ширины колонок
    sheet.getColumn(1).width = 28;
    allDates.forEach((_, i) => { sheet.getColumn(2 + i).width = 16; });
    [10, 10, 10, 13, 14, 16, 10, 18].forEach((w, i) => {
        sheet.getColumn(2 + allDates.length + i).width = w;
    });

    const SCHED_DISPLAY = {
        vacation: '🏖 Отпуск', sick: '🤒 Больничный',
        dayoff: '📅 Выходной', remote: '🏠 Удалённо', business: '✈️ Командировка',
    };

    let teamTotalWorkDays = 0, teamPresent = 0, teamLate = 0, teamArrSec = 0, teamArrCount = 0;
    let rowIdx = 0;

    for (const emp of allEmps) {
        const uid = emp.user_id;
        const daysData = empMap[uid]?.days || {};
        const sched = schedMap[uid] || {};
        const ws = workSchedulesMap.get(String(uid));  

        let daysPresent = 0, lateCount = 0;
        let totalWorkSec = 0, arrivalSecSum = 0, arrivalCount = 0;
        let earliestArr = null, latestArr = null;
        let workDaysCount = 0;
        const rowValues = [emp.user_name];

        for (const d of allDates) {
            const isWorkDay = isWorkDayBySchedule(ws?.scheduleType, ws?.cycleStart, d);
            const schedStatus = sched[d];

            // Обработка особых статусов (отпуск, больничный и т.д.)
            if (schedStatus) {
                rowValues.push(SCHED_DISPLAY[schedStatus] || schedStatus);
                if (isWorkDay) workDaysCount++;
                continue;
            }

            // Если день нерабочий по графику
            if (!isWorkDay) {
                rowValues.push('🚫 Вых.');
                continue;
            }

            // Рабочий день, проверяем отметки
            workDaysCount++;
            const rec = daysData[d];
            if (rec?.in) {
                const inDt = new Date(rec.in);
                const inHour = inDt.getHours();
                const inMin = inDt.getMinutes();
                const timeStr = `${String(inHour).padStart(2, '0')}:${String(inMin).padStart(2, '0')}`;
                const isLate = inHour > WORK_START_HOUR || (inHour === WORK_START_HOUR && inMin > WORK_START_MINUTE);

                rowValues.push(isLate ? `⚠️ ${timeStr}` : `✅ ${timeStr}`);
                daysPresent++;
                if (isLate) lateCount++;

                const arrSec = inHour * 3600 + inMin * 60;
                arrivalSecSum += arrSec;
                arrivalCount++;
                if (!earliestArr || arrSec < earliestArr) earliestArr = arrSec;
                if (!latestArr || arrSec > latestArr) latestArr = arrSec;

                if (rec.out) {
                    totalWorkSec += (new Date(rec.out) - inDt) / 1000;
                }
            } else {
                rowValues.push('❌');
            }
        }

        // Расчет статистики
        const pct = workDaysCount > 0 ? Math.round((daysPresent / workDaysCount) * 100) : 0;
        const avgArr = arrivalCount > 0 ? arrivalSecSum / arrivalCount : null;
        const avgArrStr = avgArr !== null
            ? `${String(Math.floor(avgArr / 3600)).padStart(2, '0')}:${String(Math.floor((avgArr % 3600) / 60)).padStart(2, '0')}`
            : '—';
        const avgWorkSec = daysPresent > 0 ? totalWorkSec / daysPresent : 0;
        const wsLabel = ws?.label || ws?.scheduleType || '—';
        
        let grade;
        if (workDaysCount === 0) {
            grade = '⚪ Нет раб. дней';
        } else if (pct >= 90 && lateCount === 0) {
            grade = '✅ Отлично';
        } else if (pct >= 90) {
            grade = '✅ Хорошо';
        } else if (pct >= 70) {
            grade = '⚠️ Допустимо';
        } else if (lateCount >= 3) {
            grade = '⚠️ Опоздания';
        } else {
            grade = '❌ Нарушения';
        }

        rowValues.push(daysPresent, workDaysCount, `${pct}%`, lateCount, avgArrStr, fmtSec(avgWorkSec), wsLabel, grade);

        // Выбор цвета строки
        let bg;
        if (workDaysCount === 0) {
            bg = C.dayOffBg;
        } else if (pct >= 90 && lateCount === 0) {
            bg = C.greenBg;
        } else if (pct >= 90) {
            bg = C.rowEven;
        } else if (pct >= 70) {
            bg = C.yellowBg;
        } else {
            bg = C.redBg;
        }

        const dataRow = sheet.addRow(rowValues);
        dataRow.height = 20;

        dataRow.eachCell((cell, ci) => {
            const isDay = ci >= 2 && ci <= 1 + allDates.length;
            const val = String(cell.value || '');
            let cellBg = bg;
            if (isDay) {
                if (val.startsWith('✅')) cellBg = C.greenBg;
                else if (val.startsWith('⚠️')) cellBg = C.yellowBg;
                else if (val === '❌') cellBg = C.redBg;
                else if (val === '🚫 Вых.') cellBg = C.dayOffBg;
                else if (val.includes('Отпуск') || val.includes('Больничный') || 
                         val.includes('Удалённо') || val.includes('Командировка') || 
                         val.includes('Выходной')) cellBg = C.schedBg;
            }
            styleCell(cell, { bg: cellBg, align: ci === 1 ? 'left' : 'center', size: 10 });
        });

        rowIdx++;
        teamPresent += daysPresent;
        teamLate += lateCount;
        teamTotalWorkDays += workDaysCount;
        if (arrivalCount > 0) { 
            teamArrSec += arrivalSecSum; 
            teamArrCount += arrivalCount; 
        }
    }

    // Итоговая строка по команде
    sheet.addRow([]);
    const teamAvgArrStr = teamArrCount > 0 
        ? (() => { 
            const s = teamArrSec / teamArrCount; 
            return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`; 
          })() 
        : '—';
    
    const teamRow = sheet.addRow([
        '📊 ИТОГО ПО КОМАНДЕ',
        ...allDates.map(() => ''),
        teamPresent,
        teamTotalWorkDays,
        teamTotalWorkDays > 0 ? `${Math.round(teamPresent / teamTotalWorkDays * 100)}%` : '—',
        teamLate,
        teamAvgArrStr,
        '—',
        '—',
        '—'
    ]);
    teamRow.height = 22;
    teamRow.eachCell((cell, ci) => {
        styleCell(cell, { bold: true, bg: C.titleBg, color: C.titleText, align: ci === 1 ? 'left' : 'center', size: 11 });
    });

    return sheet;
}

// ─── Лист "Месяц" с учётом графиков ──────────────────────────────────────────
async function buildMonthSheet(workbook, pool) {
    const WORK_START_HOUR = 9;
    const WORK_START_MINUTE = 10;
    const days = 30;
    const interval = '30 days';

    const allDates = dateRange(days);
    const workSchedulesMap = await loadWorkSchedulesMap(pool);

    const { rows: rawData } = await pool.query(`
        SELECT
            e.user_id, e.user_name,
            (a.timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date AS day,
            MIN(CASE WHEN a.type='in' THEN (a.timestamp AT TIME ZONE 'Asia/Yekaterinburg') END) AS in_time,
            MAX(CASE WHEN a.type='out' THEN (a.timestamp AT TIME ZONE 'Asia/Yekaterinburg') END) AS out_time
        FROM employees e
        LEFT JOIN attendance a ON a.user_id = e.user_id
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

    // Построение карт данных
    const empMap = {};
    for (const e of allEmps) empMap[e.user_id] = { user_name: e.user_name, days: {} };
    for (const r of rawData) {
        if (!empMap[r.user_id]) continue;
        const dStr = r.day ? new Date(r.day).toLocaleDateString('sv-SE') : null;
        if (dStr) empMap[r.user_id].days[dStr] = { in: r.in_time, out: r.out_time };
    }

    const schedMap = {};
    for (const s of schedRows) {
        if (!schedMap[s.user_id]) schedMap[s.user_id] = {};
        let d = new Date(s.date_from);
        const endDate = new Date(s.date_to);
        while (d <= endDate) {
            schedMap[s.user_id][d.toLocaleDateString('sv-SE')] = s.status;
            d.setDate(d.getDate() + 1);
        }
    }

    const sheet = workbook.addWorksheet(`Месяц (${days} дн.)`, { properties: { tabColor: { argb: 'FF3A7BD5' } } });
    sheet.views = [{ state: 'frozen', ySplit: 6 }];

    const TOTAL_COLS = 12; // Увеличено на 1 для колонки "График"
    sheet.mergeCells(`A1:L1`);
    const titleCell = sheet.getCell('A1');
    const fromLabel = new Date(allDates[0]).toLocaleDateString('ru-RU');
    const toLabel = new Date(allDates[allDates.length - 1]).toLocaleDateString('ru-RU');
    titleCell.value = `🗓 Месячный отчёт посещаемости — ${fromLabel} – ${toLabel}`;
    styleCell(titleCell, { bold: true, bg: C.titleBg, color: C.titleText, align: 'center', size: 14 });
    sheet.getRow(1).height = 32;
    sheet.addRow([]);

    // Заголовки группировки
    sheet.mergeCells('A3:A4');
    styleCell(sheet.getCell('A3'), { bold: true, color: C.headerText, bg: C.headerBg, align: 'center', size: 11 });
    sheet.getCell('A3').value = 'Сотрудник';

    sheet.mergeCells('B3:E3');
    styleCell(sheet.getCell('B3'), { bold: true, color: C.headerText, bg: 'FF3A7BD5', align: 'center', size: 11 });
    sheet.getCell('B3').value = '📋 Посещаемость';

    sheet.mergeCells('F3:I3');
    styleCell(sheet.getCell('F3'), { bold: true, color: C.headerText, bg: 'FF5B8DEF', align: 'center', size: 11 });
    sheet.getCell('F3').value = '⏱ Время работы';

    sheet.mergeCells('J3:L3');
    styleCell(sheet.getCell('J3'), { bold: true, color: C.headerText, bg: 'FF2D8CFF', align: 'center', size: 11 });
    sheet.getCell('J3').value = '🏆 Итог';

    const subHeaders = ['', 'Явок', 'Из дн.', '% явки', 'Пропусков', 'Опозданий', 'Ср. приход', 'Ранний', 'Поздний', 'Итого часов', 'График', 'Оценка'];
    const subBgs = ['', 'FF3A7BD5', 'FF3A7BD5', 'FF3A7BD5', 'FF3A7BD5', 'FF5B8DEF', 'FF5B8DEF', 'FF5B8DEF', 'FF5B8DEF', 'FF2D8CFF', 'FF2D8CFF', 'FF2D8CFF'];
    const r4 = sheet.getRow(4);
    r4.height = 22;
    subHeaders.forEach((h, i) => {
        if (i === 0) return;
        const cell = r4.getCell(i + 1);
        cell.value = h;
        styleCell(cell, { bold: true, color: C.headerText, bg: subBgs[i], align: 'center', size: 10 });
    });

    sheet.getColumn(1).width = 28;
    [10, 10, 10, 12, 13, 14, 12, 12, 14, 10, 20].forEach((w, i) => { sheet.getColumn(2 + i).width = w; });
    sheet.addRow([]);

    let bestEmp = null, worstEmp = null, teamTotalWorkDays = 0, teamAttendedDays = 0, teamLateDays = 0;

    for (const emp of allEmps) {
        const uid = emp.user_id;
        const dData = empMap[uid]?.days || {};
        const sched = schedMap[uid] || {};
        const ws = workSchedulesMap.get(uid);

        let daysPresent = 0, lateCount = 0, totalWorkSec = 0, arrSecSum = 0, arrCount = 0;
        let earliestSec = null, latestSec = null, workDaysCount = 0;

        for (const d of allDates) {
            const isWorkDay = isWorkDayBySchedule(ws?.scheduleType, ws?.cycleStart, d);
            const schSt = sched[d];

            if (schSt) {
                if (isWorkDay) workDaysCount++;
                continue;
            }

            if (!isWorkDay) continue;

            workDaysCount++;
            const rec = dData[d];
            if (rec?.in) {
                const inDt = new Date(rec.in);
                const inH = inDt.getHours();
                const inM = inDt.getMinutes();
                const arrSec = inH * 3600 + inM * 60;
                const isLate = inH > WORK_START_HOUR || (inH === WORK_START_HOUR && inM > WORK_START_MINUTE);

                daysPresent++;
                if (isLate) lateCount++;

                arrSecSum += arrSec;
                arrCount++;
                if (earliestSec === null || arrSec < earliestSec) earliestSec = arrSec;
                if (latestSec === null || arrSec > latestSec) latestSec = arrSec;

                if (rec.out) {
                    totalWorkSec += Math.max(0, (new Date(rec.out) - inDt) / 1000);
                }
            }
        }

        teamTotalWorkDays += workDaysCount;
        teamAttendedDays += daysPresent;
        teamLateDays += lateCount;

        const pct = workDaysCount > 0 ? Math.round(daysPresent / workDaysCount * 100) : null;
        const avgArr = arrCount > 0 ? arrSecSum / arrCount : null;
        const fmtT = (sec) => sec !== null ? `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}` : '—';
        const totalHours = (totalWorkSec / 3600).toFixed(1);
        const wsLabel = ws?.label || ws?.scheduleType || '—';

        let grade;
        if (pct === null) {
            grade = 'Весь период в расписании';
        } else if (pct >= 90 && lateCount === 0) {
            grade = '✅ Отлично';
        } else if (pct >= 90) {
            grade = '✅ Хорошо';
        } else if (pct >= 80) {
            grade = lateCount >= 5 ? '⚠️ Опоздания' : '⚠️ Допустимо';
        } else if (pct >= 60) {
            grade = '⚠️ Нарушения';
        } else {
            grade = '❌ Критично';
        }

        const bg = pct === null ? C.schedBg : 
                   pct >= 90 ? (lateCount === 0 ? C.greenBg : C.rowEven) : 
                   pct >= 70 ? C.yellowBg : C.redBg;

        const row = sheet.addRow([
            emp.user_name,
            pct !== null ? daysPresent : '—',
            pct !== null ? workDaysCount : '—',
            pct !== null ? `${pct}%` : '—',
            pct !== null ? (workDaysCount - daysPresent) : '—',
            pct !== null ? lateCount : '—',
            fmtT(avgArr),
            fmtT(earliestSec),
            fmtT(latestSec),
            pct !== null ? `${totalHours} ч` : '—',
            wsLabel,
            grade,
        ]);
        row.height = 20;
        row.eachCell((cell, ci) => styleCell(cell, { bg, align: ci === 1 ? 'left' : 'center', size: 10 }));

        if (pct !== null) {
            if (!bestEmp || pct > bestEmp.pct) bestEmp = { name: emp.user_name, pct };
            if (!worstEmp || pct < worstEmp.pct) worstEmp = { name: emp.user_name, pct };
        }
    }

    sheet.addRow([]);
    const teamRate = teamTotalWorkDays > 0 ? Math.round(teamAttendedDays / teamTotalWorkDays * 100) : 0;
    const teamRow = sheet.addRow([
        '📊 ИТОГО ПО КОМАНДЕ', 
        '', '', 
        `${teamRate}%`, 
        '', 
        teamLateDays, 
        '', '', '', '', '', 
        `${bestEmp?.name || '—'} (лучший)`,
    ]);
    teamRow.height = 22;
    teamRow.eachCell((cell, ci) => {
        styleCell(cell, { bold: true, bg: C.titleBg, color: C.titleText, align: ci === 1 ? 'left' : 'center', size: 11 });
    });

    return sheet;
}

// ─── Лист "Неделя / Месяц" (обёртка для совместимости) ───────────────────────
async function buildPeriodSheet(workbook, pool, days) {
    if (days === 7) return buildWeekSheet(workbook, pool);
    if (days === 30) return buildMonthSheet(workbook, pool);
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
        { title: 'Сотрудник', width: 26 },
        { title: 'Статус', width: 20 },
        { title: 'Начало', width: 16 },
        { title: 'Конец', width: 16 },
        { title: 'Дней', width: 10 },
        { title: 'Комментарий', width: 34 },
    ];
    sheet.columns = cols.map(c => ({ width: c.width }));
    addTableHeader(sheet, cols);

    rows.forEach((r, i) => {
        const from = new Date(r.date_from);
        const to = new Date(r.date_to);
        const days = Math.round((to - from) / 86400000) + 1;
        const row = sheet.addRow([
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
// ═════════════════════════════════════════════════════════════════════════════
async function buildExcelReport(pool, period = 'today') {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Бот учёта рабочего времени';
    workbook.created = new Date();
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
    if (period === 'today' || period === 'full') {
        await buildScheduleSheet(workbook, pool);
    }

    if (workbook.worksheets.length === 0) {
        workbook.addWorksheet('Нет данных').addRow(['Нет данных за период']);
    }

    const labels = { today: 'Сегодня', week: 'Неделя', month: 'Месяц', full: 'Полный' };
    const dateStr = new Date().toLocaleDateString('ru-RU').replace(/\./g, '-');
    const fname = `Отчёт_${labels[period] || period}_${dateStr}.xlsx`;
    const tmpFile = path.join(os.tmpdir(), fname);

    await workbook.xlsx.writeFile(tmpFile);
    return { file: tmpFile, name: fname, label: labels[period] || period };
}

// ═════════════════════════════════════════════════════════════════════════════
//  ОТПРАВКА EMAIL — через Brevo HTTP API
// ═════════════════════════════════════════════════════════════════════════════
async function sendReportByEmail(pool, period, config) {
    const { smtpUser, brevoApiKey, reportEmails } = config;
    if (!brevoApiKey) return { ok: false, error: 'Не задан BREVO_API_KEY' };
    if (!reportEmails || reportEmails.length === 0) return { ok: false, error: 'Не задан REPORT_EMAIL' };

    try {
        const { file, name, label } = await buildExcelReport(pool, period);
        const fileBuffer = fs.readFileSync(file);
        const fileBase64 = fileBuffer.toString('base64');
        const dateRu = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Yekaterinburg' });
        const senderEmail = smtpUser || 'bot@brevo.com';

        const axios = require('axios');
        const response = await axios.post(
            'https://api.brevo.com/v3/smtp/email',
            {
                sender: { name: '🤖 Учёт времени', email: senderEmail },
                to: reportEmails.map(email => ({ email })),
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
                                Отправлено: ${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Yekaterinburg' })}
                            </p>
                        </div>
                    </div>`,
                attachment: [{ content: fileBase64, name }],
            },
            { headers: { 'api-key': brevoApiKey, 'Content-Type': 'application/json' }, timeout: 30000 }
        );

        try { fs.unlinkSync(file); } catch (_) {}
        console.log(`✅ Отчёт "${label}" отправлен на ${reportEmails.join(', ')} (Brevo API, статус ${response.status})`);
        return { ok: true, label, email: reportEmails };
    } catch (err) {
        console.error('❌ Email error:', err.message);
        return { ok: false, error: err.message };
    }
}

// ═════════════════════════════════════════════════════════════════════════════
//  АВТОМАТИЧЕСКИЕ ОТЧЁТЫ ПО КРОНУ
// ═════════════════════════════════════════════════════════════════════════════
function scheduleCronReports(pool, config, sendMessageFn) {
    cron.schedule('0 14 * * 1-5', async () => {
        console.log('⏰ Автоотчёт: ежедневный (пн–пт 19:00 Ект)');
        const result = await sendReportByEmail(pool, 'today', config);
        if (!result.ok) {
            console.error('❌ Автоотчёт не отправлен:', result.error);
        }
    }, { timezone: 'UTC' });

    cron.schedule('0 13 * * 5', async () => {
        console.log('⏰ Автоотчёт: недельный (пятница 18:00 Ект)');
        const result = await sendReportByEmail(pool, 'week', config);
        if (!result.ok) {
            console.error('❌ Недельный отчёт не отправлен:', result.error);
        }
    }, { timezone: 'UTC' });

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
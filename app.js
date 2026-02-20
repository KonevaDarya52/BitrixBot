require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path    = require('path');
const cron    = require('node-cron');

const app  = express();
const port = process.env.PORT || 10000;

// ─── Настройки ────────────────────────────────────────────────────────────────
const APP_DOMAIN    = process.env.APP_DOMAIN    || 'bitrixbot-bnnd.onrender.com';
const BITRIX_WEBHOOK = process.env.BITRIX_WEBHOOK || ''; // вставить вебхук заказчика
const OFFICE_LAT    = parseFloat(process.env.OFFICE_LAT || '55.7558');
const OFFICE_LON    = parseFloat(process.env.OFFICE_LON || '37.6173');
const OFFICE_RADIUS = parseInt(process.env.OFFICE_RADIUS || '150');   // метров
const MANAGER_ID    = process.env.MANAGER_USER_ID || '1';             // ID руководителя в Битрикс24
const REPORT_EMAIL  = process.env.REPORT_EMAIL   || '';

// ─── База данных ──────────────────────────────────────────────────────────────
const db = new sqlite3.Database(path.join(__dirname, 'attendance.db'));

db.serialize(() => {
    // Отметки присутствия
    db.run(`CREATE TABLE IF NOT EXISTS attendance (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     TEXT NOT NULL,
        user_name   TEXT,
        type        TEXT NOT NULL,
        timestamp   DATETIME DEFAULT CURRENT_TIMESTAMP,
        latitude    REAL,
        longitude   REAL,
        in_office   INTEGER DEFAULT 0
    )`);

    // Токены геолокации (одноразовые)
    db.run(`CREATE TABLE IF NOT EXISTS geo_tokens (
        token       TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        user_name   TEXT,
        dialog_id   TEXT NOT NULL,
        bot_id      TEXT NOT NULL,
        domain      TEXT NOT NULL,
        access_token TEXT NOT NULL,
        type        TEXT NOT NULL,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    console.log(`📍 ${new Date().toISOString()} ${req.method} ${req.url}`);
    next();
});

// ─── Утилиты ─────────────────────────────────────────────────────────────────

// Расстояние между координатами (метры)
function getDistance(lat1, lon1, lat2, lon2) {
    const R    = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a    = Math.sin(dLat/2) ** 2
               + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Одноразовый токен
function makeToken() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Отправить сообщение через вебхук (не требует auth от Битрикс24)
async function sendMessage(domain, accessToken, botId, dialogId, message, buttons = null) {
    try {
        const payload = {
            BOT_ID:    botId,
            DIALOG_ID: dialogId,
            MESSAGE:   message,
        };

        if (buttons) {
            payload.KEYBOARD = { BUTTONS: buttons };
        }

        await axios.post(
            `https://${domain}/rest/imbot.message.add`,
            payload,
            { params: { auth: accessToken } }
        );
    } catch (err) {
        console.error('❌ sendMessage error:', err.response?.data || err.message);
    }
}

// Уведомить руководителя через вебхук
async function notifyManager(text) {
    if (!BITRIX_WEBHOOK) return;
    try {
        await axios.post(`${BITRIX_WEBHOOK}im.notify.system.add`, {
            USER_ID: MANAGER_ID,
            MESSAGE: text,
        });
    } catch (err) {
        console.error('❌ notifyManager error:', err.message);
    }
}

// Записать отметку в БД
function saveAttendance(userId, userName, type, lat, lon, inOffice) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO attendance (user_id, user_name, type, latitude, longitude, in_office)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, userName, type, lat, lon, inOffice ? 1 : 0],
            function(err) { err ? reject(err) : resolve(this.lastID); }
        );
    });
}

// Получить отметки пользователя за сегодня
function getTodayMarks(userId) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT type, timestamp, in_office FROM attendance
             WHERE user_id = ? AND date(timestamp) = date('now','localtime')
             ORDER BY timestamp`,
            [userId],
            (err, rows) => err ? reject(err) : resolve(rows)
        );
    });
}

// Сохранить токен геолокации
function saveToken(token, userId, userName, dialogId, botId, domain, accessToken, type) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT OR REPLACE INTO geo_tokens
             (token, user_id, user_name, dialog_id, bot_id, domain, access_token, type)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [token, userId, userName, dialogId, botId, domain, accessToken, type],
            err => err ? reject(err) : resolve()
        );
    });
}

// Получить и удалить токен
function popToken(token) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT * FROM geo_tokens WHERE token = ?`, [token], (err, row) => {
            if (err) return reject(err);
            if (!row) return resolve(null);
            db.run(`DELETE FROM geo_tokens WHERE token = ?`, [token]);
            resolve(row);
        });
    });
}

// ─── Страница геолокации ──────────────────────────────────────────────────────
app.get('/geo', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).send('Токен не найден');

    res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Отметка присутствия</title>
    <style>
        body {
            font-family: -apple-system, sans-serif;
            display: flex; align-items: center; justify-content: center;
            min-height: 100vh; margin: 0;
            background: #f0f4ff;
        }
        .card {
            background: white; border-radius: 20px;
            padding: 40px 30px; text-align: center;
            box-shadow: 0 8px 32px rgba(0,0,0,0.1);
            max-width: 320px; width: 90%;
        }
        .icon { font-size: 48px; margin-bottom: 16px; }
        h2 { color: #1a1a2e; margin: 0 0 8px; }
        p  { color: #666; font-size: 14px; }
    </style>
</head>
<body>
<div class="card">
    <div class="icon" id="icon">📍</div>
    <h2 id="title">Определяем геолокацию...</h2>
    <p id="msg">Пожалуйста, разрешите доступ к местоположению</p>
</div>
<script>
function done(icon, title, msg) {
    document.getElementById('icon').textContent  = icon;
    document.getElementById('title').textContent = title;
    document.getElementById('msg').textContent   = msg;
}

if (!navigator.geolocation) {
    done('❌', 'Ошибка', 'Геолокация не поддерживается браузером');
} else {
    navigator.geolocation.getCurrentPosition(
        pos => {
            fetch('/confirm-geo', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    token: '${token}',
                    lat:   pos.coords.latitude,
                    lon:   pos.coords.longitude,
                })
            })
            .then(r => r.json())
            .then(d => {
                if (d.ok) {
                    if (d.in_office) {
                        done('✅', 'Отметка принята!', 'Вы в офисе. Можно закрыть страницу.');
                    } else {
                        done('⚠️', 'Отметка принята', 'Вы вне офиса. Руководитель уведомлён.');
                    }
                } else {
                    done('❌', 'Ошибка', d.error || 'Попробуйте ещё раз');
                }
                setTimeout(() => window.close(), 3000);
            })
            .catch(() => done('❌', 'Ошибка сети', 'Проверьте подключение'));
        },
        err => {
            const msgs = {
                1: 'Вы запретили доступ к геолокации. Разрешите в настройках браузера.',
                2: 'Не удалось определить местоположение.',
                3: 'Превышено время ожидания геолокации.',
            };
            done('❌', 'Нет геолокации', msgs[err.code] || 'Неизвестная ошибка');
        },
        { timeout: 10000, enableHighAccuracy: true }
    );
}
</script>
</body>
</html>`);
});

// ─── Подтверждение геолокации ─────────────────────────────────────────────────
app.post('/confirm-geo', async (req, res) => {
    const { token, lat, lon } = req.body;

    const rec = await popToken(token);
    if (!rec) return res.json({ ok: false, error: 'Токен устарел или уже использован' });

    const inOffice = getDistance(lat, lon, OFFICE_LAT, OFFICE_LON) <= OFFICE_RADIUS;
    const typeLabel = rec.type === 'in' ? 'Приход' : 'Уход';
    const time      = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

    await saveAttendance(rec.user_id, rec.user_name, rec.type, lat, lon, inOffice);

    // Отвечаем пользователю в чат Битрикс24
    const statusText = inOffice ? '📍 В офисе' : '⚠️ Вне офиса';
    await sendMessage(
        rec.domain, rec.access_token, rec.bot_id, rec.dialog_id,
        `${rec.type === 'in' ? '✅' : '🚪'} ${typeLabel} зафиксирован в ${time}\n${statusText}`
    );

    // Если вне офиса — уведомляем руководителя
    if (!inOffice) {
        await notifyManager(
            `⚠️ ${rec.user_name} отметил ${typeLabel.toLowerCase()} вне офиса в ${time}\n` +
            `Координаты: ${lat.toFixed(5)}, ${lon.toFixed(5)}`
        );
    }

    console.log(`✅ ${rec.user_name} — ${typeLabel} в ${time}, в офисе: ${inOffice}`);
    res.json({ ok: true, in_office: inOffice });
});

// ─── Вебхук бота (приём сообщений от Битрикс24) ───────────────────────────────
app.post('/imbot', async (req, res) => {
    res.json({ result: 'ok' }); // отвечаем сразу чтобы Битрикс не ждал

    try {
        const { event, data, auth } = req.body;
        if (!event || !data?.PARAMS) return;

        const { MESSAGE, DIALOG_ID, BOT_ID, FROM_USER_ID, USER_NAME } = data.PARAMS;
        const userName   = USER_NAME || `Пользователь ${FROM_USER_ID}`;
        const cleanMsg   = (MESSAGE || '').toLowerCase().trim();
        const geoBaseUrl = `https://${APP_DOMAIN}/geo`;

        console.log(`💬 [${userName}] написал: "${MESSAGE}"`);

        // ── Приветствие при входе в чат ───────────────────────────
        if (event === 'ONIMBOTJOINCHAT') {
            await sendMessage(auth.domain, auth.access_token, BOT_ID, DIALOG_ID,
                `👋 Привет, ${userName}!\n\n` +
                `Я слежу за посещаемостью. Доступные команды:\n` +
                `• "пришел" — отметить приход\n` +
                `• "ушел" — отметить уход\n` +
                `• "статус" — мои отметки сегодня\n` +
                `• "помощь" — справка`
            );
            return;
        }

        if (event !== 'ONIMBOTMESSAGEADD') return;

        // ── Обработка команд ──────────────────────────────────────
        if (cleanMsg === 'пришел' || cleanMsg === 'пришёл') {
            const token = makeToken();
            await saveToken(token, FROM_USER_ID, userName, DIALOG_ID, BOT_ID, auth.domain, auth.access_token, 'in');
            await sendMessage(auth.domain, auth.access_token, BOT_ID, DIALOG_ID,
                `📍 Нажми ссылку ниже чтобы подтвердить приход через геолокацию:\n` +
                `👉 ${geoBaseUrl}?token=${token}\n\n` +
                `_Ссылка действительна 5 минут_`
            );

        } else if (cleanMsg === 'ушел' || cleanMsg === 'ушёл') {
            // Проверяем — был ли приход сегодня
            const marks = await getTodayMarks(FROM_USER_ID);
            const hasIn = marks.some(m => m.type === 'in');

            if (!hasIn) {
                await sendMessage(auth.domain, auth.access_token, BOT_ID, DIALOG_ID,
                    `⚠️ Не нашёл отметки прихода сегодня.\nСначала напиши "пришел".`
                );
                return;
            }

            const token = makeToken();
            await saveToken(token, FROM_USER_ID, userName, DIALOG_ID, BOT_ID, auth.domain, auth.access_token, 'out');
            await sendMessage(auth.domain, auth.access_token, BOT_ID, DIALOG_ID,
                `📍 Нажми ссылку чтобы подтвердить уход:\n` +
                `👉 ${geoBaseUrl}?token=${token}\n\n` +
                `_Ссылка действительна 5 минут_`
            );

        } else if (cleanMsg === 'статус') {
            const marks = await getTodayMarks(FROM_USER_ID);

            if (marks.length === 0) {
                await sendMessage(auth.domain, auth.access_token, BOT_ID, DIALOG_ID,
                    `📊 Сегодня отметок нет.\nНапиши "пришел" когда придёшь в офис.`
                );
            } else {
                const lines = marks.map(m => {
                    const t    = new Date(m.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                    const type = m.type === 'in' ? '✅ Приход' : '🚪 Уход';
                    const loc  = m.in_office ? '📍 В офисе' : '⚠️ Вне офиса';
                    return `${type} в ${t} — ${loc}`;
                }).join('\n');

                await sendMessage(auth.domain, auth.access_token, BOT_ID, DIALOG_ID,
                    `📊 Твои отметки сегодня:\n\n${lines}`
                );
            }

        } else if (cleanMsg === 'помощь') {
            await sendMessage(auth.domain, auth.access_token, BOT_ID, DIALOG_ID,
                `🤖 Бот учёта посещаемости\n\n` +
                `Команды:\n` +
                `• "пришел" — отметить приход (откроется страница геолокации)\n` +
                `• "ушел" — отметить уход\n` +
                `• "статус" — посмотреть свои отметки за сегодня\n` +
                `• "помощь" — эта справка\n\n` +
                `При отметке нужно разрешить доступ к геолокации в браузере.`
            );

        } else {
            await sendMessage(auth.domain, auth.access_token, BOT_ID, DIALOG_ID,
                `❓ Не понимаю команду "${MESSAGE}".\nНапиши "помощь" для списка команд.`
            );
        }

    } catch (err) {
        console.error('❌ imbot handler error:', err.message);
    }
});

// ─── Очистка устаревших токенов (каждые 10 минут) ────────────────────────────
cron.schedule('*/10 * * * *', () => {
    db.run(`DELETE FROM geo_tokens WHERE created_at < datetime('now', '-10 minutes')`);
});

// ─── Напоминания по расписанию (пн-пт) ───────────────────────────────────────

// 08:45 — напомнить всем отметиться (через вебхук)
cron.schedule('45 8 * * 1-5', async () => {
    if (!BITRIX_WEBHOOK) return;
    console.log('⏰ Отправляем утренние напоминания...');
    try {
        // Получаем список активных пользователей через вебхук
        const resp = await axios.get(`${BITRIX_WEBHOOK}user.get`, {
            params: { ACTIVE: true, filter: { 'UF_DEPARTMENT': true } }
        });
        const users = resp.data?.result || [];

        for (const user of users) {
            // Проверяем — отметился ли уже сегодня
            const marks = await getTodayMarks(String(user.ID));
            if (marks.length === 0) {
                await axios.post(`${BITRIX_WEBHOOK}im.notify.system.add`, {
                    USER_ID: user.ID,
                    MESSAGE: `☀️ Доброе утро! Не забудь отметить приход.\nНайди бота "Учёт времени" в чатах и напиши "пришел".`,
                });
            }
        }
    } catch (err) {
        console.error('❌ Morning reminder error:', err.message);
    }
});

// 09:35 — проверяем кто не отметился, уведомляем руководителя
cron.schedule('35 9 * * 1-5', async () => {
    if (!BITRIX_WEBHOOK) return;
    console.log('⏰ Проверяем опоздавших...');
    try {
        const resp  = await axios.get(`${BITRIX_WEBHOOK}user.get`, { params: { ACTIVE: true } });
        const users = resp.data?.result || [];
        const late  = [];

        for (const user of users) {
            const marks = await getTodayMarks(String(user.ID));
            if (marks.length === 0) {
                late.push(`• ${user.NAME} ${user.LAST_NAME}`);
            }
        }

        if (late.length > 0) {
            await notifyManager(
                `🔴 Не отметились к 9:30:\n${late.join('\n')}`
            );
        }
    } catch (err) {
        console.error('❌ Late check error:', err.message);
    }
});

// ─── Статус сервера ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({
        status:  'running',
        service: 'Bitrix24 Attendance Bot',
        webhook: BITRIX_WEBHOOK ? '✅ настроен' : '❌ не настроен — добавь BITRIX_WEBHOOK в .env',
        office:  `${OFFICE_LAT}, ${OFFICE_LON} (радиус ${OFFICE_RADIUS}м)`,
        time:    new Date().toISOString(),
    });
});

app.get('/status', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ─── Запуск ───────────────────────────────────────────────────────────────────
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на порту ${port}`);
    console.log(`📍 APP_DOMAIN:     ${APP_DOMAIN}`);
    console.log(`🔗 BITRIX_WEBHOOK: ${BITRIX_WEBHOOK || '❌ не настроен'}`);
    console.log(`📍 Офис:           ${OFFICE_LAT}, ${OFFICE_LON} (${OFFICE_RADIUS}м)`);
    console.log('=== ✅ READY ===');
});
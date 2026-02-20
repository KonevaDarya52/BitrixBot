require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path    = require('path');
const cron    = require('node-cron');

const app  = express();
const port = process.env.PORT || 10000;

// ─── Настройки ────────────────────────────────────────────────────────────────
const APP_DOMAIN     = process.env.APP_DOMAIN     || 'bitrixbot-bnnd.onrender.com';
const BITRIX_DOMAIN  = process.env.BITRIX_DOMAIN  || '';
const CLIENT_ID      = process.env.BITRIX_CLIENT_ID     || '';
const CLIENT_SECRET  = process.env.BITRIX_CLIENT_SECRET || '';
const BITRIX_WEBHOOK = process.env.BITRIX_WEBHOOK || ''; // заполнится когда заказчик даст вебхук
const OFFICE_LAT     = parseFloat(process.env.OFFICE_LAT    || '57.151929');
const OFFICE_LON     = parseFloat(process.env.OFFICE_LON    || '65.592076');
const OFFICE_RADIUS  = parseInt(process.env.OFFICE_RADIUS   || '100');
const MANAGER_ID     = process.env.MANAGER_USER_ID || '1';

// ─── Хранилище токенов портала (в памяти — для каждого установленного портала)
// Структура: { domain: { access_token, refresh_token, bot_id } }
const portals = {};

// ─── База данных ──────────────────────────────────────────────────────────────
const db = new sqlite3.Database(path.join(__dirname, 'attendance.db'));

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS attendance (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     TEXT NOT NULL,
        user_name   TEXT,
        domain      TEXT,
        type        TEXT NOT NULL,
        timestamp   DATETIME DEFAULT CURRENT_TIMESTAMP,
        latitude    REAL,
        longitude   REAL,
        in_office   INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS geo_tokens (
        token        TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL,
        user_name    TEXT,
        dialog_id    TEXT NOT NULL,
        bot_id       TEXT NOT NULL,
        domain       TEXT NOT NULL,
        access_token TEXT NOT NULL,
        type         TEXT NOT NULL,
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    console.log(`📍 ${new Date().toISOString()} ${req.method} ${req.url}`);
    next();
});

// ═════════════════════════════════════════════════════════════════════════════
//  УТИЛИТЫ
// ═════════════════════════════════════════════════════════════════════════════

function getDistance(lat1, lon1, lat2, lon2) {
    const R    = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a    = Math.sin(dLat/2) ** 2
               + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180)
               * Math.sin(dLon/2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function makeToken() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Вызов REST API Битрикс24 с токеном доступа
async function callBitrix(domain, accessToken, method, params = {}) {
    try {
        const resp = await axios.post(
            `https://${domain}/rest/${method}`,
            params,
            { params: { auth: accessToken } }
        );
        return resp.data;
    } catch (err) {
        console.error(`❌ Bitrix API error [${method}]:`, err.response?.data || err.message);
        return null;
    }
}

// Отправить сообщение сотруднику в чат бота
async function sendMessage(domain, accessToken, botId, dialogId, message) {
    return callBitrix(domain, accessToken, 'imbot.message.add', {
        BOT_ID:    botId,
        DIALOG_ID: dialogId,
        MESSAGE:   message,
    });
}

// Уведомить руководителя
async function notifyManager(domain, accessToken, text) {
    // Через вебхук (если есть)
    if (BITRIX_WEBHOOK) {
        try {
            await axios.post(`${BITRIX_WEBHOOK}im.notify.system.add`, {
                USER_ID: MANAGER_ID,
                MESSAGE: text,
            });
            return;
        } catch {}
    }
    // Через токен портала
    if (domain && accessToken) {
        await callBitrix(domain, accessToken, 'im.notify.system.add', {
            USER_ID: MANAGER_ID,
            MESSAGE: text,
        });
    }
}

// ─── БД: записать отметку
function saveAttendance(userId, userName, domain, type, lat, lon, inOffice) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO attendance (user_id, user_name, domain, type, latitude, longitude, in_office)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [userId, userName, domain, type, lat, lon, inOffice ? 1 : 0],
            function(err) { err ? reject(err) : resolve(this.lastID); }
        );
    });
}

// ─── БД: отметки за сегодня
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

// ─── БД: сохранить токен геолокации
function saveGeoToken(token, userId, userName, dialogId, botId, domain, accessToken, type) {
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

// ─── БД: взять и удалить токен (одноразовый)
function popGeoToken(token) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT * FROM geo_tokens WHERE token = ?`, [token], (err, row) => {
            if (err) return reject(err);
            if (!row) return resolve(null);
            db.run(`DELETE FROM geo_tokens WHERE token = ?`, [token]);
            resolve(row);
        });
    });
}

// ═════════════════════════════════════════════════════════════════════════════
//  УСТАНОВКА ЧЕРЕЗ OAUTH (для тестового портала)
// ═════════════════════════════════════════════════════════════════════════════

// Страница установки
app.get('/install', async (req, res) => {
    const { code, domain } = req.query;

    // Нет кода — редиректим на OAuth
    if (!code) {
        const redirectUri = `https://${APP_DOMAIN}/install`;
        const authUrl = `https://${BITRIX_DOMAIN}/oauth/authorize/`
            + `?client_id=${CLIENT_ID}`
            + `&response_type=code`
            + `&redirect_uri=${encodeURIComponent(redirectUri)}`;
        console.log('🔐 Redirecting to OAuth:', authUrl);
        return res.redirect(authUrl);
    }

    console.log('✅ OAuth callback received, domain:', domain);

    try {
        // Получаем access_token
        const tokenResp = await axios.post(
            'https://oauth.bitrix.info/oauth/token/',
            null,
            {
                params: {
                    grant_type:    'authorization_code',
                    client_id:     CLIENT_ID,
                    client_secret: CLIENT_SECRET,
                    code,
                    redirect_uri:  `https://${APP_DOMAIN}/install`,
                }
            }
        );

        const { access_token, refresh_token } = tokenResp.data;
        console.log('✅ Got access_token');

        // Регистрируем бота
        const botResp = await axios.post(
            `https://${domain}/rest/imbot.register`,
            {
                CODE:                  'attendance_bot',
                TYPE:                  'H',
                EVENT_MESSAGE_ADD:     `https://${APP_DOMAIN}/imbot`,
                EVENT_WELCOME_MESSAGE: `https://${APP_DOMAIN}/imbot`,
                EVENT_BOT_DELETE:      `https://${APP_DOMAIN}/imbot`,
                PROPERTIES: {
                    NAME:          'Учёт времени',
                    COLOR:         'GREEN',
                    DESCRIPTION:   'Бот учёта присутствия сотрудников',
                    WORK_POSITION: 'Помощник HR',
                }
            },
            { params: { auth: access_token } }
        );

        const botId = botResp.data?.result;
        console.log('✅ Bot registered, ID:', botId);

        // Сохраняем токены портала в памяти
        portals[domain] = { access_token, refresh_token, bot_id: botId };

        res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <title>Бот установлен!</title>
    <style>
        body { font-family: Arial, sans-serif; background: #e8f5e9;
               display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
        .card { background:white; border-radius:16px; padding:40px; text-align:center;
                box-shadow:0 8px 24px rgba(0,0,0,0.1); max-width:480px; }
        h1 { color:#2e7d32; }
        .btn { display:inline-block; margin-top:20px; padding:14px 28px;
               background:#2d8cff; color:white; border-radius:8px;
               text-decoration:none; font-size:16px; }
    </style>
</head>
<body>
<div class="card">
    <h1>🎉 Бот установлен!</h1>
    <p>Бот <strong>"Учёт времени"</strong> появился в чатах Битрикс24.</p>
    <p>Найдите его в списке чатов и напишите <strong>"помощь"</strong> для начала работы.</p>
    <a href="https://${domain}" class="btn">Перейти в Битрикс24</a>
</div>
</body>
</html>`);

    } catch (err) {
        console.error('❌ Install error:', err.response?.data || err.message);
        const detail = err.response?.data?.error_description || err.message;
        res.send(`<!DOCTYPE html>
<html lang="ru">
<head><meta charset="UTF-8"><title>Ошибка</title>
<style>body{font-family:Arial,sans-serif;background:#fce4ec;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.card{background:white;border-radius:16px;padding:40px;text-align:center;
box-shadow:0 8px 24px rgba(0,0,0,0.1);max-width:480px;}
h1{color:#c62828;} pre{background:#f5f5f5;padding:12px;border-radius:8px;text-align:left;font-size:13px;}
.btn{display:inline-block;margin-top:20px;padding:14px 28px;
background:#dc3545;color:white;border-radius:8px;text-decoration:none;}</style>
</head>
<body>
<div class="card">
    <h1>❌ Ошибка установки</h1>
    <pre>${detail}</pre>
    <a href="/install" class="btn">Попробовать снова</a>
</div>
</body>
</html>`);
    }
});

// ═════════════════════════════════════════════════════════════════════════════
//  СТРАНИЦА ГЕОЛОКАЦИИ
// ═════════════════════════════════════════════════════════════════════════════

app.get('/geo', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).send('Токен не найден');

    // Экранируем токен для вставки в JS
    const safeToken = token.replace(/['"\\]/g, '');

    res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Отметка присутствия</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: #f0f4ff;
            display: flex; align-items: center; justify-content: center;
            min-height: 100vh;
        }
        .card {
            background: white; border-radius: 24px;
            padding: 48px 32px; text-align: center;
            box-shadow: 0 8px 32px rgba(0,0,0,0.12);
            max-width: 340px; width: 90%;
        }
        .icon { font-size: 56px; margin-bottom: 20px; }
        h2 { font-size: 22px; color: #1a1a2e; margin-bottom: 8px; }
        p { font-size: 14px; color: #666; line-height: 1.5; }
        .spinner {
            width: 40px; height: 40px; margin: 16px auto;
            border: 4px solid #e0e0e0; border-top-color: #2d8cff;
            border-radius: 50%; animation: spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
<div class="card">
    <div class="icon" id="icon">📍</div>
    <h2 id="title">Определяем местоположение...</h2>
    <div class="spinner" id="spinner"></div>
    <p id="msg">Пожалуйста, разрешите доступ к геолокации когда браузер спросит</p>
</div>
<script>
function done(icon, title, msg) {
    document.getElementById('icon').textContent  = icon;
    document.getElementById('title').textContent = title;
    document.getElementById('msg').textContent   = msg;
    document.getElementById('spinner').style.display = 'none';
}

if (!navigator.geolocation) {
    done('❌', 'Нет поддержки', 'Ваш браузер не поддерживает геолокацию. Попробуйте Chrome или Safari.');
} else {
    navigator.geolocation.getCurrentPosition(
        function(pos) {
            done('⏳', 'Отправляем данные...', 'Подождите секунду');
            fetch('/confirm-geo', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    token: '${safeToken}',
                    lat:   pos.coords.latitude,
                    lon:   pos.coords.longitude,
                })
            })
            .then(function(r) { return r.json(); })
            .then(function(d) {
                if (d.ok) {
                    if (d.in_office) {
                        done('✅', 'Отметка принята!', 'Вы в офисе. Страница закроется автоматически.');
                    } else {
                        done('⚠️', 'Отметка принята', 'Вы вне офиса. Руководитель получил уведомление.');
                    }
                } else {
                    done('❌', 'Ошибка', d.error || 'Попробуйте ещё раз.');
                }
                setTimeout(function() { window.close(); }, 3000);
            })
            .catch(function() {
                done('❌', 'Ошибка сети', 'Проверьте подключение к интернету и попробуйте снова.');
            });
        },
        function(err) {
            var msgs = {
                1: 'Вы запретили доступ к геолокации. Разрешите в настройках браузера и обновите страницу.',
                2: 'Не удалось определить местоположение. Убедитесь что GPS включён.',
                3: 'Превышено время ожидания. Обновите страницу и попробуйте снова.',
            };
            done('❌', 'Геолокация недоступна', msgs[err.code] || 'Неизвестная ошибка: ' + err.message);
        },
        { timeout: 15000, enableHighAccuracy: true, maximumAge: 0 }
    );
}
</script>
</body>
</html>`);
});

// ═════════════════════════════════════════════════════════════════════════════
//  ПОДТВЕРЖДЕНИЕ ГЕОЛОКАЦИИ
// ═════════════════════════════════════════════════════════════════════════════

app.post('/confirm-geo', async (req, res) => {
    const { token, lat, lon } = req.body;

    if (!token || lat == null || lon == null) {
        return res.json({ ok: false, error: 'Неверные данные' });
    }

    const rec = await popGeoToken(token);
    if (!rec) {
        return res.json({ ok: false, error: 'Ссылка устарела или уже была использована. Запроси новую в боте.' });
    }

    const inOffice  = getDistance(lat, lon, OFFICE_LAT, OFFICE_LON) <= OFFICE_RADIUS;
    const typeLabel = rec.type === 'in' ? 'Приход' : 'Уход';
    const time      = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const emoji     = rec.type === 'in' ? '✅' : '🚪';
    const locLabel  = inOffice ? '📍 В офисе' : '⚠️ Вне офиса';

    // Сохраняем отметку
    await saveAttendance(rec.user_id, rec.user_name, rec.domain, rec.type, lat, lon, inOffice);

    // Сообщаем сотруднику в чат
    await sendMessage(
        rec.domain, rec.access_token, rec.bot_id, rec.dialog_id,
        `${emoji} ${typeLabel} зафиксирован в ${time}\n${locLabel}`
    );

    // Если вне офиса — уведомляем руководителя
    if (!inOffice) {
        await notifyManager(
            rec.domain, rec.access_token,
            `⚠️ ${rec.user_name} — ${typeLabel.toLowerCase()} вне офиса в ${time}\n` +
            `Координаты: ${parseFloat(lat).toFixed(5)}, ${parseFloat(lon).toFixed(5)}`
        );
    }

    console.log(`✅ [${rec.domain}] ${rec.user_name} — ${typeLabel} в ${time}, в офисе: ${inOffice}`);
    res.json({ ok: true, in_office: inOffice });
});

// ═════════════════════════════════════════════════════════════════════════════
//  ВЕБХУК БОТА — приём событий от Битрикс24
// ═════════════════════════════════════════════════════════════════════════════

app.post('/imbot', async (req, res) => {
    // Всегда отвечаем быстро — Битрикс ждёт не более 5 секунд
    res.json({ result: 'ok' });

    try {
        const { event, data, auth } = req.body;
        if (!event || !data?.PARAMS) return;

        const { MESSAGE, DIALOG_ID, BOT_ID, FROM_USER_ID, USER_NAME } = data.PARAMS;
        const userName  = USER_NAME || `Пользователь ${FROM_USER_ID}`;
        const cleanMsg  = (MESSAGE || '').toLowerCase().trim();
        const domain    = auth?.domain;
        const authToken = auth?.access_token;
        const geoUrl    = `https://${APP_DOMAIN}/geo`;

        console.log(`💬 [${domain}] ${userName}: "${MESSAGE}" (event: ${event})`);

        // Обновляем токен портала если он изменился
        if (domain && authToken) {
            if (!portals[domain]) portals[domain] = {};
            portals[domain].access_token = authToken;
            portals[domain].bot_id       = BOT_ID;
        }

        // ── Приветствие при первом входе в чат ────────────────────
        if (event === 'ONIMBOTJOINCHAT') {
            await sendMessage(domain, authToken, BOT_ID, DIALOG_ID,
                `👋 Привет, ${userName}!\n\n` +
                `Я помогаю фиксировать присутствие в офисе.\n\n` +
                `Команды:\n` +
                `• "пришел" — отметить приход\n` +
                `• "ушел" — отметить уход\n` +
                `• "статус" — мои отметки сегодня\n` +
                `• "помощь" — справка`
            );
            return;
        }

        if (event !== 'ONIMBOTMESSAGEADD') return;

        // ── Команда: пришел ────────────────────────────────────────
        if (cleanMsg === 'пришел' || cleanMsg === 'пришёл') {
            const token = makeToken();
            await saveGeoToken(token, FROM_USER_ID, userName, DIALOG_ID, BOT_ID, domain, authToken, 'in');
            await sendMessage(domain, authToken, BOT_ID, DIALOG_ID,
                `📍 Нажми на ссылку ниже — откроется страница геолокации.\n` +
                `Разреши доступ к местоположению и отметка зафиксируется автоматически.\n\n` +
                `👉 ${geoUrl}?token=${token}\n\n` +
                `_Ссылка действительна 10 минут_`
            );

        // ── Команда: ушел ──────────────────────────────────────────
        } else if (cleanMsg === 'ушел' || cleanMsg === 'ушёл') {
            const marks = await getTodayMarks(FROM_USER_ID);
            const hasIn = marks.some(m => m.type === 'in');

            if (!hasIn) {
                await sendMessage(domain, authToken, BOT_ID, DIALOG_ID,
                    `⚠️ Нет отметки прихода сегодня.\nСначала напиши "пришел".`
                );
                return;
            }

            const hasOut = marks.some(m => m.type === 'out');
            if (hasOut) {
                await sendMessage(domain, authToken, BOT_ID, DIALOG_ID,
                    `ℹ️ Уход уже отмечен сегодня.\nНапиши "статус" чтобы посмотреть отметки.`
                );
                return;
            }

            const token = makeToken();
            await saveGeoToken(token, FROM_USER_ID, userName, DIALOG_ID, BOT_ID, domain, authToken, 'out');
            await sendMessage(domain, authToken, BOT_ID, DIALOG_ID,
                `📍 Нажми на ссылку чтобы подтвердить уход:\n\n` +
                `👉 ${geoUrl}?token=${token}\n\n` +
                `_Ссылка действительна 10 минут_`
            );

        // ── Команда: статус ────────────────────────────────────────
        } else if (cleanMsg === 'статус') {
            const marks = await getTodayMarks(FROM_USER_ID);

            if (marks.length === 0) {
                await sendMessage(domain, authToken, BOT_ID, DIALOG_ID,
                    `📊 Сегодня отметок нет.\nНапиши "пришел" когда придёшь в офис.`
                );
            } else {
                const lines = marks.map(m => {
                    const t   = new Date(m.timestamp + 'Z').toLocaleTimeString('ru-RU', {
                        hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Yekaterinburg'
                    });
                    const tp  = m.type === 'in' ? '✅ Приход' : '🚪 Уход';
                    const loc = m.in_office ? '📍 В офисе' : '⚠️ Вне офиса';
                    return `${tp} в ${t} — ${loc}`;
                }).join('\n');

                await sendMessage(domain, authToken, BOT_ID, DIALOG_ID,
                    `📊 Твои отметки сегодня:\n\n${lines}`
                );
            }

        // ── Команда: помощь ────────────────────────────────────────
        } else if (cleanMsg === 'помощь') {
            await sendMessage(domain, authToken, BOT_ID, DIALOG_ID,
                `🤖 Бот учёта посещаемости\n\n` +
                `Команды:\n` +
                `• "пришел" — отметить приход (нужно разрешить геолокацию)\n` +
                `• "ушел" — отметить уход\n` +
                `• "статус" — отметки за сегодня\n` +
                `• "помощь" — эта справка\n\n` +
                `При нажатии на ссылку откроется браузер — разреши доступ к местоположению.`
            );

        // ── Неизвестная команда ────────────────────────────────────
        } else {
            await sendMessage(domain, authToken, BOT_ID, DIALOG_ID,
                `❓ Не понимаю "${MESSAGE}".\nНапиши "помощь" для списка команд.`
            );
        }

    } catch (err) {
        console.error('❌ imbot error:', err.message);
    }
});

// ═════════════════════════════════════════════════════════════════════════════
//  РАСПИСАНИЕ
// ═════════════════════════════════════════════════════════════════════════════

// Чистим устаревшие гео-токены каждые 15 минут
cron.schedule('*/15 * * * *', () => {
    db.run(`DELETE FROM geo_tokens WHERE created_at < datetime('now', '-15 minutes')`);
    console.log('🧹 Устаревшие токены очищены');
});

// 09:35 пн-пт — уведомляем руководителя о не отметившихся
// Работает только если настроен BITRIX_WEBHOOK
cron.schedule('35 4 * * 1-5', async () => { // 04:35 UTC = 09:35 Тюмень (UTC+5)
    if (!BITRIX_WEBHOOK) return;
    console.log('⏰ Проверяем кто не отметился...');
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
            await axios.post(`${BITRIX_WEBHOOK}im.notify.system.add`, {
                USER_ID: MANAGER_ID,
                MESSAGE: `🔴 Не отметились к 9:30 (${new Date().toLocaleDateString('ru-RU')}):\n${late.join('\n')}`,
            });
        }
    } catch (err) {
        console.error('❌ Late check error:', err.message);
    }
});

// ═════════════════════════════════════════════════════════════════════════════
//  ВСПОМОГАТЕЛЬНЫЕ МАРШРУТЫ
// ═════════════════════════════════════════════════════════════════════════════

// Главная — страница установки
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Бот учёта времени</title>
    <style>
        body { font-family: Arial, sans-serif; background: linear-gradient(135deg,#667eea,#764ba2);
               min-height:100vh; margin:0; display:flex; align-items:center; justify-content:center; }
        .card { background:white; border-radius:16px; padding:40px; max-width:500px; width:90%;
                box-shadow:0 10px 40px rgba(0,0,0,0.2); }
        h1 { color:#2d8cff; margin-bottom:8px; }
        .btn { display:inline-block; margin-top:24px; padding:16px 32px;
               background:#2d8cff; color:white; border-radius:50px; text-decoration:none;
               font-size:18px; font-weight:bold; }
        ul { margin-top:16px; padding-left:20px; line-height:2; }
    </style>
</head>
<body>
<div class="card">
    <h1>🤖 Бот учёта рабочего времени</h1>
    <p>Автоматическая фиксация прихода и ухода сотрудников с проверкой геолокации.</p>
    <ul>
        <li>📍 Геолокация при каждой отметке</li>
        <li>⚠️ Уведомление если сотрудник вне офиса</li>
        <li>📊 Статус за текущий день</li>
        <li>🔔 Уведомления руководителю</li>
    </ul>
    <a href="/install" class="btn">📥 Установить в Битрикс24</a>
</div>
</body>
</html>`);
});

// Статус сервера (для UptimeRobot и проверки)
app.get('/status', (req, res) => {
    res.json({
        ok:      true,
        service: 'Bitrix24 Attendance Bot',
        domain:  APP_DOMAIN,
        office:  `${OFFICE_LAT}, ${OFFICE_LON} (радиус ${OFFICE_RADIUS}м)`,
        webhook: BITRIX_WEBHOOK ? '✅ настроен' : '⏳ ожидаем от заказчика',
        portals: Object.keys(portals),
        time:    new Date().toISOString(),
    });
});

// ─── Запуск ───────────────────────────────────────────────────────────────────
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен: https://${APP_DOMAIN}`);
    console.log(`📍 Офис: ${OFFICE_LAT}, ${OFFICE_LON} (${OFFICE_RADIUS}м)`);
    console.log(`🔗 Вебхук: ${BITRIX_WEBHOOK || '⏳ не настроен'}`);
    console.log('=== ✅ READY ===');
});
require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path    = require('path');
const cron    = require('node-cron');

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

    db.run(`CREATE TABLE IF NOT EXISTS portals (
        domain          TEXT PRIMARY KEY,
        access_token    TEXT NOT NULL,
        refresh_token   TEXT,
        bot_id          TEXT,
        client_endpoint TEXT,
        updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
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
    const a    = Math.sin(dLat / 2) ** 2
               + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
               * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function makeToken() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ─── БД: порталы ─────────────────────────────────────────────────────────────

function savePortal(domain, accessToken, refreshToken, botId, clientEndpoint) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT OR REPLACE INTO portals
             (domain, access_token, refresh_token, bot_id, client_endpoint, updated_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'))`,
            [domain, accessToken, refreshToken || '', botId || '', clientEndpoint || ''],
            err => err ? reject(err) : resolve()
        );
    });
}

function getPortal(domain) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT * FROM portals WHERE domain = ?`, [domain],
            (err, row) => err ? reject(err) : resolve(row || null)
        );
    });
}

// ─── БД: посещаемость ────────────────────────────────────────────────────────

function saveAttendance(userId, userName, domain, type, lat, lon, inOffice) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO attendance
             (user_id, user_name, domain, type, latitude, longitude, in_office)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [userId, userName, domain, type, lat, lon, inOffice ? 1 : 0],
            function(err) { err ? reject(err) : resolve(this.lastID); }
        );
    });
}

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

// ─── БД: гео-токены ──────────────────────────────────────────────────────────

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

// ─── Bitrix24 API ─────────────────────────────────────────────────────────────

async function doRefreshToken(domain, rToken) {
    try {
        const resp = await axios.get('https://oauth.bitrix24.tech/oauth/token/', {
            params: {
                grant_type:    'refresh_token',
                client_id:     CLIENT_ID,
                client_secret: CLIENT_SECRET,
                refresh_token: rToken,
            }
        });
        if (resp.data?.access_token) {
            const portal = await getPortal(domain);
            await savePortal(domain, resp.data.access_token, resp.data.refresh_token,
                portal?.bot_id, resp.data.client_endpoint);
            console.log('🔄 Токен обновлён для', domain);
            return resp.data.access_token;
        }
    } catch (err) {
        console.error('❌ Ошибка обновления токена:', err.message);
    }
    return null;
}

async function callBitrix(domain, accessToken, method, params = {}) {
    try {
        const resp = await axios.post(
            `https://${domain}/rest/${method}`,
            params,
            { params: { auth: accessToken }, timeout: 10000 }
        );
        return resp.data;
    } catch (err) {
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

async function sendMessage(domain, accessToken, botId, dialogId, message) {
    console.log(`📤 sendMessage → bot=${botId}, dialog=${dialogId}`);
    return callBitrix(domain, accessToken, 'imbot.message.add', {
        BOT_ID:    botId,
        DIALOG_ID: dialogId,
        MESSAGE:   message,
    });
}

async function notifyManager(domain, accessToken, text) {
    return callBitrix(domain, accessToken, 'im.notify.system.add', {
        USER_ID: MANAGER_ID,
        MESSAGE: text,
    });
}

// ─── Регистрация / перерегистрация бота ──────────────────────────────────────
// ВАЖНО: для imbot НЕ используем event.bind — события регистрируются только
// через поля EVENT_MESSAGE_ADD / EVENT_WELCOME_MESSAGE в imbot.register

async function registerBot(domain, accessToken, existingBotId) {
    const handlerUrl = `https://${APP_DOMAIN}/imbot`;

    // Если бот уже есть — сначала удаляем, чтобы обновить URL обработчика
    if (existingBotId) {
        console.log(`🗑 Удаляем старого бота ID=${existingBotId}...`);
        await callBitrix(domain, accessToken, 'imbot.unregister', { BOT_ID: existingBotId });
        await new Promise(r => setTimeout(r, 1500));
    }

    console.log('🤖 Регистрируем бота...');
    const resp = await callBitrix(domain, accessToken, 'imbot.register', {
        CODE:                  'attendance_bot',
        TYPE:                  'H',
        EVENT_MESSAGE_ADD:     handlerUrl,
        EVENT_WELCOME_MESSAGE: handlerUrl,
        EVENT_BOT_DELETE:      handlerUrl,
        PROPERTIES: {
            NAME:          'Учёт времени',
            COLOR:         'GREEN',
            DESCRIPTION:   'Бот учёта присутствия сотрудников',
            WORK_POSITION: 'Помощник HR',
        }
    });

    const botId = String(resp?.result || '');
    if (botId) {
        console.log('✅ Бот зарегистрирован, ID:', botId);
    } else {
        console.error('❌ Ошибка регистрации бота:', JSON.stringify(resp));
    }
    return botId;
}

// ═════════════════════════════════════════════════════════════════════════════
//  УСТАНОВКА
// ═════════════════════════════════════════════════════════════════════════════

app.post('/install', async (req, res) => {
    console.log('📥 POST /install body:', JSON.stringify(req.body));

    const AUTH_ID        = req.body.AUTH_ID        || req.body.auth_id;
    const REFRESH_ID     = req.body.REFRESH_ID     || req.body.refresh_id     || '';
    const SERVER_ENDPOINT= req.body.SERVER_ENDPOINT|| req.body.server_endpoint|| '';
    const domain         = req.body.DOMAIN         || req.body.domain
                        || req.query.DOMAIN        || req.query.domain        || '';

    if (AUTH_ID && domain) {
        console.log('🔑 Токен получен для домена:', domain);

        // Проверяем, есть ли уже зарегистрированный бот в Битрикс24
        const botsResp = await callBitrix(domain, AUTH_ID, 'imbot.bot.list', {});
        const botsArr  = Object.values(botsResp?.result || {});
        const ourBot   = botsArr.find(b => b.CODE === 'attendance_bot');

        if (ourBot) {
            // Бот уже есть — просто обновляем токен, бота не трогаем
            const existingBotId = String(ourBot.ID);
            console.log(`✅ Бот уже зарегистрирован (ID=${existingBotId}), обновляем токен`);
            await savePortal(domain, AUTH_ID, REFRESH_ID, existingBotId, SERVER_ENDPOINT);
        } else {
            // Бота нет — регистрируем впервые
            console.log('🤖 Бот не найден, регистрируем...');
            await savePortal(domain, AUTH_ID, REFRESH_ID, '', SERVER_ENDPOINT);
            const botId = await registerBot(domain, AUTH_ID, null);
            if (botId) {
                await savePortal(domain, AUTH_ID, REFRESH_ID, botId, SERVER_ENDPOINT);
            }
        }
    } else {
        console.warn('⚠️ /install — нет AUTH_ID или domain:', { AUTH_ID: !!AUTH_ID, domain });
    }

    res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Учёт времени</title>
    <style>
        body { font-family:Arial,sans-serif; background:#f0f4ff;
               display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
        .card { background:white; border-radius:16px; padding:40px; text-align:center;
                max-width:480px; width:90%; box-shadow:0 8px 24px rgba(0,0,0,0.1); }
        h1 { color:#2e7d32; margin-bottom:16px; }
        .cmd { background:#f5f5f5; border-radius:8px; padding:12px 20px;
               margin:8px 0; font-size:18px; font-weight:bold; display:inline-block; width:200px; }
        p { color:#555; line-height:1.6; }
    </style>
</head>
<body>
<div class="card">
    <h1>🤖 Бот "Учёт времени" установлен!</h1>
    <p>Найдите бота в списке чатов Битрикс24 и напишите одну из команд:</p>
    <br>
    <div class="cmd">пришел</div><br>
    <div class="cmd">ушел</div><br>
    <div class="cmd">статус</div><br>
    <div class="cmd">помощь</div>
</div>
</body>
</html>`);
});

// ═════════════════════════════════════════════════════════════════════════════
//  СТРАНИЦА ГЕОЛОКАЦИИ
// ═════════════════════════════════════════════════════════════════════════════

app.get('/geo', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).send('Токен не найден');
    const safeToken = token.replace(/['"\\<>]/g, '');

    res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Отметка присутствия</title>
    <style>
        * { box-sizing:border-box; margin:0; padding:0; }
        body { font-family:-apple-system,sans-serif; background:#f0f4ff;
               display:flex; align-items:center; justify-content:center; min-height:100vh; }
        .card { background:white; border-radius:24px; padding:48px 32px; text-align:center;
                box-shadow:0 8px 32px rgba(0,0,0,0.12); max-width:340px; width:90%; }
        .icon { font-size:56px; margin-bottom:20px; }
        h2 { font-size:22px; color:#1a1a2e; margin-bottom:8px; }
        p  { font-size:14px; color:#666; line-height:1.5; }
        .spinner { width:40px; height:40px; margin:16px auto;
                   border:4px solid #e0e0e0; border-top-color:#2d8cff;
                   border-radius:50%; animation:spin 0.8s linear infinite; }
        @keyframes spin { to { transform:rotate(360deg); } }
    </style>
</head>
<body>
<div class="card">
    <div class="icon" id="icon">📍</div>
    <h2 id="title">Определяем местоположение...</h2>
    <div class="spinner" id="spinner"></div>
    <p id="msg">Разрешите доступ к геолокации когда браузер спросит</p>
</div>
<script>
function done(icon, title, msg) {
    document.getElementById('icon').textContent  = icon;
    document.getElementById('title').textContent = title;
    document.getElementById('msg').textContent   = msg;
    document.getElementById('spinner').style.display = 'none';
}
if (!navigator.geolocation) {
    done('❌','Нет поддержки','Попробуйте Chrome или Safari');
} else {
    navigator.geolocation.getCurrentPosition(
        function(pos) {
            done('⏳','Отправляем данные...','Подождите');
            fetch('/confirm-geo', {
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({ token:'${safeToken}', lat:pos.coords.latitude, lon:pos.coords.longitude })
            })
            .then(function(r){ return r.json(); })
            .then(function(d){
                if (d.ok) {
                    done(d.in_office?'✅':'⚠️',
                         d.in_office?'Отметка принята!':'Отметка принята',
                         d.in_office?'Вы в офисе. Можно закрыть страницу.':'Вы вне офиса. Руководитель уведомлён.');
                } else {
                    done('❌','Ошибка', d.error||'Попробуйте ещё раз');
                }
                setTimeout(function(){ window.close(); }, 3000);
            })
            .catch(function(){ done('❌','Ошибка сети','Проверьте подключение'); });
        },
        function(err) {
            var msgs = {1:'Запретили геолокацию — разрешите в настройках браузера.',
                        2:'Не удалось определить местоположение.',
                        3:'Превышено время ожидания.'};
            done('❌','Геолокация недоступна', msgs[err.code]||'Ошибка: '+err.message);
        },
        { timeout:15000, enableHighAccuracy:true, maximumAge:0 }
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
    if (!token || lat == null || lon == null)
        return res.json({ ok: false, error: 'Неверные данные' });

    const rec = await popGeoToken(token);
    if (!rec)
        return res.json({ ok: false, error: 'Ссылка устарела или уже использована. Запроси новую в боте.' });

    const inOffice  = getDistance(lat, lon, OFFICE_LAT, OFFICE_LON) <= OFFICE_RADIUS;
    const typeLabel = rec.type === 'in' ? 'Приход' : 'Уход';
    const emoji     = rec.type === 'in' ? '✅' : '🚪';
    const time      = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

    await saveAttendance(rec.user_id, rec.user_name, rec.domain, rec.type, lat, lon, inOffice);

    await sendMessage(rec.domain, rec.access_token, rec.bot_id, rec.dialog_id,
        `${emoji} ${typeLabel} зафиксирован в ${time}\n` +
        (inOffice ? '📍 В офисе' : '⚠️ Вне офиса')
    );

    if (!inOffice) {
        await notifyManager(rec.domain, rec.access_token,
            `⚠️ ${rec.user_name} — ${typeLabel.toLowerCase()} вне офиса в ${time}\n` +
            `Координаты: ${parseFloat(lat).toFixed(5)}, ${parseFloat(lon).toFixed(5)}`
        );
    }

    console.log(`✅ ${rec.user_name} — ${typeLabel} в ${time}, в офисе: ${inOffice}`);
    res.json({ ok: true, in_office: inOffice });
});

// ═════════════════════════════════════════════════════════════════════════════
//  ВЕБХУК БОТА — сюда Битрикс24 шлёт все события
// ═════════════════════════════════════════════════════════════════════════════

app.post('/imbot', async (req, res) => {
    // Отвечаем сразу — Битрикс24 ждёт ответ не более 5 секунд
    res.json({ result: 'ok' });

    try {
        console.log('📨 /imbot RAW:', JSON.stringify(req.body));

        const body  = req.body;
        const event = body.event || body.EVENT;
        const data  = body.data  || body.DATA  || {};
        const auth  = body.auth  || body.AUTH  || {};

        if (!event) {
            console.log('⚠️ /imbot — нет поля event, пропускаем');
            return;
        }

        // Битрикс24 может слать данные как в PARAMS, так и напрямую в data
        const params = data.PARAMS || data.params || data;

        const MESSAGE      = params.MESSAGE      || params.message      || '';
        const DIALOG_ID    = params.DIALOG_ID    || params.dialog_id    || '';
        const BOT_ID       = params.BOT_ID       || params.bot_id       || '';
        const FROM_USER_ID = params.FROM_USER_ID || params.from_user_id || '';
        const USER_NAME    = params.USER_NAME    || params.user_name    || '';

        const domain   = auth.domain       || auth.DOMAIN       || BITRIX_DOMAIN;
        let authToken  = auth.access_token || auth.ACCESS_TOKEN || '';
        const userName = USER_NAME || `Пользователь ${FROM_USER_ID}`;
        const cleanMsg = MESSAGE.toLowerCase().trim();
        const geoUrl   = `https://${APP_DOMAIN}/geo`;

        console.log(`📨 event=${event} domain=${domain} user=${userName} msg="${MESSAGE}"`);

        // Всегда обновляем токен из входящего запроса — он самый свежий
        if (domain && authToken) {
            const existing = await getPortal(domain);
            await savePortal(domain, authToken, existing?.refresh_token,
                BOT_ID || existing?.bot_id, existing?.client_endpoint);
        }

        // Если токен не пришёл — берём из БД
        if (!authToken) {
            const portal = await getPortal(domain);
            if (portal) {
                authToken = portal.access_token;
                console.log('🔑 Используем токен из БД');
            } else {
                console.error('❌ Нет токена для домена:', domain);
                return;
            }
        }

        // Получаем актуальный bot_id
        const portal = await getPortal(domain);
        const botId  = BOT_ID || portal?.bot_id;

        if (!botId) {
            console.error('❌ Нет bot_id для домена:', domain);
            return;
        }

        // ── Приветствие при входе в чат ──────────────────────────────────────
        if (event === 'ONIMBOTJOINCHAT') {
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `👋 Привет, ${userName}!\n\n` +
                `Команды:\n` +
                `• "пришел" — отметить приход\n` +
                `• "ушел" — отметить уход\n` +
                `• "статус" — мои отметки сегодня\n` +
                `• "помощь" — справка`
            );
            return;
        }

        if (event !== 'ONIMBOTMESSAGEADD') {
            console.log(`ℹ️ Событие ${event} — игнорируем`);
            return;
        }

        // ── Обработка команд ─────────────────────────────────────────────────

        if (cleanMsg === 'пришел' || cleanMsg === 'пришёл') {
            const token = makeToken();
            await saveGeoToken(token, FROM_USER_ID, userName, DIALOG_ID, botId, domain, authToken, 'in');
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `📍 Нажми на ссылку — откроется страница геолокации.\n\n` +
                `👉 ${geoUrl}?token=${token}\n\n` +
                `_Ссылка действительна 10 минут_`
            );

        } else if (cleanMsg === 'ушел' || cleanMsg === 'ушёл') {
            const marks  = await getTodayMarks(FROM_USER_ID);
            const hasIn  = marks.some(m => m.type === 'in');
            const hasOut = marks.some(m => m.type === 'out');

            if (!hasIn) {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `⚠️ Нет отметки прихода сегодня.\nСначала напиши "пришел".`);
                return;
            }
            if (hasOut) {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `ℹ️ Уход уже отмечен сегодня.`);
                return;
            }
            const token = makeToken();
            await saveGeoToken(token, FROM_USER_ID, userName, DIALOG_ID, botId, domain, authToken, 'out');
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `📍 Нажми на ссылку чтобы подтвердить уход:\n\n` +
                `👉 ${geoUrl}?token=${token}\n\n` +
                `_Ссылка действительна 10 минут_`
            );

        } else if (cleanMsg === 'статус') {
            const marks = await getTodayMarks(FROM_USER_ID);
            if (marks.length === 0) {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `📊 Сегодня отметок нет.`);
            } else {
                const lines = marks.map(m => {
                    const t  = new Date(m.timestamp + 'Z').toLocaleTimeString('ru-RU',
                        { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Yekaterinburg' });
                    const tp  = m.type === 'in' ? '✅ Приход' : '🚪 Уход';
                    const loc = m.in_office ? '📍 В офисе' : '⚠️ Вне офиса';
                    return `${tp} в ${t} — ${loc}`;
                }).join('\n');
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `📊 Твои отметки сегодня:\n\n${lines}`);
            }

        } else if (cleanMsg === 'помощь') {
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `🤖 Бот учёта посещаемости\n\n` +
                `• "пришел" — отметить приход\n` +
                `• "ушел" — отметить уход\n` +
                `• "статус" — отметки за сегодня\n` +
                `• "помощь" — эта справка`
            );

        } else {
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `❓ Не понимаю "${MESSAGE}".\nНапиши "помощь".`);
        }

    } catch (err) {
        console.error('❌ /imbot error:', err.message, err.stack);
    }
});

// ═════════════════════════════════════════════════════════════════════════════
//  ВСПОМОГАТЕЛЬНЫЕ МАРШРУТЫ
// ═════════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
    res.send(`<h1>🤖 Бот учёта рабочего времени</h1>
    <p>Сервер работает</p>
    <ul>
        <li><a href="/status">Статус</a></li>
        <li><a href="/debug">Debug</a></li>
        <li><a href="/reinstall-bot">Переперегистрировать бота</a></li>
        <li><a href="/test-bot">Тест бота</a></li>
    </ul>`);
});

app.get('/status', async (req, res) => {
    const portals = await new Promise(r => {
        db.all(`SELECT domain, bot_id, updated_at FROM portals`, [], (e, rows) => r(rows || []));
    });
    res.json({
        ok: true, service: 'v6',
        portals,
        time: new Date().toISOString(),
        env: {
            app_domain:      APP_DOMAIN,
            office_location: `${OFFICE_LAT}, ${OFFICE_LON}`,
            office_radius:   OFFICE_RADIUS,
            manager_id:      MANAGER_ID,
        }
    });
});

app.get('/debug', async (req, res) => {
    const domain = req.query.domain || BITRIX_DOMAIN;
    const portal = await getPortal(domain);
    res.json({
        domain,
        portal_in_db: !!portal,
        portal_data:  portal ? {
            domain:        portal.domain,
            bot_id:        portal.bot_id,
            token_preview: portal.access_token ? portal.access_token.substring(0, 12) + '...' : null,
            updated_at:    portal.updated_at,
        } : null,
        app_domain: APP_DOMAIN,
        manager_id: MANAGER_ID,
    });
});

// ─── /reinstall-bot — удалить старого бота и зарегистрировать заново ─────────
// Вызывай этот endpoint после деплоя нового кода
app.get('/reinstall-bot', async (req, res) => {
    const domain = req.query.domain || BITRIX_DOMAIN;
    const portal = await getPortal(domain);
    if (!portal) return res.json({ ok: false, error: 'Портал не найден в БД. Нажми "Переустановить" в Битрикс24.' });

    const log = [];

    // Проверяем токен
    const profile = await callBitrix(domain, portal.access_token, 'profile', {});
    log.push({ profile: profile?.result ? '✅ токен валидный' : '❌ токен не работает' });

    if (!profile?.result) {
        // Пробуем обновить токен
        if (portal.refresh_token) {
            const newToken = await doRefreshToken(domain, portal.refresh_token);
            log.push({ refresh: newToken ? '✅ токен обновлён' : '❌ не удалось обновить' });
            if (!newToken) return res.json({ ok: false, log, error: 'Токен просрочен. Нажми "Переустановить" в Битрикс24.' });
        } else {
            return res.json({ ok: false, log, error: 'Нет refresh_token. Нажми "Переустановить" в Битрикс24.' });
        }
    }

    // Перечитываем портал после возможного обновления токена
    const freshPortal = await getPortal(domain);
    const token = freshPortal.access_token;

    const botId = await registerBot(domain, token, freshPortal.bot_id || null);
    if (botId) {
        await savePortal(domain, token, freshPortal.refresh_token, botId, freshPortal.client_endpoint);
        log.push({ bot_registered: `✅ ID=${botId}` });
    } else {
        log.push({ bot_registered: '❌ не удалось зарегистрировать' });
    }

    res.json({ ok: !!botId, log, bot_id: botId,
        message: botId
            ? `✅ Бот перерегистрирован (ID=${botId}). Найди бота в чатах и напиши "помощь".`
            : '❌ Не удалось зарегистрировать бота.' });
});

// ─── /test-bot ────────────────────────────────────────────────────────────────
app.get('/test-bot', async (req, res) => {
    const domain = req.query.domain || BITRIX_DOMAIN;
    const portal = await getPortal(domain);
    if (!portal) return res.json({ ok: false, error: 'Портал не найден в БД.' });

    const profile   = await callBitrix(domain, portal.access_token, 'profile', {});
    const notify    = await callBitrix(domain, portal.access_token, 'im.notify.system.add', {
        USER_ID: MANAGER_ID,
        MESSAGE: '🔧 Тест уведомлений — работает!',
    });
    const botsResp  = await callBitrix(domain, portal.access_token, 'imbot.bot.list', {});

    res.json({
        portal_found:  true,
        bot_id:        portal.bot_id,
        token_updated: portal.updated_at,
        profile_check: profile?.result ? `✅ ${profile.result.NAME} ${profile.result.LAST_NAME}` : '❌ невалидный',
        notify_result: notify?.result  ? '✅ отправлено' : '❌ ошибка',
        bots_in_b24:   botsResp?.result || 'нет данных',
    });
});


// ─── /check-handler ─────────────────────────────────────────────────────────────
app.get("/check-handler", async (req, res) => {
    const domain = req.query.domain || BITRIX_DOMAIN;
    const portal = await getPortal(domain);
    if (!portal) return res.json({ ok: false, error: "Портал не найден" });
    const botsFull = await callBitrix(domain, portal.access_token, "imbot.bot.list", { SHOW_SYSTEM: "Y" });
    const events   = await callBitrix(domain, portal.access_token, "event.get", {});
    res.json({ bot_id: portal.bot_id, bots_full: botsFull?.result || null, registered_events: events?.result || null });
});
// ─── Очистка старых гео-токенов каждые 15 минут ───────────────────────────────
cron.schedule('*/15 * * * *', () => {
    db.run(`DELETE FROM geo_tokens WHERE created_at < datetime('now', '-15 minutes')`);
    console.log('🧹 Очистка старых geo-токенов');
});

// ─── Запуск ───────────────────────────────────────────────────────────────────
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Сервер: https://${APP_DOMAIN}`);
    console.log(`📍 Офис: ${OFFICE_LAT}, ${OFFICE_LON} (${OFFICE_RADIUS}м)`);
    console.log(`🆔 Менеджер: ${MANAGER_ID}`);
    console.log('=== ✅ READY ===');
});
require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path    = require('path');
const cron    = require('node-cron');

const app  = express();
const port = process.env.PORT || 10000;

const APP_DOMAIN    = process.env.APP_DOMAIN            || 'bitrixbot-bnnd.onrender.com';
const BITRIX_DOMAIN = process.env.BITRIX_DOMAIN         || 'b24-etqwns.bitrix24.ru';
const CLIENT_ID     = process.env.BITRIX_CLIENT_ID      || '';
const CLIENT_SECRET = process.env.BITRIX_CLIENT_SECRET  || '';
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
        domain        TEXT PRIMARY KEY,
        access_token  TEXT NOT NULL,
        refresh_token TEXT,
        bot_id        TEXT,
        updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
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

function savePortal(domain, accessToken, refreshToken, botId) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT OR REPLACE INTO portals (domain, access_token, refresh_token, bot_id, updated_at)
             VALUES (?, ?, ?, ?, datetime('now'))`,
            [domain, accessToken, refreshToken || '', botId || ''],
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

async function callBitrix(domain, accessToken, method, params = {}) {
    try {
        const resp = await axios.post(
            `https://${domain}/rest/${method}`,
            params,
            { params: { auth: accessToken }, timeout: 10000 }
        );
        return resp.data;
    } catch (err) {
        console.error(`❌ Bitrix API [${method}]:`, err.response?.data || err.message);
        return null;
    }
}

async function sendMessage(domain, accessToken, botId, dialogId, message) {
    console.log(`📤 sendMessage → ${domain}, bot=${botId}, dialog=${dialogId}`);
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

// ─── ★ Подписка на события бота через event.bind ─────────────────────────────
// Для локальных приложений Битрикс24 события идут через event.bind,
// а не через EVENT_MESSAGE_ADD в imbot.register
async function bindBotEvents(domain, accessToken) {
    const handlerUrl = `https://${APP_DOMAIN}/imbot`;
    const events = ['ONIMBOTMESSAGEADD', 'ONIMBOTJOINCHAT', 'ONIMCOMMAND'];
    const results = {};

    for (const event of events) {
        const r = await callBitrix(domain, accessToken, 'event.bind', {
            EVENT:   event,
            HANDLER: handlerUrl,
        });
        results[event] = r?.result ? '✅' : ('❌ ' + JSON.stringify(r));
        console.log(`📎 event.bind ${event}:`, JSON.stringify(r));
    }
    return results;
}

// ═════════════════════════════════════════════════════════════════════════════
//  УСТАНОВКА — POST (Битрикс24 вызывает при установке/переустановке)
// ═════════════════════════════════════════════════════════════════════════════

app.post('/install', async (req, res) => {
    console.log('📥 POST /install body:', JSON.stringify(req.body));

    const { AUTH_ID, REFRESH_ID, DOMAIN } = req.body;
    const domain = DOMAIN || req.body.domain || req.query.DOMAIN || req.query.domain || '';

    if (AUTH_ID && domain) {
        console.log('🔑 Токен получен для домена:', domain);
        const existing = await getPortal(domain);
        await savePortal(domain, AUTH_ID, REFRESH_ID || '', existing?.bot_id || '');
        console.log('✅ Токен сохранён в БД');

        // ★ Ключевой шаг: подписываемся на события
        console.log('📎 Подписываемся на события бота...');
        const bindResults = await bindBotEvents(domain, AUTH_ID);
        console.log('📎 event.bind результаты:', JSON.stringify(bindResults));

        // Регистрируем бота если ещё не зарегистрирован
        if (!existing?.bot_id) {
            console.log('🤖 Регистрируем бота...');
            const botResp = await callBitrix(domain, AUTH_ID, 'imbot.register', {
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
            });
            const botId = String(botResp?.result || '');
            if (botId) {
                await savePortal(domain, AUTH_ID, REFRESH_ID || '', botId);
                console.log('✅ Бот зарегистрирован, ID:', botId);
            } else {
                console.error('❌ Не удалось зарегистрировать бота:', JSON.stringify(botResp));
            }
        }
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
        return res.json({ ok:false, error:'Неверные данные' });

    const rec = await popGeoToken(token);
    if (!rec)
        return res.json({ ok:false, error:'Ссылка устарела или уже использована. Запроси новую в боте.' });

    const inOffice  = getDistance(lat, lon, OFFICE_LAT, OFFICE_LON) <= OFFICE_RADIUS;
    const typeLabel = rec.type === 'in' ? 'Приход' : 'Уход';
    const emoji     = rec.type === 'in' ? '✅' : '🚪';
    const time      = new Date().toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' });

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
    res.json({ ok:true, in_office:inOffice });
});

// ═════════════════════════════════════════════════════════════════════════════
//  ВЕБХУК БОТА — сюда приходят все события от Битрикс24
// ═════════════════════════════════════════════════════════════════════════════

app.post('/imbot', async (req, res) => {
    console.log('📨 /imbot BODY:', JSON.stringify(req.body));
    res.json({ result: 'ok' });

    try {
        const body = req.body;

        // Битрикс24 шлёт поля в разных регистрах — обрабатываем оба варианта
        const event  = body.event || body.EVENT;
        const data   = body.data  || body.DATA;
        const auth   = body.auth  || body.AUTH;

        if (!event) {
            console.log('⚠️ /imbot — нет поля event');
            return;
        }

        console.log('📨 event:', event);

        const params       = data?.PARAMS   || data?.params   || {};
        const MESSAGE      = params.MESSAGE      || params.message      || '';
        const DIALOG_ID    = params.DIALOG_ID    || params.dialog_id    || '';
        const BOT_ID       = params.BOT_ID       || params.bot_id       || '';
        const FROM_USER_ID = params.FROM_USER_ID || params.from_user_id || '';
        const USER_NAME    = params.USER_NAME    || params.user_name    || '';

        const domain    = auth?.domain       || auth?.DOMAIN       || BITRIX_DOMAIN;
        let authToken   = auth?.access_token || auth?.ACCESS_TOKEN || '';
        const userName  = USER_NAME || `Пользователь ${FROM_USER_ID}`;
        const cleanMsg  = MESSAGE.toLowerCase().trim();
        const geoUrl    = `https://${APP_DOMAIN}/geo`;

        console.log(`💬 [${domain}] ${userName}: "${MESSAGE}" (${event})`);

        // Обновляем токен в БД
        if (domain && authToken) {
            const existing = await getPortal(domain);
            await savePortal(domain, authToken, existing?.refresh_token, BOT_ID || existing?.bot_id);
        }

        // Берём токен из БД если не пришёл
        if (!authToken) {
            const portal = await getPortal(domain);
            if (portal) {
                authToken = portal.access_token;
                console.log('🔑 Используем токен из БД');
            } else {
                console.error('❌ Нет токена для домена', domain);
                return;
            }
        }

        const botId = BOT_ID || (await getPortal(domain))?.bot_id;

        // Приветствие
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

        if (event !== 'ONIMBOTMESSAGEADD') return;

        // пришел
        if (cleanMsg === 'пришел' || cleanMsg === 'пришёл') {
            const token = makeToken();
            await saveGeoToken(token, FROM_USER_ID, userName, DIALOG_ID, botId, domain, authToken, 'in');
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `📍 Нажми на ссылку — откроется страница геолокации.\n\n` +
                `👉 ${geoUrl}?token=${token}\n\n` +
                `_Ссылка действительна 10 минут_`
            );

        // ушел
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

        // статус
        } else if (cleanMsg === 'статус') {
            const marks = await getTodayMarks(FROM_USER_ID);
            if (marks.length === 0) {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `📊 Сегодня отметок нет.`);
            } else {
                const lines = marks.map(m => {
                    const t   = new Date(m.timestamp + 'Z').toLocaleTimeString('ru-RU',
                        { hour:'2-digit', minute:'2-digit', timeZone:'Asia/Yekaterinburg' });
                    const tp  = m.type === 'in' ? '✅ Приход' : '🚪 Уход';
                    const loc = m.in_office ? '📍 В офисе' : '⚠️ Вне офиса';
                    return `${tp} в ${t} — ${loc}`;
                }).join('\n');
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `📊 Твои отметки сегодня:\n\n${lines}`);
            }

        // помощь
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
        console.error('❌ imbot error:', err.message, err.stack);
    }
});

// ═════════════════════════════════════════════════════════════════════════════
//  РАСПИСАНИЕ
// ═════════════════════════════════════════════════════════════════════════════

cron.schedule('*/15 * * * *', () => {
    db.run(`DELETE FROM geo_tokens WHERE created_at < datetime('now', '-15 minutes')`);
});

// ═════════════════════════════════════════════════════════════════════════════
//  ВСПОМОГАТЕЛЬНЫЕ МАРШРУТЫ
// ═════════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
    res.send(`<h1>🤖 Бот учёта рабочего времени</h1><a href="/install">Установить</a>`);
});

app.get('/status', async (req, res) => {
    const portalsInDb = await new Promise(r => {
        db.all(`SELECT domain, bot_id, updated_at FROM portals`, [], (e, rows) => r(rows || []));
    });
    res.json({ ok: true, service: 'v4', portals: portalsInDb, time: new Date().toISOString() });
});

// ─── /bind-events — подписать события вручную ────────────────────────────────
app.get('/bind-events', async (req, res) => {
    const domain = BITRIX_DOMAIN || 'b24-etqwns.bitrix24.ru';
    const portal = await getPortal(domain);
    if (!portal) return res.json({ ok: false, error: 'Портал не найден. Переустанови приложение.' });

    const results = await bindBotEvents(domain, portal.access_token);
    res.json({ ok: true, results, handler: `https://${APP_DOMAIN}/imbot` });
});

// ─── /reinstall-bot ───────────────────────────────────────────────────────────
app.get('/reinstall-bot', async (req, res) => {
    const log = [];
    const domain = BITRIX_DOMAIN || 'b24-etqwns.bitrix24.ru';
    const portal = await getPortal(domain);
    if (!portal) return res.json({ ok: false, error: 'Портал не найден в БД.' });

    const token = portal.access_token;

    const del = await callBitrix(domain, token, 'imbot.unregister', { BOT_ID: portal.bot_id });
    log.push('🗑 Удаление: ' + JSON.stringify(del));

    await new Promise(r => setTimeout(r, 1000));

    const reg = await callBitrix(domain, token, 'imbot.register', {
        CODE:                  'attendance_bot',
        TYPE:                  'H',
        EVENT_MESSAGE_ADD:     `https://${APP_DOMAIN}/imbot`,
        EVENT_WELCOME_MESSAGE: `https://${APP_DOMAIN}/imbot`,
        EVENT_BOT_DELETE:      `https://${APP_DOMAIN}/imbot`,
        PROPERTIES: {
            NAME: 'Учёт времени', COLOR: 'GREEN',
            DESCRIPTION: 'Бот учёта присутствия', WORK_POSITION: 'Помощник HR',
        }
    });
    const newBotId = String(reg?.result || '');
    log.push('✅ Регистрация: ' + JSON.stringify(reg));

    if (newBotId) {
        await savePortal(domain, token, portal.refresh_token, newBotId);
        log.push('✅ bot_id: ' + newBotId);
    }

    const bindResults = await bindBotEvents(domain, token);
    log.push('📎 event.bind: ' + JSON.stringify(bindResults));

    res.json({ ok: !!newBotId, log, new_bot_id: newBotId });
});

// ─── /fix-bot ─────────────────────────────────────────────────────────────────
app.get('/fix-bot', async (req, res) => {
    const domain = BITRIX_DOMAIN || 'b24-etqwns.bitrix24.ru';
    const portal = await getPortal(domain);
    if (!portal) return res.json({ ok: false, error: 'Портал не найден в БД' });

    const botsResp = await callBitrix(domain, portal.access_token, 'imbot.bot.list', {});
    const botsArr  = Object.values(botsResp?.result || {});

    let botId = '';
    if (botsArr.length > 0) {
        const ourBot = botsArr.find(b => b.CODE === 'attendance_bot') || botsArr[0];
        botId = String(ourBot.ID);
        await savePortal(domain, portal.access_token, portal.refresh_token, botId);
    }

    const bindResults = await bindBotEvents(domain, portal.access_token);

    res.json({
        ok: true, bots_found: botsArr, bot_id_saved: botId,
        bind_results: bindResults, handler: `https://${APP_DOMAIN}/imbot`,
        message: botId ? '✅ Готово — напиши боту "помощь"' : '❌ Боты не найдены'
    });
});

// ─── /test-bot ────────────────────────────────────────────────────────────────
app.get('/test-bot', async (req, res) => {
    const domain = BITRIX_DOMAIN || 'b24-etqwns.bitrix24.ru';
    const portal = await getPortal(domain);
    if (!portal) return res.json({ ok: false, error: 'Портал не найден в БД.' });

    const me = await callBitrix(domain, portal.access_token, 'profile', {});
    const notify = await callBitrix(domain, portal.access_token, 'im.notify.system.add', {
        USER_ID: MANAGER_ID, MESSAGE: '🔧 Тест: уведомления работают!'
    });
    res.json({
        portal_found:  true,
        bot_id:        portal.bot_id,
        token_updated: portal.updated_at,
        profile_check: me?.result ? '✅ Токен валидный' : '❌ Токен недействителен',
        notify_result: notify?.result ? '✅ Уведомление отправлено' : '❌ Ошибка',
        profile_name:  me?.result ? `${me.result.NAME} ${me.result.LAST_NAME}` : null,
    });
});

// ─── Запуск ───────────────────────────────────────────────────────────────────
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Сервер: https://${APP_DOMAIN}`);
    console.log(`📍 Офис: ${OFFICE_LAT}, ${OFFICE_LON} (${OFFICE_RADIUS}м)`);
    console.log('=== ✅ READY ===');
});
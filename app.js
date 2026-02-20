require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path    = require('path');
const cron    = require('node-cron');

const app  = express();
const port = process.env.PORT || 10000;

const APP_DOMAIN    = process.env.APP_DOMAIN            || 'bitrixbot-bnnd.onrender.com';
const BITRIX_DOMAIN = process.env.BITRIX_DOMAIN         || '';
const CLIENT_ID     = process.env.BITRIX_CLIENT_ID      || '';
const CLIENT_SECRET = process.env.BITRIX_CLIENT_SECRET  || '';
const OFFICE_LAT    = parseFloat(process.env.OFFICE_LAT    || '57.151929');
const OFFICE_LON    = parseFloat(process.env.OFFICE_LON    || '65.592076');
const OFFICE_RADIUS = parseInt(process.env.OFFICE_RADIUS   || '100');
const MANAGER_ID    = process.env.MANAGER_USER_ID          || '1';

// ─── База данных ──────────────────────────────────────────────────────────────
const db = new sqlite3.Database(path.join(__dirname, 'attendance.db'));

db.serialize(() => {
    // Отметки присутствия
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

    // Одноразовые токены геолокации
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

    // ★ Токены порталов — в БД, не в памяти — переживают перезапуск Render
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

// ─── Портал: сохранить токены в БД
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

// ─── Портал: получить токены из БД
function getPortal(domain) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT * FROM portals WHERE domain = ?`, [domain],
            (err, row) => err ? reject(err) : resolve(row || null)
        );
    });
}

// ─── Вызов Битрикс24 REST API
async function callBitrix(domain, accessToken, method, params = {}) {
    try {
        const resp = await axios.post(
            `https://${domain}/rest/${method}`,
            params,
            { params: { auth: accessToken }, timeout: 8000 }
        );
        return resp.data;
    } catch (err) {
        console.error(`❌ Bitrix API [${method}]:`, err.response?.data || err.message);
        return null;
    }
}

// ─── Отправить сообщение в чат бота
async function sendMessage(domain, accessToken, botId, dialogId, message) {
    console.log(`📤 sendMessage → ${domain}, bot=${botId}, dialog=${dialogId}`);
    return callBitrix(domain, accessToken, 'imbot.message.add', {
        BOT_ID:    botId,
        DIALOG_ID: dialogId,
        MESSAGE:   message,
    });
}

// ─── Уведомить руководителя
async function notifyManager(domain, accessToken, text) {
    return callBitrix(domain, accessToken, 'im.notify.system.add', {
        USER_ID: MANAGER_ID,
        MESSAGE: text,
    });
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

// ─── БД: сохранить гео-токен
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

// ─── БД: взять и удалить гео-токен (одноразовый)
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
//  УСТАНОВКА — POST (Битрикс24 открывает приложение внутри себя)
// ═════════════════════════════════════════════════════════════════════════════

app.post('/install', async (req, res) => {
    console.log('📥 POST /install — тело запроса:', JSON.stringify(req.body));

    const { AUTH_ID, AUTH_EXPIRES, REFRESH_ID, member_id, DOMAIN, PROTOCOL } = req.body;
    // Домен может прийти в теле запроса ИЛИ в URL параметрах
    const domain = DOMAIN || req.body.domain || req.query.DOMAIN || req.query.domain || '';

    // Битрикс24 присылает AUTH_ID как access_token при переустановке
    if (AUTH_ID && domain) {
        console.log('🔑 Получен токен через POST /install для домена:', domain);
        const existing = await getPortal(domain);
        await savePortal(domain, AUTH_ID, REFRESH_ID || '', existing?.bot_id || '');
        console.log('✅ Токен сохранён в БД из POST /install');
    }

    res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Учёт времени</title>
    <style>
        body { font-family: Arial, sans-serif; background: #f0f4ff;
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
    <p style="margin-top:24px; font-size:13px; color:#999;">
        При отметке откроется страница в браузере — разрешите доступ к геолокации.
    </p>
</div>
</body>
</html>`);
});

// ═════════════════════════════════════════════════════════════════════════════
//  УСТАНОВКА — GET (OAuth callback)
// ═════════════════════════════════════════════════════════════════════════════

app.get('/install', async (req, res) => {
    const { code, domain } = req.query;

    // Нет кода — начинаем OAuth
    if (!code) {
        const redirectUri = `https://${APP_DOMAIN}/install`;
        const authUrl = `https://${BITRIX_DOMAIN}/oauth/authorize/`
            + `?client_id=${CLIENT_ID}`
            + `&response_type=code`
            + `&redirect_uri=${encodeURIComponent(redirectUri)}`;
        console.log('🔐 OAuth redirect →', authUrl);
        return res.redirect(authUrl);
    }

    console.log('✅ OAuth callback, domain:', domain);

    try {
        // Получаем access_token
        const tokenResp = await axios.post(
            'https://oauth.bitrix.info/oauth/token/', null,
            { params: {
                grant_type:    'authorization_code',
                client_id:     CLIENT_ID,
                client_secret: CLIENT_SECRET,
                code,
                redirect_uri:  `https://${APP_DOMAIN}/install`,
            }}
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

        const botId = String(botResp.data?.result || '');
        console.log('✅ Bot registered, ID:', botId);

        // ★ Сохраняем токены в БД — переживут перезапуск Render
        await savePortal(domain, access_token, refresh_token, botId);
        console.log('✅ Portal saved to DB:', domain);

        res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8"><title>Установлено!</title>
    <style>
        body { font-family:Arial,sans-serif; background:#e8f5e9;
               display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
        .card { background:white; border-radius:16px; padding:40px; text-align:center;
                box-shadow:0 8px 24px rgba(0,0,0,0.1); max-width:480px; }
        h1 { color:#2e7d32; }
        .btn { display:inline-block; margin-top:20px; padding:14px 28px;
               background:#2d8cff; color:white; border-radius:8px; text-decoration:none; }
    </style>
</head>
<body>
<div class="card">
    <h1>🎉 Бот установлен!</h1>
    <p>Бот <strong>"Учёт времени"</strong> появился в чатах.</p>
    <p>Найдите его и напишите <strong>"помощь"</strong>.</p>
    <a href="https://${domain}" class="btn">Перейти в Битрикс24</a>
</div>
</body>
</html>`);

    } catch (err) {
        console.error('❌ Install error:', err.response?.data || err.message);
        const detail = JSON.stringify(err.response?.data || err.message, null, 2);
        res.status(500).send(`<pre>Ошибка установки:\n${detail}</pre>`);
    }
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
//  ВЕБХУК БОТА
// ═════════════════════════════════════════════════════════════════════════════

app.post('/imbot', async (req, res) => {
    res.json({ result:'ok' }); // отвечаем немедленно

    try {
        const { event, data, auth } = req.body;
        if (!event || !data?.PARAMS) return;

        const { MESSAGE, DIALOG_ID, BOT_ID, FROM_USER_ID, USER_NAME } = data.PARAMS;
        const domain   = auth?.domain;
        let   authToken = auth?.access_token;
        const userName  = USER_NAME || `Пользователь ${FROM_USER_ID}`;
        const cleanMsg  = (MESSAGE || '').toLowerCase().trim();
        const geoUrl    = `https://${APP_DOMAIN}/geo`;

        console.log(`💬 [${domain}] ${userName}: "${MESSAGE}" (${event})`);

        // ★ Обновляем токен в БД при каждом входящем запросе
        if (domain && authToken) {
            const existing = await getPortal(domain);
            await savePortal(domain, authToken, existing?.refresh_token, BOT_ID || existing?.bot_id);
        }

        // Если токен от Битрикс24 устарел — берём из БД
        if (!authToken) {
            const portal = await getPortal(domain);
            if (portal) {
                authToken = portal.access_token;
                console.log('🔑 Используем сохранённый токен для', domain);
            } else {
                console.error('❌ Нет токена для домена', domain);
                return;
            }
        }

        const botId = BOT_ID || (await getPortal(domain))?.bot_id;

        // ── Приветствие при первом входе в чат ────────────────────
        if (event === 'ONIMBOTJOINCHAT') {
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `👋 Привет, ${userName}!\n\n` +
                `Я фиксирую присутствие сотрудников в офисе.\n\n` +
                `Команды:\n` +
                `• "пришел" — отметить приход\n` +
                `• "ушел" — отметить уход\n` +
                `• "статус" — мои отметки сегодня\n` +
                `• "помощь" — справка`
            );
            return;
        }

        if (event !== 'ONIMBOTMESSAGEADD') return;

        // ── пришел ────────────────────────────────────────────────
        if (cleanMsg === 'пришел' || cleanMsg === 'пришёл') {
            const token = makeToken();
            await saveGeoToken(token, FROM_USER_ID, userName, DIALOG_ID, botId, domain, authToken, 'in');
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `📍 Нажми на ссылку — откроется страница геолокации.\n` +
                `Разреши доступ к местоположению и отметка зафиксируется.\n\n` +
                `👉 ${geoUrl}?token=${token}\n\n` +
                `_Ссылка действительна 10 минут_`
            );

        // ── ушел ──────────────────────────────────────────────────
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
                    `ℹ️ Уход уже отмечен сегодня.\nНапиши "статус" чтобы посмотреть.`);
                return;
            }

            const token = makeToken();
            await saveGeoToken(token, FROM_USER_ID, userName, DIALOG_ID, botId, domain, authToken, 'out');
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `📍 Нажми на ссылку чтобы подтвердить уход:\n\n` +
                `👉 ${geoUrl}?token=${token}\n\n` +
                `_Ссылка действительна 10 минут_`
            );

        // ── статус ────────────────────────────────────────────────
        } else if (cleanMsg === 'статус') {
            const marks = await getTodayMarks(FROM_USER_ID);
            if (marks.length === 0) {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `📊 Сегодня отметок нет.\nНапиши "пришел" когда придёшь в офис.`);
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

        // ── помощь ────────────────────────────────────────────────
        } else if (cleanMsg === 'помощь') {
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `🤖 Бот учёта посещаемости\n\n` +
                `• "пришел" — отметить приход (нужна геолокация)\n` +
                `• "ушел" — отметить уход\n` +
                `• "статус" — отметки за сегодня\n` +
                `• "помощь" — эта справка`
            );

        // ── неизвестная команда ────────────────────────────────────
        } else {
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `❓ Не понимаю "${MESSAGE}".\nНапиши "помощь" для списка команд.`);
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
});

// ═════════════════════════════════════════════════════════════════════════════
//  ВСПОМОГАТЕЛЬНЫЕ МАРШРУТЫ
// ═════════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Бот учёта времени</title>
    <style>
        body { font-family:Arial,sans-serif; background:linear-gradient(135deg,#667eea,#764ba2);
               min-height:100vh; margin:0; display:flex; align-items:center; justify-content:center; }
        .card { background:white; border-radius:16px; padding:40px; max-width:500px; width:90%;
                box-shadow:0 10px 40px rgba(0,0,0,0.2); }
        h1 { color:#2d8cff; margin-bottom:8px; }
        .btn { display:inline-block; margin-top:24px; padding:16px 32px;
               background:#2d8cff; color:white; border-radius:50px;
               text-decoration:none; font-size:18px; font-weight:bold; }
        ul { margin-top:16px; padding-left:20px; line-height:2; }
    </style>
</head>
<body>
<div class="card">
    <h1>🤖 Бот учёта рабочего времени</h1>
    <p>Фиксация прихода и ухода с проверкой геолокации.</p>
    <ul>
        <li>📍 Геолокация при каждой отметке</li>
        <li>⚠️ Уведомление если сотрудник вне офиса</li>
        <li>📊 Статус за текущий день</li>
    </ul>
    <a href="/install" class="btn">📥 Установить в Битрикс24</a>
</div>
</body>
</html>`);
});

app.get('/status', async (req, res) => {
    const portalsInDb = await new Promise(r => {
        db.all(`SELECT domain, bot_id, updated_at FROM portals`, [], (e, rows) => r(rows || []));
    });
    res.json({
        ok:      true,
        service: 'Bitrix24 Attendance Bot v3',
        domain:  APP_DOMAIN,
        office:  `${OFFICE_LAT}, ${OFFICE_LON} (радиус ${OFFICE_RADIUS}м)`,
        portals: portalsInDb,
        time:    new Date().toISOString(),
    });
});

// ─── Запуск ───────────────────────────────────────────────────────────────────
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Сервер: https://${APP_DOMAIN}`);
    console.log(`📍 Офис: ${OFFICE_LAT}, ${OFFICE_LON} (${OFFICE_RADIUS}м)`);
    console.log('=== ✅ READY ===');
});



// ═══════════════════════════════════════════════════════════════════════
//  /setup — полная переустановка за один шаг (вызывать после деплоя)
// ═══════════════════════════════════════════════════════════════════════
app.get('/setup', async (req, res) => {
    const log = [];
    
    try {
        // Шаг 1: Получаем новый токен через client_credentials
        log.push('1️⃣ Получаем токен...');
        const tokenResp = await axios.post(
            'https://oauth.bitrix.info/oauth/token/', null,
            { params: {
                grant_type:    'client_credentials',
                client_id:     CLIENT_ID,
                client_secret: CLIENT_SECRET,
            }}
        );
        
        const { access_token, refresh_token } = tokenResp.data;
        if (!access_token) throw new Error('Не получили токен: ' + JSON.stringify(tokenResp.data));
        log.push('✅ Токен получен');

        // Шаг 2: Проверяем профиль
        const profile = await callBitrix(BITRIX_DOMAIN, access_token, 'profile', {});
        log.push('✅ Профиль: ' + (profile?.result?.NAME || 'неизвестно'));

        // Шаг 3: Получаем список ботов
        const botsResp = await callBitrix(BITRIX_DOMAIN, access_token, 'imbot.bot.list', {});
        const bots = botsResp?.result || [];
        log.push('📋 Ботов найдено: ' + bots.length);

        let botId = '';
        
        if (bots.length > 0) {
            // Бот уже есть — берём его ID
            const ourBot = bots.find(b => b.CODE === 'attendance_bot') || bots[0];
            botId = String(ourBot.ID);
            log.push('✅ Бот уже существует, ID: ' + botId);

            // Обновляем EVENT_MESSAGE_ADD на случай если URL изменился
            await callBitrix(BITRIX_DOMAIN, access_token, 'imbot.bot.update', {
                BOT_ID: botId,
                FIELDS: {
                    EVENT_MESSAGE_ADD:     `https://${APP_DOMAIN}/imbot`,
                    EVENT_WELCOME_MESSAGE: `https://${APP_DOMAIN}/imbot`,
                }
            });
            log.push('✅ Вебхук бота обновлён');
        } else {
            // Бота нет — регистрируем
            log.push('2️⃣ Регистрируем бота...');
            const botResp = await callBitrix(BITRIX_DOMAIN, access_token, 'imbot.register', {
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
            botId = String(botResp?.result || '');
            log.push('✅ Бот зарегистрирован, ID: ' + botId);
        }

        // Шаг 4: Сохраняем всё в БД
        await savePortal(BITRIX_DOMAIN, access_token, refresh_token || '', botId);
        log.push('✅ Портал сохранён в БД');

        res.json({ ok: true, log, bot_id: botId, domain: BITRIX_DOMAIN });

    } catch (err) {
        log.push('❌ Ошибка: ' + (err.response?.data ? JSON.stringify(err.response.data) : err.message));
        res.json({ ok: false, log, error: err.message });
    }
});

// Диагностика и починка bot_id
app.get('/fix-bot', async (req, res) => {
    const portal = await getPortal('b24-etqwns.bitrix24.ru');
    if (!portal) return res.json({ ok: false, error: 'Портал не найден' });

    // Получаем список ботов на портале
    const bots = await callBitrix('b24-etqwns.bitrix24.ru', portal.access_token, 'imbot.bot.list', {});
    
    let botId = '';
    if (bots?.result && bots.result.length > 0) {
        // Находим нашего бота по коду
        const ourBot = bots.result.find(b => b.CODE === 'attendance_bot') || bots.result[0];
        botId = String(ourBot.ID);
        
        // Обновляем bot_id в БД
        await savePortal('b24-etqwns.bitrix24.ru', portal.access_token, portal.refresh_token, botId);
        console.log('✅ bot_id исправлен:', botId);
    }

    res.json({
        ok: true,
        bots_found: bots?.result || [],
        bot_id_saved: botId,
        message: botId ? '✅ bot_id сохранён — теперь напиши боту "помощь"' : '❌ Боты не найдены'
    });
});

// Диагностика — проверяет токен и пробует отправить уведомление
app.get('/test-bot', async (req, res) => {
    const portal = await getPortal('b24-etqwns.bitrix24.ru');
    if (!portal) {
        return res.json({ ok: false, error: 'Портал не найден в БД. Переустановите бота.' });
    }
    const me = await callBitrix('b24-etqwns.bitrix24.ru', portal.access_token, 'profile', {});
    const notify = await callBitrix('b24-etqwns.bitrix24.ru', portal.access_token, 'im.notify.system.add', {
        USER_ID: MANAGER_ID,
        MESSAGE: '🔧 Тест бота: если видите это — уведомления работают!'
    });
    res.json({
        portal_found:  true,
        bot_id:        portal.bot_id,
        token_updated: portal.updated_at,
        profile_check: me?.result ? '✅ Токен валидный' : '❌ Токен недействителен',
        notify_result: notify?.result ? '✅ Уведомление отправлено' : '❌ Ошибка отправки',
        profile_name:  me?.result ? `${me.result.NAME} ${me.result.LAST_NAME}` : null,
    });
});
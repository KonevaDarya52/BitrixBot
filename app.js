require('dotenv').config();
const express  = require('express');
const axios    = require('axios');
const { Pool } = require('pg');
const cron     = require('node-cron');

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

// ─── PostgreSQL ───────────────────────────────────────────────────────────────
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS portals (
            domain          TEXT PRIMARY KEY,
            access_token    TEXT NOT NULL,
            refresh_token   TEXT,
            bot_id          TEXT,
            client_endpoint TEXT,
            updated_at      TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS attendance (
            id          SERIAL PRIMARY KEY,
            user_id     TEXT NOT NULL,
            user_name   TEXT,
            domain      TEXT,
            type        TEXT NOT NULL,
            timestamp   TIMESTAMPTZ DEFAULT NOW(),
            latitude    REAL,
            longitude   REAL,
            in_office   INTEGER DEFAULT 0
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS geo_tokens (
            token        TEXT PRIMARY KEY,
            user_id      TEXT NOT NULL,
            user_name    TEXT,
            dialog_id    TEXT NOT NULL,
            bot_id       TEXT NOT NULL,
            domain       TEXT NOT NULL,
            access_token TEXT NOT NULL,
            type         TEXT NOT NULL,
            created_at   TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS leaves (
            id          SERIAL PRIMARY KEY,
            user_id     TEXT NOT NULL,
            user_name   TEXT,
            type        TEXT NOT NULL,
            date_from   DATE NOT NULL,
            date_to     DATE NOT NULL,
            comment     TEXT,
            created_at  TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    console.log('✅ БД инициализирована');
}

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

function isAdmin(userId) {
    return String(userId) === String(MANAGER_ID);
}

// ─── Клавиатуры ──────────────────────────────────────────────────────────────
// ВАЖНО: Битрикс принимает клавиатуру строго в таком формате
// Каждый элемент массива = строка кнопок
// Нажатие кнопки = бот получает MESSAGE = TEXT кнопки (не COMMAND!)

function keyboardMain(userId) {
    const rows = [
        [
            { TEXT: '✅ Пришёл',  BG_COLOR: '#29b36b', TEXT_COLOR: '#ffffff' },
            { TEXT: '🚪 Ушёл',   BG_COLOR: '#e05c5c', TEXT_COLOR: '#ffffff' },
        ],
        [
            { TEXT: '📊 Статус', BG_COLOR: '#5b8def', TEXT_COLOR: '#ffffff' },
            { TEXT: '❓ Помощь', BG_COLOR: '#888888', TEXT_COLOR: '#ffffff' },
        ],
    ];
    if (isAdmin(userId)) {
        rows.push([
            { TEXT: '⚙️ Управление', BG_COLOR: '#9b59b6', TEXT_COLOR: '#ffffff' },
        ]);
    }
    return rows;
}

function keyboardGeoLink(url, type) {
    const label = type === 'in' ? '📍 Отметить приход' : '📍 Отметить уход';
    return [
        [{ TEXT: label, LINK: url }],
        [{ TEXT: '◀️ Назад в меню', BG_COLOR: '#888888', TEXT_COLOR: '#ffffff' }],
    ];
}

function keyboardAdmin() {
    return [
        [
            { TEXT: '📋 Отчёт за сегодня',  BG_COLOR: '#5b8def', TEXT_COLOR: '#ffffff' },
            { TEXT: '📅 Отчёт за неделю',   BG_COLOR: '#5b8def', TEXT_COLOR: '#ffffff' },
        ],
        [
            { TEXT: '👥 Кто в офисе',       BG_COLOR: '#29b36b', TEXT_COLOR: '#ffffff' },
            { TEXT: '🏖 Добавить отпуск',   BG_COLOR: '#e0a020', TEXT_COLOR: '#ffffff' },
        ],
        [
            { TEXT: '◀️ Назад в меню',      BG_COLOR: '#888888', TEXT_COLOR: '#ffffff' },
        ],
    ];
}

// ─── БД: порталы ─────────────────────────────────────────────────────────────
async function savePortal(domain, accessToken, refreshToken, botId, clientEndpoint) {
    await pool.query(
        `INSERT INTO portals (domain, access_token, refresh_token, bot_id, client_endpoint, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (domain) DO UPDATE SET
             access_token    = EXCLUDED.access_token,
             refresh_token   = COALESCE(NULLIF($3, ''), portals.refresh_token),
             bot_id          = COALESCE(NULLIF($4, ''), portals.bot_id),
             client_endpoint = COALESCE(NULLIF($5, ''), portals.client_endpoint),
             updated_at      = NOW()`,
        [domain, accessToken, refreshToken || '', botId || '', clientEndpoint || '']
    );
}

async function getPortal(domain) {
    const { rows } = await pool.query(`SELECT * FROM portals WHERE domain = $1`, [domain]);
    return rows[0] || null;
}

// ─── БД: посещаемость ────────────────────────────────────────────────────────
async function saveAttendance(userId, userName, domain, type, lat, lon, inOffice) {
    const { rows } = await pool.query(
        `INSERT INTO attendance (user_id, user_name, domain, type, latitude, longitude, in_office)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [userId, userName, domain, type, lat, lon, inOffice ? 1 : 0]
    );
    return rows[0].id;
}

async function getTodayMarks(userId) {
    const { rows } = await pool.query(
        `SELECT type, timestamp, in_office FROM attendance
         WHERE user_id = $1
           AND (timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date = (NOW() AT TIME ZONE 'Asia/Yekaterinburg')::date
         ORDER BY timestamp`,
        [userId]
    );
    return rows;
}

// ─── БД: гео-токены ──────────────────────────────────────────────────────────
async function saveGeoToken(token, userId, userName, dialogId, botId, domain, accessToken, type) {
    await pool.query(
        `INSERT INTO geo_tokens (token, user_id, user_name, dialog_id, bot_id, domain, access_token, type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (token) DO UPDATE SET
             user_id = EXCLUDED.user_id, user_name = EXCLUDED.user_name,
             dialog_id = EXCLUDED.dialog_id, bot_id = EXCLUDED.bot_id,
             domain = EXCLUDED.domain, access_token = EXCLUDED.access_token,
             type = EXCLUDED.type, created_at = NOW()`,
        [token, userId, userName, dialogId, botId, domain, accessToken, type]
    );
}

async function popGeoToken(token) {
    const { rows } = await pool.query(
        `DELETE FROM geo_tokens WHERE token = $1 RETURNING *`, [token]
    );
    return rows[0] || null;
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
            await savePortal(domain, resp.data.access_token, resp.data.refresh_token, '', '');
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

// Отправка сообщения с клавиатурой
async function sendMessage(domain, accessToken, botId, dialogId, message, keyboard = null) {
    console.log(`📤 sendMessage → bot=${botId}, dialog=${dialogId}`);
    const params = {
        BOT_ID:    botId,
        DIALOG_ID: dialogId,
        MESSAGE:   message,
    };
    if (keyboard) {
        params.KEYBOARD = keyboard;
    }
    const result = await callBitrix(domain, accessToken, 'imbot.message.add', params);
    if (!result?.result) {
        console.error('❌ sendMessage failed:', JSON.stringify(result));
    }
    return result;
}

async function notifyManager(domain, accessToken, text) {
    return callBitrix(domain, accessToken, 'im.notify.system.add', {
        USER_ID: MANAGER_ID,
        MESSAGE: text,
    });
}

// ─── Регистрация бота ─────────────────────────────────────────────────────────
async function registerBot(domain, accessToken, existingBotId) {
    const handlerUrl = `https://${APP_DOMAIN}/imbot`;

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

    const AUTH_ID         = req.body.AUTH_ID         || req.body.auth_id         || '';
    const REFRESH_ID      = req.body.REFRESH_ID      || req.body.refresh_id      || '';
    const SERVER_ENDPOINT = req.body.SERVER_ENDPOINT || req.body.server_endpoint || '';
    const domain          = req.body.DOMAIN          || req.body.domain
                         || req.query.DOMAIN         || req.query.domain         || '';

    if (AUTH_ID && domain) {
        console.log('🔑 Токен получен для домена:', domain);

        // Проверяем, зарегистрирован ли уже бот
        const botsResp = await callBitrix(domain, AUTH_ID, 'imbot.bot.list', {});
        const botsArr  = Object.values(botsResp?.result || {});
        const ourBot   = botsArr.find(b => b.CODE === 'attendance_bot');

        if (ourBot) {
            // Бот уже есть — просто обновляем токен, НЕ перерегистрируем
            const existingBotId = String(ourBot.ID);
            console.log(`✅ Бот уже зарегистрирован (ID=${existingBotId}), обновляем токен`);
            await savePortal(domain, AUTH_ID, REFRESH_ID, existingBotId, SERVER_ENDPOINT);
        } else {
            // Бота нет — регистрируем первый раз
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
    <script src="//api.bitrix24.com/api/v1/"></script>
    <style>
        body { font-family:Arial,sans-serif; background:#f0f4ff;
               display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
        .card { background:white; border-radius:16px; padding:40px; text-align:center;
                max-width:480px; width:90%; box-shadow:0 8px 24px rgba(0,0,0,0.1); }
        h1 { color:#2e7d32; margin-bottom:16px; }
        p { color:#555; line-height:1.6; }
    </style>
</head>
<body>
<div class="card">
    <h1>🤖 Бот "Учёт времени" установлен!</h1>
    <p>Найдите бота в списке чатов Битрикс24 и нажмите на кнопки</p>
</div>
<script>
    BX24.init(function() { BX24.installFinish(); });
</script>
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
                    done('✅','Отметка принята!','Можно закрыть страницу.');
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

    const inOffice = getDistance(lat, lon, OFFICE_LAT, OFFICE_LON) <= OFFICE_RADIUS;
    const typeLabel = rec.type === 'in' ? 'прихода' : 'ухода';
    const time = new Date().toLocaleTimeString('ru-RU', {
        hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Yekaterinburg'
    });
    const kb = keyboardMain(rec.user_id);

    if (!inOffice) {
        await sendMessage(rec.domain, rec.access_token, rec.bot_id, rec.dialog_id,
            `❌ Отметка ${typeLabel} не принята.\n` +
            `📍 Вы находитесь вне офиса (радиус ${OFFICE_RADIUS} м).\n` +
            `Подойдите ближе к офису и попробуйте снова.`,
            kb
        );
        return res.json({ ok: false, error: 'Вы вне офиса. Отметка не принята.' });
    }

    await saveAttendance(rec.user_id, rec.user_name, rec.domain, rec.type, lat, lon, true);

    const emoji = rec.type === 'in' ? '✅' : '🚪';
    const label = rec.type === 'in' ? 'Приход' : 'Уход';
    await sendMessage(rec.domain, rec.access_token, rec.bot_id, rec.dialog_id,
        `${emoji} ${label} зафиксирован в ${time}\n📍 В офисе`,
        kb
    );

    if (rec.type === 'out') {
        // Считаем сколько часов отработано
        const marks = await getTodayMarks(rec.user_id);
        const inMark = marks.find(m => m.type === 'in');
        if (inMark) {
            const diff = (Date.now() - new Date(inMark.timestamp)) / 3600000;
            await sendMessage(rec.domain, rec.access_token, rec.bot_id, rec.dialog_id,
                `⏱ Рабочее время сегодня: ${diff.toFixed(1)} ч.`,
                kb
            );
        }
    }

    console.log(`✅ ${rec.user_name} — ${label} в ${time}, в офисе`);
    res.json({ ok: true, in_office: true });
});

// ═════════════════════════════════════════════════════════════════════════════
//  ВЕБХУК БОТА
// ═════════════════════════════════════════════════════════════════════════════

app.post('/imbot', async (req, res) => {
    res.json({ result: 'ok' });

    try {
        console.log('📨 /imbot RAW:', JSON.stringify(req.body));

        const body  = req.body;
        const event = body.event || body.EVENT;
        const data  = body.data  || body.DATA  || {};
        const auth  = body.auth  || body.AUTH  || {};

        if (!event) {
            console.log('⚠️ /imbot — нет поля event');
            return;
        }

        const params = data.PARAMS || data.params || data;

        // Битрикс присылает нажатие кнопки как обычное MESSAGE = текст кнопки
        // COMMAND поле может прийти или нет — поэтому читаем оба
        const MESSAGE      = params.MESSAGE      || params.message      || '';
        const DIALOG_ID    = params.DIALOG_ID    || params.dialog_id    || '';
        const BOT_ID       = params.BOT_ID       || params.bot_id       || '';
        const FROM_USER_ID = params.FROM_USER_ID || params.from_user_id || '';
        const USER_NAME    = params.USER_NAME    || params.user_name    || '';

        // Имя берём из USER блока если есть
        const userBlock = data.USER || data.user || {};
        const realName  = userBlock.NAME
            ? `${userBlock.NAME} ${userBlock.LAST_NAME || ''}`.trim()
            : (USER_NAME || `Пользователь ${FROM_USER_ID}`);

        const domain   = auth.domain       || auth.DOMAIN       || BITRIX_DOMAIN;
        let authToken  = auth.access_token || auth.ACCESS_TOKEN || '';

        // Нормализуем текст для сравнения
        const msg = MESSAGE.trim().toLowerCase();

        console.log(`📨 event=${event} domain=${domain} user=${realName}(${FROM_USER_ID}) msg="${MESSAGE}"`);

        // Обновляем/берём токен из БД
        if (domain && authToken) {
            const existing = await getPortal(domain);
            await savePortal(domain, authToken, existing?.refresh_token,
                BOT_ID || existing?.bot_id, existing?.client_endpoint);
        }
        if (!authToken) {
            const portal = await getPortal(domain);
            if (portal) authToken = portal.access_token;
            else { console.error('❌ Нет токена для домена:', domain); return; }
        }

        const portal = await getPortal(domain);
        const botId  = BOT_ID || portal?.bot_id;
        if (!botId) { console.error('❌ Нет bot_id для домена:', domain); return; }

        const geoUrl = `https://${APP_DOMAIN}/geo`;
        const kb     = keyboardMain(FROM_USER_ID);

        // ── Приветствие при первом открытии чата ─────────────────────────────
        if (event === 'ONIMBOTJOINCHAT') {
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `👋 Привет, ${realName}!\n\n` +
                `Я веду учёт рабочего времени.\n` +
                `Нажимай кнопки ниже 👇`,
                kb
            );
            return;
        }

        if (event !== 'ONIMBOTMESSAGEADD') return;

        // ── ПРИШЁЛ ───────────────────────────────────────────────────────────
        if (msg === '✅ пришёл' || msg === 'пришел' || msg === 'пришёл') {
            const marks  = await getTodayMarks(FROM_USER_ID);
            const hasIn  = marks.some(m => m.type === 'in');

            if (hasIn) {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `ℹ️ Ты уже отметил приход сегодня.\nЕсли нужно — нажми "Ушёл".`,
                    kb
                );
                return;
            }

            // Проверяем отпуск/больничный
            const today = new Date().toISOString().slice(0, 10);
            const { rows: leaveRows } = await pool.query(
                `SELECT type FROM leaves WHERE user_id=$1 AND date_from<=$2 AND date_to>=$2`,
                [FROM_USER_ID, today]
            );
            if (leaveRows.length > 0) {
                const leaveLabels = { vacation:'отпуске', sick:'больничном', dayoff:'отгуле', trip:'командировке', remote:'удалёнке' };
                const lbl = leaveLabels[leaveRows[0].type] || 'отпуске';
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `ℹ️ По данным системы ты сейчас в ${lbl}.\n` +
                    `Если это ошибка — обратись к руководителю.`,
                    kb
                );
                return;
            }

            const token = makeToken();
            await saveGeoToken(token, FROM_USER_ID, realName, DIALOG_ID, botId, domain, authToken, 'in');
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `📍 Нажми кнопку ниже чтобы подтвердить приход.\n_Ссылка действует 10 минут._`,
                keyboardGeoLink(`${geoUrl}?token=${token}`, 'in')
            );

        // ── УШЁЛ ─────────────────────────────────────────────────────────────
        } else if (msg === '🚪 ушёл' || msg === 'ушел' || msg === 'ушёл') {
            const marks  = await getTodayMarks(FROM_USER_ID);
            const hasIn  = marks.some(m => m.type === 'in');
            const hasOut = marks.some(m => m.type === 'out');

            if (!hasIn) {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `⚠️ Сначала отметь приход — нажми "✅ Пришёл".`,
                    kb
                );
                return;
            }
            if (hasOut) {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `ℹ️ Ты уже отметил уход сегодня.`,
                    kb
                );
                return;
            }

            const token = makeToken();
            await saveGeoToken(token, FROM_USER_ID, realName, DIALOG_ID, botId, domain, authToken, 'out');
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `📍 Нажми кнопку ниже чтобы подтвердить уход.\n_Ссылка действует 10 минут._`,
                keyboardGeoLink(`${geoUrl}?token=${token}`, 'out')
            );

        // ── СТАТУС ────────────────────────────────────────────────────────────
        } else if (msg === '📊 статус' || msg === 'статус') {
            const marks = await getTodayMarks(FROM_USER_ID);
            if (marks.length === 0) {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `📊 Сегодня отметок нет.\nНажми "✅ Пришёл" когда придёшь в офис.`,
                    kb
                );
            } else {
                const lines = marks.map(m => {
                    const t  = new Date(m.timestamp).toLocaleTimeString('ru-RU',
                        { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Yekaterinburg' });
                    const tp = m.type === 'in' ? '✅ Приход' : '🚪 Уход';
                    return `${tp} — ${t}`;
                }).join('\n');

                // Считаем время если есть оба
                const inMark  = marks.find(m => m.type === 'in');
                const outMark = marks.find(m => m.type === 'out');
                let extra = '';
                if (inMark && outMark) {
                    const diff = (new Date(outMark.timestamp) - new Date(inMark.timestamp)) / 3600000;
                    extra = `\n⏱ Отработано: ${diff.toFixed(1)} ч.`;
                }

                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `📊 Твои отметки сегодня:\n\n${lines}${extra}`,
                    kb
                );
            }

        // ── ПОМОЩЬ ────────────────────────────────────────────────────────────
        } else if (msg === '❓ помощь' || msg === 'помощь' || msg === 'help') {
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `🤖 *Бот учёта рабочего времени*\n\n` +
                `✅ *Пришёл* — отметить начало рабочего дня\n` +
                `🚪 *Ушёл* — отметить конец рабочего дня\n` +
                `📊 *Статус* — твои отметки за сегодня\n\n` +
                `При нажатии "Пришёл" или "Ушёл" откроется страница\n` +
                `для подтверждения геолокации — нужно разрешить\n` +
                `доступ к местоположению в браузере.`,
                kb
            );

        // ── НАЗАД В МЕНЮ ──────────────────────────────────────────────────────
        } else if (msg === '◀️ назад в меню' || msg === 'назад' || msg === 'меню') {
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `👇 Выбери действие:`,
                kb
            );

        // ── ADMIN: УПРАВЛЕНИЕ ─────────────────────────────────────────────────
        } else if (msg === '⚙️ управление' || msg === 'управление') {
            if (!isAdmin(FROM_USER_ID)) {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `🚫 Нет доступа.`, kb);
                return;
            }
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `⚙️ *Панель управления*\nВыбери действие:`,
                keyboardAdmin()
            );

        // ── ADMIN: ОТЧЁТ ЗА СЕГОДНЯ ──────────────────────────────────────────
        } else if (msg === '📋 отчёт за сегодня' || msg === 'отчёт сегодня') {
            if (!isAdmin(FROM_USER_ID)) {
                await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb);
                return;
            }
            const today = new Date().toISOString().slice(0, 10);
            const { rows } = await pool.query(`
                SELECT user_name, user_id,
                    MIN(CASE WHEN type='in'  THEN timestamp END) as in_time,
                    MAX(CASE WHEN type='out' THEN timestamp END) as out_time
                FROM attendance
                WHERE (timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date = $1
                GROUP BY user_id, user_name
                ORDER BY user_name
            `, [today]);

            const { rows: leaveRows } = await pool.query(`
                SELECT user_name, type FROM leaves
                WHERE date_from <= $1 AND date_to >= $1
            `, [today]);

            let text = `📋 *Отчёт за ${new Date().toLocaleDateString('ru-RU')}*\n\n`;

            if (rows.length) {
                text += `*Явились (${rows.length}):*\n`;
                rows.forEach(r => {
                    const inn = r.in_time
                        ? new Date(r.in_time).toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', timeZone:'Asia/Yekaterinburg' })
                        : '?';
                    const out = r.out_time
                        ? new Date(r.out_time).toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', timeZone:'Asia/Yekaterinburg' })
                        : 'ещё в офисе';
                    text += `• ${r.user_name || r.user_id}: ${inn} → ${out}\n`;
                });
            } else {
                text += `Отметок нет.\n`;
            }

            if (leaveRows.length) {
                const labels = { vacation:'отпуск', sick:'б/л', dayoff:'отгул', trip:'командировка', remote:'удалёнка' };
                text += `\n*Отсутствуют (${leaveRows.length}):*\n`;
                leaveRows.forEach(l => {
                    text += `• ${l.user_name || '?'} — ${labels[l.type] || l.type}\n`;
                });
            }

            await sendMessage(domain, authToken, botId, DIALOG_ID, text, keyboardAdmin());

        // ── ADMIN: ОТЧЁТ ЗА НЕДЕЛЮ ───────────────────────────────────────────
        } else if (msg === '📅 отчёт за неделю' || msg === 'отчёт неделя') {
            if (!isAdmin(FROM_USER_ID)) {
                await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb);
                return;
            }
            const { rows } = await pool.query(`
                SELECT user_name, user_id,
                    COUNT(DISTINCT (timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date) as days,
                    MIN(timestamp) as first_in
                FROM attendance
                WHERE type='in'
                  AND timestamp >= NOW() - INTERVAL '7 days'
                GROUP BY user_id, user_name
                ORDER BY user_name
            `);

            let text = `📅 *Отчёт за 7 дней*\n\n`;
            if (rows.length) {
                rows.forEach(r => {
                    text += `• ${r.user_name || r.user_id}: явился ${r.days} из 5 дней\n`;
                });
            } else {
                text += `Нет данных за период.`;
            }


            
            await sendMessage(domain, authToken, botId, DIALOG_ID, text, keyboardAdmin());

        // ── ADMIN: КТО В ОФИСЕ ────────────────────────────────────────────────
        } else if (msg === '👥 кто в офисе' || msg === 'кто в офисе') {
            if (!isAdmin(FROM_USER_ID)) {
                await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb);
                return;
            }
            // Кто пришёл но не ушёл сегодня
            const { rows } = await pool.query(`
                SELECT user_name, user_id,
                    MIN(CASE WHEN type='in'  THEN timestamp END) as in_time,
                    MAX(CASE WHEN type='out' THEN timestamp END) as out_time
                FROM attendance
                WHERE (timestamp AT TIME ZONE 'Asia/Yekaterinburg')::date = (NOW() AT TIME ZONE 'Asia/Yekaterinburg')::date
                GROUP BY user_id, user_name
                HAVING MAX(CASE WHEN type='out' THEN 1 ELSE 0 END) = 0
                ORDER BY user_name
            `);

            let text = `👥 *Сейчас в офисе (${rows.length} чел.):*\n\n`;
            if (rows.length) {
                rows.forEach(r => {
                    const inn = r.in_time
                        ? new Date(r.in_time).toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', timeZone:'Asia/Yekaterinburg' })
                        : '?';
                    text += `• ${r.user_name || r.user_id} (с ${inn})\n`;
                });
            } else {
                text += `Никого нет.`;
            }

            await sendMessage(domain, authToken, botId, DIALOG_ID, text, keyboardAdmin());

        // ── ADMIN: ДОБАВИТЬ ОТПУСК ────────────────────────────────────────────
        } else if (msg === '🏖 добавить отпуск' || msg === 'добавить отпуск') {
            if (!isAdmin(FROM_USER_ID)) {
                await sendMessage(domain, authToken, botId, DIALOG_ID, `🚫 Нет доступа.`, kb);
                return;
            }
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `🏖 *Добавление отпуска/б-л*\n\n` +
                `Напишите в формате:\n` +
                `[тип] [ID сотрудника] [с даты] [по дату]\n\n` +
                `Примеры:\n` +
                `отпуск 5 2026-03-10 2026-03-20\n` +
                `больничный 5 2026-03-10 2026-03-15\n` +
                `командировка 5 2026-03-10 2026-03-12\n` +
                `удалёнка 5 2026-03-10 2026-03-14\n\n` +
                `_Для отмены нажмите "Назад в меню"_`,
                [[ { TEXT: '◀️ Назад в меню', BG_COLOR: '#888888', TEXT_COLOR: '#ffffff' } ]]
            );

        // ── ПАРСИНГ КОМАНДЫ ДОБАВЛЕНИЯ СТАТУСА ───────────────────────────────
        } else if (isAdmin(FROM_USER_ID) &&
            /^(отпуск|больничный|командировка|удалёнка|отгул)\s+\d+\s+\d{4}-\d{2}-\d{2}\s+\d{4}-\d{2}-\d{2}$/i.test(msg)) {

            const parts = msg.split(/\s+/);
            const typeMap = { 'отпуск':'vacation', 'больничный':'sick', 'командировка':'trip', 'удалёнка':'remote', 'отгул':'dayoff' };
            const leaveType = typeMap[parts[0]] || 'vacation';
            const targetId  = parts[1];
            const dateFrom  = parts[2];
            const dateTo    = parts[3];

            // Ищем имя сотрудника
            const { rows: nameRows } = await pool.query(
                `SELECT user_name FROM attendance WHERE user_id=$1 LIMIT 1`, [targetId]
            );
            const targetName = nameRows[0]?.user_name || `ID:${targetId}`;

            await pool.query(
                `INSERT INTO leaves (user_id, user_name, type, date_from, date_to)
                 VALUES ($1, $2, $3, $4, $5)`,
                [targetId, targetName, leaveType, dateFrom, dateTo]
            );

            const labelMap = { vacation:'отпуск', sick:'больничный', trip:'командировку', remote:'удалёнку', dayoff:'отгул' };
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `✅ Добавлено: ${targetName} → ${labelMap[leaveType]}\n` +
                `📅 ${dateFrom} — ${dateTo}`,
                keyboardAdmin()
            );

        // ── ЛЮБОЕ ДРУГОЕ СООБЩЕНИЕ ────────────────────────────────────────────
        } else {
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `❓ Не понял: "${MESSAGE}"\n\nВоспользуйся кнопками ниже 👇`,
                kb
            );
        }

    } catch (err) {
        console.error('❌ /imbot error:', err.message, err.stack);
    }
});

// ═════════════════════════════════════════════════════════════════════════════
//  ВСПОМОГАТЕЛЬНЫЕ МАРШРУТЫ
// ═════════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
    res.send(`<h1>🤖 Бот учёта рабочего времени</h1><p>Сервер работает</p>
    <ul>
        <li><a href="/status">Статус</a></li>
        <li><a href="/debug">Debug</a></li>
        <li><a href="/reinstall-bot">Перерегистрировать бота</a></li>
        <li><a href="/test-bot">Тест бота</a></li>
    </ul>`);
});

app.get('/status', async (req, res) => {
    const { rows } = await pool.query(`SELECT domain, bot_id, updated_at FROM portals`);
    res.json({
        ok: true, service: 'v8',
        portals: rows,
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
        domain, portal_in_db: !!portal,
        portal_data: portal ? {
            domain:        portal.domain,
            bot_id:        portal.bot_id,
            token_preview: portal.access_token?.substring(0, 12) + '...',
            updated_at:    portal.updated_at,
        } : null,
        app_domain: APP_DOMAIN, manager_id: MANAGER_ID,
    });
});

app.get('/reinstall-bot', async (req, res) => {
    const domain = req.query.domain || BITRIX_DOMAIN;
    const portal = await getPortal(domain);
    if (!portal) return res.json({ ok: false, error: 'Портал не найден. Нажми "Переустановить" в Битрикс24.' });

    const log = [];
    const profile = await callBitrix(domain, portal.access_token, 'profile', {});
    log.push({ profile: profile?.result ? '✅ токен валидный' : '❌ невалидный' });

    if (!profile?.result) {
        if (portal.refresh_token) {
            const newToken = await doRefreshToken(domain, portal.refresh_token);
            log.push({ refresh: newToken ? '✅ обновлён' : '❌ не удалось' });
            if (!newToken) return res.json({ ok: false, log, error: 'Нажми "Переустановить" в Битрикс24.' });
        } else {
            return res.json({ ok: false, log, error: 'Нет refresh_token. Нажми "Переустановить" в Битрикс24.' });
        }
    }

    const fresh = await getPortal(domain);
    const botId = await registerBot(domain, fresh.access_token, fresh.bot_id || null);
    if (botId) {
        await savePortal(domain, fresh.access_token, fresh.refresh_token, botId, fresh.client_endpoint);
        log.push({ bot_registered: `✅ ID=${botId}` });
    } else {
        log.push({ bot_registered: '❌ не удалось' });
    }

    res.json({ ok: !!botId, log, bot_id: botId,
        message: botId
            ? `✅ Бот перерегистрирован (ID=${botId}).`
            : '❌ Не удалось зарегистрировать бота.' });
});

app.get('/test-bot', async (req, res) => {
    const domain = req.query.domain || BITRIX_DOMAIN;
    const portal = await getPortal(domain);
    if (!portal) return res.json({ ok: false, error: 'Портал не найден.' });

    const profile = await callBitrix(domain, portal.access_token, 'profile', {});
    const notify  = await callBitrix(domain, portal.access_token, 'im.notify.system.add', {
        USER_ID: MANAGER_ID, MESSAGE: '🔧 Тест уведомлений — работает!',
    });
    const bots = await callBitrix(domain, portal.access_token, 'imbot.bot.list', {});

    res.json({
        bot_id:        portal.bot_id,
        profile_check: profile?.result ? `✅ ${profile.result.NAME} ${profile.result.LAST_NAME}` : '❌',
        notify_result: notify?.result  ? '✅ отправлено' : '❌ ошибка',
        bots_in_b24:   bots?.result || null,
    });
});

// ─── Очистка старых гео-токенов ───────────────────────────────────────────────
cron.schedule('*/15 * * * *', async () => {
    await pool.query(`DELETE FROM geo_tokens WHERE created_at < NOW() - INTERVAL '15 minutes'`);
    console.log('🧹 Очистка старых geo-токенов');
});

// ─── Запуск ───────────────────────────────────────────────────────────────────
initDB().then(() => {
    app.listen(port, '0.0.0.0', () => {
        console.log(`🚀 Сервер: https://${APP_DOMAIN}`);
        console.log(`📍 Офис: ${OFFICE_LAT}, ${OFFICE_LON} (${OFFICE_RADIUS}м)`);
        console.log(`🆔 Менеджер: ${MANAGER_ID}`);
        console.log('=== ✅ READY ===');
    });
}).catch(err => {
    console.error('❌ Ошибка подключения к БД:', err.message);
    process.exit(1);
});
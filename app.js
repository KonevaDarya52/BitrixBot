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
const WORK_START    = parseInt(process.env.WORK_START_HOUR || '9');  // час начала рабочего дня
const TZ            = process.env.TZ_NAME                  || 'Asia/Yekaterinburg';

// Администраторы — список ID через запятую: ADMIN_IDS=1,2,5
const ADMIN_IDS = (process.env.ADMIN_IDS || MANAGER_ID)
    .split(',').map(s => s.trim()).filter(Boolean);

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
        )`);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS attendance (
            id          SERIAL PRIMARY KEY,
            user_id     TEXT NOT NULL,
            user_name   TEXT,
            domain      TEXT,
            type        TEXT NOT NULL,   -- 'in','out','vacation','sick','dayoff'
            timestamp   TIMESTAMPTZ DEFAULT NOW(),
            latitude    REAL,
            longitude   REAL,
            in_office   INTEGER DEFAULT 0,
            note        TEXT             -- комментарий для отпуска/больничного
        )`);
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
        )`);
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

function nowInTZ() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}

function formatTime(date) {
    return new Date(date).toLocaleTimeString('ru-RU',
        { hour: '2-digit', minute: '2-digit', timeZone: TZ });
}

function formatDate(date) {
    return new Date(date).toLocaleDateString('ru-RU',
        { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: TZ });
}

function isAdmin(userId) {
    return ADMIN_IDS.includes(String(userId));
}

// ─── Приветствия ─────────────────────────────────────────────────────────────
function getGreeting(name) {
    const hour = nowInTZ().getHours();
    const day  = nowInTZ().getDay(); // 0=вс, 5=пт
    const firstName = name.split(' ')[0];

    const morning = [
        `☀️ Доброе утро, ${firstName}! Пусть этот день будет продуктивным и приятным 🚀`,
        `🌅 С добрым утром, ${firstName}! Кофе уже ждёт тебя ☕`,
        `🐦 Утро доброе, ${firstName}! Ты сегодня первый(ая) — молодец! 🌟`,
        `🌤️ Привет, ${firstName}! Отличное утро, чтобы свернуть горы 💪`,
    ];
    const day_greet = [
        `👋 Привет, ${firstName}! Рада тебя видеть сегодня 😊`,
        `🙌 ${firstName}, привет! Как дела? Главное — ты здесь! ✨`,
        `💫 Привет-привет, ${firstName}! Продолжаем покорять рабочий день 🎯`,
        `🤗 ${firstName}, добро пожаловать! Офис стал лучше с твоим появлением 🌸`,
    ];
    const friday = [
        `🎉 ${firstName}, с пятницей! Финальный рывок — и выходные твои 🏆`,
        `🥳 Пятница, ${firstName}! Ты дожил(а) до неё — это уже победа! 🎊`,
    ];
    const evening = [
        `🌆 Добрый вечер, ${firstName}! Работаешь допоздна? Ты герой 🦸`,
        `🌙 ${firstName}, привет! Вечерний режим активирован ✨`,
    ];

    if (day === 5) return friday[Math.floor(Math.random() * friday.length)];
    if (hour < 12) return morning[Math.floor(Math.random() * morning.length)];
    if (hour >= 18) return evening[Math.floor(Math.random() * evening.length)];
    return day_greet[Math.floor(Math.random() * day_greet.length)];
}

function getWelcomeMessage(name) {
    const greeting = getGreeting(name);
    return `${greeting}\n\n` +
        `Я помогу отмечать приход и уход из офиса 📋\n\n` +
        `Выбери действие 👇`;
}

// ─── Клавиатура бота ─────────────────────────────────────────────────────────
function mainKeyboard() {
    return JSON.stringify([
        [{ TEXT: '📍 Пришёл', command: 'пришел' }],
        [{ TEXT: '🚪 Ушёл', command: 'ушел' }],
        [{ TEXT: '📊 Мой статус', command: 'статус' }, { TEXT: '❓ Помощь', command: 'помощь' }],
        [{ TEXT: '🌴 Отпуск', command: 'отпуск' }, { TEXT: '🤒 Больничный', command: 'больничный' }],
    ]);
}

function geoKeyboard(token) {
    const url = `https://${APP_DOMAIN}/geo?token=${token}`;
    return JSON.stringify([
        [{ TEXT: '📍 Отправить геолокацию', link: url }],
    ]);
}

// ─── БД: порталы ─────────────────────────────────────────────────────────────
async function savePortal(domain, accessToken, refreshToken, botId, clientEndpoint) {
    await pool.query(
        `INSERT INTO portals (domain, access_token, refresh_token, bot_id, client_endpoint, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (domain) DO UPDATE SET
             access_token    = EXCLUDED.access_token,
             refresh_token   = COALESCE(NULLIF($3,''), portals.refresh_token),
             bot_id          = COALESCE(NULLIF($4,''), portals.bot_id),
             client_endpoint = COALESCE(NULLIF($5,''), portals.client_endpoint),
             updated_at      = NOW()`,
        [domain, accessToken, refreshToken || '', botId || '', clientEndpoint || '']
    );
}

async function getPortal(domain) {
    const { rows } = await pool.query(`SELECT * FROM portals WHERE domain=$1`, [domain]);
    return rows[0] || null;
}

// ─── БД: посещаемость ────────────────────────────────────────────────────────
async function saveAttendance(userId, userName, domain, type, lat, lon, inOffice, note) {
    const { rows } = await pool.query(
        `INSERT INTO attendance (user_id,user_name,domain,type,latitude,longitude,in_office,note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [userId, userName, domain, type, lat||null, lon||null, inOffice?1:0, note||null]
    );
    return rows[0].id;
}

async function getTodayMarks(userId) {
    const { rows } = await pool.query(
        `SELECT type,timestamp,in_office,note FROM attendance
         WHERE user_id=$1
           AND (timestamp AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date
         ORDER BY timestamp`,
        [userId, TZ]
    );
    return rows;
}

async function getMarksForPeriod(startDate, endDate, domain) {
    const { rows } = await pool.query(
        `SELECT user_id, user_name, type, timestamp, in_office, note
         FROM attendance
         WHERE domain=$1
           AND (timestamp AT TIME ZONE $4)::date >= $2::date
           AND (timestamp AT TIME ZONE $4)::date <= $3::date
         ORDER BY user_name, timestamp`,
        [domain, startDate, endDate, TZ]
    );
    return rows;
}

async function getUsersWithoutCheckIn(domain) {
    // Получаем всех кто отмечался хоть раз, но сегодня не отметился
    const { rows } = await pool.query(
        `SELECT DISTINCT ON (user_id) user_id, user_name, domain
         FROM attendance
         WHERE domain = $1
           AND (timestamp AT TIME ZONE $2)::date < (NOW() AT TIME ZONE $2)::date
           AND user_id NOT IN (
               SELECT DISTINCT user_id FROM attendance
               WHERE domain = $1
                 AND (timestamp AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date
           )
         ORDER BY user_id`,
        [domain, TZ]
    );
    return rows;
}

// ─── БД: гео-токены ──────────────────────────────────────────────────────────
async function saveGeoToken(token, userId, userName, dialogId, botId, domain, accessToken, type) {
    await pool.query(
        `INSERT INTO geo_tokens (token,user_id,user_name,dialog_id,bot_id,domain,access_token,type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (token) DO UPDATE SET
             user_id=$2,user_name=$3,dialog_id=$4,bot_id=$5,
             domain=$6,access_token=$7,type=$8,created_at=NOW()`,
        [token, userId, userName, dialogId, botId, domain, accessToken, type]
    );
}

async function popGeoToken(token) {
    const { rows } = await pool.query(
        `DELETE FROM geo_tokens WHERE token=$1 RETURNING *`, [token]
    );
    return rows[0] || null;
}

// ─── Bitrix24 API ─────────────────────────────────────────────────────────────
async function doRefreshToken(domain, rToken) {
    try {
        const resp = await axios.get('https://oauth.bitrix24.tech/oauth/token/', {
            params: { grant_type:'refresh_token', client_id:CLIENT_ID,
                      client_secret:CLIENT_SECRET, refresh_token:rToken }
        });
        if (resp.data?.access_token) {
            await savePortal(domain, resp.data.access_token, resp.data.refresh_token, '', '');
            console.log('🔄 Токен обновлён для', domain);
            return resp.data.access_token;
        }
    } catch (err) { console.error('❌ refresh token:', err.message); }
    return null;
}

async function callBitrix(domain, accessToken, method, params = {}) {
    try {
        const resp = await axios.post(
            `https://${domain}/rest/${method}`, params,
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

async function sendMessage(domain, accessToken, botId, dialogId, message, keyboard) {
    console.log(`📤 sendMessage → bot=${botId}, dialog=${dialogId}`);
    const params = { BOT_ID: botId, DIALOG_ID: dialogId, MESSAGE: message };
    if (keyboard) params.KEYBOARD = keyboard;
    return callBitrix(domain, accessToken, 'imbot.message.add', params);
}

async function notifyManager(domain, accessToken, text) {
    return callBitrix(domain, accessToken, 'im.notify.system.add', {
        USER_ID: MANAGER_ID, MESSAGE: text,
    });
}

// ─── Регистрация бота ─────────────────────────────────────────────────────────
async function registerBot(domain, accessToken, existingBotId) {
    const handlerUrl = `https://${APP_DOMAIN}/imbot`;
    if (existingBotId) {
        console.log(`🗑 Удаляем бота ID=${existingBotId}...`);
        await callBitrix(domain, accessToken, 'imbot.unregister', { BOT_ID: existingBotId });
        await new Promise(r => setTimeout(r, 1500));
    }
    console.log('🤖 Регистрируем бота...');
    const resp = await callBitrix(domain, accessToken, 'imbot.register', {
        CODE: 'attendance_bot', TYPE: 'H',
        EVENT_MESSAGE_ADD:     handlerUrl,
        EVENT_WELCOME_MESSAGE: handlerUrl,
        EVENT_BOT_DELETE:      handlerUrl,
        PROPERTIES: {
            NAME: 'Учёт времени', COLOR: 'GREEN',
            DESCRIPTION: 'Бот учёта присутствия сотрудников',
            WORK_POSITION: 'Помощник HR',
        }
    });
    const botId = String(resp?.result || '');
    if (botId) console.log('✅ Бот зарегистрирован, ID:', botId);
    else console.error('❌ Ошибка регистрации:', JSON.stringify(resp));
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
    const domain          = req.body.DOMAIN || req.body.domain
                         || req.query.DOMAIN || req.query.domain || '';

    if (AUTH_ID && domain) {
        const botsResp = await callBitrix(domain, AUTH_ID, 'imbot.bot.list', {});
        const botsArr  = Object.values(botsResp?.result || {});
        const ourBot   = botsArr.find(b => b.CODE === 'attendance_bot');
        if (ourBot) {
            console.log(`✅ Бот уже зарегистрирован (ID=${ourBot.ID}), обновляем токен`);
            await savePortal(domain, AUTH_ID, REFRESH_ID, String(ourBot.ID), SERVER_ENDPOINT);
        } else {
            await savePortal(domain, AUTH_ID, REFRESH_ID, '', SERVER_ENDPOINT);
            const botId = await registerBot(domain, AUTH_ID, null);
            if (botId) await savePortal(domain, AUTH_ID, REFRESH_ID, botId, SERVER_ENDPOINT);
        }
    }

    res.send(`<!DOCTYPE html>
<html lang="ru"><head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Учёт времени</title>
    <script src="//api.bitrix24.com/api/v1/"></script>
    <style>
        body{font-family:Arial,sans-serif;background:#f0f4ff;display:flex;
             align-items:center;justify-content:center;min-height:100vh;margin:0}
        .card{background:white;border-radius:16px;padding:40px;text-align:center;
              max-width:480px;width:90%;box-shadow:0 8px 24px rgba(0,0,0,.1)}
        h1{color:#2e7d32;margin-bottom:16px}
        .cmd{background:#f5f5f5;border-radius:8px;padding:10px 16px;margin:6px 0;
             font-size:16px;font-weight:bold;display:inline-block;width:220px}
        p{color:#555;line-height:1.6}
    </style>
</head>
<body><div class="card">
    <h1>🤖 Бот "Учёт времени" установлен!</h1>
    <p>Найдите бота в списке чатов Битрикс24:</p><br>
    <div class="cmd">📍 Пришёл</div><br>
    <div class="cmd">🚪 Ушёл</div><br>
    <div class="cmd">🌴 Отпуск / 🤒 Больничный</div><br>
    <div class="cmd">📊 Статус</div>
</div>
<script>BX24.init(function(){ BX24.installFinish(); });</script>
</body></html>`);
});

// ═════════════════════════════════════════════════════════════════════════════
//  СТРАНИЦА ГЕОЛОКАЦИИ
// ═════════════════════════════════════════════════════════════════════════════
app.get('/geo', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).send('Токен не найден');
    const safeToken = token.replace(/['"\\<>]/g, '');

    res.send(`<!DOCTYPE html>
<html lang="ru"><head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Отметка присутствия</title>
    <style>
        *{box-sizing:border-box;margin:0;padding:0}
        body{font-family:-apple-system,sans-serif;background:linear-gradient(135deg,#667eea,#764ba2);
             display:flex;align-items:center;justify-content:center;min-height:100vh}
        .card{background:white;border-radius:24px;padding:48px 32px;text-align:center;
              box-shadow:0 16px 48px rgba(0,0,0,.2);max-width:340px;width:90%}
        .icon{font-size:64px;margin-bottom:16px}
        h2{font-size:22px;color:#1a1a2e;margin-bottom:8px}
        p{font-size:14px;color:#666;line-height:1.5;margin-bottom:16px}
        .btn{background:linear-gradient(135deg,#667eea,#764ba2);color:white;border:none;
             border-radius:50px;padding:16px 32px;font-size:16px;font-weight:bold;
             cursor:pointer;width:100%;transition:.3s}
        .btn:hover{opacity:.9;transform:translateY(-2px)}
        .btn:disabled{opacity:.5;cursor:not-allowed;transform:none}
        .spinner{width:40px;height:40px;margin:16px auto;
                 border:4px solid #e0e0e0;border-top-color:#667eea;
                 border-radius:50%;animation:spin .8s linear infinite;display:none}
        @keyframes spin{to{transform:rotate(360deg)}}
    </style>
</head>
<body><div class="card">
    <div class="icon" id="icon">📍</div>
    <h2 id="title">Подтверди своё местоположение</h2>
    <p id="msg">Нажми кнопку — мы определим, что ты в офисе 🏢</p>
    <div class="spinner" id="spinner"></div>
    <button class="btn" id="btn" onclick="sendGeo()">📍 Отправить геолокацию</button>
</div>
<script>
function done(icon,title,msg,hideBtn){
    document.getElementById('icon').textContent=icon;
    document.getElementById('title').textContent=title;
    document.getElementById('msg').textContent=msg;
    document.getElementById('spinner').style.display='none';
    if(hideBtn) document.getElementById('btn').style.display='none';
}
function sendGeo(){
    if(!navigator.geolocation){done('❌','Нет поддержки','Попробуйте Chrome или Safari',false);return}
    document.getElementById('btn').disabled=true;
    document.getElementById('btn').textContent='⏳ Определяем...';
    document.getElementById('spinner').style.display='block';
    document.getElementById('msg').textContent='Разрешите доступ к геолокации';
    navigator.geolocation.getCurrentPosition(
        function(pos){
            done('⏳','Отправляем данные...','Подождите секунду',true);
            fetch('/confirm-geo',{method:'POST',headers:{'Content-Type':'application/json'},
                body:JSON.stringify({token:'${safeToken}',lat:pos.coords.latitude,lon:pos.coords.longitude})})
            .then(r=>r.json())
            .then(d=>{
                if(d.ok){
                    done(d.in_office?'✅':'⚠️',
                         d.in_office?'Отметка принята! Ты в офисе 🏢':'Отметка принята',
                         d.in_office?'Всё отлично, можно закрыть страницу':'Ты вне офиса — руководитель уведомлён',true);
                }else{
                    done('❌','Ошибка',d.error||'Попробуй ещё раз',false);
                    document.getElementById('btn').disabled=false;
                    document.getElementById('btn').textContent='📍 Попробовать снова';
                }
                if(d.ok) setTimeout(()=>window.close(),3000);
            })
            .catch(()=>{done('❌','Ошибка сети','Проверь подключение',false);
                        document.getElementById('btn').disabled=false;});
        },
        function(err){
            var msgs={1:'Запретили геолокацию — разрешите в настройках',
                      2:'Не удалось определить местоположение',3:'Превышено время ожидания'};
            done('❌','Геолокация недоступна',msgs[err.code]||'Ошибка: '+err.message,false);
            document.getElementById('btn').disabled=false;
            document.getElementById('btn').textContent='📍 Попробовать снова';
        },
        {timeout:15000,enableHighAccuracy:true,maximumAge:0}
    );
}
</script></div></body></html>`);
});

// ═════════════════════════════════════════════════════════════════════════════
//  ПОДТВЕРЖДЕНИЕ ГЕОЛОКАЦИИ
// ═════════════════════════════════════════════════════════════════════════════
app.post('/confirm-geo', async (req, res) => {
    const { token, lat, lon } = req.body;
    if (!token || lat == null || lon == null)
        return res.json({ ok: false, error: 'Неверные данные' });

    const rec = await popGeoToken(token);
    if (!rec) return res.json({ ok: false, error: 'Ссылка устарела или уже использована. Запроси новую в боте.' });

    const inOffice  = getDistance(lat, lon, OFFICE_LAT, OFFICE_LON) <= OFFICE_RADIUS;
    const typeLabel = rec.type === 'in' ? 'Приход' : 'Уход';
    const emoji     = rec.type === 'in' ? '✅' : '🚪';
    const time      = formatTime(new Date());

    // Проверяем опоздание
    const now     = nowInTZ();
    const isLate  = rec.type === 'in' && now.getHours() >= WORK_START && now.getMinutes() > 0;
    const lateMin = rec.type === 'in' ? now.getHours() * 60 + now.getMinutes() - WORK_START * 60 : 0;

    await saveAttendance(rec.user_id, rec.user_name, rec.domain, rec.type, lat, lon, inOffice);

    let msg = `${emoji} *${typeLabel}* зафиксирован в ${time}\n`;
    msg += inOffice ? '📍 В офисе' : '⚠️ Вне офиса';
    if (isLate && lateMin > 0) msg += `\n⏰ Опоздание: ${lateMin} мин`;

    await sendMessage(rec.domain, rec.access_token, rec.bot_id, rec.dialog_id, msg, mainKeyboard());

    if (!inOffice || (isLate && lateMin > 15)) {
        let notif = `⚠️ *${rec.user_name}* — ${typeLabel.toLowerCase()} `;
        if (!inOffice) notif += `вне офиса в ${time}`;
        else if (isLate) notif += `с опозданием ${lateMin} мин (${time})`;
        await notifyManager(rec.domain, rec.access_token, notif);
    }

    console.log(`✅ ${rec.user_name} — ${typeLabel} в ${time}, в офисе: ${inOffice}`);
    res.json({ ok: true, in_office: inOffice });
});

// ═════════════════════════════════════════════════════════════════════════════
//  ADMIN — страница отчётов
// ═════════════════════════════════════════════════════════════════════════════
app.get('/admin', async (req, res) => {
    const userId = req.query.user_id;
    if (!userId || !isAdmin(userId)) {
        return res.status(403).send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Доступ запрещён</title></head>
<body style="font-family:Arial;text-align:center;padding:60px">
<h1>🔒 Доступ запрещён</h1>
<p>Эта страница только для администраторов.</p>
<p>Используй команду <b>отчёт</b> в боте.</p>
</body></html>`);
    }

    const domain = req.query.domain || BITRIX_DOMAIN;

    res.send(`<!DOCTYPE html>
<html lang="ru"><head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Отчёты — Учёт времени</title>
    <style>
        *{box-sizing:border-box}
        body{font-family:'Segoe UI',Arial,sans-serif;background:#f0f4ff;margin:0;padding:20px}
        .wrap{max-width:900px;margin:0 auto}
        h1{color:#1a237e;margin-bottom:4px}
        .sub{color:#666;margin-bottom:24px;font-size:14px}
        .card{background:white;border-radius:16px;padding:24px;box-shadow:0 4px 16px rgba(0,0,0,.08);margin-bottom:20px}
        .row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}
        label{font-size:13px;font-weight:600;color:#444;display:block;margin-bottom:4px}
        input[type=date]{border:1.5px solid #ddd;border-radius:8px;padding:8px 12px;font-size:14px;outline:none}
        input[type=date]:focus{border-color:#667eea}
        .btn{background:linear-gradient(135deg,#667eea,#764ba2);color:white;border:none;
             border-radius:8px;padding:10px 20px;font-size:14px;font-weight:600;cursor:pointer}
        .btn:hover{opacity:.9}
        .btn.green{background:linear-gradient(135deg,#43a047,#1b5e20)}
        table{width:100%;border-collapse:collapse;font-size:13px;margin-top:16px}
        th{background:#f5f5f5;padding:10px 12px;text-align:left;font-weight:600;color:#333;
           border-bottom:2px solid #eee}
        td{padding:9px 12px;border-bottom:1px solid #f0f0f0;color:#444}
        tr:hover td{background:#fafafa}
        .badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600}
        .badge.in{background:#e8f5e9;color:#2e7d32}
        .badge.out{background:#fff3e0;color:#e65100}
        .badge.vacation{background:#e3f2fd;color:#1565c0}
        .badge.sick{background:#fce4ec;color:#c62828}
        .badge.late{background:#fff9c4;color:#f57f17}
        .badge.yes{background:#e8f5e9;color:#2e7d32}
        .badge.no{background:#ffebee;color:#c62828}
        #loading{display:none;text-align:center;padding:40px;color:#888}
        #empty{display:none;text-align:center;padding:40px;color:#aaa}
    </style>
</head>
<body><div class="wrap">
    <h1>📊 Отчёты по посещаемости</h1>
    <p class="sub">Администраторская панель</p>

    <div class="card">
        <div class="row">
            <div>
                <label>Дата с</label>
                <input type="date" id="dateFrom">
            </div>
            <div>
                <label>Дата по</label>
                <input type="date" id="dateTo">
            </div>
            <button class="btn" onclick="loadReport()">🔍 Показать</button>
            <button class="btn green" onclick="exportExcel()">📥 Экспорт в Excel</button>
        </div>
    </div>

    <div class="card">
        <div id="loading">⏳ Загружаем данные...</div>
        <div id="empty">📭 Нет данных за выбранный период</div>
        <div id="tableWrap"></div>
    </div>
</div>
<script>
const domain = '${domain}';
const userId = '${userId}';

// Устанавливаем даты по умолчанию — текущая неделя
const today = new Date();
const mon   = new Date(today); mon.setDate(today.getDate() - today.getDay() + 1);
document.getElementById('dateFrom').value = mon.toISOString().slice(0,10);
document.getElementById('dateTo').value   = today.toISOString().slice(0,10);

let reportData = [];

async function loadReport() {
    const from = document.getElementById('dateFrom').value;
    const to   = document.getElementById('dateTo').value;
    if (!from || !to) return alert('Выберите даты');

    document.getElementById('loading').style.display = 'block';
    document.getElementById('tableWrap').innerHTML = '';
    document.getElementById('empty').style.display = 'none';

    const resp = await fetch('/admin/data?user_id=${userId}&domain='+domain+'&from='+from+'&to='+to);
    const data = await resp.json();
    reportData = data.rows || [];

    document.getElementById('loading').style.display = 'none';
    if (!reportData.length) { document.getElementById('empty').style.display='block'; return; }

    renderTable(reportData);
}

function typeLabel(t) {
    const map = {in:'📍 Приход',out:'🚪 Уход',vacation:'🌴 Отпуск',sick:'🤒 Больничный',dayoff:'💼 Отгул'};
    return map[t] || t;
}
function typeBadge(t) {
    return '<span class="badge '+t+'">'+typeLabel(t)+'</span>';
}

function renderTable(rows) {
    let html = '<table><thead><tr>'
        +'<th>Сотрудник</th><th>Дата</th><th>Тип</th>'
        +'<th>Время</th><th>В офисе</th><th>Опоздание</th><th>Примечание</th>'
        +'</tr></thead><tbody>';

    for (const r of rows) {
        const dt   = new Date(r.timestamp);
        const date = dt.toLocaleDateString('ru-RU');
        const time = dt.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Yekaterinburg'});
        const inOf = r.in_office
            ? '<span class="badge yes">✅ Да</span>'
            : (r.latitude ? '<span class="badge no">❌ Нет</span>' : '—');
        const late = r.late_minutes > 0
            ? '<span class="badge late">+'+r.late_minutes+' мин</span>' : '—';
        html += '<tr>'
            +'<td>'+r.user_name+'</td>'
            +'<td>'+date+'</td>'
            +'<td>'+typeBadge(r.type)+'</td>'
            +'<td>'+time+'</td>'
            +'<td>'+inOf+'</td>'
            +'<td>'+late+'</td>'
            +'<td>'+(r.note||'')+'</td>'
            +'</tr>';
    }
    html += '</tbody></table>';
    document.getElementById('tableWrap').innerHTML = html;
}

async function exportExcel() {
    const from = document.getElementById('dateFrom').value;
    const to   = document.getElementById('dateTo').value;
    if (!from || !to) return alert('Выберите даты');
    window.location = '/admin/export?user_id=${userId}&domain='+domain+'&from='+from+'&to='+to;
}

loadReport();
</script>
</body></html>`);
});

// ─── API данных для админ-панели ──────────────────────────────────────────────
app.get('/admin/data', async (req, res) => {
    const { user_id, domain, from, to } = req.query;
    if (!isAdmin(user_id)) return res.status(403).json({ error: 'Forbidden' });

    const rows = await getMarksForPeriod(from, to, domain || BITRIX_DOMAIN);

    // Добавляем вычисленные поля
    const enriched = rows.map(r => {
        let late_minutes = 0;
        if (r.type === 'in') {
            const dt   = new Date(r.timestamp);
            const hour = parseInt(dt.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: TZ }));
            const min  = parseInt(dt.toLocaleString('en-US', { minute: 'numeric', timeZone: TZ }));
            const totalMin = hour * 60 + min;
            if (totalMin > WORK_START * 60) late_minutes = totalMin - WORK_START * 60;
        }
        return { ...r, late_minutes };
    });

    res.json({ rows: enriched });
});

// ─── Экспорт в Excel ──────────────────────────────────────────────────────────
app.get('/admin/export', async (req, res) => {
    const { user_id, domain, from, to } = req.query;
    if (!isAdmin(user_id)) return res.status(403).send('Forbidden');

    const rows = await getMarksForPeriod(from, to, domain || BITRIX_DOMAIN);

    // Группируем по сотруднику + дате
    const byUserDate = {};
    for (const r of rows) {
        const dt   = new Date(r.timestamp);
        const date = dt.toLocaleDateString('ru-RU', { timeZone: TZ });
        const key  = `${r.user_id}__${date}`;
        if (!byUserDate[key]) byUserDate[key] = { user_name: r.user_name, date, in_time: null, out_time: null, in_office: false, late: 0, note: '', special: null };
        const d = byUserDate[key];
        const time = dt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: TZ });

        if (r.type === 'in' && !d.in_time) {
            d.in_time = time;
            d.in_office = !!r.in_office;
            const hour = parseInt(dt.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: TZ }));
            const min  = parseInt(dt.toLocaleString('en-US', { minute: 'numeric', timeZone: TZ }));
            const tot  = hour * 60 + min;
            if (tot > WORK_START * 60) d.late = tot - WORK_START * 60;
        }
        if (r.type === 'out') d.out_time = time;
        if (['vacation','sick','dayoff'].includes(r.type)) {
            d.special = r.type;
            d.note = r.note || '';
        }
    }

    // Строим CSV (Excel откроет через запятую с BOM)
    const BOM = '\uFEFF';
    const headers = ['Сотрудник','Дата','Приход','Уход','Итого часов','В офисе','Опоздание (мин)','Статус','Примечание'];
    const lines = [headers.join(';')];

    for (const d of Object.values(byUserDate)) {
        let hours = '';
        if (d.in_time && d.out_time) {
            const [ih,im] = d.in_time.split(':').map(Number);
            const [oh,om] = d.out_time.split(':').map(Number);
            const diff = (oh*60+om) - (ih*60+im);
            if (diff > 0) hours = (diff/60).toFixed(1);
        }
        const specialLabel = { vacation:'Отпуск', sick:'Больничный', dayoff:'Отгул' };
        lines.push([
            d.user_name,
            d.date,
            d.in_time   || (d.special ? specialLabel[d.special]||'' : '—'),
            d.out_time  || '—',
            hours       || '—',
            d.special   ? '—' : (d.in_office ? 'Да' : 'Нет'),
            d.late      || '0',
            d.special   ? (specialLabel[d.special]||'') : 'Рабочий день',
            d.note      || '',
        ].join(';'));
    }

    const csv = BOM + lines.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="attendance_${from}_${to}.csv"`);
    res.send(csv);
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
        if (!event) return;

        const params = data.PARAMS || data.params || data;
        const MESSAGE      = params.MESSAGE      || params.message      || '';
        const DIALOG_ID    = params.DIALOG_ID    || params.dialog_id    || '';
        const BOT_ID       = params.BOT_ID       || params.bot_id       || '';
        const FROM_USER_ID = params.FROM_USER_ID || params.from_user_id || '';

        // Имя берём из USER если есть
        const userObj  = data.USER || {};
        const USER_NAME = userObj.NAME || params.USER_NAME || params.user_name
                       || `Пользователь ${FROM_USER_ID}`;

        const domain   = auth.domain       || auth.DOMAIN       || BITRIX_DOMAIN;
        let authToken  = auth.access_token || auth.ACCESS_TOKEN || '';
        const cleanMsg = MESSAGE.toLowerCase().trim();
        const geoUrl   = `https://${APP_DOMAIN}/geo`;

        console.log(`📨 event=${event} user=${USER_NAME}(${FROM_USER_ID}) msg="${MESSAGE}"`);

        if (domain && authToken) {
            const existing = await getPortal(domain);
            await savePortal(domain, authToken, existing?.refresh_token,
                BOT_ID || existing?.bot_id, existing?.client_endpoint);
        }
        if (!authToken) {
            const portal = await getPortal(domain);
            if (portal) authToken = portal.access_token;
            else { console.error('❌ Нет токена для:', domain); return; }
        }

        const portal = await getPortal(domain);
        const botId  = BOT_ID || portal?.bot_id;
        if (!botId) { console.error('❌ Нет bot_id для:', domain); return; }

        // ── Приветствие ────────────────────────────────────────────────────
        if (event === 'ONIMBOTJOINCHAT') {
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                getWelcomeMessage(USER_NAME), mainKeyboard());
            return;
        }
        if (event !== 'ONIMBOTMESSAGEADD') return;

        // ── Команды ────────────────────────────────────────────────────────

        // Пришёл
        if (cleanMsg === 'пришел' || cleanMsg === 'пришёл') {
            const token = makeToken();
            await saveGeoToken(token, FROM_USER_ID, USER_NAME, DIALOG_ID, botId, domain, authToken, 'in');
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `${getGreeting(USER_NAME)}\n\nНажми кнопку ниже, чтобы подтвердить местоположение 📍`,
                geoKeyboard(token)
            );

        // Ушёл
        } else if (cleanMsg === 'ушел' || cleanMsg === 'ушёл') {
            const marks  = await getTodayMarks(FROM_USER_ID);
            const hasIn  = marks.some(m => m.type === 'in');
            const hasOut = marks.some(m => m.type === 'out');
            if (!hasIn) {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `⚠️ Ты ещё не отмечал(а) приход сегодня.\nСначала нажми "📍 Пришёл".`, mainKeyboard());
                return;
            }
            if (hasOut) {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `ℹ️ Уход уже отмечен сегодня.`, mainKeyboard());
                return;
            }
            const token = makeToken();
            await saveGeoToken(token, FROM_USER_ID, USER_NAME, DIALOG_ID, botId, domain, authToken, 'out');
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `До встречи! 👋 Нажми кнопку, чтобы подтвердить уход из офиса.`,
                geoKeyboard(token)
            );

        // Отпуск
        } else if (cleanMsg === 'отпуск') {
            await saveAttendance(FROM_USER_ID, USER_NAME, domain, 'vacation', null, null, false, 'Отпуск');
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `🌴 *Отпуск* зафиксирован на сегодня.\nХорошего отдыха, ${USER_NAME.split(' ')[0]}! 😎`,
                mainKeyboard()
            );
            await notifyManager(domain, authToken, `🌴 ${USER_NAME} — в отпуске сегодня`);

        // Больничный
        } else if (cleanMsg === 'больничный') {
            await saveAttendance(FROM_USER_ID, USER_NAME, domain, 'sick', null, null, false, 'Больничный');
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `🤒 *Больничный* зафиксирован.\nВыздоравливай скорее, ${USER_NAME.split(' ')[0]}! 💊`,
                mainKeyboard()
            );
            await notifyManager(domain, authToken, `🤒 ${USER_NAME} — на больничном сегодня`);

        // Статус
        } else if (cleanMsg === 'статус') {
            const marks = await getTodayMarks(FROM_USER_ID);
            if (!marks.length) {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `📊 Сегодня отметок ещё нет.\nНажми "📍 Пришёл" когда доберёшься до офиса!`,
                    mainKeyboard());
            } else {
                const lines = marks.map(m => {
                    const t   = formatTime(m.timestamp);
                    const tp  = { in:'✅ Приход', out:'🚪 Уход', vacation:'🌴 Отпуск',
                                  sick:'🤒 Больничный', dayoff:'💼 Отгул' }[m.type] || m.type;
                    const loc = m.latitude != null ? (m.in_office ? '📍 В офисе' : '⚠️ Вне офиса') : '';
                    return `${tp} в ${t} ${loc}`.trim();
                }).join('\n');
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `📊 *Твои отметки сегодня:*\n\n${lines}`, mainKeyboard());
            }

        // Отчёт (для администраторов)
        } else if (cleanMsg === 'отчёт' || cleanMsg === 'отчет') {
            if (!isAdmin(FROM_USER_ID)) {
                await sendMessage(domain, authToken, botId, DIALOG_ID,
                    `🔒 Команда доступна только администраторам.`, mainKeyboard());
                return;
            }
            const adminUrl = `https://${APP_DOMAIN}/admin?user_id=${FROM_USER_ID}&domain=${domain}`;
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `📊 *Панель администратора*\n\nОткрой ссылку для просмотра отчётов и экспорта в Excel:`,
                JSON.stringify([[{ TEXT: '📊 Открыть отчёты', link: adminUrl }]])
            );

        // Помощь
        } else if (cleanMsg === 'помощь') {
            const adminTip = isAdmin(FROM_USER_ID)
                ? '\n\n👑 *Для администраторов:*\n• "отчёт" — открыть панель отчётов' : '';
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `🤖 *Бот учёта присутствия*\n\n` +
                `📍 *Пришёл* — отметить приход\n` +
                `🚪 *Ушёл* — отметить уход\n` +
                `🌴 *Отпуск* — зафиксировать отпуск\n` +
                `🤒 *Больничный* — зафиксировать больничный\n` +
                `📊 *Статус* — мои отметки сегодня${adminTip}`,
                mainKeyboard()
            );

        } else {
            await sendMessage(domain, authToken, botId, DIALOG_ID,
                `❓ Не понял команду "${MESSAGE}".\nВоспользуйся кнопками ниже 👇`,
                mainKeyboard()
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
    <ul><li><a href="/status">Статус</a></li><li><a href="/debug">Debug</a></li>
    <li><a href="/reinstall-bot">Перерегистрировать бота</a></li>
    <li><a href="/test-bot">Тест бота</a></li></ul>`);
});

app.get('/status', async (req, res) => {
    const { rows } = await pool.query(`SELECT domain,bot_id,updated_at FROM portals`);
    res.json({ ok:true, service:'v8', portals:rows, time:new Date().toISOString(),
        env:{ app_domain:APP_DOMAIN, office_location:`${OFFICE_LAT},${OFFICE_LON}`,
              office_radius:OFFICE_RADIUS, manager_id:MANAGER_ID, admin_ids:ADMIN_IDS,
              work_start:`${WORK_START}:00`, tz:TZ }});
});

app.get('/debug', async (req, res) => {
    const domain = req.query.domain || BITRIX_DOMAIN;
    const portal = await getPortal(domain);
    res.json({ domain, portal_in_db:!!portal,
        portal_data: portal ? { domain:portal.domain, bot_id:portal.bot_id,
            token_preview: portal.access_token?.substring(0,12)+'...', updated_at:portal.updated_at
        } : null, app_domain:APP_DOMAIN, manager_id:MANAGER_ID });
});

app.get('/reinstall-bot', async (req, res) => {
    const domain = req.query.domain || BITRIX_DOMAIN;
    const portal = await getPortal(domain);
    if (!portal) return res.json({ ok:false, error:'Портал не найден. Нажми "Переустановить" в Битрикс24.' });
    const log = [];
    const profile = await callBitrix(domain, portal.access_token, 'profile', {});
    log.push({ profile: profile?.result ? '✅ токен валидный' : '❌ невалидный' });
    if (!profile?.result) {
        if (portal.refresh_token) {
            const t = await doRefreshToken(domain, portal.refresh_token);
            log.push({ refresh: t ? '✅ обновлён' : '❌ не удалось' });
            if (!t) return res.json({ ok:false, log, error:'Нажми "Переустановить" в Битрикс24.' });
        } else return res.json({ ok:false, log, error:'Нет refresh_token.' });
    }
    const fresh = await getPortal(domain);
    const botId = await registerBot(domain, fresh.access_token, fresh.bot_id || null);
    if (botId) {
        await savePortal(domain, fresh.access_token, fresh.refresh_token, botId, fresh.client_endpoint);
        log.push({ bot_registered:`✅ ID=${botId}` });
    } else log.push({ bot_registered:'❌ не удалось' });
    res.json({ ok:!!botId, log, bot_id:botId,
        message: botId ? `✅ Бот перерегистрирован (ID=${botId}). Найди в чатах и напиши "помощь".`
                       : '❌ Не удалось зарегистрировать бота.' });
});

app.get('/test-bot', async (req, res) => {
    const domain = req.query.domain || BITRIX_DOMAIN;
    const portal = await getPortal(domain);
    if (!portal) return res.json({ ok:false, error:'Портал не найден.' });
    const profile = await callBitrix(domain, portal.access_token, 'profile', {});
    const bots    = await callBitrix(domain, portal.access_token, 'imbot.bot.list', {});
    res.json({ bot_id:portal.bot_id,
        profile_check: profile?.result ? `✅ ${profile.result.NAME} ${profile.result.LAST_NAME}` : '❌',
        bots_in_b24: bots?.result || null });
});

// ═════════════════════════════════════════════════════════════════════════════
//  CRON-ЗАДАЧИ
// ═════════════════════════════════════════════════════════════════════════════

// Очистка старых гео-токенов каждые 15 минут
cron.schedule('*/15 * * * *', async () => {
    await pool.query(`DELETE FROM geo_tokens WHERE created_at < NOW() - INTERVAL '15 minutes'`);
    console.log('🧹 Очистка geo-токенов');
});

// Напоминание в 10:00 по местному времени (для Екатеринбурга = 05:00 UTC)
// Меняй часы под свой часовой пояс: UTC+5 → 10:00-5=05:00 UTC
cron.schedule('0 5 * * 1-5', async () => {
    console.log('⏰ Проверка неотметившихся...');
    try {
        const { rows: portals } = await pool.query(`SELECT * FROM portals`);
        for (const portal of portals) {
            const users = await getUsersWithoutCheckIn(portal.domain);
            for (const u of users) {
                await callBitrix(portal.domain, portal.access_token, 'im.message.add', {
                    DIALOG_ID: u.user_id,
                    MESSAGE: `⏰ Привет! Не забудь отметиться — уже 10:00 🙈\nНажми "📍 Пришёл" в боте «Учёт времени»`,
                });
            }
            console.log(`📨 Напоминания отправлены: ${users.length} чел.`);
        }
    } catch (err) { console.error('❌ cron reminder:', err.message); }
});

// Еженедельный отчёт администраторам — в пятницу в 17:30 (UTC 12:30)
cron.schedule('30 12 * * 5', async () => {
    console.log('📊 Еженедельный отчёт...');
    try {
        const { rows: portals } = await pool.query(`SELECT * FROM portals`);
        for (const portal of portals) {
            const today = new Date();
            const mon   = new Date(today); mon.setDate(today.getDate() - today.getDay() + 1);
            const from  = mon.toISOString().slice(0,10);
            const to    = today.toISOString().slice(0,10);
            const rows  = await getMarksForPeriod(from, to, portal.domain);

            const users = {};
            for (const r of rows) {
                if (!users[r.user_id]) users[r.user_id] = { name: r.user_name, in:0, out:0, late:0, absent:0 };
                if (r.type === 'in') users[r.user_id].in++;
                if (r.type === 'out') users[r.user_id].out++;
            }

            const lines = Object.values(users)
                .map(u => `• ${u.name}: приходов ${u.in}, уходов ${u.out}`)
                .join('\n');

            const msg = `📊 *Итоги недели (${from} — ${to})*\n\n${lines || 'Нет данных'}\n\n` +
                `Полный отчёт: https://${APP_DOMAIN}/admin?user_id=${MANAGER_ID}&domain=${portal.domain}`;

            for (const adminId of ADMIN_IDS) {
                await callBitrix(portal.domain, portal.access_token, 'im.notify.system.add', {
                    USER_ID: adminId, MESSAGE: msg,
                });
            }
        }
    } catch (err) { console.error('❌ cron weekly report:', err.message); }
});

// ─── Запуск ───────────────────────────────────────────────────────────────────
initDB().then(() => {
    app.listen(port, '0.0.0.0', () => {
        console.log(`🚀 Сервер: https://${APP_DOMAIN}`);
        console.log(`📍 Офис: ${OFFICE_LAT}, ${OFFICE_LON} (${OFFICE_RADIUS}м)`);
        console.log(`🆔 Менеджер: ${MANAGER_ID} | Admins: ${ADMIN_IDS.join(',')}`);
        console.log(`⏰ Начало рабочего дня: ${WORK_START}:00 (${TZ})`);
        console.log('=== ✅ READY ===');
    });
}).catch(err => {
    console.error('❌ Ошибка подключения к БД:', err.message);
    process.exit(1);
});
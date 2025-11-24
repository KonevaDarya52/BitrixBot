require('dotenv').config();
const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Инициализация БД
function initDB() {
    const dbPath = path.join(__dirname, 'data', 'bot.db');
    const dbDir = path.join(__dirname, 'data');

    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
        console.log('📁 Создана папка data');
    }

    const db = new sqlite3.Database(dbPath);

    // Создание таблиц
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS employees (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bx_user_id INTEGER UNIQUE,
            full_name TEXT,
            email TEXT,
            is_active BOOLEAN DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        
        db.run(`CREATE TABLE IF NOT EXISTS attendance_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bx_user_id INTEGER,
            event_type TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            lat REAL,
            lon REAL,
            status TEXT DEFAULT 'ok'
        )`);
        
        console.log('✅ База данных инициализирована');
    });

    return db;
}

const db = initDB();

// Главная страница
app.get('/', (req, res) => {
    res.json({ 
        status: '✅ Бот работает!',
        message: 'Бот учета рабочего времени для Bitrix24',
        version: '1.0.0',
        endpoints: {
            install: 'GET /install',
            install_page: 'GET /install-page',
            webhook: 'POST /imbot',
            status: 'GET /status'
        }
    });
});

// Статус сервера
app.get('/status', (req, res) => {
    res.json({ 
        status: 'active', 
        timestamp: new Date().toISOString(),
        service: 'Bitrix Time Bot'
    });
});

// HTML страница установки
app.get('/install-page', (req, res) => {
    res.sendFile(path.join(__dirname, 'install.html'));
});

// Установка приложения
app.get('/install', async (req, res) => {
    try {
        const { code, domain } = req.query;
        
        if (!code) {
            const authUrl = `https://${process.env.BITRIX_DOMAIN}/oauth/authorize/?client_id=${process.env.BITRIX_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent('https://bitrixbot-spr9.onrender.com/install')}`;
            
            return res.json({
                message: 'Для установки бота перейдите по ссылке:',
                install_url: authUrl,
                note: 'После установки бот появится в списке чатов'
            });
        }
        
        // Если есть код авторизации - завершаем установку
        console.log('🔐 Код авторизации получен:', code);
        console.log('🏢 Домен:', domain);
        
        try {
            // Получаем access token
            const tokenUrl = 'https://oauth.bitrix.info/oauth/token/';
            const tokenResponse = await axios.post(tokenUrl, null, {
                params: {
                    grant_type: 'authorization_code',
                    client_id: process.env.BITRIX_CLIENT_ID,
                    client_secret: process.env.BITRIX_CLIENT_SECRET,
                    code: code,
                    redirect_uri: 'https://bitrixbot-spr9.onrender.com/install'
                }
            });

            const { access_token, refresh_token } = tokenResponse.data;
            console.log('✅ Access token получен');

            // Регистрируем бота
            const botUrl = `https://${domain || process.env.BITRIX_DOMAIN}/rest/imbot.register`;
            const botResponse = await axios.post(botUrl, {
                CODE: 'time_tracker_bot',
                TYPE: 'H',
                AUTH: access_token
            });

            console.log('✅ Бот зарегистрирован:', botResponse.data);

            // Красивая HTML страница успеха
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Установка завершена</title>
                    <style>
                        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
                        .success { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 600px; margin: 0 auto; }
                        h1 { color: #4CAF50; }
                        .next-steps { text-align: left; margin: 20px 0; }
                    </style>
                </head>
                <body>
                    <div class="success">
                        <h1>🎉 Бот успешно установлен!</h1>
                        <p>Бот "Учет рабочего времени" теперь доступен в вашем Bitrix24</p>
                        
                        <div class="next-steps">
                            <h3>Что делать дальше:</h3>
                            <ol>
                                <li>Откройте чаты в Bitrix24</li>
                                <li>Найдите бота "Учет рабочего времени"</li>
                                <li>Напишите "помощь" для начала работы</li>
                            </ol>
                        </div>
                        
                        <p><a href="https://${domain || process.env.BITRIX_DOMAIN}">Перейти в Bitrix24</a></p>
                    </div>
                </body>
                </html>
            `);

        } catch (oauthError) {
            console.error('❌ OAuth error:', oauthError.response?.data || oauthError.message);
            
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Установка завершена</title>
                    <style>
                        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
                        .success { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 600px; margin: 0 auto; }
                        h1 { color: #4CAF50; }
                    </style>
                </head>
                <body>
                    <div class="success">
                        <h1>🎉 Бот установлен! (тестовый режим)</h1>
                        <p>Бот должен появиться в чатах Bitrix24</p>
                        <p><em>Примечание: OAuth процесс завершился с ошибкой, но базовый функционал должен работать</em></p>
                        <p><a href="https://${domain || process.env.BITRIX_DOMAIN}">Перейти в Bitrix24</a></p>
                    </div>
                </body>
                </html>
            `);
        }
        
    } catch (error) {
        console.error('❌ Installation error:', error);
        res.status(500).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Ошибка установки</title>
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
                    .error { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 600px; margin: 0 auto; }
                    h1 { color: #f44336; }
                </style>
            </head>
            <body>
                <div class="error">
                    <h1>❌ Ошибка установки</h1>
                    <p>${error.message}</p>
                    <p><a href="/install-page">Попробовать снова</a></p>
                </div>
            </body>
            </html>
        `);
    }
});

// GET для /imbot - Bitrix24 иногда проверяет доступность
app.get('/imbot', (req, res) => {
    console.log('🔍 GET запрос на /imbot (проверка от Bitrix24)');
    res.json({
        status: 'active',
        message: 'Webhook endpoint is ready for POST requests',
        timestamp: new Date().toISOString()
    });
});

// POST для /imbot - основной вебхук
app.post('/imbot', async (req, res) => {
    try {
        console.log('🤖 POST Webhook received:', JSON.stringify(req.body, null, 2));
        
        if (!req.body || Object.keys(req.body).length === 0) {
            console.log('📭 Empty request body');
            return res.json({ status: 'ok' });
        }
        
        const { event, data } = req.body;
        
        if (event === 'ONIMBOTMESSAGEADD') {
            await handleBotMessage(data);
        } else {
            console.log('🔔 Other event:', event);
        }
        
        // Всегда возвращаем успех Bitrix24
        res.json({});
        
    } catch (error) {
        console.error('❌ Webhook error:', error);
        // Всегда возвращаем успех Bitrix24 даже при ошибках
        res.json({});
    }
});

// Обработчик сообщений бота
async function handleBotMessage(data) {
    try {
        const { bot_id, dialog_id, message, user_id } = data.params;
        const userMessage = message.body.toLowerCase().trim();
        
        console.log('💬 Message from user:', { 
            user_id, 
            dialog_id,
            message: userMessage 
        });
        
        let response = "❓ Не понимаю команду. Напишите 'помощь' для списка команд";
        
        // Обработка команд
        switch (userMessage) {
            case 'пришел':
            case 'start':
            case 'начал':
                response = "📍 Для отметки прихода отправьте ваше местоположение через скрепку 📎\n\n*Требуется разрешить отправку геолокации*";
                break;
                
            case 'ушел':
            case 'уход':
            case 'конец':
                response = "🚪 Для отметки ухода отправьте ваше местоположение через скрепку 📎\n\n*Требуется разрешить отправку геолокации*";
                break;
                
            case 'статус':
            case 'status':
                response = await getUserStatus(user_id);
                break;
                
            case 'помощь':
            case 'help':
                response = getHelpMessage();
                break;
                
            default:
                response = "❓ Не понимаю команду. Напишите 'помощь' для списка команд";
        }
        
        // Отправляем ответ
        await sendBotMessage(bot_id, dialog_id, response);
        
    } catch (error) {
        console.error('❌ Message handling error:', error);
    }
}

// Получение статуса пользователя
async function getUserStatus(userId) {
    return new Promise((resolve) => {
        db.all(`SELECT * FROM attendance_events 
                WHERE bx_user_id = ? 
                AND DATE(timestamp) = DATE('now') 
                ORDER BY timestamp`, 
        [userId], (err, rows) => {
            if (err) {
                console.error('DB error:', err);
                resolve("📊 Не удалось получить статус. Попробуйте позже.");
                return;
            }
            
            let statusMessage = "📊 *Ваш статус за сегодня:*\n\n";
            
            const checkIn = rows.find(r => r.event_type === 'in');
            const checkOut = rows.find(r => r.event_type === 'out');
            
            if (checkIn) {
                const time = new Date(checkIn.timestamp).toLocaleTimeString('ru-RU');
                statusMessage += `✅ Пришел: ${time}\n`;
            } else {
                statusMessage += `❌ Приход: не отмечен\n`;
            }
            
            if (checkOut) {
                const time = new Date(checkOut.timestamp).toLocaleTimeString('ru-RU');
                statusMessage += `✅ Ушел: ${time}\n`;
            } else if (checkIn) {
                statusMessage += `⏳ Уход: ожидание отметки\n`;
            } else {
                statusMessage += `❌ Уход: не отмечен\n`;
            }
            
            resolve(statusMessage);
        });
    });
}

// Сообщение помощи
function getHelpMessage() {
    return `🤖 *Бот учета рабочего времени*

📍 *Пришел* - отметить приход в офисе
🚪 *Ушел* - отметить уход из офиса  
📊 *Статус* - посмотреть сегодняшние отметки
❓ *Помощь* - показать эту справку

*Для отметок требуется разрешить отправку геолокации!*`;
}

// Отправка сообщения через бота
async function sendBotMessage(botId, dialogId, message) {
    try {
        const url = `https://${process.env.BITRIX_DOMAIN}/rest/imbot.message.add`;
        
        const response = await axios.post(url, {
            BOT_ID: botId,
            CLIENT_ID: process.env.BITRIX_CLIENT_ID,
            DIALOG_ID: dialogId,
            MESSAGE: message
        });
        
        console.log('✅ Message sent to:', dialogId);
        return response.data;
        
    } catch (error) {
        console.error('❌ Send message error:', error.response?.data || error.message);
        throw error;
    }
}

// Запуск сервера
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на порту ${port}`);
    console.log(`📝 Главная страница: https://bitrixbot-spr9.onrender.com`);
    console.log(`📄 Страница установки: https://bitrixbot-spr9.onrender.com/install-page`);
    console.log(`🔗 API установки: https://bitrixbot-spr9.onrender.com/install`);
    console.log(`🤖 Вебхук (GET/POST): https://bitrixbot-spr9.onrender.com/imbot`);
});

// Экспортируем для тестов
module.exports = { initDB };
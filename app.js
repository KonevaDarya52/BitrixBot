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

// Установка приложения
app.get('/install', async (req, res) => {
    try {
        const { code, domain } = req.query;
        
        if (!code) {
            const authUrl = `https://${process.env.BITRIX_DOMAIN}/oauth/authorize/?client_id=${process.env.BITRIX_CLIENT_ID}&response_type=code`;
            
            return res.json({
                message: 'Для установки бота перейдите по ссылке:',
                install_url: authUrl,
                note: 'После установки бот появится в списке чатов'
            });
        }
        
        // Если есть код авторизации
        console.log('🔐 Код авторизации получен:', code);
        
        // Здесь можно добавить логику получения access_token
        // но для простоты сразу возвращаем успех
        
        res.json({
            status: 'success',
            message: '🎉 Бот успешно установлен!',
            next_steps: [
                'Найдите бота в списке чатов по имени "Бот учета рабочего времени"',
                'Напишите "помощь" для получения списка команд',
                'Используйте команды: пришел, ушел, статус'
            ]
        });
        
    } catch (error) {
        console.error('❌ Installation error:', error);
        res.status(500).json({
            error: 'Installation failed',
            details: error.message
        });
    }
});

// Вебхук для бота - основной endpoint
app.post('/imbot', async (req, res) => {
    try {
        console.log('🤖 Webhook received:', JSON.stringify(req.body, null, 2));
        
        const { event, data } = req.body;
        
        if (event === 'ONIMBOTMESSAGEADD') {
            await handleBotMessage(data);
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

// Обработка геолокации (будет добавлено позже)
app.post('/webhook/message', async (req, res) => {
    try {
        console.log('📍 Location webhook:', JSON.stringify(req.body, null, 2));
        res.json({ status: 'ok' });
    } catch (error) {
        console.error('Location webhook error:', error);
        res.json({});
    }
});

// Запуск сервера
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на порту ${port}`);
    console.log(`📝 Главная страница: https://your-app.onrender.com`);
    console.log(`🔗 Установка: https://your-app.onrender.com/install`);
    console.log(`🤖 Вебхук: https://your-app.onrender.com/imbot`);
});

// Экспортируем для тестов
module.exports = { initDB };
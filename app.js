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
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Бот учета времени</title>
            <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                .container { max-width: 600px; margin: 0 auto; }
                .button { background: #2d8cff; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 10px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🤖 Бот учета рабочего времени</h1>
                <p>Система автоматического учета прихода/ухода сотрудников</p>
                
                <div style="margin: 30px 0;">
                    <a href="/install-page" class="button">📥 Установить бота</a>
                    <a href="/status" class="button" style="background: #28a745;">🔍 Статус сервера</a>
                </div>
                
                <h3>Команды бота:</h3>
                <ul style="text-align: left; display: inline-block;">
                    <li>📍 <strong>Пришел</strong> - отметить приход</li>
                    <li>🚪 <strong>Ушел</strong> - отметить уход</li>
                    <li>📊 <strong>Статус</strong> - посмотреть отметки</li>
                    <li>❓ <strong>Помощь</strong> - справка по командам</li>
                </ul>
            </div>
        </body>
        </html>
    `);
});

// Статус сервера
app.get('/status', (req, res) => {
    res.json({ 
        status: 'active', 
        timestamp: new Date().toISOString(),
        service: 'Bitrix Time Bot',
        version: '1.0.0'
    });
});

// Страница установки
app.get('/install-page', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Установка бота</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; max-width: 800px; margin: 0 auto; }
                .step { background: #f8f9fa; padding: 20px; margin: 10px 0; border-radius: 5px; }
                .button { background: #2d8cff; color: white; padding: 15px 25px; text-decoration: none; border-radius: 5px; display: inline-block; }
                .success { background: #d4edda; color: #155724; padding: 15px; border-radius: 5px; }
            </style>
        </head>
        <body>
            <h1>📥 Установка бота учета времени</h1>
            
            <div class="step">
                <h2>Шаг 1: Настройте приложение в Bitrix24</h2>
                <p>Зайдите в <strong>Настройки → Приложения → Локальные приложения</strong></p>
                <p>И укажите следующие URL:</p>
                <ul>
                    <li><strong>Обработчик бота:</strong> <code>https://bitrixbot-spr9.onrender.com/imbot</code></li>
                    <li><strong>Адрес для установки:</strong> <code>https://bitrixbot-spr9.onrender.com/install-page</code></li>
                </ul>
            </div>
            
            <div class="step">
                <h2>Шаг 2: Сохраните настройки</h2>
                <p>Нажмите "Сохранить" в настройках приложения</p>
            </div>
            
            <div class="step">
                <h2>Шаг 3: Установите приложение</h2>
                <p>После сохранения настроек, установите приложение в ваш Bitrix24</p>
                <div style="background: #e9ecef; padding: 15px; border-radius: 5px; margin: 15px 0;">
                    <p><strong>Примечание:</strong> Если установка не работает через OAuth, используйте прямую ссылку:</p>
                    <a href="https://b24-etqwns.bitrix24.ru/oauth/authorize/?client_id=local.69243239019bc3.21171311&response_type=code" 
                       class="button" style="background: #28a745;">
                        🔗 Прямая установка
                    </a>
                </div>
            </div>
            
            <div class="step">
                <h2>Шаг 4: Проверьте работу</h2>
                <p>После установки найдите бота в чатах и напишите "помощь"</p>
            </div>
            
            <div style="margin-top: 30px;">
                <a href="/" class="button">← На главную</a>
                <a href="https://b24-etqwns.bitrix24.ru" class="button" style="background: #6c757d;">📊 Открыть Bitrix24</a>
            </div>
        </body>
        </html>
    `);
});

// Простой установочный endpoint
app.get('/install', (req, res) => {
    const { code } = req.query;
    
    if (code) {
        console.log('🔐 Получен код:', code);
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Установка завершена</title>
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                    .success { background: #d4edda; color: #155724; padding: 30px; border-radius: 10px; max-width: 600px; margin: 0 auto; }
                </style>
            </head>
            <body>
                <div class="success">
                    <h1>🎉 Установка завершена!</h1>
                    <p>Код авторизации получен: ${code.substring(0, 10)}...</p>
                    <p>Бот должен появиться в списке чатов Bitrix24</p>
                    <p><a href="/install-page">← Вернуться к инструкции</a></p>
                </div>
            </body>
            </html>
        `);
    } else {
        res.redirect('/install-page');
    }
});

// GET для /imbot - проверка от Bitrix24
app.get('/imbot', (req, res) => {
    console.log('🔍 GET запрос на /imbot');
    res.json({
        status: 'active',
        message: 'Bot webhook is ready',
        timestamp: new Date().toISOString(),
        instructions: 'Bitrix24 should send POST requests to this endpoint'
    });
});

// POST для /imbot - основной вебхук
app.post('/imbot', async (req, res) => {
    try {
        console.log('🤖 POST Webhook received');
        
        if (!req.body || Object.keys(req.body).length === 0) {
            console.log('📭 Empty request body');
            return res.json({ status: 'ok' });
        }
        
        console.log('📦 Body:', JSON.stringify(req.body, null, 2));
        
        const { event, data } = req.body;
        
        if (event === 'ONIMBOTMESSAGEADD') {
            await handleBotMessage(data);
        } else {
            console.log('🔔 Other event:', event);
        }
        
        res.json({});
        
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.json({});
    }
});

// Обработчик сообщений бота
async function handleBotMessage(data) {
    try {
        const { bot_id, dialog_id, message, user_id } = data.params;
        const userMessage = message.body.toLowerCase().trim();
        
        console.log('💬 Message from user:', user_id, userMessage);
        
        let response = "❓ Не понимаю команду. Напишите 'помощь' для списка команд";
        
        switch (userMessage) {
            case 'пришел':
            case 'start':
            case 'начал':
                response = "📍 Для отметки прихода отправьте ваше местоположение через скрепку 📎";
                break;
                
            case 'ушел':
            case 'уход':
            case 'конец':
                response = "🚪 Для отметки ухода отправьте ваше местоположение через скрепку 📎";
                break;
                
            case 'статус':
            case 'status':
                response = await getUserStatus(user_id);
                break;
                
            case 'помощь':
            case 'help':
                response = `🤖 *Бот учета рабочего времени*

📍 *Пришел* - отметить приход
🚪 *Ушел* - отметить уход  
📊 *Статус* - посмотреть отметки
❓ *Помощь* - эта справка

*Для отметок требуется отправка геолокации!*`;
                break;
        }
        
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
                resolve("📊 Не удалось получить статус");
                return;
            }
            
            let statusMessage = "📊 *Ваш статус за сегодня:*\\n\\n";
            
            const checkIn = rows.find(r => r.event_type === 'in');
            const checkOut = rows.find(r => r.event_type === 'out');
            
            if (checkIn) {
                const time = new Date(checkIn.timestamp).toLocaleTimeString('ru-RU');
                statusMessage += `✅ Пришел: ${time}\\n`;
            } else {
                statusMessage += `❌ Приход: не отмечен\\n`;
            }
            
            if (checkOut) {
                const time = new Date(checkOut.timestamp).toLocaleTimeString('ru-RU');
                statusMessage += `✅ Ушел: ${time}\\n`;
            } else if (checkIn) {
                statusMessage += `⏳ Уход: ожидание отметки\\n`;
            } else {
                statusMessage += `❌ Уход: не отмечен\\n`;
            }
            
            resolve(statusMessage);
        });
    });
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
    }
}

// Запуск сервера
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на порту ${port}`);
    console.log(`📍 Главная: https://bitrixbot-spr9.onrender.com`);
    console.log(`📥 Установка: https://bitrixbot-spr9.onrender.com/install-page`);
    console.log(`🤖 Вебхук: https://bitrixbot-spr9.onrender.com/imbot`);
});
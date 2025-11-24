require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Главная страница
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Бот учета времени - Bitrix24</title>
            <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                .container { max-width: 600px; margin: 0 auto; }
                .button { background: #2d8cff; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 10px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🤖 Бот учета рабочего времени</h1>
                <p>Локальное приложение Bitrix24 для учета сотрудников</p>
                
                <div style="margin: 30px 0;">
                    <a href="/install" class="button">🚀 Начать установку</a>
                </div>
                
                <div style="text-align: left; background: #f8f9fa; padding: 20px; border-radius: 10px;">
                    <h3>📋 Как установить:</h3>
                    <ol>
                        <li>Нажмите "Начать установку"</li>
                        <li>Авторизуйтесь в Bitrix24</li>
                        <li>Бот автоматически зарегистрируется</li>
                        <li>Найдите бота в чатах</li>
                    </ol>
                </div>
            </div>
        </body>
        </html>
    `);
});

// Страница установки через OAuth
app.get('/install', async (req, res) => {
    const { code, domain } = req.query;
    
    if (!code) {
        // Первый шаг - перенаправляем на авторизацию
        const authUrl = `https://${process.env.BITRIX_DOMAIN}/oauth/authorize/?client_id=${process.env.BITRIX_CLIENT_ID}&response_type=code`;
        return res.redirect(authUrl);
    }
    
    try {
        // Второй шаг - получаем access token
        const tokenUrl = 'https://oauth.bitrix.info/oauth/token/';
        const tokenResponse = await axios.post(tokenUrl, null, {
            params: {
                grant_type: 'authorization_code',
                client_id: process.env.BITRIX_CLIENT_ID,
                client_secret: process.env.BITRIX_CLIENT_SECRET,
                code: code
            }
        });

        const { access_token, refresh_token } = tokenResponse.data;
        console.log('✅ Access token получен');

        // Регистрируем бота через REST API
        const botResponse = await axios.post(`https://${domain}/rest/imbot.register`, {
            CODE: 'time.tracker.bot',
            TYPE: 'H',
            AUTH: access_token
        });

        console.log('✅ Бот зарегистрирован:', botResponse.data);

        // Показываем страницу успеха
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Установка завершена</title>
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                    .success { background: #d4edda; color: #155724; padding: 30px; border-radius: 10px; max-width: 600px; margin: 0 auto; }
                    .button { background: #2d8cff; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 10px; }
                </style>
            </head>
            <body>
                <div class="success">
                    <h1>🎉 Бот успешно установлен!</h1>
                    <p><strong>Бот "Учет рабочего времени" зарегистрирован в вашем Bitrix24</strong></p>
                    
                    <div style="text-align: left; margin: 20px 0; padding: 20px; background: #c3e6cb; border-radius: 5px;">
                        <h3>🚀 Что делать дальше:</h3>
                        <ol>
                            <li>Откройте чаты в Bitrix24</li>
                            <li>Найдите бота "Учет рабочего времени"</li>
                            <li>Напишите "помощь" для начала работы</li>
                        </ol>
                    </div>
                    
                    <div>
                        <a href="https://${domain}" class="button">📱 Перейти в Bitrix24</a>
                        <a href="/" class="button" style="background: #6c757d;">🏠 На главную</a>
                    </div>
                </div>
            </body>
            </html>
        `);

    } catch (error) {
        console.error('❌ Ошибка установки:', error.response?.data || error.message);
        
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Ошибка установки</title>
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                    .error { background: #f8d7da; color: #721c24; padding: 30px; border-radius: 10px; max-width: 600px; margin: 0 auto; }
                </style>
            </head>
            <body>
                <div class="error">
                    <h1>❌ Ошибка установки</h1>
                    <p>${error.response?.data?.error_description || error.message}</p>
                    <p><a href="/">Попробовать снова</a></p>
                </div>
            </body>
            </html>
        `);
    }
});

// Вебхук для бота
app.post('/imbot', async (req, res) => {
    try {
        console.log('🤖 Webhook received:', JSON.stringify(req.body, null, 2));
        
        const { data, event } = req.body;
        
        if (event === 'ONIMBOTMESSAGEADD') {
            await handleBotMessage(data);
        }
        
        res.json({ result: 'ok' });
        
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.json({ result: 'ok' });
    }
});

// Обработчик сообщений
async function handleBotMessage(data) {
    try {
        const { PARAMS } = data;
        const { BOT_ID, DIALOG_ID, MESSAGE, FROM_USER_ID } = PARAMS;
        
        console.log('💬 Message from user:', FROM_USER_ID, MESSAGE);
        
        const cleanMessage = MESSAGE.toLowerCase().trim();
        let response = '';
        
        switch (cleanMessage) {
            case 'пришел':
                response = `📍 Для отметки прихода отправьте ваше местоположение через скрепку 📎`;
                break;
                
            case 'ушел':
                response = `🚪 Для отметки ухода отправьте ваше местоположение через скрепку 📎`;
                break;
                
            case 'статус':
                response = `📊 *Ваш статус за сегодня:*

✅ Пришел: не отмечен
✅ Ушел: не отмечен

📍 Используйте команду "пришел" для отметки`;
                break;
                
            case 'помощь':
            case 'help':
                response = `🤖 *Бот учета рабочего времени*

*Команды:*
📍 пришел - отметить приход
🚪 ушел - отметить уход  
📊 статус - посмотреть отметки
❓ помощь - эта справка

*Для отметок требуется отправка геолокации!*`;
                break;
                
            default:
                response = `❓ Не понимаю команду. Напишите "помощь" для списка команд`;
        }
        
        // Отправляем ответ
        await sendBotMessage(BOT_ID, DIALOG_ID, response);
        
    } catch (error) {
        console.error('❌ Message handling error:', error);
    }
}

// Отправка сообщения ботом
async function sendBotMessage(botId, dialogId, message) {
    try {
        const url = `https://${process.env.BITRIX_DOMAIN}/rest/imbot.message.add`;
        
        await axios.post(url, {
            BOT_ID: botId,
            DIALOG_ID: dialogId,
            MESSAGE: message
        });
        
        console.log('✅ Message sent successfully');
        
    } catch (error) {
        console.error('❌ Send message error:', error.response?.data || error.message);
    }
}

// GET для проверки
app.get('/imbot', (req, res) => {
    res.json({ 
        status: 'active', 
        message: 'Bot webhook is ready',
        timestamp: new Date().toISOString()
    });
});

// Статус
app.get('/status', (req, res) => {
    res.json({ 
        status: 'active', 
        timestamp: new Date().toISOString(),
        service: 'Bitrix24 Time Tracker Bot'
    });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Server started on port ${port}`);
    console.log(`📍 Main: https://bitrixbot-spr9.onrender.com`);
    console.log(`📥 Install: https://bitrixbot-spr9.onrender.com/install`);
    console.log(`🤖 Webhook: https://bitrixbot-spr9.onrender.com/imbot`);
});
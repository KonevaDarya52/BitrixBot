require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 10000;

app.use(express.json());

// Главная страница - ДОЛЖНА РАБОТАТЬ
app.get('/', (req, res) => {
    console.log('📍 Главная страница запрошена');
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

// УСТАНОВКА - ОЧЕНЬ ВАЖНО: этот маршрут должен быть ОТДЕЛЬНЫМ
app.get('/install', (req, res) => {
    console.log('📥 INSTALL route called - STEP 1');
    const { code } = req.query;
    
    if (!code) {
        console.log('🔐 No code - redirecting to OAuth');
        const redirectUri = 'https://bitrixbot-spr9.onrender.com/install';
        const authUrl = `https://${process.env.BITRIX_DOMAIN}/oauth/authorize/?client_id=${process.env.BITRIX_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}`;
        console.log('🔗 Redirect to OAuth:', authUrl);
        return res.redirect(authUrl);
    }
    
    // Если есть код - обрабатываем OAuth callback
    console.log('🔄 Processing OAuth callback with code');
    handleOAuthCallback(code, res);
});

// Функция обработки OAuth callback
async function handleOAuthCallback(code, res) {
    try {
        console.log('🔐 Getting access token with code:', code.substring(0, 10) + '...');
        
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

        const { access_token, refresh_token, domain } = tokenResponse.data;
        console.log('✅ Access token получен для домена:', domain);

        // Регистрируем бота
        const botResponse = await axios.post(`https://${domain}/rest/imbot.register`, {
            CODE: 'time.tracker.bot',
            TYPE: 'H',
            EVENT_MESSAGE_ADD: 'https://bitrixbot-spr9.onrender.com/imbot',
            EVENT_WELCOME_MESSAGE: 'https://bitrixbot-spr9.onrender.com/imbot',
            EVENT_BOT_DELETE: 'https://bitrixbot-spr9.onrender.com/imbot',
            PROPERTIES: {
                NAME: 'Учет времени',
                COLOR: 'GREEN',
                WORK_POSITION: 'Бот для учета рабочего времени сотрудников'
            }
        }, {
            params: { auth: access_token }
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
}

// Вебхук для бота - POST запросы
app.post('/imbot', async (req, res) => {
    try {
        console.log('🤖 Webhook received:', req.body.event);
        
        const { data, event, auth } = req.body;
        
        if (event === 'ONIMBOTMESSAGEADD') {
            await handleBotMessage(data, auth);
        } else if (event === 'ONAPPINSTALL') {
            await handleAppInstall(data, auth);
        } else if (event === 'ONIMBOTJOINCHAT') {
            await handleWelcomeMessage(data, auth);
        }
        
        res.json({ result: 'ok' });
        
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.json({ result: 'ok' });
    }
});

// GET для /imbot (только для проверки)
app.get('/imbot', (req, res) => {
    res.json({ 
        status: 'active', 
        message: 'Bot webhook is ready for POST requests',
        timestamp: new Date().toISOString(),
        note: 'This endpoint should receive POST requests from Bitrix24'
    });
});

// Обработчик установки приложения
async function handleAppInstall(data, auth) {
    try {
        const botResponse = await axios.post(`https://${auth.domain}/rest/imbot.register`, {
            CODE: 'time.tracker.bot',
            TYPE: 'H',
            EVENT_MESSAGE_ADD: 'https://bitrixbot-spr9.onrender.com/imbot',
            EVENT_WELCOME_MESSAGE: 'https://bitrixbot-spr9.onrender.com/imbot',
            EVENT_BOT_DELETE: 'https://bitrixbot-spr9.onrender.com/imbot',
            PROPERTIES: {
                NAME: 'Учет времени',
                COLOR: 'GREEN',
                WORK_POSITION: 'Бот для учета рабочего времени сотрудников'
            }
        }, {
            params: { auth: auth.access_token }
        });
        
        console.log('✅ Бот зарегистрирован при установке:', botResponse.data);
        
    } catch (error) {
        console.error('❌ Bot registration error:', error.response?.data || error.message);
    }
}

// Приветственное сообщение
async function handleWelcomeMessage(data, auth) {
    try {
        const { PARAMS } = data;
        const { DIALOG_ID } = PARAMS;
        
        const welcomeMessage = `🤖 Добро пожаловать в бот учета рабочего времени!

Для работы используйте команды:
📍 "пришел" - отметить приход в офис
🚪 "ушел" - отметить уход из офиса  
📊 "статус" - посмотреть сегодняшние отметки
❓ "помощь" - справка по командам

Для отметок требуется отправка геолокации через скрепку 📎`;
        
        await axios.post(`https://${auth.domain}/rest/imbot.message.add`, {
            DIALOG_ID: DIALOG_ID,
            MESSAGE: welcomeMessage
        }, {
            params: { auth: auth.access_token }
        });
        
        console.log('✅ Приветственное сообщение отправлено');
        
    } catch (error) {
        console.error('❌ Welcome message error:', error);
    }
}

// Обработчик сообщений
async function handleBotMessage(data, auth) {
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
                response = `🤖 *Бот учета рабочего времени*

*Команды:*
📍 пришел - отметить приход
🚪 ушел - отметить уход  
📊 статус - посмотреть отметки
❓ помощь - эта справка

*Для отметок требуется отправка геолокации через скрепку 📎*`;
                break;
            default:
                response = `❓ Не понимаю команду. Напишите "помощь" для списка команд`;
        }
        
        await sendBotMessage(BOT_ID, DIALOG_ID, response, auth);
        
    } catch (error) {
        console.error('❌ Message handling error:', error);
    }
}

// Отправка сообщения ботом
async function sendBotMessage(botId, dialogId, message, auth) {
    try {
        await axios.post(`https://${auth.domain}/rest/imbot.message.add`, {
            BOT_ID: botId,
            DIALOG_ID: dialogId,
            MESSAGE: message
        }, {
            params: { auth: auth.access_token }
        });
        
        console.log('✅ Message sent successfully');
        
    } catch (error) {
        console.error('❌ Send message error:', error.response?.data || error.message);
    }
}

// Статус
app.get('/status', (req, res) => {
    res.json({ 
        status: 'active', 
        timestamp: new Date().toISOString(),
        service: 'Bitrix24 Time Tracker Bot'
    });
});

// Дебаг
app.get('/debug', (req, res) => {
    res.json({
        message: 'Debug endpoint - ALL ROUTES SHOULD WORK',
        routes: {
            main: '/',
            install: '/install',
            webhook: '/imbot (POST)',
            status: '/status',
            debug: '/debug'
        },
        environment: {
            BITRIX_DOMAIN: process.env.BITRIX_DOMAIN || 'NOT SET',
            BITRIX_CLIENT_ID: process.env.BITRIX_CLIENT_ID ? 'SET' : 'NOT SET',
            PORT: process.env.PORT
        },
        timestamp: new Date().toISOString()
    });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Server started on port ${port}`);
    console.log(`📍 Main: https://bitrixbot-spr9.onrender.com`);
    console.log(`📥 Install: https://bitrixbot-spr9.onrender.com/install`);
    console.log(`🤖 Webhook: https://bitrixbot-spr9.onrender.com/imbot`);
    console.log(`🔧 Debug: https://bitrixbot-spr9.onrender.com/debug`);
    console.log(`📊 Status: https://bitrixbot-spr9.onrender.com/status`);
});
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { markAttendance, getTodayAttendance } = require('./database');

const app = express();
const port = process.env.PORT || 10000;

// Константы
const APP_DOMAIN = 'bitrixbot-bnnd.onrender.com';
const REDIRECT_URI = `https://${APP_DOMAIN}/install`;

app.use(express.json());

// ВАЖНО: Этот middleware должен быть ПЕРВЫМ
app.use((req, res, next) => {
    console.log(`📍 ${new Date().toISOString()} ${req.method} ${req.url}`);
    next();
});

// Главная страница
app.get('/', (req, res) => {
    console.log('🎯 Serving main page');
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

// УСТАНОВКА - отдельный маршрут
app.get('/install', async (req, res) => {
    console.log('🎯 Serving install page');
    const { code, domain } = req.query;
    
    if (!code) {
        console.log('🔐 No code - redirecting to OAuth');
        const authUrl = `https://${process.env.BITRIX_DOMAIN}/oauth/authorize/?client_id=${process.env.BITRIX_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
        console.log('🔗 Redirect to:', authUrl);
        return res.redirect(authUrl);
    }
    
    console.log('🔄 Processing OAuth callback with code:', code);
    console.log('🏢 Domain:', domain);
    
    try {
        // Получаем access token
        const tokenUrl = 'https://oauth.bitrix.info/oauth/token/';
        const tokenResponse = await axios.post(tokenUrl, null, {
            params: {
                grant_type: 'authorization_code',
                client_id: process.env.BITRIX_CLIENT_ID,
                client_secret: process.env.BITRIX_CLIENT_SECRET,
                code: code,
                redirect_uri: REDIRECT_URI
            }
        });

        const { access_token, refresh_token, expires_in, member_id } = tokenResponse.data;
        console.log('✅ Access token получен');
        console.log('🏢 Domain:', domain);
        console.log('👤 Member ID:', member_id);
        console.log('⏰ Expires in:', expires_in);

        // Сохраняем токены (в реальном приложении - в базу данных)
        // Для демо просто выводим
        process.env[`TOKEN_${domain}`] = access_token;
        process.env[`REFRESH_${domain}`] = refresh_token;

        // Регистрируем бота
        const botResponse = await axios.post(`https://${domain}/rest/imbot.register`, {
            CODE: 'time.tracker.bot',
            TYPE: 'H',
            EVENT_MESSAGE_ADD: `https://${APP_DOMAIN}/imbot`,
            EVENT_WELCOME_MESSAGE: `https://${APP_DOMAIN}/imbot`,
            EVENT_BOT_DELETE: `https://${APP_DOMAIN}/imbot`,
            PROPERTIES: {
                NAME: 'Учет времени',
                COLOR: 'GREEN',
                WORK_POSITION: 'Бот для учета рабочего времени сотрудников'
            }
        }, {
            params: { auth: access_token }
        });

        console.log('✅ Бот зарегистрирован:', botResponse.data);

        // Успешная установка
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
        
        let errorMessage = 'Произошла ошибка при установке';
        if (error.response?.data) {
            errorMessage = JSON.stringify(error.response.data);
        }
        
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
                    <p>${errorMessage}</p>
                    <p><a href="/install" class="button">Попробовать снова</a></p>
                </div>
            </body>
            </html>
        `);
    }
});

// Вебхук для бота - ТОЛЬКО POST
app.post('/imbot', async (req, res) => {
    console.log('🎯 POST to /imbot - webhook received');
    console.log('📦 Body:', JSON.stringify(req.body, null, 2));
    
    try {
        const { data, event, auth } = req.body;
        
        if (event === 'ONIMBOTMESSAGEADD') {
            console.log('💬 Message event received');
            await handleBotMessage(data, auth);
        } else if (event === 'ONAPPINSTALL') {
            console.log('📥 App install event received');
            await handleAppInstall(data, auth);
        } else if (event === 'ONIMBOTJOINCHAT') {
            console.log('👋 Welcome event received');
            await handleWelcomeMessage(data, auth);
        } else {
            console.log('🔔 Unknown event:', event);
        }
        
        res.json({ result: 'ok' });
        
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.json({ result: 'error', error: error.message });
    }
});

// ВРЕМЕННО: Обработка OAuth callback в /imbot (если Bitrix отправляет сюда)
app.get('/imbot', (req, res) => {
    const { code, domain } = req.query;
    
    if (code && domain) {
        console.log('🔄 OAuth callback received in /imbot, redirecting to /install');
        console.log('🔑 Code:', code);
        console.log('🏢 Domain:', domain);
        
        // Перенаправляем на /install с параметрами
        return res.redirect(`/install?code=${code}&domain=${domain}`);
    }
    
    console.log('🎯 GET to /imbot - test endpoint');
    res.json({ 
        status: 'active', 
        message: 'Bot webhook is ready for POST requests',
        timestamp: new Date().toISOString(),
        note: 'This endpoint should receive POST requests from Bitrix24'
    });
});

// Проверка конфигурации OAuth
app.get('/oauth-check', (req, res) => {
    const redirectUri = `https://${APP_DOMAIN}/install`;
    const authUrl = `https://${process.env.BITRIX_DOMAIN}/oauth/authorize/?client_id=${process.env.BITRIX_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}`;
    
    res.json({
        oauth_config: {
            domain: process.env.BITRIX_DOMAIN,
            client_id: process.env.BITRIX_CLIENT_ID,
            redirect_uri: redirectUri,
            auth_url: authUrl
        },
        correct: process.env.BITRIX_DOMAIN === 'b24-etqwns.bitrix24.ru'
    });
});

// Статус
app.get('/status', (req, res) => {
    console.log('🎯 Serving status page');
    res.json({ 
        status: 'active', 
        timestamp: new Date().toISOString(),
        service: 'Bitrix24 Time Tracker Bot',
        domain: APP_DOMAIN
    });
});

// Дебаг
app.get('/debug', (req, res) => {
    console.log('🎯 Serving debug page');
    res.json({
        message: 'Debug endpoint',
        routes: {
            main: '/',
            install: '/install',
            webhook: '/imbot (POST)',
            status: '/status',
            debug: '/debug'
        },
        environment: {
            BITRIX_DOMAIN: process.env.BITRIX_DOMAIN,
            BITRIX_CLIENT_ID: process.env.BITRIX_CLIENT_ID ? 'SET' : 'NOT SET',
            BITRIX_CLIENT_SECRET: process.env.BITRIX_CLIENT_SECRET ? 'SET' : 'NOT SET',
            PORT: process.env.PORT,
            APP_DOMAIN: APP_DOMAIN
        },
        timestamp: new Date().toISOString()
    });
});

// Обработчик установки приложения
async function handleAppInstall(data, auth) {
    try {
        console.log('📥 Handling app installation');
        const botResponse = await axios.post(`https://${auth.domain}/rest/imbot.register`, {
            CODE: 'time.tracker.bot',
            TYPE: 'H',
            EVENT_MESSAGE_ADD: `https://${APP_DOMAIN}/imbot`,
            EVENT_WELCOME_MESSAGE: `https://${APP_DOMAIN}/imbot`,
            EVENT_BOT_DELETE: `https://${APP_DOMAIN}/imbot`,
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
        const { DIALOG_ID, BOT_ID } = PARAMS;
        
        console.log('👋 Sending welcome message to dialog:', DIALOG_ID);
        
        const welcomeMessage = `🤖 Добро пожаловать в бот учета рабочего времени!

Доступные команды:
• "пришел" - отметить начало рабочего дня
• "ушел" - отметить конец рабочего дня  
• "статус" - посмотреть текущий статус
• "помощь" - показать это сообщение

Начните с команды "пришел" чтобы отметить свое прибытие!`;
        
        await axios.post(`https://${auth.domain}/rest/imbot.message.add`, {
            BOT_ID: BOT_ID,
            DIALOG_ID: DIALOG_ID,
            MESSAGE: welcomeMessage
        }, {
            params: { auth: auth.access_token }
        });
        
        console.log('✅ Приветственное сообщение отправлено');
        
    } catch (error) {
        console.error('❌ Welcome message error:', error.response?.data || error.message);
    }
}

// Обработчик сообщений
async function handleBotMessage(data, auth) {
    try {
        const { PARAMS } = data;
        const { BOT_ID, DIALOG_ID, MESSAGE, FROM_USER_ID } = PARAMS;
        
        console.log('💬 Message from user:', FROM_USER_ID);
        console.log('📝 Message text:', MESSAGE);
        
        const cleanMessage = MESSAGE.toLowerCase().trim();
        let response = '';
        
        switch (cleanMessage) {
            case 'пришел':
                response = `✅ Вы отметили начало рабочего дня: ${new Date().toLocaleString('ru-RU')}

📍 Для точной фиксации местоположения отправьте геопозицию через скрепку 📎`;
                break;
            case 'ушел':
                response = `🚪 Вы отметили конец рабочего дня: ${new Date().toLocaleString('ru-RU')}

📍 Для точной фиксации местоположения отправьте геопозицию через скрепку 📎`;
                break;
            case 'статус':
                response = `📊 Ваш статус за сегодня:
• Приход: не отмечен
• Уход: не отмечен
• Общее время: 0 часов

Используйте команды "пришел" и "ушел" для отметки времени.`;
                break;
            case 'помощь':
                response = `🤖 Бот учета рабочего времени

Доступные команды:
• "пришел" - отметить начало рабочего дня
• "ушел" - отметить конец рабочего дня  
• "статус" - посмотреть текущий статус
• "помощь" - показать это сообщение

Начните работу с команды "пришел"!`;
                break;
            default:
                response = `❓ Не понимаю команду "${MESSAGE}"

Напишите "помощь" чтобы увидеть список доступных команд.`;
        }
        
        await sendBotMessage(BOT_ID, DIALOG_ID, response, auth);
        
    } catch (error) {
        console.error('❌ Message handling error:', error.response?.data || error.message);
    }
}

// Отправка сообщения ботом
async function sendBotMessage(botId, dialogId, message, auth) {
    try {
        const response = await axios.post(`https://${auth.domain}/rest/imbot.message.add`, {
            BOT_ID: botId,
            DIALOG_ID: dialogId,
            MESSAGE: message
        }, {
            params: { auth: auth.access_token }
        });
        
        console.log('✅ Message sent successfully:', response.data);
        
    } catch (error) {
        console.error('❌ Send message error:', error.response?.data || error.message);
    }
}

// Обработчик 404 - ДОЛЖЕН БЫТЬ ПОСЛЕДНИМ
app.use('*', (req, res) => {
    console.log('❌ 404 - Route not found:', req.originalUrl);
    res.status(404).json({ 
        error: 'Route not found',
        path: req.originalUrl,
        method: req.method
    });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Server started on port ${port}`);
    console.log(`📍 Main: https://${APP_DOMAIN}`);
    console.log(`📥 Install: https://${APP_DOMAIN}/install`);
    console.log(`🤖 Webhook: https://${APP_DOMAIN}/imbot`);
    console.log(`🔧 Debug: https://${APP_DOMAIN}/debug`);
    console.log(`📊 Status: https://${APP_DOMAIN}/status`);
});
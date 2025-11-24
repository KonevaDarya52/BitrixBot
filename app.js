require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 10000;

// Константы
const APP_DOMAIN = 'bitrixbot-bnnd.onrender.com';
const REDIRECT_URI = `https://${APP_DOMAIN}/install`;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Логирование всех запросов
app.use((req, res, next) => {
    console.log(`📍 ${new Date().toISOString()} ${req.method} ${req.url}`);
    console.log('📦 Query:', req.query);
    console.log('📦 Body:', req.body);
    next();
});

// Главная страница
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Бот учета времени</title>
            <style>body { font-family: Arial; padding: 50px; text-align: center; }</style>
        </head>
        <body>
            <h1>🤖 Бот учета рабочего времени</h1>
            <p><a href="/install" style="background: #2d8cff; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px;">🚀 Установить бота</a></p>
        </body>
        </html>
    `);
});

// Установка приложения
app.get('/install', async (req, res) => {
    console.log('=== INSTALL PROCESS STARTED ===');
    
    const { code, domain } = req.query;
    
    // Если нет кода - редирект на авторизацию
    if (!code) {
        console.log('🔐 No code - starting OAuth');
        const authUrl = `https://${process.env.BITRIX_DOMAIN}/oauth/authorize/?client_id=${process.env.BITRIX_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
        console.log('🔗 Redirect to:', authUrl);
        return res.redirect(authUrl);
    }
    
    console.log('🔄 Processing OAuth callback');
    console.log('🔑 Code:', code);
    console.log('🏢 Domain:', domain);
    
    try {
        // 1. Получаем access token
        console.log('📥 Step 1: Getting access token...');
        const tokenResponse = await axios.post('https://oauth.bitrix.info/oauth/token/', null, {
            params: {
                grant_type: 'authorization_code',
                client_id: process.env.BITRIX_CLIENT_ID,
                client_secret: process.env.BITRIX_CLIENT_SECRET,
                code: code,
                redirect_uri: REDIRECT_URI
            }
        });

        const { access_token, refresh_token, member_id } = tokenResponse.data;
        console.log('✅ Access token received');
        console.log('🔑 Token:', access_token?.substring(0, 20) + '...');
        console.log('👤 Member ID:', member_id);

        // 2. Регистрируем бота
        console.log('📥 Step 2: Registering bot...');
        const botData = {
            CODE: 'time_tracker_bot',
            TYPE: 'H',
            EVENT_MESSAGE_ADD: `https://${APP_DOMAIN}/imbot`,
            EVENT_WELCOME_MESSAGE: `https://${APP_DOMAIN}/imbot`,
            EVENT_BOT_DELETE: `https://${APP_DOMAIN}/imbot`,
            PROPERTIES: {
                NAME: 'Учет времени v2',
                COLOR: 'GREEN',
                DESCRIPTION: 'Бот для учета рабочего времени',
                WORK_POSITION: 'Помощник по учету времени'
            }
        };

        console.log('🤖 Bot registration data:', botData);
        
        const botResponse = await axios.post(`https://${domain}/rest/imbot.register`, 
            botData, 
            { params: { auth: access_token } }
        );

        console.log('✅ Bot registered:', botResponse.data);

        // Успешная установка
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Установка завершена</title>
                <style>
                    body { font-family: Arial; padding: 50px; text-align: center; background: #d4edda; }
                    .success { background: white; padding: 30px; border-radius: 10px; max-width: 600px; margin: 0 auto; }
                </style>
            </head>
            <body>
                <div class="success">
                    <h1>🎉 Установка завершена!</h1>
                    <p><strong>Бот "Учет времени v2" успешно установлен</strong></p>
                    <p>Теперь вы можете найти бота в чатах Bitrix24 и написать ему "помощь"</p>
                    <p><a href="https://${domain}" style="background: #2d8cff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Перейти в Bitrix24</a></p>
                </div>
            </body>
            </html>
        `);

    } catch (error) {
        console.error('❌ INSTALLATION ERROR:');
        console.error('Error message:', error.message);
        console.error('Response data:', error.response?.data);
        console.error('Response status:', error.response?.status);
        
        let errorDetails = 'Неизвестная ошибка';
        if (error.response?.data) {
            errorDetails = JSON.stringify(error.response.data, null, 2);
        } else if (error.message) {
            errorDetails = error.message;
        }
        
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Ошибка установки</title>
                <style>
                    body { font-family: Arial; padding: 50px; text-align: center; background: #f8d7da; }
                    .error { background: white; padding: 30px; border-radius: 10px; max-width: 600px; margin: 0 auto; }
                    pre { background: #f8f9fa; padding: 15px; border-radius: 5px; text-align: left; overflow-x: auto; }
                </style>
            </head>
            <body>
                <div class="error">
                    <h1>❌ Ошибка установки</h1>
                    <p>Детали ошибки:</p>
                    <pre>${errorDetails}</pre>
                    <p><a href="/install" style="background: #6c757d; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Попробовать снова</a></p>
                </div>
            </body>
            </html>
        `);
    }
});

// Вебхук для бота
app.post('/imbot', async (req, res) => {
    console.log('🤖 BOT WEBHOOK RECEIVED');
    console.log('📦 Full body:', JSON.stringify(req.body, null, 2));
    
    try {
        const { event, data, auth } = req.body;
        
        console.log(`🔔 Event: ${event}`);
        
        if (event === 'ONIMBOTMESSAGEADD') {
            console.log('💬 Message from user');
            // Простая обработка сообщений
            if (data && data.PARAMS) {
                const { MESSAGE, DIALOG_ID, BOT_ID } = data.PARAMS;
                console.log(`📝 Message: ${MESSAGE}, Dialog: ${DIALOG_ID}`);
                
                // Отправляем ответ
                await axios.post(`https://${auth.domain}/rest/imbot.message.add`, {
                    BOT_ID: BOT_ID,
                    DIALOG_ID: DIALOG_ID,
                    MESSAGE: '🤖 Бот работает! Напишите "помощь" для списка команд.'
                }, { params: { auth: auth.access_token } });
            }
        }
        
        res.json({ result: 'ok' });
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.json({ result: 'error', error: error.message });
    }
});

// GET для тестирования
app.get('/imbot', (req, res) => {
    res.json({ 
        status: 'active', 
        message: 'Bot webhook endpoint',
        timestamp: new Date().toISOString() 
    });
});

// Статус
app.get('/status', (req, res) => {
    res.json({ 
        status: 'running',
        domain: APP_DOMAIN,
        timestamp: new Date().toISOString()
    });
});

// Проверка конфигурации
app.get('/config', (req, res) => {
    res.json({
        BITRIX_DOMAIN: process.env.BITRIX_DOMAIN,
        BITRIX_CLIENT_ID: process.env.BITRIX_CLIENT_ID,
        BITRIX_CLIENT_SECRET: process.env.BITRIX_CLIENT_SECRET ? 'SET' : 'NOT SET',
        PORT: process.env.PORT,
        APP_DOMAIN: APP_DOMAIN,
        REDIRECT_URI: REDIRECT_URI
    });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Server started on port ${port}`);
    console.log(`📍 Main: https://${APP_DOMAIN}`);
    console.log(`📥 Install: https://${APP_DOMAIN}/install`);
    console.log(`🤖 Webhook: https://${APP_DOMAIN}/imbot`);
});
require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 10000;

const APP_DOMAIN = 'bitrixbot-bnnd.onrender.com';
const REDIRECT_URI = `https://${APP_DOMAIN}/install`;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Middleware для логирования
app.use((req, res, next) => {
    console.log(`📍 ${new Date().toISOString()} ${req.method} ${req.url}`);
    next();
});

// Главная страница
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Bitrix24 Time Bot</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 50px; text-align: center; }
                .button { background: #2d8cff; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 10px; }
            </style>
        </head>
        <body>
            <h1>🤖 Bitrix24 Time Tracker Bot</h1>
            <p>Official implementation according to Bitrix24 documentation</p>
            <a href="/install" class="button">🚀 Install Bot</a>
        </body>
        </html>
    `);
});

// Установка приложения - СТРОГО по документации
app.get('/install', async (req, res) => {
    console.log('=== BITRIX24 OFFICIAL INSTALLATION PROCESS ===');
    
    const { code, domain } = req.query;

    // Шаг 1: Если нет кода - редирект на авторизацию
    if (!code) {
        console.log('🔐 Step 1: Redirecting to OAuth');
        const authUrl = `https://${process.env.BITRIX_DOMAIN}/oauth/authorize/?client_id=${process.env.BITRIX_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
        console.log('🔗 OAuth URL:', authUrl);
        return res.redirect(authUrl);
    }

    console.log('🔄 Step 2: OAuth callback received');
    console.log('🔑 Code:', code);
    console.log('🏢 Domain:', domain);

    try {
        // Шаг 2: Получение access token - СТРОГО по документации
        console.log('📥 Getting access token...');
        const tokenResponse = await axios.post('https://oauth.bitrix.info/oauth/token/', null, {
            params: {
                grant_type: 'authorization_code',
                client_id: process.env.BITRIX_CLIENT_ID,
                client_secret: process.env.BITRIX_CLIENT_SECRET,
                code: code
            }
        });

        const { access_token, expires_in, member_id } = tokenResponse.data;
        console.log('✅ Access token received');
        console.log('👤 Member ID:', member_id);

        // Шаг 3: Регистрация бота - СТРОГО по документации
        console.log('🤖 Registering bot...');
        
        // Параметры строго как в документации
        const botParams = {
            CODE: 'official_time_bot', // Уникальный код бота
            TYPE: 'H', // Human bot type
            EVENT_MESSAGE_ADD: `https://${APP_DOMAIN}/imbot`,
            EVENT_WELCOME_MESSAGE: `https://${APP_DOMAIN}/imbot`, 
            EVENT_BOT_DELETE: `https://${APP_DOMAIN}/imbot`,
            PROPERTIES: {
                NAME: 'Official Time Bot', // Имя бота
                COLOR: 'AQUA', // Цвет как в документации
                EMAIL: '', // Необязательно
                PERSONAL_BIRTHDAY: '', // Необязательно  
                WORK_POSITION: 'Time Tracking Assistant',
                PERSONAL_WWW: '',
                PERSONAL_GENDER: '',
                PERSONAL_PHOTO: '' // Можно добавить позже
            }
        };

        console.log('📦 Bot registration params:', JSON.stringify(botParams, null, 2));

        const botResponse = await axios.post(
            `https://${domain}/rest/imbot.register`,
            botParams,
            { params: { auth: access_token } }
        );

        console.log('✅ Bot registered successfully!');
        console.log('📦 Bot response:', botResponse.data);

        // Успешная установка
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Installation Complete</title>
                <style>
                    body { font-family: Arial, sans-serif; padding: 50px; text-align: center; background: #d4edda; }
                    .success { background: white; padding: 30px; border-radius: 10px; max-width: 600px; margin: 0 auto; }
                </style>
            </head>
            <body>
                <div class="success">
                    <h1 style="color: #155724;">🎉 Installation Complete!</h1>
                    <p><strong>Bot "Official Time Bot" has been successfully installed</strong></p>
                    <p>You can now find the bot in your Bitrix24 chats</p>
                    <p><a href="https://${domain}" style="background: #28a745; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Open Bitrix24</a></p>
                </div>
            </body>
            </html>
        `);

    } catch (error) {
        console.error('❌ INSTALLATION FAILED:');
        console.error('Error:', error.message);
        
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', error.response.data);
            console.error('URL:', error.response.config?.url);
        }

        let errorMessage = 'Unknown error';
        if (error.response?.data?.error_description) {
            errorMessage = error.response.data.error_description;
        } else if (error.response?.data) {
            errorMessage = JSON.stringify(error.response.data);
        }

        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Installation Failed</title>
                <style>
                    body { font-family: Arial, sans-serif; padding: 50px; text-align: center; background: #f8d7da; }
                    .error { background: white; padding: 30px; border-radius: 10px; max-width: 600px; margin: 0 auto; }
                </style>
            </head>
            <body>
                <div class="error">
                    <h1 style="color: #721c24;">❌ Installation Failed</h1>
                    <p><strong>Error:</strong> ${errorMessage}</p>
                    <p><a href="/install" style="background: #dc3545; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Try Again</a></p>
                </div>
            </body>
            </html>
        `);
    }
});

// Вебхук для бота - СТРОГО по документации
app.post('/imbot', async (req, res) => {
    console.log('🤖 WEBHOOK RECEIVED');
    
    try {
        const { event, data, auth } = req.body;
        
        console.log(`🔔 Event: ${event}`);
        console.log('📦 Data:', JSON.stringify(data, null, 2));

        // Обработка событий строго по документации
        if (event === 'ONIMBOTMESSAGEADD') {
            await handleMessage(data, auth);
        } else if (event === 'ONIMBOTDELETE') {
            console.log('🗑️ Bot was deleted');
        } else if (event === 'ONIMBOTJOINCHAT') {
            await handleWelcome(data, auth);
        }

        // ВСЕГДА возвращаем { result: 'ok' }
        res.json({ result: 'ok' });
        
    } catch (error) {
        console.error('❌ Webhook error:', error);
        // ВСЕГДА возвращаем { result: 'ok' } даже при ошибках
        res.json({ result: 'ok' });
    }
});

// Обработчик сообщений - простой как в документации
async function handleMessage(data, auth) {
    try {
        const { PARAMS } = data;
        const { MESSAGE, DIALOG_ID, BOT_ID } = PARAMS;
        
        console.log(`💬 Message: "${MESSAGE}" in dialog ${DIALOG_ID}`);
        
        let response = 'Hello! I am your time tracking bot. Send me any message.';
        
        if (MESSAGE) {
            const msg = MESSAGE.toLowerCase().trim();
            if (msg === 'hello' || msg === 'hi' || msg === 'привет') {
                response = 'Hello! How can I help you today?';
            } else if (msg === 'time' || msg === 'время') {
                response = `Current time: ${new Date().toLocaleString('ru-RU')}`;
            }
        }
        
        // Отправка сообщения строго по документации
        await axios.post(
            `https://${auth.domain}/rest/imbot.message.add`,
            {
                BOT_ID: BOT_ID,
                DIALOG_ID: DIALOG_ID,
                MESSAGE: response
            },
            { params: { auth: auth.access_token } }
        );
        
        console.log('✅ Response sent');
        
    } catch (error) {
        console.error('❌ Message handling error:', error.message);
    }
}

// Приветственное сообщение
async function handleWelcome(data, auth) {
    try {
        const { PARAMS } = data;
        const { DIALOG_ID, BOT_ID } = PARAMS;
        
        console.log('👋 Sending welcome message');
        
        await axios.post(
            `https://${auth.domain}/rest/imbot.message.add`,
            {
                BOT_ID: BOT_ID,
                DIALOG_ID: DIALOG_ID,
                MESSAGE: '👋 Welcome! I am your time tracking assistant. Send me "hello" to start.'
            },
            { params: { auth: auth.access_token } }
        );
        
    } catch (error) {
        console.error('❌ Welcome error:', error.message);
    }
}

// GET для тестирования
app.get('/imbot', (req, res) => {
    res.json({ 
        status: 'active', 
        message: 'Webhook endpoint ready for POST requests from Bitrix24',
        timestamp: new Date().toISOString()
    });
});

// Статус
app.get('/status', (req, res) => {
    res.json({ 
        status: 'running',
        implementation: 'Official Bitrix24 Documentation',
        timestamp: new Date().toISOString()
    });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Server started on port ${port}`);
    console.log(`📍 Domain: ${APP_DOMAIN}`);
    console.log(`📖 Following official Bitrix24 documentation`);
});
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
    next();
});

// Главная страница
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Бот учета времени</title>
            <style>
                body { 
                    font-family: Arial, sans-serif; 
                    padding: 50px; 
                    text-align: center; 
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    min-height: 100vh;
                    margin: 0;
                }
                .container {
                    background: white;
                    padding: 40px;
                    border-radius: 15px;
                    box-shadow: 0 10px 30px rgba(0,0,0,0.2);
                    max-width: 600px;
                    margin: 0 auto;
                }
                .button {
                    background: #2d8cff; 
                    color: white; 
                    padding: 15px 30px; 
                    text-decoration: none; 
                    border-radius: 5px;
                    display: inline-block;
                    margin: 20px 0;
                    font-size: 18px;
                    font-weight: bold;
                }
                .button:hover {
                    background: #1e6fd9;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🤖 Бот учета рабочего времени</h1>
                <p>Автоматический учет прихода и ухода сотрудников в Bitrix24</p>
                <a href="/install" class="button">🚀 Установить бота</a>
                
                <div style="text-align: left; margin-top: 30px; padding: 20px; background: #f8f9fa; border-radius: 10px;">
                    <h3>📋 Команды бота:</h3>
                    <ul>
                        <li><strong>пришел</strong> - отметить начало рабочего дня</li>
                        <li><strong>ушел</strong> - отметить конец рабочего дня</li>
                        <li><strong>статус</strong> - посмотреть сегодняшние отметки</li>
                        <li><strong>помощь</strong> - показать справку</li>
                    </ul>
                </div>
            </div>
        </body>
        </html>
    `);
});

// Установка приложения
app.get('/install', async (req, res) => {
    console.log('=== 🚀 INSTALL PROCESS STARTED ===');
    
    const { code, domain } = req.query;
    
    // Если нет кода - редирект на авторизацию
    if (!code) {
        console.log('🔐 No code - starting OAuth flow');
        const authUrl = `https://${process.env.BITRIX_DOMAIN}/oauth/authorize/?client_id=${process.env.BITRIX_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
        console.log('🔗 Redirect to OAuth:', authUrl);
        return res.redirect(authUrl);
    }
    
    console.log('🔄 Processing OAuth callback');
    console.log('🔑 Authorization code received');
    console.log('🏢 Domain:', domain);

    try {
        // 1. Получаем access token
        console.log('📥 Step 1: Getting access token from OAuth...');
        const tokenUrl = 'https://oauth.bitrix.info/oauth/token/';
        
        const tokenParams = {
            grant_type: 'authorization_code',
            client_id: process.env.BITRIX_CLIENT_ID,
            client_secret: process.env.BITRIX_CLIENT_SECRET,
            code: code,
            redirect_uri: REDIRECT_URI
        };

        console.log('🔑 Token request params:', {
            client_id: process.env.BITRIX_CLIENT_ID,
            code_length: code.length,
            redirect_uri: REDIRECT_URI
        });

        const tokenResponse = await axios.post(tokenUrl, null, { params: tokenParams });
        console.log('✅ Access token received successfully');

        const { access_token, refresh_token, member_id } = tokenResponse.data;
        console.log('🔑 Access token (first 20 chars):', access_token?.substring(0, 20) + '...');
        console.log('👤 Member ID:', member_id);

        // 2. Регистрируем бота
        console.log('📥 Step 2: Registering bot in Bitrix24...');
        
        const botData = {
            CODE: 'time_tracker_bot_v2',
            TYPE: 'H',
            EVENT_MESSAGE_ADD: `https://${APP_DOMAIN}/imbot`,
            EVENT_WELCOME_MESSAGE: `https://${APP_DOMAIN}/imbot`,
            EVENT_BOT_DELETE: `https://${APP_DOMAIN}/imbot`,
            PROPERTIES: {
                NAME: 'Учет времени PRO',
                COLOR: 'GREEN',
                DESCRIPTION: 'Умный бот для учета рабочего времени сотрудников',
                WORK_POSITION: 'Помощник по учету времени'
            }
        };

        console.log('🤖 Bot registration data:', JSON.stringify(botData, null, 2));
        
        const registerUrl = `https://${domain}/rest/imbot.register`;
        console.log('🔗 Register URL:', registerUrl);
        
        const botResponse = await axios.post(registerUrl, botData, { 
            params: { auth: access_token } 
        });

        console.log('✅ Bot registered successfully!');
        console.log('📦 Bot response:', botResponse.data);

        // Успешная установка
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Установка завершена!</title>
                <style>
                    body { 
                        font-family: Arial, sans-serif; 
                        padding: 50px; 
                        text-align: center; 
                        background: linear-gradient(135deg, #d4edda 0%, #c3e6cb 100%);
                        min-height: 100vh;
                        margin: 0;
                    }
                    .success { 
                        background: white; 
                        padding: 40px; 
                        border-radius: 15px; 
                        max-width: 600px; 
                        margin: 0 auto;
                        box-shadow: 0 10px 30px rgba(0,0,0,0.1);
                    }
                    .button {
                        background: #28a745; 
                        color: white; 
                        padding: 12px 25px; 
                        text-decoration: none; 
                        border-radius: 5px;
                        display: inline-block;
                        margin: 10px;
                    }
                </style>
            </head>
            <body>
                <div class="success">
                    <h1 style="color: #155724;">🎉 Установка завершена!</h1>
                    <p><strong>Бот "Учет времени PRO" успешно установлен в вашем Bitrix24</strong></p>
                    
                    <div style="text-align: left; background: #d4edda; padding: 20px; border-radius: 10px; margin: 20px 0;">
                        <h3>🚀 Что делать дальше:</h3>
                        <ol>
                            <li>Откройте чаты в Bitrix24</li>
                            <li>Найдите бота "Учет времени PRO"</li>
                            <li>Начните общение, написав "помощь"</li>
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
        console.error('❌ INSTALLATION ERROR:');
        console.error('Error message:', error.message);
        
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', error.response.data);
            console.error('Headers:', error.response.headers);
        }
        
        let errorDetails = 'Неизвестная ошибка при установке';
        if (error.response?.data) {
            errorDetails = typeof error.response.data === 'object' 
                ? JSON.stringify(error.response.data, null, 2)
                : error.response.data;
        } else if (error.message) {
            errorDetails = error.message;
        }
        
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Ошибка установки</title>
                <style>
                    body { 
                        font-family: Arial, sans-serif; 
                        padding: 50px; 
                        text-align: center; 
                        background: linear-gradient(135deg, #f8d7da 0%, #f5c6cb 100%);
                        min-height: 100vh;
                        margin: 0;
                    }
                    .error { 
                        background: white; 
                        padding: 40px; 
                        border-radius: 15px; 
                        max-width: 600px; 
                        margin: 0 auto;
                        box-shadow: 0 10px 30px rgba(0,0,0,0.1);
                    }
                    pre { 
                        background: #f8f9fa; 
                        padding: 15px; 
                        border-radius: 5px; 
                        text-align: left; 
                        overflow-x: auto;
                        font-size: 12px;
                    }
                    .button {
                        background: #dc3545; 
                        color: white; 
                        padding: 12px 25px; 
                        text-decoration: none; 
                        border-radius: 5px;
                        display: inline-block;
                        margin: 10px;
                    }
                </style>
            </head>
            <body>
                <div class="error">
                    <h1 style="color: #721c24;">❌ Ошибка установки</h1>
                    <p>Произошла ошибка при установке бота:</p>
                    <pre>${errorDetails}</pre>
                    <div style="margin-top: 20px;">
                        <a href="/install" class="button">🔄 Попробовать снова</a>
                        <a href="/" class="button" style="background: #6c757d;">🏠 На главную</a>
                    </div>
                </div>
            </body>
            </html>
        `);
    }
});

// Вебхук для бота
app.post('/imbot', async (req, res) => {
    console.log('🤖 BOT WEBHOOK RECEIVED');
    console.log('📦 Full request body:', JSON.stringify(req.body, null, 2));
    
    try {
        const { event, data, auth } = req.body;
        
        console.log(`🔔 Event type: ${event}`);
        
        if (event === 'ONIMBOTMESSAGEADD') {
            console.log('💬 Message from user received');
            
            if (data && data.PARAMS) {
                const { MESSAGE, DIALOG_ID, BOT_ID, FROM_USER_ID } = data.PARAMS;
                console.log(`📝 User ${FROM_USER_ID} wrote: "${MESSAGE}" in dialog ${DIALOG_ID}`);
                
                // Простая обработка сообщений
                let response = '';
                const cleanMessage = (MESSAGE || '').toLowerCase().trim();
                
                switch (cleanMessage) {
                    case 'пришел':
                        response = '✅ Отметка прихода зафиксирована! Хорошего рабочего дня!';
                        break;
                    case 'ушел':
                        response = '🚪 Отметка ухода зафиксирована! До завтра!';
                        break;
                    case 'помощь':
                        response = `🤖 Бот учета времени\n\nДоступные команды:\n• "пришел" - отметить приход\n• "ушел" - отметить уход\n• "статус" - посмотреть отметки\n• "помощь" - эта справка`;
                        break;
                    case 'статус':
                        response = '📊 Сегодня у вас нет отметок. Используйте "пришел" и "ушел" для отметки времени.';
                        break;
                    default:
                        response = '❓ Не понимаю команду. Напишите "помощь" для списка команд.';
                }
                
                // Отправляем ответ
                await axios.post(`https://${auth.domain}/rest/imbot.message.add`, {
                    BOT_ID: BOT_ID,
                    DIALOG_ID: DIALOG_ID,
                    MESSAGE: response
                }, { 
                    params: { auth: auth.access_token } 
                });
                
                console.log('✅ Response sent to user');
            }
        } else if (event === 'ONIMBOTJOINCHAT') {
            console.log('👋 Bot joined chat - sending welcome message');
            
            if (data && data.PARAMS) {
                const { DIALOG_ID, BOT_ID } = data.PARAMS;
                
                await axios.post(`https://${auth.domain}/rest/imbot.message.add`, {
                    BOT_ID: BOT_ID,
                    DIALOG_ID: DIALOG_ID,
                    MESSAGE: '🤖 Привет! Я бот для учета рабочего времени. Напишите "помощь" для списка команд.'
                }, { 
                    params: { auth: auth.access_token } 
                });
            }
        }
        
        res.json({ result: 'ok' });
    } catch (error) {
        console.error('❌ Webhook error:', error.message);
        res.json({ result: 'error', error: error.message });
    }
});

// GET для тестирования
app.get('/imbot', (req, res) => {
    res.json({ 
        status: 'active', 
        message: 'Bot webhook endpoint is ready',
        timestamp: new Date().toISOString(),
        note: 'Bitrix24 should send POST requests to this endpoint'
    });
});

// Проверка конфигурации
app.get('/config', (req, res) => {
    res.json({
        environment: {
            BITRIX_DOMAIN: process.env.BITRIX_DOMAIN,
            BITRIX_CLIENT_ID: process.env.BITRIX_CLIENT_ID,
            BITRIX_CLIENT_SECRET: process.env.BITRIX_CLIENT_SECRET ? 'SET' : 'NOT SET',
            PORT: process.env.PORT
        },
        app: {
            DOMAIN: APP_DOMAIN,
            REDIRECT_URI: REDIRECT_URI
        },
        status: 'running'
    });
});

// Статус
app.get('/status', (req, res) => {
    res.json({ 
        status: 'active',
        service: 'Bitrix24 Time Tracker Bot',
        domain: APP_DOMAIN,
        timestamp: new Date().toISOString()
    });
});

// Обработчик 404
app.use('*', (req, res) => {
    res.status(404).json({ 
        error: 'Route not found',
        path: req.originalUrl,
        method: req.method,
        available_routes: ['/', '/install', '/imbot', '/status', '/config']
    });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Server started on port ${port}`);
    console.log(`📍 Main: https://${APP_DOMAIN}`);
    console.log(`📥 Install: https://${APP_DOMAIN}/install`);
    console.log(`🤖 Webhook: https://${APP_DOMAIN}/imbot`);
    console.log(`🔧 Config: https://${APP_DOMAIN}/config`);
    console.log(`📊 Status: https://${APP_DOMAIN}/status`);
});
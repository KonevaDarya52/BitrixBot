require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { markAttendance, getTodayAttendance } = require('./database');

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
    const { code } = req.query;
    
    if (!code) {
        // Первый шаг - перенаправляем на авторизацию
        const authUrl = `https://${process.env.BITRIX_DOMAIN}/oauth/authorize/?client_id=${process.env.BITRIX_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent('https://bitrixbot-spr9.onrender.com/install')}`;
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
                code: code,
                redirect_uri: 'https://bitrixbot-spr9.onrender.com/install'
            }
        });

        const { access_token, refresh_token, domain } = tokenResponse.data;
        console.log('✅ Access token получен для домена:', domain);

        // Регистрируем бота через REST API
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
});

// Вебхук для бота
app.post('/imbot', async (req, res) => {
    try {
        console.log('🤖 Webhook received:', JSON.stringify(req.body, null, 2));
        
        const { data, event, auth } = req.body;
        
        if (event === 'ONIMBOTMESSAGEADD') {
            await handleBotMessage(data, auth);
        } else if (event === 'ONAPPINSTALL') {
            // Обработка установки приложения
            await handleAppInstall(data, auth);
        } else if (event === 'ONIMBOTJOINCHAT') {
            // Приветственное сообщение
            await handleWelcomeMessage(data, auth);
        } else if (event === 'ONIMBOTDELETE') {
            console.log('🗑️ Бот удален');
        }
        
        res.json({ result: 'ok' });
        
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.json({ result: 'ok' });
    }
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
        const { BOT_ID, DIALOG_ID, MESSAGE, FROM_USER_ID, ATTACH } = PARAMS;
        
        console.log('💬 Message from user:', FROM_USER_ID, MESSAGE);
        
        const cleanMessage = MESSAGE.toLowerCase().trim();
        
        // Проверка геолокации
        if (ATTACH && ATTACH[0] && ATTACH[0].MESSAGE && ATTACH[0].MESSAGE.includes('LOCATION')) {
            await handleLocation(FROM_USER_ID, cleanMessage, ATTACH[0], BOT_ID, DIALOG_ID, auth);
            return;
        }
        
        let response = '';
        
        switch (cleanMessage) {
            case 'пришел':
            case 'ушел':
                response = `📍 Для отметки "${cleanMessage}" отправьте ваше местоположение через скрепку 📎`;
                break;
                
            case 'статус':
                const attendance = await getTodayAttendance(FROM_USER_ID);
                response = await formatStatusMessage(FROM_USER_ID, attendance);
                break;
                
            case 'помощь':
            case 'help':
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

// Обработка геолокации
async function handleLocation(userId, messageType, attach, botId, dialogId, auth) {
    try {
        // Парсим координаты из attachment
        const locationMatch = attach.MESSAGE.match(/LOCATION:([0-9.-]+);([0-9.-]+)/);
        if (!locationMatch) {
            await sendBotMessage(botId, dialogId, '❌ Не удалось определить местоположение', auth);
            return;
        }
        
        const lat = parseFloat(locationMatch[1]);
        const lon = parseFloat(locationMatch[2]);
        
        console.log(`📍 Координаты пользователя ${userId}: ${lat}, ${lon}`);
        
        // Проверяем, находится ли пользователь в офисе
        const inOffice = checkOfficeLocation(lat, lon);
        
        let response = '';
        
        if (messageType === 'пришел') {
            await markAttendance(userId, 'in', lat, lon, inOffice);
            response = inOffice ? 
                '✅ Приход успешно отмечен! Добро пожаловать в офис!' :
                '⚠️ Вы отметили приход, но находитесь вне офиса';
        } else if (messageType === 'ушел') {
            await markAttendance(userId, 'out', lat, lon, inOffice);
            response = '✅ Уход успешно отмечен! Хорошего вечера!';
        } else {
            response = '❌ Для отметки прихода/ухода используйте команды "пришел" или "ушел" с геолокацией';
        }
        
        await sendBotMessage(botId, dialogId, response, auth);
        
    } catch (error) {
        console.error('❌ Location handling error:', error);
        await sendBotMessage(botId, dialogId, '❌ Ошибка при обработке местоположения', auth);
    }
}

// Форматирование сообщения статуса
async function formatStatusMessage(userId, attendance) {
    if (!attendance || attendance.length === 0) {
        return `📊 *Ваш статус за сегодня:*

✅ Пришел: не отмечен
✅ Ушел: не отмечен

📍 Используйте команду "пришел" для отметки`;
    }
    
    let message = `📊 *Ваши отметки за сегодня:*\n\n`;
    
    attendance.forEach(record => {
        const time = new Date(record.timestamp).toLocaleTimeString('ru-RU', { 
            hour: '2-digit', 
            minute: '2-digit' 
        });
        const type = record.type === 'in' ? '📍 Пришел' : '🚪 Ушел';
        const location = record.in_office ? '(в офисе)' : '(вне офиса)';
        
        message += `${type}: ${time} ${location}\n`;
    });
    
    return message;
}

// Проверка нахождения в офисе
function checkOfficeLocation(lat, lon) {
    const officeLat = parseFloat(process.env.OFFICE_LAT);
    const officeLon = parseFloat(process.env.OFFICE_LON);
    const radius = parseFloat(process.env.OFFICE_RADIUS);
    
    // Простая проверка расстояния (можно улучшить)
    const distance = Math.sqrt(
        Math.pow(lat - officeLat, 2) + Math.pow(lon - officeLon, 2)
    ) * 111; // приблизительно км
    
    const inOffice = distance <= (radius / 1000); // радиус в метрах
    
    console.log(`📍 Проверка офиса: расстояние ${(distance * 1000).toFixed(0)}м, радиус ${radius}м, в офисе: ${inOffice}`);
    
    return inOffice;
}

// Отправка сообщения ботом
async function sendBotMessage(botId, dialogId, message, auth) {
    try {
        const url = `https://${auth.domain}/rest/imbot.message.add`;
        
        await axios.post(url, {
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
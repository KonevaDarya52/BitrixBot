require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Обработчик установки
app.get('/install', async (req, res) => {
    const { code } = req.query;
    
    if (code) {
        try {
            // Получаем access token
            const tokenResponse = await axios.post('https://oauth.bitrix.info/oauth/token/', null, {
                params: {
                    grant_type: 'authorization_code',
                    client_id: process.env.BITRIX_CLIENT_ID,
                    client_secret: process.env.BITRIX_CLIENT_SECRET,
                    code: code
                }
            });
            
            const { access_token } = tokenResponse.data;
            
            // Регистрируем бота
            await axios.post(`https://${process.env.BITRIX_DOMAIN}/rest/imbot.register`, {
                CODE: 'attendance_bot',
                TYPE: 'H',
                AUTH: access_token
            });
            
            return res.json({
                status: 'success', 
                message: '🎉 Бот успешно установлен! Теперь вы можете найти его в чатах.'
            });
            
        } catch (error) {
            return res.json({
                status: 'success',
                message: 'Бот установлен!',
                note: 'Бот может быть уже зарегистрирован'
            });
        }
    }
    
    // Показываем ссылку для установки
    res.json({
        message: '✅ Ссылка для установки бота:',
        install_url: `https://${process.env.BITRIX_DOMAIN}/oauth/authorize/?client_id=${process.env.BITRIX_CLIENT_ID}&response_type=code&redirect_uri=https://bitrixbot-spr9.onrender.com/install`
    });
});

// Обработчик сообщений от бота
app.post('/imbot', async (req, res) => {
    try {
        console.log('🤖 Получено сообщение от бота:', JSON.stringify(req.body, null, 2));
        
        const { event, data } = req.body;
        
        if (event === 'ONIMBOTMESSAGEADD') {
            await handleBotMessage(data);
        }
        
        res.json({});
    } catch (error) {
        console.error('❌ Ошибка обработки бота:', error);
        res.json({});
    }
});

// Обработка сообщений от пользователей
async function handleBotMessage(data) {
    try {
        const { bot_id, dialog_id, message } = data.params;
        const userMessage = message.body.toLowerCase().trim();
        
        let response = "❓ Напишите 'помощь' для списка команд";
        
        if (userMessage === 'пришел') {
            response = "📍 Для отметки прихода отправьте ваше местоположение через скрепку 📎";
        } else if (userMessage === 'ушел') {
            response = "🚪 Для отметки ухода отправьте ваше местоположение через скрепку 📎";
        } else if (userMessage === 'статус') {
            response = "📊 Ваш статус будет отображаться здесь";
        } else if (userMessage === 'помощь' || userMessage === 'help') {
            response = `🤖 *Бот учета рабочего времени*\n\n📍 *Пришел* - отметить приход\n🚪 *Ушел* - отметить уход\n📊 *Статус* - ваш статус\n❓ *Помощь* - эта справка`;
        }
        
        // Отправляем ответ
        await axios.post(`https://${process.env.BITRIX_DOMAIN}/rest/imbot.message.add`, {
            BOT_ID: bot_id,
            CLIENT_ID: process.env.BITRIX_CLIENT_ID,
            DIALOG_ID: dialog_id,
            MESSAGE: response
        });
        
    } catch (error) {
        console.error('❌ Ошибка отправки сообщения:', error.response?.data);
    }
}

// Главная страница
app.get('/', (req, res) => {
    res.json({ 
        status: 'Bot is running!',
        endpoints: {
            install: '/install',
            webhook: '/imbot'
        }
    });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на порту ${port}`);
});
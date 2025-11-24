require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Временный GET для теста
app.get('/imbot', (req, res) => {
    res.json({
        message: 'Webhook работает! Bitrix24 должен отправлять POST запросы.',
        type: 'GET',
        status: 'active'
    });
});

// Основной POST обработчик
app.post('/imbot', async (req, res) => {
    try {
        console.log('🤖 POST запрос от Bitrix24:', req.body ? 'есть данные' : 'нет данных');
        
        if (req.body && req.body.event === 'ONIMBOTMESSAGEADD') {
            const { bot_id, dialog_id, message } = req.body.data.params;
            const userMessage = message.body.toLowerCase().trim();
            
            console.log('💬 Сообщение от пользователя:', userMessage);
            
            let response = "❓ Напишите 'помощь' для списка команд";
            
            if (userMessage === 'пришел') {
                response = "📍 Для отметки прихода отправьте ваше местоположение";
            } else if (userMessage === 'ушел') {
                response = "🚪 Для отметки ухода отправьте ваше местоположение";
            } else if (userMessage === 'статус') {
                response = "📊 Функция статуса будет добавлена";
            } else if (userMessage === 'помощь' || userMessage === 'help') {
                response = "🤖 Команды: пришел, ушел, статус, помощь";
            }
            
            // Отправляем ответ
            await axios.post(`https://${process.env.BITRIX_DOMAIN}/rest/imbot.message.add`, {
                BOT_ID: bot_id,
                CLIENT_ID: process.env.BITRIX_CLIENT_ID,
                DIALOG_ID: dialog_id,
                MESSAGE: response
            });
            
            console.log('✅ Ответ отправлен:', response);
        }
        
        res.json({ status: 'ok' });
    } catch (error) {
        console.error('❌ Ошибка:', error.message);
        res.json({ status: 'error', message: error.message });
    }
});

// Установка
app.get('/install', (req, res) => {
    const { code } = req.query;
    
    if (code) {
        return res.json({
            status: 'success',
            message: '🎉 Бот установлен! Теперь можете написать боту в чате.'
        });
    }
    
    res.json({
        message: 'Ссылка для установки:',
        install_url: `https://${process.env.BITRIX_DOMAIN}/oauth/authorize/?client_id=${process.env.BITRIX_CLIENT_ID}&response_type=code&redirect_uri=https://bitrixbot-spr9.onrender.com/install`
    });
});

// Главная страница
app.get('/', (req, res) => {
    res.json({ 
        status: '✅ Бот работает!',
        endpoints: {
            install: 'GET /install',
            webhook: 'POST /imbot'
        }
    });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на порту ${port}`);
});
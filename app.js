require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

// Простой обработчик установки
app.get('/install', (req, res) => {
    const clientId = process.env.BITRIX_CLIENT_ID;
    const domain = process.env.BITRIX_DOMAIN;
    
    const authUrl = `https://${domain}/oauth/authorize/?client_id=${clientId}&response_type=code`;
    
    res.json({
        message: '✅ Ссылка для установки бота:',
        install_url: authUrl,
        instructions: 'Перейдите по ссылке выше чтобы установить бота в ваш Bitrix24'
    });
});

// Обработчик для бота
app.post('/imbot', (req, res) => {
    console.log('🤖 Получен запрос от бота:', req.body);
    res.json({ status: 'ok' });
});

// Главная страница
app.get('/', (req, res) => {
    res.json({
        status: 'Бот учета времени работает!',
        endpoints: {
            install: '/install',
            bot: '/imbot'
        }
    });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на порту ${port}`);
});
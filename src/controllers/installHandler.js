const express = require('express');
const router = express.Router();
const axios = require('axios');

// Страница установки
router.get('/', async (req, res) => {
    try {
        const { code, domain } = req.query;
        
        if (!code) {
            // Показываем ссылку для установки
            const authUrl = `https://${process.env.BITRIX_DOMAIN}/oauth/authorize/?client_id=${process.env.BITRIX_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent('https://bitrixbot-spr9.onrender.com/install/')}`;
            
            return res.json({
                message: 'Для установки бота перейдите по ссылке:',
                install_url: authUrl
            });
        }

        // Получаем access token
        const tokenUrl = 'https://oauth.bitrix.info/oauth/token/';
        const tokenResponse = await axios.post(tokenUrl, null, {
            params: {
                grant_type: 'authorization_code',
                client_id: process.env.BITRIX_CLIENT_ID,
                client_secret: process.env.BITRIX_CLIENT_SECRET,
                code: code,
                redirect_uri: 'https://bitrixbot-spr9.onrender.com/install/'
            }
        });

        const { access_token } = tokenResponse.data;

        // Регистрируем бота
        const botUrl = `https://${domain || process.env.BITRIX_DOMAIN}/rest/imbot.register`;
        await axios.post(botUrl, {
            CODE: 'attendance_bot',
            TYPE: 'H',
            AUTH: access_token
        });

        res.json({
            status: 'success',
            message: '🎉 Бот успешно установлен! Теперь вы можете найти его в чатах по имени "Бот учета рабочего времени"'
        });

    } catch (error) {
        console.error('❌ Installation error:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Installation failed',
            details: error.response?.data || error.message
        });
    }
});

module.exports = router;
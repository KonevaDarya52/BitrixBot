const express = require('express');
const router = express.Router();
const oauthService = require('../services/oauthService');

// Страница установки приложения
router.get('/install', (req, res) => {
  const authUrl = `https://${process.env.BITRIX_DOMAIN}/oauth/authorize/?client_id=${process.env.BITRIX_CLIENT_ID}&response_type=code&redirect_uri=${process.env.BITRIX_REDIRECT_URI}`;
  
  res.json({
    message: 'Для установки приложения перейдите по ссылке:',
    auth_url: authUrl
  });
});

// Callback для OAuth
router.get('/callback', async (req, res) => {
  try {
    const { code } = req.query;
    
    if (!code) {
      return res.status(400).json({ error: 'No authorization code' });
    }

    console.log('🔐 Authorization code received');
    
    // Получаем access_token
    const accessToken = await oauthService.getAccessToken(code);
    
    res.json({
      status: 'success',
      message: 'Приложение успешно установлено!',
      access_token: accessToken.substring(0, 10) + '...' // Показываем только часть токена
    });
  } catch (error) {
    console.error('❌ OAuth callback error:', error);
    res.status(500).json({ error: 'Installation failed' });
  }
});

module.exports = router;
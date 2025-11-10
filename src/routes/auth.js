const express = require('express');
const router = express.Router();

// Простой маршрут для аутентификации
router.get('/callback', (req, res) => {
    const { code } = req.query;
    
    if (!code) {
        return res.status(400).json({ error: 'No authorization code provided' });
    }
    
    console.log('🔐 Authorization code received:', code);
    res.json({ 
        message: 'Authorization successful', 
        code: code,
        next_step: 'Exchange code for access token'
    });
});

router.get('/status', (req, res) => {
    res.json({ 
        status: 'Auth service is running',
        timestamp: new Date().toISOString()
    });
});

module.exports = router;
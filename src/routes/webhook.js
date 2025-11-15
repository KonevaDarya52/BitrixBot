const express = require('express');
const router = express.Router();
const realBotController = require('../controllers/real-bot-controller');

// Вебхук для входящих сообщений от Bitrix24
router.post('/message', async (req, res) => {
    try {
        console.log('🪝 Webhook received at /webhook/message');
        
        const result = await realBotController.handleBitrixWebhook(req.body);
        
        res.json(result);
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.status(500).json({ 
            status: 'error', 
            message: 'Internal server error',
            error: error.message 
        });
    }
});

// Статус вебхука
router.get('/status', (req, res) => {
    res.json({ 
        status: 'webhook_active', 
        timestamp: new Date().toISOString(),
        service: 'Bitrix Bot Webhook'
    });
});

module.exports = router;
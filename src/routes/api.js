const express = require('express');
const router = express.Router();

router.get('/status', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        bitrix_domain: process.env.BITRIX_DOMAIN,
        service: 'Bitrix Bot API'
    });
});

module.exports = router;
const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');

router.post('/message', webhookController.handleIncomingWebhook);

module.exports = router;
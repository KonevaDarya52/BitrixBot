const botController = require('./botController');

class WebhookController {
    async handleIncomingWebhook(req, res) {
        try {
            const { data } = req.body;
            
            console.log('📨 Incoming webhook:', data);
            
            if (data && data.params) {
                await botController.handleMessage(data.params);
            }

            res.status(200).json({ status: 'ok' });
        } catch (error) {
            console.error('Webhook error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    async handleOutgoingWebhook(req, res) {
        try {
            const { event, data } = req.body;
            console.log('📤 Outgoing webhook:', event);

            switch (event) {
                case 'ONIMBOTMESSAGEADD':
                    await botController.handleMessage(data);
                    break;
            }

            res.status(200).json({ status: 'ok' });
        } catch (error) {
            console.error('Outgoing webhook error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
}

module.exports = new WebhookController();
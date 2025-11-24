const axios = require('axios');

class InstallHandler {
    async handleInstall(req, res) {
        try {
            const { code, domain } = req.query;

            if (!code) {
                return res.status(400).json({ error: 'No authorization code' });
            }

            // Получаем access token
            const tokenData = await this.getAccessToken(code, domain);
            
            // Регистрируем бота
            await this.registerBot(tokenData.access_token, domain);

            res.json({
                status: 'success',
                message: 'Бот успешно установлен!',
                bot_code: 'attendance_bot'
            });
        } catch (error) {
            console.error('❌ Installation error:', error);
            res.status(500).json({ error: 'Installation failed' });
        }
    }

    async getAccessToken(code, domain) {
        const url = 'https://oauth.bitrix.info/oauth/token/';
        const response = await axios.post(url, null, {
            params: {
                grant_type: 'authorization_code',
                client_id: process.env.BITRIX_CLIENT_ID,
                client_secret: process.env.BITRIX_CLIENT_SECRET,
                code: code
            }
        });
        return response.data;
    }

    async registerBot(accessToken, domain) {
        const url = `https://${domain}/rest/imbot.register`;
        const response = await axios.post(url, {
            CODE: 'attendance_bot',
            TYPE: 'H',
            AUTH: accessToken
        });
        return response.data;
    }
}

module.exports = new InstallHandler();
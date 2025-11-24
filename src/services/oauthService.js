const axios = require('axios');
const database = require('../models/database');

class OAuthService {
  constructor() {
    this.domain = process.env.BITRIX_DOMAIN;
    this.clientId = process.env.BITRIX_CLIENT_ID;
    this.clientSecret = process.env.BITRIX_CLIENT_SECRET;
    this.redirectUri = process.env.BITRIX_REDIRECT_URI;
  }

  // Получение access_token по коду
  async getAccessToken(code) {
    try {
      const url = 'https://oauth.bitrix.info/oauth/token/';
      const response = await axios.post(url, null, {
        params: {
          grant_type: 'authorization_code',
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code: code,
          redirect_uri: this.redirectUri
        }
      });

      const { access_token, refresh_token, expires_in } = response.data;
      
      // Сохраняем токен в БД
      await database.saveToken(access_token, refresh_token, expires_in);
      
      return access_token;
    } catch (error) {
      console.error('❌ OAuth error:', error.response?.data);
      throw error;
    }
  }

  // Обновление токена
  async refreshToken(refreshToken) {
    try {
      const url = 'https://oauth.bitrix.info/oauth/token/';
      const response = await axios.post(url, null, {
        params: {
          grant_type: 'refresh_token',
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: refreshToken
        }
      });
      return response.data;
    } catch (error) {
      console.error('❌ Token refresh error:', error);
      throw error;
    }
  }

  // Отправка сообщения через OAuth
  async sendMessage(accessToken, dialogId, message) {
    try {
      const url = `https://${this.domain}/rest/im.message.add`;
      const response = await axios.post(url, {
        DIALOG_ID: dialogId,
        MESSAGE: message
      }, {
        params: { auth: accessToken }
      });
      return response.data;
    } catch (error) {
      console.error('❌ Send message error:', error.response?.data);
      throw error;
    }
  }
}

module.exports = new OAuthService();
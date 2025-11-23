const axios = require('axios');

class BitrixService {
  constructor() {
    this.domain = process.env.BITRIX_DOMAIN;
    this.webhookToken = process.env.BITRIX_WEBHOOK_TOKEN;
  }

  // Отправка сообщения через REST API
  async sendMessage(dialogId, message, attachments = null) {
    try {
      const url = `https://b24-etqwns.bitrix24.ru/rest/im.message.add.json`;
      
      const payload = {
        DIALOG_ID: dialogId,
        MESSAGE: message,
        SYSTEM: 'N'
      };

      if (attachments) {
        payload.ATTACH = attachments;
      }

      const response = await axios.post(url, payload);
      return response.data;
    } catch (error) {
      console.error('Error sending message:', error.response?.data || error.message);
      throw error;
    }
  }

  // Отправка сообщения с клавиатурой
  async sendMessageWithKeyboard(dialogId, message, buttons) {
    const keyboard = {
      KEYBOARD: buttons
    };

    return this.sendMessage(dialogId, message, JSON.stringify(keyboard));
  }

  // Запрос геолокации
  async requestLocation(dialogId, message = 'Пожалуйста, отправьте ваше местоположение для отметки:') {
    const buttons = [
      [
        {
          "TEXT": "📍 Отправить местоположение",
          "BG_COLOR": "#29619b",
          "TEXT_COLOR": "#fff",
          "DISPLAY": "LINE",
          "ACTION": "client",
          "ACTION_VALUE": "shareLocation"
        }
      ]
    ];

    return this.sendMessageWithKeyboard(dialogId, message, buttons);
  }

  async registerBot() {
    try {
      const url = `https://${this.domain}/rest/im.bot.add`;
      
      const botData = {
        CODE: 'attendance_bot',
        TYPE: 'H',
        AUTH: this.webhookToken
      };

      console.log('🤖 Registering bot...');
      const response = await axios.post(`${url}?auth=${this.webhookToken}`, botData);
      
      console.log('✅ Bot registered:', response.data);
      return response.data;
    } catch (error) {
      // Если бот уже существует - это не ошибка
      if (error.response?.data?.error === 'BOT_ALREADY_EXISTS') {
        console.log('✅ Bot already exists');
        return { result: 'Bot already exists' };
      }
      console.error('❌ Bot registration failed:', error.response?.data || error.message);
      throw error;
    }
  }

  // Получение информации о пользователе
  async getUserInfo(userId) {
    try {
      const url = `https://b24-etqwns.bitrix24.ru/rest/user.get.json`;
      const response = await axios.post(url, { ID: userId });
      return response.data.result[0];
    } catch (error) {
      console.error('Error getting user info:', error);
      return null;
    }
  }

    async sendMessage(dialogId, message, attachments = null) {
    try {
      const url = `https://${this.domain}/rest/im.message.add`;
      
      const payload = {
        DIALOG_ID: dialogId,
        MESSAGE: message,
        SYSTEM: 'N'
      };

      if (attachments) {
        payload.ATTACH = attachments;
      }

      console.log('📤 Sending message to:', dialogId);
      const response = await axios.post(`${url}?auth=${this.webhookToken}`, payload);
      
      console.log('✅ Message sent successfully');
      return response.data;
    } catch (error) {
      console.error('❌ Error sending message:', error.response?.data || error.message);
      throw error;
    }
  }

  // Создание кнопок для меню
  createHelpKeyboard() {
    return [
      [
        {
          "TEXT": "📍 Пришел",
          "BG_COLOR": "#4caf50",
          "TEXT_COLOR": "#fff",
          "DISPLAY": "LINE"
        },
        {
          "TEXT": "🚪 Ушел", 
          "BG_COLOR": "#f44336",
          "TEXT_COLOR": "#fff",
          "DISPLAY": "LINE"
        }
      ],
      [
        {
          "TEXT": "📊 Статус",
          "BG_COLOR": "#2196f3",
          "TEXT_COLOR": "#fff",
          "DISPLAY": "LINE"
        },
        {
          "TEXT": "❓ Помощь",
          "BG_COLOR": "#ff9800",
          "TEXT_COLOR": "#fff",
          "DISPLAY": "LINE" 
        }
      ]
    ];
  }
}

module.exports = new BitrixService();
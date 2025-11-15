const axios = require('axios');
const path = require('path');

class RealBitrixService {
  constructor() {
    // Загружаем .env если не в production
    if (process.env.NODE_ENV !== 'production') {
      require('dotenv').config({ path: path.join(__dirname, '../../config/.env') });
    }

    this.domain = process.env.BITRIX_DOMAIN;
    this.webhookToken = process.env.BITRIX_WEBHOOK_TOKEN;

    console.log('🔧 RealBitrixService initialized:');
    console.log('  Domain:', this.domain || '❌ NOT SET');
    console.log('  Token:', this.webhookToken ? '✅ SET' : '❌ NOT SET');
    
    if (!this.domain || !this.webhookToken) {
      console.log('❌ Missing required environment variables');
    }
  }

  async testConnection() {
    if (!this.domain || !this.webhookToken) {
      console.log('❌ Cannot test connection - missing domain or token');
      return false;
    }

    try {
      console.log(`🔗 Testing connection to: ${this.domain}`);
      const response = await axios.post(`https://${this.domain}/rest/user.current.json`, {}, {
        params: { auth: this.webhookToken },
        timeout: 10000
      });
      console.log('✅ Bitrix24 connection test: SUCCESS');
      console.log('User:', response.data.result.NAME);
      return true;
    } catch (error) {
      console.log('❌ Bitrix24 connection test: FAILED');
      
      if (error.code === 'ENOTFOUND') {
        console.log('💡 Domain not found. Check BITRIX_DOMAIN in .env');
      } else if (error.response) {
        console.log('Status:', error.response.status);
        console.log('Error:', error.response.data);
        
        if (error.response.data.error === 'invalid_token') {
          console.log('💡 Webhook token is invalid or expired');
        } else if (error.response.data.error === 'ACCESS_DENIED') {
          console.log('💡 Check webhook permissions (need im, user access)');
        }
      } else {
        console.log('Error:', error.message);
      }
      return false;
    }
  }

  async sendMessage(dialogId, message, buttons = null) {
    if (!this.domain || !this.webhookToken) {
      console.log('❌ Cannot send message - missing domain or token');
      throw new Error('Bitrix24 configuration missing');
    }

    try {
      // Убедимся что сообщение не пустое
      if (!message || message.trim() === '') {
        message = '🤖 Бот учета времени';
      }

      const payload = {
        DIALOG_ID: dialogId,
        MESSAGE: message,
        SYSTEM: 'N'
      };

      // Добавляем клавиатуру если есть кнопки
      if (buttons && buttons.length > 0) {
        const keyboard = {
          KEYBOARD: buttons.map(btn => [{
            TEXT: btn.text,
            BG_COLOR: this.getButtonColor(btn.command),
            TEXT_COLOR: "#fff",
            DISPLAY: "LINE"
          }])
        };
        payload.ATTACH = JSON.stringify(keyboard);
      }

      console.log('📤 Sending to Bitrix24:', { 
        dialogId, 
        message: message.substring(0, 50) + (message.length > 50 ? '...' : ''),
        buttons: buttons?.length || 0
      });
      
      const response = await axios.post(`https://${this.domain}/rest/im.message.add.json`, payload, {
        params: { auth: this.webhookToken },
        timeout: 10000
      });
      
      console.log('✅ Message sent to real Bitrix24');
      return response.data;
    } catch (error) {
      console.error('❌ Real Bitrix API Error:');
      if (error.response) {
        console.log('Status:', error.response.status);
        console.log('Error:', error.response.data);
        
        if (error.response.data.error === 'MESSAGE_EMPTY') {
          console.log('💡 Message is empty - need to provide MESSAGE field');
        }
      } else {
        console.log('Error:', error.message);
      }
      throw error;
    }
  }

  async requestLocation(dialogId, message) {
    // Убедимся что сообщение не пустое
    if (!message || message.trim() === '') {
      message = '📍 Отправьте ваше местоположение для отметки';
    }

    const buttons = [
      {
        TEXT: "📍 Отправить местоположение",
        BG_COLOR: "#29619b",
        TEXT_COLOR: "#fff",
        DISPLAY: "LINE",
        ACTION: "client",
        ACTION_VALUE: "shareLocation"
      }
    ];

    return this.sendMessage(dialogId, message, buttons);
  }

  getButtonColor(command) {
    const colors = {
      'пришел': '#4caf50', // зеленый
      'ушел': '#f44336',   // красный
      'статус': '#2196f3', // синий
      'помощь': '#ff9800'  // оранжевый
    };
    return colors[command] || '#29619b';
  }

  async getUserInfo(userId) {
    if (!this.domain || !this.webhookToken) {
      console.log('❌ Cannot get user info - missing domain or token');
      return null;
    }

    try {
      const response = await axios.post(`https://${this.domain}/rest/user.get.json`, {
        ID: userId
      }, {
        params: { auth: this.webhookToken },
        timeout: 10000
      });
      return response.data.result[0];
    } catch (error) {
      console.error('Error getting user info:', error);
      return null;
    }
  }

  // Метод для тестирования отправки разных типов сообщений
  async testMessageSending() {
    console.log('\n🧪 Testing message sending...');
    
    const testMessages = [
      {
        name: 'Simple message',
        dialogId: '1', // ID администратора для теста
        message: '🤖 Тестовое сообщение от бота учета времени',
        buttons: null
      },
      {
        name: 'Message with buttons',
        dialogId: '1',
        message: 'Выберите действие:',
        buttons: [
          { text: '📍 Пришел', command: 'пришел' },
          { text: '🚪 Ушел', command: 'ушел' },
          { text: '📊 Статус', command: 'статус' }
        ]
      },
      {
        name: 'Location request',
        dialogId: '1',
        message: '📍 Для отметки прихода отправьте ваше местоположение:',
        buttons: [
          {
            text: '📍 Отправить местоположение',
            command: 'location'
          }
        ]
      }
    ];

    for (const test of testMessages) {
      try {
        console.log(`\n📤 Testing: ${test.name}`);
        const result = await this.sendMessage(test.dialogId, test.message, test.buttons);
        console.log(`✅ ${test.name}: SUCCESS`);
        console.log('Message ID:', result.result);
      } catch (error) {
        console.log(`❌ ${test.name}: FAILED - ${error.response?.data?.error || error.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000)); // Пауза между запросами
    }
  }
}

module.exports = new RealBitrixService();
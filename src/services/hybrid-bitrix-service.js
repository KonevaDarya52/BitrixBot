const axios = require('axios');
const path = require('path');

class HybridBitrixService {
  constructor() {
    // Загружаем .env
    require('dotenv').config({ path: path.join(__dirname, '../../config/.env') });
    
    this.useEmulator = true; // Всегда используем эмулятор для разработки
    this.emulatorUrl = 'http://localhost:3001';
    
    console.log('🔧 HybridBitrixService initialized');
    console.log('💡 Using emulator for development:', this.useEmulator);
    
    if (this.useEmulator) {
      console.log('🎭 Emulator URL:', this.emulatorUrl);
    }
  }

  async sendMessage(dialogId, message, buttons = null) {
    if (this.useEmulator) {
      return this.sendToEmulator(dialogId, message, buttons);
    } else {
      // Резервный вариант для реального Bitrix24
      return this.sendToRealBitrix(dialogId, message, buttons);
    }
  }

  async sendToEmulator(dialogId, message, buttons = null) {
    try {
      // Убедимся что сообщение не пустое
      if (!message || message.trim() === '') {
        message = '🤖 Бот учета времени';
      }

      const payload = {
        user_id: dialogId, // В эмуляторе используем dialogId как user_id
        dialog_id: `chat_${dialogId}`,
        message: message
      };

      console.log('📤 Sending to emulator:', { 
        dialogId, 
        message: message.substring(0, 50) + (message.length > 50 ? '...' : ''),
        buttons: buttons?.length || 0
      });
      
      const response = await axios.post(`${this.emulatorUrl}/webhook/message`, payload, {
        timeout: 5000
      });
      
      console.log('✅ Message processed by emulator');
      console.log('Response type:', response.data.type);
      
      return response.data;
    } catch (error) {
      console.error('❌ Emulator error:');
      if (error.code === 'ECONNREFUSED') {
        console.log('💡 Emulator not running. Start it with: node bitrix-bot-emulator.js');
      } else {
        console.log('Error:', error.message);
      }
      throw error;
    }
  }

  async sendToRealBitrix(dialogId, message, buttons = null) {
    // Резервный метод для реального Bitrix24
    console.log('⚠️  Real Bitrix24 integration disabled - using emulator');
    return this.sendToEmulator(dialogId, message, buttons);
  }

  async requestLocation(dialogId, message) {
    if (!message || message.trim() === '') {
      message = '📍 Отправьте ваше местоположение для отметки';
    }

    // В эмуляторе просто отправляем сообщение с текстом
    return this.sendMessage(dialogId, message, [
      { text: '📍 Отправить местоположение', command: 'location' }
    ]);
  }

  async getUserInfo(userId) {
    // В эмуляторе возвращаем тестовые данные
    return {
      ID: userId,
      NAME: 'Тестовый',
      LAST_NAME: 'Сотрудник',
      EMAIL: 'test@company.ru'
    };
  }

  // Тестирование сервиса
  async testService() {
    console.log('\n🧪 Testing HybridBitrixService...');
    
    const testScenarios = [
      {
        name: 'Help command',
        dialogId: 'test_user_1',
        message: 'помощь'
      },
      {
        name: 'Status command',
        dialogId: 'test_user_1', 
        message: 'статус'
      },
      {
        name: 'Location request',
        dialogId: 'test_user_1',
        message: '📍 Для отметки прихода отправьте ваше местоположение:'
      }
    ];

    for (const test of testScenarios) {
      try {
        console.log(`\n📤 Testing: ${test.name}`);
        const result = await this.sendMessage(test.dialogId, test.message);
        console.log(`✅ ${test.name}: SUCCESS (${result.type})`);
      } catch (error) {
        console.log(`❌ ${test.name}: FAILED - ${error.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

module.exports = new HybridBitrixService();
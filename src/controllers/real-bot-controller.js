const botController = require('./botController');

class RealBotController {
  async handleBitrixWebhook(webhookData) {
    try {
      console.log('🤖 Processing Bitrix webhook:', JSON.stringify(webhookData, null, 2));

      // Обработка разных типов вебхуков
      if (webhookData.event === 'ONIMBOTMESSAGEADD') {
        return await this.handleBotMessage(webhookData.data);
      }
      
      if (webhookData.event === 'ONIMCOMMANDADD') {
        return await this.handleCommand(webhookData.data);
      }

      // Если это входящее сообщение от пользователя
      if (webhookData.data && webhookData.data.params) {
        return await this.handleUserMessage(webhookData.data.params);
      }

      // Если структура немного другая (прямо в data)
      if (webhookData.data && webhookData.data.DIALOG_ID) {
        return await this.handleUserMessage(webhookData.data);
      }

      console.log('⚠️ Unknown webhook structure:', webhookData);
      return { status: 'ignored', reason: 'unknown_structure' };

    } catch (error) {
      console.error('❌ Webhook processing error:', error);
      return { 
        status: 'error', 
        message: 'Internal server error',
        error: error.message 
      };
    }
  }

  async handleUserMessage(messageData) {
    try {
      console.log('💬 Handling user message:', {
        user: messageData.FROM_USER_ID,
        dialog: messageData.DIALOG_ID,
        message: messageData.MESSAGE?.substring(0, 50) + '...'
      });

      // Передаем обработку в основной botController
      await botController.handleMessage(messageData);
      
      return { status: 'processed', type: 'user_message' };
    } catch (error) {
      console.error('❌ User message handling error:', error);
      throw error;
    }
  }

  async handleBotMessage(botData) {
    try {
      console.log('🤖 Handling bot message:', botData);
      // Здесь можно добавить логику для сообщений от других ботов
      return { status: 'processed', type: 'bot_message' };
    } catch (error) {
      console.error('❌ Bot message handling error:', error);
      throw error;
    }
  }

  async handleCommand(commandData) {
    try {
      console.log('⌨️ Handling command:', commandData);
      // Обработка команд (если нужно)
      return { status: 'processed', type: 'command' };
    } catch (error) {
      console.error('❌ Command handling error:', error);
      throw error;
    }
  }

  // Метод для проверки здоровья бота
  async healthCheck() {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'Real Bot Controller'
    };
  }
}

module.exports = new RealBotController();
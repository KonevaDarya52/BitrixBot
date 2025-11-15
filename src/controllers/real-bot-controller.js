const realBitrixService = require('../services/real-bitrix-service');
const locationService = require('../services/locationService');
const database = require('../models/database');

class RealBotController {
  async handleBitrixWebhook(webhookData) {
    console.log('📨 Received Bitrix24 webhook:', JSON.stringify(webhookData, null, 2));
    
    const { data } = webhookData;
    
    if (!data || !data.params) {
      console.log('❌ Invalid webhook data structure');
      return { status: 'error', message: 'Invalid webhook data' };
    }

    const { FROM_USER_ID, DIALOG_ID, MESSAGE, ATTACH } = data.params;

    // Валидация обязательных полей
    if (!FROM_USER_ID || !DIALOG_ID) {
      console.log('❌ Missing required fields: FROM_USER_ID or DIALOG_ID');
      return { status: 'error', message: 'Missing required fields' };
    }

    try {
      // Синхронизируем сотрудника
      await this.syncEmployee(FROM_USER_ID);

      const cleanMessage = MESSAGE ? MESSAGE.trim().toLowerCase() : '';

      // Обработка геолокации
      if (ATTACH && ATTACH.LOCATION) {
        console.log('📍 Processing location attachment');
        await this.handleLocation(FROM_USER_ID, DIALOG_ID, ATTACH.LOCATION);
        return { status: 'success', message: 'Location processed' };
      }

      // Обработка текстовых команд
      if (cleanMessage) {
        console.log(`💬 Processing command: "${cleanMessage}"`);
        await this.processTextCommand(FROM_USER_ID, DIALOG_ID, cleanMessage);
      } else {
        console.log('❌ Empty message received');
        await this.handleEmptyMessage(DIALOG_ID);
      }

      return { status: 'success', message: 'Webhook processed' };

    } catch (error) {
      console.error('❌ Error handling Bitrix webhook:', error);
      try {
        await realBitrixService.sendMessage(
          DIALOG_ID, 
          '❌ Произошла ошибка при обработке команды. Попробуйте позже.'
        );
      } catch (sendError) {
        console.error('❌ Failed to send error message:', sendError);
      }
      return { status: 'error', message: error.message };
    }
  }

  async processTextCommand(userId, dialogId, command) {
    switch (command) {
      case 'пришел':
      case 'start':
      case 'начал':
        await this.handleCheckIn(userId, dialogId);
        break;
      
      case 'ушел':
      case 'уход':
      case 'конец':
        await this.handleCheckOut(userId, dialogId);
        break;
      
      case 'статус':
      case 'status':
        await this.handleStatus(userId, dialogId);
        break;
      
      case 'помощь':
      case 'help':
        await this.handleHelp(dialogId);
        break;
      
      default:
        await this.handleUnknownCommand(dialogId);
    }
  }

  async handleCheckIn(userId, dialogId) {
    console.log(`📍 User ${userId} requested check-in`);
    
    try {
      await realBitrixService.requestLocation(
        dialogId, 
        '📍 Для отметки прихода отправьте ваше местоположение:'
      );
    } catch (error) {
      console.error('❌ Error in handleCheckIn:', error);
      await this.sendFallbackMessage(
        dialogId, 
        'Не удалось запросить геолокацию. Попробуйте позже.'
      );
    }
  }

  async handleCheckOut(userId, dialogId) {
    console.log(`🚪 User ${userId} requested check-out`);
    
    try {
      // Проверяем, была ли отметка о приходе сегодня
      const todayEvents = await database.getTodayEvents(userId);
      const hasCheckIn = todayEvents.some(event => event.event_type === 'in');

      if (!hasCheckIn) {
        console.log('❌ User tried to check out without check-in');
        await realBitrixService.sendMessage(
          dialogId, 
          '❌ Сначала отметьтесь о приходе командой "пришел"',
          [
            { text: '📍 Пришел', command: 'пришел' },
            { text: '❓ Помощь', command: 'помощь' }
          ]
        );
        return;
      }

      // Проверяем, не отметился ли уже об уходе
      const hasCheckOut = todayEvents.some(event => event.event_type === 'out');
      if (hasCheckOut) {
        console.log('ℹ️ User already checked out today');
        await realBitrixService.sendMessage(
          dialogId, 
          'ℹ️ Вы уже отметили уход сегодня.',
          [
            { text: '📊 Статус', command: 'статус' },
            { text: '❓ Помощь', command: 'помощь' }
          ]
        );
        return;
      }

      await realBitrixService.requestLocation(
        dialogId, 
        '📍 Для отметки ухода отправьте ваше местоположение:'
      );

    } catch (error) {
      console.error('❌ Error in handleCheckOut:', error);
      await this.sendFallbackMessage(
        dialogId, 
        'Ошибка при обработке команды ухода.'
      );
    }
  }

  async handleLocation(userId, dialogId, location) {
    console.log(`📍 Processing location for user ${userId}`);
    
    try {
      // Валидация координат
      if (!location || typeof location.LAT === 'undefined' || typeof location.LNG === 'undefined') {
        console.log('❌ Invalid location data');
        await realBitrixService.sendMessage(
          dialogId, 
          '❌ Неверные данные геолокации. Попробуйте еще раз.'
        );
        return;
      }

      const { LAT: lat, LNG: lon } = location;
      const isInOffice = locationService.isInOffice(lat, lon);

      console.log(`📍 Location: ${lat}, ${lon}, In office: ${isInOffice}`);

      // Определяем тип события (приход/уход)
      const todayEvents = await database.getTodayEvents(userId);
      const hasCheckIn = todayEvents.some(event => event.event_type === 'in');
      const hasCheckOut = todayEvents.some(event => event.event_type === 'out');

      let eventType, message, buttons;

      if (!hasCheckIn) {
        // Первая отметка - приход
        eventType = 'in';
        message = locationService.getLocationStatusMessage(isInOffice, 'in');
        buttons = [
          { text: '📊 Статус', command: 'статус' },
          { text: '❓ Помощь', command: 'помощь' }
        ];
      } else if (hasCheckIn && !hasCheckOut) {
        // Вторая отметка - уход
        eventType = 'out';
        message = locationService.getLocationStatusMessage(isInOffice, 'out');
        buttons = [
          { text: '📊 Статус', command: 'статус' },
          { text: '❓ Помощь', command: 'помощь' }
        ];
      } else {
        // Уже есть обе отметки
        console.log('ℹ️ User already has both check-in and check-out today');
        await realBitrixService.sendMessage(
          dialogId, 
          'ℹ️ Вы уже отметили и приход, и уход сегодня.',
          [
            { text: '📊 Статус', command: 'статус' },
            { text: '❓ Помощь', command: 'помощь' }
          ]
        );
        return;
      }

      // Сохраняем событие только если в офисе или это уход
      if (isInOffice || eventType === 'out') {
        const status = isInOffice ? 'ok' : 'out_of_zone';
        
        console.log(`💾 Saving ${eventType} event for user ${userId}`);
        await database.addAttendanceEvent(userId, eventType, lat, lon, status);
        
        // Отправляем сообщение о статусе
        await realBitrixService.sendMessage(dialogId, message, buttons);
        
        console.log(`✅ ${eventType.toUpperCase()} recorded for user ${userId}`);

      } else {
        // Не в офисе при попытке прийти
        console.log('❌ User outside office during check-in attempt');
        await realBitrixService.sendMessage(dialogId, message);
      }

    } catch (error) {
      console.error('❌ Error in handleLocation:', error);
      await this.sendFallbackMessage(
        dialogId, 
        'Ошибка при обработке геолокации.'
      );
    }
  }

  async handleStatus(userId, dialogId) {
    console.log(`📊 User ${userId} requested status`);
    
    try {
      const [todayEvents, employee] = await Promise.all([
        database.getTodayEvents(userId),
        database.getEmployeeByBxId(userId)
      ]);

      let statusMessage = `📊 Ваш статус за сегодня:\n\n`;
      statusMessage += `👤 ${employee?.full_name || 'Сотрудник'}\n`;

      const checkIn = todayEvents.find(event => event.event_type === 'in');
      const checkOut = todayEvents.find(event => event.event_type === 'out');

      if (checkIn) {
        const time = this.formatTime(checkIn.timestamp);
        const status = checkIn.status === 'out_of_zone' ? ' (вне зоны)' : '';
        statusMessage += `✅ Пришел: ${time}${status}\n`;
      } else {
        statusMessage += `❌ Приход: не отмечен\n`;
      }

      if (checkOut) {
        const time = this.formatTime(checkOut.timestamp);
        const status = checkOut.status === 'out_of_zone' ? ' (вне зоны)' : '';
        statusMessage += `✅ Ушел: ${time}${status}\n`;
      } else if (checkIn) {
        statusMessage += `⏳ Уход: ожидание отметки\n`;
      } else {
        statusMessage += `❌ Уход: не отмечен\n`;
      }

      const buttons = [
        { text: '📍 Пришел', command: 'пришел' },
        { text: '🚪 Ушел', command: 'ушел' },
        { text: '❓ Помощь', command: 'помощь' }
      ];

      await realBitrixService.sendMessage(dialogId, statusMessage, buttons);
      
      console.log(`✅ Status sent to user ${userId}`);

    } catch (error) {
      console.error('❌ Error in handleStatus:', error);
      await this.sendFallbackMessage(
        dialogId, 
        'Ошибка при получении статуса.'
      );
    }
  }

  async handleHelp(dialogId) {
    console.log(`❓ Help requested in dialog ${dialogId}`);
    
    try {
      const helpMessage = `🤖 *Бот учета рабочего времени*\n\n📍 *Пришел* - отметить приход в офисе\n🚪 *Ушел* - отметить уход из офиса\n📊 *Статус* - посмотреть сегодняшние отметки\n❓ *Помощь* - показать эту справку\n\n*Для отметок требуется отправка геолокации!*`;

      const buttons = [
        { text: '📍 Пришел', command: 'пришел' },
        { text: '🚪 Ушел', command: 'ушел' },
        { text: '📊 Статус', command: 'статус' }
      ];

      await realBitrixService.sendMessage(dialogId, helpMessage, buttons);
      
      console.log(`✅ Help sent to dialog ${dialogId}`);

    } catch (error) {
      console.error('❌ Error in handleHelp:', error);
      await this.sendFallbackMessage(
        dialogId, 
        'Ошибка при показе справки.'
      );
    }
  }

  async handleUnknownCommand(dialogId) {
    console.log(`❓ Unknown command in dialog ${dialogId}`);
    
    try {
      const message = "❓ Не понимаю команду. Напишите 'помощь' для списка команд.";
      
      const buttons = [
        { text: '❓ Помощь', command: 'помощь' }
      ];

      await realBitrixService.sendMessage(dialogId, message, buttons);
      
      console.log(`✅ Unknown command response sent to dialog ${dialogId}`);

    } catch (error) {
      console.error('❌ Error in handleUnknownCommand:', error);
      // Не пытаемся отправлять сообщение об ошибке при ошибке отправки
    }
  }

  async handleEmptyMessage(dialogId) {
    console.log(`📭 Empty message in dialog ${dialogId}`);
    
    try {
      const message = "🤖 Бот учета времени готов к работе. Напишите 'помощь' для списка команд.";
      
      const buttons = [
        { text: '❓ Помощь', command: 'помощь' }
      ];

      await realBitrixService.sendMessage(dialogId, message, buttons);
      
    } catch (error) {
      console.error('❌ Error in handleEmptyMessage:', error);
    }
  }

  async syncEmployee(userId) {
    try {
      console.log(`👤 Syncing employee ${userId}`);
      
      const userInfo = await realBitrixService.getUserInfo(userId);
      if (userInfo) {
        const fullName = `${userInfo.NAME || ''} ${userInfo.LAST_NAME || ''}`.trim();
        const email = userInfo.EMAIL || '';
        
        await database.addEmployee(userId, fullName, email);
        console.log(`✅ Employee synced: ${fullName} (${userId})`);
      } else {
        console.log(`⚠️ User info not found for ${userId}, using default`);
        // Создаем запись с дефолтными данными
        await database.addEmployee(userId, `Сотрудник ${userId}`, '');
      }
    } catch (error) {
      console.error(`❌ Error syncing employee ${userId}:`, error);
      // Не прерываем выполнение при ошибке синхронизации сотрудника
      // Создаем базовую запись
      try {
        await database.addEmployee(userId, `Сотрудник ${userId}`, '');
      } catch (dbError) {
        console.error(`❌ Failed to create default employee record:`, dbError);
      }
    }
  }

  // Вспомогательные методы
  formatTime(timestamp) {
    try {
      return new Date(timestamp).toLocaleTimeString('ru-RU', { 
        hour: '2-digit', 
        minute: '2-digit' 
      });
    } catch (error) {
      console.error('Error formatting time:', error);
      return '--:--';
    }
  }

  async sendFallbackMessage(dialogId, message) {
    try {
      await realBitrixService.sendMessage(dialogId, message);
    } catch (error) {
      console.error('❌ Failed to send fallback message:', error);
    }
  }

  // Метод для тестирования контроллера
  async testController() {
    console.log('🧪 Testing RealBotController...');
    
    const testScenarios = [
      {
        name: 'Help command',
        webhookData: {
          data: {
            params: {
              FROM_USER_ID: 'test_user_1',
              DIALOG_ID: 'test_chat_1',
              MESSAGE: 'помощь'
            }
          }
        }
      },
      {
        name: 'Status command',
        webhookData: {
          data: {
            params: {
              FROM_USER_ID: 'test_user_1',
              DIALOG_ID: 'test_chat_1',
              MESSAGE: 'статус'
            }
          }
        }
      },
      {
        name: 'Check-in command',
        webhookData: {
          data: {
            params: {
              FROM_USER_ID: 'test_user_1',
              DIALOG_ID: 'test_chat_1',
              MESSAGE: 'пришел'
            }
          }
        }
      }
    ];

    for (const scenario of testScenarios) {
      console.log(`\n🧪 Testing: ${scenario.name}`);
      try {
        const result = await this.handleBitrixWebhook(scenario.webhookData);
        console.log(`✅ ${scenario.name}:`, result.status);
      } catch (error) {
        console.log(`❌ ${scenario.name}:`, error.message);
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

module.exports = new RealBotController();
const hybridBitrixService = require('../services/hybrid-bitrix-service');
const locationService = require('../services/locationService');
const database = require('../models/database');

class HybridBotController {
  async handleMessage(userId, dialogId, message, location = null) {
    console.log('💬 Processing message:', { userId, dialogId, message, location: !!location });
    
    try {
      // Синхронизируем сотрудника
      await this.syncEmployee(userId);

      const cleanMessage = message ? message.trim().toLowerCase() : '';

      // Обработка геолокации
      if (location) {
        console.log('📍 Processing location');
        await this.handleLocation(userId, dialogId, location);
        return { status: 'success', type: 'location_processed' };
      }

      // Обработка текстовых команд
      if (cleanMessage) {
        console.log(`💬 Processing command: "${cleanMessage}"`);
        await this.processTextCommand(userId, dialogId, cleanMessage);
      } else {
        console.log('📭 Empty message received');
        await this.handleEmptyMessage(dialogId);
      }

      return { status: 'success', type: 'message_processed' };

    } catch (error) {
      console.error('❌ Error handling message:', error);
      try {
        await hybridBitrixService.sendMessage(
          dialogId, 
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
    await hybridBitrixService.requestLocation(
      dialogId, 
      '📍 Для отметки прихода отправьте ваше местоположение:'
    );
  }

  async handleCheckOut(userId, dialogId) {
    console.log(`🚪 User ${userId} requested check-out`);
    
    // Проверяем, была ли отметка о приходе сегодня
    const todayEvents = await database.getTodayEvents(userId);
    const hasCheckIn = todayEvents.some(event => event.event_type === 'in');

    if (!hasCheckIn) {
      console.log('❌ User tried to check out without check-in');
      await hybridBitrixService.sendMessage(
        dialogId, 
        '❌ Сначала отметьтесь о приходе командой "пришел"',
        [
          { text: '📍 Пришел', command: 'пришел' },
          { text: '❓ Помощь', command: 'помощь' }
        ]
      );
      return;
    }

    await hybridBitrixService.requestLocation(
      dialogId, 
      '📍 Для отметки ухода отправьте ваше местоположение:'
    );
  }

  async handleLocation(userId, dialogId, location) {
    console.log(`📍 Processing location for user ${userId}`);
    
    const { lat, lon } = location;
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
      await hybridBitrixService.sendMessage(
        dialogId, 
        'ℹ️ Вы уже отметили и приход, и уход сегодня.',
        [
          { text: '📊 Статус', command: 'статус' },
          { text: '❓ Помощь', command: 'помощь' }
        ]
      );
      return;
    }

    // Сохраняем событие
    if (isInOffice || eventType === 'out') {
      const status = isInOffice ? 'ok' : 'out_of_zone';
      
      console.log(`💾 Saving ${eventType} event for user ${userId}`);
      await database.addAttendanceEvent(userId, eventType, lat, lon, status);
      
      // Отправляем сообщение о статусе
      await hybridBitrixService.sendMessage(dialogId, message, buttons);
      
      console.log(`✅ ${eventType.toUpperCase()} recorded for user ${userId}`);
    } else {
      // Не в офисе при попытке прийти
      console.log('❌ User outside office during check-in attempt');
      await hybridBitrixService.sendMessage(dialogId, message);
    }
  }

  async handleStatus(userId, dialogId) {
    console.log(`📊 User ${userId} requested status`);
    
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
      statusMessage += `✅ Пришел: ${time}\n`;
    } else {
      statusMessage += `❌ Приход: не отмечен\n`;
    }

    if (checkOut) {
      const time = this.formatTime(checkOut.timestamp);
      statusMessage += `✅ Ушел: ${time}\n`;
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

    await hybridBitrixService.sendMessage(dialogId, statusMessage, buttons);
  }

  async handleHelp(dialogId) {
    console.log(`❓ Help requested in dialog ${dialogId}`);
    
    const helpMessage = `🤖 *Бот учета рабочего времени*\n\n📍 *Пришел* - отметить приход в офисе\n🚪 *Ушел* - отметить уход из офиса\n📊 *Статус* - посмотреть сегодняшние отметки\n❓ *Помощь* - показать эту справку\n\n*Для отметок требуется отправка геолокации!*`;

    const buttons = [
      { text: '📍 Пришел', command: 'пришел' },
      { text: '🚪 Ушел', command: 'ушел' },
      { text: '📊 Статус', command: 'статус' }
    ];

    await hybridBitrixService.sendMessage(dialogId, helpMessage, buttons);
  }

  async handleUnknownCommand(dialogId) {
    console.log(`❓ Unknown command in dialog ${dialogId}`);
    
    const message = "❓ Не понимаю команду. Напишите 'помощь' для списка команд.";
    const buttons = [
      { text: '❓ Помощь', command: 'помощь' }
    ];

    await hybridBitrixService.sendMessage(dialogId, message, buttons);
  }

  async handleEmptyMessage(dialogId) {
    console.log(`📭 Empty message in dialog ${dialogId}`);
    
    const message = "🤖 Бот учета времени готов к работе. Напишите 'помощь' для списка команд.";
    const buttons = [
      { text: '❓ Помощь', command: 'помощь' }
    ];

    await hybridBitrixService.sendMessage(dialogId, message, buttons);
  }

  async syncEmployee(userId) {
    try {
      console.log(`👤 Syncing employee ${userId}`);
      const userInfo = await hybridBitrixService.getUserInfo(userId);
      
      await database.addEmployee(userId, `${userInfo.NAME} ${userInfo.LAST_NAME}`, userInfo.EMAIL);
      console.log(`✅ Employee synced: ${userInfo.NAME} ${userInfo.LAST_NAME}`);
    } catch (error) {
      console.error(`❌ Error syncing employee ${userId}:`, error);
      // Создаем базовую запись
      await database.addEmployee(userId, `Сотрудник ${userId}`, '');
    }
  }

  formatTime(timestamp) {
    try {
      return new Date(timestamp).toLocaleTimeString('ru-RU', { 
        hour: '2-digit', 
        minute: '2-digit' 
      });
    } catch (error) {
      return '--:--';
    }
  }

  // Тестирование контроллера
  async testController() {
    console.log('\n🧪 Testing HybridBotController...');
    
    const testScenarios = [
      {
        name: 'Help command',
        userId: 'test_user_1',
        dialogId: 'chat_1',
        message: 'помощь'
      },
      {
        name: 'Status command',
        userId: 'test_user_1',
        dialogId: 'chat_1', 
        message: 'статус'
      },
      {
        name: 'Check-in command',
        userId: 'test_user_1',
        dialogId: 'chat_1',
        message: 'пришел'
      },
      {
        name: 'Location test',
        userId: 'test_user_1', 
        dialogId: 'chat_1',
        message: '',
        location: { lat: 57.152105, lon: 65.592075 }
      }
    ];

    for (const test of testScenarios) {
      console.log(`\n🧪 Testing: ${test.name}`);
      try {
        const result = await this.handleMessage(
          test.userId, 
          test.dialogId, 
          test.message, 
          test.location
        );
        console.log(`✅ ${test.name}: ${result.status} (${result.type})`);
      } catch (error) {
        console.log(`❌ ${test.name}: ${error.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

module.exports = new HybridBotController();
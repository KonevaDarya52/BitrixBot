const bitrixService = require('../services/bitrixService');
const locationService = require('../services/locationService');
const database = require('../models/database');

class BotController {
  async handleMessage(messageData) {
    const { DIALOG_ID, FROM_USER_ID, MESSAGE, ATTACH } = messageData;
    
    try {
      // Сохраняем/обновляем информацию о сотруднике
      await this.syncEmployee(FROM_USER_ID);

      const cleanMessage = MESSAGE.trim().toLowerCase();

      // Обработка команд
      if (ATTACH && ATTACH.LOCATION) {
        await this.handleLocation(FROM_USER_ID, DIALOG_ID, ATTACH.LOCATION);
        return;
      }

      switch (cleanMessage) {
        case 'пришел':
        case 'start':
        case 'начал':
          await this.handleCheckIn(FROM_USER_ID, DIALOG_ID);
          break;
        
        case 'ушел':
        case 'уход':
        case 'конец':
          await this.handleCheckOut(FROM_USER_ID, DIALOG_ID);
          break;
        
        case 'статус':
        case 'status':
          await this.handleStatus(FROM_USER_ID, DIALOG_ID);
          break;
        
        case 'помощь':
        case 'help':
          await this.handleHelp(DIALOG_ID);
          break;
        
        default:
          await this.handleUnknownCommand(DIALOG_ID);
      }
    } catch (error) {
      console.error('Error handling message:', error);
      await bitrixService.sendMessage(DIALOG_ID, '❌ Произошла ошибка. Попробуйте позже.');
    }
  }

  async handleCheckIn(userId, dialogId) {
    await bitrixService.requestLocation(dialogId, 'Для отметки прихода отправьте ваше местоположение:');
  }

  async handleCheckOut(userId, dialogId) {
    // Проверяем, была ли отметка о приходе сегодня
    const todayEvents = await database.getTodayEvents(userId);
    const hasCheckIn = todayEvents.some(event => event.event_type === 'in');

    if (!hasCheckIn) {
      await bitrixService.sendMessage(dialogId, '❌ Сначала отметьтесь о приходе командой "пришел"');
      return;
    }

    await bitrixService.requestLocation(dialogId, 'Для отметки ухода отправьте ваше местоположение:');
  }

  async handleLocation(userId, dialogId, location) {
    const { LAT: lat, LNG: lon } = location;
    const isInOffice = locationService.isInOffice(lat, lon);

    // Определяем тип события (приход/уход)
    const todayEvents = await database.getTodayEvents(userId);
    const hasCheckIn = todayEvents.some(event => event.event_type === 'in');
    const hasCheckOut = todayEvents.some(event => event.event_type === 'out');

    let eventType, status, message;

    if (!hasCheckIn) {
      // Первая отметка - приход
      eventType = 'in';
      status = isInOffice ? 'ok' : 'out_of_zone';
      message = locationService.getLocationStatusMessage(isInOffice, 'in');
    } else if (hasCheckIn && !hasCheckOut) {
      // Вторая отметка - уход
      eventType = 'out';
      status = isInOffice ? 'ok' : 'out_of_zone';
      message = locationService.getLocationStatusMessage(isInOffice, 'out');
    } else {
      // Уже есть обе отметки
      await bitrixService.sendMessage(dialogId, 'ℹ️ Вы уже отметили и приход, и уход сегодня.');
      return;
    }

    // Сохраняем событие
    if (isInOffice || eventType === 'out') {
      await database.addAttendanceEvent(userId, eventType, lat, lon, status);
    }

    await bitrixService.sendMessage(dialogId, message);

    // Показываем меню после успешной отметки
    if (isInOffice) {
      setTimeout(() => this.showMainMenu(dialogId), 1000);
    }
  }

  async handleStatus(userId, dialogId) {
    const todayEvents = await database.getTodayEvents(userId);
    const employee = await database.getEmployeeByBxId(userId);

    let statusMessage = `📊 Ваш статус за сегодня:\n\n`;
    statusMessage += `👤 ${employee?.full_name || 'Сотрудник'}\n`;

    const checkIn = todayEvents.find(event => event.event_type === 'in');
    const checkOut = todayEvents.find(event => event.event_type === 'out');

    if (checkIn) {
      const time = new Date(checkIn.timestamp).toLocaleTimeString('ru-RU', { 
        hour: '2-digit', minute: '2-digit' 
      });
      statusMessage += `✅ Пришел: ${time}\n`;
    } else {
      statusMessage += `❌ Приход: не отмечен\n`;
    }

    if (checkOut) {
      const time = new Date(checkOut.timestamp).toLocaleTimeString('ru-RU', { 
        hour: '2-digit', minute: '2-digit' 
      });
      statusMessage += `✅ Ушел: ${time}\n`;
    } else if (checkIn) {
      statusMessage += `⏳ Уход: ожидание отметки\n`;
    } else {
      statusMessage += `❌ Уход: не отмечен\n`;
    }

    await bitrixService.sendMessage(dialogId, statusMessage);
    await this.showMainMenu(dialogId);
  }

  async handleHelp(dialogId) {
    const helpMessage = `
🤖 *Бот учета рабочего времени*

📍 *Пришел* - отметить приход в офисе
🚪 *Ушел* - отметить уход из офиса  
📊 *Статус* - посмотреть сегодняшние отметки
❓ *Помощь* - показать эту справку

*Для отметок требуется разрешить отправку геолокации!*
    `.trim();

    await bitrixService.sendMessage(dialogId, helpMessage);
    await this.showMainMenu(dialogId);
  }

  async handleUnknownCommand(dialogId) {
    const message = "❓ Не понимаю команду. Напишите 'помощь' для списка команд.";
    await bitrixService.sendMessage(dialogId, message);
    await this.showMainMenu(dialogId);
  }

  async showMainMenu(dialogId) {
    const keyboard = bitrixService.createHelpKeyboard();
    await bitrixService.sendMessageWithKeyboard(dialogId, 'Выберите действие:', keyboard);
  }

  async syncEmployee(userId) {
    try {
      const userInfo = await bitrixService.getUserInfo(userId);
      if (userInfo) {
        await database.addEmployee(
          userId, 
          `${userInfo.NAME} ${userInfo.LAST_NAME}`.trim(),
          userInfo.EMAIL
        );
      }
    } catch (error) {
      console.error('Error syncing employee:', error);
    }
  }
}

module.exports = new BotController();
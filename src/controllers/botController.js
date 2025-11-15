const bitrixService = require('../services/bitrixService');
const locationService = require('../services/locationService');
const database = require('../models/database');

class BotController {
  async handleMessage(messageData) {
    const { DIALOG_ID, FROM_USER_ID, MESSAGE, ATTACH } = messageData;
    
    // Валидация входных данных
    if (!DIALOG_ID || !FROM_USER_ID || !MESSAGE) {
      console.error('Invalid message data:', messageData);
      return;
    }

    try {
      // Сохраняем/обновляем информацию о сотруднике
      await this.syncEmployee(FROM_USER_ID);

      const cleanMessage = MESSAGE.trim().toLowerCase();

      // Обработка геолокации
      if (ATTACH && ATTACH.LOCATION) {
        await this.handleLocation(FROM_USER_ID, DIALOG_ID, ATTACH.LOCATION);
        return;
      }

      // Обработка текстовых команд
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
      try {
        await bitrixService.sendMessage(DIALOG_ID, '❌ Произошла ошибка. Попробуйте позже.');
      } catch (sendError) {
        console.error('Failed to send error message:', sendError);
      }
    }
  }

  async handleCheckIn(userId, dialogId) {
    try {
      await bitrixService.requestLocation(dialogId, '📍 Для отметки прихода отправьте ваше местоположение:');
    } catch (error) {
      console.error('Error in handleCheckIn:', error);
      await this.sendFallbackMessage(dialogId, 'Не удалось запросить геолокацию. Попробуйте позже.');
    }
  }

  async handleCheckOut(userId, dialogId) {
    try {
      // Проверяем, была ли отметка о приходе сегодня
      const todayEvents = await database.getTodayEvents(userId);
      const hasCheckIn = todayEvents.some(event => event.event_type === 'in');

      if (!hasCheckIn) {
        await bitrixService.sendMessage(dialogId, '❌ Сначала отметьтесь о приходе командой "пришел"');
        return;
      }

      // Проверяем, не отметился ли уже об уходе
      const hasCheckOut = todayEvents.some(event => event.event_type === 'out');
      if (hasCheckOut) {
        await bitrixService.sendMessage(dialogId, 'ℹ️ Вы уже отметили уход сегодня.');
        return;
      }

      await bitrixService.requestLocation(dialogId, '📍 Для отметки ухода отправьте ваше местоположение:');
    } catch (error) {
      console.error('Error in handleCheckOut:', error);
      await this.sendFallbackMessage(dialogId, 'Ошибка при обработке команды ухода.');
    }
  }

  async handleLocation(userId, dialogId, location) {
    try {
      // Валидация координат
      if (!location || typeof location.LAT === 'undefined' || typeof location.LNG === 'undefined') {
        await bitrixService.sendMessage(dialogId, '❌ Неверные данные геолокации.');
        return;
      }

      const { LAT: lat, LNG: lon } = location;
      const isInOffice = locationService.isInOffice(lat, lon);

      // Определяем тип события (приход/уход)
      const todayEvents = await database.getTodayEvents(userId);
      const hasCheckIn = todayEvents.some(event => event.event_type === 'in');
      const hasCheckOut = todayEvents.some(event => event.event_type === 'out');

      let eventType, message;

      if (!hasCheckIn) {
        // Первая отметка - приход
        eventType = 'in';
        message = locationService.getLocationStatusMessage(isInOffice, 'in');
      } else if (hasCheckIn && !hasCheckOut) {
        // Вторая отметка - уход
        eventType = 'out';
        message = locationService.getLocationStatusMessage(isInOffice, 'out');
      } else {
        // Уже есть обе отметки
        await bitrixService.sendMessage(dialogId, 'ℹ️ Вы уже отметили и приход, и уход сегодня.');
        return;
      }

      // Сохраняем событие только если в офисе или это уход
      if (isInOffice || eventType === 'out') {
        const status = isInOffice ? 'ok' : 'out_of_zone';
        await database.addAttendanceEvent(userId, eventType, lat, lon, status);
        
        // Отправляем сообщение о статусе
        await bitrixService.sendMessage(dialogId, message);

        // Показываем меню после успешной отметки в офисе
        if (isInOffice) {
          setTimeout(() => this.showMainMenu(dialogId), 1000);
        }
      } else {
        // Не в офисе при попытке прийти
        await bitrixService.sendMessage(dialogId, message);
      }

    } catch (error) {
      console.error('Error in handleLocation:', error);
      await this.sendFallbackMessage(dialogId, 'Ошибка при обработке геолокации.');
    }
  }

  async handleStatus(userId, dialogId) {
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

      await bitrixService.sendMessage(dialogId, statusMessage);
      await this.showMainMenu(dialogId);
    } catch (error) {
      console.error('Error in handleStatus:', error);
      await this.sendFallbackMessage(dialogId, 'Ошибка при получении статуса.');
    }
  }

  async handleHelp(dialogId) {
    try {
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
    } catch (error) {
      console.error('Error in handleHelp:', error);
      await this.sendFallbackMessage(dialogId, 'Ошибка при показе справки.');
    }
  }

  async handleUnknownCommand(dialogId) {
    try {
      const message = "❓ Не понимаю команду. Напишите 'помощь' для списка команд.";
      await bitrixService.sendMessage(dialogId, message);
      await this.showMainMenu(dialogId);
    } catch (error) {
      console.error('Error in handleUnknownCommand:', error);
    }
  }

  async showMainMenu(dialogId) {
    try {
      const keyboard = bitrixService.createHelpKeyboard();
      await bitrixService.sendMessageWithKeyboard(dialogId, 'Выберите действие:', keyboard);
    } catch (error) {
      console.error('Error showing main menu:', error);
      // Если не удалось отправить клавиатуру, отправляем простое сообщение
      await this.sendFallbackMessage(dialogId, 'Используйте команды: пришел, ушел, статус, помощь');
    }
  }

  async syncEmployee(userId) {
    try {
      const userInfo = await bitrixService.getUserInfo(userId);
      if (userInfo) {
        const fullName = `${userInfo.NAME || ''} ${userInfo.LAST_NAME || ''}`.trim();
        await database.addEmployee(userId, fullName, userInfo.EMAIL || '');
        console.log(`Synced employee: ${fullName} (${userId})`);
      }
    } catch (error) {
      console.error('Error syncing employee:', error);
      // Не прерываем выполнение при ошибке синхронизации сотрудника
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
      return '--:--';
    }
  }

  async sendFallbackMessage(dialogId, message) {
    try {
      await bitrixService.sendMessage(dialogId, message);
    } catch (error) {
      console.error('Failed to send fallback message:', error);
    }
  }
}

module.exports = new BotController();
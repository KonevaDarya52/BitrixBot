const axios = require('axios');
const database = require('../models/database');
const locationService = require('../services/locationService');

class BotHandler {
    async handleBot(req, res) {
        try {
            const { data } = req.body;
            console.log('🤖 Bot event:', data);

            // Регистрация бота
            if (data.event === 'ONIMBOTDELETE') {
                return res.json({});
            }

            // Обработка сообщений
            if (data.event === 'ONIMBOTMESSAGEADD') {
                await this.handleMessage(data);
            }

            res.json({});
        } catch (error) {
            console.error('❌ Bot handler error:', error);
            res.json({});
        }
    }

    async handleMessage(data) {
        const { bot_id, dialog_id, message } = data.data.params;

        try {
            // Сохраняем информацию о пользователе
            await this.syncUser(data.data.params.user_id);

            const cleanMessage = message.body.toLowerCase().trim();

            switch (cleanMessage) {
                case 'пришел':
                case 'start':
                    await this.handleCheckIn(bot_id, dialog_id, data.data.params.user_id);
                    break;
                
                case 'ушел':
                case 'уход':
                    await this.handleCheckOut(bot_id, dialog_id, data.data.params.user_id);
                    break;
                
                case 'статус':
                    await this.handleStatus(bot_id, dialog_id, data.data.params.user_id);
                    break;
                
                case 'помощь':
                case 'help':
                    await this.handleHelp(bot_id, dialog_id);
                    break;
                
                default:
                    await this.handleUnknown(bot_id, dialog_id);
            }
        } catch (error) {
            console.error('❌ Message handling error:', error);
            await this.sendMessage(bot_id, dialog_id, '❌ Произошла ошибка. Попробуйте позже.');
        }
    }

    async handleCheckIn(botId, dialogId, userId) {
        const message = `📍 Для отметки прихода отправьте ваше местоположение.

Нажмите на скрепку 📎 и выберите "Геопозиция", затем отправьте ваше текущее местоположение.`;
        
        await this.sendMessage(botId, dialogId, message);
    }

    async handleCheckOut(botId, dialogId, userId) {
        // Проверяем, был ли приход сегодня
        const todayEvents = await database.getTodayEvents(userId);
        const hasCheckIn = todayEvents.some(event => event.event_type === 'in');

        if (!hasCheckIn) {
            await this.sendMessage(botId, dialogId, '❌ Сначала отметьтесь о приходе командой "пришел"');
            return;
        }

        const message = `🚪 Для отметки ухода отправьте ваше местоположение.

Нажмите на скрепку 📎 и выберите "Геопозиция", затем отправьте ваше текущее местоположение.`;
        
        await this.sendMessage(botId, dialogId, message);
    }

    async handleLocation(botId, dialogId, userId, location) {
        const { lat, lon } = location;
        const isInOffice = locationService.isInOffice(lat, lon);

        const todayEvents = await database.getTodayEvents(userId);
        const hasCheckIn = todayEvents.some(event => event.event_type === 'in');
        const hasCheckOut = todayEvents.some(event => event.event_type === 'out');

        let eventType, statusMessage;

        if (!hasCheckIn) {
            eventType = 'in';
            if (isInOffice) {
                statusMessage = '✅ Отлично! Вы отметились о приходе.';
                await database.addAttendanceEvent(userId, eventType, lat, lon, 'ok');
            } else {
                statusMessage = '❌ Вы находитесь вне офиса. Отметка возможна только в офисе.';
            }
        } else if (!hasCheckOut) {
            eventType = 'out';
            statusMessage = isInOffice ? 
                '✅ Спасибо за работу! Вы отметились об уходе.' :
                '✅ Уход отмечен (вне офиса).';
            await database.addAttendanceEvent(userId, eventType, lat, lon, isInOffice ? 'ok' : 'out_of_zone');
        } else {
            statusMessage = 'ℹ️ Вы уже отметили и приход, и уход сегодня.';
        }

        await this.sendMessage(botId, dialogId, statusMessage);
    }

    async handleStatus(botId, dialogId, userId) {
        const [todayEvents, employee] = await Promise.all([
            database.getTodayEvents(userId),
            database.getEmployeeByBxId(userId)
        ]);

        let statusMessage = `📊 Ваш статус за сегодня:\n\n`;
        statusMessage += `👤 ${employee?.full_name || 'Сотрудник'}\n`;

        const checkIn = todayEvents.find(event => event.event_type === 'in');
        const checkOut = todayEvents.find(event => event.event_type === 'out');

        if (checkIn) {
            const time = new Date(checkIn.timestamp).toLocaleTimeString('ru-RU');
            const status = checkIn.status === 'out_of_zone' ? ' (вне зоны)' : '';
            statusMessage += `✅ Пришел: ${time}${status}\n`;
        } else {
            statusMessage += `❌ Приход: не отмечен\n`;
        }

        if (checkOut) {
            const time = new Date(checkOut.timestamp).toLocaleTimeString('ru-RU');
            const status = checkOut.status === 'out_of_zone' ? ' (вне зоны)' : '';
            statusMessage += `✅ Ушел: ${time}${status}\n`;
        } else if (checkIn) {
            statusMessage += `⏳ Уход: ожидание отметки\n`;
        } else {
            statusMessage += `❌ Уход: не отмечен\n`;
        }

        await this.sendMessage(botId, dialogId, statusMessage);
    }

    async handleHelp(botId, dialogId) {
        const helpMessage = `🤖 *Бот учета рабочего времени*

📍 *Пришел* - отметить приход в офисе
🚪 *Ушел* - отметить уход из офиса  
📊 *Статус* - посмотреть сегодняшние отметки
❓ *Помощь* - показать эту справку

*Для отметок требуется отправить геолокацию через скрепку 📎*
        `.trim();

        await this.sendMessage(botId, dialogId, helpMessage);
    }

    async handleUnknown(botId, dialogId) {
        await this.sendMessage(botId, dialogId, 
            "❓ Не понимаю команду. Напишите 'помощь' для списка команд.");
    }

    async sendMessage(botId, dialogId, message) {
        try {
            const domain = process.env.BITRIX_DOMAIN;
            const clientId = process.env.BITRIX_CLIENT_ID;
            const clientSecret = process.env.BITRIX_CLIENT_SECRET;

            const url = `https://${domain}/rest/imbot.message.add`;
            
            await axios.post(url, {
                BOT_ID: botId,
                CLIENT_ID: clientId,
                DIALOG_ID: dialogId,
                MESSAGE: message
            });
        } catch (error) {
            console.error('❌ Send message error:', error.response?.data);
        }
    }

    async syncUser(userId) {
        try {
            const domain = process.env.BITRIX_DOMAIN;
            const clientId = process.env.BITRIX_CLIENT_ID;

            const url = `https://${domain}/rest/user.get`;
            const response = await axios.post(url, { ID: userId });
            const user = response.data.result[0];

            if (user) {
                const fullName = `${user.NAME || ''} ${user.LAST_NAME || ''}`.trim();
                await database.addEmployee(userId, fullName, user.EMAIL || '');
            }
        } catch (error) {
            console.error('❌ Sync user error:', error.message);
        }
    }
}

module.exports = new BotHandler();
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, './config/.env') });

const TelegramBot = require('node-telegram-bot-api');
const database = require('./src/models/database');
const locationService = require('./src/services/locationService');

// Токен вашего Telegram бота (получите у @BotFather)
const TELEGRAM_TOKEN = '8207077542:AAGTBQ5UfmCQS-Wc0Jl1C9s0L_YAnWKPlC4';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

console.log('🤖 Telegram Bot started...');

// Обработчик текстовых сообщений
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text?.toLowerCase().trim();
    
    try {
        if (msg.location) {
            // Обработка геолокации
            const { latitude: lat, longitude: lon } = msg.location;
            const isInOffice = locationService.isInOffice(lat, lon);
            
            // Сохраняем в базу (для теста используем chatId как userId)
            if (isInOffice) {
                await database.addAttendanceEvent(chatId, 'in', lat, lon, 'ok');
                await bot.sendMessage(chatId, '✅ Отлично! Вы отметились о приходе.');
            } else {
                await bot.sendMessage(chatId, '❌ Вы находитесь вне офиса.');
            }
            return;
        }
        
        switch (text) {
            case 'пришел':
            case 'start':
            case 'начал':
                await bot.sendMessage(chatId, '📍 Для отметки прихода отправьте ваше местоположение:', {
                    reply_markup: {
                        keyboard: [[{
                            text: '📍 Отправить местоположение',
                            request_location: true
                        }]],
                        resize_keyboard: true
                    }
                });
                break;
                
            case 'ушел':
            case 'уход':
            case 'конец':
                await bot.sendMessage(chatId, '📍 Для отметки ухода отправьте ваше местоположение:', {
                    reply_markup: {
                        keyboard: [[{
                            text: '📍 Отправить местоположение', 
                            request_location: true
                        }]],
                        resize_keyboard: true
                    }
                });
                break;
                
            case 'статус':
            case 'status':
                const todayEvents = await database.getTodayEvents(chatId);
                let statusMessage = '📊 Ваш статус за сегодня:\n\n';
                
                const checkIn = todayEvents.find(e => e.event_type === 'in');
                const checkOut = todayEvents.find(e => e.event_type === 'out');
                
                if (checkIn) {
                    statusMessage += `✅ Пришел: ${new Date(checkIn.timestamp).toLocaleTimeString()}\n`;
                } else {
                    statusMessage += '❌ Приход: не отмечен\n';
                }
                
                if (checkOut) {
                    statusMessage += `✅ Ушел: ${new Date(checkOut.timestamp).toLocaleTimeString()}\n`;
                } else if (checkIn) {
                    statusMessage += '⏳ Уход: ожидание отметки\n';
                } else {
                    statusMessage += '❌ Уход: не отмечен\n';
                }
                
                await bot.sendMessage(chatId, statusMessage);
                break;
                
            case 'помощь':
            case 'help':
                const helpMessage = `
🤖 *Бот учета рабочего времени*

📍 *Пришел* - отметить приход в офисе
🚪 *Ушел* - отметить уход из офиса  
📊 *Статус* - посмотреть сегодняшние отметки
❓ *Помощь* - показать эту справку

*Для отметок требуется отправить геолокацию!*
                `.trim();
                
                await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
                break;
                
            default:
                await bot.sendMessage(chatId, '❓ Не понимаю команду. Напишите "помощь" для списка команд.');
        }
        
    } catch (error) {
        console.error('Telegram bot error:', error);
        await bot.sendMessage(chatId, '❌ Произошла ошибка. Попробуйте позже.');
    }
});

console.log('✅ Telegram Bot is running...');
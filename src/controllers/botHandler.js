const express = require('express');
const router = express.Router();
const axios = require('axios');

// Обработчик вебхуков от Bitrix24
router.post('/', async (req, res) => {
    try {
        console.log('🤖 Received bot webhook:', JSON.stringify(req.body, null, 2));
        
        const { event, data } = req.body;
        
        if (event === 'ONIMBOTMESSAGEADD') {
            await handleBotMessage(data);
        }
        
        res.json({});
    } catch (error) {
        console.error('❌ Bot handler error:', error);
        res.json({});
    }
});

async function handleBotMessage(data) {
    try {
        const { bot_id, dialog_id, message } = data.params;
        const userId = data.params.user_id;
        
        console.log('💬 Message from user:', { userId, message: message.body });
        
        const cleanMessage = message.body.toLowerCase().trim();
        
        // Простой ответ для теста
        let response = "❓ Не понимаю команду. Напишите 'помощь'";
        
        if (cleanMessage === 'пришел') {
            response = "📍 Для отметки прихода отправьте ваше местоположение через скрепку 📎";
        } else if (cleanMessage === 'ушел') {
            response = "🚪 Для отметки ухода отправьте ваше местоположение через скрепку 📎";
        } else if (cleanMessage === 'статус') {
            response = "📊 Ваш статус: приход не отмечен, уход не отмечен";
        } else if (cleanMessage === 'помощь' || cleanMessage === 'help') {
            response = `🤖 Бот учета времени\n\nКоманды:\n📍 пришел - отметка прихода\n🚪 ушел - отметка ухода\n📊 статус - ваш статус\n❓ помощь - эта справка`;
        }
        
        // Отправляем ответ
        await sendMessage(bot_id, dialog_id, response);
        
    } catch (error) {
        console.error('❌ Message handling error:', error);
    }
}

async function sendMessage(botId, dialogId, message) {
    try {
        const domain = process.env.BITRIX_DOMAIN;
        const clientId = process.env.BITRIX_CLIENT_ID;
        
        const url = `https://${domain}/rest/imbot.message.add`;
        
        await axios.post(url, {
            BOT_ID: botId,
            CLIENT_ID: clientId,
            DIALOG_ID: dialogId,
            MESSAGE: message
        });
        
        console.log('✅ Message sent to:', dialogId);
    } catch (error) {
        console.error('❌ Send message error:', error.response?.data);
    }
}

module.exports = router;
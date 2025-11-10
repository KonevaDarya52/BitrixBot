const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../config/.env') });

const bitrixService = require('./services/bitrixService');

async function testWebhook() {
    try {
        console.log('🔧 Testing Bitrix webhook...');
        console.log('Domain:', process.env.BITRIX_DOMAIN);
        console.log('Token length:', process.env.BITRIX_WEBHOOK_TOKEN?.length || '❌ Missing');
        
        // Тест 1: Проверка подключения
        console.log('\n🧪 Test 1: Basic connection...');
        
        // Тест 2: Отправка сообщения (закомментируйте сначала)
        console.log('\n🧪 Test 2: Sending message...');
        // ЗАКОММЕНТИРУЙTE ЭТУ СТРОКУ ПЕРВЫЙ РАЗ:
        // const result = await bitrixService.sendMessage('1', 'Тестовое сообщение от бота');
        // console.log('✅ Message sent:', result);
        
        console.log('\n📝 Next steps:');
        console.log('1. Uncomment the sendMessage line in test-webhook.js');
        console.log('2. Replace "1" with actual chat ID');
        console.log('3. Run: node test-webhook.js');
        
    } catch (error) {
        console.error('❌ Webhook error:');
        console.error('Message:', error.message);
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Response:', error.response.data);
        }
    }
}

testWebhook();
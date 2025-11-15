const path = require('path');
require('dotenv').config({ path: path.join(__dirname, 'config/.env') });

const axios = require('axios');

async function testNewWebhook() {
    const domain = process.env.BITRIX_DOMAIN;
    const token = process.env.BITRIX_WEBHOOK_TOKEN;

    console.log('🧪 Testing new webhook configuration...');
    console.log('Domain:', domain);
    console.log('Token starts with:', token ? token.substring(0, 8) + '...' : 'NOT SET');

    if (!token) {
        console.log('❌ Token not found in .env');
        return;
    }

    // Тест 1: Проверка пользователя
    console.log('\n1. Testing user.current...');
    try {
        const userResponse = await axios.post(`https://${domain}/rest/user.current.json`, {}, {
            params: { auth: token },
            timeout: 10000
        });
        console.log('✅ user.current: SUCCESS');
        console.log('User:', userResponse.data.result.NAME);
    } catch (error) {
        console.log('❌ user.current: FAILED');
        console.log('Error:', error.response?.data || error.message);
    }

    // Тест 2: Отправка сообщения
    console.log('\n2. Testing im.message.add...');
    try {
        const messageResponse = await axios.post(`https://${domain}/rest/im.message.add.json`, {
            DIALOG_ID: '1', // ID администратора
            MESSAGE: '🤖 Тест нового вебхука - бот учета времени работает!'
        }, {
            params: { auth: token },
            timeout: 10000
        });
        console.log('✅ im.message.add: SUCCESS');
        console.log('Message ID:', messageResponse.data.result);
    } catch (error) {
        console.log('❌ im.message.add: FAILED');
        console.log('Error:', error.response?.data || error.message);
        
        if (error.response?.data?.error === 'ACCESS_DENIED') {
            console.log('💡 Webhook needs "im" permission');
        }
    }

    // Тест 3: Получение информации о пользователе
    console.log('\n3. Testing user.get...');
    try {
        const userGetResponse = await axios.post(`https://${domain}/rest/user.get.json`, {
            ID: '1'
        }, {
            params: { auth: token },
            timeout: 10000
        });
        console.log('✅ user.get: SUCCESS');
        console.log('User:', userGetResponse.data.result[0]?.NAME);
    } catch (error) {
        console.log('❌ user.get: FAILED');
        console.log('Error:', error.response?.data || error.message);
    }
}

testNewWebhook();
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, 'config/.env') });

console.log('🚀 Testing Hybrid System (Emulator + Local Logic)');
console.log('=================================================');

async function testHybridSystem() {
    try {
        // 1. Проверяем и запускаем эмулятор
        console.log('\n1. Checking emulator...');
        const axios = require('axios');
        
        try {
            const status = await axios.get('http://localhost:3001/webhook/status', { timeout: 3000 });
            console.log('✅ Emulator is running:', status.data.status);
        } catch (error) {
            console.log('❌ Emulator not running');
            console.log('💡 Start emulator in another terminal: node bitrix-bot-emulator.js');
            return;
        }

        // 2. Тестируем гибридный сервис
        console.log('\n2. Testing HybridBitrixService...');
        const hybridBitrixService = require('./src/services/hybrid-bitrix-service');
        await hybridBitrixService.testService();

        // 3. Тестируем гибридный контроллер
        console.log('\n3. Testing HybridBotController...');
        const hybridBotController = require('./src/controllers/hybrid-bot-controller');
        await hybridBotController.testController();

        console.log('\n🎉 Hybrid system test completed!');
        console.log('=================================================');
        console.log('💡 Your bot is fully functional locally!');
        console.log('💡 Use test-with-emulator.js for interactive testing');

    } catch (error) {
        console.log('❌ Test failed:', error.message);
    }
}

testHybridSystem();
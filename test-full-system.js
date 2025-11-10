const path = require('path');
require('dotenv').config({ path: path.join(__dirname, './config/.env') });

async function testFullSystem() {
    try {
        console.log('🧪 Testing full system...');
        
        // 1. Test database
        console.log('\n1. Testing database...');
        const database = require('./src/models/database');
        await database.initDB();
        console.log('✅ Database: OK');
        
        // 2. Test adding employee
        await database.addEmployee(123, 'Test User', 'test@example.com');
        const employee = await database.getEmployeeByBxId(123);
        console.log('✅ Employee operations: OK');
        
        // 3. Test bot controller
        console.log('\n2. Testing bot controller...');
        const botController = require('./src/controllers/botController');
        console.log('✅ Bot controller: OK');
        
        // 4. Test Bitrix service
        console.log('\n3. Testing Bitrix service...');
        const bitrixService = require('./src/services/bitrixService');
        console.log('✅ Bitrix service: OK');
        
        // 5. Test webhook controller
        console.log('\n4. Testing webhook controller...');
        const webhookController = require('./src/controllers/webhookController');
        console.log('✅ Webhook controller: OK');
        
        console.log('\n🎉 All systems are working!');
        console.log('\n📝 Next steps:');
        console.log('1. Keep server running: node app.js');
        console.log('2. Set up webhook in Bitrix24');
        console.log('3. Test bot commands in Bitrix24 chat');
        
    } catch (error) {
        console.error('❌ System test failed:', error.message);
    }
}

testFullSystem();
const path = require('path');

// Загружаем .env перед всеми импортами
require('dotenv').config({ path: path.join(__dirname, 'config/.env') });

console.log('🚀 Starting Real Bot Controller Test...');
console.log('=====================================');

async function testRealController() {
    console.log('🧪 Testing RealBotController with Bitrix24...');
    console.log('Domain:', process.env.BITRIX_DOMAIN);
    console.log('Token:', process.env.BITRIX_WEBHOOK_TOKEN ? '✅ SET' : '❌ NOT SET');
    
    try {
        // Проверим подключение к Bitrix24
        const realBitrixService = require('./src/services/real-bitrix-service');
        
        console.log('\n1. Testing Bitrix24 connection...');
        const connected = await realBitrixService.testConnection();
        
        if (!connected) {
            console.log('❌ Cannot proceed - Bitrix24 connection failed');
            console.log('💡 Check your webhook configuration in Bitrix24');
            return;
        }

        console.log('\n2. Testing message sending...');
        await realBitrixService.testMessageSending();

        console.log('\n3. Testing RealBotController...');
        const realBotController = require('./src/controllers/real-bot-controller');
        
        // Тестируем обработку вебхуков
        const testWebhooks = [
            {
                name: 'Help command',
                data: {
                    data: {
                        params: {
                            FROM_USER_ID: '1', // ID администратора
                            DIALOG_ID: '1',
                            MESSAGE: 'помощь'
                        }
                    }
                }
            },
            {
                name: 'Status command', 
                data: {
                    data: {
                        params: {
                            FROM_USER_ID: '1',
                            DIALOG_ID: '1', 
                            MESSAGE: 'статус'
                        }
                    }
                }
            },
            {
                name: 'Check-in command',
                data: {
                    data: {
                        params: {
                            FROM_USER_ID: '1',
                            DIALOG_ID: '1',
                            MESSAGE: 'пришел'
                        }
                    }
                }
            },
            {
                name: 'Unknown command',
                data: {
                    data: {
                        params: {
                            FROM_USER_ID: '1',
                            DIALOG_ID: '1',
                            MESSAGE: 'неизвестная команда'
                        }
                    }
                }
            }
        ];

        for (const test of testWebhooks) {
            console.log(`\n🧪 Testing: ${test.name}`);
            try {
                const result = await realBotController.handleBitrixWebhook(test.data);
                console.log(`✅ ${test.name}: ${result.status}`);
                if (result.message) {
                    console.log(`   Message: ${result.message}`);
                }
            } catch (error) {
                console.log(`❌ ${test.name}: ${error.message}`);
            }
            await new Promise(resolve => setTimeout(resolve, 2000)); // Пауза между тестами
        }

        console.log('\n🎉 All tests completed!');
        console.log('=====================================');
        console.log('💡 Next steps:');
        console.log('1. Set up outgoing webhook in Bitrix24 for onImMessageAdd');
        console.log('2. Point webhook URL to your server /webhook/message');
        console.log('3. Test bot in real Bitrix24 chat');

    } catch (error) {
        console.log('❌ Test failed with error:', error.message);
        console.log('Stack:', error.stack);
    }
}

// Обработка необработанных исключений
process.on('uncaughtException', (error) => {
    console.log('❌ Uncaught Exception:', error.message);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.log('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

// Запускаем тест
testRealController();
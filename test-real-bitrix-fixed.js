const axios = require('axios');
require('dotenv').config({ path: './config/.env' });

async function testFixedMethods() {
    const domain = process.env.BITRIX_DOMAIN;
    const token = process.env.BITRIX_WEBHOOK_TOKEN;

    console.log('🧪 Testing fixed Bitrix24 methods...');

    if (!token) {
        console.log('❌ BITRIX_WEBHOOK_TOKEN not found');
        return;
    }

    // Тестовые сообщения с разными сценариями
    const testScenarios = [
        {
            name: 'Simple message',
            payload: {
                DIALOG_ID: '1',
                MESSAGE: '🤖 Простое тестовое сообщение от бота'
            }
        },
        {
            name: 'Message with keyboard',
            payload: {
                DIALOG_ID: '1',
                MESSAGE: 'Выберите действие:',
                ATTACH: JSON.stringify({
                    KEYBOARD: [
                        [
                            {
                                "TEXT": "📍 Пришел",
                                "BG_COLOR": "#4caf50",
                                "TEXT_COLOR": "#fff",
                                "DISPLAY": "LINE"
                            },
                            {
                                "TEXT": "🚪 Ушел",
                                "BG_COLOR": "#f44336",
                                "TEXT_COLOR": "#fff", 
                                "DISPLAY": "LINE"
                            }
                        ]
                    ]
                })
            }
        },
        {
            name: 'Location request',
            payload: {
                DIALOG_ID: '1',
                MESSAGE: '📍 Для отметки прихода отправьте ваше местоположение:',
                ATTACH: JSON.stringify({
                    KEYBOARD: [
                        [
                            {
                                "TEXT": "📍 Отправить местоположение",
                                "BG_COLOR": "#29619b",
                                "TEXT_COLOR": "#fff",
                                "DISPLAY": "LINE",
                                "ACTION": "client",
                                "ACTION_VALUE": "shareLocation"
                            }
                        ]
                    ]
                })
            }
        }
    ];

    for (const scenario of testScenarios) {
        try {
            console.log(`\n🧪 Testing: ${scenario.name}`);
            console.log('Message:', scenario.payload.MESSAGE);
            
            const response = await axios.post(`https://${domain}/rest/im.message.add.json`, scenario.payload, {
                params: { auth: token }
            });
            
            console.log('✅ SUCCESS');
            console.log('Response:', response.data);
            
        } catch (error) {
            console.log('❌ FAILED');
            if (error.response) {
                console.log('Status:', error.response.status);
                console.log('Error:', error.response.data);
                
                if (error.response.data.error === 'MESSAGE_EMPTY') {
                    console.log('💡 Message is empty - need to provide MESSAGE field');
                }
            } else {
                console.log('Error:', error.message);
            }
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000)); // Пауза между запросами
    }
}

// Сначала проверим подключение
async function checkConnection() {
    const domain = process.env.BITRIX_DOMAIN;
    const token = process.env.BITRIX_WEBHOOK_TOKEN;

    try {
        console.log('🔍 Checking Bitrix24 connection...');
        const response = await axios.post(`https://${domain}/rest/user.current.json`, {}, {
            params: { auth: token }
        });
        console.log('✅ Connection OK - User:', response.data.result.NAME);
        return true;
    } catch (error) {
        console.log('❌ Connection failed:', error.response?.data || error.message);
        return false;
    }
}

async function main() {
    const connected = await checkConnection();
    if (connected) {
        await testFixedMethods();
    }
}

main();
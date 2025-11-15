const path = require('path');

// Загружаем .env из папки config
require('dotenv').config({ path: path.join(__dirname, 'config/.env') });

console.log('🔍 Checking environment variables...');
console.log('BITRIX_DOMAIN:', process.env.BITRIX_DOMAIN || '❌ NOT SET');
console.log('BITRIX_WEBHOOK_TOKEN:', process.env.BITRIX_WEBHOOK_TOKEN ? '✅ SET' : '❌ NOT SET');
console.log('PORT:', process.env.PORT);
console.log('NODE_ENV:', process.env.NODE_ENV);

// Проверим что файл .env существует
const fs = require('fs');
const envPath = path.join(__dirname, 'config/.env');
console.log('.env file exists:', fs.existsSync(envPath) ? '✅ YES' : '❌ NO');

if (fs.existsSync(envPath)) {
    console.log('File content:');
    console.log(fs.readFileSync(envPath, 'utf8'));
}
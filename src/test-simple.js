// src/test-simple.js
const path = require('path');

// Загружаем .env из корневой папки проекта
require('dotenv').config({ path: path.join(__dirname, '../config/.env') });

console.log('🔧 Environment check:');
console.log('BITRIX_DOMAIN:', process.env.BITRIX_DOMAIN || '❌ NOT SET');
console.log('BITRIX_WEBHOOK_TOKEN:', process.env.BITRIX_WEBHOOK_TOKEN ? '✅ SET' : '❌ NOT SET');
console.log('PORT:', process.env.PORT);
console.log('NODE_ENV:', process.env.NODE_ENV);

// Проверка наличия файлов (относительно src папки)
const fs = require('fs');

const files = [
    './services/bitrixService.js',
    './controllers/botController.js', 
    './models/database.js',
    './db/sqlite.js'
];

console.log('\n📁 File check:');
files.forEach(file => {
    const fullPath = path.join(__dirname, file);
    console.log(`${file}: ${fs.existsSync(fullPath) ? '✅ EXISTS' : '❌ MISSING'}`);
});

// Проверка папок
console.log('\n📁 Folder check:');
const folders = ['./controllers', './services', './models', './db', './routes'];
folders.forEach(folder => {
    const fullPath = path.join(__dirname, folder);
    console.log(`${folder}: ${fs.existsSync(fullPath) ? '✅ EXISTS' : '❌ MISSING'}`);
});

// Покажем полный путь к .env для отладки
console.log('\n🔍 Debug info:');
console.log('Current dir:', __dirname);
console.log('Project root:', path.join(__dirname, '..'));
console.log('Looking for .env at:', path.join(__dirname, '../.env'));
console.log('.env exists:', fs.existsSync(path.join(__dirname, '../.env')));
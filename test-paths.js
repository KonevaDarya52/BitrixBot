const fs = require('fs');
const path = require('path');

console.log('📁 Checking file paths...');

const filesToCheck = [
    './src/db/sqlite.js',
    './src/models/database.js', 
    './src/routes/api.js',
    './src/routes/bot.js',
    './src/routes/webhook.js',
    './config/.env'
];

filesToCheck.forEach(file => {
    const exists = fs.existsSync(path.join(__dirname, file));
    console.log(`${file}: ${exists ? '✅ EXISTS' : '❌ MISSING'}`);
});

console.log('\n🔍 Database path check:');
const dbPath = path.join(__dirname, './src/db/sqlite.js');
console.log('DB file exists:', fs.existsSync(dbPath));
console.log('DB path:', dbPath);
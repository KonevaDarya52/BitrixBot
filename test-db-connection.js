const path = require('path');
require('dotenv').config({ path: path.join(__dirname, './config/.env') });

console.log('🧪 Testing database connection...');

try {
    const db = require('./src/db/sqlite');
    console.log('✅ SQLite connection successful');
    
    // Простой тест запроса с callback (оригинальный метод)
    db.get("SELECT name FROM sqlite_master WHERE type='table'", (err, row) => {
        if (err) {
            console.log('❌ Database query error:', err.message);
        } else {
            console.log('✅ Database query successful');
            console.log('Tables:', row);
        }
    });
} catch (error) {
    console.log('❌ Database connection failed:', error.message);
}
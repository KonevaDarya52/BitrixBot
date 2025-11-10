const db = require('../db/sqlite');
const fs = require('fs');
const path = require('path');

async function runMigrations() {
    try {
        // Читаем файл миграции
        const migrationPath = path.join(__dirname, '001_init.sql');
        const sql = fs.readFileSync(migrationPath, 'utf8');
        
        // Выполняем миграцию
        await db.exec(sql);
        console.log('✅ Database migrations completed');
    } catch (error) {
        console.error('❌ Migration failed:', error);
    }
}

runMigrations();
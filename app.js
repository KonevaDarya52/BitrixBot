require('dotenv').config();
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

// Простые роуты для проверки (добавляем ДО инициализации)
app.get('/', (req, res) => {
    res.json({
        status: 'Bitrix Bot is running',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

async function initializeApp() {
    try {
        console.log('🚀 Starting Bitrix Bot initialization...');
        
        // Динамически импортируем модули
        const database = require('./src/models/database');
        const cronJobs = require('./src/jobs/cronJobs');
        const bitrixService = require('./src/services/bitrixService');
        
        // Инициализируем БД
        console.log('📦 Initializing database...');
        await database.initDB();
        console.log('✅ Database initialized successfully');
        
        // Регистрируем бота (пропускаем ошибки)
try {
  await bitrixService.createBotAutomatically();
  console.log('✅ Bot created successfully');
} catch (botError) {
  console.log('⚠️ Bot creation skipped:', botError.message);
}
        
        // Инициализируем cron jobs
        console.log('⏰ Initializing cron jobs...');
        cronJobs.initCronJobs();
        console.log('✅ Cron jobs initialized');
        
        // Подключаем остальные роуты
        console.log('🔗 Setting up routes...');
        const apiRouter = require('./src/routes/api');
        const webhookRouter = require('./src/routes/webhook');
        const authRouter = require('./src/routes/auth');
        const checkinRouter = require('./src/routes/checkin');
        
        app.use('/api', apiRouter);
        app.use('/webhook', webhookRouter);
        app.use('/auth', authRouter);
        app.use('/checkin', checkinRouter);
        
        console.log('✅ All routes configured');
        
        // Запускаем сервер
        app.listen(port, '0.0.0.0', () => {
            console.log(`🎉 Bitrix Bot successfully started on port ${port}`);
            console.log(`📍 Bitrix domain: ${process.env.BITRIX_DOMAIN || 'Not set'}`);
            console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
        });
        
    } catch (error) {
        console.error('❌ Failed to initialize app:', error);
        console.error('Stack:', error.stack);
        process.exit(1);
    }
}

// Запускаем инициализацию
initializeApp();

// Обработка непредвиденных ошибок
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    process.exit(1);
});
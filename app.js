const path = require('path');
// Загружаем .env из папки config
require('dotenv').config({ path: path.join(__dirname, './config/.env') });

const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

// Роуты из папки src (правильные пути)
const apiRouter = require('./src/routes/api');
const botRouter = require('./src/routes/bot');
const webhookRouter = require('./src/routes/webhook');
const authRouter = require('./src/routes/auth');
const checkinRouter = require('./src/routes/checkin');

app.use('/api', apiRouter);
app.use('/bot', botRouter);
app.use('/webhook', webhookRouter);
app.use('/auth', authRouter);
app.use('/checkin', checkinRouter);

// Инициализация БД и cron jobs
const database = require('./src/models/database');
const cronJobs = require('./src/jobs/cronJobs');

async function initializeApp() {
    try {
        await database.initDB();
        console.log('✅ Database initialized');
        
        cronJobs.initCronJobs();
        
        app.listen(port, () => {
            console.log(`🚀 Bot server running on port ${port}`);
            console.log(`📊 API: http://localhost:${port}/api/status`);
            console.log(`🤖 Bot: http://localhost:${port}/bot/message`);
            console.log(`🪝 Webhook: http://localhost:${port}/webhook/message`);
            console.log(`📍 Bitrix domain: ${process.env.BITRIX_DOMAIN}`);
        });
    } catch (error) {
        console.error('❌ Failed to initialize app:', error);
    }
}

initializeApp();
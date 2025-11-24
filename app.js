require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

// Импортируем базу данных и инициализируем
const database = require('./src/models/database');
const cronJobs = require('./src/jobs/cronJobs');

// Основные роуты
app.use('/imbot', require('./src/controllers/botHandler'));
app.use('/install', require('./src/controllers/installHandler'));

// Простые роуты
app.get('/', (req, res) => {
    res.json({ 
        status: 'Bitrix Bot is running', 
        version: '1.0.0',
        endpoints: {
            install: '/install',
            webhook: '/imbot'
        }
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// Инициализация
async function initializeApp() {
    try {
        await database.initDB();
        console.log('✅ Database initialized');
        
        cronJobs.initCronJobs();
        console.log('✅ Cron jobs initialized');
        
        app.listen(port, '0.0.0.0', () => {
            console.log(`🚀 Bot server running on port ${port}`);
        });
    } catch (error) {
        console.error('❌ Initialization failed:', error);
    }
}

initializeApp();
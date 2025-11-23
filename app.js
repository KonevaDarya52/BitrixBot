require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');


app.use(bodyParser.json());


// Для Railway переменные уже установлены
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config({ path: path.join(__dirname, 'config/.env') });
}

const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

// Роуты из папки src
const apiRouter = require('./src/routes/api');
const botRouter = require('./src/routes/bot');
const webhookRouter = require('./src/routes/webhook');
const authRouter = require('./src/routes/auth');
const checkinRouter = require('./src/routes/checkin');
app.use('/admin', adminRouter);
app.use('/api', apiRouter);
app.use('/bot', botRouter);
app.use('/webhook', webhookRouter);
app.use('/auth', authRouter);
app.use('/checkin', checkinRouter);

// Инициализация БД и cron jobs
const database = require('./src/models/database');
const cronJobs = require('./src/jobs/cronJobs');

// Простой маршрут для проверки
app.get('/', (req, res) => {
  res.json({
    status: 'Bitrix Bot is running',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

async function initializeApp() {
    try {
        // Импортируем здесь, чтобы избежать циклических зависимостей
        const database = require('./src/models/database');
        const cronJobs = require('./src/jobs/cronJobs');
        const bitrixService = require('./src/services/bitrixService');
        
        // Инициализируем БД
        await database.initDB();
        console.log('✅ Database initialized');
        
        // Регистрируем бота (пропустим ошибку если бот уже существует)
        try {
            await bitrixService.registerBot();
            console.log('✅ Bot registered in Bitrix24');
        } catch (botError) {
            console.log('⚠️ Bot registration skipped:', botError.message);
        }
        
        // Инициализируем cron jobs
        cronJobs.initCronJobs();
        console.log('✅ Cron jobs initialized');
        
        // Подключаем роуты ПОСЛЕ инициализации
        const apiRouter = require('./src/routes/api');
        const botRouter = require('./src/routes/bot');
        const webhookRouter = require('./src/routes/webhook');
        const authRouter = require('./src/routes/auth');
        const checkinRouter = require('./src/routes/checkin');
        const adminRouter = require('./src/routes/admin');
        
        app.use('/api', apiRouter);
        app.use('/bot', botRouter);
        app.use('/webhook', webhookRouter);
        app.use('/auth', authRouter);
        app.use('/checkin', checkinRouter);
        app.use('/admin', adminRouter);
        
        // Простой маршрут для проверки
        app.get('/', (req, res) => {
            res.json({
                status: 'Bitrix Bot is running',
                timestamp: new Date().toISOString(),
                version: '1.0.0'
            });
        });
        
        // Запускаем сервер
        app.listen(port, '0.0.0.0', () => {
            console.log(`🚀 Bot server running on port ${port}`);
            console.log(`📍 Bitrix domain: ${process.env.BITRIX_DOMAIN || 'Not set'}`);
        });
        
    } catch (error) {
        console.error('❌ Failed to initialize app:', error);
        process.exit(1);
    }
}

initializeApp();
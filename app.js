require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 10000;

const APP_DOMAIN = 'bitrixbot-bnnd.onrender.com';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Улучшенное логирование
app.use((req, res, next) => {
    console.log('=== 🚨 NEW REQUEST ===');
    console.log(`📍 ${new Date().toISOString()} ${req.method} ${req.url}`);
    console.log('📦 Query:', JSON.stringify(req.query, null, 2));
    console.log('📦 Headers:', JSON.stringify(req.headers, null, 2));
    console.log('📦 Body:', JSON.stringify(req.body, null, 2));
    next();
});

// ТЕСТ 1: Главная страница - проверка базовой работы
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Diagnostic Tool</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 30px; }
                .test { background: #f8f9fa; padding: 20px; margin: 10px 0; border-radius: 5px; }
                .button { background: #007bff; color: white; padding: 10px 15px; text-decoration: none; border-radius: 3px; margin: 5px; display: inline-block; }
            </style>
        </head>
        <body>
            <h1>🔧 Diagnostic Tests</h1>
            
            <div class="test">
                <h3>Тест 1: Базовая работа сервера</h3>
                <p>Если вы видите эту страницу - сервер работает ✅</p>
                <a href="/test-oauth" class="button">Тест OAuth</a>
                <a href="/test-bot" class="button">Тест Bot API</a>
                <a href="/env-check" class="button">Проверка переменных</a>
            </div>

            <div class="test">
                <h3>Тест 2: OAuth установка</h3>
                <a href="/install-simple" class="button">Простая установка</a>
                <a href="/install-debug" class="button">Установка с дебагом</a>
            </div>

            <div class="test">
                <h3>Тест 3: Вебхуки</h3>
                <a href="/webhook-test" class="button">Тест вебхука</a>
            </div>
        </body>
        </html>
    `);
});

// ТЕСТ 2: Проверка переменных окружения
app.get('/env-check', (req, res) => {
    const envCheck = {
        BITRIX_DOMAIN: process.env.BITRIX_DOMAIN,
        BITRIX_CLIENT_ID: process.env.BITRIX_CLIENT_ID,
        BITRIX_CLIENT_SECRET: process.env.BITRIX_CLIENT_SECRET ? '✅ SET' : '❌ MISSING',
        PORT: process.env.PORT,
        APP_DOMAIN: APP_DOMAIN,
        status: 'running'
    };

    console.log('🔍 Environment Check:', envCheck);
    
    res.json(envCheck);
});

// ТЕСТ 3: Простой OAuth редирект (без обработки callback)
app.get('/install-simple', (req, res) => {
    console.log('🔐 Simple OAuth redirect test');
    
    const redirectUri = `https://${APP_DOMAIN}/install-callback`;
    const authUrl = `https://${process.env.BITRIX_DOMAIN}/oauth/authorize/?client_id=${process.env.BITRIX_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}`;
    
    console.log('🔗 Redirect to:', authUrl);
    
    res.send(`
        <div style="padding: 20px;">
            <h2>🔐 Тест OAuth редиректа</h2>
            <p><strong>Redirect URI:</strong> ${redirectUri}</p>
            <p><a href="${authUrl}" style="background: #007bff; color: white; padding: 10px 15px; text-decoration: none; border-radius: 3px;">Начать OAuth</a></p>
            <p><small>После авторизации Bitrix24 перенаправит на /install-callback</small></p>
        </div>
    `);
});

// ТЕСТ 4: Callback endpoint для теста
app.get('/install-callback', (req, res) => {
    console.log('🔄 OAuth Callback Received (TEST)');
    console.log('📦 Full query:', req.query);
    
    res.send(`
        <div style="padding: 20px;">
            <h2>✅ OAuth Callback получен!</h2>
            <h3>Параметры:</h3>
            <pre>${JSON.stringify(req.query, null, 2)}</pre>
            <p><strong>Важно:</strong> Посмотрите в консоли Render.com куда именно Bitrix24 делает редирект</p>
        </div>
    `);
});

// ТЕСТ 5: Расширенная установка с дебагом
app.get('/install-debug', async (req, res) => {
    const { code, domain, auth } = req.query;
    
    console.log('=== 🧪 DEBUG INSTALLATION ===');
    console.log('🔑 Code:', code);
    console.log('🏢 Domain:', domain);
    console.log('🔐 Auth:', auth);
    console.log('📦 All params:', req.query);

    // Если нет кода - начинаем OAuth
    if (!code) {
        const redirectUri = `https://${APP_DOMAIN}/install-debug`;
        const authUrl = `https://${process.env.BITRIX_DOMAIN}/oauth/authorize/?client_id=${process.env.BITRIX_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}`;
        
        console.log('🔗 Starting OAuth flow to:', authUrl);
        
        return res.redirect(authUrl);
    }

    // Если есть код - показываем информацию
    res.send(`
        <div style="padding: 20px;">
            <h2>🧪 Debug Information</h2>
            
            <div style="background: #e9ecef; padding: 15px; border-radius: 5px; margin: 10px 0;">
                <h3>OAuth Parameters:</h3>
                <pre>${JSON.stringify(req.query, null, 2)}</pre>
            </div>

            <div style="background: #d4edda; padding: 15px; border-radius: 5px; margin: 10px 0;">
                <h3>✅ Success!</h3>
                <p>OAuth callback получен на endpoint: <strong>/install-debug</strong></p>
                <p>Код авторизации: ${code ? '✅ Получен' : '❌ Отсутствует'}</p>
                <p>Домен: ${domain || 'Не указан'}</p>
            </div>

            <div style="background: #fff3cd; padding: 15px; border-radius: 5px; margin: 10px 0;">
                <h3>🔍 Next Steps:</h3>
                <p>1. Проверьте логи в Render.com - увидите полные параметры</p>
                <p>2. Посмотрите на какой endpoint Bitrix24 сделал редирект</p>
                <p>3. Сравните с настройками в Bitrix24 Marketplace</p>
            </div>

            <a href="/" style="background: #6c757d; color: white; padding: 10px 15px; text-decoration: none; border-radius: 3px;">На главную</a>
        </div>
    `);
});

// ТЕСТ 6: Эмуляция вебхука от Bitrix24
app.get('/webhook-test', (req, res) => {
    res.send(`
        <div style="padding: 20px;">
            <h2>🤖 Тест вебхука</h2>
            <p>Endpoint: <strong>POST https://${APP_DOMAIN}/imbot</strong></p>
            
            <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 10px 0;">
                <h4>Пример данных вебхука:</h4>
                <pre>
{
  "event": "ONIMBOTMESSAGEADD",
  "data": {
    "PARAMS": {
      "MESSAGE": "test",
      "DIALOG_ID": "chat123", 
      "BOT_ID": "bot123",
      "FROM_USER_ID": "user123"
    }
  },
  "auth": {
    "domain": "${process.env.BITRIX_DOMAIN}",
    "access_token": "test_token"
  }
}
                </pre>
            </div>
            
            <p>Используйте Postman или curl для тестирования POST запросов</p>
        </div>
    `);
});

// ТЕСТ 7: Универсальный обработчик OAuth (ловим все)
app.get('*', (req, res) => {
    const { code, domain, auth } = req.query;
    
    // Если есть OAuth параметры - логируем куда пришел запрос
    if (code || auth) {
        console.log('=== 🎯 OAUTH DETECTED ON UNEXPECTED ENDPOINT ===');
        console.log('🔗 Path:', req.path);
        console.log('🔑 Code:', code);
        console.log('🏢 Domain:', domain);
        console.log('🔐 Auth:', auth);
        console.log('📦 Full URL:', req.originalUrl);
        
        res.send(`
            <div style="padding: 20px;">
                <h2>🎯 OAuth Callback Detected</h2>
                <p><strong>Endpoint:</strong> ${req.path}</p>
                <p><strong>Parameters:</strong></p>
                <pre>${JSON.stringify(req.query, null, 2)}</pre>
                
                <div style="background: #f8d7da; padding: 15px; border-radius: 5px; margin: 10px 0;">
                    <h3>⚠️ Внимание!</h3>
                    <p>Bitrix24 перенаправляет OAuth на: <strong>${req.path}</strong></p>
                    <p>Это значит что в настройках приложения указан неправильный URL установки!</p>
                </div>
            </div>
        `);
        return;
    }
    
    // Обычный 404
    res.status(404).json({
        error: 'Endpoint not found',
        path: req.path,
        available_endpoints: [
            '/', '/env-check', '/install-simple', '/install-debug', '/webhook-test'
        ]
    });
});

// Обработчик вебхуков
app.post('/imbot', (req, res) => {
    console.log('🤖 Webhook received at /imbot');
    console.log('📦 Body:', JSON.stringify(req.body, null, 2));
    
    res.json({ result: 'ok', received: true });
});

app.listen(port, '0.0.0.0', () => {
    console.log('🚀 Diagnostic server started');
    console.log('📍 Domain:', APP_DOMAIN);
    console.log('🔧 Port:', port);
    console.log('=== 🧪 READY FOR TESTING ===');
});
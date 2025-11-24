require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

// Основные роуты для бота
app.post('/imbot/', require('./src/controllers/botHandler').handleBot);
app.get('/install/', require('./src/controllers/installHandler').handleInstall);

app.get('/', (req, res) => {
    res.json({ status: 'Bot is running', version: '1.0.0' });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Bot server running on port ${port}`);
});
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

// роуты
const authRouter = require('./routes/auth');
const checkinRouter = require('./routes/checkin');

app.use('/auth', authRouter);
app.use('/checkin', checkinRouter);

// простая проверка
app.get('/', (req, res) => res.send('BitrixBot running'));

app.listen(port, () => console.log(`Server running on ${port}`));
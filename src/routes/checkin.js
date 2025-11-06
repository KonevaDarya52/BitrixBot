const express = require('express');
const router = express.Router();
const controller = require('../controllers/checkinController');

router.post('/', controller);

module.exports = router;
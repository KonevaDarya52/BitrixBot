const express = require('express');
const router = express.Router();
const checkinController = require('../controllers/checkinController');

router.post('/', checkinController);

module.exports = router;
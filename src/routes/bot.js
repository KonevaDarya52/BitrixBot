const express = require('express');
const router = express.Router();
const botController = require('../controllers/botController');

router.post('/message', async (req, res) => {
  try {
    const { userId, dialogId, message } = req.body;
    await botController.handleMessage({
      FROM_USER_ID: userId,
      DIALOG_ID: dialogId,
      MESSAGE: message
    });
    res.json({ status: 'Message sent' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
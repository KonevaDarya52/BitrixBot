const axios = require('axios');

async function handleCheckin(req, res) {
  try {
    const { userId, token } = req.body;

    if (!userId || !token) {
      return res.status(400).json({ message: 'Отсутствует userId или token' });
    }

    // Здесь будет логика отметки сотрудника
    console.log(`Сотрудник ${userId} отметился`);

    return res.status(200).json({ message: 'Отметка успешно выполнена' });
  } catch (error) {
    console.error('Ошибка при обработке отметки:', error);
    return res.status(500).json({ message: 'Ошибка сервера' });
  }
}

module.exports = handleCheckin;
import axios from 'axios';
import dotenv from 'dotenv';
import { getAccessToken } from './auth.js';

dotenv.config();

const { BITRIX_DOMAIN } = process.env;

export async function handleCheckin(req, res) {
  try {
    const { userId, token } = req.body;

    if (!userId || !token) {
      return res.status(400).json({ message: 'Отсутствует userId или token' });
    }

    // проверка авторизации (например, через Bitrix)
    const response = await axios.post(`https://${BITRIX_DOMAIN}/rest/user.current.json`, { auth: token });

    if (response.data.error) {
      return res.status(401).json({ message: 'Неверный токен Bitrix' });
    }

    // Здесь будет логика отметки сотрудника
    console.log(`Сотрудник ${userId} отметился`);

    return res.status(200).json({ message: 'Отметка успешно выполнена' });
  } catch (error) {
    console.error('Ошибка при обработке отметки:', error);
    return res.status(500).json({ message: 'Ошибка сервера' });
  }
}
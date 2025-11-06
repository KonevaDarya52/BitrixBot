import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const { BITRIX_CLIENT_ID, BITRIX_SECRET, BITRIX_DOMAIN } = process.env;

export async function getAccessToken(code) {
  try {
    const response = await axios.post(`https://${BITRIX_DOMAIN}/oauth/token/`, {
      grant_type: 'authorization_code',
      client_id: BITRIX_CLIENT_ID,
      client_secret: BITRIX_SECRET,
      code,
    });
    return response.data;
  } catch (error) {
    console.error('Ошибка при получении токена:', error);
    throw error;
  }
}

export async function refreshAccessToken(refreshToken) {
  try {
    const response = await axios.post(`https://${BITRIX_DOMAIN}/oauth/token/`, {
      grant_type: 'refresh_token',
      client_id: BITRIX_CLIENT_ID,
      client_secret: BITRIX_SECRET,
      refresh_token: refreshToken,
    });
    return response.data;
  } catch (error) {
    console.error('Ошибка при обновлении токена:', error);
    throw error;
  }
}
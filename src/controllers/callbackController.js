const axios = require('axios');
const db = require('../db/sqlite');

module.exports = async function(req, res) {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code');

  try {
    // обменять code на access_token
    const tokenResp = await axios.post(`https://oauth.bitrix.info/oauth/token/`, null, {
      params: {
        grant_type: 'authorization_code',
        client_id: process.env.BX_CLIENT_ID,
        client_secret: process.env.BX_CLIENT_SECRET,
        code,
        redirect_uri: process.env.BX_REDIRECT_URI
      }
    });

    const { access_token, refresh_token, expires_in } = tokenResp.data;
    // Получить user info через Bitrix метод user.current
    const me = await axios.get(`https://your-bitrix-domain/rest/user.current.json?auth=${access_token}`)
      .catch(e => null);

    // Для MVP покажем токен (в проде лучше сохранить в БД)
    res.send(`
      <h3>Auth OK</h3>
      <pre>${JSON.stringify(tokenResp.data, null, 2)}</pre>
      <p>Теперь используй access_token для тестирования /checkin (см. README)</p>
    `);
  } catch (err) {
    console.error(err.response ? err.response.data : err);
    res.status(500).send('Auth failed');
  }
};const axios = require('axios');
const db = require('../db/sqlite');

module.exports = async function(req, res) {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code');

  try {
    // обменять code на access_token
    const tokenResp = await axios.post(`https://oauth.bitrix.info/oauth/token/`, null, {
      params: {
        grant_type: 'authorization_code',
        client_id: process.env.BX_CLIENT_ID,
        client_secret: process.env.BX_CLIENT_SECRET,
        code,
        redirect_uri: process.env.BX_REDIRECT_URI
      }
    });

    const { access_token, refresh_token, expires_in } = tokenResp.data;
    // Получить user info через Bitrix метод user.current
    const me = await axios.get(`https://your-bitrix-domain/rest/user.current.json?auth=${access_token}`)
      .catch(e => null);

    // Для MVP покажем токен (в проде лучше сохранить в БД)
    res.send(`
      <h3>Auth OK</h3>
      <pre>${JSON.stringify(tokenResp.data, null, 2)}</pre>
      <p>Теперь используй access_token для тестирования /checkin (см. README)</p>
    `);
  } catch (err) {
    console.error(err.response ? err.response.data : err);
    res.status(500).send('Auth failed');
  }
};
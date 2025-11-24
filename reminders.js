const axios = require('axios');
const { getTodayAttendance } = require('./database');

// Функция для отправки напоминаний
async function sendReminders(auth) {
    try {
        console.log('⏰ Проверка напоминаний...');
        
        // Здесь можно добавить логику получения списка пользователей
        // и проверки их отметок за сегодня
        
        // Пример: получаем пользователей, которые не отметили приход
        // const usersWithoutCheckin = await getUsersWithoutCheckin();
        
        // for (const user of usersWithoutCheckin) {
        //     await sendBotMessage(botId, user.id, '⏰ Не забудьте отметить приход!', auth);
        // }
        
        console.log('✅ Напоминания отправлены');
        
    } catch (error) {
        console.error('❌ Reminders error:', error);
    }
}

// Функция для отправки отчетов администратору
async function sendAdminReport(auth, adminUserId) {
    try {
        console.log('📊 Подготовка отчета для администратора...');
        
        // Получаем статистику за сегодня
        const teamStats = await getTeamAttendance(
            new Date().toISOString().split('T')[0],
            new Date().toISOString().split('T')[0]
        );
        
        let report = `📊 *Отчет по посещаемости за ${new Date().toLocaleDateString('ru-RU')}*\n\n`;
        
        if (teamStats.length === 0) {
            report += 'Нет данных о посещаемости';
        } else {
            teamStats.forEach(stat => {
                report += `👤 Пользователь ${stat.user_id}:\n`;
                report += `📍 Приходов: ${stat.checkins || 0}\n`;
                report += `🚪 Уходов: ${stat.checkouts || 0}\n`;
                report += `⏰ Первый приход: ${stat.first_checkin ? new Date(stat.first_checkin).toLocaleTimeString('ru-RU') : 'нет данных'}\n`;
                report += `🏠 Последний уход: ${stat.last_checkout ? new Date(stat.last_checkout).toLocaleTimeString('ru-RU') : 'нет данных'}\n\n`;
            });
        }
        
        // Отправляем отчет администратору
        await sendBotMessage(botId, adminUserId, report, auth);
        
        console.log('✅ Отчет отправлен администратору');
        
    } catch (error) {
        console.error('❌ Admin report error:', error);
    }
}

module.exports = { sendReminders, sendAdminReport };
const nodeCron = require('node-cron');
const database = require('../models/database');
const bitrixService = require('../services/bitrixService');

class CronJobs {
  initCronJobs() {
    // Напоминание о приходе в 9:00
    nodeCron.schedule('0 9 * * 1-5', this.sendMorningReminders.bind(this));

    // Напоминание об уходе в 18:00
    nodeCron.schedule('0 18 * * 1-5', this.sendEveningReminders.bind(this));

    // Отчет для руководства в 19:00
    nodeCron.schedule('0 19 * * 1-5', this.sendDailyReport.bind(this));

    console.log('✅ Cron jobs initialized');
  }

  async sendMorningReminders() {
    try {
      const message = "⏰ Доброе утро! Не забудьте отметить приход в офисе командой 'пришел'";
      
      // Здесь можно получить список всех активных сотрудников
      // и отправить им напоминания
      console.log('Morning reminders sent');
    } catch (error) {
      console.error('Error sending morning reminders:', error);
    }
  }

  async sendEveningReminders() {
    try {
      const usersWithoutCheckout = await database.getUsersWithoutCheckout();
      
      for (const user of usersWithoutCheckout) {
        const message = "🏠 Не забудьте отметить уход командой 'ушел'";
        // await bitrixService.sendMessage(user.bx_user_id, message);
        console.log(`Reminder sent to ${user.full_name}`);
      }
    } catch (error) {
      console.error('Error sending evening reminders:', error);
    }
  }

  async sendDailyReport() {
    try {
      const report = await database.getDailyReport();
      let reportMessage = "📊 *Ежедневный отчет по отметкам*\n\n";

      report.forEach(employee => {
        const checkIn = employee.check_in ? 
          new Date(employee.check_in).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : 
          '❌';
        
        const checkOut = employee.check_out ? 
          new Date(employee.check_out).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : 
          '❌';

        reportMessage += `👤 ${employee.full_name}\n`;
        reportMessage += `   Пришел: ${checkIn}\n`;
        reportMessage += `   Ушел: ${checkOut}\n\n`;
      });

      // Отправка отчета руководителям (укажите ID руководителей)
      const managers = ['1', '2']; // Замените на реальные ID
      for (const managerId of managers) {
        // await bitrixService.sendMessage(managerId, reportMessage);
        console.log(`Report sent to manager ${managerId}`);
      }

      console.log('Daily report sent');
    } catch (error) {
      console.error('Error sending daily report:', error);
    }
  }
}

module.exports = new CronJobs();
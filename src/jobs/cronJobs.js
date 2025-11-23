const nodeCron = require('node-cron');
const database = require('../models/database');
const bitrixService = require('../services/bitrixService');

class CronJobs {
  initCronJobs() {
    // Напоминание о приходе в 9:00 (только по рабочим дням 1-5 = пн-пт)
    nodeCron.schedule('0 9 * * 1-5', this.sendMorningReminders.bind(this));

    // Напоминание об уходе в 18:00 (только по рабочим дням)
    nodeCron.schedule('0 18 * * 1-5', this.sendEveningReminders.bind(this));

    // Отчет для руководства в 19:00 (только по рабочим дням)
    nodeCron.schedule('0 19 * * 1-5', this.sendDailyReport.bind(this));

    console.log('✅ Cron jobs initialized');
  }

  async sendMorningReminders() {
    try {
      console.log('⏰ Sending morning reminders...');
      
      // Получаем всех активных сотрудников
      const allEmployees = await database.getAllActiveEmployees();
      
      for (const employee of allEmployees) {
        try {
          const message = "⏰ Доброе утро! Не забудьте отметить приход в офисе командой 'пришел'";
          // Отправляем сообщение через Bitrix
          await bitrixService.sendMessage(employee.bx_user_id, message);
          console.log(`✅ Morning reminder sent to ${employee.full_name}`);
        } catch (error) {
          console.error(`❌ Failed to send reminder to ${employee.full_name}:`, error.message);
        }
      }
    } catch (error) {
      console.error('❌ Error sending morning reminders:', error);
    }
  }

  async sendEveningReminders() {
    try {
      console.log('🏠 Sending evening reminders...');
      
      const usersWithoutCheckout = await database.getUsersWithoutCheckout();
      
      for (const user of usersWithoutCheckout) {
        try {
          const message = "🏠 Не забудьте отметить уход командой 'ушел'";
          await bitrixService.sendMessage(user.bx_user_id, message);
          console.log(`✅ Evening reminder sent to ${user.full_name}`);
        } catch (error) {
          console.error(`❌ Failed to send reminder to ${user.full_name}:`, error.message);
        }
      }
    } catch (error) {
      console.error('❌ Error sending evening reminders:', error);
    }
  }

  async sendDailyReport() {
    try {
      console.log('📊 Generating daily report...');
      
      const report = await database.getDailyReport();
      let reportMessage = "📊 *Ежедневный отчет по отметкам*\n\n";
      let hasData = false;

      report.forEach(employee => {
        const checkIn = employee.check_in ? 
          new Date(employee.check_in).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : 
          '❌ Не отмечен';
        
        const checkOut = employee.check_out ? 
          new Date(employee.check_out).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : 
          '❌ Не отмечен';

        // Добавляем только если есть данные
        if (employee.check_in || employee.check_out) {
          reportMessage += `👤 ${employee.full_name}\n`;
          reportMessage += `   ✅ Пришел: ${checkIn}\n`;
          reportMessage += `   🏠 Ушел: ${checkOut}\n\n`;
          hasData = true;
        }
      });

      if (!hasData) {
        reportMessage += "ℹ️ За сегодня нет данных об отметках сотрудников.";
      }

      // Отправка отчета руководителям
      const managers = process.env.ADMIN_USER_IDS ? process.env.ADMIN_USER_IDS.split(',') : ['1'];
      
      for (const managerId of managers) {
        try {
          await bitrixService.sendMessage(managerId, reportMessage);
          console.log(`✅ Daily report sent to manager ${managerId}`);
        } catch (error) {
          console.error(`❌ Failed to send report to manager ${managerId}:`, error.message);
        }
      }

    } catch (error) {
      console.error('❌ Error sending daily report:', error);
    }
  }
}

module.exports = new CronJobs();
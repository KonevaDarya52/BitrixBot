const express = require('express');
const router = express.Router();
const database = require('../models/database');

// Статистика по сотрудникам
router.get('/stats', async (req, res) => {
    try {
        const report = await database.getDailyReport();
        res.json({
            totalEmployees: report.length,
            employeesWithCheckIn: report.filter(e => e.check_in).length,
            employeesWithCheckOut: report.filter(e => e.check_out).length,
            report: report
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Сброс тестовых данных
router.delete('/reset-test', async (req, res) => {
    try {
        // Удаляем тестовые данные
        // Добавьте свою логику очистки
        res.json({ message: 'Test data reset' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
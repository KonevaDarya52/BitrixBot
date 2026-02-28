const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'attendance.db');
const db = new sqlite3.Database(dbPath);

// Инициализация БД
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        latitude REAL,
        longitude REAL,
        in_office BOOLEAN
    )`);
    
    db.run(`CREATE INDEX IF NOT EXISTS idx_user_date ON attendance(user_id, date(timestamp))`);
});

// Функция для отметки прихода/ухода
function markAttendance(userId, type, lat, lon, inOffice) {
    return new Promise((resolve, reject) => {
        db.run(`INSERT INTO attendance (user_id, type, latitude, longitude, in_office) 
                VALUES (?, ?, ?, ?, ?)`,
            [userId, type, lat, lon, inOffice],
            function(err) {
                if (err) {
                    console.error('❌ Database error:', err);
                    reject(err);
                } else {
                    console.log(`✅ Отметка сохранена: пользователь ${userId}, тип ${type}, в офисе: ${inOffice}`);
                    resolve(this.lastID);
                }
            });
    });
}

// Получить сегодняшние отметки пользователя
function getTodayAttendance(userId) {
    return new Promise((resolve, reject) => {
        db.all(`SELECT type, timestamp, in_office 
                FROM attendance 
                WHERE user_id = ? AND date(timestamp) = date('now') 
                ORDER BY timestamp`,
            [userId],
            (err, rows) => {
                if (err) {
                    console.error('❌ Database error:', err);
                    reject(err);
                } else {
                    console.log(`✅ Получены отметки пользователя ${userId}:`, rows.length, 'записей');
                    resolve(rows);
                }
            });
    });
}

// Получить все отметки пользователя (для отчетов)
function getUserAttendance(userId, startDate, endDate) {
    return new Promise((resolve, reject) => {
        db.all(`SELECT type, timestamp, in_office, latitude, longitude
                FROM attendance 
                WHERE user_id = ? AND date(timestamp) BETWEEN ? AND ?
                ORDER BY timestamp`,
            [userId, startDate, endDate],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
    });
}

// Получить статистику по всем пользователям за период
function getTeamAttendance(startDate, endDate) {
    return new Promise((resolve, reject) => {
        db.all(`SELECT user_id, 
                       COUNT(CASE WHEN type = 'in' THEN 1 END) as checkins,
                       COUNT(CASE WHEN type = 'out' THEN 1 END) as checkouts,
                       MIN(CASE WHEN type = 'in' THEN timestamp END) as first_checkin,
                       MAX(CASE WHEN type = 'out' THEN timestamp END) as last_checkout
                FROM attendance 
                WHERE date(timestamp) BETWEEN ? AND ?
                GROUP BY user_id`,
            [startDate, endDate],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
    });
}

module.exports = { 
    markAttendance, 
    getTodayAttendance, 
    getUserAttendance,
    getTeamAttendance 
};
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Путь к базе данных в папке data
const dbPath = path.join(__dirname, '../data/dev.sqlite');

// Создаем папку data если не существует
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Создаем соединение с БД
const db = new sqlite3.Database(dbPath);

// Сохраняем оригинальные методы
const originalRun = db.run.bind(db);
const originalGet = db.get.bind(db);
const originalAll = db.all.bind(db);
const originalExec = db.exec.bind(db);

// Добавляем промис-обертки с разными именами методов
db.runAsync = function(sql, params = []) {
    return new Promise((resolve, reject) => {
        originalRun(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
};

db.getAsync = function(sql, params = []) {
    return new Promise((resolve, reject) => {
        originalGet(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
};

db.allAsync = function(sql, params = []) {
    return new Promise((resolve, reject) => {
        originalAll(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
};

db.execAsync = function(sql) {
    return new Promise((resolve, reject) => {
        originalExec(sql, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
};

module.exports = db;
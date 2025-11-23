const db = require('../db/sqlite');

class Database {
  async initDB() {
    try {
      // Таблица сотрудников
      await db.runAsync(`
        CREATE TABLE IF NOT EXISTS employees (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          bx_user_id INTEGER UNIQUE,
          full_name TEXT,
          email TEXT,
          is_active BOOLEAN DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Таблица офисов
      await db.runAsync(`
        CREATE TABLE IF NOT EXISTS offices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT,
          lat REAL,
          lon REAL,
          radius_m INTEGER DEFAULT 100,
          is_active BOOLEAN DEFAULT 1
        )
      `);

      // Таблица отметок
      await db.runAsync(`
        CREATE TABLE IF NOT EXISTS attendance_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          bx_user_id INTEGER,
          office_id INTEGER,
          event_type TEXT,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          lat REAL,
          lon REAL,
          status TEXT DEFAULT 'pending',
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Таблица расписаний
      await db.runAsync(`
        CREATE TABLE IF NOT EXISTS work_schedules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          bx_user_id INTEGER,
          start_time TEXT,
          end_time TEXT,
          weekdays TEXT,
          is_active BOOLEAN DEFAULT 1
        )
      `);

      console.log('✅ Database initialized successfully');
    } catch (error) {
      console.error('❌ Database initialization error:', error);
    }
  }

  // Методы для работы с сотрудниками
  async addEmployee(bxUserId, fullName, email) {
    const sql = `INSERT OR REPLACE INTO employees (bx_user_id, full_name, email) VALUES (?, ?, ?)`;
    return await db.runAsync(sql, [bxUserId, fullName, email]);
  }

  async getEmployeeByBxId(bxUserId) {
    const sql = `SELECT * FROM employees WHERE bx_user_id = ?`;
    return await db.getAsync(sql, [bxUserId]);
  }

  async getAllActiveEmployees() {
  const sql = `SELECT * FROM employees WHERE is_active = 1`;
  return await db.allAsync(sql);
}

  // Методы для работы с отметками
  async addAttendanceEvent(bxUserId, eventType, lat, lon, status = 'ok') {
    const sql = `
      INSERT INTO attendance_events (bx_user_id, event_type, lat, lon, status) 
      VALUES (?, ?, ?, ?, ?)
    `;
    return await db.runAsync(sql, [bxUserId, eventType, lat, lon, status]);
  }

  async getTodayEvents(bxUserId) {
    const sql = `
      SELECT * FROM attendance_events 
      WHERE bx_user_id = ? 
      AND DATE(timestamp) = DATE('now') 
      ORDER BY timestamp
    `;
    return await db.allAsync(sql, [bxUserId]);
  }

  async getUsersWithoutCheckout() {
    const sql = `
      SELECT e.* 
      FROM employees e
      WHERE e.is_active = 1
      AND NOT EXISTS (
        SELECT 1 FROM attendance_events ae 
        WHERE ae.bx_user_id = e.bx_user_id 
        AND DATE(ae.timestamp) = DATE('now') 
        AND ae.event_type = 'out'
      )
      AND EXISTS (
        SELECT 1 FROM attendance_events ae 
        WHERE ae.bx_user_id = e.bx_user_id 
        AND DATE(ae.timestamp) = DATE('now') 
        AND ae.event_type = 'in'
      )
    `;
    return await db.allAsync(sql);
  }

  async getDailyReport() {
    const sql = `
      SELECT 
        e.full_name,
        e.bx_user_id,
        MAX(CASE WHEN ae.event_type = 'in' THEN ae.timestamp END) as check_in,
        MAX(CASE WHEN ae.event_type = 'out' THEN ae.timestamp END) as check_out
      FROM employees e
      LEFT JOIN attendance_events ae ON e.bx_user_id = ae.bx_user_id AND DATE(ae.timestamp) = DATE('now')
      WHERE e.is_active = 1
      GROUP BY e.bx_user_id, e.full_name
      ORDER BY e.full_name
    `;
    return await db.allAsync(sql);
  }
}

module.exports = new Database();
-- Таблица сотрудников
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bx_user_id INTEGER UNIQUE,
  full_name TEXT,
  email TEXT,
  is_active BOOLEAN DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Таблица офисов
CREATE TABLE IF NOT EXISTS offices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  lat REAL,
  lon REAL,
  radius_m INTEGER DEFAULT 100,
  is_active BOOLEAN DEFAULT 1
);

-- Таблица отметок
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
);

-- Таблица расписаний
CREATE TABLE IF NOT EXISTS work_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bx_user_id INTEGER,
  start_time TEXT,
  end_time TEXT,
  weekdays TEXT,
  is_active BOOLEAN DEFAULT 1
);

-- Вставляем тестовые данные офиса (Москва, Кремль)
INSERT OR IGNORE INTO offices (name, lat, lon, radius_m) 
VALUES ('Главный офис', 55.7520, 37.6175, 500);

-- Индексы для оптимизации
CREATE INDEX IF NOT EXISTS idx_attendance_events_user_date 
ON attendance_events(bx_user_id, DATE(timestamp));

CREATE INDEX IF NOT EXISTS idx_attendance_events_date 
ON attendance_events(DATE(timestamp));

CREATE INDEX IF NOT EXISTS idx_employees_active 
ON employees(is_active);
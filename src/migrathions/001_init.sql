CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bx_user_id INTEGER UNIQUE,
  full_name TEXT,
  email TEXT
);

CREATE TABLE IF NOT EXISTS offices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  lat REAL,
  lon REAL,
  radius_m INTEGER DEFAULT 50
);

CREATE TABLE IF NOT EXISTS attendance_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bx_user_id INTEGER,
  office_id INTEGER,
  event_type TEXT, -- 'in' or 'out' or 'scan'
  timestamp INTEGER, -- unix epoch seconds
  lat REAL,
  lon REAL,
  device_id TEXT,
  status TEXT, -- 'ok','out_of_zone','no_token','invalid_user','replay'
  notes TEXT
);

CREATE TABLE IF NOT EXISTS work_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bx_user_id INTEGER,
  start_time TEXT, -- e.g. "09:00"
  end_time TEXT,   -- e.g. "18:00"
  weekdays TEXT -- e.g. "1,2,3,4,5"
);
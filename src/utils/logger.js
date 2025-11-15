class Logger {
    static info(message, meta = {}) {
        console.log(`[INFO] ${new Date().toISOString()} - ${message}`, meta);
    }
    
    static error(message, error = {}) {
        console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, error);
    }
    
    static warn(message, meta = {}) {
        console.warn(`[WARN] ${new Date().toISOString()} - ${message}`, meta);
    }
}

module.exports = Logger;
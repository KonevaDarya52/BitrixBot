class LocationService {
  constructor() {
    this.officeLat = parseFloat(process.env.OFFICE_LAT);
    this.officeLon = parseFloat(process.env.OFFICE_LON);
    this.officeRadius = parseInt(process.env.OFFICE_RADIUS);
  }

  // Проверка находится ли пользователь в офисе
  isInOffice(userLat, userLon) {
    const earthRadius = 6371000; // метров
    
    const latDelta = this.deg2rad(userLat - this.officeLat);
    const lonDelta = this.deg2rad(userLon - this.officeLon);
    
    const a = Math.sin(latDelta / 2) * Math.sin(latDelta / 2) +
             Math.cos(this.deg2rad(this.officeLat)) * Math.cos(this.deg2rad(userLat)) *
             Math.sin(lonDelta / 2) * Math.sin(lonDelta / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    
    const distance = earthRadius * c;
    
    return distance <= this.officeRadius;
  }

  deg2rad(deg) {
    return deg * (Math.PI / 180);
  }

  // Получение сообщения о статусе геолокации
  getLocationStatusMessage(isInOffice, eventType) {
    if (!isInOffice) {
      return "❌ Вы находитесь вне офиса. Отметка возможна только в офисе.";
    }

    if (eventType === 'in') {
      return "✅ Отлично! Вы отметились о приходе.";
    } else {
      return "✅ Спасибо за работу! Вы отметились об уходе.";
    }
  }
}

module.exports = new LocationService();
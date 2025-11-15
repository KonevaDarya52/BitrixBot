class LocationService {
  constructor() {
    // Координаты офиса (Москва, Кремль для теста)
    this.officeLat = 55.7520;
    this.officeLon = 37.6175;
    this.officeRadius = 500; // 500 метров
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
    
    console.log(`📍 Distance from office: ${distance.toFixed(2)}m (radius: ${this.officeRadius}m)`);
    console.log(`📍 Office: ${this.officeLat}, ${this.officeLon}`);
    console.log(`📍 User: ${userLat}, ${userLon}`);
    
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
class Validators {
    static validateWebhookData(data) {
        if (!data || !data.params) {
            throw new Error('Invalid webhook data structure');
        }
        
        const { FROM_USER_ID, DIALOG_ID, MESSAGE } = data.params;
        
        if (!FROM_USER_ID || !DIALOG_ID || !MESSAGE) {
            throw new Error('Missing required webhook parameters');
        }
        
        return true;
    }
    
    static validateCoordinates(lat, lon) {
        if (lat < -90 || lat > 90) {
            throw new Error('Invalid latitude');
        }
        if (lon < -180 || lon > 180) {
            throw new Error('Invalid longitude');
        }
        return true;
    }
}

module.exports = Validators;
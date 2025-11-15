const http = require('http');

console.log('🚀 Bitrix Bot Emulator started on port 3001');
console.log('📡 Available endpoints:');
console.log('   GET  /webhook/status    - Check emulator status');
console.log('   POST /webhook/message   - Send message to bot');
console.log('   POST /webhook/location  - Send location to bot');
console.log('=================================================');

const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    console.log(`📨 ${req.method} ${req.url}`);

    if (req.url === '/webhook/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'online',
            service: 'bitrix-bot-emulator',
            timestamp: new Date().toISOString()
        }));
        return;
    }

    if (req.url === '/webhook/message' && req.method === 'POST') {
        let body = '';
        
        req.on('data', chunk => {
            body += chunk.toString();
        });
        
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                console.log('💬 Received message:', {
                    user_id: data.user_id,
                    dialog_id: data.dialog_id,
                    message: data.message
                });

                // Имитация ответа Bitrix24
                const response = {
                    type: 'message_sent',
                    result: {
                        message_id: Date.now(),
                        timestamp: new Date().toISOString(),
                        user_id: data.user_id,
                        dialog_id: data.dialog_id
                    }
                };
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));
                
                console.log('✅ Message processed successfully');

            } catch (error) {
                console.error('❌ Error processing message:', error);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    if (req.url === '/webhook/location' && req.method === 'POST') {
        let body = '';
        
        req.on('data', chunk => {
            body += chunk.toString();
        });
        
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                console.log('📍 Received location:', {
                    user_id: data.user_id,
                    lat: data.lat,
                    lon: data.lon
                });

                const response = {
                    type: 'location_processed',
                    result: {
                        location_id: Date.now(),
                        timestamp: new Date().toISOString(),
                        user_id: data.user_id
                    }
                };
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));
                
                console.log('✅ Location processed successfully');

            } catch (error) {
                console.error('❌ Error processing location:', error);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // 404 для неизвестных маршрутов
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Route not found' }));
});

server.listen(3001, () => {
    console.log('✅ Emulator ready! Test it with: node test-hybrid-system.js');
    console.log('=================================================');
});

// Обработка graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down emulator...');
    server.close(() => {
        console.log('✅ Emulator stopped');
        process.exit(0);
    });
});
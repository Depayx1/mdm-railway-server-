const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Menggunakan PORT dinamis dari Railway, atau port 3000 untuk lokal
const PORT = process.env.PORT || 3000;

app.use(express.json());
let connectedDevices = {};

// ==========================================
// KONEKSI WEBSOCKET REAL-TIME
// ==========================================
wss.on('connection', (ws) => {
    let currentDeviceId = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            // Jalur HP Android mendaftarkan diri
            if (data.type === 'REGISTER_DEVICE') {
                currentDeviceId = data.deviceId;
                connectedDevices[currentDeviceId] = {
                    ws: ws,
                    model: data.model,
                    battery: data.battery,
                    osVersion: data.osVersion,
                    status: "Online",
                    lastSeen: new Date().toLocaleTimeString()
                };
                console.log(`[MDM] HP Terhubung: ${currentDeviceId}`);
                broadcastToAdmins();
            }

            // Jalur Dashboard Web mendaftarkan diri
            if (data.type === 'REGISTER_ADMIN') {
                ws.isAdmin = true;
                ws.send(JSON.stringify({ type: 'UPDATE_LIST', devices: getDeviceList() }));
            }

            // Jalur Admin mengirim perintah (Lock/Wipe) ke HP
            if (data.type === 'SEND_COMMAND' && ws.isAdmin) {
                const target = connectedDevices[data.targetDeviceId];
                if (target && target.ws.readyState === target.ws.OPEN) {
                    target.ws.send(JSON.stringify({ type: 'EXECUTE', command: data.command }));
                    console.log(`[MDM] Perintah ${data.command} dikirim ke ${data.targetDeviceId}`);
                }
            }
        } catch (err) {
            console.error("Gagal membaca data:", err);
        }
    });

    ws.on('close', () => {
        if (currentDeviceId && connectedDevices[currentDeviceId]) {
            console.log(`[MDM] HP Terputus: ${currentDeviceId}`);
            delete connectedDevices[currentDeviceId];
            broadcastToAdmins();
        }
    });
});

function getDeviceList() {
    return Object.keys(connectedDevices).map(id => ({
        deviceId: id,
        model: connectedDevices[id].model,
        battery: connectedDevices[id].battery,
        osVersion: connectedDevices[id].osVersion,
        status: connectedDevices[id].status,
        lastSeen: connectedDevices[id].lastSeen
    }));
}

function broadcastToAdmins() {
    const list = getDeviceList();
    wss.clients.forEach(client => {
        if (client.isAdmin && client.readyState === client.OPEN) {
            client.send(JSON.stringify({ type: 'UPDATE_LIST', devices: list }));
        }
    });
}

// ==========================================
// DASHBOARD WEB ADMIN (FRONTEND)
// ==========================================
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="id">
    <head>
        <meta charset="UTF-8">
        <title>Railway MDM Panel</title>
        <style>
            body { font-family: sans-serif; margin: 0; padding: 20px; background-color: #0f172a; color: #f8fafc; }
            .container { max-width: 1100px; margin: 0 auto; }
            header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; padding-bottom: 20px; }
            h1 { margin: 0; color: #38bdf8; }
            .badge { background-color: #22c55e; padding: 6px 12px; border-radius: 4px; font-size: 14px; font-weight: bold; }
            table { width: 100%; border-collapse: collapse; margin-top: 30px; background-color: #1e293b; border-radius: 8px; overflow: hidden; }
            th, td { padding: 14px; text-align: left; border-bottom: 1px solid #334155; }
            th { background-color: #334155; color: #38bdf8; }
            .btn { padding: 8px 14px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; }
            .btn-lock { background-color: #eab308; color: #0f172a; margin-right: 5px; }
            .btn-wipe { background-color: #ef4444; color: white; }
        </style>
    </head>
    <body>
        <div class="container">
            <header>
                <h1>MDM Railway Panel</h1>
                <div id="status" class="badge" style="background-color: #ef4444;">Connecting...</div>
            </header>
            <table>
                <thead>
                    <tr>
                        <th>Device ID</th>
                        <th>Model HP</th>
                        <th>OS</th>
                        <th>Baterai</th>
                        <th>Status</th>
                        <th>Terakhir Terlihat</th>
                        <th>Aksi Jarak Jauh</th>
                    </tr>
                </thead>
                <tbody id="table-body">
                    <tr><td colspan="7" style="text-align:center; padding: 30px; color: #64748b;">Menunggu perangkat terhubung...</td></tr>
                </tbody>
            </table>
        </div>
        <script>
            const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
            const ws = new WebSocket(protocol + window.location.host);
            
            ws.onopen = () => {
                document.getElementById('status').style.backgroundColor = '#22c55e';
                document.getElementById('status').innerText = 'Server Connected';
                ws.send(JSON.stringify({ type: 'REGISTER_ADMIN' }));
            };
            ws.onclose = () => {
                document.getElementById('status').style.backgroundColor = '#ef4444';
                document.getElementById('status').innerText = 'Disconnected';
            };
            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                if (data.type === 'UPDATE_LIST') { renderTable(data.devices); }
            };

            function renderTable(devices) {
                const tbody = document.getElementById('table-body');
                if(devices.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:30px; color:#64748b;">Tidak ada HP online.</td></tr>';
                    return;
                }
                tbody.innerHTML = '';
                devices.forEach(dev => {
                    tbody.innerHTML += \`
                        <tr>
                            <td>\${dev.deviceId}</td>
                            <td><strong>\${dev.model}</strong></td>
                            <td>Android \${dev.osVersion}</td>
                            <td>\${dev.battery}%</td>
                            <td style="color:#22c55e;">● \${dev.status}</td>
                            <td>\${dev.lastSeen}</td>
                            <td>
                                <button class="btn btn-lock" onclick="sendCmd('\${dev.deviceId}', 'LOCK_DEVICE')">Kunci HP</button>
                                <button class="btn btn-wipe" onclick="sendCmd('\${dev.deviceId}', 'WIPE_DATA')">Wipe Data</button>
                            </td>
                        </tr>
                    \`;
                });
            }

            function sendCmd(deviceId, command) {
                if (command === 'WIPE_DATA' && !confirm('Hapus seluruh data HP secara permanen?')) return;
                ws.send(JSON.stringify({ type: 'SEND_COMMAND', targetDeviceId: deviceId, command: command }));
            }
        </script>
    </body>
    </html>
    `);
});

server.listen(PORT, () => {
    console.log(`Server MDM aktif di port: ${PORT}`);
});

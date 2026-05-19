const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const QRCode = require('qrcode');
const os = require('os');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3030;
const SAVE_DIR = path.join(os.homedir(), 'Downloads', 'Droply');
if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });

app.use(express.json());

// ── Helpers ────────────────────────────────────────────────────────────────

function getLocalSubnets() {
  const nets = os.networkInterfaces();
  const subnets = [];
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) {
        subnets.push(net.address.split('.').slice(0, 3).join('.'));
      }
    }
  }
  return subnets;
}

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

function isLocalNetwork(ip) {
  const clean = ip.replace('::ffff:', '');
  if (clean === '127.0.0.1' || clean === '::1') return true;
  const subnets = getLocalSubnets();
  return subnets.some(s => clean.startsWith(s + '.'));
}

function getClientIP(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace('::ffff:', '');
}

// ── State ──────────────────────────────────────────────────────────────────

const clients = new Map();   // ws → { id, name, deviceType, ip, blocked }
const blocklist = new Set();  // blocked IPs
let nextId = 1;

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcast(data, excludeWs = null) {
  wss.clients.forEach(ws => {
    if (ws !== excludeWs) send(ws, data);
  });
}

function clientList() {
  const list = [];
  clients.forEach((c, ws) => {
    if (!c.blocked) list.push({ id: c.id, name: c.name, deviceType: c.deviceType });
  });
  return list;
}

function pushClientList() {
  const list = clientList();
  wss.clients.forEach(ws => send(ws, { type: 'clients', clients: list }));
}

// ── WebSocket ──────────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');

  // Enforce local network
  if (!isLocalNetwork(ip)) {
    send(ws, { type: 'error', code: 'NOT_LOCAL', message: 'Only local network devices can connect.' });
    ws.close();
    return;
  }

  if (blocklist.has(ip)) {
    send(ws, { type: 'error', code: 'BLOCKED', message: 'You have been blocked by the host.' });
    ws.close();
    return;
  }

  const id = nextId++;
  const info = { id, name: `Device ${id}`, deviceType: 'unknown', ip, blocked: false };
  clients.set(ws, info);

  send(ws, { type: 'welcome', id, serverURL: `http://${getLocalIP()}:${PORT}` });
  pushClientList();
  broadcast({ type: 'system', text: `${info.name} joined` }, ws);

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      const me = clients.get(ws);
      if (!me || me.blocked) return;

      if (msg.type === 'identify') {
        me.name = String(msg.name || '').slice(0, 32) || me.name;
        me.deviceType = msg.deviceType || 'unknown';
        pushClientList();
        broadcast({ type: 'system', text: `${me.name} is here` }, ws);

      } else if (msg.type === 'block') {
        // Any client can tell the server to block a peer (host feature)
        const targetId = msg.targetId;
        clients.forEach((c, cws) => {
          if (c.id === targetId) {
            c.blocked = true;
            blocklist.add(c.ip);
            send(cws, { type: 'error', code: 'BLOCKED', message: 'You were blocked.' });
            cws.close();
          }
        });
        pushClientList();

      } else if (msg.type === 'message') {
        // Broadcast or private message (with optional subject/description)
        const payload = {
          type: 'message',
          fromId: me.id,
          fromName: me.name,
          subject: String(msg.subject || '').slice(0, 100),
          description: String(msg.description || '').slice(0, 500),
          text: String(msg.text || '').slice(0, 2000),
          time: Date.now(),
          private: false
        };
        if (msg.toId) {
          // Private DM
          payload.private = true;
          let sent = false;
          clients.forEach((c, cws) => {
            if (c.id === msg.toId && !c.blocked) { send(cws, payload); sent = true; }
          });
          if (sent) send(ws, { ...payload, echo: true }); // echo to sender
        } else {
          broadcast(payload, ws);
          send(ws, { ...payload, echo: true });
        }
      }
    } catch (e) { /* ignore malformed */ }
  });

  ws.on('close', () => {
    const me = clients.get(ws);
    clients.delete(ws);
    pushClientList();
    if (me && !me.blocked) broadcast({ type: 'system', text: `${me.name} left` });
  });
});

// ── File Upload ────────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SAVE_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}-${file.originalname}`)
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } }); // 2 GB

app.post('/upload', (req, res) => {
  const ip = getClientIP(req);
  if (!isLocalNetwork(ip)) return res.status(403).json({ error: 'Local network only' });
  if (blocklist.has(ip)) return res.status(403).json({ error: 'Blocked' });

  upload.array('files')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });

    const { subject, description, toId } = req.body;
    const senderEntry = [...clients.entries()].find(([, c]) => c.ip === ip);
    const senderName = senderEntry ? senderEntry[1].name : 'Unknown';
    const senderId = senderEntry ? senderEntry[1].id : null;

    const files = (req.files || []).map(f => ({
      name: f.originalname,
      size: f.size,
      mimetype: f.mimetype,
      url: `/files/${encodeURIComponent(f.filename)}`
    }));

    const payload = {
      type: 'files',
      fromId: senderId,
      fromName: senderName,
      subject: String(subject || '').slice(0, 100),
      description: String(description || '').slice(0, 500),
      files,
      time: Date.now(),
      private: !!toId
    };

    if (toId) {
      const tid = parseInt(toId);
      clients.forEach((c, cws) => {
        if (c.id === tid && !c.blocked) send(cws, payload);
      });
      if (senderEntry) send(senderEntry[0], { ...payload, echo: true });
    } else {
      wss.clients.forEach(ws => {
        const c = clients.get(ws);
        if (c && !c.blocked) send(ws, payload);
      });
    }

    res.json({ ok: true, files });
  });
});

// ── Static ─────────────────────────────────────────────────────────────────

app.use('/files', (req, res, next) => {
  const ip = getClientIP(req);
  if (!isLocalNetwork(ip)) return res.status(403).send('Local network only');
  next();
}, express.static(SAVE_DIR));

app.get('/qr', async (req, res) => {
  const url = `http://${getLocalIP()}:${PORT}`;
  const qr = await QRCode.toDataURL(url, { width: 280, margin: 1, color: { dark: '#0a0a0a', light: '#ffffff' } });
  res.json({ qr, url });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'manifest.json')));

// ── Start ──────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  const url = `http://${getLocalIP()}:${PORT}`;
  console.log(`\n┌─────────────────────────────────────┐`);
  console.log(`│  🚀  Droply running                 │`);
  console.log(`│  Local:   http://localhost:${PORT}    │`);
  console.log(`│  Network: ${url}  │`);
  console.log(`│  Scan QR on your phone to connect   │`);
  console.log(`└─────────────────────────────────────┘\n`);
});

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const busboy = require('busboy');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3030;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Rooms ────────────────────────────────────────────────────────────────────
// rooms: Map<roomCode, Map<clientId, clientInfo>>
const rooms = new Map();
const blockedInRoom = new Map();

function getOrCreateRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, new Map());
    blockedInRoom.set(code, new Set());
  }
  return rooms.get(code);
}

function cleanupRoom(code) {
  const room = rooms.get(code);
  if (room && room.size === 0) {
    rooms.delete(code);
    blockedInRoom.delete(code);
  }
}

function broadcast(roomCode, data, excludeId = null) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const msg = JSON.stringify(data);
  for (const [id, client] of room) {
    if (id !== excludeId && client.ws.readyState === 1) client.ws.send(msg);
  }
}

function sendClientList(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const clients = [...room.values()].map(c => ({ id: c.id, name: c.name, deviceType: c.deviceType }));
  for (const [, client] of room) {
    if (client.ws.readyState === 1)
      client.ws.send(JSON.stringify({ type: 'clients', clients }));
  }
}

// ── Subnet → room code ────────────────────────────────────────────────────────
// Groups devices on the same /24 subnet into the same room automatically.
// e.g. 192.168.1.42 → subnet 192.168.1 → stable room code "C8A1"
function subnetToRoom(ip) {
  if (!ip) return 'DEFAULT';
  // Strip IPv6-mapped IPv4 prefix
  const clean = ip.replace(/^::ffff:/, '');
  // For loopback / local dev, use a shared room
  if (clean === '127.0.0.1' || clean === '::1') return 'LOCAL';
  const parts = clean.split('.');
  if (parts.length === 4) {
    // Use first 3 octets as subnet key → hash to short code
    const subnet = parts.slice(0, 3).join('.');
    return hashSubnet(subnet);
  }
  // IPv6: use first 4 groups
  return hashSubnet(clean.split(':').slice(0, 4).join(':'));
}

function hashSubnet(subnet) {
  let h = 0;
  for (let i = 0; i < subnet.length; i++) {
    h = Math.imul(31, h) + subnet.charCodeAt(i) | 0;
  }
  return Math.abs(h).toString(36).toUpperCase().slice(0, 4).padStart(4, '0');
}

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  // Serve index.html
  if (req.method === 'GET' && pathname === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // API: return the room code for this client's subnet + QR code
  if (req.method === 'GET' && pathname === '/api/room') {
    const ip = getClientIP(req);
    const roomCode = subnetToRoom(ip);
    const host = req.headers['x-forwarded-host'] || req.headers['host'] || `localhost:${PORT}`;
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const roomUrl = `${proto}://${host}`;
    const qrDataUrl = await QRCode.toDataURL(roomUrl, { width: 180, margin: 1 });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ room: roomCode, url: roomUrl, qr: qrDataUrl, ip }));
  }

  // Serve uploaded files
  if (req.method === 'GET' && pathname.startsWith('/uploads/')) {
    const file = path.join(UPLOAD_DIR, path.basename(pathname));
    if (fs.existsSync(file)) {
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'Content-Type': getMime(ext), 'Cache-Control': 'public, max-age=3600' });
      return fs.createReadStream(file).pipe(res);
    }
    res.writeHead(404); return res.end('Not found');
  }

  // File upload
  if (req.method === 'POST' && pathname === '/upload') {
    const roomCode = url.searchParams.get('room');
    const toId = url.searchParams.get('toId') || null;
    const fromId = url.searchParams.get('fromId');

    if (!roomCode || !rooms.has(roomCode)) {
      res.writeHead(400); return res.end(JSON.stringify({ error: 'Bad room' }));
    }

    const bb = busboy({ headers: req.headers, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });
    const fileWritePromises = [];
    const savedFiles = [];
    let subject = '', description = '';

    bb.on('field', (name, val) => {
      if (name === 'subject') subject = val;
      if (name === 'description') description = val;
    });

    bb.on('file', (fieldname, stream, info) => {
      const filename = info.filename || 'file';
      const uid = uuidv4();
      const ext = path.extname(filename);
      const saveName = uid + ext;
      const savePath = path.join(UPLOAD_DIR, saveName);
      let size = 0;

      const p = new Promise((resolve, reject) => {
        const ws2 = fs.createWriteStream(savePath);
        stream.on('data', chunk => size += chunk.length);
        stream.pipe(ws2);
        ws2.on('finish', () => {
          savedFiles.push({ name: filename, url: `/uploads/${saveName}`, size });
          resolve();
        });
        ws2.on('error', reject);
      });
      fileWritePromises.push(p);
    });

    bb.on('finish', async () => {
      try {
        await Promise.all(fileWritePromises);
      } catch (e) {
        res.writeHead(500); return res.end(JSON.stringify({ error: 'Write failed' }));
      }

      if (!savedFiles.length) { res.writeHead(400); return res.end(JSON.stringify({ error: 'No files' })); }

      const room = rooms.get(roomCode);
      const fromClient = room?.get(fromId);
      const fromName = fromClient?.name || 'Unknown';
      const isPrivate = !!toId;

      const payload = {
        type: 'files',
        fromId,
        fromName,
        files: savedFiles,
        subject,
        description,
        private: isPrivate,
        time: Date.now(),
      };

      // Echo to sender
      if (fromClient?.ws.readyState === 1)
        fromClient.ws.send(JSON.stringify({ ...payload, echo: true }));

      if (isPrivate) {
        const target = room?.get(toId);
        if (target?.ws.readyState === 1) target.ws.send(JSON.stringify(payload));
      } else {
        broadcast(roomCode, payload, fromId);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, files: savedFiles.length }));
    });

    bb.on('error', (err) => {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    });

    req.pipe(bb);
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ── WebSocket Server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const ip = getClientIP(req);
  const roomCode = subnetToRoom(ip);

  const blocked = blockedInRoom.get(roomCode);
  const clientId = uuidv4().split('-')[0];

  // Check if blocked
  if (blocked?.has(clientId)) {
    ws.send(JSON.stringify({ type: 'error', code: 'BLOCKED' }));
    ws.close(); return;
  }

  const client = {
    id: clientId, ws,
    name: `Device-${clientId.slice(0, 4)}`,
    deviceType: 'desktop',
    roomCode,
  };

  const room = getOrCreateRoom(roomCode);
  room.set(clientId, client);

  ws.send(JSON.stringify({ type: 'welcome', id: clientId, room: roomCode }));
  sendClientList(roomCode);
  broadcast(roomCode, { type: 'system', text: `${client.name} joined` }, clientId);

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'identify') {
      client.name = String(m.name || client.name).slice(0, 32);
      client.deviceType = ['phone', 'tablet', 'desktop'].includes(m.deviceType) ? m.deviceType : 'desktop';
      broadcast(roomCode, { type: 'system', text: `${client.name} is here` });
      sendClientList(roomCode);
    }

    if (m.type === 'message') {
      const isPrivate = !!m.toId;
      const payload = {
        type: 'message',
        fromId: clientId,
        fromName: client.name,
        subject: String(m.subject || '').slice(0, 100),
        description: String(m.description || '').slice(0, 500),
        text: String(m.text || '').slice(0, 5000),
        private: isPrivate,
        time: Date.now(),
      };
      ws.send(JSON.stringify({ ...payload, echo: true }));
      if (isPrivate) {
        const target = room.get(m.toId);
        if (target?.ws.readyState === 1) target.ws.send(JSON.stringify(payload));
      } else {
        broadcast(roomCode, payload, clientId);
      }
    }

    if (m.type === 'block') {
      const target = room.get(m.targetId);
      if (target) {
        blockedInRoom.get(roomCode)?.add(m.targetId);
        target.ws.send(JSON.stringify({ type: 'error', code: 'BLOCKED' }));
        target.ws.close();
        room.delete(m.targetId);
        broadcast(roomCode, { type: 'system', text: `A device was removed` });
        sendClientList(roomCode);
      }
    }
  });

  ws.on('close', () => {
    room.delete(clientId);
    broadcast(roomCode, { type: 'system', text: `${client.name} left` });
    sendClientList(roomCode);
    cleanupRoom(roomCode);
  });
});

function getMime(ext) {
  const map = {
    '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png',
    '.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml',
    '.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm',
    '.mp3':'audio/mpeg','.wav':'audio/wav','.pdf':'application/pdf',
    '.zip':'application/zip',
  };
  return map[ext] || 'application/octet-stream';
}

server.listen(PORT, () => {
  console.log(`Droply running → http://localhost:${PORT}`);
});

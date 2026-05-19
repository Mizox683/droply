const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const busboy = require('busboy');

const PORT = process.env.PORT || 3030;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── In-memory state ──────────────────────────────────────────────────────
// rooms: Map<roomCode, Map<clientId, clientInfo>>
const rooms = new Map();
const clientRoom = new Map(); // clientId -> roomCode
const blockedInRoom = new Map(); // roomCode -> Set<clientId>

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
    if (id !== excludeId && client.ws.readyState === 1) {
      client.ws.send(msg);
    }
  }
}

function sendClientList(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const clients = [...room.values()].map(c => ({
    id: c.id,
    name: c.name,
    deviceType: c.deviceType,
  }));
  for (const [, client] of room) {
    if (client.ws.readyState === 1) {
      client.ws.send(JSON.stringify({ type: 'clients', clients }));
    }
  }
}

// ── HTTP Server ──────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  // Serve index.html for / or /<roomcode>
  if (req.method === 'GET' && (pathname === '/' || /^\/[A-Z0-9]{4,8}$/i.test(pathname))) {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // Serve uploaded files
  if (req.method === 'GET' && pathname.startsWith('/uploads/')) {
    const file = path.join(UPLOAD_DIR, path.basename(pathname));
    if (fs.existsSync(file)) {
      const ext = path.extname(file).toLowerCase();
      const mime = getMime(ext);
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' });
      return fs.createReadStream(file).pipe(res);
    }
    res.writeHead(404); return res.end('Not found');
  }

  // File upload endpoint
  if (req.method === 'POST' && pathname === '/upload') {
    const roomCode = url.searchParams.get('room');
    const toId = url.searchParams.get('toId') || null;
    const fromId = url.searchParams.get('fromId');

    if (!roomCode || !rooms.has(roomCode)) {
      res.writeHead(400); return res.end('Bad room');
    }

    const bb = busboy({ headers: req.headers, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });
    const savedFiles = [];
    let subject = '', description = '';

    bb.on('field', (name, val) => {
      if (name === 'subject') subject = val;
      if (name === 'description') description = val;
    });

    bb.on('file', (fieldname, stream, info) => {
      const filename = info.filename;
      const uid = uuidv4();
      const ext = path.extname(filename);
      const saveName = uid + ext;
      const savePath = path.join(UPLOAD_DIR, saveName);
      let size = 0;
      const ws2 = fs.createWriteStream(savePath);
      stream.on('data', chunk => size += chunk.length);
      stream.pipe(ws2);
      ws2.on('finish', () => {
        savedFiles.push({ name: filename, url: `/uploads/${saveName}`, size });
      });
    });

    bb.on('finish', () => {
      if (!savedFiles.length) { res.writeHead(400); return res.end('No files'); }

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

      // Echo back to sender
      if (fromClient?.ws.readyState === 1) {
        fromClient.ws.send(JSON.stringify({ ...payload, echo: true }));
      }

      if (isPrivate) {
        const target = room?.get(toId);
        if (target?.ws.readyState === 1) target.ws.send(JSON.stringify(payload));
      } else {
        broadcast(roomCode, payload, fromId);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    req.pipe(bb);
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ── WebSocket Server ──────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost`);
  const roomCode = (url.searchParams.get('room') || '').toUpperCase();

  if (!roomCode || !/^[A-Z0-9]{4,8}$/.test(roomCode)) {
    ws.close(1008, 'Invalid room');
    return;
  }

  const blocked = blockedInRoom.get(roomCode);
  const clientId = uuidv4().split('-')[0];

  const client = {
    id: clientId,
    ws,
    name: `Device-${clientId.slice(0, 4)}`,
    deviceType: 'desktop',
    roomCode,
  };

  const room = getOrCreateRoom(roomCode);
  room.set(clientId, client);
  clientRoom.set(clientId, roomCode);

  ws.send(JSON.stringify({ type: 'welcome', id: clientId, room: roomCode }));
  sendClientList(roomCode);

  broadcast(roomCode, { type: 'system', text: `${client.name} joined` }, clientId);

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'identify') {
      client.name = String(m.name || client.name).slice(0, 32);
      client.deviceType = ['phone', 'tablet', 'desktop'].includes(m.deviceType) ? m.deviceType : 'desktop';
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
      // Echo to sender
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
        clientRoom.delete(m.targetId);
        broadcast(roomCode, { type: 'system', text: `A device was removed` });
        sendClientList(roomCode);
      }
    }
  });

  ws.on('close', () => {
    room.delete(clientId);
    clientRoom.delete(clientId);
    broadcast(roomCode, { type: 'system', text: `${client.name} left` });
    sendClientList(roomCode);
    cleanupRoom(roomCode);
  });
});

// ── MIME types ────────────────────────────────────────────────────────────
function getMime(ext) {
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf',
    '.zip': 'application/zip',
  };
  return map[ext] || 'application/octet-stream';
}

server.listen(PORT, () => {
  console.log(`Droply running → http://localhost:${PORT}`);
});

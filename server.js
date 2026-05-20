/**
 * Droply — Signalling-only server
 *
 * Does exactly three things:
 *   1. Serves index.html
 *   2. Groups devices by LAN subnet into rooms
 *   3. Relays tiny WebRTC signalling messages (offer/answer/ICE) between peers
 *
 * All actual file/message data flows peer-to-peer via WebRTC data channels.
 * Nothing is stored. Nothing is uploaded. No internet required.
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3030;

// ── Room state ────────────────────────────────────────────────────
// Map<roomCode, Map<clientId, { id, ip, name, deviceType, ws }>>
const rooms      = new Map();
const blockedIPs = new Map();

function getOrCreateRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, new Map());
    blockedIPs.set(code, new Set());
  }
  return rooms.get(code);
}

function cleanupRoom(code) {
  if (rooms.get(code)?.size === 0) {
    rooms.delete(code);
    blockedIPs.delete(code);
  }
}

function broadcast(roomCode, data, excludeId = null) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const msg = JSON.stringify(data);
  for (const [id, c] of room) {
    if (id !== excludeId && c.ws.readyState === 1) c.ws.send(msg);
  }
}

function pushPeerList(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const peers = [...room.values()].map(c => ({
    id: c.id, name: c.name, deviceType: c.deviceType
  }));
  const msg = JSON.stringify({ type: 'peers', peers });
  for (const [, c] of room) {
    if (c.ws.readyState === 1) c.ws.send(msg);
  }
}

// ── IP helpers ────────────────────────────────────────────────────
function getClientIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

function isLAN(ip) {
  const c = ip.replace(/^::ffff:/, '');
  return (
    c === '127.0.0.1' || c === '::1' ||
    /^10\./.test(c) ||
    /^192\.168\./.test(c) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(c)
  );
}

function subnetRoom(ip) {
  const c = ip.replace(/^::ffff:/, '');
  if (c === '127.0.0.1' || c === '::1') return 'LOCAL';
  const parts = c.split('.');
  if (parts.length === 4) return hashStr(parts.slice(0, 3).join('.'));
  return hashStr(c.split(':').slice(0, 4).join(':'));
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return Math.abs(h).toString(36).toUpperCase().slice(0, 4).padStart(4, '0');
}

function getHostLANIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces) {
      if (!i.internal && i.family === 'IPv4') return i.address;
    }
  }
  return 'localhost';
}

// ── HTTP ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url      = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const ip       = getClientIP(req);

  // Only allow LAN connections
  if (!isLAN(ip)) {
    res.writeHead(403); return res.end('Local network only');
  }

  if (req.method === 'GET') {
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }

    if (pathname === '/manifest.json') {
      const mf = path.join(__dirname, 'manifest.json');
      if (fs.existsSync(mf)) {
        res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
        return res.end(fs.readFileSync(mf));
      }
    }

    if (pathname === '/qr') {
      const hostIP  = getHostLANIP();
      const roomUrl = `http://${hostIP}:${PORT}`;
      const qr      = await QRCode.toDataURL(roomUrl, {
        width: 220, margin: 1,
        color: { dark: '#000', light: '#fff' }
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        url: roomUrl,
        qr,
        room: subnetRoom(ip),
        hostIP,
        port: PORT
      }));
    }
  }

  res.writeHead(404); res.end('Not found');
});

// ── WebSocket signalling ──────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const ip       = getClientIP(req);
  const roomCode = subnetRoom(ip);

  if (!isLAN(ip)) {
    ws.send(JSON.stringify({ type: 'error', code: 'NOT_LOCAL' }));
    ws.close(); return;
  }

  if (blockedIPs.get(roomCode)?.has(ip)) {
    ws.send(JSON.stringify({ type: 'error', code: 'BLOCKED' }));
    ws.close(); return;
  }

  const clientId = uuidv4().split('-')[0];
  const client   = {
    id: clientId, ip, ws,
    name: `Device-${clientId.slice(0, 4)}`,
    deviceType: 'desktop',
    roomCode
  };

  const room = getOrCreateRoom(roomCode);
  room.set(clientId, client);

  // Welcome: send own ID + existing peers
  ws.send(JSON.stringify({
    type:  'welcome',
    id:    clientId,
    room:  roomCode,
    peers: [...room.values()]
      .filter(c => c.id !== clientId)
      .map(c => ({ id: c.id, name: c.name, deviceType: c.deviceType }))
  }));

  broadcast(roomCode, {
    type: 'peer-joined',
    peer: { id: clientId, name: client.name, deviceType: client.deviceType }
  }, clientId);

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'identify') {
      client.name       = String(m.name || client.name).slice(0, 32);
      client.deviceType = ['phone','tablet','desktop'].includes(m.deviceType)
        ? m.deviceType : 'desktop';
      broadcast(roomCode, {
        type: 'peer-updated',
        peer: { id: clientId, name: client.name, deviceType: client.deviceType }
      });
      pushPeerList(roomCode);
    }

    // WebRTC signalling — relay to target peer only
    if (['rtc-offer','rtc-answer','rtc-ice'].includes(m.type)) {
      const target = room.get(m.toId);
      if (target?.ws.readyState === 1) {
        target.ws.send(JSON.stringify({ ...m, fromId: clientId, fromName: client.name }));
      }
    }

    // Text chat via server (fallback if P2P not yet ready)
    if (m.type === 'chat') {
      const payload = {
        type:     'chat',
        fromId:   clientId,
        fromName: client.name,
        text:     String(m.text || '').slice(0, 4000),
        subject:  String(m.subject || '').slice(0, 100),
        toId:     m.toId || null,
        time:     Date.now(),
      };
      ws.send(JSON.stringify({ ...payload, echo: true }));
      if (m.toId) {
        const t = room.get(m.toId);
        if (t?.ws.readyState === 1) t.ws.send(JSON.stringify(payload));
      } else {
        broadcast(roomCode, payload, clientId);
      }
    }

    // Block peer by IP
    if (m.type === 'block') {
      const target = room.get(m.targetId);
      if (target) {
        blockedIPs.get(roomCode)?.add(target.ip);
        target.ws.send(JSON.stringify({ type: 'error', code: 'BLOCKED' }));
        target.ws.close();
        room.delete(m.targetId);
        broadcast(roomCode, { type: 'peer-left', id: m.targetId });
        pushPeerList(roomCode);
      }
    }
  });

  ws.on('close', () => {
    room.delete(clientId);
    broadcast(roomCode, { type: 'peer-left', id: clientId, name: client.name });
    pushPeerList(roomCode);
    cleanupRoom(roomCode);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const lan = getHostLANIP();
  console.log('\n📡  Droply — signalling server');
  console.log(`    Local   → http://localhost:${PORT}`);
  console.log(`    Network → http://${lan}:${PORT}`);
  console.log('\n    Signalling only. All file transfers are peer-to-peer.');
  console.log('    Nothing is stored on this server.\n');
});

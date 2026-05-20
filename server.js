/**
 * Droply — Public signalling server
 *
 * Works as a public website. Groups visitors into rooms automatically:
 * - Same public IP (same router/network) → same room
 * - Different public IP → different room
 *
 * The server only handles signalling (WebRTC handshake).
 * All file/message data flows directly peer-to-peer via WebRTC data channels.
 * Nothing is stored. Nothing is uploaded.
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');

const PORT       = process.env.PORT || 3030;
const PUBLIC_URL = process.env.PUBLIC_URL || ''; // e.g. https://droply.example.com

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
  // Trust x-forwarded-for if behind a reverse proxy (nginx, Cloudflare, etc.)
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  const ip = req.socket?.remoteAddress || '';
  // Strip IPv6-mapped IPv4
  return ip.replace(/^::ffff:/i, '').trim();
}

/**
 * Room code = hash of the public IP.
 * Everyone behind the same router shares the same public IP → same room.
 * IPv4: hash full IP (not just subnet — on a VPS each user has a different public IP anyway)
 * IPv6: hash first 6 groups (usually the network prefix for a household)
 */
function ipToRoom(ip) {
  if (!ip) return 'DEFAULT';
  const c = ip.replace(/^::ffff:/i, '').trim();
  // Loopback / local dev — put everyone in the same room
  if (c === '127.0.0.1' || c === '::1' || c === 'localhost' || c === '') return 'LOCAL';
  // Private LAN ranges → use /24 subnet so all LAN devices share a room
  if (
    /^10\./.test(c) ||
    /^192\.168\./.test(c) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(c)
  ) {
    const parts = c.split('.');
    return hashStr('lan:' + parts.slice(0, 3).join('.'));
  }
  // Public IPv4 — full IP is the room key (each router has one public IP)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(c)) return hashStr(c);
  // IPv6 — use first 4 groups as network prefix
  return hashStr(c.split(':').slice(0, 4).join(':'));
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  // 6-char alphanumeric code — short enough to share, enough entropy for rooms
  return Math.abs(h).toString(36).toUpperCase().slice(0, 6).padStart(6, '0');
}

function getSiteURL(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${host}`;
}

// ── HTTP ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url      = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const ip       = getClientIP(req);
  const roomCode = ipToRoom(ip);

  // Allow all connections — no LAN restriction
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

    // Returns site URL + QR + room code for this visitor
    if (pathname === '/qr') {
      const siteUrl = getSiteURL(req);
      const qr      = await QRCode.toDataURL(siteUrl, {
        width: 220, margin: 1,
        color: { dark: '#000', light: '#fff' }
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        url:  siteUrl,
        qr,
        room: roomCode,
      }));
    }

    // Room info endpoint — how many people in my room right now
    if (pathname === '/room-info') {
      const room = rooms.get(roomCode);
      const count = room ? room.size : 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ room: roomCode, peers: count }));
    }
  }

  res.writeHead(404); res.end('Not found');
});

// ── WebSocket signalling ──────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const ip       = getClientIP(req);
  const roomCode = ipToRoom(ip);

  // Check if this IP is blocked in this room
  if (blockedIPs.get(roomCode)?.has(ip)) {
    ws.send(JSON.stringify({ type: 'error', code: 'BLOCKED' }));
    ws.close(); return;
  }

  const clientId = uuidv4().split('-')[0];
  const client   = {
    id: clientId, ip, ws,
    name:       `Device-${clientId.slice(0, 4)}`,
    deviceType: 'desktop',
    roomCode
  };

  const room = getOrCreateRoom(roomCode);
  room.set(clientId, client);

  console.log(`[+] ${clientId} joined room ${roomCode} (ip: ${ip}) — room size: ${room.size}`);

  // Welcome: send own ID + room code + existing peers
  ws.send(JSON.stringify({
    type:  'welcome',
    id:    clientId,
    room:  roomCode,
    peers: [...room.values()]
      .filter(c => c.id !== clientId)
      .map(c => ({ id: c.id, name: c.name, deviceType: c.deviceType }))
  }));

  // Tell everyone else a new peer arrived
  broadcast(roomCode, {
    type: 'peer-joined',
    peer: { id: clientId, name: client.name, deviceType: client.deviceType }
  }, clientId);

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    // Device identifies itself with a name and device type
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

    // WebRTC signalling — relay to target peer only, never stored
    if (['rtc-offer','rtc-answer','rtc-ice'].includes(m.type)) {
      const target = room.get(m.toId);
      if (target?.ws.readyState === 1) {
        target.ws.send(JSON.stringify({ ...m, fromId: clientId, fromName: client.name }));
      }
    }

    // Text chat — relayed through server as fallback before P2P is ready
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

    // Block a peer by their IP — they can't rejoin this room
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
    console.log(`[-] ${clientId} left room ${roomCode} — room size: ${room.size}`);
    broadcast(roomCode, { type: 'peer-left', id: clientId, name: client.name });
    pushPeerList(roomCode);
    cleanupRoom(roomCode);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n📡  Droply — public signalling server');
  console.log(`    Listening on port ${PORT}`);
  console.log(`    Set PUBLIC_URL env var to your domain, e.g.:`);
  console.log(`    PUBLIC_URL=https://droply.example.com node server.js`);
  console.log('\n    Rooms are grouped by public IP automatically.');
  console.log('    Signalling only — all file transfers are peer-to-peer.');
  console.log('    Nothing is stored on this server.\n');
});

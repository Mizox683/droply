# Droply 📡

> Open-source local network file sharing. Send files, images, and videos to every device on your WiFi — privately, instantly, no cloud.

![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)

## Features

- 📡 **Broadcast** — send files/messages to all connected devices at once
- 🔏 **Private DM** — click any device to send directly to just them
- 🚫 **Block strangers** — one-click block any device from your session
- 🎬 **Media preview** — images and videos preview inline before saving
- 📝 **Subject + description** — add context to every send
- 📱 **QR connect** — scan the QR code to join from your phone instantly
- 🔒 **Local network enforced** — the server blocks any connection that isn't on your LAN
- 💾 Files saved to `~/Downloads/Droply/` on the host machine
- No account, no cloud, no tracking — 100% private

## Quick Start

**Requirements:** [Node.js 18+](https://nodejs.org)

```bash
git clone https://github.com/YOUR_USERNAME/droply.git
cd droply
npm install
node server.js
```

Then open **http://localhost:3030** in your browser.

## Connecting other devices

1. Make sure all devices are on the **same WiFi network**
2. On the host PC, open `http://localhost:3030`
3. Scan the **QR code** with your phone — or share the network URL shown on screen
4. Everyone connected appears in the device list

## How to use

### Send to everyone
- Drop files on the drop zone or click "Attach files"
- Add an optional subject and description
- Hit **Send** — all connected devices get the files instantly with a download link

### Send privately (device to device)
- Click the **✉ envelope** icon next to any device in the list
- The target chip appears — now your sends go only to that device
- Click ✕ on the chip to go back to broadcast mode

### Block a device
- Click the **🚫** icon next to any device
- They are immediately disconnected and cannot reconnect

### Preview media
- Images show as thumbnails — click to open full preview
- Videos show a play button — click to play inline

## Security model

- The server checks every WebSocket connection and HTTP request against your machine's local subnet
- Any IP outside your LAN (`192.168.x.x`, `10.x.x.x`, `172.16–31.x.x`) is immediately rejected
- Blocked IPs are stored in memory for the session duration
- No data leaves your local network

## Deploy / self-host

For permanent hosting within your home network, run with [PM2](https://pm2.keymetrics.io/):

```bash
npm install -g pm2
pm2 start server.js --name droply
pm2 startup
pm2 save
```

## Contributing

PRs welcome! Open an issue first for big changes.

## License

MIT

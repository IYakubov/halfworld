const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const SLOTS = ['A', 'B'];

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/controller', (req, res) => res.sendFile(path.join(__dirname, 'public', 'controller.html')));

// ── LAN address ──
// Phones can't reach "localhost", so when the host page was opened via
// localhost/127.0.0.1 the QR code uses this machine's LAN IPv4 instead.
function lanIp() {
  const nets = os.networkInterfaces();
  const found = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if ((n.family === 'IPv4' || n.family === 4) && !n.internal) found.push(n.address);
    }
  }
  const pref = found.find(a => /^192\.168\./.test(a)) ||
               found.find(a => /^10\./.test(a)) ||
               found.find(a => /^172\.(1[6-9]|2\d|3[01])\./.test(a)) ||
               found[0];
  return pref || 'localhost';
}

// Public address of this game behind the Shared Couch front door
// (it sends X-Forwarded-Proto / -Host / -Prefix).
function publicPrefix(h) {
  return String(h['x-forwarded-prefix'] || '').split(',')[0].trim().replace(/\/+$/, '');
}
function publicProto(h) {
  return String(h['x-forwarded-proto'] || 'http').split(',')[0].trim();
}
function joinBase(headers) {
  const h = String(headers['x-forwarded-host'] || headers.host || '').split(',')[0].trim().toLowerCase();
  const hostname = h.replace(/:\d+$/, '');
  if (!h || hostname === 'localhost' || hostname.startsWith('127.') || hostname === '[::1]') {
    return `http://${lanIp()}:${PORT}`;
  }
  return `${publicProto(headers)}://${h}${publicPrefix(headers)}`;
}

async function qrSvgFor(url) {
  return QRCode.toString(url, {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#1b1b1a', light: '#ecebe6' }
  });
}

// ── Rooms ──
// rooms[code] = { hostSocketId, players:{A,B}, clientIds:{A,B}, ready:{A,B},
//                 started, active:['A','B']|['A'], ui }
const rooms = {};
const both = v => ({ A: v, B: v });

function genCode() {
  let code;
  do { code = Math.floor(100000 + Math.random() * 900000).toString(); } while (rooms[code]);
  return code;
}

function lobbyPayload(room) {
  return { A: !!room.players.A, B: !!room.players.B, readyA: room.ready.A, readyB: room.ready.B };
}
function broadcastLobby(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit('game_event', { event: 'lobby_ready_update', data: lobbyPayload(room) });
}

function shortUA(socket) {
  const ua = socket.handshake.headers['user-agent'] || '?';
  return ua.length > 90 ? ua.slice(0, 90) + '…' : ua;
}

// Bind a phone to a slot. One phone (clientId) = one slot, one socket = one slot.
function bindPhone(socket, code, clientId, hintSlot) {
  const room = rooms[code];
  if (!room) { socket.emit('join_error', 'Room not found'); return; }
  clientId = typeof clientId === 'string' && clientId ? clientId.slice(0, 64) : null;

  if (socket.data.code === code && socket.data.slot && room.players[socket.data.slot] === socket.id) {
    sendJoined(socket, room, socket.data.slot);
    return;
  }

  let slot = null;
  if (clientId) slot = SLOTS.find(s => room.clientIds[s] === clientId) || null;
  if (!slot && SLOTS.includes(hintSlot) && !room.players[hintSlot] && !room.clientIds[hintSlot]) slot = hintSlot;
  if (!slot) slot = SLOTS.find(s => !room.players[s] && !room.clientIds[s]) || null;
  if (!slot) slot = SLOTS.find(s => !room.players[s]) || null;
  if (!slot) { socket.emit('join_error', 'Room is full'); return; }

  const prev = room.players[slot];
  if (prev && prev !== socket.id) {
    const old = io.sockets.sockets.get(prev);
    if (old) {
      old.data.slot = null;
      old.data.code = null;
      old.leave(code);
      old.emit('replaced');
    }
  }
  SLOTS.forEach(s => { if (s !== slot && room.players[s] === socket.id) room.players[s] = null; });

  if (room.clientIds[slot] !== clientId) room.ready[slot] = false;
  room.players[slot] = socket.id;
  room.clientIds[slot] = clientId;
  socket.data.code = code;
  socket.data.slot = slot;
  socket.join(code);

  console.log(`[${code}] phone → ${slot}  (${shortUA(socket)})`);
  sendJoined(socket, room, slot);
  io.to(code).emit('player_joined', { slot, players: { A: !!room.players.A, B: !!room.players.B } });
  broadcastLobby(code);
}

function sendJoined(socket, room, slot) {
  socket.emit('joined', { slot, code: socket.data.code, started: room.started, ready: room.ready[slot] });
  if (room.started) {
    socket.emit('game_start', { players: room.active || ['A', 'B'] });
    if (room.ui) socket.emit('host_ui', room.ui);
  }
}

function phoneOk(socket) {
  const room = rooms[socket.data.code];
  const slot = socket.data.slot;
  if (!room || !slot || room.players[slot] !== socket.id) return null;
  return { room, slot };
}

io.on('connection', (socket) => {
  socket.data.code = null;
  socket.data.slot = null;
  socket.data.isHost = false;

  // ── HOST ──
  socket.on('create_game', async () => {
    const code = genCode();
    rooms[code] = {
      hostSocketId: socket.id,
      players: both(null),
      clientIds: both(null),
      ready: both(false),
      started: false,
      active: null,
      ui: null
    };
    socket.data.code = code;
    socket.data.isHost = true;
    socket.join(code);
    const joinUrl = `${joinBase(socket.handshake.headers)}/controller?code=${code}`;
    let qrSvg = '';
    try { qrSvg = await qrSvgFor(joinUrl); } catch (e) { console.warn('QR failed', e.message); }
    console.log(`[${code}] room created — join: ${joinUrl}`);
    socket.emit('game_created', { code, joinUrl, qrSvg });
  });

  // Host mirrors its menus / roles / status to the phones.
  socket.on('host_ui', (ui) => {
    const room = rooms[socket.data.code];
    if (!room || room.hostSocketId !== socket.id) return;
    room.ui = ui;
    socket.to(socket.data.code).emit('host_ui', ui);
  });

  // Live gun angle + ammo, ~10 times a second (dropped if a phone lags behind).
  socket.on('host_state', (st) => {
    const room = rooms[socket.data.code];
    if (!room || room.hostSocketId !== socket.id) return;
    socket.volatile.to(socket.data.code).emit('host_state', st);
  });

  socket.on('host_back_to_lobby', () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.hostSocketId !== socket.id) return;
    room.started = false;
    room.active = null;
    room.ready = both(false);
    room.ui = null;
    io.to(code).emit('back_to_lobby');
    broadcastLobby(code);
  });

  socket.on('host_exit', () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.hostSocketId !== socket.id) return;
    socket.to(code).emit('host_exit');
  });

  // ── PHONE ──
  socket.on('join_game', ({ code, clientId } = {}) => bindPhone(socket, String(code || ''), clientId, null));
  socket.on('rejoin_game', ({ code, slot, clientId } = {}) => bindPhone(socket, String(code || ''), clientId, slot));

  socket.on('player_ready', () => {
    const p = phoneOk(socket);
    if (!p) return;
    const { room } = p;
    room.ready[p.slot] = true;
    broadcastLobby(socket.data.code);
    if (!room.started && room.players.A && room.players.B && room.ready.A && room.ready.B) {
      room.started = true;
      room.active = ['A', 'B'];
      io.to(socket.data.code).emit('game_start', { players: room.active });
    }
  });

  // One phone alone in the room plays both roles.
  socket.on('player_solo', () => {
    const p = phoneOk(socket);
    if (!p || p.room.started) return;
    const other = p.slot === 'A' ? 'B' : 'A';
    if (p.room.players[other]) return;
    p.room.ready[p.slot] = true;
    p.room.started = true;
    p.room.active = [p.slot];
    broadcastLobby(socket.data.code);
    io.to(socket.data.code).emit('game_start', { players: p.room.active });
  });

  // Turning: dir -1 (left), 0 (stop), 1 (right).
  socket.on('ctrl_turn', ({ dir } = {}) => {
    const p = phoneOk(socket);
    if (!p) return;
    dir = Number(dir);
    if (![-1, 0, 1].includes(dir)) return;
    io.to(p.room.hostSocketId).emit('ctrl_turn', { slot: p.slot, dir });
  });

  // Trigger held / released.
  socket.on('ctrl_fire', ({ on } = {}) => {
    const p = phoneOk(socket);
    if (!p) return;
    io.to(p.room.hostSocketId).emit('ctrl_fire', { slot: p.slot, on: !!on });
  });

  // A tapped row of the mirrored menu.
  socket.on('ctrl_pick', ({ index } = {}) => {
    const p = phoneOk(socket);
    if (!p) return;
    io.to(p.room.hostSocketId).emit('ctrl_pick', { slot: p.slot, index: Number(index) | 0 });
  });

  socket.on('ctrl_menu', () => {
    const p = phoneOk(socket);
    if (!p) return;
    io.to(p.room.hostSocketId).emit('ctrl_menu', { slot: p.slot });
  });

  socket.on('disconnect', () => {
    const code = socket.data.code;
    const room = code && rooms[code];
    if (!room) return;

    if (socket.data.isHost && room.hostSocketId === socket.id) {
      io.to(code).emit('host_disconnected');
      delete rooms[code];
      return;
    }
    const slot = socket.data.slot;
    if (slot && room.players[slot] === socket.id) {
      room.players[slot] = null;
      if (!room.started) room.ready[slot] = false;
      // A phone that drops mid-game lets go of the crank and the trigger.
      io.to(room.hostSocketId).emit('ctrl_turn', { slot, dir: 0 });
      io.to(room.hostSocketId).emit('ctrl_fire', { slot, on: false });
      io.to(code).emit('player_left', { slot });
      broadcastLobby(code);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Turret Duo server: http://localhost:${PORT}`);
  console.log(`Phones join via: http://${lanIp()}:${PORT}`);
});

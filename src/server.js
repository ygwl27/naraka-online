/**
 * 永劫·振刀录 —— 多人联机服务端
 *
 * 架构：Node.js + Express + Socket.IO，服务器权威（server-authoritative）
 *   - 客户端只发送「输入/操作」，不信任客户端发来的位置、分数、战斗结果。
 *   - 服务端以固定 tick（默认 15Hz）计算权威状态并广播快照。
 *   - 房间与玩家状态存内存，免费单实例够用；重启后房间丢失可接受。
 *   - 每个玩家分配 playerId + sessionToken，断线 120 秒内凭 token 恢复。
 *
 * 部署：Render 免费层 Web Service
 *   - 监听 process.env.PORT，绑定 0.0.0.0，不写死 localhost。
 *   - 健康检查 GET /healthz 返回 200 OK。
 */

'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

const TICK_MS = 66;                 // 约 15Hz 广播频率
const ROOM_MAX_PLAYERS = 8;         // 单房间最大玩家数
const PLAYER_RECONNECT_GRACE_MS = 120000; // 断线后保留状态 120 秒
const INPUT_RATE_LIMIT = 30;        // 每玩家每秒最多 N 条输入
const CLEANUP_INTERVAL_MS = 30000;  // 空房间/超时玩家清理间隔

// 简单日志：带时间戳，方便在 Render 面板看
function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

// ---------------------------------------------------------------------------
// Express + HTTP + Socket.IO
// ---------------------------------------------------------------------------
const app = express();

// 静态目录（前端页面由同一 Express 服务托管，减少 CORS / 部署复杂度）
app.use(express.static(path.join(__dirname, '..', 'public')));

// 健康检查：Render 用它判断实例是否存活；冷启动后第一次被访问会唤醒实例
app.get('/healthz', (req, res) => {
  res.status(200).type('text/plain').send('OK');
});

// 根路径返回前端入口
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const server = http.createServer(app);
const io = new Server(server, {
  // Socket.IO 默认路径 /socket.io，此处显式声明便于排查
  path: '/socket.io',
  // 降低免费实例闲置期间的资源占用
  pingInterval: 25000,
  pingTimeout: 20000,
});

// ---------------------------------------------------------------------------
// 内存状态
// ---------------------------------------------------------------------------
/**
 * rooms: Map<roomId, RoomState>
 * RoomState = {
 *   id, createdAt,
 *   players: Map<playerId, Player>,
 *   gameState: { ... 权威游戏状态，此处最小可玩为「位置同步 + 占位回合状态」 },
 *   tick: number,
 * }
 *
 * Player = {
 *   id, name, sessionToken,
 *   socketId, connected, disconnectedAt,
 *   x, y, color,        // 权威位置（demo：方块移动）
 *   lastInputAt,        // 输入频率限制
 *   lastSeen,           // 用于超时清理
 * }
 */
const rooms = new Map();
// playerId -> { roomId, sessionToken } 便于按 socket 反查
const playerIndex = new Map();

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}
function newId() {
  return crypto.randomBytes(8).toString('hex');
}

// 玩家默认颜色池（demo 用）
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#1abc9c', '#e67e22', '#ecf0f1'];

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      createdAt: Date.now(),
      players: new Map(),
      gameState: {
        // 最小可玩：权威状态仅含 tick 与玩家列表；后续可扩展卡牌逻辑
        phase: 'lobby',
      },
      tick: 0,
    });
    log(`房间创建: ${roomId}`);
  }
  return rooms.get(roomId);
}

// 生成给客户端看的房间快照（剥离内部字段）
function roomSnapshot(room) {
  const players = [];
  for (const p of room.players.values()) {
    players.push({
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      color: p.color,
      connected: p.connected,
    });
  }
  return {
    tick: room.tick,
    players,
    gameState: room.gameState,
  };
}

// ---------------------------------------------------------------------------
// 房间逻辑
// ---------------------------------------------------------------------------

/**
 * 加入房间。返回 { player, isReconnect }
 * 若携带 sessionToken 且能找到对应玩家（在重连宽限期内），则恢复；否则新建。
 */
function joinRoom(socket, { roomId, playerName, sessionToken }) {
  roomId = String(roomId || '').trim();
  playerName = String(playerName || '').trim().slice(0, 24);
  if (!roomId) throw new Error('缺少 roomId');
  if (!playerName) playerName = '无名氏';

  const room = getOrCreateRoom(roomId);
  if (room.players.size >= ROOM_MAX_PLAYERS) {
    // 允许重连玩家占位：若 token 对应的是本房间已有玩家，则放行
    const existing = sessionToken ? findPlayerByToken(room, sessionToken) : null;
    if (!existing) throw new Error('房间已满');
  }

  // 尝试重连恢复
  if (sessionToken) {
    const existing = findPlayerByToken(room, sessionToken);
    if (existing) {
      // 恢复：更新 socket 绑定、清除断线标记
      existing.socketId = socket.id;
      existing.connected = true;
      existing.disconnectedAt = null;
      existing.lastSeen = Date.now();
      playerIndex.set(existing.id, { roomId: room.id, sessionToken: existing.sessionToken });
      socket.join(room.id);
      socket.data.playerId = existing.id;
      socket.data.roomId = room.id;
      log(`玩家重连恢复: ${existing.name} (${existing.id}) 房间 ${room.id}`);
      return { player: existing, isReconnect: true, room };
    }
    log(`token 无效或已过期，按新玩家加入 (${playerName})`);
  }

  // 新建玩家
  const player = {
    id: newId(),
    name: playerName,
    sessionToken: newToken(),
    socketId: socket.id,
    connected: true,
    disconnectedAt: null,
    x: 20 + Math.random() * 60,   // demo 初始位置
    y: 20 + Math.random() * 60,
    color: COLORS[room.players.size % COLORS.length],
    lastInputAt: 0,
    lastSeen: Date.now(),
  };
  room.players.set(player.id, player);
  playerIndex.set(player.id, { roomId: room.id, sessionToken: player.sessionToken });
  socket.join(room.id);
  socket.data.playerId = player.id;
  socket.data.roomId = room.id;
  log(`玩家加入: ${player.name} (${player.id}) 房间 ${room.id}，当前 ${room.players.size} 人`);
  return { player, isReconnect: false, room };
}

function findPlayerByToken(room, sessionToken) {
  for (const p of room.players.values()) {
    if (p.sessionToken === sessionToken) return p;
  }
  return null;
}

// 离开房间 / 断开标记
function handleDisconnect(socket) {
  const playerId = socket.data.playerId;
  if (!playerId) return;
  const roomId = socket.data.roomId;
  const room = roomId ? rooms.get(roomId) : null;
  if (!room) return;
  const p = room.players.get(playerId);
  if (!p || p.socketId !== socket.id) return;

  p.connected = false;
  p.disconnectedAt = Date.now();
  log(`玩家断开: ${p.name} (${p.id}) 房间 ${roomId}（${PLAYER_RECONNECT_GRACE_MS / 1000}s 内可凭 token 重连）`);

  // 广播 player_left（保留状态，供重连；客户端可据此显示"已离线"）
  io.to(room.id).emit('player_left', { playerId: p.id, name: p.name });
}

// 真正移除玩家（超时未重连时调用）
function removePlayer(room, playerId) {
  const p = room.players.get(playerId);
  if (!p) return;
  room.players.delete(playerId);
  playerIndex.delete(playerId);
  io.to(room.id).emit('player_left', { playerId, name: p.name, permanent: true });
  log(`玩家永久移除: ${p.name} (${playerId}) 房间 ${room.id}`);
}

// ---------------------------------------------------------------------------
// Socket.IO 事件
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  log(`连接: ${socket.id}（来源 ${socket.handshake.address}）`);

  // 加入房间
  socket.on('join_room', (payload, ack) => {
    try {
      const { player, isReconnect, room } = joinRoom(socket, payload || {});
      // 回执：带 playerId + sessionToken + 房间快照
      if (typeof ack === 'function') {
        ack({
          ok: true,
          playerId: player.id,
          sessionToken: player.sessionToken,
          roomState: roomSnapshot(room),
          isReconnect,
        });
      }
      // 广播给房间内其他人
      if (!isReconnect) {
        socket.to(room.id).emit('player_joined', {
          player: {
            id: player.id, name: player.name, x: player.x, y: player.y, color: player.color, connected: true,
          },
        });
      } else {
        socket.to(room.id).emit('player_joined', {
          player: {
            id: player.id, name: player.name, x: player.x, y: player.y, color: player.color, connected: true,
          },
          reconnected: true,
        });
      }
      // 立即广播一次快照，让房间状态一致
      io.to(room.id).emit('state_snapshot', roomSnapshot(room));
    } catch (err) {
      log(`join_room 失败: ${err.message}`);
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
      else socket.emit('error', { message: err.message });
    }
  });

  // 输入（客户端只发操作，不直接改权威状态）
  socket.on('player_input', (payload) => {
    const playerId = socket.data.playerId;
    const roomId = socket.data.roomId;
    if (!playerId || !roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const p = room.players.get(playerId);
    if (!p) return;

    // 消息频率限制：每玩家每秒最多 INPUT_RATE_LIMIT 条
    const now = Date.now();
    if (now - p.lastInputAt < 1000 / INPUT_RATE_LIMIT) return; // 超频直接丢弃
    p.lastInputAt = now;
    p.lastSeen = now;

    // 解析输入：只接受受控字段，绝不信任客户端传来的绝对位置/分数
    const input = payload && payload.input;
    if (!input || typeof input !== 'object') return;

    // demo：方向移动（dx/dy 归一化 + 步长，由服务端累加权威位置）
    const dir = input.dir;
    if (dir && (typeof dir.dx === 'number' && typeof dir.dy === 'number')) {
      const len = Math.hypot(dir.dx, dir.dy) || 1;
      const STEP = input.step ? Math.min(Math.abs(Number(input.step)), 6) : 2.5;
      p.x = clamp(p.x + (dir.dx / len) * STEP, 0, 100);
      p.y = clamp(p.y + (dir.dy / len) * STEP, 0, 100);
    }

    // 占位：其它自定义操作（后续可扩展卡牌出牌等），仅记录，不影响权威状态
    if (input.action) {
      // 这里留给后续卡牌规则挂接；demo 阶段仅日志
      // log(`输入 action=${input.action} from ${p.name}`);
    }
  });

  // 心跳（客户端主动 ping，服务端回 pong）
  socket.on('ping', (ack) => {
    if (typeof ack === 'function') ack({ t: Date.now() });
  });

  socket.on('disconnect', (reason) => {
    log(`断开: ${socket.id} 原因 ${reason}`);
    handleDisconnect(socket);
  });
});

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

// ---------------------------------------------------------------------------
// 固定 tick 广播
// ---------------------------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    // 清理：断线超过宽限期仍未重连的玩家 → 永久移除
    for (const [pid, p] of room.players) {
      if (!p.connected && p.disconnectedAt && now - p.disconnectedAt > PLAYER_RECONNECT_GRACE_MS) {
        removePlayer(room, pid);
      }
    }
    // 空房间删除
    if (room.players.size === 0) {
      rooms.delete(roomId);
      log(`空房间清理: ${roomId}`);
      continue;
    }
    room.tick += 1;
    io.to(roomId).emit('state_snapshot', roomSnapshot(room));
  }
}, TICK_MS);

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
server.listen(PORT, HOST, () => {
  log(`服务已启动: http://${HOST}:${PORT}`);
  log(`健康检查: http://localhost:${PORT}/healthz`);
  log(`Socket.IO 路径: /socket.io`);
  log(`按需活跃：${CLEANUP_INTERVAL_MS / 1000}s 清理空房间/超时玩家`);
});

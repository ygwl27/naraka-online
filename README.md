# 永劫 · 振刀录 —— 多人联机服务端

基于 **Node.js + Express + Socket.IO** 的服务器权威联机后端，为《永劫·振刀录》卡牌游戏提供多人实时同步能力。

> 当前版本为**最小可玩 demo**：房间 + 玩家加入/离开 + 状态广播 + 移动同步，并完整实现了断线自动重连与 sessionToken 恢复。

---

## 一、架构说明

```
┌──────────────────────────────────────────────┐
│                  客户端（浏览器）              │
│   socket.io-client · 只发输入/操作            │
│   自动重连 · sessionToken 恢复 · 连接状态 UI    │
└───────────────┬──────────────────────────────┘
                │  WebSocket (/socket.io)
┌───────────────▼──────────────────────────────┐
│              服务端（Node.js + Socket.IO）     │
│   Express 托管静态文件 + 健康检查 /healthz      │
│   房间 Map<roomId, RoomState> · 内存状态       │
│   服务器权威：固定 tick 广播 state_snapshot     │
│   断线保留 120s · 消息频率限制 · 日志            │
└──────────────────────────────────────────────┘
```

**核心原则**
- **服务器权威**：客户端只发输入（`player_input`），位置/分数/战斗结果全部由服务端计算。**绝不信任客户端发来的绝对位置、分数、战斗结果。**
- **固定 tick**：服务端每 66ms（约 15Hz）向房间广播一次权威状态快照。
- **状态存内存**：免费单实例够用，Render 重启后房间丢失可接受（不引入数据库）。

---

## 二、消息协议

### client → server

| 事件 | 载荷 | 说明 |
|------|------|------|
| `join_room` | `{ roomId, playerName, sessionToken? }` | 加入/重连房间，带 token 则尝试恢复 |
| `player_input` | `{ roomId, input: { dir:{dx,dy}, step?, action? } }` | 输入操作（只发方向/操作，不发绝对位置） |
| `ping` | — | 心跳，服务端回 pong |

### server → client

| 事件 | 载荷 | 说明 |
|------|------|------|
| `joined` | `{ ok, playerId, sessionToken, roomState, isReconnect }` | 加入回执（ack 回调返回） |
| `player_joined` | `{ player, reconnected? }` | 有人加入/重连 |
| `player_left` | `{ playerId, name, permanent? }` | 有人断开（保留状态）或永久移除 |
| `state_snapshot` | `{ tick, players, gameState }` | 权威状态快照 |
| `error` | `{ message }` | 错误 |

---

## 三、本地运行

前置：Node.js 18+（本项目在 Node 22 上验证通过）。

```bash
cd naraka-online
npm install
npm start
```

启动后：
- 服务监听 `http://0.0.0.0:3000`（可用 `PORT` 环境变量覆盖）
- 健康检查：`http://localhost:3000/healthz` → `OK`
- 前端 demo：`http://localhost:3000/`

**本地联机测试**：开两个浏览器标签页访问 `http://localhost:3000`，用相同房间号、不同昵称加入，用方向键/WASD 移动方块，两个页面会实时同步。

开发热重载（可选）：

```bash
npm run dev
```

---

## 四、部署到 Render（免费层）

### 4.1 推送代码到 GitHub

```bash
git init
git add .
git commit -m "init: naraka online server"
git remote add origin https://github.com/<你的用户名>/naraka-online.git
git push -u origin main
```

### 4.2 Render 控制台创建 Web Service

1. 登录 [render.com](https://render.com) → **New +** → **Web Service**
2. 连接你的 GitHub 仓库，选择 `naraka-online`
3. 配置：

| 配置项 | 值 |
|--------|-----|
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | **Free** |
| Health Check Path | `/healthz` |

> **环境变量无需额外配置**：Render 会自动注入 `PORT`，服务端已监听 `process.env.PORT` 并绑定 `0.0.0.0`。

4. **不要绑定支付方式**。免费额度用完后服务会自动暂停，**不会自动扣费**。

### 4.3 验证

部署完成后访问：

```
https://你的服务.onrender.com/healthz    → 应返回 OK
https://你的服务.onrender.com/           → 打开联机 demo
```

---

## 五、「按需活跃」策略（两种模式）

Render 免费层规则：**15 分钟无流量即休眠**，下次访问自动唤醒，冷启动约 30–60 秒。

### 模式 A：真正按需，不保活（默认）

- 不配置任何定时保活。
- 朋友第一次连入时服务自动唤醒，客户端显示「服务器唤醒中，请稍候…」。
- **优点**：不联机时几乎不消耗实例小时。
- **缺点**：每次开场可能要等 30–60 秒。

> 本项目默认即模式 A，客户端已内置冷启动唤醒提示，无需额外操作。

### 模式 B：保活，减少等待

用 [cron-job.org](https://cron-job.org) 每 10 分钟 `GET` 一次：

```
https://你的服务.onrender.com/healthz
```

- 服务基本常驻，朋友连入不用等冷启动。
- **注意**：24 小时保活约消耗 **720 小时/月**，Render 免费实例额度约 **750 小时/月**，接近上限。
- 适合「经常联机」的阶段，不建议长期 24/7 保活。

### 如何切换

| 模式 | 操作 |
|------|------|
| A（默认，省额度） | 什么都不做 |
| B（常驻，少等待） | 在 cron-job.org 建一个每 10 分钟请求 `/healthz` 的任务 |
| 临时切换 | 需要联机前，先手动访问一次你的服务 URL 预热 |

---

## 六、断线重连机制

1. 每个玩家连接时服务端分配 `playerId` + `sessionToken`，客户端存入 `localStorage`。
2. 断线后，服务端**保留玩家状态 120 秒**（`PLAYER_RECONNECT_GRACE_MS`）。
3. 客户端开启自动重连（`reconnectionAttempts: Infinity`），重连成功后自动重新 `join_room` 并携带 `sessionToken`。
4. 服务端凭 token 恢复玩家身份和权威位置，广播 `player_joined`（`reconnected: true`）。

> 应对 Render 休眠、维护、实例替换导致的连接中断，客户端会无限次自动重连，直到服务恢复。

---

## 七、验收清单

- [x] 本地 `npm start` 能启动，`/healthz` 返回 200
- [x] 两个浏览器标签页能加入同一房间，互相看到对方加入/离开
- [x] 一个客户端移动，另一个客户端能看到状态变化
- [x] 手动断网/关标签页再重连，能凭 sessionToken 恢复
- [ ] Render 部署后公网可访问（需你部署后验证）
- [ ] 服务休眠后首次访问能自动唤醒，客户端有「唤醒中」提示
- [ ] 不绑定支付方式，确认免费实例
- [x] README 包含本地运行、Render 部署、保活开关说明

---

## 八、目录结构

```
naraka-online/
├── package.json          # 依赖 + start 脚本
├── README.md             # 本文档
├── src/
│   └── server.js         # 服务端入口（Express + Socket.IO + 房间/tick/重连逻辑）
└── public/
    └── index.html        # 前端 demo（socket.io-client + 自动重连 + 状态 UI）
```

## 九、从 demo 到正式游戏

当前 demo 用「移动方块」验证网络层。接入真实卡牌游戏时，建议：

1. **保留现有渲染**，只替换网络层（如用户已有 `index.html`，把 PeerJS 替换为 socket.io-client）。
2. 在 `player_input` 的 `input.action` 里扩展出牌/振刀/蓄力等操作，在服务端 `src/server.js` 的输入处理处实现权威卡牌规则。
3. 在 `state_snapshot.gameState` 里承载完整的对战状态（双方手牌、护甲、魂玉、回合等）。
4. 把 `rooms`/`RoomState` 从「位置同步」升级为「回合制对战状态机」。

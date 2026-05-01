"use strict";

const TAP_DEBUG = process.env.BLINKGRID_DEBUG === "1" || process.env.BLINKGRID_TAP_DEBUG === "1";

function tapDebug(label, data) {
  if (!TAP_DEBUG) return;
  console.debug(`[BlinkGrid:tap] ${label}`, data ?? "");
}

/** @param {unknown} tileId `"x,y"` from client */
function parseTileId(tileId) {
  const s = String(tileId ?? "").trim();
  const m = /^(\d+),(\d+)$/.exec(s);
  if (!m) return null;
  const xi = Number(m[1]);
  const yi = Number(m[2]);
  if (!Number.isInteger(xi) || !Number.isInteger(yi)) return null;
  return { xi, yi };
}

const PLAYER_COLORS = [
  { id: "blue", hex: "#3B82F6" },
  { id: "green", hex: "#22C55E" },
  { id: "pink", hex: "#EC4899" },
  { id: "yellow", hex: "#FACC15" },
  { id: "cyan", hex: "#06B6D4" },
  { id: "purple", hex: "#9333EA" },
];

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** @type {Map<string, object>} */
const rooms = new Map();

const MAX_PLAYERS = 6;
/** Brief warning before a blink becomes tappable (fairness / readability). */
const BLINK_TELEGRAPH_MS = 180;
const CLICK_THROTTLE_MS = 100;
const COMBO_WINDOW_MS = 500;
const COMBO_CAP = 6;
/** Display names + bot tuning (skill ~ tap chance, delays in ms). */
const BOT_PERSONALITIES = [
  { name: "Flash 🤖", skill: 0.26, delayLo: 110, delayHi: 340, greed: 0.85 },
  { name: "Lazy 🤖", skill: 0.11, delayLo: 420, delayHi: 920, greed: 0.35 },
  { name: "Sneak 🤖", skill: 0.18, delayLo: 200, delayHi: 520, greed: 0.95 },
  { name: "Zen 🤖", skill: 0.14, delayLo: 300, delayHi: 700, greed: 0.45 },
  { name: "Chaos 🤖", skill: 0.2, delayLo: 80, delayHi: 620, greed: 0.55 },
  { name: "Spark 🤖", skill: 0.17, delayLo: 160, delayHi: 480, greed: 0.7 },
];

/** Allowed board sizes (host picks in lobby). */
const GRID_SIZES = Object.freeze([5, 6, 7, 10, 16]);

/** Round length presets (ms): easy, medium, hard — host picks in lobby. */
const MATCH_DURATION_MS = Object.freeze([90_000, 60_000, 30_000]);
const DEFAULT_MATCH_DURATION_MS = 60_000;

function normalizeGridSize(n) {
  const x = Number(n);
  return GRID_SIZES.includes(x) ? x : 5;
}

function normalizeMatchDurationMs(n) {
  const x = Number(n);
  return MATCH_DURATION_MS.includes(x) ? x : DEFAULT_MATCH_DURATION_MS;
}

/** Strip risky chars and obvious slurs from display names (lightweight lobby moderation). */
function sanitizePlayerName(raw) {
  let s = String(raw ?? "Player")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 16);
  if (!s) s = "Player";
  const scrubbed = s.replace(
    /\b(f+u+c+k+|s+h+i+t+|c+u+n+t+|n+i+g+g+a+|n+i+g+g+e+r+|f+a+g+g+o+t+)\b/gi,
    "***",
  );
  return scrubbed.slice(0, 16) || "Player";
}

function randomRoomCode() {
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  if (rooms.has(code)) return randomRoomCode();
  return code;
}

function now() {
  return Date.now();
}

function pickGridSize(room) {
  return normalizeGridSize(room.gridSize);
}

function createEmptyCells(size) {
  const cells = [];
  for (let y = 0; y < size; y++) {
    const row = [];
    for (let x = 0; x < size; x++) row.push({ ownerId: null });
    cells.push(row);
  }
  return cells;
}

function broadcastRoom(room) {
  room.io.to(room.code).emit("room:update", serializeRoom(room));
}

function serializeRoom(room) {
  const humans = room.players.filter((p) => p.isBot !== true);
  return {
    code: room.code,
    phase: room.phase,
    gridSize: room.gridSize,
    matchDurationMs: normalizeMatchDurationMs(room.matchDurationMs),
    hostId: room.hostId,
    players: humans.map((p) => ({
      id: p.id,
      name: p.name,
      colorId: p.colorId,
      colorHex: p.colorHex,
      ready: p.ready,
      score: p.score,
      isHost: p.id === room.hostId,
      isBot: false,
    })),
  };
}

function serializeGame(room) {
  if (room.phase === "lobby") {
    return { phase: "lobby", serverNow: now() };
  }
  const size = pickGridSize(room);
  const blinks = [];
  for (const [, b] of room.activeBlinks) {
    if (b.expiresAt > now()) {
      const spawnedAt = Number(b.spawnedAt) || b.expiresAt;
      const activeFrom = Number.isFinite(Number(b.activeFrom)) ? Number(b.activeFrom) : spawnedAt;
      blinks.push({
        x: b.x,
        y: b.y,
        type: b.type,
        expiresAt: b.expiresAt,
        spawnedAt,
        activeFrom,
      });
    }
  }
  return {
    phase: room.phase,
    gridSize: size,
    gameEndTime: room.gameEndsAt,
    gameEndsAt: room.gameEndsAt,
    serverNow: now(),
    cells: room.cells,
    blinks,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      colorId: p.colorId,
      colorHex: p.colorHex,
      score: p.score,
      frozenUntil: Number(p.frozenUntil) || 0,
      isBot: !!p.isBot,
      combo: Math.max(1, p.combo || 1),
    })),
  };
}

function broadcastGame(room) {
  room.io.to(room.code).emit("game:update", serializeGame(room));
}

function clearRoomTimers(room) {
  if (room.spawnTimer) {
    clearTimeout(room.spawnTimer);
    room.spawnTimer = null;
  }
  if (room.tickTimer) {
    clearInterval(room.tickTimer);
    room.tickTimer = null;
  }
  if (room.pendingTimeouts?.length) {
    for (const tid of room.pendingTimeouts) clearTimeout(tid);
    room.pendingTimeouts = [];
  }
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function shuffleClaimedOwners(room) {
  const size = pickGridSize(room);
  if (!room.cells) return;
  const coords = [];
  const owners = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = room.cells[y]?.[x]?.ownerId;
      if (o) {
        coords.push({ x, y });
        owners.push(o);
      }
    }
  }
  if (owners.length < 2) return;
  shuffleInPlace(owners);
  for (let i = 0; i < coords.length; i++) {
    const { x, y } = coords[i];
    if (room.cells[y]?.[x]) room.cells[y][x].ownerId = owners[i];
  }
}

/** Remove other pending blinks within Manhattan distance ≤ 2 of (cx, cy). */
function magnetPull(room, cx, cy) {
  const toDelete = [];
  for (const [key, b] of room.activeBlinks) {
    if (b.x === cx && b.y === cy) continue;
    const d = Math.abs(b.x - cx) + Math.abs(b.y - cy);
    if (d <= 2) toDelete.push(key);
  }
  for (const k of toDelete) room.activeBlinks.delete(k);
}

function isTileClaimed(room, x, y) {
  const row = room.cells?.[y];
  const c = row?.[x];
  return !!(c && c.ownerId);
}

function isGridFullyClaimed(room) {
  if (room.phase !== "playing" || !room.cells) return false;
  const size = pickGridSize(room);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!room.cells[y]?.[x]?.ownerId) return false;
    }
  }
  return true;
}

function humansIn(room) {
  return room.players.filter((p) => p.isBot !== true);
}

function addSessionBots(room) {
  const real = humansIn(room).length;
  let nBots = 0;
  if (real >= 1 && real <= 4) {
    nBots = Math.max(0, MAX_PLAYERS - real);
  }
  const humanCount = real;
  for (let i = 0; i < nBots; i++) {
    const color = PLAYER_COLORS[(humanCount + i) % PLAYER_COLORS.length];
    const pers = BOT_PERSONALITIES[i % BOT_PERSONALITIES.length];
    const skill = Math.max(0.08, Math.min(0.32, pers.skill + (Math.random() - 0.5) * 0.06));
    const id = `bot_${i + 1}_${room.code}`;
    room.players.push({
      id,
      socketId: null,
      isBot: true,
      name: pers.name,
      colorId: color.id,
      colorHex: color.hex,
      ready: true,
      score: 0,
      frozenUntil: 0,
      skill,
      botDelayLo: pers.delayLo,
      botDelayHi: pers.delayHi,
      botGreed: pers.greed,
      combo: 1,
      lastComboAt: 0,
      lastClickAttemptAt: 0,
    });
  }
}

function removeBots(room) {
  room.players = room.players.filter((p) => p.isBot !== true);
}

function applyFreezeOthers(room, claimerId, t) {
  const until = t + 1000;
  for (const op of room.players) {
    if (op.id === claimerId) continue;
    const prev = Number(op.frozenUntil) || 0;
    op.frozenUntil = Math.max(prev, until);
    tapDebug("freeze_apply", { targetId: op.id, untilMs: op.frozenUntil, prevMs: prev });
  }
}

function tryProcessTap(room, player, xi, yi, _feedbackSocket) {
  const t = now();
  const size = pickGridSize(room);
  if (!Number.isInteger(xi) || !Number.isInteger(yi) || xi < 0 || yi < 0 || xi >= size || yi >= size) {
    tapDebug("reject_bounds", { xi, yi, size });
    return false;
  }
  const frozenUntil = Number(player.frozenUntil) || 0;
  if (frozenUntil > t) {
    tapDebug("reject_frozen", { playerId: player.id, frozenUntilMs: frozenUntil, nowMs: t });
    return false;
  }

  const key = `${xi},${yi}`;
  const blink = room.activeBlinks.get(key);
  if (!blink || blink.expiresAt <= t) {
    tapDebug("reject_blink", { key, hasBlink: !!blink, expiresAt: blink?.expiresAt, nowMs: t });
    return false;
  }
  const activeFrom = Number(blink.activeFrom);
  if (Number.isFinite(activeFrom) && t < activeFrom) {
    tapDebug("reject_telegraph", { key, activeFromMs: activeFrom, nowMs: t });
    return false;
  }
  if (t - (player.lastClickAttemptAt || 0) < CLICK_THROTTLE_MS) {
    tapDebug("reject_throttle", { playerId: player.id });
    return false;
  }
  player.lastClickAttemptAt = t;

  room.activeBlinks.delete(key);
  if (blink.type === "magnet") {
    magnetPull(room, xi, yi);
  }

  let delta = 1;
  if (blink.type === "double") delta = 2;
  else if (blink.type === "trap") delta = -1;
  else if (blink.type === "freeze") {
    applyFreezeOthers(room, player.id, t);
    delta = 0;
  }

  const kind = blink.type;
  let gained = 0;

  if (kind === "shuffle") {
    shuffleClaimedOwners(room);
    player.combo = 1;
    player.lastComboAt = 0;
    gained = 1;
    player.score += 1;
  } else if (kind === "streak") {
    if (t - (player.lastComboAt || 0) <= COMBO_WINDOW_MS) {
      player.combo = Math.min(COMBO_CAP, (player.combo || 1) + 2);
    } else {
      player.combo = Math.min(COMBO_CAP, 3);
    }
    player.lastComboAt = t;
    gained = 1 + (player.combo - 1);
    player.score += gained;
  } else if (delta > 0) {
    if (t - (player.lastComboAt || 0) <= COMBO_WINDOW_MS) {
      player.combo = Math.min(COMBO_CAP, (player.combo || 1) + 1);
    } else {
      player.combo = 1;
    }
    player.lastComboAt = t;
    gained = delta + (player.combo - 1);
    player.score += gained;
  } else {
    player.combo = 1;
    player.lastComboAt = 0;
    player.score += delta;
    gained = delta;
  }

  if (room.cells[yi] && room.cells[yi][xi]) {
    room.cells[yi][xi].ownerId = player.id;
  }

  tapDebug("tile_claimed", {
    tileId: key,
    playerId: player.id,
    x: xi,
    y: yi,
    gained,
    kind,
  });

  room.io.to(room.code).emit("tileClaimed", {
    tileId: key,
    playerId: player.id,
    x: xi,
    y: yi,
    colorHex: player.colorHex,
  });

  room.io.to(room.code).emit("game:tapFeedback", {
    x: xi,
    y: yi,
    gained,
    combo: player.combo || 1,
    delta,
    kind,
    playerId: player.id,
    playerName: player.name,
    colorHex: player.colorHex,
  });

  broadcastGame(room);
  if (isGridFullyClaimed(room)) {
    endGame(room, "grid_full");
  }
  return true;
}

function processBotTap(room, botId, x, y, expectedExpiresAt) {
  if (room.phase !== "playing") return;
  const bot = room.players.find((p) => p.id === botId);
  if (!bot || !bot.isBot) return;
  const t = now();
  if ((Number(bot.frozenUntil) || 0) > t) return;
  const blink = room.activeBlinks.get(`${x},${y}`);
  if (!blink || blink.expiresAt !== expectedExpiresAt) return;
  if (t >= blink.expiresAt) return;
  const af = Number(blink.activeFrom);
  if (Number.isFinite(af) && t < af) return;
  tryProcessTap(room, bot, x, y, null);
}

function scheduleBotTap(room, blink) {
  if (room.phase !== "playing" || !blink) return;
  const bots = room.players.filter((p) => p.isBot);
  const { x, y } = blink;
  const exp = blink.expiresAt;
  for (const bot of bots) {
    const attemptChance = bot.skill * (0.42 + Math.random() * 0.28);
    if (Math.random() > attemptChance) continue;
    const greed = bot.botGreed ?? 0.65;
    if (Math.random() < 0.22 * (1 - greed)) continue;
    const lo = bot.botDelayLo ?? 220;
    const hi = bot.botDelayHi ?? 820;
    const delay = lo + Math.floor(Math.random() * (hi - lo + 1));
    const tid = setTimeout(() => processBotTap(room, bot.id, x, y, exp), delay);
    room.pendingTimeouts.push(tid);
  }
}

/** @param {boolean} [rush] last-10s style: more specials */
function rollSpecialType(rush) {
  const r = Math.random();
  if (rush) {
    if (r < 0.14) return "double";
    if (r < 0.27) return "trap";
    if (r < 0.38) return "freeze";
    if (r < 0.41) return "streak";
    if (r < 0.44) return "shuffle";
    if (r < 0.47) return "magnet";
    return "normal";
  }
  if (r < 0.12) return "double";
  if (r < 0.22) return "trap";
  if (r < 0.3) return "freeze";
  if (r < 0.32) return "streak";
  if (r < 0.34) return "shuffle";
  if (r < 0.36) return "magnet";
  return "normal";
}

function spawnBlink(room) {
  if (room.phase !== "playing") return;
  const size = pickGridSize(room);
  const occupied = new Set(room.activeBlinks.keys());
  const available = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const key = `${x},${y}`;
      if (occupied.has(key)) continue;
      if (isTileClaimed(room, x, y)) continue;
      available.push({ x, y });
    }
  }
  if (available.length === 0) return;

  shuffleInPlace(available);
  const leftMs = room.gameEndsAt - now();
  const rush = leftMs <= 10000;
  let extra =
    (Math.random() < 0.35 ? 1 : 0) +
    (size >= 10 ? (Math.random() < 0.4 ? 1 : 0) : 0) +
    (size >= 16 ? (Math.random() < 0.35 ? 1 : 0) : 0);
  if (rush) extra += Math.random() < 0.55 ? 2 : 1;
  const count = Math.min(available.length, rush ? 5 : 4, 1 + extra);
  const toAdd = [];
  const tSpawn = now();
  const tele = BLINK_TELEGRAPH_MS;
  for (let i = 0; i < count; i++) {
    const { x, y } = available[i];
    const duration = 1000 + Math.floor(Math.random() * 1001);
    const type = rollSpecialType(rush);
    toAdd.push({
      x,
      y,
      type,
      activeFrom: tSpawn + tele,
      expiresAt: tSpawn + tele + duration,
      spawnedAt: tSpawn,
    });
  }

  for (const b of toAdd) {
    room.activeBlinks.set(`${b.x},${b.y}`, b);
  }
  if (toAdd.length) {
    broadcastGame(room);
    for (const b of toAdd) scheduleBotTap(room, b);
  }
}

function scheduleNextSpawn(room) {
  if (room.phase !== "playing") return;
  if (room.spawnTimer) clearTimeout(room.spawnTimer);
  const size = pickGridSize(room);
  const leftMs = room.gameEndsAt - now();
  const pace = Math.sqrt(size / 5);
  const started = Number(room.gameStartedAt) || now();
  const totalMs = Math.max(1, room.gameEndsAt - started);
  const elapsed = Math.max(0, now() - started);
  const progress = Math.min(1, elapsed / totalMs);
  const ramp = 0.4 + 0.6 * progress * progress;
  let lo = Math.round(340 / pace / ramp);
  let hi = Math.round(580 / pace / ramp);
  if (leftMs <= 10000) {
    lo = Math.round(120 / pace / ramp);
    hi = Math.round(260 / pace / ramp);
  }
  const wait = lo + Math.floor(Math.random() * (hi - lo + 1));
  room.spawnTimer = setTimeout(() => {
    room.spawnTimer = null;
    if (room.phase !== "playing") return;
    spawnBlink(room);
    scheduleNextSpawn(room);
  }, wait);
}

function endGame(room, reason) {
  if (room.phase !== "playing") return;
  clearRoomTimers(room);
  room.phase = "results";
  room.activeBlinks.clear();
  const ranking = [...room.players]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({
      rank: i + 1,
      id: p.id,
      name: p.name,
      score: p.score,
      colorHex: p.colorHex,
      isBot: !!p.isBot,
    }));
  for (const p of room.players) {
    if (!p.isBot) p.rematchVote = false;
  }
  room.io.to(room.code).emit("game:over", { ranking, reason });
  broadcastRoom(room);
  broadcastGame(room);
}

function startGameLoop(room) {
  clearRoomTimers(room);
  room.pendingTimeouts = [];
  removeBots(room);
  const size = pickGridSize(room);
  const duration = normalizeMatchDurationMs(room.matchDurationMs);
  room.gameEndsAt = now() + duration;
  room.gameStartedAt = now();
  room.phase = "playing";
  room.cells = createEmptyCells(pickGridSize(room));
  room.activeBlinks = new Map();

  addSessionBots(room);

  for (const p of room.players) {
    p.score = 0;
    p.frozenUntil = 0;
    p.combo = 1;
    p.lastComboAt = 0;
    p.lastClickAttemptAt = 0;
  }

  scheduleNextSpawn(room);

  room.tickTimer = setInterval(() => tickPlayingRoom(room), 120);
}

function tickPlayingRoom(room) {
  if (room.phase !== "playing") return;
  if (isGridFullyClaimed(room)) {
    endGame(room, "grid_full");
    return;
  }
  const t = now();
  if (t >= room.gameEndsAt) {
    endGame(room, "time");
    return;
  }
  let changed = false;
  for (const [key, b] of room.activeBlinks) {
    if (b.expiresAt <= t) {
      room.activeBlinks.delete(key);
      changed = true;
    }
  }
  for (const p of room.players) {
    const fu = Number(p.frozenUntil) || 0;
    if (fu > 0 && fu <= t) {
      tapDebug("freeze_expired", { playerId: p.id, wasMs: fu, nowMs: t });
      p.frozenUntil = 0;
      changed = true;
    }
  }
  if (changed) broadcastGame(room);
}

function findPlayer(room, socketId) {
  return room.players.find((p) => p.socketId === socketId && p.isBot !== true);
}

function leaveRoom(socket, io) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;
  const idx = room.players.findIndex((p) => p.socketId === socket.id && p.isBot !== true);
  if (idx === -1) return;
  const [removed] = room.players.splice(idx, 1);
  socket.leave(code);
  socket.data.roomCode = null;

  if (room.players.length === 0) {
    clearRoomTimers(room);
    rooms.delete(code);
    return;
  }

  if (removed.id === room.hostId) {
    const nextHuman = room.players.find((p) => p.isBot !== true);
    if (nextHuman) {
      room.hostId = nextHuman.id;
      nextHuman.ready = false;
    }
  }

  if (room.phase === "playing") {
    const humanCount = humansIn(room).length;
    if (humanCount < 1) {
      endGame(room, "player_left");
    } else {
      broadcastGame(room);
    }
  }

  broadcastRoom(room);
  room.io.to(code).emit("player:left", { playerId: removed.id });
}

function attachBlinkGridSockets(io) {
  io.on("connection", (socket) => {
    socket.data.roomCode = null;

    function handleHumanGameTap(xi, yi) {
      const code = socket.data.roomCode;
      const room = rooms.get(code);
      tapDebug("click_received", { socketId: socket.id, code, xi, yi, phase: room?.phase });
      if (!room || room.phase !== "playing") {
        tapDebug("validation_result", { ok: false, reason: "not_playing" });
        return;
      }
      const player = findPlayer(room, socket.id);
      if (!player || player.isBot) {
        tapDebug("validation_result", { ok: false, reason: "no_human_player" });
        return;
      }
      if (tryProcessTap(room, player, xi, yi, socket)) {
        tapDebug("validation_result", { ok: true, xi, yi });
        return;
      }

      const t = now();
      const size = pickGridSize(room);
      if (!Number.isInteger(xi) || !Number.isInteger(yi) || xi < 0 || yi < 0 || xi >= size || yi >= size) {
        tapDebug("validation_result", { ok: false, reason: "out_of_bounds", xi, yi, size });
        return;
      }
      const frozenMs = Number(player.frozenUntil) || 0;
      if (frozenMs > t) {
        tapDebug("validation_result", {
          ok: false,
          reason: "player_frozen",
          frozenUntilMs: frozenMs,
          nowMs: t,
        });
        return;
      }
      const key = `${xi},${yi}`;
      const blink = room.activeBlinks.get(key);
      if (blink && blink.expiresAt > t) {
        const af = Number(blink.activeFrom);
        const reason =
          Number.isFinite(af) && t < af ? "blink_telegraph_wait" : "blink_active_try_failed";
        tapDebug("validation_result", { ok: false, reason, key });
        return;
      }
      if (t - (player.lastClickAttemptAt || 0) < CLICK_THROTTLE_MS) {
        tapDebug("validation_result", { ok: false, reason: "miss_throttled", playerId: player.id });
        return;
      }
      player.lastClickAttemptAt = t;
      player.combo = 1;
      player.lastComboAt = 0;
      tapDebug("tap_miss", { xi, yi, playerId: player.id });
      socket.emit("game:miss", { x: xi, y: yi });
    }

    socket.on("room:create", ({ name, gridSize, matchDurationMs }, ack) => {
      const trimmed = sanitizePlayerName(name);
      const code = randomRoomCode();
      const playerId = socket.id;
      const color = PLAYER_COLORS[0];
      const room = {
        code,
        io,
        phase: "lobby",
        gridSize: normalizeGridSize(gridSize),
        matchDurationMs: normalizeMatchDurationMs(matchDurationMs),
        hostId: playerId,
        players: [
          {
            id: playerId,
            socketId: socket.id,
            name: trimmed,
            colorId: color.id,
            colorHex: color.hex,
            ready: false,
            score: 0,
            frozenUntil: 0,
            isBot: false,
            combo: 1,
            lastComboAt: 0,
            lastClickAttemptAt: 0,
            rematchVote: false,
          },
        ],
        cells: null,
        activeBlinks: new Map(),
        gameEndsAt: 0,
        spawnTimer: null,
        tickTimer: null,
        pendingTimeouts: [],
      };
      rooms.set(code, room);
      socket.join(code);
      socket.data.roomCode = code;
      if (typeof ack === "function") {
        ack({ ok: true, yourId: socket.id, room: serializeRoom(room) });
      }
      broadcastRoom(room);
    });

    socket.on("room:join", ({ code, name }, ack) => {
      const c = String(code || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 5);
      const room = rooms.get(c);
      if (!room) {
        if (typeof ack === "function") ack({ ok: false, error: "Room not found" });
        return;
      }
      if (room.players.length >= MAX_PLAYERS) {
        if (typeof ack === "function") ack({ ok: false, error: "Room is full" });
        return;
      }
      if (room.phase === "playing") {
        if (typeof ack === "function") ack({ ok: false, error: "Game already in progress" });
        return;
      }
      const trimmed = sanitizePlayerName(name);
      const playerId = socket.id;
      const color = PLAYER_COLORS[humansIn(room).length % PLAYER_COLORS.length];
      room.players.push({
        id: playerId,
        socketId: socket.id,
        name: trimmed,
        colorId: color.id,
        colorHex: color.hex,
        ready: false,
        score: 0,
        frozenUntil: 0,
        isBot: false,
        combo: 1,
        lastComboAt: 0,
        lastClickAttemptAt: 0,
        rematchVote: false,
      });
      socket.join(c);
      socket.data.roomCode = c;
      if (typeof ack === "function") {
        ack({ ok: true, yourId: socket.id, room: serializeRoom(room) });
      }
      broadcastRoom(room);
    });

    socket.on("room:ready", ({ ready }) => {
      const code = socket.data.roomCode;
      const room = rooms.get(code);
      if (!room || room.phase !== "lobby") return;
      const p = findPlayer(room, socket.id);
      if (!p) return;
      p.ready = !!ready;
      broadcastRoom(room);
    });

    socket.on("room:setGrid", ({ gridSize }, ack) => {
      const code = socket.data.roomCode;
      const room = rooms.get(code);
      if (!room || room.phase !== "lobby") {
        if (typeof ack === "function") ack({ ok: false, error: "Not in lobby" });
        return;
      }
      const p = findPlayer(room, socket.id);
      const allowed = room.hostId === socket.id || (p && p.id === room.hostId);
      if (!allowed) {
        if (typeof ack === "function") ack({ ok: false, error: "Only the host can change the grid" });
        return;
      }
      room.gridSize = normalizeGridSize(gridSize);
      broadcastRoom(room);
      if (typeof ack === "function") ack({ ok: true, gridSize: room.gridSize });
    });

    socket.on("room:setMatchDuration", ({ matchDurationMs }, ack) => {
      const code = socket.data.roomCode;
      const room = rooms.get(code);
      if (!room || room.phase !== "lobby") {
        if (typeof ack === "function") ack({ ok: false, error: "Not in lobby" });
        return;
      }
      const p = findPlayer(room, socket.id);
      const allowed = room.hostId === socket.id || (p && p.id === room.hostId);
      if (!allowed) {
        if (typeof ack === "function") ack({ ok: false, error: "Only the host can change round time" });
        return;
      }
      room.matchDurationMs = normalizeMatchDurationMs(matchDurationMs);
      broadcastRoom(room);
      if (typeof ack === "function") ack({ ok: true, matchDurationMs: room.matchDurationMs });
    });

    socket.on("game:start", () => {
      const code = socket.data.roomCode;
      const room = rooms.get(code);
      tapDebug("game_start_recv", { code, hasRoom: !!room, phase: room?.phase, socketId: socket.id });
      if (!room || room.phase !== "lobby") {
        tapDebug("game_start_abort", {
          reason: !room ? "no_room" : "phase_not_lobby",
          phase: room?.phase,
        });
        return;
      }
      const starter = findPlayer(room, socket.id);
      if (!starter || starter.id !== room.hostId) {
        tapDebug("game_start_abort", {
          reason: !starter ? "find_player_failed" : "not_host",
          hostId: room.hostId,
          starterId: starter?.id,
        });
        return;
      }
      const hs = humansIn(room);
      if (hs.length < 1) {
        tapDebug("game_start_abort", { reason: "no_humans" });
        return;
      }
      if (!hs.every((p) => p.ready)) {
        tapDebug("game_start_abort", {
          reason: "not_all_ready",
          readiness: hs.map((p) => ({ id: p.id, ready: p.ready })),
        });
        return;
      }
      tapDebug("game_start_ok", { code: room.code });
      startGameLoop(room);
      broadcastRoom(room);
      broadcastGame(room);
    });

    socket.on("game:tap", ({ x, y }) => {
      handleHumanGameTap(Number(x), Number(y));
    });

    socket.on("tileClick", ({ tileId }) => {
      tapDebug("tileClick_received", { tileId, socketId: socket.id });
      const pos = parseTileId(tileId);
      tapDebug("tileClick_parsed", { tileId, pos });
      if (!pos) {
        tapDebug("validation_result", { ok: false, reason: "bad_tileId", tileId });
        return;
      }
      handleHumanGameTap(pos.xi, pos.yi);
    });

    socket.on("room:rematchVote", () => {
      const code = socket.data.roomCode;
      const room = rooms.get(code);
      if (!room || room.phase !== "results") return;
      const p = findPlayer(room, socket.id);
      if (!p) return;
      p.rematchVote = true;
      const hs = humansIn(room);
      if (hs.length < 1) return;
      const votes = hs.filter((h) => h.rematchVote).length;
      const need = Math.ceil(hs.length / 2);
      if (votes >= need) {
        for (const h of hs) h.rematchVote = false;
        startGameLoop(room);
        broadcastRoom(room);
        broadcastGame(room);
      } else {
        room.io.to(room.code).emit("rematch:votes", { votes, need });
      }
    });

    socket.on("room:backToLobby", () => {
      const code = socket.data.roomCode;
      const room = rooms.get(code);
      if (!room) return;
      if (room.phase !== "results") return;
      clearRoomTimers(room);
      removeBots(room);
      room.phase = "lobby";
      room.cells = null;
      room.activeBlinks = new Map();
      room.gameEndsAt = 0;
      for (const p of room.players) {
        p.ready = false;
        p.score = 0;
        p.frozenUntil = 0;
        p.combo = 1;
        p.lastComboAt = 0;
        p.lastClickAttemptAt = 0;
        p.rematchVote = false;
      }
      broadcastRoom(room);
      broadcastGame(room);
    });

    socket.on("room:leave", () => {
      leaveRoom(socket, io);
    });

    socket.on("disconnect", () => {
      leaveRoom(socket, io);
    });
  });
}

function getRooms() {
  return rooms;
}

function clearAllRoomsForTests() {
  for (const room of rooms.values()) {
    clearRoomTimers(room);
  }
  rooms.clear();
}

module.exports = {
  attachBlinkGridSockets,
  getRooms,
  clearAllRoomsForTests,
  /** @internal test / tooling hooks */
  _test: {
    rollSpecialType,
    tryProcessTap,
    spawnBlink,
    scheduleBotTap,
    processBotTap,
    startGameLoop,
    endGame,
    addSessionBots,
    removeBots,
    createEmptyCells,
    pickGridSize,
    normalizeGridSize,
    normalizeMatchDurationMs,
    MATCH_DURATION_MS,
    DEFAULT_MATCH_DURATION_MS,
    GRID_SIZES,
    CLICK_THROTTLE_MS,
    MAX_PLAYERS,
    serializeGame,
    broadcastGame,
    broadcastRoom,
    parseTileId,
    tickPlayingRoom,
  },
};

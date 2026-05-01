"use strict";

/**
 * BlinkGrid Socket.io load test
 *
 * Uses the real server protocol (tileClick + room lifecycle).
 * Max 6 humans per room — clients are spread across ceil(N/6) rooms.
 *
 * Usage:
 *   1. npm start   (or: node server.js)
 *   2. node loadTest.js
 *
 * Env:
 *   SERVER_URL         default http://localhost:3000
 *   TOTAL_CLIENTS      default 100
 *   PLAYERS_PER_ROOM   default 6 (max per BlinkGrid room)
 *   TAP_MIN_MS         default 200
 *   TAP_MAX_MS         default 1000
 *   STAGGER_MS         delay between starting each room (default 50)
 *   RUN_MS             how long to run before exit (default 0 = until Ctrl+C)
 *   STATS_INTERVAL_MS  default 10000
 */

const { io } = require("socket.io-client");

const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";
const TOTAL_CLIENTS = Math.max(1, parseInt(process.env.TOTAL_CLIENTS || "100", 10));
const PLAYERS_PER_ROOM = Math.min(6, Math.max(1, parseInt(process.env.PLAYERS_PER_ROOM || "6", 10)));
const TAP_MIN_MS = parseInt(process.env.TAP_MIN_MS || "200", 10);
const TAP_MAX_MS = parseInt(process.env.TAP_MAX_MS || "1000", 10);
const STAGGER_MS = parseInt(process.env.STAGGER_MS || "50", 10);
const RUN_MS = parseInt(process.env.RUN_MS || "0", 10);
const STATS_INTERVAL_MS = parseInt(process.env.STATS_INTERVAL_MS || "10000", 10);
const GRID = 5;

const stats = {
  roomsStarted: 0,
  roomsFailed: 0,
  socketsConnected: 0,
  connectErrors: 0,
  unexpectedDisconnects: 0,
  tapsSent: 0,
  tapFeedbacks: 0,
  gameUpdatesSampled: 0,
  latenciesMs: [],
};

let shuttingDown = false;

const MAX_LATENCY_SAMPLES = 5000;

function pushLatency(ms) {
  stats.latenciesMs.push(ms);
  if (stats.latenciesMs.length > MAX_LATENCY_SAMPLES) {
    stats.latenciesMs.splice(0, stats.latenciesMs.length - MAX_LATENCY_SAMPLES);
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)));
  return sorted[idx];
}

function summarizeLatencies() {
  const s = [...stats.latenciesMs].sort((a, b) => a - b);
  if (!s.length) return { count: 0 };
  return {
    count: s.length,
    min: s[0],
    p50: percentile(s, 0.5),
    p95: percentile(s, 0.95),
    max: s[s.length - 1],
  };
}

function connectSocket(index) {
  return new Promise((resolve, reject) => {
    const socket = io(SERVER_URL, {
      transports: ["websocket", "polling"],
      reconnection: false,
      forceNew: true,
    });
    const to = setTimeout(() => {
      socket.close();
      reject(new Error(`connect timeout client #${index}`));
    }, 20000);
    socket.once("connect", () => {
      clearTimeout(to);
      stats.socketsConnected += 1;
      resolve(socket);
    });
    socket.once("connect_error", (err) => {
      clearTimeout(to);
      stats.connectErrors += 1;
      reject(err);
    });
    socket.on("disconnect", () => {
      if (!shuttingDown) stats.unexpectedDisconnects += 1;
    });
  });
}

function createRoom(socket, name) {
  return new Promise((resolve, reject) => {
    socket.emit("room:create", { name, gridSize: GRID }, (ack) => {
      if (!ack?.ok) reject(new Error(ack?.error || "room:create failed"));
      else resolve(ack.room.code);
    });
  });
}

function joinRoom(socket, code, name) {
  return new Promise((resolve, reject) => {
    socket.emit("room:join", { code, name }, (ack) => {
      if (!ack?.ok) reject(new Error(ack?.error || "room:join failed"));
      else resolve();
    });
  });
}

async function setAllReady(sockets) {
  for (const s of sockets) {
    s.emit("room:ready", { ready: true });
    await new Promise((r) => setTimeout(r, 5));
  }
}

function waitForPlaying(hostSocket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("game did not reach playing phase")), timeoutMs);
    function onGame(payload) {
      if (payload?.phase === "playing") {
        clearTimeout(t);
        hostSocket.off("game:update", onGame);
        resolve();
      }
    }
    hostSocket.on("game:update", onGame);
  });
}

async function setupRoom(roomIndex, baseClientIndex, count) {
  const sockets = [];
  for (let k = 0; k < count; k += 1) {
    sockets.push(await connectSocket(baseClientIndex + k));
  }

  const host = sockets[0];
  const code = await createRoom(host, `LoadHost_${baseClientIndex}`);

  for (let k = 1; k < count; k += 1) {
    await joinRoom(sockets[k], code, `LoadJoin_${baseClientIndex + k}`);
  }

  await setAllReady(sockets);
  await new Promise((r) => setTimeout(r, 40));
  host.emit("game:start");
  await waitForPlaying(host, 15000);

  const intervals = [];
  const feedbackGuards = [];

  host.on("game:update", () => {
    stats.gameUpdatesSampled += 1;
  });

  for (const s of sockets) {
    const tick = () => {
      const x = Math.floor(Math.random() * GRID);
      const y = Math.floor(Math.random() * GRID);
      stats.tapsSent += 1;
      const sent = Date.now();
      const onFeedback = () => {
        stats.tapFeedbacks += 1;
        pushLatency(Date.now() - sent);
      };
      s.once("game:tapFeedback", onFeedback);
      const tid = setTimeout(() => {
        s.off("game:tapFeedback", onFeedback);
      }, 3000);
      feedbackGuards.push(tid);

      s.emit("tileClick", { tileId: `${x},${y}` });
    };

    const intervalMs = () => TAP_MIN_MS + Math.random() * Math.max(0, TAP_MAX_MS - TAP_MIN_MS);
    const scheduleNext = () => {
      const id = setTimeout(() => {
        tick();
        scheduleNext();
      }, intervalMs());
      intervals.push(id);
    };
    scheduleNext();
  }

  return { sockets, intervals, feedbackGuards, code };
}

async function main() {
  console.log(`BlinkGrid load test → ${SERVER_URL}`);
  console.log(
    `Clients: ${TOTAL_CLIENTS}, up to ${PLAYERS_PER_ROOM} per room → ${Math.ceil(TOTAL_CLIENTS / PLAYERS_PER_ROOM)} rooms\n`,
  );

  const numRooms = Math.ceil(TOTAL_CLIENTS / PLAYERS_PER_ROOM);
  const roomResults = [];

  for (let r = 0; r < numRooms; r += 1) {
    const base = r * PLAYERS_PER_ROOM;
    const count = Math.min(PLAYERS_PER_ROOM, TOTAL_CLIENTS - base);
    await new Promise((res) => setTimeout(res, r * STAGGER_MS));
    try {
      const ctx = await setupRoom(r, base, count);
      roomResults.push(ctx);
      stats.roomsStarted += 1;
      console.log(`Room ${r + 1}/${numRooms} playing (${count} humans, code ${ctx.code})`);
    } catch (e) {
      stats.roomsFailed += 1;
      console.error(`Room ${r + 1} failed:`, e.message || e);
    }
  }

  const printStats = () => {
    const lat = summarizeLatencies();
    console.log(
      "\n--- stats ---\n" +
        JSON.stringify(
          {
            roomsStarted: stats.roomsStarted,
            roomsFailed: stats.roomsFailed,
            socketsConnected: stats.socketsConnected,
            connectErrors: stats.connectErrors,
            unexpectedDisconnects: stats.unexpectedDisconnects,
            tapsSent: stats.tapsSent,
            tapFeedbacks: stats.tapFeedbacks,
            tapHitRate:
              stats.tapsSent > 0 ? (stats.tapFeedbacks / stats.tapsSent).toFixed(3) : null,
            gameUpdatesSampled_hostOnly: stats.gameUpdatesSampled,
            latencyMs_tapToTapFeedback: lat,
          },
          null,
          2,
        ),
    );
  };

  const statsTimer = setInterval(printStats, STATS_INTERVAL_MS);

  const shutdown = (label) => {
    shuttingDown = true;
    clearInterval(statsTimer);
    for (const room of roomResults) {
      for (const id of room.intervals) clearTimeout(id);
      for (const tid of room.feedbackGuards || []) clearTimeout(tid);
      for (const s of room.sockets) {
        try {
          s.removeAllListeners();
          s.disconnect();
        } catch {
          /* ignore */
        }
      }
    }
    printStats();
    console.log(`\nStopped (${label}).`);
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  if (RUN_MS > 0) {
    setTimeout(() => shutdown(`RUN_MS=${RUN_MS}`), RUN_MS);
  }

  printStats();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

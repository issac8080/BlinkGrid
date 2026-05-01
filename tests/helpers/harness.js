"use strict";

const http = require("http");
const { Server } = require("socket.io");
const { io: ioc } = require("socket.io-client");
const {
  attachBlinkGridSockets,
  clearAllRoomsForTests,
  getRooms,
} = require("../../lib/blinkGridServer");

/**
 * Starts a real HTTP + Socket.io server on an ephemeral port for integration tests.
 */
function startTestServer() {
  clearAllRoomsForTests();
  const httpServer = http.createServer();
  const io = new Server(httpServer, { cors: { origin: "*" } });
  attachBlinkGridSockets(io);
  return new Promise((resolve, reject) => {
    httpServer.listen(0, (err) => {
      if (err) {
        reject(err);
        return;
      }
      const port = httpServer.address().port;
      resolve({
        port,
        httpServer,
        io,
        getRooms,
        async close() {
          io.close();
          await new Promise((r) => httpServer.close(() => r()));
          clearAllRoomsForTests();
        },
      });
    });
  });
}

function connectClient(port, opts = {}) {
  const socket = ioc(`http://127.0.0.1:${port}`, {
    transports: ["websocket", "polling"],
    forceNew: true,
    ...opts,
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("socket connect timeout")), 5000);
    socket.once("connect", () => {
      clearTimeout(t);
      resolve(socket);
    });
    socket.once("connect_error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

/**
 * Creates a room as host; returns host socket and room snapshot from ack.
 */
async function createTestRoom(harness, { name = "Host", gridSize = 5 } = {}) {
  const socket = await connectClient(harness.port);
  const room = await new Promise((resolve, reject) => {
    socket.emit("room:create", { name, gridSize }, (ack) => {
      if (!ack?.ok) reject(new Error(ack?.error || "room:create failed"));
      else resolve(ack.room);
    });
  });
  return { socket, room, code: room.code };
}

/**
 * Joins an existing room with human players (each gets a new socket).
 */
async function addTestPlayers(harness, code, names) {
  const sockets = [];
  for (const name of names) {
    const socket = await connectClient(harness.port);
    await new Promise((resolve, reject) => {
      socket.emit("room:join", { code, name }, (ack) => {
        if (!ack?.ok) reject(new Error(ack?.error || "room:join failed"));
        else resolve();
      });
    });
    sockets.push(socket);
  }
  return sockets;
}

/**
 * Marks each connected client as ready (emit once per human socket in lobby order).
 */
async function setPlayersReady(sockets, ready = true) {
  for (const s of sockets) {
    s.emit("room:ready", { ready });
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Emits a tile tap from the given connected client.
 */
function simulateTileClick(socket, x, y) {
  socket.emit("tileClick", { tileId: `${x},${y}` });
}

/**
 * Polls in-memory room state until the server reaches the expected phase.
 */
async function pollRoomPhase(harness, code, phase, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = harness.getRooms().get(code);
    if (r?.phase === phase) return r;
    await new Promise((res) => setTimeout(res, 5));
  }
  const r = harness.getRooms().get(code);
  throw new Error(`Expected phase ${phase}, got ${r?.phase ?? "no room"}`);
}

/**
 * Marks everyone ready, starts the match, then optionally stops auto spawn/tick/bot timers
 * (default: stop — use keepGameTimers: true for load/simulation that needs the real loop).
 */
async function startPlayingMatch(harness, hostSocket, code, otherSockets = [], opts = {}) {
  const keepGameTimers = !!opts.keepGameTimers;
  await setPlayersReady([hostSocket, ...otherSockets], true);
  await new Promise((r) => setTimeout(r, 50));
  hostSocket.emit("game:start");
  await pollRoomPhase(harness, code, "playing");
  if (keepGameTimers) return;
  const room = harness.getRooms().get(code);
  if (room?.spawnTimer) {
    clearTimeout(room.spawnTimer);
    room.spawnTimer = null;
  }
  if (room?.pendingTimeouts?.length) {
    for (const tid of room.pendingTimeouts) clearTimeout(tid);
    room.pendingTimeouts = [];
  }
  if (room?.tickTimer) {
    clearInterval(room.tickTimer);
    room.tickTimer = null;
  }
}

/**
 * Waits until the socket receives the next game:update matching an optional predicate.
 */
function waitForGameUpdate(socket, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.off("game:update", onUpd);
      reject(new Error("waitForGameUpdate timeout"));
    }, timeoutMs);
    function onUpd(payload) {
      try {
        if (!predicate || predicate(payload)) {
          clearTimeout(t);
          socket.off("game:update", onUpd);
          resolve(payload);
        }
      } catch (e) {
        clearTimeout(t);
        socket.off("game:update", onUpd);
        reject(e);
      }
    }
    socket.on("game:update", onUpd);
  });
}

/**
 * Waits for a single socket.io event (optionally matching a predicate).
 */
function waitForSocketEvent(socket, event, { timeoutMs = 4000, predicate } = {}) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.off(event, onEvt);
      reject(new Error(`waitForSocketEvent:${event} timeout`));
    }, timeoutMs);
    function onEvt(payload) {
      try {
        if (!predicate || predicate(payload)) {
          clearTimeout(t);
          socket.off(event, onEvt);
          resolve(payload);
        }
      } catch (e) {
        clearTimeout(t);
        socket.off(event, onEvt);
        reject(e);
      }
    }
    socket.on(event, onEvt);
  });
}

module.exports = {
  startTestServer,
  connectClient,
  createTestRoom,
  addTestPlayers,
  setPlayersReady,
  simulateTileClick,
  waitForGameUpdate,
  waitForSocketEvent,
  pollRoomPhase,
  startPlayingMatch,
};

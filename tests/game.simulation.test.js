"use strict";

/**
 * Simulation-based QA: compresses a full match timeline with Jest fake timers
 * plus real Socket.io bootstraps for 1 / 3 / 6 human scenarios.
 *
 * Semantic `[SIM]` logs:
 *   Local default: on (set SIM_LOG=0 to silence).
 *   In CI: off unless SIM_LOG=1.
 */

const { createHumanPlayer } = require("./helpers/mockRoom");
const {
  startTestServer,
  createTestRoom,
  addTestPlayers,
  simulateTileClick,
  startPlayingMatch,
} = require("./helpers/harness");
const { _test } = require("../lib/blinkGridServer");

const {
  startGameLoop,
  tryProcessTap,
  tickPlayingRoom,
  processBotTap,
  scheduleBotTap,
  createEmptyCells,
  CLICK_THROTTLE_MS,
  MAX_PLAYERS,
} = _test;

const SIM_LOG = (() => {
  if (process.env.SIM_LOG === "1") return true;
  if (process.env.SIM_LOG === "0") return false;
  return !process.env.CI;
})();

/** Fixed epoch for fake timers so gameEndsAt math is stable. */
const SIM_T0 = 10_000_000;

/** Deterministic PRNG stream for spawn pacing / tile rolls (do not use for crypto). */
const PRECOMP_R = (() => {
  const a = [];
  let x = 0.12345;
  for (let i = 0; i < 14000; i += 1) {
    x = (x * 9301 + 49297) % 233280;
    a.push(x / 233280);
  }
  return a;
})();
let precompIndex = 0;

function simPrint(label, detail) {
  if (!SIM_LOG) return;
  const msg = detail !== undefined ? `[SIM] ${label} ${JSON.stringify(detail)}` : `[SIM] ${label}`;
  console.log(msg);
}

/**
 * Wraps room.io broadcasts and emits semantic QA events by diffing successive game:update payloads.
 */
function createSemanticIo() {
  const semanticLog = [];
  let primed = false;
  let prevBlink = new Set();
  let prevScores = {};
  let prevFrozen = {};

  function logSemantic(name, detail) {
    semanticLog.push({ name, detail, at: Date.now() });
    simPrint(name, detail);
  }

  const io = {
    to() {
      return {
        emit(event, payload) {
          if (event === "game:update" && payload.phase === "playing") {
            const blinkKeys = new Set((payload.blinks || []).map((b) => `${b.x},${b.y}`));
            if (primed) {
              for (const k of blinkKeys) {
                if (!prevBlink.has(k)) {
                  const b = payload.blinks.find((bl) => `${bl.x},${bl.y}` === k);
                  logSemantic("tileActivated", { x: b.x, y: b.y, type: b.type, expiresAt: b.expiresAt });
                }
              }
              for (const k of prevBlink) {
                if (!blinkKeys.has(k)) {
                  const [xs, ys] = k.split(",").map(Number);
                  const cell = payload.cells?.[ys]?.[xs];
                  const owner = cell?.ownerId;
                  if (owner) logSemantic("tileClaimed", { x: xs, y: ys, ownerId: owner });
                  else logSemantic("tileExpired", { x: xs, y: ys });
                }
              }
              for (const p of payload.players || []) {
                if (prevScores[p.id] !== undefined && p.score !== prevScores[p.id]) {
                  logSemantic("scoreUpdated", {
                    playerId: p.id,
                    score: p.score,
                    prev: prevScores[p.id],
                  });
                }
                const pf = prevFrozen[p.id] ?? 0;
                if (p.frozenUntil > pf) {
                  logSemantic("playerFrozen", { playerId: p.id, frozenUntil: p.frozenUntil });
                }
              }
            }
            primed = true;
            prevBlink = blinkKeys;
            prevScores = Object.fromEntries((payload.players || []).map((p) => [p.id, p.score]));
            prevFrozen = Object.fromEntries((payload.players || []).map((p) => [p.id, p.frozenUntil || 0]));
          }
          if (event === "game:over") {
            logSemantic("gameOver", { reason: payload.reason, ranking: payload.ranking });
          }
          if (event === "game:tapFeedback") {
            logSemantic("tapFeedback", payload);
          }
        },
      };
    },
  };

  return { io, getSemanticLog: () => semanticLog };
}

function clearBotTapTimers(room) {
  if (room.pendingTimeouts?.length) {
    for (const tid of room.pendingTimeouts) clearTimeout(tid);
    room.pendingTimeouts = [];
  }
}

function assertUniqueActiveBlinks(room) {
  const keys = [...room.activeBlinks.keys()];
  expect(new Set(keys).size).toBe(keys.length);
}

function buildHumans(n) {
  return Array.from({ length: n }, (_, i) =>
    createHumanPlayer({
      id: `sim_h${i}`,
      socketId: `sim_sock_${i}`,
      name: `Sim${i}`,
    }),
  );
}

function advanceMs(ms) {
  jest.advanceTimersByTime(ms);
}

describe("BlinkGrid simulation QA", () => {
  describe("Socket bootstrap — real clients (1 / 3 / 6 humans)", () => {
    let harness;
    beforeEach(async () => {
      harness = await startTestServer();
    });
    afterEach(async () => {
      if (harness) await harness.close();
    });

    test("1 human: room starts, bots fill to six seats", async () => {
      const { socket: host, code } = await createTestRoom(harness, { name: "Solo", gridSize: 5 });
      await startPlayingMatch(harness, host, code, []);
      const room = harness.getRooms().get(code);
      expect(room.players.filter((p) => !p.isBot)).toHaveLength(1);
      expect(room.players.filter((p) => p.isBot)).toHaveLength(5);
      expect(room.players).toHaveLength(MAX_PLAYERS);
      host.disconnect();
    });

    test("3 humans: three players plus three bots", async () => {
      const { socket: host, code } = await createTestRoom(harness);
      const others = await addTestPlayers(harness, code, ["A", "B"]);
      await startPlayingMatch(harness, host, code, others);
      const room = harness.getRooms().get(code);
      expect(room.players.filter((p) => !p.isBot)).toHaveLength(3);
      expect(room.players.filter((p) => p.isBot)).toHaveLength(3);
      host.disconnect();
      others.forEach((s) => s.disconnect());
    });

    test("6 humans: full lobby, no bots", async () => {
      const { socket: host, code } = await createTestRoom(harness);
      const five = await addTestPlayers(harness, code, ["P1", "P2", "P3", "P4", "P5"]);
      await startPlayingMatch(harness, host, code, five);
      const room = harness.getRooms().get(code);
      expect(room.players.filter((p) => !p.isBot)).toHaveLength(6);
      expect(room.players.filter((p) => p.isBot)).toHaveLength(0);
      host.disconnect();
      five.forEach((s) => s.disconnect());
    });
  });

  describe("Time-driven full match (engine + Jest fake timers)", () => {
    beforeEach(() => {
      precompIndex = 0;
      jest.useFakeTimers({ now: SIM_T0 });
      jest.spyOn(Math, "random").mockImplementation(() => PRECOMP_R[precompIndex++ % PRECOMP_R.length]);
    });
    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    /**
     * Phases (simulated clock):
     * 0–10s: natural spawns + ticks — unique blinks, expiry via tick
     * 10–30s: scripted taps + invalid taps
     * 30–50s: double / trap / freeze (+ 1000ms freeze window)
     * 50–70s: concurrency same tile
     * End: advance to gameEndsAt — gameOver, no spawns, sorted leaderboard
     */
    test.each([
      [1, "1 human + bots"],
      [3, "3 humans + bots"],
      [6, "6 humans (no bots)"],
    ])("phased match: %i humans — %s", (humanCount, _label) => {
      const humans = buildHumans(humanCount);
      const { io, getSemanticLog } = createSemanticIo();
      const room = {
        code: "SIMU1",
        io,
        phase: "lobby",
        gridSize: 5,
        hostId: humans[0].id,
        players: [...humans],
        cells: null,
        activeBlinks: new Map(),
        gameEndsAt: 0,
        spawnTimer: null,
        tickTimer: null,
        pendingTimeouts: [],
      };

      simPrint("--- Phase 0: startGameLoop ---", { humanCount });
      startGameLoop(room);
      clearBotTapTimers(room);

      const matchDurationMs = 75_000;
      room.gameEndsAt = SIM_T0 + matchDurationMs;
      expect(room.players.length).toBeLessThanOrEqual(MAX_PLAYERS);

      // --- Phase 1 (0–10s simulated): spawning + expiry ---
      simPrint("--- Phase 1 (0–10s): spawns & expiry ---");
      for (let step = 0; step < 10; step += 1) {
        advanceMs(1000);
        assertUniqueActiveBlinks(room);
      }
      const activatedP1 = getSemanticLog().filter((e) => e.name === "tileActivated").length;
      expect(activatedP1).toBeGreaterThan(0);

      advanceMs(5000);
      const expired = getSemanticLog().filter((e) => e.name === "tileExpired").length;
      expect(expired).toBeGreaterThan(0);

      // --- Phase 2 (10–30s): valid / invalid taps ---
      simPrint("--- Phase 2 (10–30s): taps ---");
      const h0 = room.players.find((p) => !p.isBot);
      const tMid = SIM_T0 + 15_000;
      jest.setSystemTime(tMid);
      room.activeBlinks.set("1,1", {
        x: 1,
        y: 1,
        type: "normal",
        expiresAt: tMid + 8000,
        spawnedAt: tMid,
      });
      _test.broadcastGame(room);

      expect(tryProcessTap(room, h0, 1, 1, null)).toBe(true);
      const taps = getSemanticLog().filter((e) => e.name === "tapFeedback");
      expect(taps.length).toBeGreaterThan(0);
      expect(taps[taps.length - 1].detail).toEqual(
        expect.objectContaining({ x: 1, y: 1, gained: expect.any(Number) }),
      );
      expect(tryProcessTap(room, h0, 9, 9, null)).toBe(false);
      expect(tryProcessTap(room, h0, 1, 1, null)).toBe(false);

      const h1 = room.players.filter((p) => !p.isBot)[1];
      if (h1) {
        jest.setSystemTime(tMid + CLICK_THROTTLE_MS);
        room.activeBlinks.set("2,2", {
          x: 2,
          y: 2,
          type: "normal",
          expiresAt: tMid + 20_000,
          spawnedAt: tMid,
        });
        _test.broadcastGame(room);
        expect(tryProcessTap(room, h1, 2, 2, null)).toBe(true);
      }

      // --- Phase 3 (30–50s): specials + freeze window ---
      simPrint("--- Phase 3 (30–50s): double / trap / freeze ---");
      const t3 = SIM_T0 + 35_000;
      const gap = CLICK_THROTTLE_MS + 1;

      jest.setSystemTime(t3);
      room.activeBlinks.set("3,0", { x: 3, y: 0, type: "double", expiresAt: t3 + 20_000, spawnedAt: t3 });
      _test.broadcastGame(room);
      const s0 = h0.score;
      expect(tryProcessTap(room, h0, 3, 0, null)).toBe(true);
      expect(h0.score - s0).toBeGreaterThanOrEqual(2);

      const tTrap = t3 + gap;
      jest.setSystemTime(tTrap);
      room.activeBlinks.set("3,1", { x: 3, y: 1, type: "trap", expiresAt: tTrap + 20_000, spawnedAt: tTrap });
      _test.broadcastGame(room);
      const beforeTrap = h0.score;
      expect(tryProcessTap(room, h0, 3, 1, null)).toBe(true);
      expect(h0.score).toBe(beforeTrap - 1);

      const tFreeze = tTrap + gap;
      jest.setSystemTime(tFreeze);
      const victim =
        room.players.find((p) => !p.isBot && p.id !== h0.id) || room.players.find((p) => p.isBot);
      expect(victim).toBeDefined();
      room.activeBlinks.set("3,2", { x: 3, y: 2, type: "freeze", expiresAt: tFreeze + 20_000, spawnedAt: tFreeze });
      _test.broadcastGame(room);
      expect(tryProcessTap(room, h0, 3, 2, null)).toBe(true);
      const until = victim.frozenUntil;
      expect(until).toBe(tFreeze + 1000);

      jest.setSystemTime(tFreeze + 500);
      room.activeBlinks.set("0,4", { x: 0, y: 4, type: "normal", expiresAt: tFreeze + 25_000, spawnedAt: tFreeze });
      _test.broadcastGame(room);
      if (victim.id !== h0.id) {
        expect(tryProcessTap(room, victim, 0, 4, null)).toBe(false);
      }

      jest.setSystemTime(until);
      expect(tryProcessTap(room, victim, 0, 4, null)).toBe(true);

      // --- Phase 4 (50–70s): concurrency same tile ---
      simPrint("--- Phase 4 (50–70s): same-tile race ---");
      const t4 = SIM_T0 + 55_000;
      jest.setSystemTime(t4);
      const a = room.players.find((p) => !p.isBot);
      const b = room.players.filter((p) => !p.isBot)[1];
      room.activeBlinks.set("4,4", { x: 4, y: 4, type: "normal", expiresAt: t4 + 15_000, spawnedAt: t4 });
      _test.broadcastGame(room);
      if (b) {
        a.lastClickAttemptAt = 0;
        b.lastClickAttemptAt = 0;
        expect(tryProcessTap(room, a, 4, 4, null)).toBe(true);
        expect(tryProcessTap(room, b, 4, 4, null)).toBe(false);
      } else {
        expect(tryProcessTap(room, a, 4, 4, null)).toBe(true);
      }

      // --- Phase 5: end of match ---
      simPrint("--- Phase 5: game end ---");
      jest.setSystemTime(room.gameEndsAt);
      tickPlayingRoom(room);
      expect(room.phase).toBe("results");
      expect(room.activeBlinks.size).toBe(0);

      const overs = getSemanticLog().filter((e) => e.name === "gameOver");
      expect(overs.length).toBe(1);
      const ranking = overs[0].detail.ranking;
      for (let i = 0; i < ranking.length - 1; i += 1) {
        expect(ranking[i].score).toBeGreaterThanOrEqual(ranking[i + 1].score);
      }

      jest.setSystemTime(room.gameEndsAt + 120_000);
      tickPlayingRoom(room);
      expect(room.phase).toBe("results");
      expect(room.activeBlinks.size).toBe(0);

      clearRoomTimersForSimulation(room);
    });
  });

  describe("Bot rules (engine)", () => {
    beforeEach(() => {
      jest.useFakeTimers({ now: SIM_T0 });
    });
    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    test("bots only added inside startGameLoop, never more than six entities", () => {
      const humans = buildHumans(2);
      const { io } = createSemanticIo();
      const room = {
        code: "BOT1",
        io,
        phase: "lobby",
        gridSize: 5,
        hostId: humans[0].id,
        players: [...humans],
        cells: null,
        activeBlinks: new Map(),
        gameEndsAt: 0,
        spawnTimer: null,
        tickTimer: null,
        pendingTimeouts: [],
      };
      const before = room.players.length;
      startGameLoop(room);
      expect(room.players.length).toBe(MAX_PLAYERS);
      expect(room.players.length).toBeLessThanOrEqual(6);
      expect(room.players.length - before).toBe(4);
      clearRoomTimersForSimulation(room);
    });

    test("processBotTap does not fire instantly; respects freeze and expiry", () => {
      const bot = {
        id: "b_sim",
        isBot: true,
        skill: 0.5,
        score: 0,
        frozenUntil: 0,
        combo: 1,
        lastComboAt: 0,
        lastClickAttemptAt: 0,
      };
      const human = createHumanPlayer({ id: "h0", socketId: "s0" });
      const { io } = createSemanticIo();
      const room = {
        code: "BOT2",
        io,
        phase: "playing",
        gridSize: 5,
        hostId: human.id,
        players: [human, bot],
        cells: createEmptyCells(5),
        activeBlinks: new Map(),
        gameEndsAt: SIM_T0 + 60_000,
        spawnTimer: null,
        tickTimer: null,
        pendingTimeouts: [],
      };
      const exp = SIM_T0 + 5000;
      room.activeBlinks.set("0,0", { x: 0, y: 0, type: "normal", expiresAt: exp, spawnedAt: SIM_T0 });
      let rnd = 0;
      jest.spyOn(Math, "random").mockImplementation(() => [0, 0.1, 0.18, 0][rnd++] ?? 0);
      scheduleBotTap(room, room.activeBlinks.get("0,0"));
      expect(room.pendingTimeouts.length).toBeGreaterThanOrEqual(1);
      bot.frozenUntil = SIM_T0 + 9999;
      jest.setSystemTime(SIM_T0 + 100);
      processBotTap(room, bot.id, 0, 0, exp);
      expect(bot.score).toBe(0);
      clearRoomTimersForSimulation(room);
    });
  });

  describe("Edge cases (integration)", () => {
    let harness;
    beforeEach(async () => {
      harness = await startTestServer();
    });
    afterEach(async () => {
      if (harness) await harness.close();
    });

    test("host disconnect assigns next human as host", async () => {
      const { socket: host, code } = await createTestRoom(harness);
      const [p2] = await addTestPlayers(harness, code, ["Next"]);
      const upd = new Promise((resolve) => p2.once("room:update", resolve));
      host.disconnect();
      const snap = await upd;
      expect(snap.hostId).toBe(p2.id);
      p2.disconnect();
    });

    test("rapid taps throttled for same human", async () => {
      const { socket: host, code } = await createTestRoom(harness);
      await startPlayingMatch(harness, host, code, []);
      const room = harness.getRooms().get(code);
      const t = Date.now();
      room.activeBlinks.set("0,0", { x: 0, y: 0, type: "normal", expiresAt: t + 60_000, spawnedAt: t });
      room.activeBlinks.set("1,0", { x: 1, y: 0, type: "normal", expiresAt: t + 60_000, spawnedAt: t });
      _test.broadcastGame(room);
      simulateTileClick(host, 0, 0);
      simulateTileClick(host, 1, 0);
      await new Promise((r) => setImmediate(r));
      const human = room.players.find((p) => !p.isBot);
      expect(human.score).toBe(1);
      host.disconnect();
    });

    test("last human leaving ends session (server: <1 humans, not <2)", async () => {
      const { socket: host, code } = await createTestRoom(harness);
      const [p2] = await addTestPlayers(harness, code, ["Other"]);
      await startPlayingMatch(harness, host, code, [p2]);
      host.disconnect();
      await new Promise((r) => setImmediate(r));
      expect(harness.getRooms().get(code).phase).toBe("playing");
      p2.disconnect();
      await new Promise((r) => setImmediate(r));
      expect(harness.getRooms().get(code).phase).toBe("results");
    });
  });
});

function clearRoomTimersForSimulation(room) {
  if (room.spawnTimer) {
    clearTimeout(room.spawnTimer);
    room.spawnTimer = null;
  }
  if (room.tickTimer) {
    clearInterval(room.tickTimer);
    room.tickTimer = null;
  }
  clearBotTapTimers(room);
}

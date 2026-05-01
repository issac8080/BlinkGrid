"use strict";

const {
  startTestServer,
  createTestRoom,
  addTestPlayers,
  simulateTileClick,
  pollRoomPhase,
  startPlayingMatch,
} = require("./helpers/harness");
const { createMockIo, createHumanPlayer, createBotPlayer } = require("./helpers/mockRoom");
const { _test } = require("../lib/blinkGridServer");

const {
  rollSpecialType,
  tryProcessTap,
  spawnBlink,
  scheduleBotTap,
  processBotTap,
  addSessionBots,
  createEmptyCells,
  MAX_PLAYERS,
  tickPlayingRoom,
  broadcastGame,
  normalizeGridSize,
  normalizeMatchDurationMs,
  MATCH_DURATION_MS,
  DEFAULT_MATCH_DURATION_MS,
  GRID_SIZES,
  parseTileId,
} = _test;

function buildPlayingRoom(players, overrides = {}) {
  const { io, log } = createMockIo();
  const room = {
    code: "ABCDE",
    io,
    phase: "playing",
    gridSize: 5,
    hostId: players[0]?.id,
    players,
    cells: createEmptyCells(5),
    activeBlinks: new Map(),
    gameEndsAt: Date.now() + 120000,
    spawnTimer: null,
    tickTimer: null,
    pendingTimeouts: [],
    ...overrides,
  };
  return { room, log };
}

describe("BlinkGrid QA — game engine & sockets", () => {
  describe("0. Grid configuration", () => {
    test("GRID_SIZES lists supported boards", () => {
      expect(GRID_SIZES).toEqual([5, 6, 7, 10, 16]);
    });

    test("normalizeGridSize clamps unknown values to default 5", () => {
      expect(normalizeGridSize(7)).toBe(7);
      expect(normalizeGridSize(10)).toBe(10);
      expect(normalizeGridSize(16)).toBe(16);
      expect(normalizeGridSize(8)).toBe(5);
      expect(normalizeGridSize(null)).toBe(5);
    });

    test("normalizeMatchDurationMs clamps to easy / medium / hard presets", () => {
      expect(normalizeMatchDurationMs(90_000)).toBe(90_000);
      expect(normalizeMatchDurationMs(60_000)).toBe(60_000);
      expect(normalizeMatchDurationMs(30_000)).toBe(30_000);
      expect(normalizeMatchDurationMs(45_000)).toBe(DEFAULT_MATCH_DURATION_MS);
      expect(MATCH_DURATION_MS).toEqual([90_000, 60_000, 30_000]);
    });

    test("parseTileId parses x,y tile ids for tileClick", () => {
      expect(parseTileId("3,4")).toEqual({ xi: 3, yi: 4 });
      expect(parseTileId(" 10,16 ")).toEqual({ xi: 10, yi: 16 });
      expect(parseTileId("bad")).toBe(null);
      expect(parseTileId("")).toBe(null);
    });
  });

  describe("1. Game initialization", () => {
    let harness;
    beforeEach(async () => {
      harness = await startTestServer();
    });
    afterEach(async () => {
      if (harness) await harness.close();
    });

    test("creates a lobby room with code and host", async () => {
      const { socket, room, code } = await createTestRoom(harness, { name: "Alpha" });
      expect(code).toHaveLength(5);
      expect(room.phase).toBe("lobby");
      expect(room.matchDurationMs).toBe(60_000);
      expect(room.players.some((p) => p.name === "Alpha")).toBe(true);
      socket.disconnect();
    });

    test("resets scores and state when the game starts", async () => {
      const { socket: host, code } = await createTestRoom(harness);
      const roomRef = harness.getRooms().get(code);
      roomRef.players[0].score = 99;
      const [p2] = await addTestPlayers(harness, code, ["Guest"]);
      await startPlayingMatch(harness, host, code, [p2]);
      const playing = harness.getRooms().get(code);
      expect(playing.phase).toBe("playing");
      for (const p of playing.players) {
        expect(p.score).toBe(0);
        expect(p.frozenUntil).toBe(0);
      }
      host.disconnect();
      p2.disconnect();
    });

    test("assigns 5 bots when exactly 1 human", async () => {
      const { socket: host, code } = await createTestRoom(harness);
      await startPlayingMatch(harness, host, code, []);
      const r = harness.getRooms().get(code);
      const bots = r.players.filter((p) => p.isBot);
      const humans = r.players.filter((p) => !p.isBot);
      expect(humans).toHaveLength(1);
      expect(bots).toHaveLength(5);
      expect(r.players).toHaveLength(MAX_PLAYERS);
      host.disconnect();
    });

    test("assigns 4 bots when 2 humans", async () => {
      const { socket: host, code } = await createTestRoom(harness);
      const [p2] = await addTestPlayers(harness, code, ["Two"]);
      await startPlayingMatch(harness, host, code, [p2]);
      const r = harness.getRooms().get(code);
      expect(r.players.filter((p) => !p.isBot)).toHaveLength(2);
      expect(r.players.filter((p) => p.isBot)).toHaveLength(4);
      host.disconnect();
      p2.disconnect();
    });

    test("assigns no bots when 5 humans", async () => {
      const { socket: host, code } = await createTestRoom(harness);
      const extra = await addTestPlayers(harness, code, ["P2", "P3", "P4", "P5"]);
      await startPlayingMatch(harness, host, code, extra);
      const r = harness.getRooms().get(code);
      expect(r.players.filter((p) => !p.isBot)).toHaveLength(5);
      expect(r.players.filter((p) => p.isBot)).toHaveLength(0);
      host.disconnect();
      extra.forEach((s) => s.disconnect());
    });
  });

  describe("2. Tile spawn rules", () => {
    test("spawns only on valid, unclaimed, non-occupied cells", () => {
      const p1 = createHumanPlayer({ id: "h1" });
      const { room } = buildPlayingRoom([p1]);
      room.cells[2][2] = { ownerId: "h1" };
      jest.spyOn(Math, "random").mockReturnValue(0);
      spawnBlink(room);
      for (const [, b] of room.activeBlinks) {
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.x).toBeLessThan(5);
        expect(b.y).toBeLessThan(5);
        expect(room.cells[b.y][b.x].ownerId).toBeNull();
      }
      Math.random.mockRestore();
    });

    test("does not create duplicate active tile keys", () => {
      const p1 = createHumanPlayer({ id: "h1" });
      const { room } = buildPlayingRoom([p1]);
      let i = 0;
      jest.spyOn(Math, "random").mockImplementation(() => {
        const v = i * 0.0001;
        i += 1;
        return Math.min(0.9999, v);
      });
      spawnBlink(room);
      const keys = [...room.activeBlinks.keys()];
      expect(new Set(keys).size).toBe(keys.length);
      Math.random.mockRestore();
    });

    test("blink lifetime is between 1s and 2s inclusive", () => {
      const p1 = createHumanPlayer({ id: "h1" });
      const { room } = buildPlayingRoom([p1]);
      jest.spyOn(Date, "now").mockReturnValue(1_000_000);
      jest.spyOn(Math, "random").mockReturnValue(0);
      spawnBlink(room);
      for (const [, b] of room.activeBlinks) {
        const life = b.expiresAt - b.spawnedAt;
        expect(life).toBeGreaterThanOrEqual(1000);
        expect(life).toBeLessThanOrEqual(2000);
      }
      Math.random.mockRestore();
      Date.now.mockRestore();
    });

    test("tickPlayingRoom removes blinks after they expire", () => {
      const p1 = createHumanPlayer({ id: "h1" });
      const { room } = buildPlayingRoom([p1]);
      const t = 1_000_000;
      room.activeBlinks.set("0,0", { x: 0, y: 0, type: "normal", expiresAt: t + 500, spawnedAt: t });
      jest.spyOn(Date, "now").mockReturnValue(t + 600);
      tickPlayingRoom(room);
      expect(room.activeBlinks.has("0,0")).toBe(false);
      Date.now.mockRestore();
    });

    test("special tile distribution follows rollSpecialType thresholds", () => {
      const seq = [0.05, 0.15, 0.25, 0.9];
      let idx = 0;
      jest.spyOn(Math, "random").mockImplementation(() => seq[idx++]);
      expect(rollSpecialType()).toBe("double");
      expect(rollSpecialType()).toBe("trap");
      expect(rollSpecialType()).toBe("freeze");
      expect(rollSpecialType()).toBe("normal");
      Math.random.mockRestore();
    });
  });

  describe("3. Player actions & scoring", () => {
    test("valid tap on active blink grants score and claims cell", () => {
      const p1 = createHumanPlayer({ id: "h1" });
      const { room } = buildPlayingRoom([p1]);
      const t = Date.now();
      room.activeBlinks.set("1,1", { x: 1, y: 1, type: "normal", expiresAt: t + 5000, spawnedAt: t });
      jest.spyOn(Date, "now").mockReturnValue(t + 100);
      const ok = tryProcessTap(room, p1, 1, 1, null);
      expect(ok).toBe(true);
      expect(p1.score).toBe(1);
      expect(room.cells[1][1].ownerId).toBe("h1");
      expect(room.activeBlinks.has("1,1")).toBe(false);
      Date.now.mockRestore();
    });

    test("rejects tap on expired blink", () => {
      const p1 = createHumanPlayer({ id: "h1" });
      const { room } = buildPlayingRoom([p1]);
      const t = Date.now();
      room.activeBlinks.set("0,0", { x: 0, y: 0, type: "normal", expiresAt: t + 10, spawnedAt: t });
      jest.spyOn(Date, "now").mockReturnValue(t + 50);
      const ok = tryProcessTap(room, p1, 0, 0, null);
      expect(ok).toBe(false);
      expect(p1.score).toBe(0);
      Date.now.mockRestore();
    });

    test("rejects tap when blink was already claimed (removed)", () => {
      const p1 = createHumanPlayer({ id: "h1" });
      const p2 = createHumanPlayer({ id: "h2", socketId: "s2" });
      const { room } = buildPlayingRoom([p1, p2]);
      const t = Date.now();
      room.activeBlinks.set("2,2", { x: 2, y: 2, type: "normal", expiresAt: t + 5000, spawnedAt: t });
      jest.spyOn(Date, "now").mockReturnValue(t + 100);
      expect(tryProcessTap(room, p1, 2, 2, null)).toBe(true);
      expect(tryProcessTap(room, p2, 2, 2, null)).toBe(false);
      Date.now.mockRestore();
    });

    test("double tile adds +2 base (plus combo extras when chained)", () => {
      const p1 = createHumanPlayer({ id: "h1" });
      const { room } = buildPlayingRoom([p1]);
      const t = Date.now();
      jest.spyOn(Date, "now").mockReturnValue(t);
      room.activeBlinks.set("0,0", { x: 0, y: 0, type: "double", expiresAt: t + 5000, spawnedAt: t });
      tryProcessTap(room, p1, 0, 0, null);
      expect(p1.score).toBe(2);
      Date.now.mockRestore();
    });

    test("trap tile subtracts 1 from score", () => {
      const p1 = createHumanPlayer({ id: "h1", score: 3 });
      const { room } = buildPlayingRoom([p1]);
      const t = Date.now();
      jest.spyOn(Date, "now").mockReturnValue(t);
      room.activeBlinks.set("1,0", { x: 1, y: 0, type: "trap", expiresAt: t + 5000, spawnedAt: t });
      tryProcessTap(room, p1, 1, 0, null);
      expect(p1.score).toBe(2);
      Date.now.mockRestore();
    });
  });

  describe("4. Freeze logic", () => {
    test("freeze tile sets other players frozenUntil ~1s ahead and does not freeze claimer", () => {
      const p1 = createHumanPlayer({ id: "h1" });
      const p2 = createHumanPlayer({ id: "h2", socketId: "s2" });
      const { room } = buildPlayingRoom([p1, p2]);
      const t = 5_000_000;
      jest.spyOn(Date, "now").mockReturnValue(t);
      room.activeBlinks.set("3,3", { x: 3, y: 3, type: "freeze", expiresAt: t + 5000, spawnedAt: t });
      tryProcessTap(room, p1, 3, 3, null);
      expect(p1.frozenUntil).toBe(0);
      expect(p2.frozenUntil).toBe(t + 1000);
      expect(p1.score).toBe(0);
      Date.now.mockRestore();
    });

    test("frozen player cannot score on an active blink", () => {
      const p2 = createHumanPlayer({
        id: "h2",
        socketId: "s2",
        frozenUntil: 9_000_000,
      });
      const { room } = buildPlayingRoom([createHumanPlayer({ id: "h1" }), p2]);
      const t = 5_000_000;
      jest.spyOn(Date, "now").mockReturnValue(t);
      room.activeBlinks.set("0,0", { x: 0, y: 0, type: "normal", expiresAt: t + 5000, spawnedAt: t });
      expect(p2.frozenUntil > t).toBe(true);
      expect(tryProcessTap(room, p2, 0, 0, null)).toBe(false);
      expect(room.activeBlinks.has("0,0")).toBe(true);
      Date.now.mockRestore();
    });

    test("freeze uses Math.max so an existing longer freeze is not shortened", () => {
      const p1 = createHumanPlayer({ id: "h1" });
      const p2 = createHumanPlayer({ id: "h2", socketId: "s2", frozenUntil: 9_000_000 });
      const { room } = buildPlayingRoom([p1, p2]);
      const t = 5_000_000;
      jest.spyOn(Date, "now").mockReturnValue(t);
      room.activeBlinks.set("4,4", { x: 4, y: 4, type: "freeze", expiresAt: t + 5000, spawnedAt: t });
      tryProcessTap(room, p1, 4, 4, null);
      expect(p2.frozenUntil).toBe(9_000_000);
      Date.now.mockRestore();
    });

    test("tickPlayingRoom clears expired frozenUntil", () => {
      const p1 = createHumanPlayer({ id: "h1" });
      const { room } = buildPlayingRoom([p1]);
      const t = 8_000_000;
      jest.spyOn(Date, "now").mockReturnValue(t);
      room.gameEndsAt = t + 600_000;
      p1.frozenUntil = t - 50;
      tickPlayingRoom(room);
      expect(p1.frozenUntil).toBe(0);
      Date.now.mockRestore();
    });
  });

  describe("5. Bot behavior", () => {
    test("addSessionBots only fills to MAX_PLAYERS for 1–4 humans", () => {
      const mk = (n) => Array.from({ length: n }, (_, i) => createHumanPlayer({ id: `h${i}`, socketId: `s${i}` }));
      for (let humans = 1; humans <= 4; humans += 1) {
        const { room } = buildPlayingRoom(mk(humans));
        addSessionBots(room);
        expect(room.players).toHaveLength(MAX_PLAYERS);
        room.players = mk(humans);
      }
    });

    test("scheduleBotTap uses non-zero delay (not immediate)", () => {
      jest.useFakeTimers({ now: 1_000_000 });
      const bot = createBotPlayer({ id: "b1", skill: 1 });
      const human = createHumanPlayer({ id: "h1" });
      const { room } = buildPlayingRoom([human, bot]);
      let rnd = 0;
      jest.spyOn(Math, "random").mockImplementation(() => {
        const seq = [0, 0.1, 0.18, 0];
        return seq[Math.min(rnd++, seq.length - 1)];
      });
      const blink = { x: 0, y: 0, type: "normal", expiresAt: 1_000_000 + 10_000, spawnedAt: 1_000_000 };
      room.activeBlinks.set("0,0", blink);
      scheduleBotTap(room, blink);
      expect(room.pendingTimeouts.length).toBeGreaterThanOrEqual(1);
      jest.advanceTimersByTime(219);
      expect(bot.score).toBe(0);
      jest.advanceTimersByTime(5);
      expect(bot.score).toBe(1);
      jest.useRealTimers();
      Math.random.mockRestore();
    });

    test("bots with low skill may skip scheduling a tap", () => {
      jest.useFakeTimers({ now: 2_000_000 });
      const bot = createBotPlayer({ id: "b1", skill: 0 });
      const human = createHumanPlayer({ id: "h1" });
      const { room } = buildPlayingRoom([human, bot]);
      jest.spyOn(Math, "random").mockReturnValue(0.5);
      const blink = { x: 1, y: 1, type: "normal", expiresAt: 2_000_000 + 10_000, spawnedAt: 2_000_000 };
      room.pendingTimeouts = [];
      scheduleBotTap(room, blink);
      expect(room.pendingTimeouts.length).toBe(0);
      jest.useRealTimers();
      Math.random.mockRestore();
    });

    test("processBotTap respects freeze and expiry mismatch", () => {
      const bot = createBotPlayer({ id: "b1" });
      const human = createHumanPlayer({ id: "h1" });
      const t = Date.now();
      const { room } = buildPlayingRoom([human, bot]);
      room.activeBlinks.set("2,2", { x: 2, y: 2, type: "normal", expiresAt: t + 5000, spawnedAt: t });
      bot.frozenUntil = t + 9999;
      jest.spyOn(Date, "now").mockReturnValue(t + 100);
      processBotTap(room, "b1", 2, 2, t + 5000);
      expect(bot.score).toBe(0);
      bot.frozenUntil = 0;
      processBotTap(room, "b1", 2, 2, t + 1111);
      expect(bot.score).toBe(0);
      Date.now.mockRestore();
    });
  });

  describe("6. Concurrency & anti-cheat (integration)", () => {
    let harness;
    beforeEach(async () => {
      harness = await startTestServer();
    });
    afterEach(async () => {
      if (harness) await harness.close();
    });

    test("two players tapping the same tile: only one scores", async () => {
      const { socket: host, code } = await createTestRoom(harness);
      const [p2] = await addTestPlayers(harness, code, ["Rival"]);
      await startPlayingMatch(harness, host, code, [p2]);
      const room = harness.getRooms().get(code);
      const t = Date.now();
      room.activeBlinks.set("2,2", {
        x: 2,
        y: 2,
        type: "normal",
        expiresAt: t + 60_000,
        spawnedAt: t,
      });
      broadcastGame(room);
      simulateTileClick(host, 2, 2);
      simulateTileClick(p2, 2, 2);
      await new Promise((r) => setImmediate(r));
      const snap = harness.getRooms().get(code);
      const scores = snap.players.filter((p) => !p.isBot).map((p) => p.score);
      const winners = scores.filter((s) => s > 0);
      expect(winners).toHaveLength(1);
      expect(winners[0]).toBe(1);
      host.disconnect();
      p2.disconnect();
    });

    test("rapid taps are throttled (second within CLICK_THROTTLE_MS ignored)", async () => {
      const { socket: host, code } = await createTestRoom(harness);
      await startPlayingMatch(harness, host, code, []);
      const room = harness.getRooms().get(code);
      const t = Date.now();
      room.activeBlinks.set("0,0", { x: 0, y: 0, type: "normal", expiresAt: t + 60_000, spawnedAt: t });
      room.activeBlinks.set("1,0", { x: 1, y: 0, type: "normal", expiresAt: t + 60_000, spawnedAt: t });
      broadcastGame(room);
      await new Promise((r) => setTimeout(r, 10));
      simulateTileClick(host, 0, 0);
      simulateTileClick(host, 1, 0);
      await new Promise((r) => setImmediate(r));
      const snap = harness.getRooms().get(code);
      const human = snap.players.find((p) => !p.isBot);
      expect(human.score).toBe(1);
      host.disconnect();
    });

    test("many simultaneous taps from multiple players keep a consistent blink map", async () => {
      const { socket: host, code } = await createTestRoom(harness);
      const others = await addTestPlayers(harness, code, ["A", "B"]);
      await startPlayingMatch(harness, host, code, others);
      const room = harness.getRooms().get(code);
      const t = Date.now();
      for (let i = 0; i < 3; i += 1) {
        room.activeBlinks.set(`${i},${i}`, {
          x: i,
          y: i,
          type: "normal",
          expiresAt: t + 60_000,
          spawnedAt: t,
        });
      }
      broadcastGame(room);
      simulateTileClick(host, 0, 0);
      simulateTileClick(others[0], 1, 1);
      simulateTileClick(others[1], 2, 2);
      await new Promise((r) => setImmediate(r));
      const after = harness.getRooms().get(code);
      expect([...after.activeBlinks.keys()].length).toBe(0);
      host.disconnect();
      others.forEach((s) => s.disconnect());
    });
  });

  describe("7. Game end & leaderboard", () => {
    test("ends with reason grid_full when the last tile is claimed", () => {
      const p1 = createHumanPlayer({ id: "h1" });
      const { room, log } = buildPlayingRoom([p1]);
      const t = Date.now();
      jest.spyOn(Date, "now").mockReturnValue(t + 100);
      for (let y = 0; y < 5; y++) {
        for (let x = 0; x < 5; x++) {
          if (x === 4 && y === 4) continue;
          room.cells[y][x].ownerId = "h1";
        }
      }
      room.activeBlinks.set("4,4", { x: 4, y: 4, type: "normal", expiresAt: t + 5000, spawnedAt: t });
      expect(tryProcessTap(room, p1, 4, 4, null)).toBe(true);
      expect(room.phase).toBe("results");
      expect(log.gameOver[0].reason).toBe("grid_full");
      Date.now.mockRestore();
    });

    test("tick ends with grid_full when board is already full (timer still running)", () => {
      const p1 = createHumanPlayer({ id: "h1" });
      const { room, log } = buildPlayingRoom([p1]);
      const t = 12_345_000;
      for (let y = 0; y < 5; y++) {
        for (let x = 0; x < 5; x++) {
          room.cells[y][x].ownerId = "h1";
        }
      }
      room.gameEndsAt = t + 600_000;
      jest.spyOn(Date, "now").mockReturnValue(t);
      tickPlayingRoom(room);
      expect(room.phase).toBe("results");
      expect(log.gameOver[0].reason).toBe("grid_full");
      Date.now.mockRestore();
    });

    test("ends with reason time when clock passes gameEndsAt", () => {
      const p1 = createHumanPlayer({ id: "h1", score: 10 });
      const p2 = createHumanPlayer({ id: "h2", socketId: "s2", score: 5 });
      const { room, log } = buildPlayingRoom([p1, p2]);
      const t = 8_888_000;
      room.gameEndsAt = t;
      jest.spyOn(Date, "now").mockReturnValue(t - 100);
      tickPlayingRoom(room);
      expect(room.phase).toBe("playing");
      Date.now.mockReturnValue(t + 1);
      tickPlayingRoom(room);
      expect(room.phase).toBe("results");
      expect(log.gameOver[0].reason).toBe("time");
      const ranks = log.gameOver[0].ranking.map((r) => r.id);
      expect(ranks[0]).toBe("h1");
      Date.now.mockRestore();
    });

    test("last human leaving mid-game ends the session with results (bots may remain)", async () => {
      const harness = await startTestServer();
      try {
        const { socket: host, code } = await createTestRoom(harness);
        const [p2] = await addTestPlayers(harness, code, ["Other"]);
        await startPlayingMatch(harness, host, code, [p2]);
        host.disconnect();
        await new Promise((r) => setImmediate(r));
        expect(harness.getRooms().get(code).phase).toBe("playing");
        p2.disconnect();
        await new Promise((r) => setImmediate(r));
        const roomLeft = harness.getRooms().get(code);
        expect(roomLeft.phase).toBe("results");
      } finally {
        await harness.close();
      }
    });

    test("leaderboard is sorted by score descending on game over", () => {
      const p1 = createHumanPlayer({ id: "low", score: 1 });
      const p2 = createHumanPlayer({ id: "high", socketId: "s2", score: 50 });
      const { room, log } = buildPlayingRoom([p1, p2]);
      room.gameEndsAt = Date.now();
      jest.spyOn(Date, "now").mockReturnValue(room.gameEndsAt + 1);
      tickPlayingRoom(room);
      const ranking = log.gameOver[0].ranking;
      expect(ranking[0].score).toBeGreaterThanOrEqual(ranking[1].score);
      Date.now.mockRestore();
    });
  });

  describe("8. Disconnection & host migration", () => {
    let harness;
    beforeEach(async () => {
      harness = await startTestServer();
    });
    afterEach(async () => {
      if (harness) await harness.close();
    });

    test("migrates host to next human and clears their ready flag", async () => {
      const { socket: host, code, room: initial } = await createTestRoom(harness);
      const [p2] = await addTestPlayers(harness, code, ["NextHost"]);
      const hostIdBefore = initial.hostId;
      const upd = new Promise((resolve) => {
        p2.once("room:update", resolve);
      });
      host.disconnect();
      const snapshot = await upd;
      expect(snapshot.hostId).not.toBe(hostIdBefore);
      expect(snapshot.hostId).toBe(p2.id);
      const me = snapshot.players.find((p) => p.id === p2.id);
      expect(me.ready).toBe(false);
      p2.disconnect();
    });

    test("player:left is emitted when someone disconnects mid-lobby", async () => {
      const { socket: host, code } = await createTestRoom(harness);
      const [p2] = await addTestPlayers(harness, code, ["Leaver"]);
      const evt = new Promise((resolve) => {
        host.once("player:left", resolve);
      });
      p2.disconnect();
      const payload = await evt;
      expect(payload.playerId).toBeDefined();
      host.disconnect();
    });
  });

  describe("Edge: invalid taps rejected (engine)", () => {
    test("out-of-bounds coordinates return false", () => {
      const p1 = createHumanPlayer({ id: "h1" });
      const { room } = buildPlayingRoom([p1]);
      const t = Date.now();
      room.activeBlinks.set("0,0", { x: 0, y: 0, type: "normal", expiresAt: t + 5000, spawnedAt: t });
      jest.spyOn(Date, "now").mockReturnValue(t + 100);
      expect(tryProcessTap(room, p1, 99, 0, null)).toBe(false);
      Date.now.mockRestore();
    });
  });
});

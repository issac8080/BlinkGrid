"use strict";

const {
  startTestServer,
  createTestRoom,
  addTestPlayers,
  simulateTileClick,
  startPlayingMatch,
  waitForSocketEvent,
} = require("./helpers/harness");
const { broadcastGame, tickPlayingRoom } = require("../lib/blinkGridServer")._test;

function findHumanBySocket(room, socket) {
  return room.players.find((p) => !p.isBot && p.socketId === socket.id);
}

describe("Gameplay E2E & regression", () => {
  let harness;
  beforeEach(async () => {
    harness = await startTestServer();
  });
  afterEach(async () => {
    if (harness) await harness.close();
  });

  test("Case 1: solo human starts unfrozen; tap claims tile and updates score", async () => {
    const { socket: host, code } = await createTestRoom(harness);
    await startPlayingMatch(harness, host, code, []);
    const room = harness.getRooms().get(code);
    const human = findHumanBySocket(room, host);
    expect(human.frozenUntil).toBe(0);

    const t = Date.now();
    room.activeBlinks.set("2,2", { x: 2, y: 2, type: "normal", expiresAt: t + 60_000, spawnedAt: t });
    broadcastGame(room);

    const claimP = waitForSocketEvent(host, "tileClaimed", { timeoutMs: 3000 });
    simulateTileClick(host, 2, 2);
    const payload = await claimP;
    expect(payload).toMatchObject({ x: 2, y: 2, playerId: host.id });

    await new Promise((r) => setImmediate(r));
    const snap = harness.getRooms().get(code);
    expect(snap.cells[2][2].ownerId).toBe(host.id);
    expect(findHumanBySocket(snap, host).score).toBeGreaterThanOrEqual(1);
    host.disconnect();
  });

  test("Case 2: three humans — distinct taps claim three tiles; no double owner", async () => {
    const { socket: host, code } = await createTestRoom(harness);
    const [p2, p3] = await addTestPlayers(harness, code, ["B", "C"]);
    await startPlayingMatch(harness, host, code, [p2, p3]);
    const room = harness.getRooms().get(code);
    const t = Date.now();
    room.activeBlinks.set("0,0", { x: 0, y: 0, type: "normal", expiresAt: t + 60_000, spawnedAt: t });
    room.activeBlinks.set("1,1", { x: 1, y: 1, type: "normal", expiresAt: t + 60_000, spawnedAt: t });
    room.activeBlinks.set("2,2", { x: 2, y: 2, type: "normal", expiresAt: t + 60_000, spawnedAt: t });
    broadcastGame(room);

    const c1 = waitForSocketEvent(host, "tileClaimed");
    const c2 = waitForSocketEvent(p2, "tileClaimed");
    const c3 = waitForSocketEvent(p3, "tileClaimed");
    simulateTileClick(host, 0, 0);
    simulateTileClick(p2, 1, 1);
    simulateTileClick(p3, 2, 2);
    await Promise.all([c1, c2, c3]);
    await new Promise((r) => setImmediate(r));

    const snap = harness.getRooms().get(code);
    const owners = new Set([snap.cells[0][0].ownerId, snap.cells[1][1].ownerId, snap.cells[2][2].ownerId]);
    expect(owners.size).toBe(3);
    host.disconnect();
    p2.disconnect();
    p3.disconnect();
  });

  test("Case 3: frozen player cannot claim; after tick clears freezeUntil, tap succeeds (~1s window)", async () => {
    const { socket: host, code } = await createTestRoom(harness);
    const [p2] = await addTestPlayers(harness, code, ["Victim"]);
    await startPlayingMatch(harness, host, code, [p2]);
    const room = harness.getRooms().get(code);
    const victim = findHumanBySocket(room, p2);
    const t = Date.now();
    room.activeBlinks.set("1,1", { x: 1, y: 1, type: "normal", expiresAt: t + 60_000, spawnedAt: t });
    broadcastGame(room);

    victim.frozenUntil = t + 60_000;
    let claimedWhileFrozen = false;
    p2.once("tileClaimed", () => {
      claimedWhileFrozen = true;
    });
    simulateTileClick(p2, 1, 1);
    await new Promise((r) => setTimeout(r, 40));
    expect(claimedWhileFrozen).toBe(false);

    victim.frozenUntil = t - 50;
    tickPlayingRoom(room);
    expect(victim.frozenUntil).toBe(0);

    broadcastGame(room);
    const claimP = waitForSocketEvent(p2, "tileClaimed", { timeoutMs: 3000 });
    simulateTileClick(p2, 1, 1);
    await claimP;
    await new Promise((r) => setImmediate(r));
    expect(harness.getRooms().get(code).cells[1][1].ownerId).toBe(p2.id);

    host.disconnect();
    p2.disconnect();
  });

  test("Case 3b: freeze tile freezes others ~1s (not claimer)", async () => {
    const { socket: host, code } = await createTestRoom(harness);
    const [p2] = await addTestPlayers(harness, code, ["Rival"]);
    await startPlayingMatch(harness, host, code, [p2]);
    const room = harness.getRooms().get(code);
    const t = Date.now();
    room.activeBlinks.set("3,3", { x: 3, y: 3, type: "freeze", expiresAt: t + 60_000, spawnedAt: t });
    broadcastGame(room);
    simulateTileClick(host, 3, 3);
    await new Promise((r) => setImmediate(r));
    const hostP = findHumanBySocket(room, host);
    const rival = findHumanBySocket(room, p2);
    expect(hostP.frozenUntil).toBe(0);
    const span = rival.frozenUntil - Date.now();
    expect(span).toBeGreaterThan(400);
    expect(span).toBeLessThanOrEqual(1100);
    host.disconnect();
    p2.disconnect();
  });

  for (const [size, x, y] of [
    [5, 4, 4],
    [6, 5, 5],
    [16, 15, 15],
  ]) {
    test(`Case 4: grid ${size}×${size} — tile (${x},${y}) maps correctly`, async () => {
      const { socket: host, code } = await createTestRoom(harness, { gridSize: size });
      await startPlayingMatch(harness, host, code, []);
      const room = harness.getRooms().get(code);
      expect(room.cells.length).toBe(size);
      const t = Date.now();
      room.activeBlinks.set(`${x},${y}`, { x, y, type: "normal", expiresAt: t + 60_000, spawnedAt: t });
      broadcastGame(room);
      const claimP = waitForSocketEvent(host, "tileClaimed");
      simulateTileClick(host, x, y);
      await claimP;
      await new Promise((r) => setImmediate(r));
      expect(harness.getRooms().get(code).cells[y][x].ownerId).toBe(host.id);
      host.disconnect();
    });
  }

  test("Part 4: simulated user — join, start, multi-tap log", async () => {
    const lines = [];
    const log = (msg, extra) => {
      lines.push(extra != null ? `${msg} ${JSON.stringify(extra)}` : msg);
    };

    const { socket: host, code } = await createTestRoom(harness, { name: "SimUser" });
    log("create_ok", { code });
    await startPlayingMatch(harness, host, code, []);
    log("playing_ok", { phase: "playing" });

    const room = harness.getRooms().get(code);
    const t = Date.now();
    room.activeBlinks.set("0,1", { x: 0, y: 1, type: "normal", expiresAt: t + 60_000, spawnedAt: t });
    room.activeBlinks.set("2,0", { x: 2, y: 0, type: "normal", expiresAt: t + 60_000, spawnedAt: t });
    broadcastGame(room);

    let claims = 0;
    host.on("tileClaimed", () => {
      claims += 1;
      log("tileClaimed_event", { count: claims });
    });
    let misses = 0;
    host.on("game:miss", () => {
      misses += 1;
      log("game_miss_event", { count: misses });
    });

    const claim1 = waitForSocketEvent(host, "tileClaimed");
    simulateTileClick(host, 0, 1);
    await claim1;
    log("after_first_tap", { claims, misses, owner: room.cells[1][0].ownerId });

    await new Promise((r) => setTimeout(r, 120));
    const claim2 = waitForSocketEvent(host, "tileClaimed");
    simulateTileClick(host, 2, 0);
    await claim2;
    log("after_second_tap", { claims, misses });

    await new Promise((r) => setTimeout(r, 120));
    const missP = waitForSocketEvent(host, "game:miss", { timeoutMs: 3000 });
    simulateTileClick(host, 0, 0);
    await missP;
    log("after_miss_tap_empty_cell", { claims, misses });

    // eslint-disable-next-line no-console
    console.log("[SimulatedUser]\n" + lines.join("\n"));

    expect(claims).toBe(2);
    expect(misses).toBeGreaterThanOrEqual(1);
    expect(lines.some((l) => l.includes("after_first_tap"))).toBe(true);
    host.disconnect();
  });
});

/**
 * Socket.io browser client (not served as /socket.io/socket.io.js on static hosts like Vercel).
 * Pinned version matches server dependency.
 */
import { io as ioClient } from "https://esm.sh/socket.io-client@4.8.1";

function createNoopAudio() {
  const noop = () => {};
  const asyncNoop = async () => {};
  return {
    loadSoundPreference: () => true,
    saveSoundPreference: noop,
    initAudioGraph: noop,
    resumeAudioFromUserGesture: asyncNoop,
    startBackgroundMusic: asyncNoop,
    stopBackgroundMusic: noop,
    setSoundEnabled: asyncNoop,
    playSfx: asyncNoop,
    setMatchMusicPhase: noop,
  };
}

let Audio;
try {
  Audio = await import("./audio-engine.js");
} catch (err) {
  console.warn("BlinkGrid: audio-engine.js failed to load — continuing without music/SFX", err);
  Audio = createNoopAudio();
}

let socket = null;
/** Last Engine.IO / transport error (for user-facing messages). */
let lastSocketConnectError = null;
/** Set from create/join ack before `socket.id` is available on the client. */
let mySocketId = null;

function readBlinkgridMeta(name) {
  if (name === "blinkgrid-socket-url") {
    try {
      const q = new URLSearchParams(location.search).get("socketUrl");
      if (q) {
        const dec = decodeURIComponent(q.trim());
        if (dec.startsWith("http://") || dec.startsWith("https://")) {
          return dec.replace(/\/+$/, "");
        }
      }
    } catch {
      /* ignore */
    }
    const injected = String(globalThis.__BLINKGRID_SOCKET_URL__ ?? "").trim();
    if (injected) {
      return injected.replace(/\/+$/, "");
    }
  }
  const el = document.querySelector(`meta[name="${name}"]`);
  return (el?.getAttribute("content") ?? "").trim();
}

function setNetStatusBanner(show, message) {
  const el = document.getElementById("net-banner");
  if (!el) return;
  if (show && message) {
    el.textContent = message;
    el.removeAttribute("hidden");
  } else {
    el.setAttribute("hidden", "");
    el.textContent = "";
  }
}

function buildSocketIoClientOptions() {
  const url = readBlinkgridMeta("blinkgrid-socket-url");
  const pathRaw = readBlinkgridMeta("blinkgrid-socket-path");
  const opts = {
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: 15,
    reconnectionDelay: 600,
    reconnectionDelayMax: 10000,
    timeout: 20000,
  };
  if (pathRaw) {
    let p = pathRaw.startsWith("/") ? pathRaw : `/${pathRaw}`;
    p = p.replace(/\/+$/, "");
    opts.path = p.endsWith("/socket.io") ? p : `${p}/socket.io`;
  }
  return { url: url || undefined, opts };
}

function waitForSocketReady(sock, timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (!sock) {
      resolve(false);
      return;
    }
    if (sock.connected) {
      resolve(true);
      return;
    }
    const done = () => {
      sock.off("connect", onConnect);
      clearTimeout(timer);
    };
    const onConnect = () => {
      done();
      resolve(true);
    };
    const timer = window.setTimeout(() => {
      sock.off("connect", onConnect);
      resolve(false);
    }, timeoutMs);
    sock.once("connect", onConnect);
  });
}

function selfId() {
  return mySocketId ?? socket?.id ?? null;
}

/** If client id is out of sync but we're clearly the only human, adopt that id (fixes stuck lobby / grid). */
function reconcileMySocketId(room) {
  if (!room?.players?.length) return;
  const cur = selfId();
  if (cur && room.players.some((p) => p.id === cur)) return;
  const humans = room.players.filter((p) => !p.isBot);
  if (humans.length === 1) {
    mySocketId = humans[0].id;
  }
}

function lobbyMe(room) {
  if (!room?.players) return null;
  reconcileMySocketId(room);
  return room.players.find((p) => p.id === selfId()) || null;
}

function lobbyIsHost(room) {
  if (!room) return false;
  const me = lobbyMe(room);
  return !!(me?.isHost || room.hostId === selfId());
}

let roomState = null;
let gameState = null;
let lastRanking = [];
/** @type {string | null} */
let lastGameEndReason = null;
let clockSkew = 0;
let readyHeld = false;
let audioUnlockStarted = false;

let lastComboSeen = 1;

/** Cached grid buttons; rebuilt when board size changes. */
/** @type {HTMLButtonElement[][] | null} */
let gameBoardCells = null;
let gameBoardN = 0;

function gameCellAt(x, y) {
  return gameBoardCells?.[y]?.[x] ?? null;
}

function resetGameBoardCache() {
  gameBoardCells = null;
  gameBoardN = 0;
}

const TAP_CLIENT_DEBUG =
  typeof location !== "undefined" &&
  (/\bdebug=tap\b/.test(location.search) || globalThis.localStorage?.getItem("blinkgridDebugTap") === "1");

const GAMEPLAY_DEBUG =
  typeof location !== "undefined" &&
  (/\bdebug=game\b/.test(location.search) || globalThis.localStorage?.getItem("blinkgridDebugGameplay") === "1");

function tapClientDbg(label, data) {
  if (!TAP_CLIENT_DEBUG) return;
  console.debug(`[BlinkGrid:client] ${label}`, data ?? "");
}

function gameplayDbg(label, data) {
  if (!GAMEPLAY_DEBUG) return;
  console.debug(`[BlinkGrid:gameplay] ${label}`, data ?? "");
}

function applyTileClaimedToUi({ x, y, playerId, colorHex }) {
  if (!gameState?.cells?.[y]?.[x]) return;
  gameState.cells[y][x].ownerId = playerId;
  const pl = gameState.players?.find((p) => p.id === playerId);
  const hex = colorHex || pl?.colorHex;
  const cell = gameCellAt(x, y) || document.querySelector(`#game-grid .cell[data-x="${x}"][data-y="${y}"]`);
  if (!cell) return;
  cell.classList.remove(
    "cell--blink",
    "cell--blink-urgent",
    "cell--telegraph",
    "cell--zap",
    "cell--trap",
    "cell--freeze",
    "cell--streak",
    "cell--shuffle",
    "cell--magnet",
  );
  cell.innerHTML = "";
  if (hex) cell.style.background = hex;
  cell.classList.add("cell--claimed-pop");
  window.setTimeout(() => cell.classList.remove("cell--claimed-pop"), 380);
  tapClientDbg("tile_ui_updated", { x, y, playerId, colorHex: hex });
  gameplayDbg("tile_ui_updated", { x, y, playerId, colorHex: hex });
}

function initGameGridTap() {
  const grid = document.getElementById("game-grid");
  if (!grid || grid.dataset.tapBound === "1") return;
  grid.dataset.tapBound = "1";
  grid.addEventListener(
    "pointerdown",
    (e) => {
      const btn = e.target.closest?.(".cell");
      if (!btn || gameState?.phase !== "playing") return;
      const x = Number(btn.dataset.x);
      const y = Number(btn.dataset.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      void (async () => {
        await ensureAudioUnlocked();
        const tileId = `${x},${y}`;
        tapClientDbg("emit_tileClick", { tileId });
        gameplayDbg("emit_tileClick", { tileId, selfId: selfId() });
        ensureSocket()?.emit("tileClick", { tileId });
      })();
    },
    { passive: true },
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initGameGridTap);
} else {
  initGameGridTap();
}

function syncSoundUi() {
  const on = Audio.loadSoundPreference();
  document.body.classList.toggle("sound-off", !on);
  document.getElementById("btn-sound")?.setAttribute("aria-pressed", String(!on));
  const set = document.getElementById("set-sound");
  if (set) set.checked = on;
}

async function ensureAudioUnlocked() {
  Audio.initAudioGraph();
  await Audio.resumeAudioFromUserGesture();
  if (!audioUnlockStarted) {
    audioUnlockStarted = true;
  }
  if (Audio.loadSoundPreference() && getActiveView() === "game" && gameState?.phase === "playing") {
    await Audio.startBackgroundMusic();
  }
}

document.body.addEventListener("pointerdown", () => {
  void ensureAudioUnlocked();
}, { passive: true });

const views = {
  landing: document.getElementById("view-landing"),
  join: document.getElementById("view-join"),
  lobby: document.getElementById("view-lobby"),
  how: document.getElementById("view-how"),
  settings: document.getElementById("view-settings"),
  about: document.getElementById("view-about"),
  game: document.getElementById("view-game"),
  results: document.getElementById("view-results"),
};

function ensureSocket() {
  if (socket) return socket;
  const { url, opts } = buildSocketIoClientOptions();
  socket = url ? ioClient(url, opts) : ioClient(opts);
  socket.on("connect", () => {
    lastSocketConnectError = null;
    mySocketId = socket.id;
    setNetStatusBanner(false, "");
  });
  socket.on("disconnect", (reason) => {
    if (reason === "io client disconnect") return;
    const v = getActiveView();
    if (v === "game" || v === "lobby" || v === "join" || v === "results") {
      setNetStatusBanner(true, "Connection lost — reconnecting…");
    }
  });
  socket.on("connect_error", (err) => {
    lastSocketConnectError = err?.message || String(err);
  });
  socket.on("room:update", (payload) => {
    roomState = payload;
    if (payload.phase === "lobby") {
      reconcileMySocketId(payload);
      Audio.stopBackgroundMusic();
      const v = getActiveView();
      if (v === "results" || v === "game") showView("lobby");
      renderLobby();
      return;
    }
    if (getActiveView() === "lobby") {
      reconcileMySocketId(payload);
      renderLobby();
    }
  });
  socket.on("game:update", (payload) => {
    if (typeof payload.serverNow === "number" && Number.isFinite(payload.serverNow)) {
      clockSkew = payload.serverNow - Date.now();
    }
    gameState = payload;
    tapClientDbg("game_update", { phase: payload.phase, hasCells: !!payload.cells });
    if (payload.phase === "playing") {
      if (getActiveView() !== "game") showView("game");
      renderGame();
      tickTimer();
      if (Audio.loadSoundPreference()) {
        void (async () => {
          await Audio.resumeAudioFromUserGesture();
          await Audio.startBackgroundMusic();
        })();
      }
    } else {
      if (typeof Audio.setMatchMusicPhase === "function") Audio.setMatchMusicPhase("normal");
    }
  });
  socket.on("game:over", async ({ ranking, reason }) => {
    lastRanking = ranking || [];
    lastGameEndReason = typeof reason === "string" ? reason : null;
    lastComboSeen = 1;
    if (typeof Audio.setMatchMusicPhase === "function") Audio.setMatchMusicPhase("normal");
    Audio.stopBackgroundMusic();
    await Audio.playSfx("gameover");
    showView("results");
    renderResults();
  });
  socket.on("game:tapFeedback", (payload) => {
    tapClientDbg("tap_feedback", payload);
    showTapFloat(payload);
    const isSelf = payload.playerId === selfId();
    const k = payload.kind;
    if (k === "double") void Audio.playSfx("double");
    else if (k === "trap") void Audio.playSfx("trap");
    else if (k === "freeze") void Audio.playSfx("freeze");
    else if (k === "streak") void Audio.playSfx("streak");
    else if (k === "shuffle") void Audio.playSfx("shuffle");
    else if (k === "magnet") void Audio.playSfx("magnet");
    else void Audio.playSfx("tap");
    if (isSelf && payload.combo > lastComboSeen && payload.combo > 1 && payload.gained > 0) {
      void Audio.playSfx("combo");
    }
    if (isSelf) lastComboSeen = payload.combo || 1;
    if (payload.gained > 0 && isSelf) shakeBoard();
    pulseCell(payload.x, payload.y, payload.colorHex);
    if (payload.playerName && payload.gained > 0 && !isSelf) {
      flashGameToast(`${escapeHtml(String(payload.playerName))} +${payload.gained}`);
    }
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      try {
        navigator.vibrate(payload.gained < 0 ? [8, 30, 8] : 12);
      } catch {
        /* ignore */
      }
    }
  });
  socket.on("game:miss", (payload) => {
    lastComboSeen = 1;
    gameplayDbg("game_miss", payload ?? {});
    const x = Number(payload?.x);
    const y = Number(payload?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    void Audio.playSfx("miss");
    const cell = gameCellAt(x, y) || document.querySelector(`#game-grid .cell[data-x="${x}"][data-y="${y}"]`);
    if (cell) {
      cell.classList.remove("cell--miss");
      void cell.offsetWidth;
      cell.classList.add("cell--miss");
      window.setTimeout(() => cell.classList.remove("cell--miss"), 400);
    }
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      try {
        navigator.vibrate(6);
      } catch {
        /* ignore */
      }
    }
  });
  socket.on("tileClaimed", (payload) => {
    tapClientDbg("tileClaimed", payload);
    gameplayDbg("tileClaimed", payload);
    applyTileClaimedToUi(payload);
  });
  socket.on("rematch:votes", ({ votes, need }) => {
    const el = document.getElementById("rematch-votes");
    if (el) el.textContent = `${votes} / ${need} players voted rematch`;
  });
  return socket;
}

function getActiveView() {
  for (const [k, el] of Object.entries(views)) {
    if (el?.classList.contains("view--active")) return k;
  }
  return null;
}

function showView(name) {
  for (const [k, el] of Object.entries(views)) {
    if (!el) continue;
    el.classList.toggle("view--active", k === name);
  }
}

function serverNow() {
  return Date.now() + clockSkew;
}

syncSoundUi();

const LS_TILE_PATTERNS = "blinkgridTilePatterns";

function loadTilePatternsPref() {
  try {
    return globalThis.localStorage?.getItem(LS_TILE_PATTERNS) === "1";
  } catch {
    return false;
  }
}

function saveTilePatternsPref(on) {
  try {
    if (on) globalThis.localStorage?.setItem(LS_TILE_PATTERNS, "1");
    else globalThis.localStorage?.removeItem(LS_TILE_PATTERNS);
  } catch {
    /* ignore */
  }
}

function syncPatternsUi() {
  const on = loadTilePatternsPref();
  document.body.classList.toggle("tile-patterns", on);
  const el = document.getElementById("set-patterns");
  if (el) el.checked = on;
}

syncPatternsUi();

document.getElementById("set-patterns")?.addEventListener("change", (e) => {
  saveTilePatternsPref(!!e.target.checked);
  syncPatternsUi();
});

document.getElementById("btn-copy-invite")?.addEventListener("click", async () => {
  const code = document.getElementById("lobby-code")?.textContent?.trim();
  if (!code || code.includes("-")) return;
  try {
    const u = new URL(location.href);
    u.searchParams.set("join", code);
    await navigator.clipboard.writeText(u.toString());
  } catch {
    /* ignore */
  }
});
document.getElementById("btn-play-now")?.addEventListener("click", () => {
  ensureAudioUnlocked();
  document.getElementById("modal-name-error")?.setAttribute("hidden", "");
  document.getElementById("modal-name")?.removeAttribute("hidden");
});

document.getElementById("modal-name-cancel")?.addEventListener("click", () => {
  document.getElementById("modal-name-error")?.setAttribute("hidden", "");
  document.getElementById("modal-name")?.setAttribute("hidden", "");
});

document.getElementById("btn-join-code")?.addEventListener("click", () => {
  ensureAudioUnlocked();
  showView("join");
  document.getElementById("join-error")?.setAttribute("hidden", "");
});

document.querySelectorAll("[data-back]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const dest = btn.getAttribute("data-back");
    showView(dest || "landing");
  });
});

document.getElementById("btn-how")?.addEventListener("click", () => showView("how"));
document.getElementById("btn-settings")?.addEventListener("click", () => {
  showView("settings");
  syncSoundUi();
  syncPatternsUi();
});
document.getElementById("btn-about")?.addEventListener("click", () => showView("about"));

document.getElementById("btn-sound")?.addEventListener("click", async () => {
  await Audio.setSoundEnabled(!Audio.loadSoundPreference());
  syncSoundUi();
});

document.getElementById("set-sound")?.addEventListener("change", async (e) => {
  await Audio.setSoundEnabled(!!e.target.checked);
  syncSoundUi();
});

/* ---------- Name modal / create ---------- */
document.getElementById("modal-name-go")?.addEventListener("click", () => {
  void (async () => {
    ensureAudioUnlocked();
    const errEl = document.getElementById("modal-name-error");
    errEl?.setAttribute("hidden", "");
    const name = document.getElementById("create-name")?.value?.trim() || "Player";
    const s = ensureSocket();
    if (!s) {
      if (errEl) {
        errEl.textContent = "Could not load multiplayer client. Refresh the page.";
        errEl.removeAttribute("hidden");
      }
      return;
    }
    const connected = await waitForSocketReady(s);
    if (!connected) {
      if (errEl) {
        errEl.textContent =
          lastSocketConnectError ||
          "Could not connect to the game server. On Vercel, set meta blinkgrid-socket-url to your Node API (see README).";
        errEl.removeAttribute("hidden");
      }
      return;
    }
    const ACK_MS = 12000;
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      if (errEl) {
        errEl.textContent = "Server did not respond. Try again or check your network.";
        errEl.removeAttribute("hidden");
      }
    }, ACK_MS);
    s.emit("room:create", { name }, (res) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (!res?.ok) {
        if (errEl) {
          errEl.textContent = res?.error || "Could not create room";
          errEl.removeAttribute("hidden");
        }
        return;
      }
      if (typeof res.yourId === "string") mySocketId = res.yourId;
      roomState = res.room;
      document.getElementById("modal-name")?.setAttribute("hidden", "");
      showView("lobby");
      renderLobby();
    });
  })();
});

/* ---------- Join ---------- */
document.getElementById("btn-join-room")?.addEventListener("click", () => {
  void (async () => {
    await ensureAudioUnlocked();
    const err = document.getElementById("join-error");
    err?.setAttribute("hidden", "");
    const name = document.getElementById("join-name")?.value?.trim() || "Player";
    const code = document.getElementById("join-code")?.value?.trim() || "";
    const s = ensureSocket();
    if (!s) {
      if (err) {
        err.textContent = "Could not load multiplayer client. Refresh the page.";
        err.removeAttribute("hidden");
      }
      return;
    }
    const connected = await waitForSocketReady(s);
    if (!connected) {
      if (err) {
        err.textContent =
          lastSocketConnectError ||
          "Could not connect to the game server. On Vercel, set BLINKGRID_SOCKET_URL at build time or meta blinkgrid-socket-url (see README).";
        err.removeAttribute("hidden");
      }
      return;
    }
    s.emit("room:join", { code, name }, (res) => {
      if (!res?.ok) {
        if (err) {
          err.textContent = res?.error || "Could not join";
          err.removeAttribute("hidden");
        }
        return;
      }
      if (typeof res.yourId === "string") mySocketId = res.yourId;
      roomState = res.room;
      showView("lobby");
      renderLobby();
    });
  })();
});

/* ---------- Lobby ---------- */
function renderLobby() {
  if (!roomState) return;
  reconcileMySocketId(roomState);
  const codeEl = document.getElementById("lobby-code");
  if (codeEl) codeEl.textContent = roomState.code || "-----";
  const you = document.getElementById("lobby-you");
  if (you) {
    const me = lobbyMe(roomState);
    you.textContent = me ? `You are ${me.name}` : "";
  }

  const gs = Number(roomState.gridSize) || 5;
  const seg = document.getElementById("grid-seg");
  if (seg) {
    const isHost = lobbyIsHost(roomState);
    const locked = !isHost || roomState.phase !== "lobby";
    seg.querySelectorAll(".seg__btn").forEach((b) => {
      b.classList.toggle("seg__btn--active", Number(b.dataset.size) === gs);
      b.classList.toggle("seg__btn--locked", locked);
      b.setAttribute("aria-disabled", String(locked));
      b.disabled = false;
      b.tabIndex = locked ? -1 : 0;
    });
  }

  const dur = Number(roomState.matchDurationMs) || 60_000;
  const timeSeg = document.getElementById("time-seg");
  if (timeSeg) {
    const isHost = lobbyIsHost(roomState);
    const locked = !isHost || roomState.phase !== "lobby";
    timeSeg.querySelectorAll(".seg__btn").forEach((b) => {
      const ms = Number(b.dataset.durationMs);
      b.classList.toggle("seg__btn--active", Number.isFinite(ms) && ms === dur);
      b.classList.toggle("seg__btn--locked", locked);
      b.setAttribute("aria-disabled", String(locked));
      b.disabled = false;
      b.tabIndex = locked ? -1 : 0;
    });
  }

  const list = document.getElementById("lobby-players");
  if (list) {
    list.innerHTML = "";
    const slots = 6;
    for (let i = 0; i < slots; i++) {
      const p = roomState.players?.[i];
      const li = document.createElement("li");
      li.className = "player-row";
      if (!p) {
        li.innerHTML = `<span class="player-row__dot" style="background:#334155"></span>
          <span class="player-row__name muted">Empty slot</span>
          <span class="player-row__status player-row__status--not">—</span>`;
      } else {
        const crown = p.isHost ? `<span class="player-row__badge" title="Host">👑</span>` : "";
        const st = p.ready
          ? `<span class="player-row__status player-row__status--ready">READY</span>`
          : `<span class="player-row__status player-row__status--not">NOT READY</span>`;
        li.innerHTML = `<span class="player-row__dot" style="background:${p.colorHex}"></span>
          <span class="player-row__name">${escapeHtml(p.name)}${crown}</span>
          ${st}`;
      }
      list.appendChild(li);
    }
  }

  const me = lobbyMe(roomState);
  readyHeld = !!me?.ready;
  const btnReady = document.getElementById("btn-ready");
  if (btnReady) {
    btnReady.textContent = readyHeld ? "UNREADY" : "READY";
    btnReady.classList.toggle("btn--secondary", !readyHeld);
  }

  const btnStart = document.getElementById("btn-start");
  if (btnStart) {
    const isHost = lobbyIsHost(roomState);
    const allReady = (roomState.players || []).length >= 1 && (roomState.players || []).every((p) => p.ready);
    btnStart.hidden = !isHost;
    btnStart.disabled = !allReady;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shakeBoard() {
  const v = document.getElementById("view-game");
  if (!v) return;
  v.classList.add("view--shake");
  window.setTimeout(() => v.classList.remove("view--shake"), 320);
}

function pulseCell(x, y, colorHex) {
  const cell = gameCellAt(x, y) || document.querySelector(`#game-grid .cell[data-x="${x}"][data-y="${y}"]`);
  if (!cell || !colorHex) return;
  cell.classList.add("cell--ripple");
  cell.style.setProperty("--ripple", colorHex);
  window.setTimeout(() => {
    cell.classList.remove("cell--ripple");
    cell.style.removeProperty("--ripple");
  }, 420);
}

function flashGameToast(html) {
  const t = document.getElementById("game-toast");
  if (!t) return;
  t.innerHTML = html;
  t.removeAttribute("hidden");
  window.setTimeout(() => {
    t.setAttribute("hidden", "");
    t.textContent = "";
  }, 1400);
}

document.getElementById("btn-copy-code")?.addEventListener("click", async () => {
  const t = document.getElementById("lobby-code")?.textContent?.trim();
  if (!t || t.includes("-")) return;
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    /* ignore */
  }
});

function onLobbyGridPick(e) {
  const btn = e.target.closest?.(".seg__btn");
  if (!btn || !roomState || roomState.phase !== "lobby") return;
  if (btn.classList.contains("seg__btn--locked")) return;
  const size = Number(btn.dataset.size);
  if (![5, 6, 7, 10, 16].includes(size)) return;
  ensureSocket()?.emit("room:setGrid", { gridSize: size }, (res) => {
    if (!res?.ok && res?.error) {
      const hint = document.getElementById("grid-seg-hint");
      if (hint) {
        hint.textContent = res.error;
        window.setTimeout(() => {
          if (hint) hint.textContent = "";
        }, 2500);
      }
    }
  });
}

const gridSegEl = document.getElementById("grid-seg");
gridSegEl?.addEventListener("pointerdown", onLobbyGridPick, { passive: true });

const LOBBY_MATCH_MS = Object.freeze([90_000, 60_000, 30_000]);

function onLobbyTimePick(e) {
  const btn = e.target.closest?.(".seg__btn");
  if (!btn || !roomState || roomState.phase !== "lobby") return;
  if (btn.classList.contains("seg__btn--locked")) return;
  const ms = Number(btn.dataset.durationMs);
  if (!LOBBY_MATCH_MS.includes(ms)) return;
  ensureSocket()?.emit("room:setMatchDuration", { matchDurationMs: ms }, (res) => {
    if (!res?.ok && res?.error) {
      const hint = document.getElementById("time-seg-hint");
      if (hint) {
        hint.textContent = res.error;
        window.setTimeout(() => {
          if (hint) hint.textContent = "";
        }, 2500);
      }
    }
  });
}

document.getElementById("time-seg")?.addEventListener("pointerdown", onLobbyTimePick, { passive: true });

document.getElementById("btn-ready")?.addEventListener("click", () => {
  readyHeld = !readyHeld;
  ensureSocket()?.emit("room:ready", { ready: readyHeld });
});

document.getElementById("btn-start")?.addEventListener("click", () => {
  ensureSocket()?.emit("game:start");
});

document.getElementById("btn-leave-lobby")?.addEventListener("click", () => {
  ensureSocket()?.emit("room:leave");
  roomState = null;
  resetGameBoardCache();
  showView("landing");
});

/* ---------- Game ---------- */
let timerHandle = null;

function tickTimer() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = setInterval(() => {
    if (getActiveView() !== "game" || !gameState || gameState.phase !== "playing") {
      clearInterval(timerHandle);
      timerHandle = null;
      return;
    }
    updateTimerDisplay();
    updateFreezeOverlay();
    refreshBlinkVisuals();
    refreshBlinkUrgency();
  }, 200);
  updateTimerDisplay();
  updateFreezeOverlay();
  refreshBlinkVisuals();
  refreshBlinkUrgency();
}

function showTapFloat({ x, y, gained, combo, kind }) {
  const wrap = document.querySelector(".grid-wrap");
  if (!wrap || gameState?.phase !== "playing") return;
  const n = gameState.gridSize || 5;
  const el = document.createElement("div");
  let cls = "float-score" + (gained < 0 ? " float-score--neg" : "");
  if (gained > 0) cls += " float-score--pop";
  el.className = cls;
  if (gained === 0 && kind === "freeze") {
    el.textContent = "❄️";
  } else {
    const sign = gained > 0 ? "+" : "";
    el.textContent = sign + String(gained);
    if (combo > 1 && gained > 0) {
      el.textContent += ` ×${combo}`;
    }
  }
  const px = ((x + 0.5) / n) * 100;
  const py = ((y + 0.5) / n) * 100;
  el.style.left = `${px}%`;
  el.style.top = `${py}%`;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 900);
}

function updateTimerDisplay() {
  const el = document.getElementById("game-timer");
  const end = gameState?.gameEndTime ?? gameState?.gameEndsAt;
  if (!el || !end) return;
  const ms = Math.max(0, end - serverNow());
  const sec = Math.ceil(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  el.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  const rush = ms <= 10000 && ms > 0;
  el.classList.toggle("game-timer--rush", rush);
  if (typeof Audio.setMatchMusicPhase === "function") {
    Audio.setMatchMusicPhase(rush ? "final" : "normal");
  }
}

function updateFreezeOverlay() {
  const me = gameState?.players?.find((p) => p.id === selfId());
  const raw = me?.frozenUntil;
  const fu = Number(raw);
  const until = Number.isFinite(fu) && fu > 0 ? fu : 0;
  const t = serverNow();
  const frozen = until > t;
  const ov = document.getElementById("freeze-overlay");
  const cd = document.getElementById("freeze-countdown");
  if (ov) ov.hidden = !frozen;
  if (cd) {
    if (!frozen) {
      cd.textContent = "";
    } else {
      const msLeft = Math.max(0, until - t);
      const s = Math.ceil(msLeft / 1000);
      cd.textContent = s > 0 ? `${s}s` : "";
    }
  }
}

function blinkAt(x, y) {
  return (gameState?.blinks || []).find((b) => b.x === x && b.y === y);
}

function ownerColor(x, y) {
  const row = gameState?.cells?.[y];
  const cell = row?.[x];
  if (!cell?.ownerId) return null;
  const p = gameState.players?.find((pl) => pl.id === cell.ownerId);
  return p?.colorHex || null;
}

const CELL_BLINK_CLASSES = [
  "cell--blink",
  "cell--blink-urgent",
  "cell--telegraph",
  "cell--zap",
  "cell--trap",
  "cell--freeze",
  "cell--streak",
  "cell--shuffle",
  "cell--magnet",
];

function stripBlinkFromCell(btn) {
  btn.classList.remove(...CELL_BLINK_CLASSES);
  btn.removeAttribute("aria-label");
  btn.innerHTML = "";
}

function blinkAriaLabel(type) {
  switch (type) {
    case "double":
      return "Double points blink";
    case "trap":
      return "Trap blink, minus score";
    case "freeze":
      return "Freeze rivals blink";
    case "streak":
      return "Streak combo blink";
    case "shuffle":
      return "Shuffle owners blink";
    case "magnet":
      return "Magnet blink";
    default:
      return "Blinking tile, tap to claim";
  }
}

function syncCellButton(btn, x, y, t) {
  stripBlinkFromCell(btn);
  const oc = ownerColor(x, y);
  if (oc) btn.style.background = oc;
  else btn.style.removeProperty("background");

  const b = blinkAt(x, y);
  if (b && gameState.phase === "playing") {
    const activeFrom = Number(b.activeFrom);
    const telegraph = Number.isFinite(activeFrom) && activeFrom > t;
    if (telegraph) {
      btn.classList.add("cell--telegraph");
      btn.setAttribute("aria-label", "Incoming blink — wait for pulse");
      btn.innerHTML = `<span class="cell__icon cell__icon--tele" aria-hidden="true">◎</span>`;
      return;
    }
    btn.classList.add("cell--blink");
    const spawned = Number(b.spawnedAt);
    const exp = Number(b.expiresAt);
    if (Number.isFinite(spawned) && Number.isFinite(exp) && exp > spawned) {
      const life = (exp - t) / (exp - spawned);
      if (life > 0 && life < 0.34) btn.classList.add("cell--blink-urgent");
    }
    btn.setAttribute("aria-label", blinkAriaLabel(b.type));
    if (b.type === "double") {
      btn.classList.add("cell--zap");
      btn.innerHTML = `<span class="cell__icon" aria-hidden="true">⚡</span>`;
    } else if (b.type === "trap") {
      btn.classList.add("cell--trap");
      btn.innerHTML = `<span class="cell__icon" aria-hidden="true">💣</span>`;
    } else if (b.type === "freeze") {
      btn.classList.add("cell--freeze");
      btn.innerHTML = `<span class="cell__icon" aria-hidden="true">❄️</span>`;
    } else if (b.type === "streak") {
      btn.classList.add("cell--streak");
      btn.innerHTML = `<span class="cell__icon" aria-hidden="true">🔥</span>`;
    } else if (b.type === "shuffle") {
      btn.classList.add("cell--shuffle");
      btn.innerHTML = `<span class="cell__icon" aria-hidden="true">🌀</span>`;
    } else if (b.type === "magnet") {
      btn.classList.add("cell--magnet");
      btn.innerHTML = `<span class="cell__icon" aria-hidden="true">🧲</span>`;
    } else {
      btn.innerHTML = `<span class="cell__icon" style="opacity:0.35" aria-hidden="true">✦</span>`;
    }
  }
}

function ensureGameBoardBuilt() {
  const grid = document.getElementById("game-grid");
  if (!grid || !gameState?.cells) return false;
  const n = gameState.gridSize || 5;
  if (gameBoardCells && gameBoardN === n) return true;

  grid.innerHTML = "";
  gameBoardCells = [];
  gameBoardN = n;
  grid.style.setProperty("--gn", String(n));
  grid.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${n}, 1fr)`;

  for (let y = 0; y < n; y++) {
    const row = [];
    for (let x = 0; x < n; x++) {
      const cellBtn = document.createElement("button");
      cellBtn.type = "button";
      cellBtn.className = "cell";
      cellBtn.dataset.x = String(x);
      cellBtn.dataset.y = String(y);
      row.push(cellBtn);
      grid.appendChild(cellBtn);
    }
    gameBoardCells.push(row);
  }
  return true;
}

function syncGameBoardFromState() {
  if (!ensureGameBoardBuilt()) return;
  const n = gameBoardN;
  const t = serverNow();
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      syncCellButton(gameBoardCells[y][x], x, y, t);
    }
  }
}

/** Updates blink urgency between server frames (no full cell strip). */
function refreshBlinkVisuals() {
  if (!gameBoardCells || gameState?.phase !== "playing") return;
  const n = gameBoardN;
  const t = serverNow();
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (blinkAt(x, y)) syncCellButton(gameBoardCells[y][x], x, y, t);
    }
  }
}

function refreshBlinkUrgency() {
  if (!gameBoardCells || gameState?.phase !== "playing") return;
  const n = gameBoardN;
  const t = serverNow();
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const b = blinkAt(x, y);
      const btn = gameBoardCells[y][x];
      if (!btn || !b) {
        if (btn) btn.classList.remove("cell--blink-urgent");
        continue;
      }
      const spawned = Number(b.spawnedAt);
      const exp = Number(b.expiresAt);
      let urgent = false;
      if (Number.isFinite(spawned) && Number.isFinite(exp) && exp > spawned) {
        const life = (exp - t) / (exp - spawned);
        urgent = life > 0 && life < 0.34;
      }
      btn.classList.toggle("cell--blink-urgent", urgent);
    }
  }
}

function renderGame() {
  renderScoreboard();
  document.getElementById("game-players-n").textContent = String(gameState?.players?.length || 0);
  syncGameBoardFromState();
  updateFreezeOverlay();
}

function renderScoreboard() {
  const sb = document.getElementById("scoreboard");
  if (!sb || !gameState?.players) return;
  sb.innerHTML = "";
  const sorted = [...gameState.players].sort((a, b) => b.score - a.score);
  for (const p of sorted) {
    const row = document.createElement("div");
    row.className = "score-row" + (p.id === selfId() ? " score-row--me" : "");
    const botTag = p.isBot ? " 🤖" : "";
    const combo = Math.max(1, p.combo || 1);
    const comboHtml =
      combo > 1 ? `<span class="score-row__combo" aria-label="Combo">COMBO ×${combo}</span>` : "";
    row.innerHTML = `<span class="score-row__dot" style="background:${p.colorHex}"></span>
      <span class="score-row__mid"><span class="score-row__n">${escapeHtml(p.name)}${botTag}</span>${comboHtml}</span>
      <span class="score-row__s">${p.score}</span>`;
    sb.appendChild(row);
  }
}

document.getElementById("btn-game-menu")?.addEventListener("click", () => {
  document.getElementById("modal-game-menu")?.removeAttribute("hidden");
});
document.getElementById("modal-game-close")?.addEventListener("click", () => {
  document.getElementById("modal-game-menu")?.setAttribute("hidden", "");
});
document.getElementById("btn-forfeit")?.addEventListener("click", () => {
  document.getElementById("modal-game-menu")?.setAttribute("hidden", "");
  if (typeof Audio.setMatchMusicPhase === "function") Audio.setMatchMusicPhase("normal");
  Audio.stopBackgroundMusic();
  ensureSocket()?.emit("room:leave");
  roomState = null;
  gameState = null;
  resetGameBoardCache();
  showView("landing");
});

/* ---------- Results ---------- */
function renderResults() {
  const pod = document.getElementById("podium");
  const tagEl = document.getElementById("results-tag");
  const rv = document.getElementById("rematch-votes");
  if (rv) rv.textContent = "";
  if (!pod) return;
  pod.innerHTML = "";
  const sorted = [...(lastRanking || [])].sort((a, b) => a.rank - b.rank);
  if (sorted.length === 0) return;

  const first = sorted[0];
  const second = sorted[1];
  if (tagEl) {
    if (lastGameEndReason === "grid_full") {
      tagEl.textContent = "Full board — every tile claimed!";
      tagEl.removeAttribute("hidden");
    } else if (first && second && sorted.length >= 2) {
      const gap = first.score - second.score;
      if (gap <= 5 && first.score > 0) {
        tagEl.textContent = "Close match!";
        tagEl.removeAttribute("hidden");
      } else if (second.score > 0 && first.score >= second.score * 2) {
        tagEl.textContent = "Dominating!";
        tagEl.removeAttribute("hidden");
      } else {
        tagEl.textContent = "";
        tagEl.setAttribute("hidden", "");
      }
    } else {
      tagEl.setAttribute("hidden", "");
    }
  }

  const secondRow = sorted[1];
  const firstRow = sorted[0];
  const third = sorted[2];
  const rest = sorted.slice(3);

  const append = (r, cls) => {
    if (!r) return;
    const card = document.createElement("div");
    card.className = `podium__card ${cls}`;
    if (r.rank <= 3) card.classList.add("podium__card--sparkle");
    const crown = r.rank === 1 ? `<div class="podium__crown podium__crown--anim">👑</div>` : "";
    const botTag = r.isBot ? " 🤖" : "";
    card.innerHTML = `${crown}
      <div class="podium__dot" style="background:${r.colorHex}"></div>
      <div class="podium__name">${escapeHtml(r.name)}${botTag}</div>
      <div class="podium__pts">${r.score} pts</div>`;
    pod.appendChild(card);
  };

  append(secondRow, "podium__card--2");
  append(firstRow, "podium__card--1");
  append(third, "podium__card--3");
  for (const r of rest) append(r, "podium__card--4");
}

document.getElementById("btn-rematch")?.addEventListener("click", () => {
  ensureSocket()?.emit("room:rematchVote");
});

document.getElementById("btn-play-again")?.addEventListener("click", () => {
  ensureSocket()?.emit("room:backToLobby");
  showView("lobby");
});

/* ---------- Invite URL (?join=CODE), tutorial ---------- */
function applyInviteLinkQuery() {
  try {
    const p = new URLSearchParams(location.search);
    const raw = p.get("join") || p.get("room");
    if (!raw) return;
    const cleaned = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
    if (cleaned.length < 3) return;
    const inp = document.getElementById("join-code");
    if (inp) inp.value = cleaned;
    showView("join");
    document.getElementById("join-error")?.setAttribute("hidden", "");
  } catch {
    /* ignore */
  }
}

applyInviteLinkQuery();

const TUTORIAL_LS = "blinkgridTutorialDone";
const TUTORIAL_STEPS = [
  {
    title: "Blink Grid in seconds",
    body: "Shared board, fast rounds. Tiles flash where points are up for grabs — stay centered on the grid.",
  },
  {
    title: "Tap to claim",
    body: "Hit a tile while it is pulsing to paint it your color and score. Chain quick taps within half a second for combo bonus.",
  },
  {
    title: "Telegraph & specials",
    body: "Each blink gives a short dim preview ring before it counts — react when it lights up. Lightning doubles, bombs sting, ice freezes rivals.",
  },
  {
    title: "Play together",
    body: "Copy your room code or the invite link from the lobby. Friends open the link and paste nothing — the code is filled in.",
  },
];

let tutorialStepIndex = 0;

function closeTutorial() {
  const ov = document.getElementById("tutorial-overlay");
  if (ov) ov.hidden = true;
  document.body.classList.remove("tutorial-active");
  try {
    globalThis.localStorage?.setItem(TUTORIAL_LS, "1");
  } catch {
    /* ignore */
  }
}

function renderTutorialStep() {
  const step = TUTORIAL_STEPS[tutorialStepIndex];
  const title = document.getElementById("tutorial-title");
  const body = document.getElementById("tutorial-body");
  const badge = document.getElementById("tutorial-step-label");
  const fill = document.getElementById("tutorial-progress-fill");
  const dots = document.getElementById("tutorial-dots");
  if (!step || !title || !body) return;
  title.textContent = step.title;
  body.textContent = step.body;
  if (badge) badge.textContent = `Step ${tutorialStepIndex + 1} of ${TUTORIAL_STEPS.length}`;
  if (fill) {
    fill.classList.remove("tutorial-overlay__progress-fill--run");
    fill.style.width = `${((tutorialStepIndex + 1) / TUTORIAL_STEPS.length) * 100}%`;
  }
  if (dots) {
    dots.innerHTML = "";
    for (let i = 0; i < TUTORIAL_STEPS.length; i++) {
      const d = document.createElement("span");
      d.className =
        "tutorial-overlay__dot" + (i === tutorialStepIndex ? " tutorial-overlay__dot--active" : "");
      dots.appendChild(d);
    }
  }
}

function openTutorial() {
  const ov = document.getElementById("tutorial-overlay");
  if (!ov) return;
  tutorialStepIndex = 0;
  ov.hidden = false;
  document.body.classList.add("tutorial-active");
  renderTutorialStep();
}

function tutorialAdvance() {
  tutorialStepIndex++;
  if (tutorialStepIndex >= TUTORIAL_STEPS.length) closeTutorial();
  else renderTutorialStep();
}

function maybeAutoTutorial() {
  try {
    if (globalThis.localStorage?.getItem(TUTORIAL_LS) === "1") return;
  } catch {
    /* ignore */
  }
  if (getActiveView() !== "landing") return;
  window.setTimeout(() => {
    if (getActiveView() !== "landing") return;
    openTutorial();
  }, 450);
}

document.getElementById("tutorial-next")?.addEventListener("click", tutorialAdvance);
document.getElementById("tutorial-skip")?.addEventListener("click", closeTutorial);
document.getElementById("btn-replay-tutorial")?.addEventListener("click", () => {
  try {
    globalThis.localStorage?.removeItem(TUTORIAL_LS);
  } catch {
    /* ignore */
  }
  showView("landing");
  openTutorial();
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", maybeAutoTutorial);
} else {
  maybeAutoTutorial();
}

/**
 * BlinkGrid audio: Web Audio background loop + synthesized SFX.
 * No external assets required (instant start). Optional CDN clips can be layered later.
 */

const STORAGE_KEY = "blinkgrid_sound_v1";

let audioCtx = null;
let masterGain = null;
let musicGain = null;
let sfxGain = null;
let musicLoopTimer = null;
let variationTimer = null;
/** @type {"normal"|"final"} */
let matchMusicPhase = "normal";
/** Fires when the context finally reaches "running" (browser autoplay unlock). */
let pendingMusicListener = null;

const C_MAJOR = [261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88];

export function loadSoundPreference() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return true;
    const v = JSON.parse(raw);
    return v.enabled !== false;
  } catch {
    return true;
  }
}

export function saveSoundPreference(enabled) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: !!enabled }));
  } catch {
    /* private mode */
  }
}

function playNote(freq, start, duration, type, vol, destNode) {
  if (!audioCtx || !destNode) return;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(vol, start + 0.012);
  g.gain.exponentialRampToValueAtTime(0.001, start + duration);
  osc.connect(g).connect(destNode);
  osc.start(start);
  osc.stop(start + duration + 0.04);
}

export function initAudioGraph() {
  if (audioCtx) return audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  audioCtx = new Ctx();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.2;
  musicGain = audioCtx.createGain();
  musicGain.gain.value = 0.5;
  sfxGain = audioCtx.createGain();
  sfxGain.gain.value = 0.85;
  musicGain.connect(masterGain);
  sfxGain.connect(masterGain);
  masterGain.connect(audioCtx.destination);
  return audioCtx;
}

export async function resumeAudioFromUserGesture() {
  const ctx = initAudioGraph();
  if (!ctx) return;
  if (ctx.state === "suspended") await ctx.resume();
}

function clearPendingMusicListener() {
  if (pendingMusicListener && audioCtx) {
    audioCtx.removeEventListener("statechange", pendingMusicListener);
    pendingMusicListener = null;
  }
}

export function setMatchMusicPhase(phase) {
  matchMusicPhase = phase === "final" ? "final" : "normal";
}

function scheduleMusicChunk() {
  /* Soft upbeat loop chunk + random melody; reschedules via setTimeout. */
  if (!audioCtx || !loadSoundPreference()) return;
  const now = audioCtx.currentTime;
  const step = matchMusicPhase === "final" ? 0.22 : 0.35;
  const steps = matchMusicPhase === "final" ? 20 : 16;
  const vol = matchMusicPhase === "final" ? 0.13 : 0.11;
  for (let i = 0; i < steps; i++) {
    const t = now + i * step + 0.04;
    const freq = C_MAJOR[Math.floor(Math.random() * C_MAJOR.length)];
    playNote(freq, t, 0.24, "triangle", vol, musicGain);
    if (i % 4 === 0) {
      const bass = C_MAJOR[Math.floor(Math.random() * 3)] / 2;
      playNote(bass, t, 0.42, "sine", matchMusicPhase === "final" ? 0.18 : 0.15, musicGain);
    }
  }
  musicLoopTimer = window.setTimeout(scheduleMusicChunk, step * steps * 1000);
}

function sprinkleVariation() {
  if (!audioCtx || !loadSoundPreference() || audioCtx.state !== "running") return;
  const t = audioCtx.currentTime;
  const hi = C_MAJOR[3 + Math.floor(Math.random() * 4)] * (Math.random() < 0.5 ? 2 : 1);
  playNote(hi, t, 0.07, "sine", 0.045, musicGain);
}

function beginMusicLoopInternal() {
  if (!audioCtx || !loadSoundPreference()) return;
  if (audioCtx.state !== "running") return;
  if (musicLoopTimer) return;
  scheduleMusicChunk();
  if (variationTimer) clearInterval(variationTimer);
  variationTimer = window.setInterval(
    () => sprinkleVariation(),
    2200 + Math.floor(Math.random() * 2000)
  );
}

export async function startBackgroundMusic() {
  if (!loadSoundPreference()) return;
  initAudioGraph();
  if (!audioCtx) return;
  try {
    if (audioCtx.state === "suspended") await audioCtx.resume();
  } catch {
    /* autoplay policy */
  }
  if (audioCtx.state === "running") {
    clearPendingMusicListener();
    beginMusicLoopInternal();
    return;
  }
  if (!pendingMusicListener) {
    pendingMusicListener = () => {
      if (audioCtx.state === "running" && loadSoundPreference()) {
        clearPendingMusicListener();
        beginMusicLoopInternal();
      }
    };
    audioCtx.addEventListener("statechange", pendingMusicListener);
  }
}

export function stopBackgroundMusic() {
  clearPendingMusicListener();
  matchMusicPhase = "normal";
  if (musicLoopTimer) {
    clearTimeout(musicLoopTimer);
    musicLoopTimer = null;
  }
  if (variationTimer) {
    clearInterval(variationTimer);
    variationTimer = null;
  }
}

/** Master mute (music + SFX). Persists preference. */
export async function setSoundEnabled(on) {
  saveSoundPreference(on);
  initAudioGraph();
  if (!audioCtx) return;
  if (on && audioCtx.state === "suspended") {
    try {
      await audioCtx.resume();
    } catch {
      /* ignore */
    }
  }
  if (masterGain) masterGain.gain.value = on ? 0.2 : 0;
  if (on) {
    await startBackgroundMusic();
  } else {
    stopBackgroundMusic();
  }
}

function sfxTone(freq, dur, type = "sine", vol = 0.12) {
  if (!audioCtx || !loadSoundPreference()) return;
  const t = audioCtx.currentTime;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(sfxGain);
  o.start(t);
  o.stop(t + dur + 0.02);
}

/**
 * @param {"tap"|"double"|"trap"|"freeze"|"gameover"|"streak"|"shuffle"|"magnet"|"combo"|"miss"} kind
 */
export async function playSfx(kind) {
  if (!loadSoundPreference()) return;
  initAudioGraph();
  if (!audioCtx) return;
  if (audioCtx.state === "suspended") {
    try {
      await audioCtx.resume();
    } catch {
      return;
    }
  }
  if (audioCtx.state !== "running") return;
  const t = audioCtx.currentTime;
  switch (kind) {
    case "tap":
      sfxTone(880, 0.035, "sine", 0.07);
      sfxTone(420, 0.045, "triangle", 0.09);
      break;
    case "miss":
      sfxTone(220, 0.06, "square", 0.05);
      sfxTone(140, 0.1, "sine", 0.06);
      break;
    case "double":
      sfxTone(780, 0.06, "triangle", 0.1);
      window.setTimeout(() => sfxTone(980, 0.07, "triangle", 0.09), 55);
      break;
    case "trap":
      sfxTone(185, 0.14, "sawtooth", 0.11);
      break;
    case "freeze":
      sfxTone(360, 0.08, "square", 0.06);
      sfxTone(540, 0.1, "sine", 0.05);
      break;
    case "streak":
      sfxTone(660, 0.05, "square", 0.08);
      window.setTimeout(() => sfxTone(990, 0.08, "triangle", 0.08), 40);
      break;
    case "shuffle":
      sfxTone(320, 0.06, "sawtooth", 0.07);
      window.setTimeout(() => sfxTone(520, 0.06, "sawtooth", 0.06), 70);
      break;
    case "magnet":
      sfxTone(240, 0.08, "sine", 0.1);
      window.setTimeout(() => sfxTone(180, 0.1, "sine", 0.09), 60);
      break;
    case "combo":
      sfxTone(520, 0.04, "triangle", 0.07);
      sfxTone(780, 0.05, "triangle", 0.06);
      break;
    case "gameover": {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((f, i) => {
        playNote(f, t + i * 0.09, 0.12, "triangle", 0.1, sfxGain);
      });
      break;
    }
    default:
      sfxTone(520, 0.05);
  }
}

/**
 * Optional: Pixabay / similar CDN clip (may fail offline or if URL changes).
 * Call after user gesture; does not block Web Audio path.
 */
export function tryPlayExternalCelebration(url) {
  if (!loadSoundPreference() || !url) return;
  try {
    const a = new Audio(url);
    a.volume = 0.18;
    a.play().catch(() => {});
  } catch {
    /* ignore */
  }
}

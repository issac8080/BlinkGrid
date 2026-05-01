"use strict";

/**
 * Builds a minimal in-memory room plus emit log for engine-level unit tests.
 */
function createMockIo() {
  const log = { roomUpdate: [], gameUpdate: [], gameOver: [], tapFeedback: [] };
  const io = {
    to() {
      return {
        emit(event, payload) {
          if (event === "room:update") log.roomUpdate.push(payload);
          if (event === "game:update") log.gameUpdate.push(payload);
          if (event === "game:over") log.gameOver.push(payload);
          if (event === "game:tapFeedback") log.tapFeedback.push(payload);
        },
      };
    },
  };
  return { io, log };
}

function createHumanPlayer(overrides = {}) {
  return {
    id: overrides.id || "human_1",
    socketId: overrides.socketId || "sock_1",
    isBot: false,
    name: overrides.name || "Human",
    colorId: "blue",
    colorHex: "#3B82F6",
    ready: true,
    score: 0,
    frozenUntil: 0,
    combo: 1,
    lastComboAt: 0,
    lastClickAttemptAt: 0,
    ...overrides,
  };
}

function createBotPlayer(overrides = {}) {
  return {
    id: overrides.id || "bot_1",
    socketId: null,
    isBot: true,
    name: "Bot",
    colorId: "green",
    colorHex: "#22C55E",
    ready: true,
    score: 0,
    frozenUntil: 0,
    skill: overrides.skill ?? 1,
    combo: 1,
    lastComboAt: 0,
    lastClickAttemptAt: 0,
    ...overrides,
  };
}

module.exports = {
  createMockIo,
  createHumanPlayer,
  createBotPlayer,
};

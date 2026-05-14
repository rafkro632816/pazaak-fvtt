// ============================================================
//  Pazaak — state.mjs
//  Manage persisted game state using world-scoped game.settings.
//  GM persists updates directly; player clients emit socket requests that the GM handles.
//  Foundry synchronizes the stored state across connected users.
// ============================================================

import { MODULE_ID, getCfg } from "./config.mjs";

const SETTING_KEY = "pazaakState";

/**
 * Register the hidden world setting used for game state persistence.
 * This stub is kept for compatibility; registration now occurs in config.mjs.
 */
/** @deprecated Registration moved to registerSettings() in config.mjs. */
export function registerStateSetting(_onChangeFn) {}

/**
 * Read the persisted game state from world settings.
 * Returns null when no saved state exists.
 */
export function loadState() {
  try { return game.settings.get(MODULE_ID, SETTING_KEY) ?? null; }
  catch { return null; }
}

/**
 * Persist the current game state.
 * GM writes directly to game.settings; non-GM clients proxy the request via socket.
 */
export async function saveState(state) {
  if (game.user.isGM) {
    await game.settings.set(MODULE_ID, SETTING_KEY, foundry.utils.deepClone(state));
  } else {
    game.socket.emit(`module.${MODULE_ID}`, {
      type:  "saveState",
      state: foundry.utils.deepClone(state),
    });
  }
}

/**
 * Clear the persisted game state, resetting the saved match data.
 * GM clears the world setting; non-GM clients request a clear via socket.
 */
export async function clearState() {
  if (game.user.isGM) {
    await game.settings.set(MODULE_ID, SETTING_KEY, null);
  } else {
    game.socket.emit(`module.${MODULE_ID}`, { type: "clearState" });
  }
}

/**
 * Normalize and migrate loaded state objects to the current schema.
 * This fills in default fields and guards against missing data.
 */
export function migrateState(state) {
  const cfg = getCfg();
  state.target      ??= cfg.target;
  state.roundsToWin ??= cfg.roundsToWin;
  state.gameRound   ??= 1;
  state.turnCycle   ??= 1;
  state.turn        ??= 0;
  state.log         ??= [];
  state.playerIds   ??= [];
  state.scores      ??= {};

  for (const id of state.playerIds) {
    const p = state.scores[id];
    if (!p) continue;
    p.roundWins       ??= 0;
    p.score           ??= 0;
    p.stood           ??= false;
    p.busted          ??= false;
    p.draws           ??= [];
    p.handMods        ??= [];
    p.hand            ??= [];
    p.handCardsPlayed ??= 0;
    p.deckName        ??= cfg.fallbackHandTableName;
    p.usedTieBreaker  ??= false;
  }

  state.gamePageId  ??= null;
}

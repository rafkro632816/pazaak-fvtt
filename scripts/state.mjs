// ============================================================
//  Pazaak — state.mjs
//  Zapis / odczyt stanu gry przez game.settings (world-scope).
//  GM zapisuje bezpośrednio; gracze wysyłają żądanie przez socket,
//  GM je odbiera i zapisuje — sync jest automatyczny dzięki Foundry.
// ============================================================

import { MODULE_ID, getCfg } from "./config.mjs";

const SETTING_KEY = "pazaakState";

/**
 * Rejestruje ukryte ustawienie świata przechowujące stan gry.
 * Wywołaj w hooku "init". onChangeFn = callback przy każdej zmianie.
 */
/** @deprecated Rejestracja przeniesiona do registerSettings() w config.mjs. */
export function registerStateSetting(_onChangeFn) {}

/** Synchronicznie odczytuje stan gry (null jeśli brak). */
export function loadState() {
  try { return game.settings.get(MODULE_ID, SETTING_KEY) ?? null; }
  catch { return null; }
}

/** Zapisuje stan gry. GM zapisuje bezpośrednio; gracze przez socket. */
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

/** Usuwa stan gry (reset meczu). */
export async function clearState() {
  if (game.user.isGM) {
    await game.settings.set(MODULE_ID, SETTING_KEY, null);
  } else {
    game.socket.emit(`module.${MODULE_ID}`, { type: "clearState" });
  }
}

/**
 * Uzupełnia brakujące pola stanu (migracja / sanity-check).
 * Wywołuj za każdym razem po loadState().
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

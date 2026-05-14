// ============================================================
//  Pazaak — game.mjs
//  Core match state machine: turn processing, round resolution, and match lifecycle
// ============================================================

import { MODULE_ID, getCfg, t, getActiveCurrency }   from "./config.mjs";
import { loadState, saveState, clearState, migrateState } from "./state.mjs";
import { chat, renderMatchEnd, renderState }  from "./ui.mjs";
import { startGameLog, logTurn, logRoundEnd, logMatchEnd } from "./journal.mjs";

// ─── Utility helpers ─────────────────────────────────────────────────────────

/**
 * Returns true when a player is no longer active in the current round.
 */
export function isInactive(p) {
  return !p || p.stood || p.busted;
}

/**
 * Returns true when every player in the state is inactive.
 */
export function isFinished(state) {
  return state.playerIds.every(id => isInactive(state.scores[id]));
}

/**
 * Determines the round winner(s) based on score, bust status, and tie-breakers.
 */
export function getRoundWinners(state) {
  // Auto-win condition: 9 cards without bust takes the round.
  const nineCard = state.playerIds
    .map(id => state.scores[id])
    .find(p => p && !p.busted && (p.draws.length + p.handMods.length) >= 9);
  if (nineCard) return [nineCard];

  let best = -Infinity;
  let winners = [];
  for (const id of state.playerIds) {
    const p = state.scores[id];
    if (!p || p.busted || p.score > state.target) continue;
    if      (p.score > best) { best = p.score; winners = [p]; }
    else if (p.score === best) winners.push(p);
  }
  // Tie Breaker: resolve a tied top score by the player who played the tie-breaker card.
  if (winners.length > 1) {
    const tb = winners.find(p => p.usedTieBreaker);
    if (tb) return [tb];
  }
  return winners;
}

export function getMatchWinners(state) {
  return state.playerIds
    .map(id => state.scores[id])
    .filter(p => p && p.roundWins >= state.roundsToWin);
}

// ─── Helper: decode HTML entities from Foundry DB strings ───────────────────

function _decodeHtml(str) {
  const txt = document.createElement("textarea");
  txt.innerHTML = str;
  return txt.value;
}

// ─── Hand drawing ───────────────────────────────────────────────────────────

export async function drawHand(table, count) {
  const hand    = [];
  const usedIds = new Set();   // track draws in memory only — do not alter the RollTable

  for (let i = 0; i < count; i++) {
    const available = table.results.filter(r => !usedIds.has(r.id));
    if (!available.length) {
      console.warn(`Pazaak | Table "${table.name}" exhausted after ${i} cards.`);
      break;
    }
    const result = available[Math.floor(Math.random() * available.length)];
    usedIds.add(result.id);
    hand.push({
      label: _decodeHtml(String(result.description ?? result.text ?? "")),
      img:   result.img ?? null,
    });
  }
  return hand;
}

/**
 * Removes a selected card from the player's hand and returns its parsed metadata.
 * choice = "index|int_value|label" (select dialog format)
 */
export function consumeHandCard(player, choice) {
  if (!choice) return null;
  const [indexRaw, valueRaw, labelRaw] = String(choice).split("|");
  const index = Number.parseInt(indexRaw);
  const value = Number.parseInt(valueRaw);
  if (Number.isNaN(index) || Number.isNaN(value) || !player.hand[index]) return null;
  player.hand.splice(index, 1);
  return { value, label: labelRaw };
}

/** Reset drawn flags on hand tables used in the match (GM only). */
export async function resetHandTables(state) {
  if (!game.user.isGM || !state) return;
  const seen = new Set();
  for (const id of state.playerIds ?? []) {
    const name = state.scores?.[id]?.deckName;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const tbl = game.tables.getName(name);
    if (tbl) await tbl.reset();
  }
}

// ─── Match start ─────────────────────────────────────────────────────────────

/**
 * Initializes a new match from a set of scene tokens.
 * @param {Token[]} tokens            - at least 2 scene tokens
 * @param {Record<string,string>} [deckMap] - optional actorId → table name mapping
 * @param {number} [wager]           - wager amount (0 = none)
 * @param {string|null} [currency]   - optional currency key override
 * @returns {boolean} true if match initialization succeeded
 */
export async function startMatch(tokens, deckMap = {}, wager = 0, currency = null) {
  const cfg = getCfg();

  if (tokens.length < 2) {
    ui.notifications.warn(t("notifNeedTokens"));
    return false;
  }

  const state = {
    target:      cfg.target,
    roundsToWin: cfg.roundsToWin,
    gameRound:   1,
    turnCycle:   1,
    turn:        0,
    playerIds:   tokens.map(tok => tok.actor.id),
    scores:      {},
    log:         [],
    wager:        Math.max(0, Math.floor(wager)) || 0,
    wagerCurrency: currency ?? getActiveCurrency().key,
  };

  // 1. Resolve each player's hand table using explicit selection, actor-specific table, or fallback
  const handTables = {};
  for (const tok of tokens) {
    const id           = tok.actor.id;
    const chosenName   = deckMap[id];
    const specificName = `${cfg.handTablePrefix}${tok.actor.name}`;
    const handTable    =
      (chosenName   ? game.tables.getName(chosenName)   : null) ||
      game.tables.getName(specificName)                          ||
      game.tables.getName(cfg.fallbackHandTableName);
    if (!handTable) {
      ui.notifications.error(t("notifNoHandTable", {
        name:     tok.actor.name,
        fallback: cfg.fallbackHandTableName,
      }));
      return false;
    }
    handTables[id] = handTable;
  }

  // 2. Deal hands into each player's state
  for (const tok of tokens) {
    const id        = tok.actor.id;
    const handTable = handTables[id];
    const hand      = await drawHand(handTable, cfg.handSize);
    state.scores[id] = {
      name:             tok.actor.name,
      deckName:         handTable.name,
      roundWins:        0,
      score:            0,
      stood:            false,
      busted:           false,
      draws:            [],
      handMods:         [],
      handCardsPlayed:  0,
      hand,
    };
  }

  await saveState(state);
  await chat(t("chatMatchStart", { players: state.playerIds.map(id => state.scores[id]?.name).join(" vs ") }));

  // Validate each player's funds before collecting the wager
  if (state.wager > 0) {
    const path = `system.currency.${state.wagerCurrency}`;
    for (const id of state.playerIds) {
      const actor = game.actors.get(id);
      if (!actor || actor.type !== "character") continue;
      const balance = foundry.utils.getProperty(actor, path) ?? 0;
      if (balance < state.wager) {
        ui.notifications.error(t("notifInsufficientFunds", {
          name:     actor.name,
          amount:   state.wager,
          currency: state.wagerCurrency,
          balance,
        }));
        await chat(t("chatInsufficientFunds", {
          name:     actor.name,
          amount:   state.wager,
          currency: state.wagerCurrency,
          balance,
        }));
        await clearState();
        return false;
      }
    }
  }

  // Deduct wager from each player actor; skip non-character actors
  if (state.wager > 0) {
    for (const id of state.playerIds) {
      await adjustCurrency(id, -state.wager, state.wagerCurrency);
    }
    await chat(t("chatWagerDeducted", {
      amount: state.wager,
      currency: state.wagerCurrency,
    }));
  }

  // Create a journal entry for this match and persist game state
  state.gamePageId = await startGameLog(state);
  await saveState(state);

  return true;
}

// ─── Turn resolution ──────────────────────────────────────────────────────────

/**
 * Applies a turn result: base card, optional hand card, and stand/pass decision.
 */
export async function resolveTurn(state, playerId, cardVal, handChoice, wantsStand) {
  migrateState(state);
  const cfg = getCfg();
  const p   = state.scores[playerId];

  if (!p) {
    ui.notifications.error(t("notifNoPlayer"));
    return;
  }

  // Enforce the match-level hand card play limit
  if (handChoice && p.handCardsPlayed >= cfg.maxHandPlays) {
    ui.notifications.warn(t("notifHandLimitWarn", {
      name:  p.name,
      max:   cfg.maxHandPlays,
      scope: cfg.handCardsLimitScope === "round" ? t("notifLimitScopeRound") : t("notifLimitScopeMatch"),
    }));
    handChoice = "";
  }

  // Apply the base draw card to the player's board
  p.draws.push(cardVal);

  // Apply any selected hand card effect
  const handPlay = consumeHandCard(p, handChoice);
  let   mod      = handPlay?.value ?? 0;
  if (handPlay) {
    p.handMods.push(handPlay.label);
    p.handCardsPlayed++;

    // Double card: apply a second card value without mutating the original draw entry
    // drawDoubled[] is used by the UI to render a ×2 badge on the original card
    if (handPlay.label === "Double") {
      if (!p.drawDoubled) p.drawDoubled = [];
      while (p.drawDoubled.length < p.draws.length - 1) p.drawDoubled.push(false);
      p.drawDoubled[p.draws.length - 1] = true;
      mod = cardVal; // score = cardVal + cardVal = cardVal * 2 (without changing draws)
    }

    // Flip cards: invert selected board card values and compute delta for score
    const FLIP_RANGES = { "Flip 1&2": [1, 2], "Flip 3&4": [3, 4], "Flip 5&6": [5, 6] };
    const flipRange = FLIP_RANGES[handPlay.label];
    if (flipRange) {
      let flipDelta = 0;
      p.draws = p.draws.map(v => {
        if (flipRange.includes(Math.abs(v))) { flipDelta -= 2 * v; return -v; }
        return v;
      });
      mod = flipDelta;
    }

    // Tie Breaker card: mark the player so a tie resolves in their favor
    if (handPlay.label === "Tie Breaker") p.usedTieBreaker = true;
  }

  const total     = p.score + cardVal + mod;
  const cardCount = p.draws.length + p.handMods.length;
  const autoStand = cardCount >= 9;

  p.score  = total;
  p.busted = !autoStand && total > state.target;
  p.stood  = autoStand || wantsStand || total === state.target || p.busted;

  state.log.push({
    gameRound:  state.gameRound,
    turnCycle:  state.turnCycle,
    name:       p.name,
    card:       cardVal,
    hand:       handPlay?.label ?? null,
    mod,
    total,
    stood:      p.stood,
    busted:     p.busted,
  });

  await saveState(state);

  const autoStandFlag = autoStand && !p.busted;
  await logTurn(state, {
    name:      p.name,
    card:      cardVal,
    hand:      handPlay?.label ?? null,
    mod,
    total,
    stood:     p.stood,
    busted:    p.busted,
    autoStand: autoStandFlag,
  });

  await advanceTurn(state);
}

// ─── Turn progression ───────────────────────────────────────────────────────

export async function advanceTurn(state) {
  migrateState(state);

  if (isFinished(state)) {
    await finishRound(state);
    return;
  }

  let safety     = 0;
  let wrapped    = false;
  let foundActive = false;

  // Advance turn to the next active player, wrapping turn order and preventing infinite loops.
  while (safety < state.playerIds.length) {
    const oldTurn  = state.turn;
    state.turn     = (state.turn + 1) % state.playerIds.length;
    if (state.turn <= oldTurn) wrapped = true;

    if (!isInactive(state.scores[state.playerIds[state.turn]])) {
      foundActive = true;
      break;
    }
    safety++;
  }

  if (!foundActive) {
    await finishRound(state);
    return;
  }

  if (wrapped) state.turnCycle++;

  await saveState(state);
}

// ─── Round end ──────────────────────────────────────────────────────────────

export async function finishRound(state) {
  migrateState(state);
  const winners = getRoundWinners(state);
  if (winners.length === 1) winners[0].roundWins++;

  await saveState(state);
  await logRoundEnd(state, winners, state.gameRound);

  const matchWinners = getMatchWinners(state);
  if (matchWinners.length > 0) {
    // Award the winner the full wager pot
    if (state.wager > 0 && matchWinners.length === 1) {
      const pot = state.wager * state.playerIds.length;
      await adjustCurrency(matchWinners[0].name, pot, state.wagerCurrency, true);
      await chat(t("chatWagerAwarded", {
        winner:   matchWinners[0].name,
        amount:   pot,
        currency: state.wagerCurrency,
      }));
    } else if (state.wager > 0 && matchWinners.length > 1) {
      // Match tie: refund each player's wager equally
      for (const id of state.playerIds) {
        await adjustCurrency(id, state.wager, state.wagerCurrency);
      }
      await chat(t("chatWagerTied", {
        amount:   state.wager,
        currency: state.wagerCurrency,
      }));
    }
    await logMatchEnd(state, matchWinners);
    await chat(renderMatchEnd(state, matchWinners));

    // Victory screen (for a single winner only)
    if (matchWinners.length === 1) {
      const winnerActorId = state.playerIds.find(id => state.scores[id] === matchWinners[0]) ?? null;
      const pot           = state.wager > 0 ? state.wager * state.playerIds.length : 0;
      const victoryData   = {
        name:     matchWinners[0].name,
        actorId:  winnerActorId,
        pot,
        currency: state.wagerCurrency,
      };
      // Broadcast victory payload to all connected clients
      game.socket.emit(`module.${MODULE_ID}`, { type: "showVictory", ...victoryData });
      // Trigger local victory UI via Hook — avoid direct import of victory.mjs
      Hooks.call("pazaakVictory", victoryData);
    }

    await resetHandTables(state);
    await clearState();
    return;
  }

  await startNextGameRound(state);
}

// ─── Next match round ───────────────────────────────────────────────────────

export async function startNextGameRound(state) {
  migrateState(state);
  const cfg = getCfg();

  state.gameRound++;
  state.turnCycle = 1;

  // The previous round loser starts the next round (like KOTOR)
  const winners = getRoundWinners(state);
  if (winners.length === 1) {
    const loserIdx = state.playerIds.findIndex(id => state.scores[id] !== winners[0]);
    state.turn = loserIdx >= 0 ? loserIdx : 0;
  } else {
    state.turn = 0;
  }


  for (const id of state.playerIds) {
    const p    = state.scores[id];
    p.score          = 0;
    p.stood          = false;
    p.busted         = false;
    p.draws          = [];
    p.handMods       = [];
    p.usedTieBreaker = false;
    if (cfg.handCardsLimitScope === "round") p.handCardsPlayed = 0;
    if (cfg.redrawHandEachRound) {
      const ht = game.tables.getName(p.deckName)
              ?? game.tables.getName(cfg.fallbackHandTableName);
      if (ht) p.hand = await drawHand(ht, cfg.handSize);
    }
  }

  await normalizeTurn(state);
  await saveState(state);
  await chat(t("chatRoundStart", { n: state.gameRound }));
}

// ─── Turn normalization ──────────────────────────────────────────────────────

export async function normalizeTurn(state) {
  migrateState(state);
  if (state.turn < 0 || state.turn >= state.playerIds.length) state.turn = 0;
  if (!isInactive(state.scores[state.playerIds[state.turn]])) return;

  let safety = 0;
  let wrapped = false;

  // Skip inactive players until a valid active turn is found.
  while (
    safety < state.playerIds.length &&
    isInactive(state.scores[state.playerIds[state.turn]])
  ) {
    const oldTurn = state.turn;
    state.turn    = (state.turn + 1) % state.playerIds.length;
    if (state.turn <= oldTurn) wrapped = true;
    safety++;
  }

  if (wrapped) state.turnCycle++;
}

// ─── Currency: deduction / reward ────────────────────────────────────────────

/**
 * Adjusts a character actor's currency balance.
 * @param {string} actorIdOrName  - actor id or name (name is used when actor id is unavailable)
 * @param {number} delta          - amount to change (negative = subtract, positive = add)
 * @param {string} currencyKey    - currency field key (e.g. "gp", "cr")
 * @param {boolean} byName        - resolve actor by name instead of id
 */
export async function adjustCurrency(actorIdOrName, delta, currencyKey, byName = false) {
  if (!delta) return;

  if (!game.user.isGM) {
    // Delegate to GM — they have permission to update any actor
    game.socket.emit(`module.${MODULE_ID}`, {
      type: "adjustCurrency",
      actorIdOrName, delta, currencyKey, byName,
    });
    return;
  }

  const actor = byName
    ? game.actors.find(a => a.name === actorIdOrName)
    : game.actors.get(actorIdOrName);
  if (!actor) return;

  // Only player character actors; skip NPCs, vehicles, and other types
  if (actor.type !== "character") return;

  const path    = `system.currency.${currencyKey}`;
  const current = foundry.utils.getProperty(actor, path) ?? 0;
  const next    = Math.max(0, current + delta);
  await actor.update({ [path]: next });
}

// ============================================================
//  Pazaak — game.mjs
//  Cała logika gry: tury, rundy, mecz
// ============================================================

import { MODULE_ID, getCfg, t, getActiveCurrency }   from "./config.mjs";
import { loadState, saveState, clearState, migrateState } from "./state.mjs";
import { chat, renderMatchEnd, renderState }  from "./ui.mjs";
import { startGameLog, logTurn, logRoundEnd, logMatchEnd } from "./journal.mjs";

// ─── Drobne pomocniki ─────────────────────────────────────────────────────────

export function isInactive(p) {
  return !p || p.stood || p.busted;
}

export function isFinished(state) {
  return state.playerIds.every(id => isInactive(state.scores[id]));
}

export function getRoundWinners(state) {
  // Gracz z 9 kartami bez busta auto-wygrywa niezależnie od sumy
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
  // Tie Breaker: przy remisie wygrywa gracz, który zagrał tę kartę
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

// ─── Pomocnik: dekoduj HTML entities z tekstów Foundry DB ────────────────────

function _decodeHtml(str) {
  const txt = document.createElement("textarea");
  txt.innerHTML = str;
  return txt.value;
}

// ─── Dobieranie ręki ─────────────────────────────────────────────────────────

export async function drawHand(table, count) {
  const hand    = [];
  const usedIds = new Set();   // śledź tylko w pamięci — baza RollTable nienaruszona

  for (let i = 0; i < count; i++) {
    const available = table.results.filter(r => !usedIds.has(r.id));
    if (!available.length) {
      console.warn(`Pazaak | Talia "${table.name}" wyczerpana po ${i} kartach.`);
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
 * Zużywa kartę z ręki gracza.
 * choice = "indeks|wartość_int|etykieta" (format z selecta w dialogu)
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

/** Resetuje flagi drawn na taliach użytych w meczu (tylko GM). */
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

// ─── Start meczu ─────────────────────────────────────────────────────────────

/**
 * Inicjuje nowy mecz na podstawie tablicy tokenów.
 * @param {Token[]} tokens  — minimum 2 tokeny ze sceny
 * @param {Record<string,string>} [deckMap]  — opcjonalna mapa actorId → nazwa tabeli
 * @param {number} [wager]  — kwota zakładu (0 = brak)
 * @returns {boolean} true jeśli start się powiódł
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

  // 1. Rozwiąż talie dla każdego gracza (walidacja przed ruszeniem kart)
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

  // 2. Rozdaj karty
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

  // Sprawdź czy gracze mają wystarczające środki na zakład
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

  // Pobierz zakład od graczy (pomijaj NPC)
  if (state.wager > 0) {
    for (const id of state.playerIds) {
      await adjustCurrency(id, -state.wager, state.wagerCurrency);
    }
    await chat(t("chatWagerDeducted", {
      amount: state.wager,
      currency: state.wagerCurrency,
    }));
  }

  // Utwórz stronę w dzienniku dla tego meczu
  state.gamePageId = await startGameLog(state);
  await saveState(state);

  return true;
}

// ─── Rozpatrywanie tury ───────────────────────────────────────────────────────

/**
 * Aplikuje wynik tury (karta główna + opcjonalna karta z ręki + decyzja PAS).
 */
export async function resolveTurn(state, playerId, cardVal, handChoice, wantsStand) {
  migrateState(state);
  const cfg = getCfg();
  const p   = state.scores[playerId];

  if (!p) {
    ui.notifications.error(t("notifNoPlayer"));
    return;
  }

  // Walidacja limitu kart z ręki
  if (handChoice && p.handCardsPlayed >= cfg.maxHandPlays) {
    ui.notifications.warn(t("notifHandLimitWarn", {
      name:  p.name,
      max:   cfg.maxHandPlays,
      scope: cfg.handCardsLimitScope === "round" ? t("notifLimitScopeRound") : t("notifLimitScopeMatch"),
    }));
    handChoice = "";
  }

  // Aplikuj kartę główną
  p.draws.push(cardVal);

  // Aplikuj kartę z ręki
  const handPlay = consumeHandCard(p, handChoice);
  let   mod      = handPlay?.value ?? 0;
  if (handPlay) {
    p.handMods.push(handPlay.label);
    p.handCardsPlayed++;

    // Karta Double: podwaja wynik, ale zachowujemy oryginalną wartość w draws
    // (doubled=true w drawDoubled[] pozwala UI pokazać ×2 badge na karcie)
    if (handPlay.label === "Double") {
      if (!p.drawDoubled) p.drawDoubled = [];
      while (p.drawDoubled.length < p.draws.length - 1) p.drawDoubled.push(false);
      p.drawDoubled[p.draws.length - 1] = true;
      mod = cardVal; // score = cardVal + cardVal = cardVal * 2 (bez zmiany draws)
    }

    // Karty Flip: odwracają znak wybranych kart na planszy
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

    // Karta Tie Breaker: zaznacza gracza — przy remisie wygrywa rundę
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

// ─── Postęp tury ─────────────────────────────────────────────────────────────

export async function advanceTurn(state) {
  migrateState(state);

  if (isFinished(state)) {
    await finishRound(state);
    return;
  }

  let safety     = 0;
  let wrapped    = false;
  let foundActive = false;

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

// ─── Koniec rundy ─────────────────────────────────────────────────────────────

export async function finishRound(state) {
  migrateState(state);
  const winners = getRoundWinners(state);
  if (winners.length === 1) winners[0].roundWins++;

  await saveState(state);
  await logRoundEnd(state, winners, state.gameRound);

  const matchWinners = getMatchWinners(state);
  if (matchWinners.length > 0) {
    // Nagrodź zwycięzcę zakładem (całą pulą)
    if (state.wager > 0 && matchWinners.length === 1) {
      const pot = state.wager * state.playerIds.length;
      await adjustCurrency(matchWinners[0].name, pot, state.wagerCurrency, true);
      await chat(t("chatWagerAwarded", {
        winner:   matchWinners[0].name,
        amount:   pot,
        currency: state.wagerCurrency,
      }));
    } else if (state.wager > 0 && matchWinners.length > 1) {
      // Remis meczu — zwróć zakład każdemu graczowi
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

    // Ekran zwycięzcy (tylko dla jednego zwycięzcy)
    if (matchWinners.length === 1) {
      const winnerActorId = state.playerIds.find(id => state.scores[id] === matchWinners[0]) ?? null;
      const pot           = state.wager > 0 ? state.wager * state.playerIds.length : 0;
      const victoryData   = {
        name:     matchWinners[0].name,
        actorId:  winnerActorId,
        pot,
        currency: state.wagerCurrency,
      };
      // Wyślij do wszystkich graczy
      game.socket.emit(`module.${MODULE_ID}`, { type: "showVictory", ...victoryData });
      // Pokaż lokalnie (przez Hook — nie importujemy victory.mjs bezpośrednio)
      Hooks.call("pazaakVictory", victoryData);
    }

    await resetHandTables(state);
    await clearState();
    return;
  }

  await startNextGameRound(state);
}

// ─── Nowa runda meczu ─────────────────────────────────────────────────────────

export async function startNextGameRound(state) {
  migrateState(state);
  const cfg = getCfg();

  state.gameRound++;
  state.turnCycle = 1;

  // Przegrany poprzedniej rundy zaczyna następną (jak w KOTOR)
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

// ─── Normalizacja kolejki ──────────────────────────────────────────────────────

export async function normalizeTurn(state) {
  migrateState(state);
  if (state.turn < 0 || state.turn >= state.playerIds.length) state.turn = 0;
  if (!isInactive(state.scores[state.playerIds[state.turn]])) return;

  let safety = 0;
  let wrapped = false;

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

// ─── Waluta: dedukcja / nagroda ───────────────────────────────────────────────

/**
 * Modyfikuje walutę aktora.
 * @param {string} actorIdOrName  — id aktora lub nazwa (dla zwycięzcy po wyczyszczeniu stanu)
 * @param {number} delta          — kwota (ujemna = odejmij, dodatnia = dodaj)
 * @param {string} currencyKey    — klucz pola waluty (np. "gp", "cr")
 * @param {boolean} byName        — szukaj po nazwie zamiast id
 */
/**
 * Zmienia walutę aktora (tylko type==="character").
 * Jeśli wywołujący nie jest GM, deleguje przez socket.
 */
export async function adjustCurrency(actorIdOrName, delta, currencyKey, byName = false) {
  if (!delta) return;

  if (!game.user.isGM) {
    // Deleguj do GM — on ma uprawnienia do aktualizacji każdego aktora
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

  // Tylko karty postaci gracza (PC); NPC, pojazdy itp. — pomijaj
  if (actor.type !== "character") return;

  const path    = `system.currency.${currencyKey}`;
  const current = foundry.utils.getProperty(actor, path) ?? 0;
  const next    = Math.max(0, current + delta);
  await actor.update({ [path]: next });
}

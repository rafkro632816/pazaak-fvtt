// ============================================================
//  Pazaak — app.mjs
//  Main UI application: ApplicationV2 + HandlebarsApplicationMixin
// ============================================================

import { MODULE_ID, getCfg, t, getAvailableCurrencies, getActiveCurrency } from "./config.mjs";
import { loadState, clearState, migrateState }        from "./state.mjs";
import { startMatch, resolveTurn, normalizeTurn,
         advanceTurn, isInactive, resetHandTables, adjustCurrency } from "./game.mjs";
import { parseCardValue, signed, chat }               from "./ui.mjs";
import { DeckBuilderApp }                             from "./deck-builder.mjs";

/** Decodes HTML entities from Foundry DB texts (e.g., "&amp;" → "&"). */
function _decodeHtml(str) {
  const txt = document.createElement("textarea");
  txt.innerHTML = String(str);
  return txt.value;
}

/** Builds an array of clickable hand cards (handles +/- as two buttons). */
function buildHandCards(hand) {
  return hand.flatMap((card, i) => {
    const label = card.label ?? "";
    if (String(label).includes("+/-")) {
      const n = Math.abs(parseCardValue(label));
      return [
        { optValue: `${i}|${n}|+${n}`,  display: `+${n}`, cardVal:  n },
        { optValue: `${i}|-${n}|-${n}`, display: `-${n}`, cardVal: -n },
      ];
    }
    const value = parseCardValue(label);
    return [{ optValue: `${i}|${value}|${signed(value)}`, display: signed(value), cardVal: value }];
  });
}

/** Returns the path to the hand card image based on the label (+N, -N, +/-N, Special). */
function handCardImg(label) {
  const s = String(label ?? "");
  const pm  = s.match(/^\+\/-?(\d+)$/);
  if (s.startsWith("+/-")) {
    const n = s.replace("+/-", "");
    return `modules/${MODULE_ID}/assets/+-/+-${n}.png`;
  }
  const pos = s.match(/^\+(\d+)$/);
  if (pos) return `modules/${MODULE_ID}/assets/+/+${pos[1]}.png`;
  const neg = s.match(/^-(\d+)$/);
  if (neg) return `modules/${MODULE_ID}/assets/-/-${neg[1]}.png`;
  const specials = { "Double": "Double", "Flip 1&2": "Flip 1&2", "Flip 3&4": "Flip 3&4", "Flip 5&6": "Flip 5&6", "Tie Breaker": "Tie Breaker" };
  if (specials[s]) return `modules/${MODULE_ID}/assets/Special/${specials[s]}.png`;
  return null;
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class PazaakApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "pazaak-app",
    window: {
      title:       "Pazaak",
      resizable:   true,
      minimizable: true,
    },
    classes:   ["pazaak-app"],
    position:  { width: 720, height: 700, top: 80, left: 120 },
    actions: {
      startGame:      PazaakApp._onStartGame,
      openDeckBuilder: PazaakApp._onOpenDeckBuilder,
      drawCard:       PazaakApp._onDrawCard,
      confirmTurn:    PazaakApp._onConfirmTurn,
      standTurn:      PazaakApp._onStandTurn,
      resetGame:      PazaakApp._onResetGame,
      cancelWaiting:  PazaakApp._onCancelWaiting,
      selectHandCard: PazaakApp._onSelectHandCard,
      closeVictory:   PazaakApp._onCloseVictory,
    },
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/pazaak-app.hbs` },
  };

  /** @type {PazaakApp|null} */
  static _instance = null;

  /** Card drawn but not yet confirmed by the player. */
  _pending = null; // { playerId, val, img, newTotal }

  /** Whether the victory screen is currently displayed (blocks start buttons). */
  static _victoryOpen = false;

  /** Winner data to display in the window. */
  static _victoryData = null;

  // ── Singleton ─────────────────────────────────────────────────────────────

  static openSingleton() {
    if (!PazaakApp._instance) PazaakApp._instance = new PazaakApp();
    if (PazaakApp._instance.rendered) {
      (PazaakApp._instance.bringToFront ?? PazaakApp._instance.bringToTop)?.call(PazaakApp._instance);
    } else {
      PazaakApp._instance.render({ force: true });
    }
    return PazaakApp._instance;
  }

  // ── Context ───────────────────────────────────────────────────────────────

  /**
   * Prepares the context data for the Handlebars template.
   * Builds player data, including board slots, hand slots, and pending card state.
   * Handles victory screen display and waiting states.
   */
  async _prepareContext(options) {
    const cfg   = getCfg();
    const state = loadState();

    if (!state) {
        // Display victory screen in the main app window instead of a separate popup for better UX.
      if (PazaakApp._victoryOpen && PazaakApp._victoryData) {
        const vd = PazaakApp._victoryData;
        // Resolve portrait dynamically at render time: prefer token image, fallback to actor image.
        let portrait = "icons/svg/mystery-man.svg";
        const actor  = game.actors?.get(vd.actorId);
        if (actor?.img) portrait = actor.img;
        const token = canvas?.tokens?.placeables?.find(t => t.actor?.id === vd.actorId);
        if (token?.document?.texture?.src) portrait = token.document.texture.src;
        return { hasGame: false, cfg, isGM: game.user.isGM, victoryPending: true,
                 victoryData: { ...vd, portrait } };
      }
      return { hasGame: false, cfg, isGM: game.user.isGM, victoryPending: false };
    }

    // Waiting for players to choose decks
    if (this._waitingForPicks) {
      return {
        hasGame:        false,
        isWaiting:      true,
        waitingPlayers: this._waitingForPicks.playerList,
        cfg,
        isGM:           game.user.isGM,
      };
    }

    migrateState(state);

    const MAX_GRID = 9; // 3×3 slotów na planszy

    const players = state.playerIds.map((id, i) => {
      const p = state.scores[id];
      if (!p) return null;

      const isActive  = i === state.turn && !p.stood && !p.busted;
      const actor     = game.actors.get(id);
      const isMine    = game.user.isGM ||
                        (actor?.testUserPermission(game.user, "OWNER") ?? false);
      const statusKey = p.busted  ? "bust"
                      : p.stood   ? "stood"
                      : isActive  ? "active"
                                  : "wait";

      // Board slots: array of up to MAX_GRID positions representing drawn cards and played hand cards on the board.
      // Each slot has properties: filled (boolean), value (string), img (string), isHand (boolean), isPending (boolean), doubled (boolean).
      const cardImg = (v) => {
        const n = Math.abs(v);
        return (n >= 1 && n <= 10) ? `modules/${MODULE_ID}/assets/Standard/${n}.png` : null;
      };
      const gridSlots = [];
      for (let i = 0; i < (p.draws ?? []).length; i++) {
        const v = p.draws[i];
        const doubled = (p.drawDoubled ?? [])[i] === true;
        gridSlots.push({ filled: true, value: signed(v), img: cardImg(v), isHand: false, isPending: false, doubled });
      }
      for (const hm of (p.handMods ?? [])) gridSlots.push({ filled: true, value: String(hm), img: handCardImg(hm), isHand: true, isPending: false, doubled: false });
      while (gridSlots.length < MAX_GRID)  gridSlots.push({ filled: false });

      // Hand slots: array of hand cards for the player, shown as buttons or hidden values.
      // Only the owner sees actual card values for privacy; others see placeholders.
      const handSlots = (p.hand ?? []).map((c, handIdx) => {
        const label  = _decodeHtml(c.label ?? "");
        const isPM   = String(label).includes("+/-");
        const isTB   = label === "Tie Breaker";  // Tie Breaker działa jak +/-1
        const isSpec = ["Double", "Flip 1&2", "Flip 3&4", "Flip 5&6"].includes(label);
        const n      = isTB ? 1 : Math.abs(parseCardValue(label));
        const cv     = parseCardValue(label);
        return {
          filled:       true,
          value:        isMine ? label : "★",
          img:          isMine ? handCardImg(label) : null,
          isPlusMinus:  isPM || isTB,
          isTieBreaker: isTB,
          cardN:        n,
          cardIndex:    handIdx,
          optValue:     (!isPM && !isTB) ? `${handIdx}|${cv}|${isSpec ? label : signed(cv)}` : null,
          cardVal:      (!isPM && !isTB) ? cv : null,
          displayLabel: isPM ? `+/-${n}` : isTB ? "TB ±1" : isSpec ? label : signed(cv),
          isButton:     false,
        };
      });

      // Round win gems: visual indicators for won rounds, up to cfg.roundsToWin.
      const gems = Array.from({ length: cfg.roundsToWin }, (_, gi) => ({
        won: gi < (p.roundWins ?? 0),
      }));

      return {
        ...p,
        actorId:     id,
        isActive,
        isMine,
        statusKey,
        statusLabel: { bust: t("statusBust"), stood: t("statusStood"), active: t("statusActive"), wait: t("statusWait") }[statusKey],
        gridSlots,
        handSlots,
        gems,
      };
    }).filter(Boolean);

    const myActivePlayer = players.find(p => p.isActive && p.isMine) ?? null;
    const isMyTurn       = !!myActivePlayer;

    let pending = null;
    if (this._pending) {
      // Handle pending card: a drawn card not yet confirmed, shown temporarily on the board.
      // Calculate new total and bust/perfect status for preview.
      const mp      = myActivePlayer ?? players.find(p => p.actorId === this._pending.playerId);
      const isBust  = this._pending.newTotal > state.target;
      const isPerfect = this._pending.newTotal === state.target;
      // Dodaj pending do slotów aktywnego gracza jako osobny wpis
      const pp = players.find(p => p.actorId === this._pending.playerId);
      if (pp) {
        const lastEmpty = pp.gridSlots.findIndex(s => !s.filled);
        if (lastEmpty !== -1) pp.gridSlots[lastEmpty] = {
          filled: true, value: signed(this._pending.val),
          img: (() => { const n = Math.abs(this._pending.val); return (n >= 1 && n <= 10) ? `modules/${MODULE_ID}/assets/Standard/${n}.png` : null; })(),
          isHand: false, isPending: true,
        };
        // Pokaż aktualny wynik (z dobrana kartą) zanim tura zostanie potwierdzona
        pp.score = this._pending.newTotal;
      }
      pending = {
        ...this._pending,
        valSigned:    signed(this._pending.val),
        isBust,
        isPerfect,
        handDisabled: (mp?.handCardsPlayed ?? 0) >= cfg.maxHandPlays,
      };
    }

    // Oznacz sloty ręki aktywnego gracza jako klikalne
    if (pending && !pending.handDisabled) {
      const activePl = players.find(pl => pl.actorId === this._pending?.playerId && pl.isMine);
      if (activePl) activePl.handSlots.forEach(s => { s.isButton = true; });
    }

    const showDeckName = game.settings.get(MODULE_ID, "showDeckName");

    return {
      hasGame:         true,
      state,
      cfg,
      p1:              players[0] ?? null,
      p2:              players[1] ?? null,
      isMyTurn,
      myActivePlayer,
      pending,
      activeIsLeft:    (state.turn ?? 0) === 0,
      wagerPot:        (state.wager || 0) * (state.playerIds?.length ?? 0),
      isGM:            game.user.isGM,
      showDeckName,
    };
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  static async _onStartGame(event, target) {
    const tokens = canvas.tokens?.controlled ?? [];
    if (tokens.length < 2) {
      ui.notifications.warn(t("notifNeedTokens"));
      return;
    }
    const existing = loadState();
    if (existing) {
      const ok = await _confirm(
        t("confirmNewMatchTitle"),
        t("confirmNewMatchBody")
      );
      if (!ok) return;
      await resetHandTables(loadState());
      await clearState();
    }
    this._pending = null;

    // Show deck selection dialog for each player
    const dialogResult = await _showDeckSelectionDialog(tokens);
    if (dialogResult === null) return; // canceled
    const { deckMap, wager, currency, playerPickMode } = dialogResult;

    if (playerPickMode) {
      await _startPlayerPickMode.call(this, tokens, wager, currency, deckMap);
    } else {
      await startMatch(tokens, deckMap, wager, currency);
      this.render({ force: true });
    }
  }

  static async _onDrawCard(event, target) {
    const cfg   = getCfg();
    const state = loadState();
    if (!state) return;

    migrateState(state);
    await normalizeTurn(state);

    const curId  = state.playerIds[state.turn];
    const player = state.scores[curId];

    if (isInactive(player)) {
      await advanceTurn(state);
      this.render({ force: true });
      return;
    }

    const table = game.tables.getName(cfg.tableName);
    if (!table) {
      ui.notifications.error(t("notifNoTable", { name: cfg.tableName }));
      return;
    }

    const draw   = await table.draw({ displayChat: false });
    const result = draw.results?.[0];
    if (!result) {
      ui.notifications.error(t("notifNoResult"));
      return;
    }

    const cardText = String(result.description ?? result.text ?? "");
    const cardVal  = Number.parseInt(cardText.match(/[+-]?\d+/)?.[0] ?? "0");

    this._pending = {
      playerId: curId,
      val:      cardVal,
      img:      result.img ?? null,
      newTotal: player.score + cardVal,
    };

    // Broadcast pending card to other clients for real-time UI sync.
    game.socket.emit(`module.${MODULE_ID}`, { type: "setPending", pending: this._pending });

    this.render({ force: true });
  }

  static async _onConfirmTurn(event, target) {
    if (!this._pending) return;
    const state    = loadState();
    if (!state) return;
    const handCard = this.element?.querySelector("#pazaak-hand-card")?.value ?? "";
    const { playerId, val } = this._pending;
    this._pending = null;
    game.socket.emit(`module.${MODULE_ID}`, { type: "clearPending" });
    await resolveTurn(state, playerId, val, handCard, false);
    // Foundry's onChange hook for settings doesn't trigger on the GM's own client after saving.
    // Other clients receive the update via socket, but GM must manually re-render their UI.
    if (game.user.isGM) this.render({ force: true });
  }

  static async _onStandTurn(event, target) {
    if (!this._pending) return;
    const state    = loadState();
    if (!state) return;
    const handCard = this.element?.querySelector("#pazaak-hand-card")?.value ?? "";
    const { playerId, val } = this._pending;
    this._pending = null;
    game.socket.emit(`module.${MODULE_ID}`, { type: "clearPending" });
    await resolveTurn(state, playerId, val, handCard, true);
    if (game.user.isGM) this.render({ force: true });
  }

  static _onSelectHandCard(event, target) {
    const root     = this.element;
    const input    = root.querySelector("#pazaak-hand-card");
    const totalEl  = root.querySelector("#pzk-live-total");
    const chosenEl = root.querySelector("#pzk-chosen-label");
    if (!input) return;

    const isPM = target.dataset.isPlusMinus === "true";
    let selectedVal = null;
    let displayText = "0";

    if (isPM) {
      const n         = Number(target.dataset.cardN);
      const cardIndex = target.dataset.cardIndex;
      const pmState   = target.dataset.pmState ?? "none";
      const isTB      = target.dataset.isTieBreaker === "true";
    // Tie Breaker card: applies ±1 value, but uses fixed label to trigger tie logic in game.mjs.
      const lbPlus  = isTB ? "Tie Breaker" : `+${n}`;
      const lbMinus = isTB ? "Tie Breaker" : `-${n}`;

      root.querySelectorAll(".pzk-hand-slot").forEach(b => {
        if (b !== target) {
          b.classList.remove("pzk-hand-selected", "pzk-pm-plus", "pzk-pm-minus");
          b.dataset.pmState = "none";
        }
      });

      if (pmState === "none") {
        target.classList.add("pzk-hand-selected", "pzk-pm-plus");
        target.classList.remove("pzk-pm-minus");
        target.dataset.pmState = "plus";
        input.value  = `${cardIndex}|${n}|${lbPlus}`;
        selectedVal  = n;
        displayText  = `+${n}`;
      } else if (pmState === "plus") {
        target.classList.remove("pzk-pm-plus");
        target.classList.add("pzk-pm-minus");
        target.dataset.pmState = "minus";
        input.value  = `${cardIndex}|-${n}|${lbMinus}`;
        selectedVal  = -n;
        displayText  = `-${n}`;
      } else {
        target.classList.remove("pzk-hand-selected", "pzk-pm-plus", "pzk-pm-minus");
        delete target.dataset.pmState;
        input.value = "";
        selectedVal = null;
        displayText = "0";
      }
    } else {
      const optValue = target.dataset.optValue;
      const cardVal  = Number(target.dataset.cardVal);
      const already  = input.value === optValue;

      root.querySelectorAll(".pzk-hand-slot").forEach(b => {
        if (b !== target) {
          b.classList.remove("pzk-hand-selected", "pzk-pm-plus", "pzk-pm-minus");
          b.dataset.pmState = "none";
        }
      });

      if (already) {
        target.classList.remove("pzk-hand-selected");
        input.value = "";
        selectedVal = null;
        displayText = "0";
      } else {
        target.classList.add("pzk-hand-selected");
        input.value  = optValue;
        selectedVal  = cardVal;
        displayText  = target.dataset.displayLabel ?? String(cardVal);
      }
    }

    if (chosenEl) chosenEl.textContent = displayText;

    if (totalEl && this._pending) {
      const state   = loadState();
      const target_ = state?.target ?? 20;
      const base    = this._pending.newTotal;
      const isDouble = target.dataset.displayLabel === "Double" && selectedVal !== null;
      const total   = isDouble
        ? base + this._pending.val   // Double: dodaje jeszcze raz wartość dobranej karty
        : base + (selectedVal ?? 0);
      totalEl.textContent = `${total} pkt`;
      totalEl.className   = "pzk-pending-total"
        + (total > target_   ? " pzk-val-bust"
         : total === target_ ? " pzk-val-perfect" : "");

      // Dynamically update BUST/PERFECT badges based on the new total with pending card.
      const bustBadge    = this.element.querySelector(".pzk-bust-badge");
      const perfectBadge = this.element.querySelector(".pzk-perfect-badge");
      if (bustBadge)    bustBadge.style.display    = total > target_   ? "" : "none";
      if (perfectBadge) perfectBadge.style.display = total === target_ ? "" : "none";
    }
  }

  static async _onResetGame(event, target) {
    const ok = await _confirm(
      t("confirmResetTitle"),
      t("confirmResetBody")
    );
    if (!ok) return;
    this._pending = null;
    const state = loadState();
      // Refund wager to each player before clearing game state to avoid losing currency.
    if (state?.wager > 0) {
      for (const id of state.playerIds ?? []) {
        await adjustCurrency(id, state.wager, state.wagerCurrency);
      }
      await chat(t("chatWagerRefunded", {
        amount:   state.wager,
        currency: state.wagerCurrency,
      }));
    }
    await resetHandTables(state);
    await clearState();
    await chat(t("notifReset"));
    this.render({ force: true });
  }

  static async _onCancelWaiting(event, target) {
    const app = PazaakApp._instance;
    if (!app?._waitingForPicks) return;
    game.socket.emit(`module.${MODULE_ID}`, { type: "cancelDeckPick" });
    app._waitingForPicks = null;
    app.render({ force: true });
  }

  static _onOpenDeckBuilder(event, target) {
    DeckBuilderApp.openSingleton();
  }

  static _onCloseVictory() {
    PazaakApp._victoryOpen = false;
    PazaakApp._victoryData = null;
    PazaakApp._instance?.render({ force: true });
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Shows a confirmation dialog using DialogV2 or fallback to old Dialog.
 * @param {string} title - Dialog title.
 * @param {string} content - Dialog content.
 * @returns {Promise<boolean>} True if confirmed.
 */
async function _confirm(title, content) {
  const DV2 = foundry.applications?.api?.DialogV2;
  if (DV2) {
    return (await DV2.confirm({
      window: { title }, content, rejectClose: false,
    })) === true;
  }
  return Dialog.confirm({ title, content, defaultYes: false });
}

/**
 * Displays the hand deck selection dialog before starting the match.
 * @param {Token[]} tokens
 * @returns {Promise<{deckMap: Record<string,string>, wager: number, currency: string}|null>}
 *   Map actorId → table name + wager amount + currency key, or null if canceled.
 */
async function _showDeckSelectionDialog(tokens) {
  const cfg = getCfg();
  const activeCurrency = getActiveCurrency();
  const allCurrencies  = getAvailableCurrencies();

  // Collect available RollTable (only decks starting with "Pazzak", without the main deck)
  const allTables = game.tables.contents
    .filter(t => t.name !== cfg.tableName && t.name.startsWith("Pazzak"))
    .map(t => t.name)
    .sort((a, b) => a.localeCompare(b));

  if (!allTables.length) {
    ui.notifications.error(t("notifNoTable", { name: "RollTable" }));
    return null;
  }

  // Build a select row for each player
  const rows = tokens.map((tok, i) => {
    const actorName     = tok.actor?.name ?? `${t("statusWait")} ${i + 1}`;
    const actorId       = tok.actor?.id;
    const actorType     = tok.actor?.type ?? "npc";
    // Try to pre-select a specific table or fallback
    const specificName  = `${cfg.handTablePrefix}${actorName}`;
    const defaultDeck   = game.tables.getName(specificName)?.name
                       ?? game.tables.getName(cfg.fallbackHandTableName)?.name
                       ?? allTables[0];

    const options = allTables.map(name =>
      `<option value="${name}"${name === defaultDeck ? " selected" : ""}>${name}</option>`
    ).join("");

    return `
      <div class="pazaak-deck-row" data-actor-type="${actorType}">
        <label class="pazaak-deck-label">
          <b>${actorName}</b> — ${t("uiHand")}:
        </label>
        <select name="deck-${actorId}" class="pazaak-deck-select">
          ${options}
        </select>
      </div>`;
  }).join("");

  const content = `
    <div class="pazaak-deck-selection">
      <div style="margin-bottom:8px">
        <label style="display:flex;align-items:center;gap:8px;color:#d4c090;cursor:pointer">
          <input type="checkbox" name="pazaak-player-pick-mode" style="cursor:pointer;width:14px;height:14px">
          ${t("playerPickMode")}
        </label>
        <p style="font-size:0.8em;color:#808060;margin:2px 0 6px 22px">${t("playerPickModeHint")}</p>
      </div>
      <hr style="border-color:#4a4030;margin:6px 0 10px">
      ${rows}
      <hr style="border-color:#4a4030;margin:10px 0">
      <div class="pazaak-wager-row" style="display:flex;align-items:center;gap:8px;margin-top:4px">
        <label style="flex:0 0 auto;color:#d4c090">${t("wagerLabel")}:</label>
        <input type="number" name="pazaak-wager" min="0" step="1" value="0"
               style="width:80px;background:#1a1610;border:1px solid #4a4030;color:#d4c090;padding:4px 6px;border-radius:4px">
        <select name="pazaak-currency"
                style="flex:1;background:#1a1610;border:1px solid #4a4030;color:#d4c090;padding:4px 6px;border-radius:4px">
          ${allCurrencies.map(c => `<option value="${c.key}"${c.key === activeCurrency.key ? " selected" : ""}>${c.label}</option>`).join("")}
        </select>
      </div>
      <p style="font-size:0.8em;color:#808060;margin:4px 0 0">${t("wagerHint")}</p>
    </div>`;

    // Helper: attach listener to hide character rows when player pick mode is enabled.
  function _attachPickModeListener(root) {
    const cb   = root.querySelector("[name='pazaak-player-pick-mode']");
    const rows = root.querySelectorAll("[data-actor-type='character']");
    if (!cb) return;
    cb.addEventListener("change", () => {
      rows.forEach(el => { el.style.display = cb.checked ? "none" : ""; });
    });
  }

  // Use DialogV2 (Foundry v14+) for modern dialog, fallback to old Dialog for compatibility.
  const DV2 = foundry.applications?.api?.DialogV2;
  let formEl = null;

  if (DV2) {
    const result = await DV2.wait({
      window:      { title: t("deckDialogTitle") },
      content,
      rejectClose: false,
      render:      (event, dialog) => {
        const root = dialog.element.querySelector(".pazaak-deck-selection");
        if (root) _attachPickModeListener(root);
      },
      buttons: [
        {
          action:   "start",
          label:    t("deckDialogConfirm"),
          default:  true,
          callback: (event, button, dialog) => {
            formEl = dialog.element.querySelector(".pazaak-deck-selection");
            return true;
          },
        },
        { action: "cancel", label: t("deckDialogCancel"), callback: () => false },
      ],
    });
    if (!result) return null;
  } else {
    // Fallback old Dialog
    const picked = await new Promise(resolve => {
      let res = null;
      new Dialog({
        title:   t("deckDialogTitle"),
        content: `<form>${content}</form>`,
        buttons: {
          start:  { label: t("deckDialogConfirm"), callback: html => {
            formEl = html.find(".pazaak-deck-selection")[0];
            res = true;
          }},
          cancel: { label: t("deckDialogCancel"), callback: () => { res = false; } },
        },
        render: html => _attachPickModeListener(html.find(".pazaak-deck-selection")[0]),
        close: () => resolve(res ?? false),
        default: "start",
      }, { width: 440 }).render(true);
    });
    if (!picked) return null;
  }

  // Read choices from the form
  const playerPickMode = !!(formEl?.querySelector("[name='pazaak-player-pick-mode']")?.checked);
  const deckMap = {};
  for (const tok of tokens) {
    const id  = tok.actor?.id;
    if (!id) continue;
    // When players choose their own decks, skip character tokens (they will select via dialog)
    if (playerPickMode && tok.actor?.type === "character") continue;
    const sel = formEl?.querySelector(`[name="deck-${id}"]`);
    deckMap[id] = sel?.value ?? cfg.fallbackHandTableName;
  }
  const wager    = Math.max(0, Number(formEl?.querySelector("[name='pazaak-wager']")?.value ?? 0) || 0);
  const currency  = formEl?.querySelector("[name='pazaak-currency']")?.value ?? activeCurrency.key;
  return { deckMap, wager, currency, playerPickMode };
}

// ── Player deck selection mode ────────────────────────────────────────────

/**
 * Starts the player deck selection mode for character tokens.
 * NPCs use pre-selected decks, characters choose via dialog.
 * @param {Token[]} tokens - All selected tokens.
 * @param {number} wager - Wager amount.
 * @param {string} currency - Currency key.
 * @param {Record<string,string>} npcDeckMap - Pre-selected decks for NPCs.
 */
async function _startPlayerPickMode(tokens, wager, currency, npcDeckMap = {}) {
  const cfg    = getCfg();
  const tables = game.tables.contents
    .filter(t => t.name !== cfg.tableName && t.name.startsWith("Pazzak"))
    .map(t => t.name)
    .sort((a, b) => a.localeCompare(b));

  // Split into player characters and NPCs
  const charTokens = tokens.filter(tok => tok.actor?.type === "character");
  const npcTokens  = tokens.filter(tok => tok.actor?.type !== "character");

  // Default decks only for player characters (NPCs already have chosen)
  const defaults = {};
  for (const tok of charTokens) {
    const specificName = `${cfg.handTablePrefix}${tok.actor.name}`;
    defaults[tok.actor.id] =
      game.tables.getName(specificName)?.name ??
      game.tables.getName(cfg.fallbackHandTableName)?.name ??
      tables[0] ?? "";
  }

  // NPC decks are pre-selected from the dialog.
  const collected   = new Map(Object.entries(npcDeckMap));
  const playerList  = tokens.map(tok => ({
    actorId: tok.actor.id,
    name:    tok.actor.name,
    picked:  tok.actor.type !== "character",  // NPC od razu zaznaczone
  }));

  this._waitingForPicks = {
    tokens,
    wager,
    currency,
    expectedIds: new Set(tokens.map(tok => tok.actor.id)),
    collected,
    playerList,
  };

  if (charTokens.length === 0) {
    // No player characters — game starts immediately
    const deckMap = Object.fromEntries(collected);
    this._waitingForPicks = null;
    await startMatch(tokens, deckMap, wager, currency);
    this.render({ force: true });
    return;
  }

  // Broadcast deck pick request only to player characters; NPCs use pre-selected decks.
  game.socket.emit(`module.${MODULE_ID}`, {
    type:       "requestDeckPick",
    actorIds:   charTokens.map(tok => tok.actor.id),
    actorNames: Object.fromEntries(charTokens.map(tok => [tok.actor.id, tok.actor.name])),
    tables,
    defaults,
  });

  // GM handles deck selection for player characters without an active connected user.
  for (const tok of charTokens) {
    const hasConnectedPlayer = game.users.contents.some(
      u => !u.isGM && u.active && tok.actor.testUserPermission(u, "OWNER")
    );
    if (!hasConnectedPlayer && tok.actor.testUserPermission(game.user, "OWNER")) {
      showPlayerDeckPickDialog(tok.actor.id, tok.actor.name, tables, defaults[tok.actor.id]);
    }
  }

  this.render({ force: true });
}

/**
 * Called when a player (or GM) confirms deck choice.
 * Exported — called from pazaak.mjs via socket.
 */
export function onDeckPickResponse(actorId, deckName) {
  const app = PazaakApp._instance;
  if (!app?._waitingForPicks) return;

  const wp = app._waitingForPicks;
  wp.collected.set(actorId, deckName);
  const pl = wp.playerList.find(p => p.actorId === actorId);
  if (pl) pl.picked = true;

  if (wp.collected.size >= wp.expectedIds.size) {
    const { tokens, wager, currency } = wp;
    const deckMap = Object.fromEntries(wp.collected);
    app._waitingForPicks = null;
    startMatch(tokens, deckMap, wager, currency).then(() => app.render({ force: true }));
  } else {
    app.render({ force: true });
  }
}

/**
 * Shows the player the deck selection dialog.
 * If GM — responds locally; if player — via socket.
 * Exported — called from pazaak.mjs.
 */
export async function showPlayerDeckPickDialog(actorId, actorName, tables, defaultDeck) {
  // Players see only decks they have at least LIMITED permission to, for security.
  const visibleTables = tables.filter(name => {
    const tbl = game.tables.getName(name);
    return !tbl || game.user.isGM || tbl.testUserPermission(game.user, "LIMITED");
  });

  if (!visibleTables.length) {
    _sendDeckPickResponse(actorId, defaultDeck);
    return;
  }

  // Make sure the default deck is visible; if not — use the first available deck
  const safeDefault = visibleTables.includes(defaultDeck) ? defaultDeck : visibleTables[0];

  const options = visibleTables.map(name =>
    `<option value="${name}"${name === safeDefault ? " selected" : ""}>${name}</option>`
  ).join("");

  const content = `
    <div style="padding:4px">
      <p style="margin:0 0 8px;color:#d4c090">${t("pickDeckHint")}</p>
      <select name="deck" style="width:100%;background:#1a1610;border:1px solid #4a4030;color:#d4c090;padding:4px 6px;border-radius:4px">
        ${options}
      </select>
    </div>`;

  const DV2 = foundry.applications?.api?.DialogV2;
  let deckName = safeDefault;

  if (DV2) {
    let formEl = null;
    const result = await DV2.wait({
      window:      { title: `${actorName} — ${t("pickDeckTitle")}` },
      content,
      rejectClose: false,
      buttons: [
        {
          action:   "confirm",
          label:    t("deckDialogConfirm"),
          default:  true,
          callback: (event, button, dialog) => { formEl = dialog.element; return true; },
        },
        { action: "cancel", label: t("deckDialogCancel"), callback: () => false },
      ],
    });
    if (result && formEl) deckName = formEl.querySelector("[name='deck']")?.value ?? safeDefault;
  } else {
    await new Promise(resolve => {
      let picked = safeDefault;
      new Dialog({
        title:   `${actorName} — ${t("pickDeckTitle")}`,
        content: `<form>${content}</form>`,
        buttons: {
          confirm: { label: t("deckDialogConfirm"), callback: html => { picked = html.find("[name='deck']").val() ?? safeDefault; } },
          cancel:  { label: t("deckDialogCancel") },
        },
        close: () => { deckName = picked; resolve(); },
        default: "confirm",
      }, { width: 380 }).render(true);
    });
  }

  _sendDeckPickResponse(actorId, deckName);
}

/**
 * Sends the deck pick response: locally if GM, via socket if player.
 * @param {string} actorId - Actor ID.
 * @param {string} deckName - Selected deck name.
 */
function _sendDeckPickResponse(actorId, deckName) {
  if (game.user.isGM) {
    onDeckPickResponse(actorId, deckName);
  } else {
    game.socket.emit(`module.${MODULE_ID}`, { type: "deckPickResponse", actorId, deckName });
  }
}

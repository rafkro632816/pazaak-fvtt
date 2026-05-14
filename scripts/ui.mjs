// ============================================================
//  Pazaak — ui.mjs
//  Render chat messages
// ============================================================

import { getCfg, t }    from "./config.mjs";
import { migrateState }  from "./state.mjs";

// ─── Text helpers ─────────────────────────────────────────────────────────

/**
 * Format a numeric card value with an explicit plus sign when positive.
 */
export function signed(n) { return n > 0 ? `+${n}` : `${n}`; }

/**
 * Parse a numeric card value from a UI label string.
 * Supports values like "+/-1", "+2", and "-3".
 */
export function parseCardValue(text) {
  const s = String(text ?? "").trim();
  if (s.includes("+/-")) return Number.parseInt(s.match(/\d+/)?.[0] ?? "0");
  return Number.parseInt(s.match(/[+-]?\d+/)?.[0] ?? "0");
}

// Internal formatter helpers for chat output
function fmt(arr, fn) { return arr?.length ? arr.map(fn).join(", ") : "â€”"; }
function formatDraws(p)    { return fmt(p.draws,    signed); }
function formatHandMods(p) { return fmt(p.handMods, x => x); }

/**
 * Render the current game state as a chat-friendly HTML block.
 * Includes player scores, round progress, and draw/hand details.
 */
// ─── Game state rendering (for chat) ─────────────────────────────────────────

export function renderState(state, heading) {
  migrateState(state);
  const cfg = getCfg();

  const playerCards = state.playerIds.map((id, i) => {
    const p      = state.scores[id];
    if (!p) return "";
    const active = i === state.turn && !p.stood && !p.busted;
    const status = p.busted ? `<b style="color:#c00">${t("uiBust")}</b>`
                 : p.stood  ? `<i>${t("uiStood")}</i>`
                 : active   ? `<b style="color:#4a9">${t("statusActive")} â–š</b>`
                             : t("uiWaiting");

    // Hand cards are excluded from chat rendering because they are private.
    // The PazaakApp UI handles hand visibility separately with masking.

    return `
      <div class="pazaak-player-card${active ? " pazaak-active" : ""}">
        <div class="pazaak-player-name">${active ? "â–¶ " : ""}${p.name}</div>
        <div class="pazaak-player-row">
          <span>${t("uiScore")}: <b>${p.score} / ${cfg.target}</b></span>
          <span>${status}</span>
          <span>${t("uiRounds")}: <b>${p.roundWins}/${cfg.roundsToWin}</b></span>
        </div>
        <div class="pazaak-player-detail">
          <span>${t("uiDrawn")}: ${formatDraws(p)}</span>
          <span>${t("uiFromHand")}: ${formatHandMods(p)}</span>
        </div>
      </div>`;
  }).join("");

  return `
    <div class="pazaak-state">
      <div class="pazaak-heading">${heading}</div>
      <div class="pazaak-meta">
        ${t("uiRound")} <b>${state.gameRound}</b> &nbsp;|&nbsp;
        ${t("uiCycle")} <b>${state.turnCycle}</b> &nbsp;|&nbsp;
        ${t("uiTarget")} <b>${state.target}</b>
      </div>
      ${playerCards}
    </div>`;
}

/**
 * Render the end-of-match chat message using the winner names.
 */
/**
 * Render the final match result text for chat.
 */
export function renderMatchEnd(state, winners) {
  const names = winners.map(w => `<b>${w.name}</b>`).join(" i ");
  return t("chatMatchEnd", { names });
}
// ─── Chat message helper ───────────────────────────────────────────────────

/**
 * Send formatted HTML/text to the Foundry chat log.
 */
export async function chat(content) {
  const cfg = getCfg();
  return ChatMessage.create({
    speaker: { alias: cfg.chatAlias },
    content,
  });
}

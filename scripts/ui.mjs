// ============================================================
//  Pazaak â€” ui.mjs
//  Rendering wiadomosci czat
// ============================================================

import { getCfg, t }    from "./config.mjs";
import { migrateState }  from "./state.mjs";

// â”€â”€â”€ Pomocniki tekstowe â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function signed(n) { return n > 0 ? `+${n}` : `${n}`; }

export function parseCardValue(text) {
  const s = String(text ?? "").trim();
  if (s.includes("+/-")) return Number.parseInt(s.match(/\d+/)?.[0] ?? "0");
  return Number.parseInt(s.match(/[+-]?\d+/)?.[0] ?? "0");
}

function fmt(arr, fn) { return arr?.length ? arr.map(fn).join(", ") : "â€”"; }
function formatDraws(p)    { return fmt(p.draws,    signed); }
function formatHandMods(p) { return fmt(p.handMods, x => x); }

// â”€â”€â”€ Renderowanie stanu gry (do chatu) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function renderState(state, heading) {
  migrateState(state);
  const cfg = getCfg();

  const playerCards = state.playerIds.map((id, i) => {
    const p      = state.scores[id];
    if (!p) return "";
    const active = i === state.turn && !p.stood && !p.busted;
    const status = p.busted ? `<b style="color:#c00">${t("uiBust")}</b>`
                 : p.stood  ? `<i>${t("uiStood")}</i>`
                 : active   ? `<b style="color:#4a9">${t("statusActive")} â–ş</b>`
                             : t("uiWaiting");

    // Karty w rÄ™ce nie sÄ… pokazywane w chacie â€” to prywatna informacja gracza.
    // SÄ… widoczne (z maskowaniem) w oknie PazaakApp.

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

export function renderMatchEnd(state, winners) {
  const names = winners.map(w => `<b>${w.name}</b>`).join(" i ");
  return t("chatMatchEnd", { names });
}
// â”€â”€â”€ WiadomoĹ›Ä‡ czat â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function chat(content) {
  const cfg = getCfg();
  return ChatMessage.create({
    speaker: { alias: cfg.chatAlias },
    content,
  });
}

// ============================================================
//  Pazaak — journal.mjs
//  Zapis historii gier w JournalEntry "Pazaak - Games History"
// ============================================================

import { MODULE_ID, getCfg, t } from "./config.mjs";

export const JOURNAL_NAME = "Pazaak - Games History";

/** Zwraca zlokalizowaną nazwę journalu (używaj do szukania, nie do klucza i18n). */
export function getJournalName() {
  return t("journalName");
}

// ─── Pomocniki ────────────────────────────────────────────────────────────────

function _getJournal() {
  return game.journal?.getName(JOURNAL_NAME) ?? null;
}

function _pad(n) { return String(n).padStart(2, "0"); }

function _timestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${_pad(d.getMonth()+1)}-${_pad(d.getDate())} `
       + `${_pad(d.getHours())}:${_pad(d.getMinutes())}`;
}

function _signed(n) { return n > 0 ? `+${n}` : `${n}`; }

// ─── API publiczne ────────────────────────────────────────────────────────────

/**
 * Tworzy journal "Pazaak - Games History" jeśli nie istnieje.
 * Wywołaj w setupie.
 */
export async function ensureGamesJournal() {
  if (_getJournal()) return;
  await JournalEntry.create({
    name:        JOURNAL_NAME,
    ownership:   { default: 2 },
  });
  console.log(`Pazaak | Stworzono journal "${JOURNAL_NAME}"`);
}

/**
 * Otwiera nową stronę w dzienniku dla bieżącego meczu.
 * Zwraca pageId do zapisania w state.
 * Tylko GM może tworzyć strony — jeśli wywołuje gracz, GM musi zainicjować mecz.
 */
export async function startGameLog(state) {
  if (!game.user.isGM) return null; // tylko GM tworzy stronę
  const journal = _getJournal();
  if (!journal) return null;

  const cfg     = getCfg();
  const ts      = _timestamp();
  const players = state.playerIds.map(id => state.scores[id]?.name ?? id).join(" vs ");
  const pageName = `${ts} — ${players}`;

  const header = `
<h2>⚔ Pazaak — ${players}</h2>
<p><em>${t("journalStart")}: ${ts} | ${t("journalGoal")}: ${cfg.target} | ${t("journalRoundsToWin")}: ${cfg.roundsToWin}</em></p>
<hr>`.trim();

  const pages = await journal.createEmbeddedDocuments("JournalEntryPage", [{
    name: pageName,
    type: "text",
    text: { content: header, format: 1 },
  }]);

  return pages[0]?.id ?? null;
}

/**
 * Dopisuje wiersz tury do aktywnej strony.
 */
export async function logTurn(state, entry) {
  await _appendHTML(state, _renderTurnRow(entry));
}

/**
 * Dopisuje wynik rundy.
 */
export async function logRoundEnd(state, winners, roundNum) {
  const result = !winners?.length
    ? t("journalDrawTie")
    : winners.length === 1
      ? `<b>${winners[0].name}</b> ${t("journalRoundWinner")} (${winners[0].score} ${t("journalPts")})`
      : `${t("journalRoundTie")}: ${winners.map(w => `<b>${w.name}</b>`).join(" & ")} (${winners[0].score} ${t("journalPts")})`;

  const scores = state.playerIds.map(id => {
    const p = state.scores[id];
    if (!p) return "";
    return `${p.name}: <b>${p.roundWins}</b> ${t("journalRoundWins")}`;
  }).join(" | ");

  const html = `
<p style="margin:6px 0 2px"><b>— ${t("journalRound", { n: roundNum })} —</b> ${result} &nbsp;<small>${scores}</small></p>
<hr style="margin:4px 0">`.trim();

  await _appendHTML(state, html);
}

/**
 * Finalizuje stronę z wynikiem meczu.
 */
export async function logMatchEnd(state, winners) {
  const names = winners.map(w => `<b>${w.name}</b>`).join(" & ");
  const ts    = _timestamp();
  const html  = `
<p style="margin:8px 0 4px; font-size:1.1em">🏆 <b>${t("journalMatchWinner")}</b> ${names}</p>
<p><em>${t("journalEnd")}: ${ts}</em></p>`.trim();
  await _appendHTML(state, html);
}

// ─── Wewnętrzne ───────────────────────────────────────────────────────────────

function _renderTurnRow(e) {
  // e = { name, card, hand, mod, total, stood, busted, autoStand }
  const handPart = e.hand ? ` + ${t("journalHandCard")} <em>${e.hand}</em> (${_signed(e.mod)})` : "";
  const status   = e.busted    ? `<span style="color:#c00"><b>${t("uiBust")}</b></span>`
                 : e.autoStand ? `<span style="color:#fa0"><b>${t("journalAutoStand")}</b></span>`
                 : e.stood     ? `<span style="color:#aaa"><em>${t("uiStood")}</em></span>`
                               : "";

  return `<p style="margin:2px 0; font-size:.9em">`
       + `<b>${e.name}</b>: ${t("journalDrew")} <b>${_signed(e.card)}</b>${handPart}`
       + ` = <b>${e.total} ${t("journalPoints")}</b>${status ? " &nbsp;" + status : ""}`
       + `</p>`;
}

async function _appendHTML(state, html) {
  if (!state?.gamePageId) return;
  if (game.user.isGM) {
    const journal = _getJournal();
    if (!journal) return;
    const page = journal.pages?.get(state.gamePageId);
    if (!page) return;
    const existing = page.text?.content ?? "";
    await page.update({ "text.content": existing + "\n" + html });
  } else {
    game.socket.emit(`module.${MODULE_ID}`, {
      type:   "journalAppend",
      pageId: state.gamePageId,
      html,
    });
  }
}

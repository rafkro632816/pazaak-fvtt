// ============================================================
//  Pazaak — pazaak.mjs
//  Entry point: hooki, scene controls, API publiczne
// ============================================================

import { MODULE_ID, registerSettings, getCfg, t,
         setTranslations, applyModuleLang }         from "./config.mjs";
import { loadState, clearState, migrateState,
         registerStateSetting }                 from "./state.mjs";
import { chat, renderState }                     from "./ui.mjs";
import { setupPazaakWorld, ensureGeneratedFolder } from "./setup.mjs";
import { JOURNAL_NAME }                          from "./journal.mjs";
import { PazaakApp, onDeckPickResponse, showPlayerDeckPickDialog } from "./app.mjs";
import { adjustCurrency }                        from "./game.mjs";
import { DeckBuilderApp }                        from "./deck-builder.mjs";

// Udostępnij referencję do PazaakApp dla onChange w registerSettings
globalThis._pazaakAppRef = { PazaakApp };

// ── i18nInit — wczytaj OBA pliki językowe zanim cokolwiek się wyrenderuje ─────

Hooks.once("i18nInit", async () => {
  const langs = ["en", "pl"];
  await Promise.all(langs.map(async (lang) => {
    try {
      const resp = await fetch(`/modules/${MODULE_ID}/lang/${lang}.json`);
      if (resp.ok) {
        const data = await resp.json();
        setTranslations(lang, data);
        console.log(`${MODULE_ID} | Załadowano lang/${lang}.json`);
      }
    } catch (e) {
      console.warn(`${MODULE_ID} | Błąd ładowania lang/${lang}.json:`, e);
    }
  }));

  // Zastosuj język wybrany w ustawieniach modułu (niezależnie od języka Foundry)
  const moduleLang = (() => {
    try { return game.settings.get(MODULE_ID, "language"); } catch { return "pl"; }
  })();
  applyModuleLang(moduleLang);
  console.log(`${MODULE_ID} | Aktywny język modułu: ${moduleLang}`);
});

// ── init ──────────────────────────────────────────────────────────────────────

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init`);
  registerSettings();
  registerStateSetting(() => PazaakApp._instance?.render({ force: true }));
  Handlebars.registerHelper("pazaakSigned", n => (n > 0 ? `+${n}` : String(n)));
  Handlebars.registerHelper("gt", (a, b) => a > b);
  Handlebars.registerHelper("eq", (a, b) => a === b);
  (foundry.applications.handlebars.loadTemplates ?? loadTemplates)([
    `modules/${MODULE_ID}/templates/pazaak-app.hbs`,
    `modules/${MODULE_ID}/templates/deck-builder.hbs`,
    `modules/${MODULE_ID}/templates/victory.hbs`,
  ]);
});

// Ekran zwycięzcy — wywołany przez Hooks.call w game.mjs
Hooks.on("pazaakVictory", (data) => {
  PazaakApp._victoryData = data;
  PazaakApp._victoryOpen = true;
  PazaakApp._instance?.render({ force: true });
});

// ── ready ─────────────────────────────────────────────────────────────────────

Hooks.once("ready", async () => {
  console.log(`${MODULE_ID} | ready`);

  game.pazaak = {
    open:       () => PazaakApp.openSingleton(),
    startGame:  () => PazaakApp.openSingleton(),
    resetGame:  async () => {
      const app = PazaakApp.openSingleton();
      const ok = await Dialog.confirm({
        title:      t("confirmResetTitle"),
        content:    `<p>${t("confirmResetBody")}</p>`,
        defaultYes: false,
      });
      if (!ok) return;
      app._pending = null;
      await clearState();
      await chat(t("notifReset"));
      app.render();
    },
    showStatus: async () => {
      PazaakApp.openSingleton();
      const state = loadState();
      if (!state) { ui.notifications.info(t("notifNoGame")); return; }
      migrateState(state);
      await chat(renderState(state, t("chatStatusHeader")));
    },
    setup: setupPazaakWorld,
  };

  // Socket relay
  game.socket.on(`module.${MODULE_ID}`, async (msg) => {
    // GM-only: zapis stanu i journalu
    if (game.user.isGM) {
      if (msg.type === "saveState")     await game.settings.set(MODULE_ID, "pazaakState", msg.state);
      if (msg.type === "clearState")    await game.settings.set(MODULE_ID, "pazaakState", null);
      if (msg.type === "journalAppend") await _handleJournalAppend(msg);
      if (msg.type === "adjustCurrency")
        await adjustCurrency(msg.actorIdOrName, msg.delta, msg.currencyKey, msg.byName);
      if (msg.type === "deckPickResponse")
        onDeckPickResponse(msg.actorId, msg.deckName);
    }
    // Wszyscy klienci: synchronizacja pending (dobrana karta przed zatwierdzeniem)
    if (msg.type === "setPending") {
      const app = PazaakApp._instance;
      if (app) { app._pending = msg.pending; app.render({ force: true }); }
    }
    if (msg.type === "clearPending") {
      const app = PazaakApp._instance;
      if (app) { app._pending = null; app.render({ force: true }); }
    }
    // Żądanie wyboru talii — wysłane przez GM do graczy
    if (msg.type === "requestDeckPick") {
      const { actorIds, actorNames, tables, defaults } = msg;
      for (const actorId of actorIds) {
        const actor = game.actors.get(actorId);
        if (!actor) continue;
        // Tylko klient który posiada tego aktora (i nie jest GM — GM obsługuje lokalnie)
        if (!game.user.isGM && actor.testUserPermission(game.user, "OWNER")) {
          showPlayerDeckPickDialog(actorId, actorNames[actorId], tables, defaults[actorId]);
        }
      }
    }
    // Anulowanie trybu wyboru przez GM
    if (msg.type === "cancelDeckPick") {
      const app = PazaakApp._instance;
      if (app?._waitingForPicks) { app._waitingForPicks = null; app.render({ force: true }); }
    }
    // Ekran zwycięzcy (wszyscy gracze, GM już obsłużony przez Hook w game.mjs)
    if (msg.type === "showVictory" && !game.user.isGM) {
      PazaakApp._victoryData = { name: msg.name, actorId: msg.actorId, pot: msg.pot, currency: msg.currency };
      PazaakApp._victoryOpen = true;
      PazaakApp._instance?.render({ force: true });
    }
  });

  if (game.user.isGM) await _autoSetup();
  console.log(`${MODULE_ID} | game.pazaak API gotowe`);
});

// ── Scene Controls — przycisk na lewym pasku ──────────────────────────────────

Hooks.on("getSceneControlButtons", (controls) => {
  if (!Array.isArray(controls)) return;
  const tokenLayer = controls.find(c => c.name === "token");
  if (!tokenLayer) return;
  tokenLayer.tools ??= [];
  tokenLayer.tools.push({
    name:    "pazaak",
    title:   "Pazaak",
    icon:    "fas fa-table",
    visible: true,
    button:  true,
    onClick: () => PazaakApp.openSingleton(),
  });
});

// ── Zakładka w prawym pasku bocznym ─────────────────────────────────────────────
//
//  MutationObserver obserwuje #sidebar i wstrzykuje przycisk za każdym razem
//  gdy Foundry przebuduje nav. Capture-phase listener łapie klik zanim Foundry
//  wykryje brakujący panel i przerwie akcję.

function _injectSidebarBtn() {
  // Foundry v14: przyciski są w <menu class="flexcol"> wewnątrz <nav id="sidebar-tabs">
  const menu =
    document.querySelector("#sidebar-tabs > menu") ||
    document.querySelector("#sidebar-tabs");
  if (!menu) return;
  if (menu.querySelector(".pazaak-tab-btn")) return;

  // Wstawiamy <li> przed ostatnim przyciskiem (collapse), żeby być w grupie
  const li  = document.createElement("li");
  const btn = document.createElement("button");
  btn.type      = "button";
  // ui-control plain icon to klasy natywnych zakładek — daje identyczny wygląd
  btn.className = "ui-control plain pazaak-tab-btn";
  btn.innerHTML = '<img src="modules/pazaak-fvtt/assets/Icons/pazaak_cards_icon.svg" alt="Pazaak" style="width:1.2em;height:1.2em;">';
  btn.setAttribute("aria-label", "Pazaak");
  btn.setAttribute("data-tooltip", "Pazaak");
  // NIE ustawiamy data-action="tab" ani data-tab — żeby Foundry nie szukał panelu
  li.appendChild(btn);

  const collapseLi = menu.querySelector("li:last-child");
  if (collapseLi) menu.insertBefore(li, collapseLi);
  else            menu.appendChild(li);
}

// Capture-phase: odpala się PRZED handlerami Foundry
document.addEventListener("click", (e) => {
  if (!e.target.closest(".pazaak-tab-btn")) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  PazaakApp.openSingleton();
}, true);

Hooks.once("ready", () => {
  _injectSidebarBtn();

  // Obserwuj cały sidebar — re-wstrzyknij gdy Foundry przebuduje nav
  const sidebar = document.getElementById("sidebar") ?? document.querySelector("aside#sidebar");
  if (!sidebar) return;
  const observer = new MutationObserver(_injectSidebarBtn);
  observer.observe(sidebar, { childList: true, subtree: true });
});

async function _autoSetup() {
  const cfg = getCfg();
  const needsSetup = !game.tables.getName(cfg.tableName)
                  || !game.tables.getName("Pazzak - Standard")
                  || !game.journal?.getName(JOURNAL_NAME);
  if (needsSetup) {
    console.log(`${MODULE_ID} | Pierwsze uruchomienie — auto-setup…`);
    await setupPazaakWorld();
  } else {
    // Migracja folderów — przenieś istniejące tabele do właściwych folderów (idempotentna)
    await setupPazaakWorld();
  }
}

async function _handleJournalAppend({ pageId, html }) {
  const journal = game.journal?.getName(JOURNAL_NAME);
  if (!journal) return;
  const page = journal.pages?.get(pageId);
  if (!page) return;
  const existing = page.text?.content ?? "";
  await page.update({ "text.content": existing + "\n" + html });
}

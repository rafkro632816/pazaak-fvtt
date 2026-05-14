// ============================================================
//  Pazaak — pazaak.mjs
//  Entry point for module lifecycle hooks, scene controls, and public API bindings
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

// Expose PazaakApp to module settings callbacks so the UI can re-render on onChange
globalThis._pazaakAppRef = { PazaakApp };

// ── i18nInit — preload module translation assets before UI initialization ─────

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

  // Apply the module-selected language independently of Foundry's UI language
  const moduleLang = (() => {
    try { return game.settings.get(MODULE_ID, "language"); } catch { return "pl"; }
  })();
  applyModuleLang(moduleLang);
  console.log(`${MODULE_ID} | Aktywny język modułu: ${moduleLang}`);
});

// ── init — configure module settings, state persistence, and template helpers ─────

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

// Victory screen event from game.mjs: open the local victory display when received
Hooks.on("pazaakVictory", (data) => {
  PazaakApp._victoryData = data;
  PazaakApp._victoryOpen = true;
  PazaakApp._instance?.render({ force: true });
});

// ── ready ─────────────────────────────────────────────────────────────────────

Hooks.once("ready", async () => {
  console.log(`${MODULE_ID} | ready`);

  // Public API available under game.pazaak for UI and external scripts
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

  // Socket relay: handle module messages and delegate GM-only persistence operations
  game.socket.on(`module.${MODULE_ID}`, async (msg) => {
    // GM-only operations: persist state and journal updates on the server side
    if (game.user.isGM) {
      if (msg.type === "saveState")     await game.settings.set(MODULE_ID, "pazaakState", msg.state);
      if (msg.type === "clearState")    await game.settings.set(MODULE_ID, "pazaakState", null);
      if (msg.type === "journalAppend") await _handleJournalAppend(msg);
      if (msg.type === "adjustCurrency")
        await adjustCurrency(msg.actorIdOrName, msg.delta, msg.currencyKey, msg.byName);
      if (msg.type === "deckPickResponse")
        onDeckPickResponse(msg.actorId, msg.deckName);
    }
    // Broadcast pending draw state to all clients so the UI stays in sync
    if (msg.type === "setPending") {
      const app = PazaakApp._instance;
      if (app) { app._pending = msg.pending; app.render({ force: true }); }
    }
    if (msg.type === "clearPending") {
      const app = PazaakApp._instance;
      if (app) { app._pending = null; app.render({ force: true }); }
    }
    // Deck pick request: GM asks players to choose from available deck tables
    if (msg.type === "requestDeckPick") {
      const { actorIds, actorNames, tables, defaults } = msg;
      for (const actorId of actorIds) {
        const actor = game.actors.get(actorId);
        if (!actor) continue;
        // Only the actor owner client should open the deck pick dialog, not the GM
        if (!game.user.isGM && actor.testUserPermission(game.user, "OWNER")) {
          showPlayerDeckPickDialog(actorId, actorNames[actorId], tables, defaults[actorId]);
        }
      }
    }
    // Cancel deck-pick mode: clear player waiting state when GM aborts selection
    if (msg.type === "cancelDeckPick") {
      const app = PazaakApp._instance;
      if (app?._waitingForPicks) { app._waitingForPicks = null; app.render({ force: true }); }
    }
    // Show victory dialog for non-GM clients; GM is handled via the game.mjs hook
    if (msg.type === "showVictory" && !game.user.isGM) {
      PazaakApp._victoryData = { name: msg.name, actorId: msg.actorId, pot: msg.pot, currency: msg.currency };
      PazaakApp._victoryOpen = true;
      PazaakApp._instance?.render({ force: true });
    }
  });

  if (game.user.isGM) await _autoSetup();
  console.log(`${MODULE_ID} | game.pazaak API gotowe`);
});

// ── Scene Controls — add the Pazaak toolbar button to the left sidebar ───────

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

// ── Sidebar tab button workaround ───────────────────────────────────────────
//
//  MutationObserver watches #sidebar and reinjects the button whenever
//  Foundry rebuilds the nav. The capture-phase listener intercepts clicks before
//  Foundry tries to resolve a missing tab panel.

/**
 * Ensures the Pazaak sidebar button is present in the Foundry tab bar.
 * This is a DOM-level workaround because the module does not use a native sidebar tab panel.
 */
function _injectSidebarBtn() {
  // Foundry v14: buttons live in <menu class="flexcol"> inside <nav id="sidebar-tabs">
  const menu =
    document.querySelector("#sidebar-tabs > menu") ||
    document.querySelector("#sidebar-tabs");
  if (!menu) return;
  if (menu.querySelector(".pazaak-tab-btn")) return;

  // Insert <li> before the last button (collapse) so it remains grouped with sidebar controls
  const li  = document.createElement("li");
  const btn = document.createElement("button");
  btn.type      = "button";
  // ui-control plain icon matches native tabs for a consistent appearance
  btn.className = "ui-control plain pazaak-tab-btn";
  btn.innerHTML = '<img src="modules/pazaak-fvtt/assets/Icons/pazaak_cards_icon.svg" alt="Pazaak" style="width:1.2em;height:1.2em;">';
  btn.setAttribute("aria-label", "Pazaak");
  btn.setAttribute("data-tooltip", "Pazaak");
  // Do NOT set data-action="tab" or data-tab so Foundry does not look for a tab panel
  li.appendChild(btn);

  const collapseLi = menu.querySelector("li:last-child");
  if (collapseLi) menu.insertBefore(li, collapseLi);
  else            menu.appendChild(li);
}

/**
 * Capture-phase listener prevents Foundry from trying to handle the pseudo-tab click.
 */
document.addEventListener("click", (e) => {
  if (!e.target.closest(".pazaak-tab-btn")) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  PazaakApp.openSingleton();
}, true);

Hooks.once("ready", () => {
  _injectSidebarBtn();

  // Observe the full sidebar and reinsert the button when Foundry rebuilds the nav
  const sidebar = document.getElementById("sidebar") ?? document.querySelector("aside#sidebar");
  if (!sidebar) return;
  const observer = new MutationObserver(_injectSidebarBtn);
  observer.observe(sidebar, { childList: true, subtree: true });
});

/**
 * Ensure required module world assets exist and perform idempotent folder migration.
 * Called only on the GM client during startup.
 */
async function _autoSetup() {
  const cfg = getCfg();
  const needsSetup = !game.tables.getName(cfg.tableName)
                  || !game.tables.getName("Pazzak - Standard")
                  || !game.journal?.getName(JOURNAL_NAME);
  if (needsSetup) {
    console.log(`${MODULE_ID} | Pierwsze uruchomienie — auto-setup…`);
    await setupPazaakWorld();
  } else {
    // Folder migration — move existing tables into the correct folders (idempotent)
    await setupPazaakWorld();
  }
}

/**
 * Append HTML to the current match journal page from the GM client.
 */
async function _handleJournalAppend({ pageId, html }) {
  const journal = game.journal?.getName(JOURNAL_NAME);
  if (!journal) return;
  const page = journal.pages?.get(pageId);
  if (!page) return;
  const existing = page.text?.content ?? "";
  await page.update({ "text.content": existing + "\n" + html });
}

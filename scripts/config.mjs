// ============================================================
//  Pazaak — config.mjs
//  Configuration constants and module settings registration
// ============================================================

export const MODULE_ID = "pazaak-fvtt";

/** Bundled translations independent of core Foundry language. */
/** { pl: { "PAZAAK.x": "...", ... }, en: { ... } } */
const _tr = {};

/**
 * Sets the translations for a specific language.
 * Call from pazaak.mjs after loading the language file to make translations available.
 * @param {string} lang - Language code (e.g., "en", "pl").
 * @param {object} data - Translation object.
 */
export function setTranslations(lang, data) {
  _tr[lang] = data;
}

/**
 * Applies module translations to Foundry's i18n system.
 * Merges selected language translations into game.i18n.translations for HBS {{localize}} support.
 * @param {string} lang - Language code to apply.
 */
export function applyModuleLang(lang) {
  const data = _tr[lang] ?? _tr["en"];
  if (!data) return;
  for (const [k, v] of Object.entries(data)) {
    game.i18n.translations[k] = v;
  }
}

/**
 * Translates a key using the module's dictionary.
 * Language selected from module settings (not core game.i18n.lang).
 * Supports simple substitutions like t("key", { name: "X" }).
 * @param {string} key - Translation key (e.g., "settingLanguage").
 * @param {object} [data={}] - Substitution data.
 * @returns {string} Translated string.
 */
export function t(key, data = {}) {
  const lang = (() => { try { return game.settings.get(MODULE_ID, "language"); } catch { return DEFAULTS.language; } })();
  const map  = _tr[lang] ?? _tr["en"] ?? {};
  let str    = map[`PAZAAK.${key}`] ?? game.i18n.localize(`PAZAAK.${key}`);
  for (const [k, v] of Object.entries(data)) str = str.replace(`{${k}}`, v);
  return str;
}

/** Default configuration values, used before game.settings loads. */
export const DEFAULTS = {
  language:              "en",
  tableName:             "Pazaak - Cukier base",
  handTablePrefix:       "Pazzak - ",
  fallbackHandTableName: "Pazzak - Standard",
  handSize:              4,
  maxHandPlays:          3,
  handCardsLimitScope:   "match",   // "match" | "round"
  redrawHandEachRound:   false,
  target:                20,
  roundsToWin:           3,
  wagerCurrency:         "auto",
  showDeckName:          true,
  deckSizeLimit:         10,
  chatAlias:             "Pazaak",
  flagScope:             "world",
  flagName:              "pazaakState",
};

/**
 * Retrieves available currencies based on active system/modules.
 * Supports SW5E, dnd5e, and generic fallback.
 * @returns {Array<{key: string, label: string, path: string}>} Currency list.
 */
export function getAvailableCurrencies() {
  const sys = (game.system?.id ?? "").toLowerCase();

  // SW5E is a dnd5e-based module; check if active
  const isSW5E = game.modules?.get("sw5e-module")?.active === true;

  if (isSW5E) {
    // Check if sw-currency module is active and provides config
    const swMod = game.modules?.get("sw-currency") ?? game.modules?.get("sw5e-currency");
    if (swMod?.active) {
      try {
        const cfgSetting = game.settings.get(swMod.id, "currencies");
        if (Array.isArray(cfgSetting)) {
          const enabled = cfgSetting.filter(c => c.enabled !== false);
          if (enabled.length > 0) {
            return enabled.map(c => ({
              key:   c.abbreviation ?? c.key ?? c.id,
              label: `${c.label ?? c.name ?? c.key} (${c.abbreviation ?? c.key})`,
              path:  `system.currency.${c.abbreviation ?? c.key}`,
            }));
          }
        }
      } catch { /* ignore if settings unavailable */ }
    }
    // Default SW5E currencies
    return [
      { key: "gc",   label: "Galactic Credit (gc)", path: "system.currency.gc" },
      { key: "Wup",  label: "Wupiupi (Wup)",        path: "system.currency.Wup" },
      { key: "Trg",  label: "Trugut (Trg)",          path: "system.currency.Trg" },
      { key: "Pgt",  label: "Peggat (Pgt)",          path: "system.currency.Pgt" },
    ];
  }

  if (sys === "dnd5e" && !isSW5E) {
    return [
      { key: "gp", label: "Gold (gp)",     path: "system.currency.gp" },
      { key: "sp", label: "Silver (sp)",   path: "system.currency.sp" },
      { key: "cp", label: "Copper (cp)",   path: "system.currency.cp" },
      { key: "ep", label: "Electrum (ep)", path: "system.currency.ep" },
      { key: "pp", label: "Platinum (pp)", path: "system.currency.pp" },
    ];
  }

  // Generic fallback for unsupported currency systems
  return [{ key: "gp", label: "Gold (gp)", path: "system.currency.gp" }];
}

/**
 * Gets the active currency object.
 * If setting is "auto", selects the first available currency.
 * @returns {{key: string, label: string, path: string}} Active currency.
 */
export function getActiveCurrency() {
  const list = getAvailableCurrencies();
  try {
    const saved = game.settings.get(MODULE_ID, "wagerCurrency");
    if (saved && saved !== "auto") {
      const found = list.find(c => c.key === saved);
      if (found) return found;
    }
  } catch { /* fallback before init; settings may not be available */ }
  return list[0];
}

/**
 * Retrieves current module configuration (settings + constants).
 * Safe to call after the 'init' hook when game.settings is available.
 * @returns {object} Configuration object.
 */
export function getCfg() {
  // Helper to safely get settings; falls back to DEFAULTS if game.settings unavailable (e.g., before 'init' hook).
  const get = (key) => {
    try { return game.settings.get(MODULE_ID, key); }
    catch { return DEFAULTS[key]; }
  };
  return {
    language:              get("language"),
    tableName:             get("tableName"),
    handTablePrefix:       get("handTablePrefix"),
    fallbackHandTableName: get("fallbackHandTableName"),
    handSize:              get("handSize"),
    maxHandPlays:          get("maxHandPlays"),
    handCardsLimitScope:   get("handCardsLimitScope"),
    redrawHandEachRound:   get("redrawHandEachRound"),
    target:                get("target"),
    roundsToWin:           get("roundsToWin"),
    wagerCurrency:         get("wagerCurrency"),
    chatAlias:             "Pazaak",
    flagScope:             "world",
    flagName:              "pazaakState",
  };
}

/**
 * Registers all module settings in Foundry's settings system.
 * Call during the 'init' hook.
 */
export function registerSettings() {
  // Helper function for registering settings in Foundry's system.
  // Registers a world-scoped setting with default config=true, type, and optional extras (e.g., range, choices).
  const r = (key, type, def, name, hint, extra = {}) =>
    game.settings.register(MODULE_ID, key, {
      name, hint,
      scope: "world",
      config: true,
      type,
      default: def,
      ...extra,
    });

  // Interface language setting — placed at top of settings list
  r("language", String, DEFAULTS.language,
    "PAZAAK.settingLanguage", "PAZAAK.settingLanguageHint",
    {
      choices: { pl: "PAZAAK.langPl", en: "PAZAAK.langEn" },
      onChange: (value) => {
        applyModuleLang(value);
        // Re-render open app to apply language changes immediately
        const { PazaakApp } = globalThis._pazaakAppRef ?? {};
        PazaakApp?._instance?.render({ force: true });
      },
    });

  r("tableName",             String,  DEFAULTS.tableName,
    "PAZAAK.settingTableName",        "PAZAAK.settingTableNameHint");

  r("fallbackHandTableName", String,  DEFAULTS.fallbackHandTableName,
    "PAZAAK.settingFallbackHand",     "PAZAAK.settingFallbackHandHint");

  r("handTablePrefix",       String,  DEFAULTS.handTablePrefix,
    "PAZAAK.settingHandPrefix",       "PAZAAK.settingHandPrefixHint");

  r("handSize",              Number,  DEFAULTS.handSize,
    "PAZAAK.settingHandSize",         "PAZAAK.settingHandSizeHint",
    { range: { min: 1, max: 10, step: 1 } });

  r("maxHandPlays",          Number,  DEFAULTS.maxHandPlays,
    "PAZAAK.settingMaxHandPlays",     "PAZAAK.settingMaxHandPlaysHint",
    { range: { min: 1, max: 10, step: 1 } });

  r("handCardsLimitScope",   String,  DEFAULTS.handCardsLimitScope,
    "PAZAAK.settingHandLimitScope",   "PAZAAK.settingHandLimitScopeHint",
    { choices: { match: "PAZAAK.limitScopeMatch", round: "PAZAAK.limitScopeRound" } });

  r("redrawHandEachRound",   Boolean, DEFAULTS.redrawHandEachRound,
    "PAZAAK.settingRedrawHand",       "PAZAAK.settingRedrawHandHint");

  r("showDeckName",           Boolean, DEFAULTS.showDeckName,
    "PAZAAK.settingShowDeckName",     "PAZAAK.settingShowDeckNameHint");

  r("deckSizeLimit",          Number,  DEFAULTS.deckSizeLimit,
    "PAZAAK.settingDeckSizeLimit",    "PAZAAK.settingDeckSizeLimitHint",
    { range: { min: 4, max: 20, step: 1 } });

  r("target",                Number,  DEFAULTS.target,
    "PAZAAK.settingTarget",           "PAZAAK.settingTargetHint",
    { range: { min: 10, max: 30, step: 1 } });

  r("roundsToWin",           Number,  DEFAULTS.roundsToWin,
    "PAZAAK.settingRoundsToWin",      "PAZAAK.settingRoundsToWinHint",
    { range: { min: 1, max: 5, step: 1 } });

  // ── Wager currency ────────────────────────────────────────────────────────
  // Choices built dynamically after 'init' hook when game.system is available
  const currChoices = Object.fromEntries(
    getAvailableCurrencies().map(c => [c.key, c.label])
  );
  game.settings.register(MODULE_ID, "wagerCurrency", {
    name:    "PAZAAK.settingWagerCurrency",
    hint:    "PAZAAK.settingWagerCurrencyHint",
    scope:   "world",
    config:  true,
    type:    String,
    default: getAvailableCurrencies()[0]?.key ?? "gp",
    choices: currChoices,
  });

  // ── Game state (hidden setting storing current match state) ───────────────────
  game.settings.register(MODULE_ID, "pazaakState", {
    scope:   "world",
    config:  false,
    default: null,
    type:    Object,
    onChange: () => {
      // Re-render app on state change to sync UI across clients.
      const { PazaakApp } = globalThis._pazaakAppRef ?? {};
      PazaakApp?._instance?.render({ force: true });
    },
  });

  // ── "Reset to defaults" menu ──────────────────────────────────────
  game.settings.registerMenu(MODULE_ID, "resetDefaults", {
    name:  "PAZAAK.settingResetName",
    label: "PAZAAK.settingResetLabel",
    hint:  "PAZAAK.settingResetHint",
    icon:  "fas fa-undo",
    type:  class PazaakResetDefaults extends foundry.applications.api.ApplicationV2 {
      static DEFAULT_OPTIONS = { id: "pazaak-reset-defaults", window: { title: "" } };

      // Required abstract method override; never called as we intercept render()
      async _renderHTML() { return ""; }

      // Override render() to handle reset logic without opening a window
      render(options = {}) {
        (async () => {
          const SC = foundry.applications?.settings?.SettingsConfig ?? SettingsConfig;
          const title   = t("settingResetLabel");
          const content = `<p>${t("confirmResetDefaultsBody")}</p>`;
          const confirmed = (await foundry.applications.api.DialogV2.confirm({
            window: { title }, content, rejectClose: false,
          })) === true;
          if (!confirmed) return;

          const keys = [
            "language", "tableName", "handTablePrefix", "fallbackHandTableName",
            "handSize", "maxHandPlays", "handCardsLimitScope", "redrawHandEachRound",
            "target", "roundsToWin",
          ];
          for (const key of keys) {
            await game.settings.set(MODULE_ID, key, DEFAULTS[key]);
          }
          ui.notifications.info(t("notifResetDone"));

          // Close settings panel by finding SettingsConfig instance (safer than by ID)
          const settingsWin = [...(foundry.applications?.instances?.values() ?? [])]
            .find(a => a.constructor?.name === "SettingsConfig");
          settingsWin?.close();
        })();
        return this;
      }
    },
    restricted: true,
  });

}

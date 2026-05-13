// ============================================================
//  Pazaak — config.mjs
//  Stałe konfiguracyjne i rejestracja ustawień modułu
// ============================================================

export const MODULE_ID = "pazaak-fvtt";

// ── Bundled translations — niezależne od języka core Foundry ─────────────────

/** { pl: { "PAZAAK.x": "...", ... }, en: { ... } } */
const _tr = {};

/** Wywołuj z pazaak.mjs po pobraniu pliku językowego. */
export function setTranslations(lang, data) {
  _tr[lang] = data;
}

/**
 * Merguje tłumaczenia wybranego języka do game.i18n.translations,
 * dzięki czemu {{localize}} w HBS także działa poprawnie.
 */
export function applyModuleLang(lang) {
  const data = _tr[lang] ?? _tr["en"];
  if (!data) return;
  for (const [k, v] of Object.entries(data)) {
    game.i18n.translations[k] = v;
  }
}

/**
 * Skrót do tłumaczenia ze słownika modułu.
 * Język wybierany jest z ustawienia modułu (nie z game.i18n.lang).
 * Obsługuje proste podstawienia: t("key", { name: "X" })
 */
export function t(key, data = {}) {
  const lang = (() => { try { return game.settings.get(MODULE_ID, "language"); } catch { return DEFAULTS.language; } })();
  const map  = _tr[lang] ?? _tr["en"] ?? {};
  let str    = map[`PAZAAK.${key}`] ?? game.i18n.localize(`PAZAAK.${key}`);
  for (const [k, v] of Object.entries(data)) str = str.replace(`{${k}}`, v);
  return str;
}

/** Domyślne wartości (używane przed załadowaniem game.settings) */
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
 * Zwraca listę dostępnych walut na podstawie aktywnego systemu / modułów.
 * Format: [{ key, label, path }]
 */
export function getAvailableCurrencies() {
  const sys = (game.system?.id ?? "").toLowerCase();

  // SW5E jest modułem na bazie dnd5e — sprawdzamy aktywność modułu
  const isSW5E = game.modules?.get("sw5e-module")?.active === true;

  if (isSW5E) {
    // Sprawdź czy moduł sw-currency jest aktywny i udostępnia konfigurację
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
      } catch { /* brak ustawień modułu — ignoruj */ }
    }
    // Domyślne waluty SW5E
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

  // Generyczny fallback
  return [{ key: "gp", label: "Gold (gp)", path: "system.currency.gp" }];
}

/**
 * Zwraca aktywną walutę (obiekt { key, label, path }).
 * Jeśli ustawienie to "auto", wybiera pierwszą z listy.
 */
export function getActiveCurrency() {
  const list = getAvailableCurrencies();
  try {
    const saved = game.settings.get(MODULE_ID, "wagerCurrency");
    if (saved && saved !== "auto") {
      const found = list.find(c => c.key === saved);
      if (found) return found;
    }
  } catch { /* przed init */ }
  return list[0];
}

/**
 * Zwraca aktualną konfigurację (ustawienia modułu + stałe).
 * Bezpieczne do wywołania po fazie "init".
 */
export function getCfg() {
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

/** Rejestruje wszystkie ustawienia modułu (wywołać w hooku "init"). */
export function registerSettings() {
  const r = (key, type, def, name, hint, extra = {}) =>
    game.settings.register(MODULE_ID, key, {
      name, hint,
      scope: "world",
      config: true,
      type,
      default: def,
      ...extra,
    });

  // Język interfejsu — na górze listy
  r("language", String, DEFAULTS.language,
    "PAZAAK.settingLanguage", "PAZAAK.settingLanguageHint",
    {
      choices: { pl: "PAZAAK.langPl", en: "PAZAAK.langEn" },
      onChange: (value) => {
        applyModuleLang(value);
        // Odrysuj aplikację jeśli jest otwarta
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

  // ── Waluta zakładów ────────────────────────────────────────────────────────
  // Choices są budowane dynamicznie — wywołujemy po "init" gdy game.system jest dostępne
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

  // ── Stan gry (ukryty — przechowuje aktualny stan meczu) ───────────────────
  game.settings.register(MODULE_ID, "pazaakState", {
    scope:   "world",
    config:  false,
    default: null,
    type:    Object,
    onChange: () => {
      const { PazaakApp } = globalThis._pazaakAppRef ?? {};
      PazaakApp?._instance?.render({ force: true });
    },
  });

  // ── Przycisk "Resetuj do domyślnych" ──────────────────────────────────────
  game.settings.registerMenu(MODULE_ID, "resetDefaults", {
    name:  "PAZAAK.settingResetName",
    label: "PAZAAK.settingResetLabel",
    hint:  "PAZAAK.settingResetHint",
    icon:  "fas fa-undo",
    type:  class PazaakResetDefaults extends foundry.applications.api.ApplicationV2 {
      static DEFAULT_OPTIONS = { id: "pazaak-reset-defaults", window: { title: "" } };

      // Wymagana metoda abstrakcyjna — nigdy nie zostanie wywołana
      async _renderHTML() { return ""; }

      // Nadpisujemy render() — przechwytujemy PRZED super.render() który otworzyłby okno
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

          // Zamknij panel ustawień — szukamy po nazwie konstruktora, nie po id (bezpieczniej)
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

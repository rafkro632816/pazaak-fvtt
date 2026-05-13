// ============================================================
//  Pazaak — deck-builder.mjs
//  Generator Talii: tworzy nową RollTable na podstawie kart
//  ze standardowej talii
// ============================================================

import { MODULE_ID, getCfg, t } from "./config.mjs";
import { ensureGeneratedFolder, ALL_CARDS_TABLE_NAME } from "./setup.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class DeckBuilderApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id:      "pazaak-deck-builder",
    window:  { title: "PAZAAK.deckBuilderTitle", resizable: true, minimizable: true },
    classes: ["pazaak-app", "pazaak-deck-builder"],
    position: { width: 520, height: 640, top: 100, left: 200 },
    actions: {
      incrementCard: DeckBuilderApp._onIncrement,
      decrementCard: DeckBuilderApp._onDecrement,
      createDeck:    DeckBuilderApp._onCreate,
    },
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/deck-builder.hbs` },
  };

  /** @type {DeckBuilderApp|null} */
  static _instance = null;

  static openSingleton() {
    if (!DeckBuilderApp._instance) DeckBuilderApp._instance = new DeckBuilderApp();
    if (DeckBuilderApp._instance.rendered) {
      DeckBuilderApp._instance.bringToFront();
      return;
    }
    DeckBuilderApp._instance.render({ force: true });
  }

  // ── Stan wewnętrzny ──────────────────────────────────────────────────────

  /** Mapa: label → { weight, img, count } */
  _cards = new Map();

  /** Nazwa nowej talii */
  _deckName = "Pazzak - ";

  /** Czy talia ma być widoczna dla graczy (LIMITED); false = NONE */
  _playerVisible = true;

  /** Edytowana tabela (null = tryb tworzenia nowej) */
  _editingTable = null;

  /** Suffix wpisany przez użytkownika (bez prefiksu) */
  get _deckSuffix() { return this._deckName.startsWith("Pazzak - ") ? this._deckName.slice(9) : this._deckName; }

  constructor(options = {}) {
    super(options);
    this._loadCards();
  }

  _loadCards() {
    const source = game.tables.getName(ALL_CARDS_TABLE_NAME);
    if (!source) return;
    this._cards = new Map();
    for (const result of source.results.contents) {
      const label = result.text ?? result.name ?? String(result.range?.[0] ?? "?");
      if (!this._cards.has(label)) {
        this._cards.set(label, {
          weight: result.weight ?? 1,
          img:    result.img ?? null,
          count:  0,
        });
      }
    }
  }

  /** Wczytaj karty z istniejącej tabeli (tryb edycji). */
  _loadFromTable(table) {
    // Resetuj liczniki wszystkich znanych kart
    for (const entry of this._cards.values()) entry.count = 0;
    // Zlicz wystąpienia na podstawie wyników tabeli
    for (const result of table.results.contents) {
      const label = result.text ?? result.name ?? "";
      if (this._cards.has(label)) {
        this._cards.get(label).count++;
      } else {
        // Karta spoza All Cards (stara wersja) — dodaj dynamicznie
        this._cards.set(label, { weight: 1, img: result.img ?? null, count: 1 });
      }
    }
    this._deckName = table.name;
    this._playerVisible = (table.ownership?.default ?? 0) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED;
    this._editingTable = table;
  }

  /** Zwraca liste tabel które można edytować (Pazzak - *, poza wykluczonymi). */
  _getEditableTables() {
    const cfg = getCfg();
    const excluded = new Set([ALL_CARDS_TABLE_NAME, cfg.tableName]);
    return game.tables.contents
      .filter(t => t.name.startsWith("Pazzak") && !excluded.has(t.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ── Context ──────────────────────────────────────────────────────────────

  async _prepareContext(options) {
    const entries = [];
    for (const [label, data] of this._cards) {
      entries.push({ label, img: data.img, count: data.count, weight: data.weight });
    }
    // Posortuj: najpierw numeryczne (+/-), potem specjalne
    entries.sort((a, b) => {
      const numA = _cardSortKey(a.label);
      const numB = _cardSortKey(b.label);
      return numA - numB || a.label.localeCompare(b.label);
    });

    return {
      deckName:        this._deckName,
      deckNameSuffix:  this._deckSuffix,
      sourceName:      ALL_CARDS_TABLE_NAME,
      playerVisible:   this._playerVisible,
      cards:           entries,
      totalCards:      entries.reduce((s, c) => s + c.count, 0),
      deckRequired:    game.settings.get(MODULE_ID, "deckSizeLimit"),
      isEditing:       !!this._editingTable,
      editingTableName: this._editingTable?.name ?? null,
      editableTables:  this._getEditableTables().map(t => ({ name: t.name })),
    };
  }

  // ── Akcje ────────────────────────────────────────────────────────────────

  static _onIncrement(event, target) {
    const label = target.dataset.label;
    const entry = this._cards.get(label);
    if (entry) { entry.count++; this.render({ parts: ["main"] }); }
  }

  static _onDecrement(event, target) {
    const label = target.dataset.label;
    const entry = this._cards.get(label);
    if (entry && entry.count > 0) { entry.count--; this.render({ parts: ["main"] }); }
  }

  static async _onCreate(event, target) {
    // Odczytaj suffix z inputa i sklej z prefiksem
    const suffixInput = this.element?.querySelector("[name='deck-name-suffix']");
    const suffix = suffixInput?.value.trim() ?? "";
    this._deckName = "Pazzak - " + suffix;

    // Odczytaj czy talia ma być widoczna dla graczy
    const visibleCb = this.element?.querySelector("[name='deck-player-visible']");
    const playerVisible = visibleCb?.checked ?? true;

    if (!this._deckName) {
      ui.notifications.warn(t("deckBuilderNeedName"));
      return;
    }

    const results = [];
    let rangeStart = 1;
    for (const [label, data] of this._cards) {
      if (data.count <= 0) continue;
      // Każda kopia karty = osobny wynik (dzięki temu karta pojawia się wielokrotnie niezależnie)
      for (let i = 0; i < data.count; i++) {
        results.push({
          type:   foundry.CONST.TABLE_RESULT_TYPES.TEXT,
          text:   label,
          img:    data.img ?? null,
          weight: 1,
          range:  [rangeStart, rangeStart],
        });
        rangeStart++;
      }
    }

    if (results.length === 0) {
      ui.notifications.warn(t("deckBuilderNoCards"));
      return;
    }

    const deckRequired = game.settings.get(MODULE_ID, "deckSizeLimit");

    if (results.length !== deckRequired) {
      ui.notifications.warn(t("deckBuilderExactCards", { count: results.length, required: deckRequired }));
      return;
    }

    // Sprawdź czy tabela o tej nazwie już istnieje
    if (game.tables.getName(this._deckName)) {
      ui.notifications.warn(t("deckBuilderNameTaken", { name: this._deckName }));
      return;
    }

    const genFolder = await ensureGeneratedFolder();

    if (this._editingTable) {
      // ── TRYB EDYCJI: zaktualizuj istniejącą tabelę ─────────────────────────
      const conflict = game.tables.getName(this._deckName);
      if (conflict && conflict.id !== this._editingTable.id) {
        ui.notifications.warn(t("deckBuilderNameTaken", { name: this._deckName }));
        return;
      }
      // Usuń stare wyniki
      const oldIds = this._editingTable.results.map(r => r.id);
      if (oldIds.length) await this._editingTable.deleteEmbeddedDocuments("TableResult", oldIds);
      // Dodaj nowe
      await this._editingTable.createEmbeddedDocuments("TableResult", results);
      // Zaktualizuj nazwę, formułę i ownership
      await this._editingTable.update({
        name:      this._deckName,
        formula:   `1d${results.length}`,
        ownership: { default: playerVisible ? CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED : CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
      });
      ui.notifications.info(t("deckBuilderUpdated", { name: this._deckName }));
    } else {
      // ── TRYB TWORZENIA: stwórz nową tabelę ──────────────────────────────────
      await RollTable.create({
        name:        this._deckName,
        formula:     `1d${results.reduce((s, r) => s + r.weight, 0)}`,
        replacement: true,
        folder:      genFolder?.id ?? null,
        ownership:   { default: playerVisible ? CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED : CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
        results,
      });
      ui.notifications.info(t("deckBuilderCreated", { name: this._deckName }));
    }

    await this.close();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  _onRender(context, options) {
    super._onRender?.(context, options);
    // Synchronizuj pole suffixu z _deckName po renderze
    const suffixInput = this.element?.querySelector("[name='deck-name-suffix']");
    if (suffixInput) suffixInput.value = this._deckSuffix;

    // Zapisz suffix gdy użytkownik pisze
    suffixInput?.addEventListener("input", e => {
      this._deckName = "Pazzak - " + e.target.value;
    });

    // Synchronizuj _playerVisible z checkboxem
    const visibleCb = this.element?.querySelector("[name='deck-player-visible']");
    if (visibleCb) {
      visibleCb.checked = this._playerVisible;
      visibleCb.addEventListener("change", e => { this._playerVisible = e.target.checked; });
    }

    // Obsługa dropdown trybu (nowa / edytuj)
    const editSelect = this.element?.querySelector("[name='deck-edit-target']");
    editSelect?.addEventListener("change", e => {
      const val = e.target.value;
      if (val === "__new__") {
        // Reset do trybu tworzenia nowej
        for (const entry of this._cards.values()) entry.count = 0;
        this._deckName = "Pazzak - ";
        this._playerVisible = true;
        this._editingTable = null;
      } else {
        const tbl = game.tables.getName(val);
        if (tbl) this._loadFromTable(tbl);
      }
      this.render({ parts: ["main"] });
    });
  }

  close(options = {}) {
    DeckBuilderApp._instance = null;
    return super.close(options);
  }
}

// ── Pomocnik sortowania ───────────────────────────────────────────────────────

function _cardSortKey(label) {
  const s = String(label ?? "");
  // +/-N → 200 + N
  const pm = s.match(/^\+\/-?(\d+)$/);
  if (pm) return 200 + Number(pm[1]);
  // +N → 100 + N
  const pos = s.match(/^\+(\d+)$/);
  if (pos) return 100 + Number(pos[1]);
  // -N → 300 + N
  const neg = s.match(/^-(\d+)$/);
  if (neg) return 300 + Number(neg[1]);
  // Special → 500
  return 500;
}

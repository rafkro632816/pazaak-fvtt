// ============================================================
//  Pazaak — deck-builder.mjs
//  Deck Builder: Generates a new RollTable from selected cards
//  in the standard deck, supporting create/edit modes.
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

  /**
   * Opens a singleton instance of the deck builder app.
   * Ensures only one instance is active at a time to prevent UI conflicts.
   */
  static openSingleton() {
    if (!DeckBuilderApp._instance) DeckBuilderApp._instance = new DeckBuilderApp();
    if (DeckBuilderApp._instance.rendered) {
      DeckBuilderApp._instance.bringToFront();
      return;
    }
    DeckBuilderApp._instance.render({ force: true });
  }

  // ── Internal State ──────────────────────────────────────────────────────

  /** Map of card labels to their data: { weight, img, count } */
  _cards = new Map();

  /** Name of the new deck */
  _deckName = "Pazzak - ";

  /** Whether the deck should be visible to players (LIMITED); false = NONE */
  _playerVisible = true;

  /** Reference to the RollTable being edited; null indicates create mode for a new deck. */
  _editingTable = null;

  /** Extracts the user-entered suffix from _deckName, excluding the "Pazzak - " prefix. */
  get _deckSuffix() { return this._deckName.startsWith("Pazzak - ") ? this._deckName.slice(9) : this._deckName; }

  /**
   * Initializes the deck builder, loading cards from the standard deck table.
   */
  /**
   * Initializes the deck builder, loading cards from the standard deck table.
   */
  constructor(options = {}) {
    super(options);
    this._loadCards();
  }

  /**
   * Loads card data from the 'All Cards' RollTable into the internal _cards Map.
   * Initializes each card with weight, image, and count=0 for selection.
   * This ensures the builder starts with the full standard deck available.
   */
  /**
   * Loads card data from the 'All Cards' RollTable into the internal _cards Map.
   * Initializes each card with weight, image, and count=0 for selection.
   * This ensures the builder starts with the full standard deck available.
   */
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

  /**
   * Loads card selections from an existing RollTable for editing.
   * Resets counts, tallies occurrences from table results, and handles legacy cards.
   * Updates internal state to match the table's name, visibility, and reference.
   */
  /**
   * Loads card selections from an existing RollTable for editing.
   * Resets counts, tallies occurrences from table results, and handles legacy cards.
   * Updates internal state to match the table's name, visibility, and reference.
   */
  _loadFromTable(table) {
    // Reset counts for all known cards
    for (const entry of this._cards.values()) entry.count = 0;
    // Count occurrences based on table results
    for (const result of table.results.contents) {
      const label = result.text ?? result.name ?? "";
      if (this._cards.has(label)) {
        this._cards.get(label).count++;
      } else {
        // Card outside All Cards (old version) — add dynamically
        this._cards.set(label, { weight: 1, img: result.img ?? null, count: 1 });
      }
    }
    this._deckName = table.name;
    this._playerVisible = (table.ownership?.default ?? 0) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED;
    this._editingTable = table;
  }

  /**
   * Returns a list of editable RollTables (Pazzak-prefixed, excluding core tables).
   * Filters out 'All Cards' and the active game table to prevent conflicts.
   */
  _getEditableTables() {
    const cfg = getCfg();
    const excluded = new Set([ALL_CARDS_TABLE_NAME, cfg.tableName]);
    return game.tables.contents
      .filter(t => t.name.startsWith("Pazzak") && !excluded.has(t.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ── Context ──────────────────────────────────────────────────────────────

  /**
   * Prepares data context for the Handlebars template.
   * Includes card list sorted by type (numeric first, specials last), totals, and UI state.
   */
  async _prepareContext(options) {
    const entries = [];
    for (const [label, data] of this._cards) {
      entries.push({ label, img: data.img, count: data.count, weight: data.weight });
    }
    // Sort: numeric cards (+/-) first, then specials (ensures logical UI order)
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

  // ── Actions ────────────────────────────────────────────────────────────────

  /**
   * Increments the count of a card in the deck.
   */
  static _onIncrement(event, target) {
    const label = target.dataset.label;
    const entry = this._cards.get(label);
    if (entry) { entry.count++; this.render({ parts: ["main"] }); }
  }

  /**
   * Decrements the count of a card in the deck.
   */
  static _onDecrement(event, target) {
    const label = target.dataset.label;
    const entry = this._cards.get(label);
    if (entry && entry.count > 0) { entry.count--; this.render({ parts: ["main"] }); }
  }

  /**
   * Creates or updates the deck table based on current card selections.
   */
  static async _onCreate(event, target) {
    // Read suffix from input and combine with prefix
    const suffixInput = this.element?.querySelector("[name='deck-name-suffix']");
    const suffix = suffixInput?.value.trim() ?? "";
    this._deckName = "Pazzak - " + suffix;

    // Read whether the deck should be visible to players
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
      // Each card copy = separate result (ensures card appears multiple times independently)
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

    // Check if a table with this name already exists
    if (game.tables.getName(this._deckName)) {
      ui.notifications.warn(t("deckBuilderNameTaken", { name: this._deckName }));
      return;
    }

    const genFolder = await ensureGeneratedFolder();

    if (this._editingTable) {
      // ── EDIT MODE: update existing table ─────────────────────────
      const conflict = game.tables.getName(this._deckName);
      if (conflict && conflict.id !== this._editingTable.id) {
        ui.notifications.warn(t("deckBuilderNameTaken", { name: this._deckName }));
        return;
      }
      // Delete old results
      const oldIds = this._editingTable.results.map(r => r.id);
      if (oldIds.length) await this._editingTable.deleteEmbeddedDocuments("TableResult", oldIds);
      // Add new ones
      await this._editingTable.createEmbeddedDocuments("TableResult", results);
      // Update name, formula, and ownership
      await this._editingTable.update({
        name:      this._deckName,
        formula:   `1d${results.length}`,
        ownership: { default: playerVisible ? CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED : CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
      });
      ui.notifications.info(t("deckBuilderUpdated", { name: this._deckName }));
    } else {
      // ── CREATE MODE: create new table ──────────────────────────────────
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

  /**
   * Handles rendering and sets up event listeners for UI elements.
   */
  _onRender(context, options) {
    super._onRender?.(context, options);
    // Sync suffix field with _deckName after render
    const suffixInput = this.element?.querySelector("[name='deck-name-suffix']");
    if (suffixInput) suffixInput.value = this._deckSuffix;

    // Save suffix when user types
    suffixInput?.addEventListener("input", e => {
      this._deckName = "Pazzak - " + e.target.value;
    });

    // Sync _playerVisible with checkbox
    const visibleCb = this.element?.querySelector("[name='deck-player-visible']");
    if (visibleCb) {
      visibleCb.checked = this._playerVisible;
      visibleCb.addEventListener("change", e => { this._playerVisible = e.target.checked; });
    }

    // Handle mode dropdown (new / edit)
    const editSelect = this.element?.querySelector("[name='deck-edit-target']");
    editSelect?.addEventListener("change", e => {
      const val = e.target.value;
      if (val === "__new__") {
        // Reset to create new mode
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

  /**
   * Closes the app and clears the singleton instance.
   */
  close(options = {}) {
    DeckBuilderApp._instance = null;
    return super.close(options);
  }
}

// ── Sorting Helper ───────────────────────────────────────────────────────

/**
 * Generates a sort key for card labels to order them: numeric (+/-) first, then specials.
 * @param {string} label - The card label to sort.
 * @returns {number} Sort key value.
 */
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

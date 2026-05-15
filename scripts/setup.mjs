// ============================================================
//  Pazaak — setup.mjs
//  One-time world bootstrap: create RollTables and persistent state folder
//  GM-only entrypoint: game.pazaak.setup()
// ============================================================

import { MODULE_ID, getCfg, t } from "./config.mjs";
import { ensureGamesJournal } from "./journal.mjs";

// ─── Base deck constants ───────────────────────────────────────────────────
// Main deck card definitions used to build the RollTable results.
const MAZZO_BASE = Array.from({ length: 10 }, (_, i) => ({
  val: i + 1,
  img: `modules/${MODULE_ID}/assets/Standard/${i + 1}.png`,
}));

/**
 * Resolve the image path for a hand card value during world setup.
 * Special card names map to unique assets; numeric labels map to +/- icons.
 */
function _handImg(label) {
  const s = String(label ?? "");
  if (s.startsWith("+/-")) return `modules/${MODULE_ID}/assets/+-/+-${s.replace("+/-", "")}.png`;
  const pos = s.match(/^\+(\d+)$/);
  if (pos) return `modules/${MODULE_ID}/assets/+/+${pos[1]}.png`;
  const neg = s.match(/^-(\d+)$/);
  if (neg) return `modules/${MODULE_ID}/assets/-/-${neg[1]}.png`;
  const specials = ["Double", "Flip 1&2", "Flip 3&4", "Flip 5&6", "Tie Breaker"];
  if (specials.includes(s)) return `modules/${MODULE_ID}/assets/Special/${s}.png`;
  return "icons/svg/d20-grey.svg";
}

// ─── Standard hand card definitions ────────────────────────────────────────
// Basic special cards available in the standard hand deck.
const STANDARD_HAND = [
  "+1", "+2", "+3", "+4", "+5", "+6",
  "-1", "-2", "-3", "-4", "-5", "-6",
  "Double", "Tie Breaker",
];

// Complete special hand card set used by the deck generator
const ALL_CARDS_HAND = [
  "+1", "+2", "+3", "+4", "+5", "+6",
  "-1", "-2", "-3", "-4", "-5", "-6",
  "+/-1", "+/-2", "+/-3", "+/-4", "+/-5", "+/-6",
  "Double", "Tie Breaker",
  "Flip 1&2", "Flip 3&4", "Flip 5&6",
];

export const ALL_CARDS_TABLE_NAME = "Pazaak - All Cards";

// ─── Public setup API ───────────────────────────────────────────────────────

/**
 * Bootstrap required Pazaak world assets in the campaign.
 * Creates folders, RollTables, and the history journal for GM clients.
 */
export async function setupPazaakWorld() {
  if (!game.user.isGM) {
    ui.notifications.warn(t("notifSetupGMOnly"));
    return;
  }

  ui.notifications.info(t("notifSetupStart"));

  // Ensure the module folder hierarchy exists
  const rootFolder    = await _ensureFolder("Pazaak",    null);
  const baseFolder    = await _ensureFolder("Base",      rootFolder.id);
  const premadeFolder = await _ensureFolder("PreMade",   rootFolder.id);
  await _ensureFolder("Generated", rootFolder.id); // create if missing

  await _ensureMainTable(baseFolder.id);
  await _ensureHandTable("Pazaak - Standard",  STANDARD_HAND,  premadeFolder.id);
  await _ensureHandTable(ALL_CARDS_TABLE_NAME, ALL_CARDS_HAND, premadeFolder.id);
  await ensureGamesJournal();

  ui.notifications.info(t("notifSetupDone"));
}

/**
 * Return or create the Pazaak/Generated folder.
 * Exported for DeckBuilderApp usage.
 */
export async function ensureGeneratedFolder() {
  const root = await _ensureFolder("Pazaak",    null);
  return         _ensureFolder("Generated", root.id);
}

// Exported helper for DeckBuilderApp to ensure the generated cards folder exists.
// ─── Internal helpers ─────────────────────────────────────────────────────────────

/**
 * Return an existing folder or create a new one.
 * @param {string}      name     Folder name
 * @param {string|null} parentId Parent folder ID (null = root)
 */
async function _ensureFolder(name, parentId) {
  const existing = game.folders.find(f =>
    f.type === "RollTable" &&
    f.name === name &&
    (f.folder?.id ?? null) === parentId
  );
  if (existing) return existing;
  return Folder.create({ name, type: "RollTable", folder: parentId });
}

async function _ensureMainTable(folderId) {
  // Ensure the main Pazaak deck table exists, and move it if it is in the wrong folder.
  const name = getCfg().tableName;
  const existing = game.tables.getName(name);
  if (existing) {
    if (folderId && (existing.folder?.id ?? null) !== folderId)
      await existing.update({ folder: folderId });
    console.log(`Pazaak | Tabela "${name}" już istnieje — pomijam.`);
    return;
  }

  // Build a full base deck: 4 copies of each numeric card value
  const results = [];
  for (const { val, img } of MAZZO_BASE) {
    for (let copy = 0; copy < 4; copy++) {
      results.push({
        type:        "text",
        description: String(val),
        text:        String(val),   // alias for legacy table formats
        weight:      1,
        range:       [results.length + 1, results.length + 1],
        img,
        drawn:       false,
      });
    }
  }

  await RollTable.create({
    name,
    description:  "Główna talia Pazaak: karty 1–10, po 4 kopie. Kładź obrazki w modules/pazaak/assets/cards/.",
    formula:      `1d${results.length}`,
    replacement:  true,
    displayRoll:  false,
    ownership:    { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED },
    folder:       folderId ?? null,
    results,
  });
  console.log(`Pazaak | Stworzono tabelę "${name}" (${results.length} wyników).`);
}

async function _ensureHandTable(name, cards, folderId) {
  // Ensure a hand card RollTable exists for the given special card set.
  const existing = game.tables.getName(name);
  if (existing) {
    if (folderId && (existing.folder?.id ?? null) !== folderId)
      await existing.update({ folder: folderId });
    console.log(`Pazaak | Tabela "${name}" już istnieje — pomijam.`);
    return;
  }

  const results = cards.map((val, i) => ({
    type:        "text",
    description: val,
    text:        val,
    weight:      1,
    range:       [i + 1, i + 1],
    img:         _handImg(val),
    drawn:       false,
  }));

  await RollTable.create({
    name,
    description: `Karty specjalne do ręki: ${name}`,
    formula:     `1d${results.length}`,
    replacement: true,
    displayRoll: false,
    ownership:   { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED },
    folder:      folderId ?? null,
    results,
  });
  console.log(`Pazaak | Stworzono tabelę "${name}" (${results.length} kart).`);
}

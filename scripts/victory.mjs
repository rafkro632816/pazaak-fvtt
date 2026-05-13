// ============================================================
//  Pazaak — victory.mjs
//  Ekran zwycięzcy meczu (ApplicationV2)
// ============================================================

import { MODULE_ID, t } from "./config.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class PazaakVictoryApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "pazaak-victory",
    window: {
      title:       "Pazaak",
      resizable:   false,
      minimizable: false,
    },
    classes:  ["pazaak-victory"],
    position: { width: 380, height: 520, top: 120 },
    actions: {
      close: PazaakVictoryApp._onClose,
    },
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/victory.hbs` },
  };

  /** @param {{ name:string, actorId:string, pot:number, currency:string }} data */
  constructor(data) {
    super();
    this._data = data;
  }

  async _prepareContext(_options) {
    const { name, actorId, pot, currency } = this._data;

    // Spróbuj pobrać portret tokena ze sceny (priorytet), potem z aktora
    let portrait = "icons/svg/mystery-man.svg";
    const actor = game.actors?.get(actorId);
    if (actor?.img) portrait = actor.img;

    // Token na aktywnej scenie
    const token = canvas?.tokens?.placeables?.find(t => t.actor?.id === actorId);
    if (token?.document?.texture?.src) portrait = token.document.texture.src;

    return { name, portrait, pot: pot > 0 ? pot : 0, currency };
  }

  static _onClose() {
    if (globalThis._pazaakAppRef?.PazaakApp) {
      globalThis._pazaakAppRef.PazaakApp._victoryOpen = false;
      globalThis._pazaakAppRef.PazaakApp._instance?.render({ force: true });
    }
    this.close();
  }
}

/**
 * Otwiera ekran zwycięzcy. Jeśli już jest otwarty, najpierw go zamknij.
 * @param {{ name:string, actorId:string, pot:number, currency:string }} data
 */
export function showVictoryScreen(data) {
  // Zamknij poprzedni jeśli istnieje (instances to Map w v13)
  try {
    const instances = foundry.applications?.instances;
    if (instances instanceof Map) {
      instances.forEach(a => { if (a instanceof PazaakVictoryApp) a.close({ animate: false }); });
    } else if (instances) {
      Object.values(instances).forEach(a => { if (a instanceof PazaakVictoryApp) a.close({ animate: false }); });
    }
  } catch (_) { /* ignoruj */ }

  const app = new PazaakVictoryApp(data);
  app.render({ force: true });
}

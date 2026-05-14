// ============================================================
//  Pazaak — victory.mjs
//  Victory screen dialog using Foundry's ApplicationV2 framework
// ============================================================

import { MODULE_ID, t } from "./config.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Modal dialog for displaying match victory information.
 * Extends Foundry's ApplicationV2 with Handlebars templating.
 */
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

  /**
   * Store victory data for rendering.
   * @param {{ name:string, actorId:string, pot:number, currency:string }} data
   */
  constructor(data) {
    super();
    this._data = data;
  }

  /**
   * Prepare context data for the Handlebars template.
   * Resolves actor portrait with fallback to token on scene, then actor image.
   */
  async _prepareContext(_options) {
    const { name, actorId, pot, currency } = this._data;

    // Fallback portrait resolution: scene token > actor image > default
    let portrait = "icons/svg/mystery-man.svg";
    const actor = game.actors?.get(actorId);
    if (actor?.img) portrait = actor.img;

    // Prefer token portrait from active scene for visual consistency
    const token = canvas?.tokens?.placeables?.find(t => t.actor?.id === actorId);
    if (token?.document?.texture?.src) portrait = token.document.texture.src;

    return { name, portrait, pot: pot > 0 ? pot : 0, currency };
  }

  /**
   * Handle dialog close: reset global victory state in the main app.
   */
  static _onClose() {
    if (globalThis._pazaakAppRef?.PazaakApp) {
      globalThis._pazaakAppRef.PazaakApp._victoryOpen = false;
      globalThis._pazaakAppRef.PazaakApp._instance?.render({ force: true });
    }
    this.close();
  }
}

/**
 * Display the victory screen modal for a match winner.
 * Ensures only one instance is open by closing any existing dialogs.
 * @param {{ name:string, actorId:string, pot:number, currency:string }} data
 */
export function showVictoryScreen(data) {
  // Handle Foundry version differences in application instances (Map in v13+)
  try {
    const instances = foundry.applications?.instances;
    if (instances instanceof Map) {
      instances.forEach(a => { if (a instanceof PazaakVictoryApp) a.close({ animate: false }); });
    } else if (instances) {
      Object.values(instances).forEach(a => { if (a instanceof PazaakVictoryApp) a.close({ animate: false }); });
    }
  } catch (_) { /* ignore version compatibility issues */ }

  const app = new PazaakVictoryApp(data);
  app.render({ force: true });
}

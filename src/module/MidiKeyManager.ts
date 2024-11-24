import { config } from "simple-peer";
import { debugEnabled, i18n } from "../midi-qol.js";
import { Options } from "./patching.js";
import { autoFastForwardAbilityRolls, configSettings } from "./settings.js";
import { setupSheetQol } from "./sheetQOL";
import { isAutoFastAttack, isAutoFastDamage } from "./utils.js";

export class MidiKeyManager {
  _adv = false;
  _dis = false;
  _vers = false;
  _rollToggle = false;
  _other = false;
  _fastForward = false;
  _fastForwardSet = false;
  _critical = false;
  _noop = false;
  _lastReturned: Options = {
    advantage: undefined,
    disadvantage: undefined,
    versatile: undefined,
    other: undefined,
    rollToggle: undefined,
    fastForward: undefined,
    fastForwardSet: undefined,
    parts: undefined,
    chatMessage: undefined,
    isCritical: undefined,
    fastForwardAbility: undefined,
    fastForwardDamage: undefined,
    fastForwardAttack: undefined,
    autoRollAttack: undefined,
    autoRollDamage: undefined
  };


  constructor() {
  }
  

  track(status: string) {
    //@ts-ignore
    if (CONFIG.debug.keybindings) {
      console.log("midi-qol | key pressed ", status);
    }
  }
  initKeyMappings() {
    const worldSettings = false; // configSettings.worldKeyMappings ?? false;
    //@ts-ignore
    const keybindings = game.keybindings;
    //@ts-ignore
    const normalPrecedence = CONST.KEYBINDING_PRECEDENCE.NORMAL;

    keybindings.register("midi-qol", "NoOptionalRules", {
      name: "midi-qol.NoOptionalRules.Name",
      hint: "midi-qol.NoOptionalRules.Hint",
      editable: [
      ],
      onDown: () => { configSettings.toggleOptionalRules = true; this.track("no opt rules down"); return false; },
      onUp: () => { configSettings.toggleOptionalRules = false; this.track("no opt rules up"); return false; },
      restricted: true,                         // Restrict this Keybinding to gamemaster only?
      precedence: normalPrecedence
    });
    keybindings.register("midi-qol", "Versatile", {
      name: i18n("DND5E.Versatile"),
      hint: "midi-qol.KeysVersatile.Hint",
      editable: [
        { key: "KeyV" },
        { key: "ShiftLeft" },
        { key: "ShiftRight" }
      ],
      onDown: () => { this._vers = true; this.track("versatile down"); return false; },
      onUp: () => { this._vers = false; this.track("versatile up"); return false; },
      restricted: worldSettings,                         // Restrict this Keybinding to gamemaster only?
      precedence: normalPrecedence
    });

    keybindings.register("midi-qol", "RollToggle", {
      name: i18n("midi-qol.RollToggle.Name"),
      hint: i18n("midi-qol.RollToggle.Hint"),
      editable: [
        { key: "KeyT" }
      ],
      onDown: () => { this._rollToggle = true; this.track("roll toggle down"); return false; },
      onUp: () => { this._rollToggle = false; this.track("roll toggle up"); return false; },
      restricted: worldSettings,                         // Restrict this Keybinding to gamemaster only?
      precedence: normalPrecedence
    });

    Hooks.on('renderDialog', (dialog, html, data) => {
      //@ts-expect-error
      if (CONFIG.debug.keybindings) console.log("midi-qol | dialog rendered - releasing keys");
      //@ ts-expect-error
      // game.keyboard?.releaseKeys({ force: true });
    });
    Hooks.on('renderDialogV2', (dialog, html, data) => {
      //@ts-expect-error
      if (CONFIG.debug.keybindings) console.log("midi-qol | dialog v2 rendered - releasing keys");
      //@ ts-expect-error
      // game.keyboard?.releaseKeys({ force: true });
    })
  }
}



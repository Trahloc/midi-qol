import { i18n } from "../midi-qol.js";

export class MidiKeyManager {
  constructor() {
  }
  
  initKeyMappings() {
    //@ts-ignore
    const keybindings = game.keybindings;
    //@ts-ignore
    const normalPrecedence = CONST.KEYBINDING_PRECEDENCE.NORMAL;

    keybindings.register("midi-qol", "NoOptionalRules", {
      name: "midi-qol.NoOptionalRules.Name",
      hint: "midi-qol.NoOptionalRules.Hint",
      editable: [
      ],
      restricted: true,                         // Restrict this Keybinding to gamemaster only?
      precedence: normalPrecedence
    });
    keybindings.register("midi-qol", "Versatile", {
      name: i18n("DND5E.Versatile"),
      hint: "midi-qol.KeysVersatile.Hint",
      editable: [
        { key: "KeyV" },
      ],
      restricted: false,                         // Restrict this Keybinding to gamemaster only?
      precedence: normalPrecedence
    });

    keybindings.register("midi-qol", "RollToggle", {
      name: i18n("midi-qol.RollToggle.Name"),
      hint: i18n("midi-qol.RollToggle.Hint"),
      editable: [
        { key: "KeyF" }
      ],
      restricted: false,                         // Restrict this Keybinding to gamemaster only?
      precedence: normalPrecedence
    });
  }
}



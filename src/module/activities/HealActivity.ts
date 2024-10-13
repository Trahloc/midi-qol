import { debugEnabled, i18n, warn } from "../../midi-qol.js";
import { mapSpeedKeys } from "../MidiKeyManager.js";
import { Workflow } from "../Workflow.js";
import { configSettings } from "../settings.js";
import { asyncHooksCall } from "../utils.js";
import { MidiActivityMixin } from "./MidiActivityMixin.js";

export var MidiHealActivity;
export var MidiHealSheet;

export function setupHealActivity() {
  if (debugEnabled > 0) warn("MidiQOL | HealActivity | setupHealActivity | Called");
  //@ts-expect-error
  const GameSystemConfig = game.system.config;
  //@ts-expect-error
  MidiHealSheet = defineMidiHealSheetClass(game.system.applications.activity.HealSheet);
  MidiHealActivity = defineMidiHealActivityClass(GameSystemConfig.activityTypes.heal.documentClass);
  if (configSettings.replaceDefaultActivities) {
    GameSystemConfig.activityTypes["dnd5eHeal"] = GameSystemConfig.activityTypes.heal;
    GameSystemConfig.activityTypes.heal = { documentClass: MidiHealActivity };
  } else {
    GameSystemConfig.activityTypes["midiHeal"] = { documentClass: MidiHealActivity };
  }
}

let defineMidiHealActivityClass = (ActivityClass: any) => {
  return class MidiHealActivity extends MidiActivityMixin(ActivityClass) {
    static LOCALIZATION_PREFIXES = [...super.LOCALIZATION_PREFIXES, "midi-qol.HEAL"];
    static metadata =
      foundry.utils.mergeObject(
        foundry.utils.mergeObject({}, super.metadata), {
        title: "midi-qol.HEAL.Title.one",
        sheetClass: MidiHealSheet,
        usage: {
          chatCard: "modules/midi-qol/templates/activity-card.hbs",
        },
      }, { overwrite: true })

    get isOtherActivityCompatible() { return true }

    async rollHeal(config, dialog, message) {
      config.midiOptions ??= {};
      config.midiOptions.fastForwardHeal = game.user?.isGM ? configSettings.gmAutoFastForwardDamage : ["all", "damage"].includes(configSettings.autoFastForward);
      return super.rollHeal(config, dialog, message);
    }
  }
}

export function defineMidiHealSheetClass(baseClass: any) {
  return class MidiHealSheet extends baseClass {
    static PARTS = {
      ...super.PARTS,
      effect: {
        template: "modules/midi-qol/templates/activity/heal-effect.hbs",
        templates: [
          ...super.PARTS.effect.templates,
          "modules/midi-qol/templates/activity/parts/use-condition.hbs",
        ]
      }
    };
  }
}
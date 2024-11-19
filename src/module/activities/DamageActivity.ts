import { debugEnabled, i18n, warn } from "../../midi-qol.js";
import { mapSpeedKeys } from "../MidiKeyManager.js";
import { Workflow } from "../Workflow.js";
import { ReplaceDefaultActivities, configSettings } from "../settings.js";
import { asyncHooksCall } from "../utils.js";
import { MidiActivityMixin } from "./MidiActivityMixin.js";

export var MidiDamageActivity;
export var MidiDamageSheet;

export function setupDamageActivity() {
  if (debugEnabled > 0) warn("MidiQOL | DamageActivity | setupDamageActivity | Called");
  //@ts-expect-error
  const GameSystemConfig = game.system.config;
  //@ts-expect-error
  MidiDamageSheet = defineMidiDamageSheetClass(game.system.applications.activity.DamageSheet);
  MidiDamageActivity = defineMidiDamageActivityClass(GameSystemConfig.activityTypes.damage.documentClass);
  if (ReplaceDefaultActivities) {
    GameSystemConfig.activityTypes["dnd5eDamage"] = GameSystemConfig.activityTypes.damage;
    GameSystemConfig.activityTypes.damage = { documentClass: MidiDamageActivity };
  } else {
    GameSystemConfig.activityTypes["midiDamage"] = { documentClass: MidiDamageActivity };
  }
}

let defineMidiDamageActivityClass = (ActivityClass: any) => {
  return class MidiDamageActivity extends MidiActivityMixin(ActivityClass) {
    static LOCALIZATION_PREFIXES = [...super.LOCALIZATION_PREFIXES, "midi-qol.DAMAGE"];
    static metadata =
      foundry.utils.mergeObject(
        foundry.utils.mergeObject({}, super.metadata), {
        title: "midi-qol.DAMAGE.Title.one",
        sheetClass: MidiDamageSheet,
        usage: {
          chatCard: "modules/midi-qol/templates/activity-card.hbs",
        },
      }, { overwrite: true })

    get isOtherActivityCompatible() { return true }

    async rollDamage(config, dialog, message) {
      config.midiOptions ??= {};
      config.midiOptions.fastForwardDamage = game.user?.isGM ? configSettings.gmAutoFastForwardDamage : ["all", "damage"].includes(configSettings.autoFastForward);
      return super.rollDamage(config, dialog, message);
    }

    async _triggerSubsequentActions(config, results) {
    }
  }
}

export function defineMidiDamageSheetClass(baseClass: any) {
  return class MidiDamageSheet extends baseClass {
    static PARTS = {
      ...super.PARTS,
      effect: {
        template: "modules/midi-qol/templates/activity/damage-effect.hbs",
        templates: [
          ...super.PARTS.effect.templates,
          "modules/midi-qol/templates/activity/parts/use-condition.hbs",
        ]
      }
    };
  }
}
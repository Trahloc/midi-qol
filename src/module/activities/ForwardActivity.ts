import { debugEnabled, i18n, warn } from "../../midi-qol.js";
import { Workflow } from "../Workflow.js";
import { ReplaceDefaultActivities, configSettings } from "../settings.js";
import { asyncHooksCall } from "../utils.js";
import { MidiActivityMixin, MidiActivityMixinSheet } from "./MidiActivityMixin.js";

export var MidiForwardActivity;
export var MidiForwardSheet;

export function setupForwardActivity() {
  if (debugEnabled > 0) warn("MidiQOL | ForwardActivity | setupForwardActivity | Called");
  //@ts-expect-error
  const GameSystemConfig = game.system.config;
  //@ts-expect-error
  MidiForwardSheet = defineMidiForwardSheetClass(game.system.applications.activity.ForwardSheet);
  MidiForwardActivity = defineMidiForwardActivityClass(GameSystemConfig.activityTypes.forward.documentClass);
  if (ReplaceDefaultActivities) {
    // GameSystemConfig.activityTypes["dnd5eForward"] = GameSystemConfig.activityTypes.forward;
    GameSystemConfig.activityTypes.forward = { documentClass: MidiForwardActivity };
  } else {
    GameSystemConfig.activityTypes["midiForward"] = { documentClass: MidiForwardActivity };
  }
}
let defineMidiForwardSheetClass = (baseClass: any) => {
  return class MidiForwardSheet extends MidiActivityMixinSheet(baseClass) {
  }
}

let defineMidiForwardActivityClass = (ActivityClass: any) => {
  return class MidiForwardActivity extends MidiActivityMixin(ActivityClass) {
    static LOCALIZATION_PREFIXES = [...super.LOCALIZATION_PREFIXES, "midi-qol.FORWARD"];
    static metadata =
      foundry.utils.mergeObject(
        super.metadata, {
        title: configSettings.activityNamePrefix ? "midi-qol.FORWARD.Title.one": ActivityClass.metadata.title,
        dnd5eTitle: ActivityClass.metadata.title,
        sheetClass: MidiForwardSheet,
        usage: {
          chatCard: "modules/midi-qol/templates/activity-card.hbs",
        },
      }, {inplace: false, insertKeys: true, insertValues: true});
    get isOtherActivityCompatible() {
      return false;
    }
  }

}

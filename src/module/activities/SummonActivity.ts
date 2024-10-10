import { debugEnabled, i18n, warn } from "../../midi-qol.js";
import { Workflow } from "../Workflow.js";
import { configSettings } from "../settings.js";
import { asyncHooksCall } from "../utils.js";
import { MidiActivityMixin } from "./MidiActivityMixin.js";

export var MidiSummonActivity;

export function setupSummonActivity() {
  if (debugEnabled > 0) warn("MidiQOL | SummonActivity | setupSummonActivity | Called");
  //@ts-expect-error
  const GameSystemConfig = game.system.config;
  MidiSummonActivity = defineMidiSummonActivityClass(GameSystemConfig.activityTypes.summon.documentClass);
  if (configSettings.replaceDefaultActivities) {
    GameSystemConfig.activityTypes["dnd5eSummon"] = GameSystemConfig.activityTypes.summon;
    GameSystemConfig.activityTypes.summon = { documentClass: MidiSummonActivity };
  } else {
    GameSystemConfig.activityTypes["midiSummon"] = { documentClass: MidiSummonActivity };
  }
}

let defineMidiSummonActivityClass =(ActivityClass: any) => {
  return class MidiSummonActivity extends MidiActivityMixin(ActivityClass) {
    static LOCALIZATION_PREFIXES = [...super.LOCALIZATION_PREFIXES, "midi-qol.SUMMON"];
    static metadata =
      foundry.utils.mergeObject(
        foundry.utils.mergeObject({}, super.metadata), {
        title: "midi-qol.SUMMON.Title.one",
        usage: {
          chatCard: "modules/midi-qol/templates/activity-card.hbs",
        },
      }, {})
  }
}
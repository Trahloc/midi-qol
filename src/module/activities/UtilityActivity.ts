import { debugEnabled, i18n, warn } from "../../midi-qol.js";
import { ReplaceDefaultActivities } from "../settings.js";
import { asyncHooksCall } from "../utils.js";
import { MidiActivityMixin } from "./MidiActivityMixin.js";

export var MidiUtilityActivity;
export var MidiUtilitySheet;

export function setupUtilityActivity() {
  if (debugEnabled > 0) warn("MidiQOL | UtilityActivity | setupUtilityActivity | Called");
  //@ts-expect-error
  const GameSystemConfig = game.system.config;
  //@ts-expect-error
  MidiUtilitySheet = defineMidiUtilitySheetClass(game.system.applications.activity.UtilitySheet);

  MidiUtilityActivity = defineMidiUtilityActivityClass(GameSystemConfig.activityTypes.utility.documentClass);
  if (ReplaceDefaultActivities) {
    GameSystemConfig.activityTypes["dnd5eUtility"] = GameSystemConfig.activityTypes.utility;
    GameSystemConfig.activityTypes.utility = { documentClass: MidiUtilityActivity };
  } else {
    GameSystemConfig.activityTypes["midiUtility"] = { documentClass: MidiUtilityActivity };
  }
}

let defineMidiUtilityActivityClass = (ActvityClass: any) => {
  return class MidiUtilityActivity extends MidiActivityMixin(ActvityClass) {
    static metadata =
      foundry.utils.mergeObject(
        foundry.utils.mergeObject({}, super.metadata), {
        title: "midi-qol.UTILITY.Title.one",
        sheetClass: MidiUtilitySheet,
        usage: {
          chatCard: "modules/midi-qol/templates/activity-card.hbs",
        },
      }, { overwrite: true })

    get isOtherActivityCompatible() { return true }

    async rollFormula(config, dialog, message: any = {}) {
      if (debugEnabled > 0)
        warn("UtilityActivity | rollFormula | Called", config, dialog, message);
      config ??= {};
      dialog ??= {};
      message ??= {}
      config.midiOptions ??= {};
      if (debugEnabled > 0) {
        warn("MidiUtilityActivity | rollFormula | Called", config, dialog, message);
      }
      if (await asyncHooksCall("midi-qol.preFormulaRoll", this.workflow) === false
        || await asyncHooksCall(`midi-qol.preFormulaRoll.${this.item.uuid}`, this.workflow) === false
        || await asyncHooksCall(`midi-qol.preFormulaRoll.${this.uuid}`, this.workflow) === false) {
        console.warn("midi-qol | UtiliatyActivity | Formula roll blocked via pre-hook");
        return;
      }
      if (config.midiOptions.fastForward !== undefined)
        dialog.configure = !config.midiOptions.fastForwardDamage;
      //@ts-expect-error
      const areKeysPressed = game.system.utils.areKeysPressed;
      const keys = {
        normal: areKeysPressed(config.event, "skipDialogNormal"),
        advantage: areKeysPressed(config.event, "skipDialogAdvantage"),
        disadvantage: areKeysPressed(config.event, "skipDialogDisadvantage")
      };
      if (Object.values(keys).some(k => k)) dialog.configure = this.forceDialog;
      else dialog.configure ??= !config.midiOptions.fastForwardDamage || this.forceDialog;

      /*
      else
        dialog.configure = true;
      */
      if (this.workflow?.rollOptions?.rollToggle) dialog.configure = !!!dialog.configure;

      Hooks.once("dnd5e.preRollFormulaV2", (rollConfig, dialogConfig, messageConfig) => {
        return true;
      })

      message.create = true;
      let result = await super.rollFormula(config, dialog, message);
      // result = await postProcessUtilityRoll(this, config, result);
      if (config.midiOptions.updateWorkflow !== false && this.workflow) {
        this.workflow.utilityRolls = result;
        if (this.workflow.suspended)
          this.workflow.unSuspend.bind(this.workflow)({ utilityRoll: result });
      }
      return result;
    }
    async _usageChatContext(message) {
      const context = await super._usageChatContext(message);
      context.hasRollFormula = true; // TODO fix this when able to do a proper card !!this.roll?.formula;
      return context;
    }
  }
}

export function defineMidiUtilitySheetClass(baseClass: any) {
  return class MidiUtilitySheet extends baseClass {
    static PARTS = {
      ...super.PARTS,
      effect: {
        template: "modules/midi-qol/templates/activity/utility-effect.hbs",
        templates: [
          ...super.PARTS.effect.templates,
          "modules/midi-qol/templates/activity/parts/use-condition.hbs",
        ]
      }
    };
  }
}
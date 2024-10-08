import { debugEnabled, i18n, warn } from "../../midi-qol.js";
import { MidiKeyManager, mapSpeedKeys } from "../MidiKeyManager.js";
import { Workflow } from "../Workflow.js";
import { configSettings } from "../settings.js";
import { asyncHooksCall } from "../utils.js";
import { configureDamageRoll, confirmCanProceed, confirmTargets, confirmWorkflow, midiUsageChatContext, postProcessDamageRoll, setupTargets } from "./activityHelpers.js";

export var MidiSaveActivity;
export var MidiSaveSheet;

export function setupSaveActivity() {
  if (debugEnabled > 0) warn("MidiQOL | SaveActivity | setupSaveActivity | Called");
  //@ts-expect-error
  const GameSystemConfig = game.system.config;
  //@ts-expect-error
  MidiSaveSheet = defineMidiSaveSheetClass(game.system.applications.activity.SaveSheet);
  MidiSaveActivity = defineMidiSaveActivityClass(GameSystemConfig.activityTypes.save.documentClass);
  if (configSettings.replaceDefaultActivities) {
    GameSystemConfig.activityTypes["dnd5eSave"] = GameSystemConfig.activityTypes.save;
    GameSystemConfig.activityTypes.save = { documentClass: MidiSaveActivity };
  } else {
    GameSystemConfig.activityTypes["midiSave"] = { documentClass: MidiSaveActivity };
  }
}

export function defineMidiSaveActivityClass(baseClass: any) {
  return class MidiSaveActivity extends baseClass {
    targetsToUse: Set<Token>;
    _workflow: Workflow | undefined;
    get workflow() { return this._workflow; }
    set workflow(value) { this._workflow = value; }
    static metadata =
      foundry.utils.mergeObject(
        foundry.utils.mergeObject({}, super.metadata), {
        title: "midi-qol.SAVE.Title.one",
        sheetClass: MidiSaveSheet,
        usage: {
          chatCard: "modules/midi-qol/templates/activity-card.hbs",
        },
      }, { overwrite: true })


    static defineSchema() {
      //@ts-expect-error
      const { StringField } = foundry.data.fields;

      const schema = {
        ...super.defineSchema(),
        //@ ts-expect-error
        // flags: new foundry.data.fields.ObjectField(),
        useConditionText: new StringField({ name: "useCondition", label: "Use Condition", initial: "" }),
        effectConditionText: new StringField({ name: "effectCondition", label: "Effect Condition", initial: "" }),
      };
      return schema;
    }

    async use(config, dialog, message) {
      if (!this.item.isEmbedded) return;
      if (!this.item.isOwner) {
        ui.notifications?.error("DND5E.DocumentUseWarn", { localize: true });
      }
      if (debugEnabled > 0) warn("MidiQOL | SaveActivity | use | Called", config, dialog, message);
      if (config.systemCard) return super.use(config, dialog, message);
      let previousWorkflow = Workflow.getWorkflow(this.uuid);
      if (previousWorkflow) {
        if (!(await confirmWorkflow(previousWorkflow))) return;
      }
 
      if (!config.midiOptions) config.midiOptions = {}; mapSpeedKeys(globalThis.MidiKeyManager.pressedKeys, "damage");
      if (!config.midiOptions.workflowOptions) config.midiOptions.workflowOptions = {};
      await setupTargets(this, config, dialog, message);
      await confirmTargets(this);
      // come back and see about re-rolling etc.
      if (true || !this.workflow) {
        this.workflow = new Workflow(this.actor, this, ChatMessage.getSpeaker({ actor: this.item.actor }), this.targets, config.midiOptions);
        this.workflow.rollOptions = mapSpeedKeys(globalThis.MidiKeyManager.pressedKeys, "damage");
      }
      if (!await confirmCanProceed(this, config, dialog, message)) return;

      setProperty(message, "data.flags.midi-qol.messageType", "save");
      const results = await super.use(config, dialog, message);
      this.workflow.itemCardUuid = results.message.uuid;
      this.workflow.performState(this.workflow.WorkflowState_Start, {});
      return results;
    }

    async rollDamage(config, dialog, message: any = {}) {
      if (debugEnabled > 0)
        warn("SaveActivity | rollDamage | Called", config, dialog, message);
      if (await asyncHooksCall("midi-qol.preDamageRoll", this.workflow) === false
        || await asyncHooksCall(`midi-qol.preDamageRoll.${this.item.uuid}`, this.workflow) === false
        || await asyncHooksCall(`midi-qol.preDamageRoll.${this.uuid}`, this.workflow) === false) {
        console.warn("midi-qol | Damage roll blocked via pre-hook");
        return;
      }
      dialog.configure = !config.midiOptions.fastForwardDamage;
      Hooks.once("dnd5e.preRollDamageV2", (rollConfig, dialogConfig, messageConfig) => {
        delete rollConfig.event;
        return true;
      })

      message.create = false;
      let result = await super.rollDamage(config, dialog, message);
      result = await postProcessDamageRoll(this, config, result);
      if (config.midiOptions.updateWorkflow !== false && this.workflow) {
        await this.workflow.setDamageRolls(result);
        if (this.workflow.suspended)
          this.workflow.unSuspend.bind(this.workflow)({ damageRoll: result, otherDamageRoll: this.workflow.otherDamageRoll });
      }
      return result;
    }


    prepareFinalData(rollData) {
      super.prepareFinalData(rollData);
    }
    get messageFlags() {
      const baseFlags = super.messageFlags;
      const targets = new Map();
      if (this.targets) {
        for (const token of this.targets) {
          const { name } = token;
          const { img, system, uuid } = token.actor ?? {};
          if (uuid) targets.set(uuid, { name, img, uuid, ac: system?.attributes?.ac?.value });
        }
        baseFlags.targets = Array.from(targets);
        // foundry.utils.setProperty(baseFlags, "roll.type", "usage");
      }
      return baseFlags;
    }

    getDamageConfig(config: any = {}) {
      const attackRoll: Roll | undefined = this.workflow?.attackRoll;
      const rollConfig = super.getDamageConfig(config);
      configureDamageRoll(this, rollConfig);
      for (let roll of rollConfig.rolls) {
        roll.options.isCritical = config.midiOptions.isCritical;
        roll.options.isFumble = config.midiOptions.isFumble;
      }
      return rollConfig;
    }

    async _prepareEffectContext(context) {
      context = await super._prepareEffectContext(context);
      if (debugEnabled > 0) warn("SaveActivity | _prepareEffectContext | Called", context); 
      return context;
    }

    async _usageChatContext(message) {
      const context = await super._usageChatContext(message);
      return midiUsageChatContext(this, context);
    }

    get useCondition() {
      if (this.useConditionText && this.useConditionText !== "") return this.useConditionText;
      return foundry.utils.getProperty(this.item, "flags.midi-qol.itemCondition") ?? "";
    }
    
    get effectCondition() {
      if (this.effectConditionText && this.effectConditionText !== "") return this.effectConditionText;
      return foundry.utils.getProperty(this.item, "flags.midi-qol.effectCondition") ?? "";
    }
    
    get reactionCondition() {
      return foundry.utils.getProperty(this.item, "flags.midi-qol.reactionCondition") ?? "";
    }

    get otherCondition() {
      return foundry.utils.getProperty(this.item, "flags.midi-qol.otherCondition") ?? "";
    }

    get otherActivity() {
      return undefined;
    }

    get hasDamage() {
      return this.damage.parts.length > 0;
    }
  }

}

export function defineMidiSaveSheetClass(baseClass: any) {
  return class MidiSaveSheet extends baseClass {
    static PARTS = {
      ...super.PARTS,
      effect: {
        template: "modules/midi-qol/templates/activity/save-effect.hbs",
        templates: [
          ...super.PARTS.effect.templates,
        ]
      }
    };
    async _prepareContext(options) {
      await this.activity.prepareData({});
      const returnvalue =  await super._prepareContext(options);
      return returnvalue;
    }
  }
}
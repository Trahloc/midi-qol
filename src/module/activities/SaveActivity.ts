import { debugEnabled, i18n, warn } from "../../midi-qol.js";
import { Workflow } from "../Workflow.js";
import { configSettings } from "../settings.js";
import { asyncHooksCall } from "../utils.js";
import { configureDamageRoll, confirmCanProceed, confirmTargets, confirmWorkflow, midiUsageChatContext, postProcessDamageRoll, setupTargets } from "./activityHelpers.js";

export var MidiSaveActivity;

export function setupSaveActivity() {
  if (debugEnabled > 0) warn("MidiQOL | SaveActivity | setupSaveActivity | Called");
  //@ts-expect-error
  const GameSystemConfig = game.system.config;
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
    _activityWorkflow: Workflow;
    get activityWorkflow() { return this._activityWorkflow; }
    set activityWorkflow(value) { this._activityWorkflow = value; }
    static metadata =
      foundry.utils.mergeObject(
        foundry.utils.mergeObject({}, super.metadata), {
        title: "midi-qol.SAVE.Title.one",
        usage: {
          chatCard: "modules/midi-qol/templates/activity-card.hbs",
        },
      }, { overwrite: true })


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
      const pressedKeys = foundry.utils.duplicate(globalThis.MidiKeyManager.pressedKeys);
      let tokenToUse;
      let targetConfirmationHasRun = false;

      if (!config.midiOptions) config.midiOptions = {};
      if (!config.midiOptions.workflowOptions) config.midiOptions.workflowOptions = {};
      setupTargets(this, config, dialog, message);
      if (!confirmCanProceed(this, config, dialog, message)) return;
      confirmTargets(this);
      console.error("MidiQOL | SaveActivity | use | Called", config, dialog, message);
      if (!this.activityWorkflow) {
        this.activityWorkflow = new Workflow(this.item.actor, this, ChatMessage.getSpeaker({ actor: this.item.actor }), this.targets, {});
      }
      // come back and see about re-rolling etc.
      this.activityWorkflow = new Workflow(this.item.actor, this, ChatMessage.getSpeaker({ actor: this.item.actor }), this.targets, {});

      setProperty(message, "data.flags.midi-qol.messageType", "save");
      const results = await super.use(config, dialog, message);
      this.activityWorkflow.itemCardUuid = results.message.uuid;
      this.activityWorkflow.performState(this.activityWorkflow.WorkflowState_Start, {});
      return results;
    }

    async rollDamage(config, dialog, message: any = {}) {
      console.error("MidiQOL | SaveActivity | rollDamage | Called", config, dialog, message);
      if (await asyncHooksCall("midi-qol.preDamageRoll", this.activityWorkflow) === false
        || await asyncHooksCall(`midi-qol.preDamageRoll.${this.item.uuid}`, this.activityWorkflow) === false
        || await asyncHooksCall(`midi-qol.preDamageRoll.${this.uuid}`, this.activityWorkflow) === false) {
        console.warn("midi-qol | Damage roll blocked via pre-hook");
        return;
      }
      Hooks.once("dnd5e.preRollDamageV2", (rollConfig, dialogConfig, messageConfig) => {
        delete rollConfig.event;
        dialogConfig.configure = !rollConfig.midiOptions.fastForwardDamage;
        return true;
      })

      message.create = false;
      let result = await super.rollDamage(config, this.dialog, message);
      result = await postProcessDamageRoll(this, config, result);
      if (config.midiOptions.updateWorkflow !== false) {
        await this.activityWorkflow.setDamageRolls(result);
        if (this.activityWorkflow.suspended)
          this.activityWorkflow.unSuspend.bind(this.activityWorkflow)({ damageRoll: result, otherDamageRoll: this.activityWorkflow.otherDamageRoll });
      }
      return result;
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
      const attackRoll: Roll | undefined = this.activityWorkflow.attackRoll;
      const rollConfig = super.getDamageConfig(config);
      configureDamageRoll(this, rollConfig);
      for (let roll of rollConfig.rolls) {
        roll.options.isCritical = config.midiOptions.isCritical;
        roll.options.isFumble = config.midiOptions.isFumble;
      }
      return rollConfig;
    }


    async _usageChatContext(message) {
      const context = await super._usageChatContext(message);
      return midiUsageChatContext(this, context);
    }

    get saveActivity() {
      return undefined;
    }
  }

}
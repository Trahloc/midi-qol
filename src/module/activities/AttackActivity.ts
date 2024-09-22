import { debugEnabled, warn, i18n, SystemString, log, debug, MODULE_ID, GameSystemConfig, debugCallTiming } from "../../midi-qol.js";
import { ActivityWorkflow } from "../ActivityWorkflow.js";
import { configSettings } from "../settings.js";
import { addAdvAttribution, asyncHooksCall, displayDSNForRoll, evalActivationCondition, getAutoRollAttack, getAutoRollDamage, getCachedDocument, getDamageType, getFlankingEffect, getRemoveAttackButtons, getRemoveDamageButtons, getSpeaker, getTokenForActorAsSet, hasDAE, itemHasDamage, itemIsVersatile, processAttackRollBonusFlags, processDamageRollBonusFlags, sumRolls, tokenForActor, validTargetTokens } from "../utils.js";
import { configureAttackRoll, configureDamageRoll, confirmCanProceed, confirmTargets, confirmWorkflow, midiUsageChatContext, postProcessDamageRoll, removeFlanking, setupTargets } from "./activityHelpers.js";

export function defineMidiAttackActivityClass(baseClass: any) {
  return class MidiAttackActivity extends baseClass {
    targetsToUse: Set<Token>;

    _activityWorkflow: ActivityWorkflow;
    get activityWorkflow() { return this._activityWorkflow; }
    set activityWorkflow(value) { this._activityWorkflow = value; }

    static metaData = foundry.utils.mergeObject(super.metadata, {
      usage: { chatCard: "modules/midi-qol/templates/activity-card.hbs" },
    })

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

    async use(usage, dialog, message) {
      if (!this.item.isEmbedded) return;
      if (!this.item.isOwner) {
        ui.notifications?.error("DND5E.DocumentUseWarn", { localize: true });
      }
      if (debugEnabled > 0) warn("MidiQOL | AttackActivity | use | Called", usage, dialog, message);
      if (usage.systemCard) return super.use(usage, dialog, message);
      let previousWorkflow = ActivityWorkflow.getWorkflow(this.uuid);
      if (previousWorkflow) {
        if (!(await confirmWorkflow(previousWorkflow))) return;
      }
      removeFlanking(this.item.parent)
      const pressedKeys = foundry.utils.duplicate(globalThis.MidiKeyManager.pressedKeys);
      let tokenToUse;
      let targetConfirmationHasRun = false;

      if (!usage.rollOptions) usage.rollOptions = {};
      if (!usage.rollOptions.workflowOptions) usage.rollOptions.workflowOptions = {};
      setupTargets(this, usage, dialog, message);
      if (!confirmCanProceed(this)) return;
      confirmTargets(this);
      console.error("MidiQOL | AttackActivity | use | Called", usage, dialog, message);
      if (!this.activityWorkflow) {
        this.activityWorkflow = new ActivityWorkflow(this.item.actor, this, ChatMessage.getSpeaker({ actor: this.item.actor }), this.targets, {});
      }
      // come back and see about re-rolling etc.
      this.activityWorkflow = new ActivityWorkflow(this.item.actor, this, ChatMessage.getSpeaker({ actor: this.item.actor }), this.targets, {});

      setProperty(message, "data.flags.midi-qol.messageType", "attack");
      const results = await super.use(usage, dialog, message);
      this.activityWorkflow.itemCardUuid = results.message.uuid;
      this.activityWorkflow.performState(this.activityWorkflow.WorkflowState_Start, {});
      return results;
    }

    async rollAttack(config, dialog, message) {
      if (debugEnabled > 0) warn("MidiQOL | AttackActivity | rollAttack | Called", config, dialog, message);
      let returnValue = await configureAttackRoll(this, config);
      if (this.activityWorkflow.aborted || !returnValue) return [];
      // Can't tell rollAttack to fastforward, so we have to do it here
      Hooks.once("dnd5e.preRollAttackV2", (rollConfig, dialogConfig, messageConfig) => {
        for (let roll of rollConfig.rolls) {
          roll.options.advantage = config.rollOptions.advantage;
          roll.options.disadvantage = config.rollOptions.disadvantage;
        }
        delete rollConfig.event;
        dialogConfig.configure = !config.rollOptions.fastForwardAttack;
        return true;
      });

      message ??= {};
      message.create = config.rollOptions.chatMessage;
      if (config.rollOptions.fastForwardAttack) dialog.configure = false;
      const rolls = await super.rollAttack(config, dialog, message);
      await this.activityWorkflow.setAttackRoll(rolls[0]);
      rolls[0] = await processAttackRollBonusFlags.bind(this.activityWorkflow)();
      if (["formulaadv", "adv"].includes(configSettings.rollAlternate)) addAdvAttribution(rolls[0], this.activityWorkflow.attackAdvAttribution);
      await this.activityWorkflow.setAttackRoll(rolls[0]);
      if (this.activityWorkflow.suspended) this.activityWorkflow.unSuspend.bind(this.activityWorkflow)({ attackRoll: rolls[0] })
      return rolls;
    }

    getDamageConfig(config: any = {}) {
      const rollConfig = super.getDamageConfig(config);
      configureDamageRoll(this, rollConfig);
      for (let roll of rollConfig.rolls) {
        roll.options.isCritical = config.rollOptions.critical;
      }
      return rollConfig;
    }

    async rollDamage(config, dialog, message: any = {}) {
      console.error("MidiQOL | AttackActivity | rollDamage | Called", config, dialog, message);
      if (await asyncHooksCall("midi-qol.preDamageRoll", this.activityWorkflow) === false || await asyncHooksCall(`midi-qol.preDamageRoll.${this.uuid}`, this.activityWorkflow) === false) {
        console.warn("midi-qol | Damage roll blocked via pre-hook");
        return;
      }
      Hooks.once("dnd5e.preRollDamageV2", (rollConfig, dialogConfig, messageConfig) => {
        delete rollConfig.event;
        dialogConfig.configure = !rollConfig.rollOptions.fastForwardDamage;
        return true;
      })

      message.create = false;
      const result = await super.rollDamage(config, this.dialog, message);
      postProcessDamageRoll(this, config, result);
      await this.activityWorkflow.setDamageRolls(result);
      if (this.activityWorkflow.suspended) this.activityWorkflow.unSuspend.bind(this.activityWorkflow)({ damageRoll: result, otherDamageRoll: this.activityWorkflow.otherDamageRoll });
    }

    async _usageChatContext(message) {
      const context = await super._usageChatContext(message);
      return midiUsageChatContext(this, context);
    }
  }
}

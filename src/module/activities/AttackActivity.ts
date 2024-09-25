import { debugEnabled, warn, i18n, SystemString, log, debug, MODULE_ID, GameSystemConfig, debugCallTiming } from "../../midi-qol.js";
import { ActivityWorkflow } from "../ActivityWorkflow.js";
import { configSettings } from "../settings.js";
import { addAdvAttribution, asyncHooksCall, displayDSNForRoll, evalActivationCondition, getAutoRollAttack, getAutoRollDamage, getCachedDocument, getDamageType, getFlankingEffect, getRemoveAttackButtons, getRemoveDamageButtons, getSpeaker, getTokenForActorAsSet, hasDAE, itemHasDamage, itemIsVersatile, processAttackRollBonusFlags, processDamageRollBonusFlags, sumRolls, tokenForActor, validTargetTokens } from "../utils.js";
import { configureAttackRoll, configureDamageRoll, confirmCanProceed, confirmTargets, confirmWorkflow, midiUsageChatContext, postProcessDamageRoll, removeFlanking, setupTargets } from "./activityHelpers.js";

var MidiAttackSheet;
Hooks.once("init", () => {
  //@ts-expect-error
  MidiAttackSheet = class MidiAttackSaveSheet extends game.system.applications.activity.AttackSheet {
    static PARTS = {
      ...super.PARTS,
      effect: {
        template: "systems/dnd5e/templates/activity/attack-effect.hbs",
        templates: [
          ...super.PARTS.effect.templates,
          "systems/dnd5e/templates/activity/parts/attack-damage.hbs",
          "systems/dnd5e/templates/activity/parts/attack-details.hbs",
          "systems/dnd5e/templates/activity/parts/damage-part.hbs",
          "systems/dnd5e/templates/activity/parts/damage-parts.hbs"
        ]
      }
    }

    async _prepareEffectContext(context) {
      context = super._prepareEffectContext(context);
      console.error(context);
      return context;
    }

    async _prepareIdentityContext(context) {
      context = super._prepareIdentityContext(context);
      console.error(context);
      return context;
    }
  }
});

export function defineMidiAttackActivityClass(baseClass: any) {
  return class MidiAttackSaveActivity extends baseClass {
    static defineSchema() {
      const schema = {
        ...super.defineSchema(),
        //@ts-expect-error
        flags: new foundry.data.fields.ObjectField(),
      }
      //@ts-expect-error
      schema.attack["attackMode"] = new foundry.data.fields.StringField({ default: "onehanded" });
      return schema;
    }

    targetsToUse: Set<Token>;

    _activityWorkflow: ActivityWorkflow;
    get activityWorkflow() { return this._activityWorkflow; }
    set activityWorkflow(value) { this._activityWorkflow = value; }


    static metadata =
      foundry.utils.mergeObject(
        foundry.utils.mergeObject({}, super.metadata), {
        sheetClass: MidiAttackSheet,
        title: i18n("midi." + super.metadata.title),
        usage: {
          chatCard: "modules/midi-qol/templates/activity-card.hbs",
        },
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

    async use(config, dialog, message) {
      if (!this.item.isEmbedded) return;
      if (!this.item.isOwner) {
        ui.notifications?.error("DND5E.DocumentUseWarn", { localize: true });
      }
      if (debugEnabled > 0) warn("MidiQOL | AttackActivity | use | Called", config, dialog, message);
      if (config.systemCard) return super.use(config, dialog, message);
      let previousWorkflow = ActivityWorkflow.getWorkflow(this.uuid);
      if (previousWorkflow) {
        if (!(await confirmWorkflow(previousWorkflow))) return;
      }
      removeFlanking(this.item.parent)
      const pressedKeys = foundry.utils.duplicate(globalThis.MidiKeyManager.pressedKeys);
      let tokenToUse;
      let targetConfirmationHasRun = false;

      if (!config.midiOptions) config.midiOptions = {};
      if (!config.midiOptions.workflowOptions) config.midiOptions.workflowOptions = {};
      setupTargets(this, config, dialog, message);
      if (!confirmCanProceed(this, config, dialog, message)) return;
      confirmTargets(this);
      console.error("MidiQOL | AttackActivity | use | Called", config, dialog, message);
      if (!this.activityWorkflow) {
        this.activityWorkflow = new ActivityWorkflow(this.actor, this, ChatMessage.getSpeaker({ actor: this.item.actor }), this.targets, config.midiOptions);
      }
      // come back and see about re-rolling etc.
      this.activityWorkflow = new ActivityWorkflow(this.actor, this, ChatMessage.getSpeaker({ actor: this.item.actor }), this.targets, config.midiOptions);

      setProperty(message, "data.flags.midi-qol.messageType", "attack");
      const results = await super.use(config, dialog, message);
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
          if (config.midiOptions.advantage) roll.options.advantage = config.midiOptions.advantage;
          if (config.midiOptions.disadvantage) roll.options.disadvantage = config.midiOptions.disadvantage;
        }
        delete rollConfig.event;
        dialogConfig.configure = !config.midiOptions.fastForwardAttack;
        return true;
      });

      message ??= {};
      message.create = config.midiOptions.chatMessage;
      if (config.midiOptions.fastForwardAttack) dialog.configure = false;
      const rolls = await super.rollAttack(config, dialog, message);
      for (let roll of rolls) {
        if (config.attackMode) roll.options.attackMode = config.attackMode;
      }
      await this.activityWorkflow.setAttackRoll(rolls[0]);
      rolls[0] = await processAttackRollBonusFlags.bind(this.activityWorkflow)();
      if (["formulaadv", "adv"].includes(configSettings.rollAlternate)) addAdvAttribution(rolls[0], this.activityWorkflow.attackAdvAttribution);
      await this.activityWorkflow.setAttackRoll(rolls[0]);
      if (this.activityWorkflow.suspended) this.activityWorkflow.unSuspend.bind(this.activityWorkflow)({ attackRoll: rolls[0] })
      return rolls;
    }

    getDamageConfig(config: any = {}) {
      const attackRoll: Roll | undefined = this.activityWorkflow.attackRoll;
      //@ts-expect-error
      if (attackRoll) config.attackMode = attackRoll.options.attackMode;
      const rollConfig = super.getDamageConfig(config);
      configureDamageRoll(this, rollConfig);
      for (let roll of rollConfig.rolls) {
        roll.options.isCritical = config.midiOptions.critical;
      }
      return rollConfig;
    }

    async rollDamage(config, dialog, message: any = {}) {
      console.error("MidiQOL | AttackActivity | rollDamage | Called", config, dialog, message);
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

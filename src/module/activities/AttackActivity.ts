import { debugEnabled, warn, i18n, SystemString, log, debug, MODULE_ID, GameSystemConfig, debugCallTiming, SchemaField, StringField, NumberField, BooleanField } from "../../midi-qol.js";
import { Workflow } from "../Workflow.js";
import { configSettings } from "../settings.js";
import { addAdvAttribution, asyncHooksCall, createConditionData, displayDSNForRoll, evalActivationCondition, getAutoRollAttack, getAutoRollDamage, getCachedDocument, getDamageType, getFlankingEffect, getRemoveAttackButtons, getRemoveDamageButtons, getSpeaker, getTokenForActorAsSet, hasDAE, itemHasDamage, itemIsVersatile, processAttackRollBonusFlags, processDamageRollBonusFlags, sumRolls, tokenForActor, validTargetTokens } from "../utils.js";
import { configureAttackRoll, configureDamageRoll, confirmCanProceed, confirmTargets, confirmWorkflow, midiUsageChatContext, postProcessDamageRoll, removeFlanking, setupTargets } from "./activityHelpers.js";

export var MidiAttackSheet;
export var MidiAttackActivity;
export function setupAttackActivity() {
  if (debugEnabled > 0) warn("MidiQOL | AttackActivity | setupAttackActivity | Called");
  //@ts-expect-error
  MidiAttackSheet = defineMidiAttackSheetClass(game.system.applications.activity.AttackSheet);
  MidiAttackActivity = defineMidiAttackActivityClass(GameSystemConfig.activityTypes.attack.documentClass);
  if (configSettings.replaceDefaultActivities) {
    GameSystemConfig.activityTypes["dnd5eAttack"] = GameSystemConfig.activityTypes.attack;
    GameSystemConfig.activityTypes.attack = { documentClass: MidiAttackActivity };
  } else {
    GameSystemConfig.activityTypes["midiAttack"] = { documentClass: MidiAttackActivity };
  }
}

export function defineMidiAttackSheetClass(baseClass: any) {
  return class MidiAttackSheet extends baseClass {
    static PARTS = {
      ...super.PARTS,
      effect: {
        template: "modules/midi-qol/templates/activity/attack-effect.hbs",
        templates: [
          ...super.PARTS.effect.templates,
          "modules/midi-qol/templates/activity/parts/use-condition.hbs",
          "modules/midi-qol/templates/activity/parts/attack-extras.hbs",
        ]
      }
    }

    async _prepareEffectContext(context) {
      context = await super._prepareEffectContext(context);
      context.attackModeOptions = this.item.system.attackModes;
      context.hasAmmunition = this.item.system.properties.has("amm");
      context.ammunitionOptions = this.activity.actor.items
        .filter(i => (i.type === "consumable") && (i.system.type?.value === "ammo")
          && (!this.item.system.ammunition?.type || (i.system.type.subtype === this.item.system.ammunition.type)))
        .map(i => ({
          value: i.id, label: `${i.name} (${i.system.quantity})`, item: i,
          disabled: !i.system.quantity, selected: i.id === this.activity.attack.ammunition
        }))
        .sort((lhs, rhs) => lhs.label.localeCompare(rhs.label, game.i18n.lang));
      context.otherActivityOptions = this.item.system.activities.filter(a =>
        a.damage || a.roll?.formula).reduce((ret, a) => { ret.push({ label: `${a.name}`, value: a.uuid }); return ret }, [{ label: "", value: "" }]);
      context.saveActivityOptions = this.item.system.activities.filter(a =>
        a.save).reduce((ret, a) => { ret.push({ label: `${a.name}`, value: a.uuid }); return ret }, [{ label: "", value: "" }]);
      let indexOffset = 0;

      if (context.activity.damage?.parts) {
        const scalingOptions = [
          { value: "", label: game.i18n.localize("DND5E.DAMAGE.Scaling.None") },
          //@ts-expect-error
          ...Object.entries(GameSystemConfig.damageScalingModes).map(([value, config]) => ({ value, label: config.label }))
        ];
        const types = Object.entries(GameSystemConfig.damageTypes).concat(Object.entries(GameSystemConfig.healingTypes));
        context.damageParts = context.activity.damage.parts.map((data, index) => {
          if (data.base) indexOffset--;
          const part = {
            data,
            fields: this.activity.schema.fields.damage.fields.parts.element.fields,
            prefix: `damage.parts.${index + indexOffset}.`,
            source: context.source.damage.parts[index + indexOffset] ?? data,
            canScale: this.activity.canScaleDamage,
            scalingOptions,
            typeOptions: types.map(([value, config]) => ({
              //@ts-expect-error
              value, label: config.label, selected: data.types.has(value)
            }))
          };
          return this._prepareDamagePartContext(context, part);
        })
      }
      if (debugEnabled > 0) {
        warn(("prepareEffectContext | context"), context);
      }
      return context;
    }

    _prepareContext(options) {
      return super._prepareContext(options);
    }

    _prepareSubmitData(event, formData) {
      let submitData = super._prepareSubmitData(event, formData);
      return submitData;
    }

  }
}
export function defineMidiAttackActivityClass(baseClass: any) {
  return class MidiAttackActivity extends baseClass {
    static defineSchema() {
      const schema = {
        ...super.defineSchema(),
        // @ ts-expect-error
        // flags: new foundry.data.fields.ObjectField(),
        forceDialog: new BooleanField({ name: "forceDialog", label: "Force Dialog", initial: false }),
        attackMode: new StringField({ name: "attackMode", label: "Attack Mode", initial: "oneHanded" }),
        useConditionText: new StringField({ name: "useCondition", label: "Use Condition", initial: "" }),
        effectConditionText: new StringField({ name: "effectCondition", label: "Effect Condition", initial: "" }),
        ammunition: new StringField({ name: "ammunition", label: "Ammunition", initial: "" }),
        saveActivityUuid: new StringField({ name: "saveActivity", label: "Save Activity", initial: "" }),
        otherActivityUuid: new StringField({ name: "otherActivity", label: "Other Activity", initial: "" }),
      };
      return schema;
    }
    _workflow: Workflow | undefined;
    _otherActivity: any | undefined;
    _saveActivity: any | undefined;
    get workflow() { return this._workflow; }
    set workflow(value) { this._workflow = value; }


    prepareFinalData(rollData) {
      super.prepareFinalData(rollData);
    }

    static metadata =
    foundry.utils.mergeObject(
      foundry.utils.mergeObject({}, super.metadata), {
      sheetClass: MidiAttackSheet,
      title: "midi-qol.ATTACK.Title.one",
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
    let previousWorkflow = Workflow.getWorkflow(this.uuid);
    if (previousWorkflow) {
      if (!(await confirmWorkflow(previousWorkflow))) return;
    }
    await removeFlanking(this.item.parent)
    if (!config.midiOptions) config.midiOptions = {};
    if (!config.midiOptions.workflowOptions) config.midiOptions.workflowOptions = {};
    await setupTargets(this, config, dialog, message);
    await confirmTargets(this);
    // come back and see about re-rolling etc.
    if (true || !this.workflow) {
      this.workflow = new Workflow(this.actor, this, ChatMessage.getSpeaker({ actor: this.item.actor }), this.targets, config.midiOptions);
    }
    if (!await confirmCanProceed(this, config, dialog, message)) return;
    foundry.utils.setProperty(message, "data.flags.midi-qol.messageType", "attack");
    const results = await super.use(config, dialog, message);
    this.workflow.itemCardUuid = results.message.uuid;
    await this.workflow.performState(this.workflow.WorkflowState_Start.bind(this.workflow), {});
    return results;
  }

    async rollAttack(config, dialog, message) {
    if (debugEnabled > 0) warn("MidiQOL | AttackActivity | rollAttack | Called", config, dialog, message);
    let returnValue = await configureAttackRoll(this, config);
    if (this.workflow?.aborted || !returnValue) return [];
    // Can't tell rollAttack to fastforward, so we have to do it here
    dialog.configure = !config.midiOptions.fastForwardAttack
    Hooks.once("dnd5e.preRollAttackV2", (rollConfig, dialogConfig, messageConfig) => {
      for (let roll of rollConfig.rolls) {
        if (config.midiOptions.advantage) roll.options.advantage ||= config.midiOptions.advantage;
        if (config.midiOptions.disadvantage) roll.options.disadvantage ||= config.midiOptions.disadvantage;
      }
      delete rollConfig.event;
      return true;
    });

    message ??= {};
    message.create = config.midiOptions.chatMessage;
    if (config.midiOptions.fastForwardAttack) dialog.configure = false;
    config.attackMode = this.attackMode ?? "oneHanded";
    config.ammunition = this.ammunition;
    const rolls = await super.rollAttack(config, dialog, message);
    if (this.workflow) {
      this.workflow.attackMode = config.attackMode;
      this.workflow.ammunition = config.ammunition;
      await this.workflow?.setAttackRoll(rolls[0]);
      rolls[0] = await processAttackRollBonusFlags.bind(this.workflow)();
      if (["formulaadv", "adv"].includes(configSettings.rollAlternate)) addAdvAttribution(rolls[0], this.workflow.attackAdvAttribution);
      await this.workflow?.setAttackRoll(rolls[0]);
    }
    if (debugEnabled > 0) {
      warn("AttackActivity | rollAttack | setAttackRolls completed ", rolls);
      warn(`Attack Activity | workflow is suspended ${this.workflow?.suspended}`);
    }
    if (this.workflow?.suspended) this.workflow.unSuspend.bind(this.workflow)({ attackRoll: rolls[0] })
    return rolls;
  }

  getDamageConfig(config: any = {}) {
    config.attackMode = this.workflow?.attackMode;
    config.ammunition = this.actor.items.get(this.workflow?.ammunition);
    const rollConfig = super.getDamageConfig(config);
    configureDamageRoll(this, rollConfig);
    for (let roll of rollConfig.rolls) {
      roll.options.isCritical ||= config.midiOptions.isCritical;
      roll.options.isFumble ||= config.midiOptions.isFumble;
    }
    return rollConfig;
  }

    async rollDamage(config, dialog, message: any = {}) {
    if (!config.midiOptions) config.midiOptions = {};
    if (debugEnabled > 0) {
      warn("AttackActivity | rollDamage | Called", config, dialog, message);
    }
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
    if (this.workflow && config.midiOptions.updateWorkflow !== false) await this.workflow.setDamageRolls(result);
    if (this.otherActivity) {
      let shouldRollOther = true;
      if (this.otherCondition) {
        //@ts-expect-error
        const token = this.workflow.hitTargets.first();
        if (this.workflow && !(await evalActivationCondition(this.workflow, this.otherCondition, token, { async: true }))) {
          warn("AttackActivity | rollDamage | otherCondition false", this.otherCondition);
          shouldRollOther = false;
        }
      }
      if (shouldRollOther) {
        this.otherActivity.workflow = this.workflow;
        // Check conditions & flags
        const otherConfig = foundry.utils.deepClone(config);
        if (!foundry.utils.getProperty(this.item, "flags.midiProperties.critOther")) otherConfig.midiOptions.isCritical = false;
        otherConfig.midiOptions.updateWorkflow = false;
        foundry.utils.setProperty(otherConfig, "critical.allow", this.item.flags.midiProperties?.critOther);
        let otherResult;
        if (this.otherActivity?.damage)
          otherResult = await this.otherActivity.rollDamage(otherConfig, dialog, { create: false });
        else if (this.otherActivity?.roll?.formula) {
          otherResult = await this.otherActivity.rollFormula(otherConfig, dialog, { create: false });
          if (otherResult instanceof Array) otherResult = otherResult[0];
          //@ts-expect-error
          otherResult = new game.system.dice.DamageRoll(otherResult.formula, {}, {});
        }
        if (otherResult instanceof Array) otherResult = otherResult[0]; // TODO deal with arrays of rolls
        if (otherResult && config.midiOptions.updateWorkflow !== false && this.workflow) await this.workflow.setOtherDamageRoll(otherResult);
      }
    }
    if (config.midiOptions.updateWorkflow !== false && this.workflow?.suspended) this.workflow.unSuspend.bind(this.workflow)({ damageRoll: result, otherDamageRoll: this.workflow.otherDamageRoll });
    return result;
  }

    async _usageChatContext(message) {
    const context = await super._usageChatContext(message);
    return midiUsageChatContext(this, context);
  }

    get saveActivity() {
    if (this._saveActivity) return this._saveActivity;
    if (!this.saveActivityUuid || this.saveActivityUuid === "") {
      if (configSettings.autoMergeActivitySave) {
        const saveActivity = this.item.system.activities.find(a => a.save);
        if (!saveActivity) return undefined;
        this._saveActivity = saveActivity;
        return saveActivity
      }
      return undefined;
    }
    //@ts-expect-error
    this._saveActivity = fromUuidSync(this.saveActivityUuid);
    this._saveActivity.prepareData();
    return this._saveActivity;
  }

    get otherActivity() {
    if (this._otherActivity) return this._otherActivity;
    if (!this.otherActivityUuid || this.otherActivityUuid === "") {
      const saveActivity = this.saveActivity
      if (!saveActivity || !saveActivity.damage) return undefined;
      return saveActivity;
    }
    //@ts-expect-error
    this._otherActivity = fromUuidSync(this.otherActivityUuid)
    this._otherActivity.prepareData();
    return this._otherActivity;
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
    if (this.useCondition && this.useCondition !== "") return this.useCondition;
    return foundry.utils.getProperty(this.item, "flags.midi-qol.reactionCondition") ?? "";
  }

    get otherCondition() {
    if (this.otherActivity && this.otherActivity.useCondition !== "") return this.otherActivity.useCondition;
    return foundry.utils.getProperty(this.item, "flags.midi-qol.otherCondition") ?? "";
  }
}
}
import { debugEnabled, warn, i18n, SystemString, log, debug, MODULE_ID, GameSystemConfig, debugCallTiming, SchemaField, StringField, NumberField, BooleanField } from "../../midi-qol.js";
import { Workflow } from "../Workflow.js";
import { configSettings } from "../settings.js";
import { addAdvAttribution, asyncHooksCall, displayDSNForRoll, evalActivationCondition, getAutoRollAttack, getAutoRollDamage, getCachedDocument, getDamageType, getFlankingEffect, getRemoveAttackButtons, getRemoveDamageButtons, getSpeaker, getTokenForActorAsSet, hasDAE, itemHasDamage, itemIsVersatile, processAttackRollBonusFlags, processDamageRollBonusFlags, sumRolls, tokenForActor, validTargetTokens } from "../utils.js";
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
  return class MidiAttackActivitySheet extends baseClass {
    static PARTS = {
      ...super.PARTS,
      identity: {
        template: "systems/dnd5e/templates/activity/attack-identity.hbs",
        templates: [
          ...super.PARTS.identity.templates,
          "systems/dnd5e/templates/activity/parts/attack-identity.hbs"
        ]
      },
      effect: {
        template: "modules/midi-qol/templates/activity/attack-effect.hbs",
        templates: [
          ...super.PARTS.effect.templates,
          "systems/dnd5e/templates/activity/parts/attack-damage.hbs",
          "modules/midi-qol/templates/activity/parts/attack-details.hbs",
          "systems/dnd5e/templates/activity/parts/damage-part.hbs",
          "systems/dnd5e/templates/activity/parts/damage-parts.hbs"
        ]
      }
    }

    async _prepareEffectContext(context) {
      context = await super._prepareEffectContext(context);
      console.error(context, this.item)
      context.attackModeOptions = this.item.system.attackModes;
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
      console.error(context);
      return context;
    }

    _prepareSubmitData(event, formData) {
      console.error("preparesumbitdata", formData)
      const attackMode = formData["flags.attack.attackMode"];
      if (attackMode) {
        formData["flags.attack.attackMode"] = attackMode;
      }
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
        //@ts-expect-error
        flags: new foundry.data.fields.ObjectField(),
        attack: new SchemaField({
          ability: new StringField(),
          //@ts-expect-error
          bonus: new game.system.dataModels.fields.FormulaField(),
          critical: new SchemaField({
            threshold: new NumberField({ integer: true, positive: true })
          }),
          flat: new BooleanField(),
          type: new SchemaField({
            value: new StringField(),
            classification: new StringField()
          }),
          attackMode: new StringField({ name: "attackMode", label: "Attack Mode", initial: "oneHanded", choices: ["oneHanded", "twoHanded", "thrown", "offhand", "thrown-offhand"] })
        }),
        saveActivityUuid: new StringField(),
        otherActivityUuid: new StringField()
      };
      console.error(schema)
      //@ ts-expect-error
      // schema.attack.fields["attackMode"] = new foundry.data.fields.StringField({ name: "attackMode", parent: schema.attack, label: "Attack Mode", initial: "oneHanded", choices: ["oneHanded", "twoHanded", "thrown", "offhand", "thrown-offhand"] });
      return schema;
    }

    targetsToUse: Set<Token>;

    _activityWorkflow: Workflow;
    _otherActivity: any;
    _saveActivity: any;
    get activityWorkflow() { return this._activityWorkflow; }
    set activityWorkflow(value) { this._activityWorkflow = value; }


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
        this.activityWorkflow = new Workflow(this.actor, this, ChatMessage.getSpeaker({ actor: this.item.actor }), this.targets, config.midiOptions);
      }
      // come back and see about re-rolling etc.
      this.activityWorkflow = new Workflow(this.actor, this, ChatMessage.getSpeaker({ actor: this.item.actor }), this.targets, config.midiOptions);

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
      config.attackMode = this.attack.attackMode ?? "oneHanded";
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
      const attackRoll: Roll | undefined = this.activityWorkflow?.attackRoll;
      //@ts-expect-error
      if (attackRoll) config.attackMode = attackRoll.options.attackMode;
      const rollConfig = super.getDamageConfig(config);
      configureDamageRoll(this, rollConfig);
      for (let roll of rollConfig.rolls) {
        roll.options.isCritical = config.midiOptions.isCritical;
        roll.options.isFumble = config.midiOptions.isFumble;
      }
      return rollConfig;
    }

    async rollDamage(config, dialog, message: any = {}) {
      if (!config.midiOptions) config.midiOptions = {};
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
      let result = await super.rollDamage(config, this.dialog, message);
      result = await postProcessDamageRoll(this, config, result);
      if (config.midiOptions.updateWorkflow !== false) await this.activityWorkflow.setDamageRolls(result);
      if (this.otherActivity) {
        this.otherActivity.activityWorkflow = this.activityWorkflow;
        // Check conditions & flags
        const otherConfig = foundry.utils.deepClone(config);
        if (!foundry.utils.getProperty(this.item, "flags.midiProperties.critOther")) otherConfig.midiOptions.isCritical = false;
        otherConfig.midiOptions.updateWorkflow = false;
        let otherResult;
        if (this.otherActivity?.damage)
          otherResult = await this.otherActivity.rollDamage(otherConfig, this.dialog, { create: false });
        else if (this.otherActivity?.roll?.formula) {
          otherResult = await this.otherActivity.rollFormula(otherConfig, this.dialog, { create: false });
          if (otherResult instanceof Array) otherResult = otherResult[0];
          //@ts-expect-error
          otherResult = new game.system.dice.DamageRoll(otherResult.formula, {}, {});
        }
        if (otherResult instanceof Array) otherResult = otherResult[0]; // TODO deal with arrays of rolls
        if (otherResult && config.midiOptions.updateWorkflow !== false) await this.activityWorkflow.setOtherDamageRoll(otherResult);
      }
      if (config.midiOptions.updateWorkflow !== false && this.activityWorkflow.suspended) this.activityWorkflow.unSuspend.bind(this.activityWorkflow)({ damageRoll: result, otherDamageRoll: this.activityWorkflow.otherDamageRoll });
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
  }
}
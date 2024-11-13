import { debugEnabled, warn, GameSystemConfig, debug, log } from "../../midi-qol.js";
import { mapSpeedKeys } from "../MidiKeyManager.js";
import { Workflow } from "../Workflow.js";
import { defaultRollOptions } from "../patching.js";
import { configSettings } from "../settings.js";
import { busyWait } from "../tests/setupTest.js";
import { addAdvAttribution, asyncHooksCall, displayDSNForRoll, getSpeaker, processAttackRollBonusFlags } from "../utils.js";
import { MidiActivityMixin } from "./MidiActivityMixin.js";
import { doActivityReactions } from "./activityHelpers.js";

export var MidiAttackSheet;
export var MidiAttackActivity;
export var MidiAttackActivityData;
var AttackActivityData;

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

let defineMidiAttackSheetClass = (baseClass: any) => {
  return class extends baseClass {
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
      context.ammunitionOptions = this.item.isOwned
        ? this.activity.actor.items
          .filter(i => (i.type === "consumable") && (i.system.type?.value === "ammo")
            && (!this.item.system.ammunition?.type || (i.system.type.subtype === this.item.system.ammunition.type)))
          .map(i => ({
            value: i.id, label: `${i.name} (${i.system.quantity})`, item: i,
            disabled: !i.system.quantity, selected: i.id === this.activity.attack.ammunition
          }))
          .sort((lhs, rhs) => lhs.label.localeCompare(rhs.label, game.i18n.lang))
        : [];
      context.otherActivityOptions = this.item.system.activities
        .filter(a => a.uuid !== this.activity.uuid && (a.damage || a.roll?.formula || a.save || a.check))
        .reduce((ret, a) => { ret.push({ label: `${a.name}`, value: a.uuid }); return ret }, [{ label: "", value: "" }]);

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

let defineMidiAttackActivityClass = (ActivityClass: any) => {
  return class MidiAttackActivity extends MidiActivityMixin(ActivityClass) {
    _otherActivity: any | undefined;

    static LOCALIZATION_PREFIXES = [...super.LOCALIZATION_PREFIXES, "midi-qol.ATTACK", "midi-qol.SHARED"];

    static defineSchema() {
      //@ts-expect-error
      const { StringField, ArrayField, BooleanField, SchemaField, ObjectField, NumberField } = foundry.data.fields;

      const schema = {
        ...super.defineSchema(),
        // @ ts-expect-error
        attackMode: new StringField({ name: "attackMode", initial: "oneHanded" }),
        ammunition: new StringField({ name: "ammunition", initial: "" }),
        otherActivityUuid: new StringField({ name: "otherActivity", initial: "" }),
      };
      return schema;
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
        a.damage || a.roll?.formula || a.save || a.check).reduce((ret, a) => { ret.push({ label: `${a.name}`, value: a.uuid }); return ret }, [{ label: "", value: "" }]
        );

      if (debugEnabled > 0) {
        warn(("prepareEffectContext | context"), context);
      }
      return context;
    }

    async _triggerSubsequentActions(config, results) {
    }

    async rollAttack(config, dialog, message) {
      if (!dialog) dialog = {};
      if (!message) message = {};
      if (!config.midiOptions) config.midiOptions = {};
      if (debugEnabled > 0) warn("MidiQOL | AttackActivity | rollAttack | Called", config, dialog, message);
      let returnValue = await this.configureAttackRoll(config);
      if (this.workflow?.aborted || !returnValue) return [];

      try {
        dialog.configure = !config.midiOptions.fastForwardAttack || this.forceDialog || (this.ammunition !== "" && this.confirmAmmuntion);
      } catch (err) {
        console.error("midi-qol | AttackActivity | rollAttack | Error configuring dialog", err);
      }
      Hooks.once("dnd5e.preRollAttackV2", (rollConfig, dialogConfig, messageConfig) => {
        for (let roll of rollConfig.rolls) {
          if (config.midiOptions.advantage) roll.options.advantage ||= !!config.midiOptions.advantage;
          if (config.midiOptions.disadvantage) roll.options.disadvantage ||= !!config.midiOptions.disadvantage;
        }
        delete rollConfig.event;
        return true;
      });

      message ??= {};
      message.create = config.midiOptions.chatMessage;
      config.attackMode = this.attackMode ?? "oneHanded";
      config.ammunition = this.ammunition;
      const rolls = await super.rollAttack(config, dialog, message);
      if (!rolls) return;
      if (dialog.configure && rolls[0]?.options?.ammunition && rolls[0].options.ammunition !== this.ammunition) {
        await this.update({ ammunition: rolls[0].options.ammunition });
        this.ammunition = rolls[0].options.ammunition;
        this._otherActivity = undefined; // reset this in case ammunition changed
      }
      if (this.workflow) {
        this.workflow.attackMode = config.attackMode;
        this.workflow.ammunition = rolls[0].options.ammunition ?? config.ammunition;
        if (this.workflow.workflowOptions?.attackRollDSN !== false) await displayDSNForRoll(rolls[0], "attackRollD20");
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

    async configureAttackRoll(config): Promise<boolean> {
      if (debugEnabled > 0) warn("configureAttackRoll", this, config);
      if (!this.workflow) return false;
      let workflow: Workflow = this.workflow;
      if (!config.midiOptions) config.midiOptions = {};

      if (workflow && !workflow.reactionQueried) {
        workflow.rollOptions = foundry.utils.mergeObject(workflow.rollOptions, mapSpeedKeys(globalThis.MidiKeyManager.pressedKeys, "attack", workflow.rollOptions?.rollToggle), { overwrite: true, insertValues: true, insertKeys: true });
      }

      //@ts-ignore
      if (CONFIG.debug.keybindings && workflow) {
        log("itemhandling doAttackRoll: workflow.rollOptions", workflow.rollOptions);
        log("item handling newOptions", mapSpeedKeys(globalThis.MidiKeyManager.pressedKeys, "attack", workflow.rollOptions?.rollToggle));
      }
      if (debugEnabled > 1) debug("Entering configure attack roll", config.event, workflow, config.rolllOptions);

      // workflow.systemCard = config.midiOptions.systemCard;
      if (workflow.workflowType === "BaseWorkflow") {
        if (workflow.attackRoll && workflow.currentAction === workflow.WorkflowState_Completed) {
          // we are re-rolling the attack.
          await workflow.setDamageRolls(undefined)
          if (workflow.itemCardUuid) {
            await Workflow.removeItemCardAttackDamageButtons(workflow.itemCardUuid);
            await Workflow.removeItemCardConfirmRollButton(workflow.itemCardUuid);
          }

          if (workflow.damageRollCount > 0) { // re-rolling damage counts as new damage
            const itemCard = await this.displayCard(foundry.utils.mergeObject(config, { systemCard: false, workflowId: workflow.id, minimalCard: false, createMessage: true }));
            workflow.itemCardId = itemCard.id;
            workflow.itemCardUuid = itemCard.uuid;
            workflow.needItemCard = false;
          }
        }
      }

      if (config.midiOptions.resetAdvantage) {
        workflow.advantage = false;
        workflow.disadvantage = false;
        workflow.rollOptions = foundry.utils.deepClone(defaultRollOptions);
      }
      if (workflow.workflowType === "TrapWorkflow") workflow.rollOptions.fastForward = true;

      await doActivityReactions(this, workflow);
      await busyWait(0.01);
      if (configSettings.allowUseMacro && workflow.options.noTargetOnusemacro !== true) {
        await workflow.triggerTargetMacros(["isPreAttacked"]);
        if (workflow.aborted) {
          console.warn(`midi-qol | item ${workflow.ammo.name ?? ""} roll blocked by isPreAttacked macro`);
          await workflow.performState(workflow.WorkflowState_Abort);
          return false;
        }
      }

      // Compute advantage
      await workflow.checkAttackAdvantage();
      if (await asyncHooksCall("midi-qol.preAttackRoll", workflow) === false
        || await asyncHooksCall(`midi-qol.preAttackRoll.${this.item.uuid}`, workflow) === false
        || await asyncHooksCall(`midi-qol.preAttackRoll.${this.uuid}`, workflow) === false) {
        console.warn("midi-qol | attack roll blocked by preAttackRoll hook");
        return false;
      }

      // Active defence resolves by triggering saving throws and returns early
      if (game.user?.isGM && workflow.useActiveDefence) {
        delete config.midiOptions.event; // for dnd 3.0
        // TODO work out what to do with active defense 
        /*
        let result: Roll = await wrapped(foundry.utils.mergeObject(options, {
          advantage: false,
          disadvantage: workflow.rollOptions.disadvantage,
          chatMessage: false,
          fastForward: true,
          messageData: {
            speaker: getSpeaker(this.actor)
          }
        }, { overwrite: true, insertKeys: true, insertValues: true }));
        return workflow.activeDefence(this, result);
        */
      }

      // Advantage is true if any of the sources of advantage are true;
      let advantage = config.midiOptions.advantage
        || workflow.options.advantage
        || workflow?.advantage
        || workflow?.rollOptions.advantage
        || workflow?.workflowOptions?.advantage
        || workflow.flankingAdvantage;
      if (workflow.noAdvantage) advantage = false;
      // Attribute advantaage
      if (workflow.rollOptions.advantage) {
        workflow.attackAdvAttribution.add(`ADV:keyPress`);
        workflow.advReminderAttackAdvAttribution.add(`ADV:keyPress`);
      }
      if (workflow.flankingAdvantage) {
        workflow.attackAdvAttribution.add(`ADV:flanking`);
        workflow.advReminderAttackAdvAttribution.add(`ADV:Flanking`);
      }

      let disadvantage = config.midiOptions.disadvantage
        || workflow.options.disadvantage
        || workflow?.disadvantage
        || workflow?.workflowOptions?.disadvantage
        || workflow.rollOptions.disadvantage;
      if (workflow.noDisadvantage) disadvantage = false;

      if (workflow.rollOptions.disadvantage) {
        workflow.attackAdvAttribution.add(`DIS:keyPress`);
        workflow.advReminderAttackAdvAttribution.add(`DIS:keyPress`);
      }
      if (workflow.workflowOptions?.disadvantage)
        workflow.attackAdvAttribution.add(`DIS:workflowOptions`);

      if (advantage && disadvantage) {
        advantage = false;
        disadvantage = false;
      }

      workflow.attackRollCount += 1;
      if (workflow.attackRollCount > 1) workflow.damageRollCount = 0;

      // create an options object to pass to the roll.
      // advantage/disadvantage are already set (in options)
      config.midiOptions = foundry.utils.mergeObject(config.midiOptions, {
        chatMessage: (["TrapWorkflow", "Workflow"].includes(workflow.workflowType)) ? false : config.midiOptions.chatMessage,
        fastForward: workflow.workflowOptions?.fastForwardAttack ?? workflow.rollOptions.fastForwardAttack ?? config.midiOptions.fastForward,
        messageData: {
          speaker: getSpeaker(this.actor)
        }
      },
        { insertKeys: true, overwrite: true });
      if (workflow.rollOptions.rollToggle) config.midiOptions.fastForward = !config.midiOptions.fastForward;
      if (advantage) config.midiOptions.advantage = true; // advantage passed to the roll takes precedence
      if (disadvantage) config.midiOptions.disadvantage = true; // disadvantage passed to the roll takes precedence

      // Setup labels for advantage reminder
      const advantageLabels = Array.from(workflow.advReminderAttackAdvAttribution).filter(s => s.startsWith("ADV:")).map(s => s.replace("ADV:", ""));;
      if (advantageLabels.length > 0) foundry.utils.setProperty(config.midiOptions, "dialogOptions.adv-reminder.advantageLabels", advantageLabels);
      const disadvantageLabels = Array.from(workflow.advReminderAttackAdvAttribution).filter(s => s.startsWith("DIS:")).map(s => s.replace("DIS:", ""));
      if (disadvantageLabels.length > 0) foundry.utils.setProperty(config.midiOptions, "dialogOptions.adv-reminder.disadvantageLabels", disadvantageLabels);

      // It seems that sometimes the option is true/false but when passed to the roll the critical threshold needs to be a number
      if (config.midiOptions.critical === true || config.midiOptions.critical === false)
        config.midiOptions.critical = this.criticalThreshold;
      if (config.midiOptions.fumble === true || config.midiOptions.fumble === false)
        delete config.midiOptions.fumble;

      config.midiOptions.chatMessage = false;
      // This will have to become an actvitity option
      if (foundry.utils.getProperty(this.item, "flags.midiProperties.offHandWeapon")) {
        //@ts-expect-error
        foundry.utils.logCompatibilityWarning(`${this.item.name} item.flags.midiProperties.offHandWeapn is deprecated will be removed in Version 12.5 `
          + "use acitivy.attackMode = offhand instead.",
          { since: 12.1, until: 12.5, once: true });
        config.attackMode = "offHand";
      }
      if (config.midiOptions.versatile) config.attackMode = "twoHanded";
      return true;
    }

    /** @override */
    get actionType() {
      const type = this.attack.type;
      return `${type.value === "ranged" ? "r" : "m"}${type.classification === "spell" ? "sak" : "wak"}`;
    }

    get ammunitionItem() {
      if (!this.ammunition) return undefined;
      const ammunitionItem = this.actor?.items?.get(this.ammunition);
      console.error("MidiQOL | AttackActivity | ammunition | ammunitionItem", ammunitionItem);
      return ammunitionItem
    }

    get otherActivity() {
      if (this._otherActivity !== undefined) return this._otherActivity;
      if (this.ammunitionItem?.system.damage?.replace) {
        //TODO consider making this a choice of activity
        this._otherActivity = this.ammunitionItem.system.activities.contents[0];
        if (this._otherActivity) {
          this._otherActivity.prepareData();
          return this._otherActivity;
        }
      }
      //@ts-expect-error
      this._otherActivity = fromUuidSync(this.otherActivityUuid)
      if (!this._otherActivity && configSettings.autoMergeActivityOther) {
        const otherActivityOptions = this.item.system.activities.filter(a => a.isOtherActivityCompatible);
        if (otherActivityOptions.length === 1) {
          //@ts-expect-error
          this._otherActivity = fromUuidSync(otherActivityOptions[0].uuid);
        }
      }
      this._otherActivity?.prepareData();
      if (!this._otherActivity) this._otherActivity = null;
      return this._otherActivity;
    }

    get confirmAmmuntion() {
      if (game.user?.isGM) return configSettings.gmConfirmAmmunition;
      return configSettings.confirmAmmunition;
    }
  }
}
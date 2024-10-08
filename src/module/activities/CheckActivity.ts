import { debugEnabled, i18n, warn } from "../../midi-qol.js";
import { mapSpeedKeys } from "../MidiKeyManager.js";
import { Workflow } from "../Workflow.js";
import { configSettings } from "../settings.js";
import { asyncHooksCall } from "../utils.js";
import { MidiSaveActivity } from "./SaveActivity.js";
import { configureDamageRoll, confirmCanProceed, confirmTargets, confirmWorkflow, midiUsageChatContext, postProcessDamageRoll, setupTargets } from "./activityHelpers.js";

export var MidiCheckActivity;
export var MidiCheckSheet;
var CheckActivity;
export function setupCheckActivity() {
  if (debugEnabled > 0) warn("MidiQOL | CheckActivity | setupCheckActivity | Called");
  //@ts-expect-error
  const GameSystemConfig = game.system.config;
  CheckActivity = GameSystemConfig.activityTypes.check.documentClass;
  //@ts-expect-error
  MidiCheckSheet = defineMidiCheckSheetClass(game.system.applications.activity.CheckSheet);
  MidiCheckActivity = defineMidiCheckActivityClass(GameSystemConfig.activityTypes.check.documentClass);
  if (configSettings.replaceDefaultActivities) {
    GameSystemConfig.activityTypes["dnd5eCheck"] = GameSystemConfig.activityTypes.check;
    GameSystemConfig.activityTypes.check = { documentClass: MidiCheckActivity };
  } else {
    GameSystemConfig.activityTypes["midiCheck"] = { documentClass: MidiCheckActivity };
  }
}
function getSceneTargets() {
  if (!canvas?.tokens) return [];
  let targets: Array<any>  = canvas?.tokens?.controlled.filter(t => t.actor);
  if ( !targets?.length && game.user?.character ) targets = game.user?.character.getActiveTokens();
  return targets;
}
export function defineMidiCheckActivityClass(baseClass: any) {
  return class MidiCheckActivity extends baseClass {
    static LOCALIZATION_PREFIXES = [...super.LOCALIZATION_PREFIXES, "DND5E.SAVE", "DND5E.CHECK"];

    targetsToUse: Set<Token>;
    _workflow: Workflow | undefined;
    get workflow() { return this._workflow; }
    set workflow(value) { this._workflow = value; }
    static metadata =
      foundry.utils.mergeObject(
        foundry.utils.mergeObject({}, super.metadata), {
        title: "midi-qol.CHECK.Title.one",
        sheetClass: MidiCheckSheet,
        usage: {
          chatCard: "modules/midi-qol/templates/activity-card.hbs",
          actions: {
            rollCheck: MidiCheckActivity.#rollCheck, // CheckActivity.metadata.usage.actions.rollCheck,
            rollDamage: MidiSaveActivity.metadata.usage.actions.rollDamage
          }
        },
      }, { overwrite: true })


    static defineSchema() {
      //@ts-expect-error
      const { StringField, ArrayField, SchemaField } = foundry.data.fields;
      //@ts-expect-error
      const dataModels = game.system.dataModels;
      const { ActivationField: ActivationField, CreatureTypeField, CurrencyTemplate, DamageData,
        DamageField, DurationField, MovementField, RangeField, RollConfigField, SensesField,
        SourceField, TargetField, UsesField } = dataModels.shared

      const schema = {
        ...super.defineSchema(),
        damage: new SchemaField({
          onSave: new StringField(),
          parts: new ArrayField(new DamageField())
        }),

        //@ ts-expect-error
        // flags: new foundry.data.fields.ObjectField(),
        useConditionText: new StringField({ name: "useCondition", label: "Use Condition", initial: "" }),
        effectConditionText: new StringField({ name: "effectCondition", label: "Effect Condition", initial: "" }),
      };
      return schema;
    }


    static async #rollCheck(event, target, message) {
      const targets = getSceneTargets();
      if ( !targets.length ) ui.notifications?.warn("DND5E.ActionWarningNoToken", { localize: true });
      let { ability, dc, skill, tool } = target.dataset;
      dc = parseInt(dc);
      const data: any = { event, targetValue: Number.isFinite(dc) ? dc : this.check.dc.value };
  
      for ( const token of targets ) {
        data.speaker = ChatMessage.getSpeaker({ scene: canvas?.scene ?? undefined, token: token.document });
        if ( skill ) {
          await token.actor.rollSkill(skill, { ...data, ability });
        } else if ( tool ) {
          const checkData = { ...data, ability };
          if ( (this.item.type === "tool") && !this.check.associated.size ) {
            checkData.bonus = this.item.system.bonus;
            checkData.prof = this.item.system.prof;
            checkData.item = this.item;
          }
          await token.actor.rollToolCheck(tool, checkData);
        } else {
          await token.actor.rollAbilityTest(ability, data);
        }
      }
    }
    async use(config, dialog, message) {
      if (!this.item.isEmbedded) return;
      if (!this.item.isOwner) {
        ui.notifications?.error("DND5E.DocumentUseWarn", { localize: true });
      }
      if (debugEnabled > 0) warn("MidiQOL | CheckActivity | use | Called", config, dialog, message);
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

      setProperty(message, "data.flags.midi-qol.messageType", "check");
      const results = await super.use(config, dialog, message);
      this.workflow.itemCardUuid = results.message.uuid;
      this.workflow.performState(this.workflow.WorkflowState_Start.bind(this.workflow), {});
      return results;
    }

    async rollDamage(config, dialog, message: any = {}) {
      if (debugEnabled > 0)
        warn("CheckActivity | rollDamage | Called", config, dialog, message);
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
      context.onSaveOptions = [
        { value: "none", label: game.i18n.localize("DND5E.SAVE.FIELDS.damage.onSave.None") },
        { value: "half", label: game.i18n.localize("DND5E.SAVE.FIELDS.damage.onSave.Half") },
        { value: "full", label: game.i18n.localize("DND5E.SAVE.FIELDS.damage.onSave.Full") }
      ];
      if (debugEnabled > 0) warn("CheckActivity | _prepareEffectContext | Called", context);
      return context;
    }

    _usageChatButtons(message) {
      const buttons: any[] = [];
      if (this.damage.parts.length) buttons.push({
        label: game.i18n.localize("DND5E.Damage"),
        icon: '<i class="fas fa-burst" inert></i>',
        dataset: {
          action: "rollDamage"
        }
      });
      return buttons.concat(super._usageChatButtons(message));
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

export function defineMidiCheckSheetClass(baseClass: any) {
  return class MidiCheckSheet extends baseClass {
    static PARTS = {
      ...super.PARTS,
      effect: {
        template: "modules/midi-qol/templates/activity/check-effect.hbs",
        templates: [
          ...super.PARTS.effect.templates,
          "systems/dnd5e/templates/activity/parts/save-damage.hbs",
          "systems/dnd5e/templates/activity/parts/damage-part.hbs",
          "systems/dnd5e/templates/activity/parts/damage-parts.hbs",
        ]
      }
    };
    async _prepareContext(options) {
      await this.activity.prepareData({});
      const returnvalue = await super._prepareContext(options);
      return returnvalue;
    }
  }
}
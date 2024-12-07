import { debugEnabled, i18n, warn } from "../../midi-qol.js";
import { ReplaceDefaultActivities, configSettings } from "../settings.js";
import { MidiActivityMixin, MidiActivityMixinSheet } from "./MidiActivityMixin.js";
import { MidiSaveActivity } from "./SaveActivity.js";

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
  MidiCheckActivity = defineMidiCheckActivityClass(CheckActivity);
  if (ReplaceDefaultActivities) {
    // GameSystemConfig.activityTypes["dnd5eAttack"] = GameSystemConfig.activityTypes.attack;
    GameSystemConfig.activityTypes.check = { documentClass: MidiCheckActivity };
  } else {
    GameSystemConfig.activityTypes["midiCheck"] = { documentClass: MidiCheckActivity };
  }
}
function getSceneTargets() {
  if (!canvas?.tokens) return [];
  let targets: Array<any> = canvas?.tokens?.controlled.filter(t => t.actor);
  if (!targets?.length && game.user?.character) targets = game.user?.character.getActiveTokens();
  return targets;
}
let defineMidiCheckActivityClass = (ActivityClass: any) => {
  return class MidiCheckActivity extends MidiActivityMixin(ActivityClass) {
    static LOCALIZATION_PREFIXES = [...super.LOCALIZATION_PREFIXES, "DND5E.SAVE", "DND5E.CHECK", "midi-qol.CHECK"];
    static supermetadata = super.metadata;
    static metadata =
      foundry.utils.mergeObject(
        foundry.utils.mergeObject({}, super.metadata), {
        title: "midi-qol.CHECK.Title.one",
        sheetClass: MidiCheckSheet,
        usage: {
          chatCard: "modules/midi-qol/templates/activity-card.hbs",
          actions: {
            // rollCheck: this.#rollCheck, // CheckActivity.metadata.usage.actions.rollCheck,
            rollDamage: MidiSaveActivity.metadata.usage.actions.rollDamage
          }
        },
      }, { insertKeys: true, invsertValues: true })

    static defineSchema() {
      //@ts-expect-error
      const { StringField, ArrayField, BooleanField, SchemaField, ObjectField } = foundry.data.fields;
      //@ts-expect-error
      const dataModels = game.system.dataModels;
      const { ActivationField: ActivationField, CreatureTypeField, CurrencyTemplate, DamageData,
        DamageField, DurationField, MovementField, RangeField, RollConfigField, SensesField,
        SourceField, TargetField, UsesField } = dataModels.shared

      const schema = {
        ...super.defineSchema(),
        damage: new SchemaField({
          onSave: new StringField({name: "onSave", initial: "half"}),
          parts: new ArrayField(new DamageField())
        }),
      };
      return schema;
    }

    static async #rollCheck(event, target, message) {
      const targets = getSceneTargets();
      if (!targets.length) ui.notifications?.warn("DND5E.ActionWarningNoToken", { localize: true });
      let { ability, dc, skill, tool } = target.dataset;
      dc = parseInt(dc);
      //@ts-expect-error
      let item = this.item;
      //@ts-expect-error
      let check = this.check;
      const data: any = { event, targetValue: Number.isFinite(dc) ? dc : check.dc.value };

      for (const token of targets) {
        data.speaker = ChatMessage.getSpeaker({ scene: canvas?.scene ?? undefined, token: token.document });
        if (skill) {
          await token.actor.rollSkill(skill, { ...data, ability });
        } else if (tool) {
          const checkData = { ...data, ability };
          if ((item.type === "tool") && !check.associated.size) {
            checkData.bonus = item.system.bonus;
            checkData.prof = item.system.prof;
            checkData.item = item;
          }
          await token.actor.rollToolCheck(tool, checkData);
        } else {
          await token.actor.rollAbilityTest(ability, data);
        }
      }
    }
    get isOtherActivityCompatible() { return true }
    async rollDamage(config={}, dialog={}, message={}) {
      message = foundry.utils.mergeObject({
        "data.flags.dnd5e.roll": {
          damageOnSave: this.damage.onSave
        }
      }, message);
      return super.rollDamage(config, dialog, message);
    }


    prepareFinalData(rollData) {
      super.prepareFinalData(rollData);
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
  }

}

export function defineMidiCheckSheetClass(baseClass: any) {
    return class MidiCheckSheet extends MidiActivityMixinSheet(baseClass) {

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
    
    async _prepareEffectContext(context) {
      context = await super._prepareEffectContext(context);
      context.onSaveOptions = [
        { value: "none", label: game.i18n.localize("DND5E.SAVE.FIELDS.damage.onSave.None") },
        { value: "half", label: game.i18n.localize("DND5E.SAVE.FIELDS.damage.onSave.Half") },
        { value: "full", label: game.i18n.localize("DND5E.SAVE.FIELDS.damage.onSave.Full") }
      ];
      return context;
    }
  }
}
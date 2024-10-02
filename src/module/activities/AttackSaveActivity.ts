import { GameSystemConfig, i18n } from "../../midi-qol.js";
import { MidiAttackActivity, MidiAttackSheet } from "./AttackActivity.js";


export function setupAttackSaveActivity() {
  //@ts-expect-error
  const GameSystemConfig = game.system.config;
  // MidiAttackSaveSheet = defineMidiAttackSaveActivitySheetClass(dnd5e.applications.activity.ActivitySheet);
  // MidiAttackSaveActivity = defineMidiAttackSaveActivityClass(AttackSaveActivityData);
  GameSystemConfig.activityTypes["midiAttackSave"] = { documentClass: MidiAttackSaveActivity };
  //@ ts-expect-error
  // game.system.documents["AttackSave"] = MidiAttackSaveActivity;
}

//@ts-expect-error
const { BooleanField, SchemaField, StringField, NumberField, ArrayField } = foundry.data.fields;
//@ts-expect-error
const DataModels = dnd5e.dataModels;
const FormulaField = DataModels.fields.FormulaField
export class AttackSaveActivityData extends DataModels.activity.BaseActivityData {
  static defineSchema() {
    return {
      ...super.defineSchema(),
      attack: new SchemaField({
        ability: new StringField(),
        bonus: new FormulaField(),
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
      damage: new SchemaField({
        critical: new SchemaField({
          bonus: new FormulaField()
        }),
        includeBase: new BooleanField({ initial: true }),
        parts: new ArrayField(new DataModels.shared.DamageField())
      }),
      save: new SchemaField({
        ability: new StringField({ initial: () => Object.keys(GameSystemConfig.abilities)[0] }),
        dc: new SchemaField({
          calculation: new StringField({ initial: "initial" }),
          formula: new FormulaField({ deterministic: true })
        })
      }),
      saveDamage: new SchemaField({
        onSave: new StringField(),
        parts: new ArrayField(new DataModels.shared.DamageField())
      }),
      effects: new ArrayField(new DataModels.activity.AppliedEffectField({
        onSave: new BooleanField()
      })),
    };
  }
}
//@ts-expect-error
const ActivitySheet = dnd5e.applications.activity.ActivitySheet;
export class MidiAttackSaveSheet extends ActivitySheet {
  static DEFAULT_OPTIONS = {
    classes: ["attack-activity", "save-activity"],
    actions: {
      addSaveDamagePart: MidiAttackSaveSheet.#addSaveDamagePart,
      deleteSaveDamagePart: MidiAttackSaveSheet.#deleteSaveDamagePart,
    }
  };
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
      template: "modules/midi-qol/templates/activity/attackSave-effect.hbs",
      templates: [
        ...super.PARTS.effect.templates,
        "systems/dnd5e/templates/activity/parts/attack-damage.hbs",
        "modules/midi-qol/templates/activity/parts/attack-details.hbs",
        "systems/dnd5e/templates/activity/parts/damage-part.hbs",
        "systems/dnd5e/templates/activity/parts/damage-parts.hbs",
        "systems/dnd5e/templates/activity/parts/save-details.hbs",
        "modules/midi-qol/templates/activity/parts/attackSave-damage.hbs",
        "modules/midi-qol/templates/activity/parts/saveDamage-parts.hbs",
      ]
    }
  }

  static #addSaveDamagePart(event, target) {
    //@ts-expect-error
    const activity = this.activity;
    if ( !activity.damage?.parts ) return;
    activity.update({ "saveDamage.parts": [...activity.toObject().damage.parts, {}] });
  }

  static #deleteSaveDamagePart(event, target) {
    //@ts-expect-error
    const activity = this.activity;
    if ( !activity.damage?.parts ) return;
    const parts = activity.toObject().damage.parts;
    parts.splice(target.closest("[data-index]").dataset.index, 1);
    activity.update({ "saveDamage.parts": parts });
  }
  _prepareDamagePartContext(context, part) {
    return part;
  }

  async _prepareEffectContext(context) {
    context = await super._prepareEffectContext(context);
    //@ts-expect-error
    const activity = this.activity;
    console.error(context);
    context.abilityOptions = Object.entries(GameSystemConfig.abilities).map(([value, config]) => ({
      //@ts-expect-error
      value, label: config.label
    }));
    context.calculationOptions = [
      { value: "", label: game.i18n.localize("DND5E.SAVE.FIELDS.save.dc.CustomFormula") },
      { rule: true },
      { value: "spellcasting", label: game.i18n.localize("DND5E.SpellAbility") },
      ...Object.entries(GameSystemConfig.abilities).map(([value, config]) => ({
        //@ts-expect-error
        value, label: config.label, group: game.i18n.localize("DND5E.Abilities")
      }))
    ];
    context.onSaveOptions = [
      { value: "none", label: game.i18n.localize("DND5E.SAVE.FIELDS.damage.onSave.None") },
      { value: "half", label: game.i18n.localize("DND5E.SAVE.FIELDS.damage.onSave.Half") },
      { value: "full", label: game.i18n.localize("DND5E.SAVE.FIELDS.damage.onSave.Full") }
    ];
    //@ts-expect-error
    context.hasBaseDamage = this.item.system.offersBaseDamage;

    if (context.activity.saveDamage?.parts) {
      const scalingOptions = [
        { value: "", label: game.i18n.localize("DND5E.DAMAGE.Scaling.None") },
        //@ts-expect-error
        ...Object.entries(GameSystemConfig.damageScalingModes).map(([value, config]) => ({ value, label: config.label }))
      ];
      let indexOffset = 0;
      context.saveDamageParts = context.activity.saveDamage.parts.map((data, index) => {
        if (data.base) indexOffset--;
        const part = {
          data,
          fields: activity.schema.fields.saveDamage.fields.parts.element.fields,
          prefix: `saveDamage.parts.${index + indexOffset}.`,
          source: context.source.saveDamage.parts[index + indexOffset] ?? data,
          canScale: activity.canScaleDamage,
          scalingOptions,
          //@ts-expect-error
          typeOptions: Object.entries(CONFIG.DND5E.damageTypes).map(([value, config]) => ({
            //@ts-expect-error
            value, label: config.label, selected: data.types.has(value)
          }))
        };
        return this._prepareDamagePartContext(context, part);
      });
    }

    return context;
  }

  async _prepareIdentityContext(context) {
    context = await super._prepareIdentityContext(context);
    console.error(context);
    return context;
  }
}
//@ts-expect-error
const ActivityMixin = dnd5e.documents.activity.ActivityMixin;
export class MidiAttackSaveActivity extends ActivityMixin(AttackSaveActivityData) {
  static LOCALIZATION_PREFIXES = [...super.LOCALIZATION_PREFIXES, "DND5E.ATTACK", "DND5E.SAVE"];
  static metadata =
    foundry.utils.mergeObject(super.metadata, {
      sheetClass: MidiAttackSaveSheet,
      type: "attack",
      img: "systems/dnd5e/icons/svg/activity/attack.svg",
      title: "midi.AttackSaveActivity",
      usage: {
        chatCard: "modules/midi-qol/templates/activity-card.hbs",
        actions: {
          rollAttack: MidiAttackSaveActivity.#rollAttack,
          rollDamage: MidiAttackSaveActivity.#rollDamage
        }
      },
    }, { inplace: false });

  static #rollAttack(event, target, message) {
    //@ts-expect-error
    this.rollAttack({ event });
  }

  static #rollDamage(event, target, message) {
    //@ts-expect-error
    this.#rollDamage({ event });
    return;
  }

  async rollAttack({ event }) {
    return;
  }
  async rollDamage({ event }) {
    return;
  }

  static defineSchema() {
    //@ts-expect-error
    const { BooleanField, SchemaField, StringField } = foundry.data.fields;

    //@ts-expect-error
    const DataModels = game.system.dataModels;
    const FormulaField = DataModels.fields.FormulaField
    //@ts-expect-error
    const gsc = game.system.config;
    return {
      ...super.defineSchema(),
      saveDamage: new SchemaField({
        critical: new SchemaField({
          bonus: new FormulaField()
        }),
        onSave: new StringField(),
        includeBase: new BooleanField({ initial: false }),
        parts: new ArrayField(new DataModels.shared.DamageField()),
      }),
      save: new SchemaField({
        ability: new StringField({ initia: () => Object.keys(gsc.abilities)[0] }),
        dc: new SchemaField({
          calculation: new StringField({ initial: "initial" }),
          formula: new FormulaField({ deterministic: true, initial: "8 + @mod + @prof" })
        })
      })
    }
  }
}

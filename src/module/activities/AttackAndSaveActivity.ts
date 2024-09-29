import { ArrayField, SchemaField, StringField, i18n } from "../../midi-qol.js";
import { MidiAttackActivity, MidiAttackSheet } from "./AttackActivity.js";

export var MidiAttackAndSaveActivity;
export var MidiAttackAndSaveSheet;

export function setupAttackAndSaveActivity() {
  //@ts-expect-error
  const GameSystemConfig = game.system.config;
  MidiAttackAndSaveSheet = defineMidiAttackAndSaveActivitySheetClass(MidiAttackSheet);
  MidiAttackAndSaveActivity = defineMidiAttackAndSaveActivityClass(MidiAttackActivity);
  GameSystemConfig.activityTypes["midiAttackAndSave"] = {documentClass: MidiAttackAndSaveActivity};
  //@ ts-expect-error
  // game.system.documents["AttackAndSave"] = MidiAttackAndSaveActivity;
}

export function defineMidiAttackAndSaveActivitySheetClass(baseClass: any) {
  return class MidiAttackAndSaveSheet extends baseClass {
    static PARTS = {
      ...super.PARTS,
      effect: {
        template: "modules/midi-qol/templates/activity/attackAndSave-effect.hbs",
        templates: [
          ...super.PARTS.effect.templates,
/*
          "systems/dnd5e/templates/activity/parts/attack-damage.hbs",
          "systems/dnd5e/templates/activity/parts/attack-details.hbs",
          "systems/dnd5e/templates/activity/parts/damage-part.hbs",
          "systems/dnd5e/templates/activity/parts/damage-parts.hbs",
*/
          "systems/dnd5e/templates/activity/parts/save-details.hbs",
          "systems/dnd5e/templates/activity/parts/save-damage.hbs",
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
}

export function defineMidiAttackAndSaveActivityClass(baseClass: any) {
  return class MidiAttackAndSaveActivity extends baseClass {
    static metadata =
      foundry.utils.mergeObject(
        foundry.utils.mergeObject({}, super.metadata), {
        sheetClass: MidiAttackAndSaveSheet,
        title: i18n("midi.AttackAndSaveActivity"),
        usage: {
          chatCard: "modules/midi-qol/templates/activity-card.hbs",
        },
      })
    static defineSchema() {
      //@ts-expect-error
      const DataModels = game.system.dataModels;
      const FormulaField = DataModels.fields.FormulaField
      //@ts-expect-error
      const gsc = game.system.config;
      return {
        ...super.defineSchema(),
        saveDamage: new SchemaField({ 
          onSave: new StringField(), 
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
}
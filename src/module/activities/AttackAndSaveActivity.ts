import { ArrayField, SchemaField, StringField, i18n } from "../../midi-qol.js";
import { MidiAttackActivity, MidiAttackSheet } from "./AttackActivity.js";

export var MidiAttackAndSaveActivity;
export var MidiAttackAndSaveSheet;

export function setupAttackAndSaveActivity() {
  //@ts-expect-error
  const GameSystemConfig = game.system.config;
  MidiAttackAndSaveSheet = defineMidiAttackAndSaveActivitySheetClass(MidiAttackSheet);
  MidiAttackAndSaveActivity = defineMidiAttackAndSaveActivityClass(MidiAttackActivity);
  GameSystemConfig.activityTypes["midiAttackAndSave"] = { documentClass: MidiAttackAndSaveActivity };
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
          "systems/dnd5e/templates/activity/parts/attack-damage.hbs",
          "modules/midi-qol/templates/activity/parts/attack-details.hbs",
          // "systems/dnd5e/templates/activity/parts/attack-details.hbs",
          "systems/dnd5e/templates/activity/parts/damage-part.hbs",
          "systems/dnd5e/templates/activity/parts/damage-parts.hbs",
        ]
      }
    }

    async _prepareEffectContext(context) {
      context = await super._prepareEffectContext(context);
      context.saveActivityOptions = this.item.system.activities.filter(a =>
        a.save).reduce((ret, a) => { ret.push({ label: `${a.name}`, value: a.uuid }); return ret }, [{ label: "", value: "" }]);
      context.otherActivityOptions = this.item.system.activities.filter(a =>
        a.damage).reduce((ret, a) => { ret.push({ label: `${a.name}`, value: a.uuid }); return ret }, [{ label: "", value: "" }]);

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
        title: "midi.AttackAndSaveActivity",
        usage: {
          chatCard: "modules/midi-qol/templates/activity-card.hbs",
        },
      })
    static defineSchema() {
      //@ts-expect-error
      const { BooleanField, SchemaField, StringField, DocumentIdField } = foundry.data.fields;

      //@ts-expect-error
      const DataModels = game.system.dataModels;
      const FormulaField = DataModels.fields.FormulaField
      //@ts-expect-error
      const gsc = game.system.config;
      return {
        ...super.defineSchema(),
        saveActivityUuid: new StringField(),
        otherActivityUuid: new StringField()
      }
    }
    get saveActivity() {
      if (!this.saveActivityUuid || this.saveActivityUuid === "") return undefined;
      //@ts-expect-error
      return fromUuidSync(this.saveActivityUuid)
    }

    get otherActivity() {
      if (! this.otherActivityUuid || this.otherActivityUuid === "") {
        //@ts-expect-error
        const saveActivity = fromUuidSync(this.saveActivityUuid);
        if (!saveActivity || !saveActivity.damage) return undefined;
        return saveActivity;
      }
      //@ts-expect-error
      return fromUuidSync(this.otherActivityUuid)
    }
  }
}
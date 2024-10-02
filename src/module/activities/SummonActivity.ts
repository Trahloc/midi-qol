import { debugEnabled, i18n, warn } from "../../midi-qol.js";
import { Workflow } from "../Workflow.js";
import { configSettings } from "../settings.js";
import { asyncHooksCall } from "../utils.js";
import { configureDamageRoll, confirmCanProceed, confirmTargets, confirmWorkflow, midiUsageChatContext, postProcessDamageRoll, setupTargets } from "./activityHelpers.js";

export var MidiSummonActivity;

export function setupSummonActivity() {
  if (debugEnabled > 0) warn("MidiQOL | SummonActivity | setupSummonActivity | Called");
  //@ts-expect-error
  const GameSystemConfig = game.system.config;
  MidiSummonActivity = defineMidiSummonActivityClass(GameSystemConfig.activityTypes.summon.documentClass);
  if (configSettings.replaceDefaultActivities) {
    GameSystemConfig.activityTypes["dnd5eSummon"] = GameSystemConfig.activityTypes.summon;
    GameSystemConfig.activityTypes.summon = { documentClass: MidiSummonActivity };
  } else {
    GameSystemConfig.activityTypes["midiSummon"] = { documentClass: MidiSummonActivity };
  }
}

export function defineMidiSummonActivityClass(baseClass: any) {
  return class MidiSummonActivity extends baseClass {
    targetsToUse: Set<Token>;
    _activityWorkflow: Workflow;
    get activityWorkflow() { return this._activityWorkflow; }
    set activityWorkflow(value) { this._activityWorkflow = value; }
    static metadata =
      foundry.utils.mergeObject(
        foundry.utils.mergeObject({}, super.metadata), {
        title: "midi-qol.Summon.Title.one",
        usage: {
          chatCard: "modules/midi-qol/templates/activity-card.hbs",
        },
      }, {})

    async use(config, dialog, message) {
      if (!this.item.isEmbedded) return;
      if (!this.item.isOwner) {
        ui.notifications?.error("DND5E.DocumentUseWarn", { localize: true });
      }
      if (debugEnabled > 0) warn("MidiQOL | SummonActivity | use | Called", config, dialog, message);
      if (config.systemCard) return super.use(config, dialog, message);
      let previousWorkflow = Workflow.getWorkflow(this.uuid);
      if (previousWorkflow) {
        if (!(await confirmWorkflow(previousWorkflow))) return;
      }

      // come back and see about re-rolling etc.
      this.activityWorkflow = new Workflow(this.item.actor, this, ChatMessage.getSpeaker({ actor: this.item.actor }), this.targets, {});

      setProperty(message, "data.flags.midi-qol.messageType", "summon");
      const results = await super.use(config, dialog, message);
      this.activityWorkflow.itemCardUuid = results.message.uuid;
      await baseClass.metadata.usage.actions.placeSummons.call(this);
      this.activityWorkflow.performState(this.activityWorkflow.WorkflowState_Start, {});
      return results;
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

    async _usageChatContext(message) {
      const context = await super._usageChatContext(message);
      return midiUsageChatContext(this, context);
    }

    get summonActivity() {
      return undefined;
    }
  }

}
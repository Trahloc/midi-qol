import { debugEnabled, warn, i18n, SystemString } from "../../midi-qol.js";
import { ActivityWorkflow } from "../ActivityWorkflow.js";
import { configSettings } from "../settings.js";
import { CERemoveEffect, getAutoRollAttack, getAutoRollDamage, getFlankingEffect, getRemoveAttackButtons, getRemoveDamageButtons, hasDAE, itemHasDamage, itemIsVersatile, tokenForActor } from "../utils.js";

export function defineMidiAttackActivityClass(baseClass: any) {
  return class MidiAttackActivity extends baseClass {
    _activityWorkflow: ActivityWorkflow;
    get activityWorkflow() { return this._activityWorkflow; }
    set activityWorkflow(value) { this._activityWorkflow = value; }
    async rollAttack(config, dialog, message) {
      console.error("MidiQOL | AttackActivity | rollAttack | Called", config, dialog, message);
      return super.rollAttack(config, dialog, message);
    }

    async rollDamage({ event, ammunition, attackMode }) {
      console.error("MidiQOL | AttackActivity | rollDamage | Called", event, ammunition, attackMode);
      return super.rollDamage({ event, ammunition, attackMode });
    }
    static metaData = foundry.utils.mergeObject(super.metadata, {
      usage: { chatCard: "modules/midi-qol/templates/activity-card.hbs" },
    })

    async use(usage, dialog, message) {
      if (!this.item.isEmbedded) return;
      if (!this.item.isOwner) {
        ui.notifications?.error("DND5E.DocumentUseWarn", { localize: true });
      }
      let previousWorkflow = ActivityWorkflow.getWorkflow(this.uuid);
      if (previousWorkflow) {
        if (!(await confirmWorkflow(previousWorkflow))) return;
      }
      removeFlanking(this.item.parent)
      if (!confirmCanProceed(this)) return;
      confirmTargets(this);
      console.error("MidiQOL | AttackActivity | use | Called", usage, dialog, message);
      if (!this.activityWorkflow) {
        this.activityWorkflow = new ActivityWorkflow(this.item.actor, this, ChatMessage.getSpeaker({ actor: this.item.actor }), this.targets, {});
      }
      return super.use(usage, dialog, message);
    }

    async _usageContext(message) {
      const context = await super._usageContext(message);
      let systemCard = false;
      const minimalCard = false;
      const createMessage = true;

      if (systemCard === undefined) systemCard = false;
      if (debugEnabled > 0) warn("show item card ", this, this.actor, this.actor.token, systemCard, this.activityWorkflow);
      let token = tokenForActor(this.item.actor);
      let needAttackButton = !getRemoveAttackButtons(this.item) || configSettings.mergeCardMulti || configSettings.confirmAttackDamage !== "none" ||
        (!this.activityWorkflow?.someAutoRollEventKeySet() && !getAutoRollAttack(this.activityWorkflow) && !this.activityWorkflow?.rollOptions.autoRollAttack);
      const needDamagebutton = itemHasDamage(this) && (
        (["none", "saveOnly"].includes(getAutoRollDamage(this.activityWorkflow)) || this.activityWorkflow?.rollOptions?.rollToggle)
        || configSettings.confirmAttackDamage !== "none"
        || !getRemoveDamageButtons(this.item)
        || systemCard
        || configSettings.mergeCardMulti);
      const needVersatileButton = itemIsVersatile(this) && (systemCard || ["none", "saveOnly"].includes(getAutoRollDamage(this.activityWorkflow)) || !getRemoveDamageButtons(this.item));
      // not used const sceneId = token?.scene && token.scene.id || canvas?.scene?.id;
      const isPlayerOwned = this.actor.hasPlayerOwner;
      const hideItemDetails = (["none", "cardOnly"].includes(configSettings.showItemDetails) || (configSettings.showItemDetails === "pc" && !isPlayerOwned))
        || !configSettings.itemTypeList?.includes(this.type);
      const hasEffects = !["applyNoButton", "applyRemove"].includes(configSettings.autoItemEffects) && hasDAE(this.activityWorkflow) && this.activityWorkflow.workflowType === "BaseWorkflow" && this.effects.find(ae => !ae.transfer && !foundry.utils.getProperty(ae, "flags.dae.dontApply"));
      let dmgBtnText = (this.system?.actionType === "heal") ? i18n(`${SystemString}.Healing`) : i18n(`${SystemString}.Damage`);
      if (this.activityWorkflow?.rollOptions.fastForwardDamage && configSettings.showFastForward) dmgBtnText += ` ${i18n("midi-qol.fastForward")}`;
      let versaBtnText = i18n(`${SystemString}.Versatile`);
      if (this.activityWorkflow?.rollOptions.fastForwardDamage && configSettings.showFastForward) versaBtnText += ` ${i18n("midi-qol.fastForward")}`;

      return foundry.utils.mergeObject(context, {
        actor: this.actor,
        token: this.item.actor?.token,
        // tokenId: token?.document?.uuid ?? token?.uuid ?? null, // v10 change tokenId is a token Uuid
        // tokenUuid: token?.document?.uuid ?? token?.uuid ?? null,
        hasButtons: true,
        data: await this.item.system.getCardData(),
        labels: this.labels,
        //@ts-expect-error
        config: game.system.config,
        condensed: configSettings.mergeCardCondensed,
        hasAttack: !minimalCard && (systemCard || needAttackButton || configSettings.confirmAttackDamage !== "none"),
        isHealing: !minimalCard && this.item.isHealing && (systemCard || configSettings.autoRollDamage !== "always"),
        hasDamage: needDamagebutton,
        isVersatile: needVersatileButton,
        isSpell: this.item.type === "spell",
        isPower: this.item.type === "power",
        hasSave: !minimalCard && this.item.hasSave && (systemCard || configSettings.autoCheckSaves === "none"),
        hasAreaTarget: !minimalCard && this.item.hasAreaTarget,
        hasAttackRoll: !minimalCard && this.item.hasAttack,
        configSettings,
        hideItemDetails,
        dmgBtnText,
        versaBtnText,
        showProperties: this.activityWorkflow?.workflowType === "BaseWorkflow",
        hasEffects,
        effects: this.item.effects,
        isMerge: configSettings.mergeCard,
        mergeCardMulti: configSettings.mergeCardMulti && (this.hasAttack || this.hasDamage),
        confirmAttackDamage: configSettings.confirmAttackDamage !== "none" && (this.hasAttack || this.hasDamage),
        RequiredMaterials: i18n(`${SystemString}.RequiredMaterials`),
        Attack: i18n(`${SystemString}.Attack`),
        SavingThrow: i18n(`${SystemString}.SavingThrow`),
        OtherFormula: i18n(`${SystemString}.OtherFormula`),
        PlaceTemplate: i18n(`${SystemString}.PlaceTemplate`),
        Use: i18n(`${SystemString}.Use`),
        canCancel: configSettings.undoWorkflow // TODO enable this when more testing done.
      })
    }
  }
}

export async function confirmWorkflow(existingWorkflow: ActivityWorkflow): Promise<boolean> {
  console.error("MidiQOL | AttackActivity | confirmWorkflow | Called", existingWorkflow);
  const validStates = [existingWorkflow.WorkflowState_Completed, existingWorkflow.WorkflowState_Start, existingWorkflow.WorkflowState_RollFinished]
  if (!(validStates.includes(existingWorkflow.currentAction))) {// && configSettings.confirmAttackDamage !== "none") {
    if (configSettings.autoCompleteWorkflow) {
      existingWorkflow.aborted = true;
      await existingWorkflow.performState(existingWorkflow.WorkflowState_Cleanup);
      await ActivityWorkflow.removeWorkflow(this.uuid);
    } else if (existingWorkflow.currentAction === existingWorkflow.WorkflowState_WaitForDamageRoll && existingWorkflow.hitTargets.size === 0) {
      existingWorkflow.aborted = true;
      await existingWorkflow.performState(existingWorkflow.WorkflowState_Cleanup);
    } else {
      //@ts-expect-error
      switch (await Dialog.wait({
        title: game.i18n.format("midi-qol.WaitingForexistingWorkflow", { name: existingWorkflow.activity.name }),
        default: "cancel",
        content: "Choose what to do with the previous roll",
        rejectClose: false,
        close: () => { return false },
        buttons: {
          complete: { icon: `<i class="fas fa-check"></i>`, label: "Complete previous", callback: () => { return "complete" } },
          discard: { icon: `<i class="fas fa-trash"></i>`, label: "Discard previous", callback: () => { return "discard" } },
          undo: { icon: `<i class="fas fa-undo"></i>`, label: "Undo until previous", callback: () => { return "undo" } },
          cancel: { icon: `<i class="fas fa-times"></i>`, label: "Cancel New", callback: () => { return "cancel" } },
        }
      }, { width: 700 })) {
        case "complete":
          await existingWorkflow.performState(existingWorkflow.WorkflowState_Cleanup);
          await ActivityWorkflow.removeWorkflow(this.uuid);
          break;
        case "discard":
          await existingWorkflow.performState(existingWorkflow.WorkflowState_Abort);
          break;
        case "undo":
          await existingWorkflow.performState(existingWorkflow.WorkflowState_Cancel);
          break;
        case "cancel":
        default:
          return false;
      }
    }
  }
  return true;
}
export async function removeFlanking(actor: Actor): Promise<void> {
  let CEFlanking = getFlankingEffect();
  if (CEFlanking && CEFlanking.name) await CERemoveEffect({ effectName: CEFlanking.name, uuid: actor.uuid });
}
export async function confirmCanProceed(attackActivity: any): Promise<boolean> {
  console.error("MidiQOL | AttackActivity | confirmCanProceed | Called", attackActivity);
  return true;
}

export async function confirmTargets(attackActivity: any): Promise<void> {
  attackActivity.targets = game.user?.targets;
}

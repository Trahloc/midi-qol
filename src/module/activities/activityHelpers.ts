import { MODULE_ID } from "../../midi-qol.js";
import { Workflow } from "../Workflow.js";
import { configSettings } from "../settings.js";
import { getFlankingEffect, CERemoveEffect, sumRolls } from "../utils.js";

export async function confirmWorkflow(existingWorkflow: Workflow): Promise<boolean> {
  const validStates = [existingWorkflow.WorkflowState_Completed, existingWorkflow.WorkflowState_Start, existingWorkflow.WorkflowState_RollFinished]
  if (!(validStates.includes(existingWorkflow.currentAction))) {// && configSettings.confirmAttackDamage !== "none") {
    if (configSettings.autoCompleteWorkflow) {
      existingWorkflow.aborted = true;
      await existingWorkflow.performState(existingWorkflow.WorkflowState_Cleanup);
      await Workflow.removeWorkflow(existingWorkflow.uuid);
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
          await Workflow.removeWorkflow(existingWorkflow.uuid);
          break;
        case "discard":
          await existingWorkflow.performState(existingWorkflow.WorkflowState_Abort);
          Workflow.removeWorkflow(existingWorkflow.uuid);
          break;
        case "undo":
          await existingWorkflow.performState(existingWorkflow.WorkflowState_Cancel);
          Workflow.removeWorkflow(existingWorkflow.id);
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

export function setDamageRollMinTerms(rolls: Array<Roll> | undefined) {
  if (rolls && sumRolls(rolls)) {
    for (let roll of rolls) {
      for (let term of roll.terms) {
        // I don't like the default display and it does not look good for dice so nice - fiddle the results for maximised rolls
        if (term instanceof Die && term.modifiers.includes(`min${term.faces}`)) {
          for (let result of term.results) {
            result.result = term.faces;
          }
        }
      }
    }
  }
}

export async function doActivityReactions(activity, workflow: Workflow) {
  return true;
  const promises: Promise<any>[] = [];
  if (!foundry.utils.getProperty(activity, `flags.${MODULE_ID}.noProvokeReaction`)) {
    for (let targetToken of workflow.targets) {
      promises.push(new Promise(async resolve => {
        //@ts-expect-error targetToken Type
        const result = await doReactions(targetToken, workflow.tokenUuid, null, "reactionpreattack", { item: this, workflow, workflowOptions: foundry.utils.mergeObject(workflow.workflowOptions, { sourceActorUuid: activity.actor?.uuid, sourceItemUuid: this?.uuid }, { inplace: false, overwrite: true }) });
        if (result?.name) {
          //@ts-expect-error
          targetToken.actor?._initialize();
          // targetToken.actor?.prepareData(); // allow for any items applied to the actor - like shield spell
        }
        resolve(result);
      }));
    }
  }
  await Promise.allSettled(promises);
}
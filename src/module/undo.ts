import { EffectChangeData } from "@league-of-foundry-developers/foundry-vtt-types/src/foundry/common/data/data.mjs/effectChangeData";
import { reduceEachTrailingCommentRange } from "typescript";
import { debug, error, log, warn } from "../midi-qol.js";
import { socketlibSocket } from "./GMAction.js";
import { busyWait } from "./tests/setupTest.js";
import { isReactionItem } from "./utils.js";
import { Workflow } from "./workflow.js";

var dae;
Hooks.once("ready", () => {
  dae = globalThis.DAE;
})

let undoDataQueue: any[] = [];
let startedUndoDataQueue: any[] = [];
const MAXUNDO = 20;
interface undoTokenActorEntry {
  actorUuid: string;
  tokenUuid: string | undefined,
  actorData: any;
  tokenData: any;
}
// Called by workflow to start a new undoWorkflow entry
export async function saveUndoData(workflow: Workflow): Promise<boolean> {
  workflow.undoData = {};
  workflow.undoData.uuid = workflow.uuid;
  workflow.undoData.userId = game.user?.id;
  workflow.undoData.itemName = workflow.item?.name;
  workflow.undoData.itemUuid = workflow.item?.uuid;
  workflow.undoData.userName = game.user?.name;
  workflow.undoData.tokendocUuid = workflow.token.uuid ?? workflow.token.document.uuid;
  workflow.undoData.actorUuid = workflow.actor?.uuid;
  workflow.undoData.chatCardUuids = [];
  workflow.undoData.isReaction = workflow.options?.isReaction || isReactionItem(workflow.item);
  workflow.undoData.concentrationData = {};
  if (!await socketlibSocket.executeAsGM("startUndoWorkflow", workflow.undoData)) {
    error("Could not startUndoWorkflow");
    return false;
  }
  return true;
}

// Called to save snapshots of workflow actor/token data
export function startUndoWorkflow(undoData: any): boolean {

  //@ts-expect-error fromUuidSync
  let actor = fromUuidSync(undoData.actorUuid);
  const actorData = actor?.toObject(true);
  //@ts-expect-error fromUuidSync
  const tokenData = actor?.isToken ? actor.token.toObject(true) : fromUuidSync(undoData.tokendocUuid ?? "")?.toObject(true);
  undoData.actorEntry = { actorUuid: undoData.actorUuid, tokenUuid: undoData.tokendocUuid, actorData, tokenData };
  undoData.allTokenIds = new Set();
  undoData.allActorIds = new Set();
  undoData.allActorIds.add(actor.id);
  undoData.allTargets = new Collection; // every token referenced by the workflow
  if (undoData.actorEntry.tokenData) undoData.allTokenIds.add(undoData.actorEntry.tokenData._id);
  const actorConcentrationTargets = getProperty(actor, "flags.midi-qol.concentration-data.targets");
  actorConcentrationTargets?.forEach(({ actorUuid, tokenUuid }) => {
    if (actorUuid === undoData.actorUuid) return;
    //@ts-expect-error fromUuidSync
    const actor = fromUuidSync(actorUuid);
    const targetData = { tokenUuid, actorUuid, actorData: actor.toObject(true), tokenData };
    if (actor.isToken) {
      targetData["tokenData"] = actor.token.toObject(true);
    } else if (tokenUuid) {
      //@ts-expect-error fromUuidSync
      targetData["tokenData"] = fromUuidSync(tokenUuid)?.toObject(true);
    }
    if (actor.id) undoData.allActorIds.add(actor.id);
    if (targetData?.tokenData._id) undoData.allTokenIds.add(tokenData._id);
    if (!undoData.allTargets.get(actorUuid)) undoData.allTargets.set(actorUuid, targetData)
  });
  addQueueEntry(startedUndoDataQueue, undoData);
  return true;
}

export function updateUndoChatCardUuids(data) {
  const currentUndo = undoDataQueue.find(undoEntry => undoEntry.serverTime === data.serverTime && undoEntry.userId === data.userId);
  if (!currentUndo) {
    warn("Could not find existing entry for ", data);
    return;
  }
  currentUndo.chatCardUuids = data.chatCardUuids;
}

// Called after preamblecomplete so save references to all targets
export async function saveTargetsUndoData(workflow: Workflow) {
  workflow.undoData.targets = [];
  workflow.targets.forEach(t => {
    let tokendoc: TokenDocument = (t instanceof TokenDocument) ? t : t.document;
    if (tokendoc.actor?.uuid === workflow.actor.uuid) return;
    workflow.undoData.targets.push({ tokenUuid: tokendoc.uuid, actorUuid: tokendoc.actor?.uuid });
  });
  workflow.undoData.serverTime = game.time.serverTime;
  workflow.undoData.itemCardId = workflow.itemCardId;
  return socketlibSocket.executeAsGM("queueUndoData", workflow.undoData)
}

Hooks.on("createChatMessages", (message, data, options, user) => {
  if ((undoDataQueue ?? []).length < 1) return;
  const currentUndo = undoDataQueue[0];
  const speaker = message.speaker;
  // if (currentUndo.userId !== user) return;
  if (!currentUndo.allTokenIds.has(speaker.token) || !currentUndo.allActorIds.has(speaker.actor)) return;
  currentUndo.chatCardUuids.push(message.uuid);
});

export function showUndoQueue() {
  console.log(undoDataQueue)
}

export function queueUndoData(data: any): boolean {
  let inProgress = startedUndoDataQueue.find(undoData => undoData.userId === data.userId && undoData.uuid === data.uuid);
  if (!inProgress) {
    error("Could not find started undo entry for ", data.userId, data.uuid);
    return false;
  };
  inProgress = mergeObject(inProgress, data, { overwrite: false });
  startedUndoDataQueue = startedUndoDataQueue.filter(undoData => undoData.userId !== data.userId || undoData.itemUuid !== data.itemUuid);


  data.targets.forEach(undoEntry => {
    //@ts-expect-error fromUuidSync
    let tokendoc: TokenDocument = fromUuidSync(undoEntry.tokenUuid);
    undoEntry["tokenData"] = tokendoc?.toObject(true);

    //@ts-expect-error version
    if (isNewerVersion(game.version, "11.0")) {
      undoEntry["actorData"] = tokendoc?.actor?.toObject(true);
    } else {
      //@ts-expect-error actorLink
      if (tokendoc?.actorLink) undoEntry["actorData"] = tokendoc.actor?.toObject(true);
    }
    if (!inProgress.allTargets.get(tokendoc?.actor?.uuid ?? undoEntry.actorUuid))
      inProgress.allTargets.set(tokendoc?.actor?.uuid ?? undoEntry.actorUuid, undoEntry);
    const concentrationTargets = getProperty(tokendoc.actor ?? {}, "flags.midi-qol.concentration-data")?.targets;;
    concentrationTargets?.forEach(({ actorUuid, tokenUuid }) => {
      //@ts-expect-error fromUuidSync
      const actor = fromUuidSync(actorUuid);
      const targetData = { tokenUuid, actorUuid, actorData: actor.toObject(true) };
      if (actor.isToken) {
        targetData["tokenData"] = actor.token.toObject(true);
      } else if (tokenUuid) {
        //@ts-expect-error fromUuidSync
        targetData["tokenData"] = fromUuidSync(tokenUuid)?.toObject(true);
      }
      if (!inProgress.allTargets.get(actorUuid)) inProgress.allTargets.set(actorUuid, targetData)
      if (actor.id) inProgress.allActorIds.add(actor.id);
      //@ts-expect-error _id
      if (targetData?.tokenData?._id) inProgress.allTokenIds.add(targetData.tokenData._id)
    });
  });

  addQueueEntry(undoDataQueue, inProgress);
  log("Undo queue size is ", new TextEncoder().encode(JSON.stringify(inProgress)).length);
  return true;
}

export function addQueueEntry(queue: any[], data: any) {
  // add the item
  let added = false;
  for (let i = 0; i < queue.length; i++) {
    if (data.serverTime > queue[i].serverTime) {
      queue.splice(i, 0, data);
      added = true;
      break;
    }
  }
  if (!added) queue.push(data);
  if (queue.length > MAXUNDO) {
    log("Removed undoEntry due to overflow", queue.pop());
  }
}

export async function undoMostRecentWorkflow() {
  return socketlibSocket.executeAsGM("undoMostRecentWorkflow")
}

export async function _undoMostRecentWorkflow() {
  if (undoDataQueue.length === 0) return false;
  while (undoDataQueue.length > 0) {
    let undoData = undoDataQueue.shift();
    if (undoData.isReaction) await undoWorkflow(undoData);
    else return undoWorkflow(undoData);
  }
  return;
}

export function _removeChatCards(data: { chatCardUuids: string[] }) {
  // TODO see if this might be async and awaited
  if (!data.chatCardUuids) return;
  for (let uuid of data.chatCardUuids) {
    //@ts-expect-error fromUuidSync
    fromUuidSync(uuid)?.delete();
  }
}

export async function _undoEntryChanges(data: any) {
  let { actorChanges, tokenChanges, effectsToRemove, itemsToRemove, actor, tokendoc } = data;
  if (!actor) actor = tokendoc.actor;

  try {
    if (itemsToRemove?.length > 0) {
      const removeItemsFunc = async () => {
        itemsToRemove = itemsToRemove.filter(id => actor.items.some(item => item.id === id));
        if (itemsToRemove?.length > 0) {
          await actor.deleteEmbeddedDocuments("Item", itemsToRemove);
          await busyWait(.1); // Allow some time for the item removal ripples to complete
        }
      }
      if (dae?.actionQueue) await dae.actionQueue.add(removeItemsFunc);
      else await removeItemsFunc();
    }

    if (effectsToRemove?.length > 0) {
      const removeEffectsFunc = async () => {
        if (effectsToRemove?.length) {
          effectsToRemove = effectsToRemove.filter(_id => actor.effects.some(effect => effect._id === _id));
          debug("_undoEntry: removeEffectsFunc: Effects to remove are ", effectsToRemove)
          try {
            if (effectsToRemove.length) {
              await actor.deleteEmbeddedDocuments("ActiveEffect", effectsToRemove, { noConcentrationCheck: true });
              await busyWait(.1);
            }
            debug("undoEntry: removeEffectsFunc: completed")
          } catch (err) { }
        }
      }

      debug("undoEntry: calling removeEffectsFund: using actionQueue ", dae?.actionQueue !== undefined)
      if (dae?.actionQueue) await dae.actionQueue.add(removeEffectsFunc);
      else await removeEffectsFunc();
      debug("_undoEntry: removeEffectsFunc complete")
    }
    let effectsToAdd;
    if (tokendoc?.actor.isToken) { // a token, actor chanages are to tokendoc.actor and included in tokenChanges.actorData
      // in v10 updating the token effects via actorData.effects does not work so need to do this by hand.
      // This causes a problem since the creation of the effect causes duplicates of items from macro.createItem on the actor
      const tokenChangeEffects = tokenChanges?.actorData?.effects;
      if (tokenChangeEffects) delete tokenChanges.actorData.effects;
      // Hack for created items since the effect will be recreated - check for v11
      if (tokenChanges?.actorData?.items) tokenChanges.actorData.items = tokenChanges.actorData.items.filter(itemData => !itemData.flags?.dae?.DAECreated);
      await tokendoc.update(tokenChanges);
      await busyWait(.1);
      effectsToAdd = tokenChangeEffects?.filter(efData => !tokendoc.actor.effects.some(effect => effect._id === efData._id)) ?? [];
      debug("effects to add ", tokendoc.actor.name, effectsToAdd);
      if (effectsToAdd?.length) {
        if (globalThis.DAE) await globalThis.DAE.actionQueue.add(tokendoc.actor.createEmbeddedDocuments.bind(tokendoc.actor), "ActiveEffect", effectsToAdd, { keepId: true });
        else await tokendoc.actor.createEmbeddedDocuments("ActiveEffect", effectsToAdd, { keepId: true });
      }
      debug("finished adding effects", tokendoc.actor.name, effectsToAdd)
    } else {
      //@ts-expect-error isEmpty
      if (tokendoc && !isEmpty(tokenChanges ?? {})) {
        delete tokenChanges.actorData;
        await tokendoc.update(tokenChanges)
      }
      //@ts-expect-error isEmpty
      if (actorChanges && !isEmpty(actorChanges)) {
        return (tokendoc?.actor ?? actor)?.update(actorChanges)
      }
    }
  } catch (err) {
    error(err);
  }
}

export function getRemoveUndoEffects(effectsData, actor): string[] {
  const effectsToRemove = actor.effects.filter(effect => {
    return !effectsData.some(effectData => effect._id === effectData._id);
  }).map(effect => effect._id) ?? [];
  return effectsToRemove;
}

function getRemoveUndoItems(itemsData, actor): string[] {
  const itemsToRemove = actor.items.filter(item => {
    return !itemsData?.some(itemData => item._id === itemData._id);
  }).map(item => item._id);
  return itemsToRemove;
}

function getChanges(newData, savedData): any {
  if (!newData && !savedData) return {};
  const changes = flattenObject(diffObject(newData, savedData));
  const tempChanges = flattenObject(diffObject(savedData, newData));
  const toDelete = {};
  for (let key of Object.keys(tempChanges)) {
    if (!changes[key]) {
      let parts = key.split(".");
      parts[parts.length - 1] = "-=" + parts[parts.length - 1];
      let newKey = parts.join(".");
      toDelete[newKey] = null
    }
  }
  return mergeObject(changes, toDelete);
}
async function undoSingleTokenActor({ tokenUuid, actorUuid, actorData, tokenData }) {
  //@ts-expect-error
  let actor = fromUuidSync(actorUuid ?? "");
  if (actor instanceof TokenDocument) actor = actor.actor;
  //@ts-expect-error fromuuidSync
  const tokendoc = actor?.isToken ? actor.token : fromUuidSync(tokenUuid ?? "");
  if (!actor) return;
  let actorChanges;
  let tokenChanges;
  //@ts-expect-error version
  if (isNewerVersion(game.version, "11.0")) {
    warn("undoSingleActor: starting for ", actor.name);
    const removeItemsFunc = async () => {
      //@ts-expect-error
      let actor = fromUuidSync(actorUuid ?? "");
      const itemsToRemove = getRemoveUndoItems(actorData.items ?? [], actor);
      if (itemsToRemove?.length > 0) await actor.deleteEmbeddedDocuments("Item", itemsToRemove);
      warn("removeItemsFunc: items to remove ", actor.name, itemsToRemove);
      // await busyWait(0.1);
    }
    if (dae.actionQueue) await dae.actionQueue.add(removeItemsFunc)
    else await removeItemsFunc();
    warn("undoSingleTokenActor: removeItemFunc completed")

    warn("undoSingleActor: about to remove effects")
    const removeEffectsFunc = async () => {
      const effectsToRemove = getRemoveUndoEffects(actorData.effects ?? [], actor);
      warn("effectsToRemoveFunc ", effectsToRemove);
      if (effectsToRemove.length > 0) await actor.deleteEmbeddedDocuments("ActiveEffect", effectsToRemove, { noConcentrationCheck: true });
    }
    if (dae?.actionQueue) await dae.actionQueue.add(removeEffectsFunc)
    else await removeEffectsFunc();
    warn("UndoSingleActor: remove effects completed")
    const itemsToAdd = actorData?.items?.filter(itemData => !actor.items.some(item => itemData._id === item.id));
    warn("Items to add ", actor.name, itemsToAdd)
    if (itemsToAdd?.length > 0) {
      if (dae?.actionQueue) await dae.actionQueue.add(actor.createEmbeddedDocuments.bind(actor), "Item", itemsToAdd, { keepId: true });
      else await actor?.createEmbeddedDocuments("Item", itemsToAdd, { keepId: true });
    }
    const effectsToAdd = actorData?.effects?.filter(efData => !actor.effects.some(effect => efData._id === effect.id));
    warn("Effects to add ", actor.name, effectsToAdd);
    if (effectsToAdd?.length > 0) {
      if (dae?.actionQueue) dae.actionQueue.add(actor.createEmbeddedDocuments, "ActiveEffect", "effectsToAdd", { keepId: true })
      await actor.createEmbeddedDocuments("ActiveEffect", effectsToAdd, { keepId: true });
    }
    actorChanges = actorData ? getChanges(actor.toObject(true), actorData) : {};
    warn("Actor data ", actor.name, actorData, actorChanges);
    //@ts-expect-error isEmpty
    if (!isEmpty(actorChanges)) {
      delete actorChanges.items;
      delete actorChanges.effects;
      await actor.update(actorChanges, { noConcentrationCheck: true })
    }
    if (tokendoc) {
      tokenChanges = tokenData ? getChanges(tokendoc.toObject(true), tokenData) : {};
      //@ts-expect-error tokenChanges
      if (!isEmpty(tokenChanges)) {
        delete tokenChanges.delta;
        await tokendoc.update(tokenChanges, { noConcentrationCheck: true })
      }
    }
  } else {
    let itemsToRemove;
    let effectsToRemove;
    if (tokendoc?.isLinked || !actor.isToken) {
      itemsToRemove = getRemoveUndoItems(actorData.items ?? [], actor);
      effectsToRemove = getRemoveUndoEffects(actorData.effects ?? [], actor);
      tokenChanges = tokenData ? getChanges(tokendoc.toObject(true), tokenData) : {};
      actorChanges = getChanges(actor.toObject(true), actorData);
    } else {
      itemsToRemove = getRemoveUndoItems(tokenData.actorData.items ?? [], tokendoc.actor);
      effectsToRemove = getRemoveUndoEffects(tokenData.actorData.effects ?? [], tokendoc.actor);
      tokenChanges = getChanges(tokendoc.toObject(true), tokenData);
    }
    log(`Undoing changes for ${actor.name} Token: ${tokendoc?.name}`, actorChanges, tokenChanges, itemsToRemove, effectsToRemove)
    await _undoEntryChanges({ actor, tokenChanges, actorChanges, effectsToRemove, itemsToRemove, tokendoc });
  }
}

export async function undoWorkflow(undoData: any) {
  log(`Undoing workflow for Player ${undoData.userName} Token: ${undoData.actorEntry.actorData.name} Item: ${undoData.itemName ?? ""}`)
  for (let undoEntry of undoData.allTargets) {
    log("undoing target ", undoEntry.actorData?.name ?? undoEntry.tokenData?.name, undoEntry)
    await undoSingleTokenActor(undoEntry)
  };
  await undoSingleTokenActor(undoData.actorEntry);
  // delete cards...
  if (undoData.itemCardId) await game.messages?.get(undoData.itemCardId)?.delete();
  _removeChatCards({ chatCardUuids: undoData.chatCardUuids });
}
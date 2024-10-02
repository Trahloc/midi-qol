import { debugEnabled, log, error, warn, i18n, SystemString, debug, MODULE_ID, GameSystemConfig } from "../../midi-qol.js";
import { Workflow, DummyWorkflow } from "../Workflow.js";
import { untimedExecuteAsGM } from "../GMAction.js";
import { mapSpeedKeys } from "../MidiKeyManager.js";
import { TroubleShooter } from "../apps/TroubleShooter.js";
import { preTemplateTargets, shouldRollOtherDamage } from "../itemhandling.js";
import { defaultRollOptions } from "../patching.js";
import { checkMechanic, configSettings } from "../settings.js";
import { tokenForActor, getRemoveAttackButtons, getAutoRollAttack, itemHasDamage, getAutoRollDamage, getRemoveDamageButtons, itemIsVersatile, hasDAE, getFlankingEffect, CERemoveEffect, validTargetTokens, asyncHooksCall, getSpeaker, evalActivationCondition, sumRolls, displayDSNForRoll, processDamageRollBonusFlags, getDamageType, activityHasAreaTarget, checkIncapacitated, getStatusName, isInCombat } from "../utils.js";

export async function midiUsageChatContext(activity, context) {
  let systemCard = false;
  const minimalCard = false;
  const createMessage = true;

  if (systemCard === undefined) systemCard = false;
  if (debugEnabled > 0) warn("show item card ", this, activity.actor, activity.actor.token, systemCard, activity.activityWorkflow);
  let token = tokenForActor(activity.item.actor);
  let needAttackButton = !getRemoveAttackButtons(activity.item) || configSettings.mergeCardMulti || configSettings.confirmAttackDamage !== "none" ||
    (!activity.activityWorkflow?.someAutoRollEventKeySet() && !getAutoRollAttack(activity.activityWorkflow) && !activity.activityWorkflow?.midiOptions.autoRollAttack);
  const needDamagebutton = itemHasDamage(activity.item) && (
    (["none", "saveOnly"].includes(getAutoRollDamage(activity.activityWorkflow)) || activity.activityWorkflow?.midiOptions?.rollToggle)
    || configSettings.confirmAttackDamage !== "none"
    || !getRemoveDamageButtons(activity.item)
    || systemCard
    || configSettings.mergeCardMulti);
  const needVersatileButton = itemIsVersatile(activity.item) && (systemCard || ["none", "saveOnly"].includes(getAutoRollDamage(activity.activityWorkflow)) || !getRemoveDamageButtons(activity.item));
  // not used const sceneId = token?.scene && token.scene.id || canvas?.scene?.id;
  const isPlayerOwned = activity.item.actor?.hasPlayerOwner;
  const hideItemDetails = (["none", "cardOnly"].includes(configSettings.showItemDetails) || (configSettings.showItemDetails === "pc" && !isPlayerOwned))
    || !configSettings.itemTypeList?.includes(activity.item.type);
  const hasEffects = !["applyNoButton", "applyRemove"].includes(configSettings.autoItemEffects) && hasDAE(activity.activityWorkflow) && activity.activityWorkflow.workflowType === "BaseWorkflow" && activity.effects.find(ae => !ae.transfer && !foundry.utils.getProperty(ae, "flags.dae.dontApply"));
  let dmgBtnText = (activity.actionType === "heal") ? i18n(`${SystemString}.Healing`) : i18n(`${SystemString}.Damage`);
  if (activity.activityWorkflow?.midiOptions.fastForwardDamage && configSettings.showFastForward) dmgBtnText += ` ${i18n("midi-qol.fastForward")}`;
  let versaBtnText = i18n(`${SystemString}.Versatile`);
  if (activity.activityWorkflow?.midiOptions.fastForwardDamage && configSettings.showFastForward) versaBtnText += ` ${i18n("midi-qol.fastForward")}`;

  let midiContextData = {
    // actor: activity.item.actor,
    // token: activity.item.actor?.token,
    // tokenId: token?.document?.uuid ?? token?.uuid ?? null, // v10 change tokenId is a token Uuid
    // tokenUuid: token?.document?.uuid ?? token?.uuid ?? null,
    hasButtons: true,
    // data: await activity.item.system.getCardData(),
    labels: activity.labels,
    //@ ts-expect-error TODO needed for abilities translation
    // config: game.system.config,
    condensed: configSettings.mergeCardCondensed,
    hasAttack: !minimalCard && (systemCard || needAttackButton || configSettings.confirmAttackDamage !== "none"),
    isHealing: !minimalCard && activity.item.isHealing && (systemCard || configSettings.autoRollDamage !== "always"),
    hasDamage: needDamagebutton,
    isVersatile: needVersatileButton,
    isSpell: activity.item.type === "spell",
    isPower: activity.item.type === "power",
    hasSave: !minimalCard && activity.item.hasSave && (systemCard || configSettings.autoCheckSaves === "none"),
    hasAreaTarget: !minimalCard && activityHasAreaTarget(activity),
    hasAttackRoll: !minimalCard && activity.item.hasAttack,
    configSettings,
    hideItemDetails,
    dmgBtnText,
    versaBtnText,
    showProperties: activity.activityWorkflow?.workflowType === "BaseWorkflow",
    hasEffects,
    effects: activity.item.effects,
    isMerge: true,
    mergeCardMulti: configSettings.mergeCardMulti && (activity.item.hasAttack || activity.item.hasDamage),
    confirmAttackDamage: configSettings.confirmAttackDamage !== "none" && (activity.item.hasAttack || activity.item.hasDamage),
    RequiredMaterials: i18n(`${SystemString}.RequiredMaterials`),
    Attack: i18n(`${SystemString}.Attack`),
    SavingThrow: i18n(`${SystemString}.SavingThrow`),
    OtherFormula: i18n(`${SystemString}.OtherFormula`),
    PlaceTemplate: i18n(`${SystemString}.PlaceTemplate`),
    Use: i18n(`${SystemString}.Use`),
    canCancel: configSettings.undoWorkflow // TODO enable this when more testing done.
  };
  return foundry.utils.mergeObject(context, midiContextData)
}

export async function confirmWorkflow(existingWorkflow: Workflow): Promise<boolean> {
  console.error("MidiQOL | AttackActivity | confirmWorkflow | Called", existingWorkflow);
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
export async function confirmCanProceed(activity: any, config, dialog, message): Promise<boolean> {
  console.error("MidiQOL | confirmCanProceed | Called", activity);
  if (!config.midiOptions.workflowOptions?.allowIncapacitated && checkMechanic("incapacitated")) {
    const condition = checkIncapacitated(activity.actor, true);
    if (condition) {
      ui.notifications?.warn(`${activity.actor.name} is ${getStatusName(condition)} and is incapacitated`)
      return false;
    }
  }
  let isEmanationTargeting = ["radius", "squaredRadius"].includes(activity.target?.template?.type);
  let isAoETargeting = !isEmanationTargeting && activity.target?.template?.type !== "";
  let selfTarget = activity.target?.type === "self";
  const inCombat = isInCombat(activity.actor);
  const requiresTargets = configSettings.requiresTargets === "always" || (configSettings.requiresTargets === "combat" && inCombat);
  let speaker = getSpeaker(activity.actor);

  // Call preTargeting hook/onUse macro. Create a dummy workflow if one does not already exist for the item
  let tempWorkflow = new DummyWorkflow(activity.actor, activity, speaker, game?.user?.targets ?? new Set(), {});
  tempWorkflow.options = config.midiOptions;
  let cancelWorkflow = await asyncHooksCall("midi-qol.preTargeting", tempWorkflow) === false 
    || await asyncHooksCall(`midi-qol.preTargeting.${activity.item.uuid}`, {activity,  item: activity.item }) === false
    || await asyncHooksCall(`midi-qol.preTargeting.${activity.uuid}`, {activity,  item: activity.item }) === false;
  if (configSettings.allowUseMacro) {
    const results = await tempWorkflow.callMacros(this, tempWorkflow.onUseMacros?.getMacros("preTargeting"), "OnUse", "preTargeting");
    cancelWorkflow ||= results.some(i => i === false);
  }
  if (cancelWorkflow) return false;
  isEmanationTargeting = ["radius", "squaredRadius"].includes(activity.target?.template?.type);

  let targetConfirmationHasRun = false; // Work out interaction with attack per target
  if ((!targetConfirmationHasRun && ((activity.target?.type ?? "") !== "") || configSettings.enforceSingleWeaponTarget)) {
    // TODO verify pressed keys below
    if (!(await preTemplateTargets(activity, config.midiOptions, config.midiOptions.pressedKeys)))
      return false;
    if ((activity.targets?.size ?? 0) === 0 && game.user?.targets) activity.targets = game.user?.targets;
  }
  let shouldAllowRoll = !requiresTargets // we don't care about targets
  || (activity.targets.size > 0) // there are some target selected
  || (activity.target?.type ?? "") === "" // no target required
  || selfTarget
  || isAoETargeting // area effect spell and we will auto target
  || isEmanationTargeting // range target and will autotarget
  || (!activity.item.hasAttack && !itemHasDamage(activity) && !activity.hasSave); // does not do anything - need to chck dynamic effects

  return true;
}

export async function confirmTargets(attackActivity: any): Promise<void> {
  attackActivity.targets = game.user?.targets;
}

export async function setupTargets(activity: any, config, dialog, message): Promise<boolean> {
  if (((activity.target?.affects.type ?? "") !== "") || configSettings.enforceSingleWeaponTarget) {
    //    if (!(await preTemplateTargets(this, {options}, pressedKeys)))
    if (!(await preTemplateTargets(activity, { workflowOptions: config.midiOptions }, {})))
      return false;
    // TODO clean this up
    // if ((dialog.targets?.size ?? 0) === 0 && game.user?.targets) dialog.targets = game.user?.targets;
  }
  // Setup targets.
  let selfTarget = activity.target?.type === "self";
  if (!selfTarget) {
    if (dialog.targetsToUse) activity.targets = dialog.targetsToUse;
    else activity.targets = validTargetTokens(game.user?.targets);
  } else {
    foundry.utils.setProperty(dialog, "workflowOptions.targetConfirmation", "none");
    activity.targets = new Set();
  }

  // remove selection of untargetable targets
  if (canvas?.scene) {
    //@ts-expect-error
    const tokensIdsToUse: Array<string> = Array.from(activity.targets).map(t => t.id);
    game.user?.updateTokenTargets(tokensIdsToUse)
  }
  return true;
}

export async function configureAttackRoll(activity, config): Promise<boolean> {
  if (debugEnabled > 0) warn("configureAttackRoll", activity, config);
  if (!activity?.activityWorkflow) return false;
  let workflow: Workflow = activity.activityWorkflow;

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
        const itemCard = await activity.displayCard(foundry.utils.mergeObject(config, { systemCard: false, workflowId: workflow.id, minimalCard: false, createMessage: true }));
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

  await doActivityReactions(activity, workflow);
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
  || await asyncHooksCall(`midi-qol.preAttackRoll.${activity.item.uuid}`, workflow) === false
  || await asyncHooksCall(`midi-qol.preAttackRoll.${activity.uuid}`, workflow) === false) {
    console.warn("midi-qol | attack roll blocked by preAttackRoll hook");
    return false;
  }

  // Active defence resolves by triggering saving throws and returns early
  if (game.user?.isGM && workflow.useActiveDefence) {
    delete config.midiOptions.event; // for dnd 3.0
    // TODO wqorkfout what to do with active defeinse 
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
      speaker: getSpeaker(activity.actor)
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
    config.midiOptions.critical = activity.criticalThreshold;
  if (config.midiOptions.fumble === true || config.midiOptions.fumble === false)
    delete config.midiOptions.fumble;

  config.midiOptions.chatMessage = false;
  // This will have to become an actvitity option
  if (getProperty(activity.item, "flags.midiProperties.offHandWeapon")) config.attackMode = "offHand";  
  if (config.midiOptions.versatile) config.attackMode = "twoHanded";

  delete config.event; // for dnd5e stop the event being passed to the roll or errors will happend
  return true;
}

export function configureDamageRoll(activity, config): void {
  //@ts-expect-error
  const DamageRoll = CONFIG.Dice.DamageRoll;
  try {
    const pressedKeys = globalThis.MidiKeyManager.pressedKeys; // record the key state if needed
    let workflow = activity.activityWorkflow;

    if (workflow && config.midiOptions.systemCard) workflow.systemCard = true;
    if (workflow) {
      if (!workflow.shouldRollDamage) // if we did not auto roll then process any keys
        workflow.rollOptions = foundry.utils.mergeObject(workflow.rollOptions, mapSpeedKeys(pressedKeys, "damage", workflow.rollOptions?.rollToggle), { insertKeys: true, insertValues: true, overwrite: true });
      else
        workflow.rollOptions = foundry.utils.mergeObject(workflow.rollOptions, mapSpeedKeys({}, "damage", workflow.rollOptions?.rollToggle), { insertKeys: true, insertValues: true, overwrite: true });

    }
    //@ts-expect-error
    if (CONFIG.debug.keybindings) {
      log("itemhandling: workflow.rollOptions", workflow?.rollOptions);
      log("item handling newOptions", mapSpeedKeys(globalThis.MidiKeyManager.pressedKeys, "attack", workflow?.midiOptions?.rollToggle));
    }

    if (workflow?.workflowType === "TrapWorkflow") workflow.rollOptions.fastForward = true;

    const midiFlags = workflow.actor.flags[MODULE_ID]
    if (workflow.currentAction !== workflow.WorkflowStaate_WaitForDamageRoll && workflow.noAutoAttack) {
      // TODO NW check this allow damage roll to go ahead if it's an ordinary roll
      workflow.currentAction = workflow.WorkflowState_WaitForDamageRoll;
    }

    if (workflow.currentAction !== workflow.WorkflowState_WaitForDamageRoll) {
      if (workflow.currentAction === workflow.WorkflowState_AwaitTemplate)
        return ui.notifications?.warn(i18n("midi-qol.noTemplateSeen"));
      else if (workflow.currentAction === workflow.WorkflowState_WaitForAttackRoll)
        return ui.notifications?.warn(i18n("midi-qol.noAttackRoll"));
    }

    if (workflow.damageRollCount > 0) { // we are re-rolling the damage. redisplay the item card but remove the damage if the roll was finished
      workflow.displayChatCardWithoutDamageDetail();
    };

    workflow.processDamageEventOptions();

    // Allow overrides form the caller
    if (config.midiOptions.spellLevel) workflow.rollOptions.spellLevel = config.midiOptions.spellLevel;
    if (config.midiOptions.powerLevel) workflow.rollOptions.spellLevel = config.midiOptions.powerLevel;
    if (workflow.isVersatile || config.midiOptions.versatile) workflow.rollOptions.versatile = true;
    if (debugEnabled > 0) warn("rolling damage  ", activity.name, activity);

    if (config.midiOptions?.critical !== undefined) workflow.isCritical = config.midiOptions?.critical;
    config.midiOptions.fastForwardDamage = config.midiOptions.fastForwardDamage ?? workflow.workflowOptions?.fastForwardDamage ?? workflow.rollOptions.fastForwardDamage;

    workflow.damageRollCount += 1;
    let result: Array<Roll>;
    let result2: Array<Roll>;

  } catch (err) {
    console.error(err);
  }
}

export async function postProcessDamageRoll(activity, config, result): Promise<void> {
  let result2: Array<Roll>;
  //@ts-expect-error
  const DamageRoll = CONFIG.Dice.DamageRoll;
  try {
    let workflow: Workflow = activity.activityWorkflow;
    if (foundry.utils.getProperty(activity.actor, `parent.flags.${MODULE_ID}.damage.advantage`)) {
      // TODO see if this is still possible
      // result2 = await wrapped(damageRollData)
    }
    let magicalDamage = workflow.item?.system.properties?.has("mgc") || workflow.item?.flags?.midiProperties?.magicdam;
    magicalDamage = magicalDamage || (configSettings.requireMagical === "off" && activity.attackBonus > 0);
    magicalDamage = magicalDamage || (configSettings.requireMagical === "off" && (activity.attack?.type.classification ?? "none") !== "weapon");
    magicalDamage = magicalDamage || (configSettings.requireMagical === "nonspell" && activity.isSpell);

    if (result?.length > 0) {
      result.forEach(roll => {
        const droll: any = roll;
        if (!droll.options.properties) droll.options.properties = [];
        if (workflow?.item.type === "spell") droll.options.properties.push("spell");
        if (magicalDamage && !droll.options.properties.includes("mgc")) droll.options.properties.push("mgc");
        droll.options.properties.push(activity.actionType)
      })
    }
    //@ts-expect-error .first
    const firstTarget = workflow.hitTargets.first() ?? workflow.targets?.first();
    const firstTargetActor = firstTarget?.actor;
    const targetMaxFlags = foundry.utils.getProperty(firstTargetActor, `flags.${MODULE_ID}.grants.max.damage`) ?? {};
    const maxFlags = foundry.utils.getProperty(workflow, `actor.flags.${MODULE_ID}.max`) ?? {};
    let needsMaxDamage = (maxFlags.damage?.all && await evalActivationCondition(workflow, maxFlags.damage.all, firstTarget, { async: true, errorReturn: false }))
      || (maxFlags.damage && maxFlags.damage[activity.actionType] && await evalActivationCondition(workflow, maxFlags.damage[activity.actionType], firstTarget, { async: true, errorReturn: false }));
    needsMaxDamage = needsMaxDamage || (
      (targetMaxFlags.all && await evalActivationCondition(workflow, targetMaxFlags.all, firstTarget, { async: true, errorReturn: false }))
      || (targetMaxFlags[activity.actionType] && await evalActivationCondition(workflow, targetMaxFlags[activity.actionType], firstTarget, { async: true, errorReturn: false })));
    const targetMinFlags = foundry.utils.getProperty(firstTargetActor, `flags.${MODULE_ID}.grants.min.damage`) ?? {};
    const minFlags = foundry.utils.getProperty(workflow, `actor.flags.${MODULE_ID}.min`) ?? {};
    let needsMinDamage = (minFlags.damage?.all && await evalActivationCondition(workflow, minFlags.damage.all, firstTarget, { async: true, errorReturn: false }))
      || (minFlags?.damage && minFlags.damage[activity.actionType] && await evalActivationCondition(workflow, minFlags.damage[activity.actionType], firstTarget, { async: true, errorReturn: false }));
    needsMinDamage = needsMinDamage || (
      (targetMinFlags.damage && await evalActivationCondition(workflow, targetMinFlags.all, firstTarget, { async: true, errorReturn: false }))
      || (targetMinFlags[activity.actionType] && await evalActivationCondition(workflow, targetMinFlags[activity.actionType], firstTarget, { async: true, errorReturn: false })));
    if (needsMaxDamage && needsMinDamage) {
      needsMaxDamage = false;
      needsMinDamage = false;
    }

    let actionFlavor;
    switch (game.system.id) {
      case "sw5e":
        actionFlavor = game.i18n.localize(activity.actionType === "heal" ? "SW5E.Healing" : "SW5E.DamageRoll");
        break;
      case "n5e":
        actionFlavor = game.i18n.localize(activity.actionType === "heal" ? "N5E.Healing" : "N5E.DamageRoll");
        break;
      case "dnd5e":
      default:
        actionFlavor = game.i18n.localize(activity.actionType === "heal" ? "DND5E.Healing" : "DND5E.DamageRoll");
    }

    const title = `${activity.name} - ${actionFlavor}`;
    const speaker = getSpeaker(activity.actor);
    let flavor = title;
    if (activity.item.labels.damages?.length > 0) {
      flavor = `${title} (${activity.item.labels.damages.map(d => d.damageType)})`;
    }
    let messageData = foundry.utils.mergeObject({
      title,
      flavor,
      speaker,
    }, { "flags.dnd5e.roll": { type: "damage", itemId: activity.item.id, itemUuid: activity.item.uuid } });
    if (game.system.id === "sw5e") foundry.utils.setProperty(messageData, "flags.sw5e.roll", { type: "damage", itemId: activity.item.id, itemUuid: activity.item.uuid })
    if (needsMaxDamage) {
      for (let i = 0; i < result.length; i++) {
        result[i] = await result[i].reroll({ maximize: true });
      }
    } else if (needsMinDamage) {
      for (let i = 0; i < result.length; i++) {
        result[i] = await result[i].reroll({ minimize: true });
      }
    } else if (foundry.utils.getProperty(this, `parent.flags.${MODULE_ID}.damage.reroll-kh`) || foundry.utils.getProperty(this, `parent.flags.${MODULE_ID}.damage.reroll-kl`)) {
      let result2: Roll[] = [];
      for (let i = 0; i < result.length; i++) {
        result2.push(await result[i].reroll({ async: true }));
      }
      if ((foundry.utils.getProperty(this, `parent.flags.${MODULE_ID}.damage.reroll-kh`) && (sumRolls(result2) > sumRolls(result)))
        || (foundry.utils.getProperty(this, `parent.flags.${MODULE_ID}.damage.reroll-kl`) && (sumRolls(result2) < sumRolls(result)))) {
        [result, result2] = [result2, result];
      }
      // display roll not being used.
      if (workflow.workflowOptions?.damageRollDSN !== false) {
        let promises = result2.map(r => displayDSNForRoll(r, "damageRoll"));
        await Promise.all(promises);
      }
      DamageRoll.toMessage(result2, messageData, { rollMode: game.settings.get("core", "rollMode") });
      // await result2.toMessage(messageData, { rollMode: game.settings.get("core", "rollMode") });
    }
    setDamageRollMinTerms(result)

    if (activity.actionType === "heal" && !Object.keys(GameSystemConfig.healingTypes).includes(workflow.defaultDamageType ?? "")) workflow.defaultDamageType = "healing";

    if (false && workflow.workflowOptions?.damageRollDSN !== false) {
      let promises = result.map(r => displayDSNForRoll(r, "damageRoll"));
      await Promise.all(promises);
    }
    result = await processDamageRollBonusFlags.bind(workflow)(result);
    return result;
  } catch (err) {
    const message = `doDamageRoll error for item ${activity?.name} ${activity.uuid}`;
    TroubleShooter.recordError(err, message);
    throw err;
  }
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
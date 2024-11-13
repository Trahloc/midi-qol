import { debug, i18n, error, warn, noDamageSaves, cleanSpellName, MQdefaultDamageType, allAttackTypes, debugEnabled, overTimeEffectsToDelete, geti18nOptions, getStaticID, failedSaveOverTimeEffectsToDelete, GameSystemConfig, systemConcentrationId, MQItemMacroLabel, SystemString, MODULE_ID, midiReactionEffect, midiBonusActionEffect, isdndv4 } from "../midi-qol.js";
import { configSettings, autoRemoveTargets, checkRule, targetConfirmation, criticalDamage, criticalDamageGM, checkMechanic, safeGetGameSetting, DebounceInterval, _debouncedUpdateAction } from "./settings.js";
import { log } from "../midi-qol.js";
import { DummyWorkflow, Workflow } from "./Workflow.js";
import { prepareDamagelistToJSON, socketlibSocket, timedAwaitExecuteAsGM, untimedExecuteAsGM } from "./GMAction.js";
import { dice3dEnabled, installedModules } from "./setupModules.js";
import { concentrationCheckItemDisplayName, midiFlagTypes } from "./Hooks.js";

import { OnUseMacros } from "./apps/Item.js";
import { Options } from "./patching.js";
import { TroubleShooter } from "./apps/TroubleShooter.js";
import { busyWait } from "./tests/setupTest.js";

const defaultTimeout = 30;
export type ReactionItemReference = { itemName: string, itemId: string, actionName: string, img: string, id: string, uuid: string } | String;
//@ts-expect-error
export type ReactionItem = { itemName: string, itemId: string, actionName: string, img: string, id: string, uuid: string, baseItem: Item } | game.system.documents.activity.ActivityMixin;

export function getDamageType(flavorString): string | undefined {
  if (flavorString === '') return "none";
  if (GameSystemConfig.damageTypes[flavorString] !== undefined) {
    return flavorString;
  }
  if (GameSystemConfig.healingTypes[flavorString] !== undefined) {
    return flavorString;
  }
  //@ts-expect-error
  const validDamageTypes = Object.entries(GameSystemConfig.damageTypes).map(e => { e[1] = e[1].label.toLowerCase(); return e }).deepFlatten().concat(Object.entries(GameSystemConfig.healingTypes).deepFlatten());
  //@ts-expect-error
  const validHealingTypes = Object.entries(GameSystemConfig.healingTypes).map(e => { e[1] = e[1].label.toLowerCase(); return e }).deepFlatten();
  const validDamagingTypes = validDamageTypes.concat(validHealingTypes);
  const allDamagingTypeEntries = Object.entries(GameSystemConfig.damageTypes).concat(Object.entries(GameSystemConfig.healingTypes));
  if (validDamagingTypes.includes(flavorString?.toLowerCase()) || validDamageTypes.includes(flavorString)) {
    //@ts-expect-error
    const damageEntry: any = allDamagingTypeEntries?.find(e => e[1].label.toLowerCase() === flavorString.toLowerCase());
    return damageEntry ? damageEntry[0] : flavorString
  }
  return undefined;
}

export function getDamageFlavor(damageType): string | undefined {
  const validDamageTypes = Object.entries(GameSystemConfig.damageTypes).deepFlatten().concat(Object.entries(GameSystemConfig.healingTypes).deepFlatten())
  const allDamageTypeEntries = Object.entries(GameSystemConfig.damageTypes).concat(Object.entries(GameSystemConfig.healingTypes));
  if (validDamageTypes.includes(damageType)) {
    const damageEntry: any = allDamageTypeEntries?.find(e => e[0] === damageType);
    return damageEntry ? damageEntry[1].label : damageType
  }
  return undefined;
}

/**
*  Modifies the provided damageItem! For use during the isDamaged macro passes.
*/
export function modifyDamageBy({ damageItem, value, multiplier = 1, type = "none", reason }): {} {
  //reminder: For use during the isDamaged macro passes ONLY!
  //@ts-expect-error
  if (!damageItem || foundry.utils.isEmpty(damageItem)) return {};
  if (!value) return {};
  const damageModification = { value, active: { multiplier }, type };
  if (!configSettings.useDamageDetail) damageItem.hpDamage += value;
  damageItem.damageDetail.push(damageModification);
  if (reason) damageItem.details.push(reason);
  return damageModification;
}

/**
 *  return a list of {damage: number, type: string} for the roll and the item
 */
export function createDamageDetail({ roll, item, defaultType = MQdefaultDamageType }): { damage: unknown; type: string; }[] {
  let damageParts = {};
  let rolls = roll;
  //@ts-expect-error
  const DamageRoll = CONFIG.Dice.DamageRoll;
  if (rolls instanceof Roll) {
    rolls = [rolls];
  }
  if (item?.system.damage?.parts[0]) {
    defaultType = item.system.damage.parts[0][1]
  }
  rolls = foundry.utils.deepClone(rolls).map(r => {
    if (!r.options.type) r.options.type = defaultType;
    return r;
  })
  //@ts-expect-error
  const aggregatedRolls: CONFIG.Dice.DamageRoll[] = game.system.dice.aggregateDamageRolls(rolls, { respectProperties: true });
  const detail = aggregatedRolls.map(roll => ({ damage: roll.total, value: roll.total, type: roll.options.type, formula: roll.formula, properties: new Set(roll.options.properties ?? []) }));
  return detail;
}

export function createDamageDetailV4({ roll, activity, defaultType = MQdefaultDamageType }): { damage: unknown; type: string; }[] {
  let damageParts = {};
  let rolls = roll;
  //@ts-expect-error
  const DamageRoll = CONFIG.Dice.DamageRoll;
  if (rolls instanceof Roll) {
    rolls = [rolls];
  }
  if (activity?.damage?.parts[0]) {
    defaultType = activity.damage.parts[0].types.first()
  }
  rolls = foundry.utils.deepClone(rolls).map(r => {
    if (!r.options.type) r.options.type = defaultType;
    return r;
  })

  //@ts-expect-error
  const aggregatedRolls: CONFIG.Dice.DamageRoll[] = game.system.dice.aggregateDamageRolls(rolls, { respectProperties: true });
  const detail = aggregatedRolls.map(roll => ({ damage: roll.total, value: roll.total, type: roll.options.type, formula: roll.formula, properties: new Set(roll.options.properties ?? []) }));
  return detail;
}


export function getTokenForActor(actor): Token {
  if (actor.token) return actor.token.object; //actor.token is a token document.
  const token = tokenForActor(actor);
  if (token) return token;
  const tokenData = actor.prototypeToken.toObject();
  tokenData.actorId = actor.id;
  const cls = getDocumentClass("Token");
  //@ts-expect-error
  return new cls(tokenData, { actor });
}

export function getTokenForActorAsSet(actor): Set<Token> {
  const selfTarget = getTokenForActor(actor);
  if (selfTarget) return new Set([selfTarget]);
  return new Set();
}

/** 
 * Work out the appropriate multiplier for DamageTypeString on actor
 * If configSettings.damageImmunities are not being checked always return 1
 * 
 */

export let getTraitMult = (actor, dmgTypeString, item, damageProperties: string[] = []): number => {
  dmgTypeString = getDamageType(dmgTypeString);
  let totalMult = 1;
  if (dmgTypeString.includes("healing") || dmgTypeString.includes("temphp")) totalMult = -1;
  if (dmgTypeString.includes("midi-none")) return 0;
  if (configSettings.damageImmunities === "none") return totalMult;
  let physicalDamageTypes;
  physicalDamageTypes = Object.keys(GameSystemConfig.damageTypes).filter(dt => GameSystemConfig.damageTypes[dt].isPhysical);

  if (dmgTypeString !== "") {
    // if not checking all damage counts as magical
    let magicalDamage = item?.system.properties?.has("mgc") || item?.flags?.midiProperties?.magicdam;
    magicalDamage = magicalDamage || (configSettings.requireMagical === "off" && item?.system.attackBonus > 0);
    magicalDamage = magicalDamage || (configSettings.requireMagical === "off" && item?.type !== "weapon");
    magicalDamage = magicalDamage || (configSettings.requireMagical === "nonspell" && item?.type === "spell");
    magicalDamage = magicalDamage || damageProperties.includes("mgc");
    const silverDamage = item?.system.properties.has("sil") || magicalDamage || damageProperties.includes("sil");
    const adamantineDamage = item?.system.properties?.has("ada") || damageProperties.includes("ada");
    const physicalDamage = physicalDamageTypes.includes(dmgTypeString);

    let traitList = [
      { type: "di", mult: configSettings.damageImmunityMultiplier },
      { type: "dr", mult: configSettings.damageResistanceMultiplier },
      { type: "dv", mult: configSettings.damageVulnerabilityMultiplier }];
    // for sw5e use sdi/sdr/sdv instead of di/dr/dv
    if (game.system.id === "sw5e" && actor.type === "starship" && actor.system.attributes.hp.tenp > 0) {
      traitList = [{ type: "sdi", mult: 0 }, { type: "sdr", mult: configSettings.damageResistanceMultiplier }, { type: "sdv", mult: configSettings.damageVulnerabilityMultiplier }];
    }

    for (let { type, mult } of traitList) {
      let trait = foundry.utils.deepClone(actor.system.traits[type].value);
      // trait = trait.map(dt => dt.toLowerCase());
      let customs: string[] = [];
      if (actor.system.traits[type].custom?.length > 0) {
        customs = actor.system.traits[type].custom.split(";").map(s => s.trim())
      }

      const bypasses = actor.system.traits[type].bypasses ?? new Set();
      const itemProperties = item?.system.properties ?? new Set()
      let bypassTrait = itemProperties.intersection(bypasses).size > 0;
      if (physicalDamage && bypassTrait) continue;
      // process new custom field versions
      if (!["healing", "temphp"].includes(dmgTypeString)) {
        if (customs.includes(dmgTypeString) || trait.has(dmgTypeString)) {
          totalMult = totalMult * mult;
          continue;
        }
        if (!magicalDamage && (trait.has("nonmagic") || customs.includes(GameSystemConfig.damageResistanceTypes?.["nonmagic"]))) {
          totalMult = totalMult * mult;
          continue;
        } else if (!magicalDamage && physicalDamage && (trait.has("physical") || customs.includes(GameSystemConfig.customDamageResistanceTypes?.physical))) {
          totalMult = totalMult * mult;
          continue;
        } else if (magicalDamage && trait.has("magic")) {
          totalMult = totalMult * mult;
          continue;
        }

        else if (item?.type === "spell" && trait.has("spell")) {
          totalMult = totalMult * mult;
          continue;
        } else if (item?.type === "power" && trait.has("power")) {
          totalMult = totalMult * mult;
          continue;
        }
        if (customs.length > 0) {
          if (!magicalDamage && (customs.includes("nonmagic") || customs.includes(GameSystemConfig.customDamageResistanceTypes?.nonmagic))) {
            totalMult = totalMult * mult;
            continue;
          } else if (!magicalDamage && physicalDamage && (customs.includes("physical") || customs.includes(GameSystemConfig.customDamageResistanceTypes?.physical))) {
            totalMult = totalMult * mult;
            continue;
          } else if (magicalDamage && (customs.includes("magic") || customs.includes(GameSystemConfig.customDamageResistanceTypes.magic))) {
            totalMult = totalMult * mult;
            continue;
          } else if (item?.type === "spell" && (customs.includes("spell") || customs.includes(GameSystemConfig.customDamageResistanceTypes.spell))) {
            totalMult = totalMult * mult;
            continue;
          } else if (item?.type === "power" && (customs.includes("power") || customs.includes(GameSystemConfig.customDamageResistanceTypes.power))) {
            totalMult = totalMult * mult;
            continue;
          }
        }

        // Support old style leftover settings
        if (configSettings.damageImmunities === "immunityPhysical") {
          if (!magicalDamage && trait.has("physical"))
            physicalDamageTypes.forEach(dt => trait.add(dt))
          if (!(magicalDamage || silverDamage) && trait.has("silver"))
            physicalDamageTypes.forEach(dt => trait.add(dt))
          if (!(magicalDamage || adamantineDamage) && trait.has("adamant"))
            physicalDamageTypes.forEach(dt => trait.add(dt))
        }

      }
      if (trait.has(dmgTypeString))
        totalMult = totalMult * mult;
    }
  }
  return totalMult;
  // Check the custom immunities
}
export async function applyTokenDamage(damageDetail, totalDamage, theTargets, item, saves,
  options: any = { label: "defaultDamage", existingDamage: [], superSavers: new Set(), semiSuperSavers: new Set(), workflow: undefined, updateOptions: undefined, forceApply: false, noConcentrationCheck: false }): Promise<any[]> {
  let allDamages: any = {};
  damageDetail = damageDetail.map(de => ({ ...de, value: (de.value ?? de.damage) }))
  let workflow: any = options.workflow ?? {};
  if (item && !options.workflow) workflow = Workflow.getWorkflow(item.uuid) ?? {};

  for (let tokenRef of theTargets) {
    const token = getToken(tokenRef);
    const actor = token?.actor
    if (!actor || !token) continue;
    const isHit = true;
    const saved = !!saves?.has(token);
    const superSaver = !!options.superSavers?.has(token);
    const semiSuperSaver = !!options.semiSuperSavers?.has(token);
    let saveMultiplier = 1;
    if (saved) {
      saveMultiplier = getSaveMultiplierForItem(item, "defaultDamage");
    }
    if (superSaver && getSaveMultiplierForItem(item, "defaultDamage") === 0.5) {
      saveMultiplier = saves.has(token) ? 0 : 0.5;
    }
    if (semiSuperSaver && saved) {
      saveMultiplier = 0;
    }

    allDamages[token.document.uuid] = {
      uuid: token.document.uuid,
      damageDetails: { combinedDamage: [] },
      isHit,
      saved,
      superSaver,
      semiSuperSaver,
      critical: false,
      actorId: actor.id,
      actorUuid: actor.uuid,
      totalDamage,
      sceneId: canvas?.scene?.id
    };

    const calcDamageOptions = {
      invertHealing: true,
      multiplier: 1,
      midi: {
        saved,
        itemType: item?.type,
        saveMultiplier,
        isHit: true,
        superSaver,
        semiSuperSaver,
        // tokenUuid: token?.document.uuid,
        sourceActorUuid: actor?.uuid,
        uncannyDodge: foundry.utils.getProperty(actor, `flags.${MODULE_ID}.uncanny-dodge`) && item?.hasAttack,
        // some options for ripper's module
        save: saved,
        targetUuid: token?.document.uuid,
        fumbleSave: false,
        criticalSave: false,
        isCritical: false,
        isFumble: false
      }
    };
    if (configSettings.saveDROrder === "DRSavedr") {
      calcDamageOptions.midi.saveMultiplier = saveMultiplier;
    } else {
      calcDamageOptions.midi.saveMultiplier = 1;
      calcDamageOptions.multiplier = saveMultiplier;
    }
    //@ts-expect-error
    allDamages[token.document.uuid].damageDetails["combinedDamage"] = foundry.utils.deepClone(actor.calculateDamage(damageDetail, calcDamageOptions));
    allDamages[token.document.uuid].damageDetail = allDamages[token.document.uuid].damageDetails["combinedDamage"];
    allDamages[token.document.uuid].calcDamageOptions = calcDamageOptions;
    allDamages[token.document.uuid].rawDamageDetail = damageDetail;
    allDamages[token.document.uuid].damageDetails[`rawcombinedDamage`] = damageDetail;
    setupv3DamageDetails(allDamages, "combinedDamage", token);
  }
  const cardIds: string[] = await timedAwaitExecuteAsGM("createReverseDamageCard", {
    autoApplyDamage: configSettings.autoApplyDamage,
    sender: game.user?.name,
    actorId: workflow.actor?.id,
    charName: workflow.token?.name ?? workflow.actor?.name ?? game?.user?.name,
    damageList: prepareDamagelistToJSON(Object.values(allDamages)),
    chatCardId: workflow.itemCardId,
    chatCardUuid: workflow.itemCardUuid,
    flagTags: workflow.flagTags,
    updateOptions: options.updateOptions,
    forceApply: options.forceApply,
  });
  return cardIds;
}

export interface applyDamageDetails {
  label: string;
  damageDetail: any[];
  damageTotal: number;
  saves?: Set<Token | TokenDocument>;
  superSavers?: Set<Token | TokenDocument>;
  semiSuperSavers?: Set<Token | TokenDocument>;
}

export function setupv3DamageDetails(allDamages, selector, token: Token) {
  const tokenDamage = allDamages[token.document.uuid];
  let { amount, temp } = tokenDamage.damageDetails[selector].reduce((acc, d) => {
    if (d.type === "temphp") acc.temp += d.value;
    else if (d.type !== "midi-none") acc.amount += d.value;
    return acc;
  }, { amount: 0, temp: 0 });
  amount = amount > 0 ? Math.floor(amount) : Math.ceil(amount);
  let totalDamage = tokenDamage.damageDetails[`raw${selector}`].reduce((acc, d) => acc + (["temphp", "midi-none"].includes(d.type) ? 0 : d.value), 0);
  let healingAdjustedTotalDamage = tokenDamage.damageDetails[`raw${selector}`].reduce((acc, d) => acc + (["temphp", "midi-none"].includes(d.type) ? 0 : (d.type === "healing" ? -d.value : d.value)), 0);
  //@ts-expect-error
  const as = token.actor?.system;
  if (!as || !as.attributes.hp) return;
  let effectiveTemp = as.attributes.hp.temp ?? 0;
  tokenDamage.useDamageDetail = configSettings.useDamageDetail;
  tokenDamage.tokenUuid = token.document.uuid;
  tokenDamage.tokenId = token.id;
  tokenDamage.oldHP = as.attributes.hp.value;
  tokenDamage.newHP = as.attributes.hp.value;
  tokenDamage.oldTempHP = as.attributes.hp.temp ?? 0;
  tokenDamage.newTempHP = as.attributes.hp.temp ?? 0;
  const deltaTemp = amount > 0 ? Math.min(effectiveTemp, amount) : 0;
  //@ts-expect-error
  const deltaHP = Math.clamp(amount - deltaTemp, -as.attributes.hp.damage, as.attributes.hp.value);
  tokenDamage.newHP -= deltaHP;
  tokenDamage.hpDamage = deltaHP;
  tokenDamage.newTempHP = Math.floor(Math.max(0, effectiveTemp - deltaTemp, temp));
  // damages.tempDamage = deltaTemp;
  tokenDamage.tempDamage = tokenDamage.oldTempHP - tokenDamage.newTempHP;
  tokenDamage.totalDamage = totalDamage;
  tokenDamage.healingAdjustedTotalDamage = healingAdjustedTotalDamage;
  tokenDamage.details = [];
  tokenDamage.wasHit = tokenDamage.isHit;
}

export async function processDamageRoll(workflow: Workflow, defaultDamageType: string) {
  if (debugEnabled > 0) warn("processDamageRoll |", workflow)
  // proceed if adding chat damage buttons or applying damage for our selves
  let hpDamage: any[] = [];
  const actor = workflow.actor;
  let activity = workflow.activity;
  let item = activity.item;

  // const re = /.*\((.*)\)/;
  // const defaultDamageType = message.flavor && message.flavor.match(re);

  // Show damage buttons if enabled, but only for the applicable user and the GM

  let hitTargets: Set<Token | TokenDocument> = new Set([...workflow.hitTargets, ...workflow.hitTargetsEC]);
  let theTargets = new Set(workflow.targets);
  // TODO becomes activity.target.affects.type === "self"
  if (activity.target.affects.type === "self") theTargets = getTokenForActorAsSet(actor) || theTargets;
  let effectsToExpire: string[] = [];
  if (hitTargets.size > 0 && activity.attack) effectsToExpire.push("1Hit");
  if (hitTargets.size > 0 && activity.damage) effectsToExpire.push("DamageDealt");
  if (effectsToExpire.length > 0) {
    await expireMyEffects.bind(workflow)(effectsToExpire);
  }

  if (debugEnabled > 0) warn("processDamageRoll | damage details pre merge are ", workflow.rawDamageDetail, workflow.rawBonusDamageDetail);
  let totalDamage = 0;

  const baseNoDamage = workflow.rawDamageDetail?.length === 0 || (workflow.rawDamageDetail.length === 1 && workflow?.rawDamageDetail[0] === "midi-none");
  const bonusNoDamage = workflow.rawBonusDamageDetail?.length === 0 || (workflow.rawBonusDamageDetail?.length === 1 && workflow.rawBonusDamageDetail[0] === "midi-none");
  const otherNoDamage = workflow.rawOtherDamageDetail?.length === 0 || (workflow.rawOtherDamageDetail?.length === 1 && workflow.rawOtherDamageDetail[0] === "midi-none");
  if (baseNoDamage && bonusNoDamage && otherNoDamage) return;

  const damagePerToken = {};
  workflow.damageList = [];
  totalDamage = 0;
  totalDamage = workflow.rawDamageDetail?.reduce((acc, di) => acc + (di.type === "temphp" ? 0 : di.value), 0) ?? 0;
  if (workflow.rawOtherDamageDetail) totalDamage += workflow.rawOtherDamageDetail.reduce((acc, di) => acc + (di.type === "temphp" ? 0 : di.value), 0) ?? 0;
  if (workflow.rawBonusDamageDetail) totalDamage += workflow.rawBonusDamageDetail.reduce((acc, di) => acc + (di.type === "temphp" ? 0 : di.value), 0) ?? 0;

  for (let tokenRef of theTargets) {
    const token = getToken(tokenRef);
    const tokenDocument = getTokenDocument(tokenRef);
    if (!token?.actor) continue;
    if (!tokenDocument) continue;
    let challengeModeScale = 1;

    damagePerToken[tokenDocument?.uuid] = {
      targetUuid: getTokenDocument(token)?.uuid,
      damageDetails: { combinedDamage: [], rawcombinedDamage: [], defaultDamage: [], rawdefaultDamage: workflow.rawDamageDetail, otherDamage: [], rawotherDamage: workflow.rawOtherDamageDetail, bonusDamage: [], rawbonusDamage: workflow.rawBonusDamageDetail },
      isHit: hitTargets.has(token),
      saved: workflow.saves.has(token),
      superSaver: workflow.superSavers.has(token),
      semiSuperSaver: workflow.semiSuperSavers.has(token),
      critical: workflow.isCritical,
      actorId: token.actor.id,
      actorUuid: token.actor.uuid,
      totalDamage,
      sceneId: canvas?.scene?.id,
    };
    let calcDamageOptions: any = {};
    if (["scale", "scaleNoAR"].includes(checkRule("challengeModeArmor")) && workflow.attackRoll && workflow.hitTargetsEC?.has(token)) {
      //scale the damage detail for a glancing blow - only for the first damage list? or all?
      const scale = workflow.challengeModeScale[tokenDocument?.uuid ?? "dummy"] ?? 1;
      challengeModeScale = scale;
    }
    damagePerToken[tokenDocument.uuid].challengeModeScale = challengeModeScale;
    if (totalDamage !== 0 && (workflow.hitTargets.has(token) || workflow.hitTargetsEC.has(token) || workflow.hasSave)) {
      const isHealing = ("heal" === workflow.activity.actionType);
      await doReactions(token, workflow.tokenUuid, workflow.damageRolls ?? workflow.bonusDamageRolls ?? workflow.otherDamageRolls, !isHealing ? "reactiondamage" : "reactionheal", { activity: workflow.activity, item: workflow.item, workflow, workflowOptions: { damageDetail: workflow.rawDamageDetail, damageTotal: totalDamage, sourceActorUuid: workflow.actor?.uuid, sourceItemUuid: workflow.item?.uuid, sourceAmmoUuid: workflow.ammo?.uuid } });
    }
    const damageDetails = damagePerToken[tokenDocument.uuid].damageDetails;

    for (let [rolls, type] of [[workflow.damageRolls, "defaultDamage"], [(workflow.otherDamageMatches?.has(token) ?? true) ? workflow.otherDamageRolls : [], "otherDamage"], [workflow.bonusDamageRolls, "bonusDamage"]]) {
      if (rolls?.length > 0 && rolls[0]) {
        //@ts-expect-error
        const damages = game.system.dice.aggregateDamageRolls(rolls, { respectProperties: true }).map(roll => ({
          value: roll.total,
          type: roll.options.type,
          properties: new Set(roll.options.properties ?? [])
        }));
        let activity = workflow.activity;
        let saves: Set<Token | TokenDocument> = new Set();
        if (workflow.activity.save && type !== "otherDamage") {
          activity = workflow.activity
          saves = workflow.saves;
        } else if ((workflow.activity.otherActivity?.save || workflow.activity.otherActivity?.check) && type === "otherDamage") {
          saves = workflow.saves;
          activity = workflow.activity.otherActivity;
        }
        let saveMultiplier = 1;
        if (saves.has(token)) {
          saveMultiplier = getsaveMultiplierForActivity(activity);
        }
        if (workflow.superSavers.has(token) && getsaveMultiplierForActivity(activity) === 0.5) {
          saveMultiplier = saves.has(token) ? 0 : 0.5;
        }
        if (workflow.semiSuperSavers.has(token) && saves.has(token)) {
          saveMultiplier = 0;
        }

        // const allTargetElts = document.querySelectorAll(`[data-message-id="${workflow.chatCard?.id}"]`)?.[0]?.getElementsByTagName("damage-application");
        calcDamageOptions = {
          invertHealing: true,
          multiplier: challengeModeScale,
          midi: {
            saved: saves?.has(token),
            itemType: item.type,
            saveMultiplier,
            isHit: hitTargets.has(token),
            superSaver: workflow.superSavers?.has(token),
            semiSuperSaver: workflow.semiSuperSavers?.has(token),
            // tokenUuid: token?.document.uuid,
            sourceActorUuid: workflow.actor.uuid,
            uncannyDodge: foundry.utils.getProperty(token.actor, `flags.${MODULE_ID}.uncanny-dodge`) && item?.hasAttack,
            applyDamage: true,
            // some options for ripper's modules
            save: workflow.saves.has(token),
            fumbleSave: workflow.fumbleSaves.has(token),
            criticalSave: workflow.criticalSaves.has(token),
            isCritical: workflow.isCritical,
            isFumble: workflow.isFumble,
            superSavers: workflow.superSavers,
            semiSuperSavers: workflow.semiSuperSavers,
            targetUuid: token?.document.uuid,
          }
        };

        // TODO make this a setting in midi-qol targetOptions
        const categories = { "idi": "immunity", "idr": "resistance", "idv": "vulnerability", "ida": "absorption" };
        if (workflow.item) {
          for (let key of ["idi", "idr", "idv", "ida"]) {
            const property = foundry.utils.getProperty(workflow.item, `flags.midiProperties.${key}`);
            if (property) {
              if (!calcDamageOptions.ignore?.[categories[key]]) foundry.utils.setProperty(calcDamageOptions, `ignore.${categories[key]}`, new Set())
              for (let dt of Object.keys(GameSystemConfig.damageTypes)) {
                calcDamageOptions.ignore[categories[key]].add(dt);
              }
            }
          }
        }
        //@ts-expect-error
        let returnDamages = foundry.utils.deepClone(token.actor.calculateDamage(damages, calcDamageOptions));
        if (configSettings.singleConcentrationRoll || type !== "otherDamage") {
          damageDetails[type] = returnDamages;
          damageDetails["combinedDamage"] = damageDetails["combinedDamage"].concat(returnDamages);
          damageDetails[`rawcombinedDamage`] = damageDetails[`rawcombinedDamage`].concat(damages);
          damageDetails[`calcDamageOptions.${type}`] = calcDamageOptions;
          damageDetails["calcDamageOptions.combinedDamage"] = calcDamageOptions;
        } else if (!configSettings.singleConcentrationRoll && type === "otherDamage") {
          damageDetails["otherDamage"] = returnDamages;
          damageDetails[`rawotherDamage`] = damages;
          damageDetails['calcDamageOptions.otherDamage'] = calcDamageOptions;
        }
      }
    }
  }
  workflow.damageList = Object.values(damagePerToken);
  const toCheck = ["combinedDamage"];
  if (!configSettings.singleConcentrationRoll && workflow.otherDamageRolls) toCheck.push("otherDamage");
  let chatCardUuids: string[] = [];
  for (let selector of toCheck) {
    workflow.damageList.forEach(damageEntry => {
      damageEntry.damageDetail = damageEntry.damageDetails[selector];
      damageEntry.rawDamageDetail = damageEntry.damageDetails[`raw${selector}`];
      damageEntry.calcDamageOptions = damageEntry.damageDetails[`calcDamageOptions.${selector}`];
    });

    for (let tokenRef of theTargets) {
      const token = getToken(tokenRef);
      const tokenDocument = getTokenDocument(tokenRef);
      if (!token?.actor) continue;
      if (!tokenDocument) continue;
      const damageDetails = damagePerToken[tokenDocument.uuid];
      setupv3DamageDetails(damagePerToken, selector, token);
      await workflow?.callv3DamageHooks(damageDetails, token);
      damageDetails.damageDetails[selector] = damageDetails.damageDetail;
      // setupv3DamageDetails(allDamages, selector, token);
    }
    const cardIds: string[] = await timedAwaitExecuteAsGM("createReverseDamageCard", {
      autoApplyDamage: configSettings.autoApplyDamage,
      sender: game.user?.name,
      actorId: workflow.actor?.id,
      charName: workflow.token?.name ?? workflow.actor?.name ?? game?.user?.name,
      damageList: prepareDamagelistToJSON(workflow.damageList),
      chatCardId: workflow.itemCardId,
      chatCardUuid: workflow.itemCardUuid,
      flagTags: workflow.flagTags,
      updateOptions: { noConcentrationCheck: workflow?.workflowOptions?.noConcentrationCheck ?? false },
      forceApply: false
    });
    if (cardIds) chatCardUuids.push(...cardIds);
  }

  if (workflow && configSettings.undoWorkflow) {
    // Assumes workflow.undoData.chatCardUuids has been initialised
    if (workflow.undoData) {
      workflow.undoData.chatCardUuids = workflow.undoData.chatCardUuids.concat(chatCardUuids);
      untimedExecuteAsGM("updateUndoChatCardUuids", workflow.undoData);
    }
  }
  if (debugEnabled > 1) debug(`process damage roll complete for ${workflow.item.name} `, workflow.damageList)
}

export function getsaveMultiplierForActivity(activity) {
  if (!activity) {
    error("getSaveMultiplierForActivity called with no activity");
    return 1;
  }
  if (activity?.damage?.onSave === undefined) return 1;
  switch (activity.damage.onSave) {
    case "half":
      return 0.5;
    case "none":
      return 0;
    case "full":
      return 1;
    default:
      return 0.5;
  }
}

export let getSaveMultiplierForItem = (item: Item, itemDamageType) => {
  console.warn("getSaveMultiplierForItem is deprecated, use getsaveMultiplierForActivity instead");
  // find a better way for this ? perhaps item property
  if (!item) return 1;

  // Midi default - base/bonus damage full, other damage half.
  if (["defaultDamage", "bonusDamage"].includes(itemDamageType) && itemOtherFormula(item) !== ""
    && ["default", undefined].includes(foundry.utils.getProperty(item, "flags.midiProperties.saveDamage"))) {
    return 1;
  }

  //@ts-expect-error
  if (item.actor && item.type === "spell" && item.system.level === 0) { // cantrip
    const midiFlags = foundry.utils.getProperty(item.actor ?? {}, `flags.${MODULE_ID}`);
    if (midiFlags?.potentCantrip) return 0.5;
  }
  let itemDamageSave = "fulldam";
  switch (itemDamageType) {

    case "otherDamage":
      itemDamageSave = foundry.utils.getProperty(item, "flags.midiProperties.otherSaveDamage");
      break;
    case "bonusDamage":
      itemDamageSave = foundry.utils.getProperty(item, "flags.midiProperties.bonusSaveDamage");
      break;
    case "defaultDamage":
    default:
      itemDamageSave = foundry.utils.getProperty(item, "flags.midiProperties.saveDamage");
      break;
  }

  //@ts-expect-error item.flags v10
  const midiItemProperties: any = item.flags.midiProperties;
  if (itemDamageSave === "nodam") return 0;
  if (itemDamageSave === "fulldam") return 1;
  if (itemDamageSave === "halfdam") return 0.5;

  if (!configSettings.checkSaveText)
    return configSettings.defaultSaveMult;
  //@ts-expect-error item.system v10
  let description = TextEditor.decodeHTML(item.system?.description.value).toLocaleLowerCase();
  //@ts-expect-error
  if (description.length === 0) description = item.system.description.chat.toLocaleLowerCase();
  let noDamageText = i18n("midi-qol.noDamage").toLocaleLowerCase().trim();
  if (!noDamageText || noDamageText === "") noDamageText = "midi-qol.noDamage";
  let noDamageTextAlt = i18n("midi-qol.noDamageAlt").toLocaleLowerCase().trim();
  if (!noDamageTextAlt || noDamageTextAlt === "") noDamageTextAlt = "midi-qol.noDamageAlt";
  if (description?.includes(noDamageText) || description?.includes(noDamageTextAlt)) {
    return 0.0;
  }

  let fullDamageText = i18n("midi-qol.fullDamage").toLocaleLowerCase().trim();
  if (!fullDamageText || fullDamageText === "") fullDamageText = "midi-qol.fullDamage";
  let fullDamageTextAlt = i18n("midi-qol.fullDamageAlt").toLocaleLowerCase().trim();
  if (!fullDamageTextAlt || fullDamageTextAlt === "") fullDamageText = "midi-qol.fullDamageAlt";
  if (description.includes(fullDamageText) || description.includes(fullDamageTextAlt)) {
    return 1;
  }

  let halfDamageText = i18n("midi-qol.halfDamage").toLocaleLowerCase().trim();
  if (!halfDamageText || halfDamageText === "") halfDamageText = "midi-qol.halfDamage";
  let halfDamageTextAlt = i18n("midi-qol.halfDamageAlt").toLocaleLowerCase().trim();
  if (!halfDamageTextAlt || halfDamageTextAlt === "") halfDamageTextAlt = "midi-qol.halfDamageAlt";
  if (description?.includes(halfDamageText) || description?.includes(halfDamageTextAlt)) {
    return 0.5;
  }
  //@ts-expect-error item.name v10 - allow the default list to be overridden by item settings.
  if (noDamageSaves.includes(cleanSpellName(item.name))) return 0;
  //  Think about this. if (checkSavesText true && item.hasSave) return 0; // A save is specified but the half-damage is not specified.
  return configSettings.defaultSaveMult;
};

export function requestPCSave(ability, rollType, player, actor, { advantage, disadvantage, flavor, dc, requestId, GMprompt, isMagicSave, magicResistance, magicVulnerability, saveItemUuid, isConcentrationCheck }) {
  const useUuid = true; // for  LMRTFY
  const actorId = useUuid ? actor.uuid : actor.id;
  const playerLetme = !player?.isGM && ["letme", "letmeQuery"].includes(configSettings.playerRollSaves);
  const playerLetMeQuery = "letmeQuery" === configSettings.playerRollSaves;
  const gmLetmeQuery = "letmeQuery" === GMprompt;
  const gmLetme = player.isGM && ["letme", "letmeQuery"].includes(GMprompt);
  let rollAdvantage: number = 0;
  try {
    if (player && installedModules.get("lmrtfy") && (playerLetme || gmLetme)) {
      if (((!player.isGM && playerLetMeQuery) || (player.isGM && gmLetmeQuery))) {
        // TODO - reinstated the LMRTFY patch so that the event is properly passed to the roll
        rollAdvantage = 2;
      } else {
        rollAdvantage = (advantage && !disadvantage ? 1 : (!advantage && disadvantage) ? -1 : 0);
      }
      if (isMagicSave) { // rolls done via LMRTFY won't pick up advantage when passed through and we can't pass both advantage and disadvantage
        if (magicResistance && disadvantage) rollAdvantage = 1; // This will make the LMRTFY display wrong
        if (magicVulnerability && advantage) rollAdvantage = -1; // This will make the LMRTFY display wrong
      }
      //@ts-expect-error
      let mode = foundry.utils.isNewerVersion(game.version ?? game.version, "0.9.236") ? "publicroll" : "roll";
      if (configSettings.autoCheckSaves !== "allShow") {
        mode = "blindroll";
      }
      let message = `${configSettings.displaySaveDC ? "DC " + dc : ""} ${i18n("midi-qol.saving-throw")} ${flavor}`;
      if (rollType === "abil")
        message = `${configSettings.displaySaveDC ? "DC " + dc : ""} ${i18n("midi-qol.ability-check")} ${flavor}`;
      if (rollType === "skill")
        message = `${configSettings.displaySaveDC ? "DC " + dc : ""} ${flavor}`;
      // Send a message for LMRTFY to do a save.
      const socketData = {
        user: player.id,
        actors: [actorId],
        abilities: rollType === "abil" ? [ability] : [],
        saves: rollType === "save" ? [ability] : [],
        skills: rollType === "skill" ? [ability] : [],
        advantage: rollAdvantage,
        mode,
        title: i18n("midi-qol.saving-throw"),
        message,
        formula: "",
        attach: { requestId },
        deathsave: false,
        initiative: false,
        isMagicSave,
        saveItemUuid,
        isConcentrationCheck
      }
      if (debugEnabled > 1) debug("process player save ", socketData)
      game.socket?.emit('module.lmrtfy', socketData);
      //@ts-expect-error - global variable
      LMRTFY.onMessage(socketData);
    } else { // display a chat message to the user telling them to save
      const actorName = actor.name;
      let abilityString = GameSystemConfig.abilities[ability];
      if (abilityString.label) abilityString = abilityString.label;
      let content = ` ${actorName} ${configSettings.displaySaveDC ? "DC " + dc : ""} ${abilityString} ${i18n("midi-qol.saving-throw")}`;
      if (advantage && !disadvantage) content = content + ` (${i18n("DND5E.Advantage")}) - ${flavor})`;
      else if (!advantage && disadvantage) content = content + ` (${i18n("DND5E.Disadvantage")}) - ${flavor})`;
      else content + ` - ${flavor})`;
      const chatData = {
        content,
        whisper: [player]
      }
      // think about how to do this if (workflow?.flagTags) chatData.flags = foundry.utils.mergeObject(chatData.flags ?? "", workflow.flagTags);
      ChatMessage.create(chatData);
    }
  } catch (err) {
    const message = `midi-qol | request PC save`;
    TroubleShooter.recordError(err, message);
    error(message, err);
  }
}

export function requestPCActiveDefence(player, actor, advantage, saveItemName, rollDC, formula, requestId, options?: { workflow: Workflow }) {
  const useUuid = true; // for  LMRTFY
  const actorId = useUuid ? actor.uuid : actor.id;
  if (!player.isGM && false) {
    // TODO - reinstated the LMRTFY patch so that the event is properly passed to the roll
    advantage = 2;
  } else {
    advantage = (advantage === true ? 1 : advantage === false ? -1 : 0);
  }
  let mode = checkRule("activeDefenceShow") ?? "selfroll";
  let message = `${saveItemName} ${configSettings.hideRollDetails === "none" ? "DC " + rollDC : ""} ${i18n("midi-qol.ActiveDefenceString")}`;
  if (installedModules.get("lmrtfy")) {
    // Send a message for LMRTFY to do a save.
    const socketData = {
      "abilities": [],
      "saves": [],
      "skills": [],
      mode,
      "title": i18n("midi-qol.ActiveDefenceString"),
      message,
      "tables": [],
      user: player.id,
      actors: [actorId],
      advantage,
      formula,
      attach: { requestId, mode },
      deathsave: false,
      initiative: false
    };
    if (debugEnabled > 1) debug("process player save ", socketData)
    game.socket?.emit('module.lmrtfy', socketData);
    // LMRTFY does not emit to self so in case it needs to be handled by the local client pretend we received it.
    //@ts-expect-error - LMRTFY
    LMRTFY.onMessage(socketData);
  } else if (options?.workflow) { //prompt for a normal roll.
    const rollOptions: any = { advantage, midiType: "defenceRoll", flavor: message };
    if (configSettings.autoCheckHit === "all") rollOptions.targetValue = rollDC;
    socketlibSocket.executeAsUser("D20Roll", player.id, { targetUuid: actor.uuid, formula, request: message, rollMode: mode, options: rollOptions, messageData: { speaker: getSpeaker(actor) } }).then(result => {
      if (debugEnabled > 1) debug("D20Roll result ", result);
      log("midi-qol | D20Roll result ", result);
      const handler = options.workflow.defenceRequests[requestId];
      delete options.workflow.defenceRequests[requestId];
      delete options.workflow.defenceTimeouts[requestId];
      let returnValue;
      try {
        //@ts-expect-error D20Roll
        returnValue = CONFIG.Dice.D20Roll.fromJSON(JSON.stringify(result));
      } catch (err) { returnValue = {} }
      handler(returnValue);
    });
  }
}

export function midiCustomEffect(...args) {
  let [actor, change, current, delta, changes] = args;
  if (!change.key) return true;
  if (typeof change?.key !== "string") return true;
  if (!change.key?.startsWith(`flags.${MODULE_ID}`) && !change.key?.startsWith("system.traits.da.")) return true;
  const deferredEvaluation = [
    `flags.${MODULE_ID}.OverTime`,
    `flags.${MODULE_ID}.optional`,
    `flags.${MODULE_ID}.advantage`,
    `flags.${MODULE_ID}.disadvantage`,
    `flags.${MODULE_ID}.superSaver`,
    `flags.${MODULE_ID}.semiSuperSaver`,
    `flags.${MODULE_ID}.grants`,
    `flags.${MODULE_ID}.fail`,
    `flags.${MODULE_ID}.max.damage`,
    `flags.${MODULE_ID}.min.damage`,
    `flags.${MODULE_ID}.critical`,
    `flags.${MODULE_ID}.noCritical`,
    `flags.${MODULE_ID}.ignoreCover`,
    `flags.${MODULE_ID}.ignoreWalls`,
    `flags.${MODULE_ID}.rangeOverride`
  ];
  // These have trailing data in the change key change.key values and should always just be a string
  if (change.key === `flags.${game.system.id}.DamageBonusMacro`) {
    // DAEdnd5e - daeCustom processes these
  } else if (change.key === `flags.${MODULE_ID}.onUseMacroName`) {
    const args = change.value.split(",")?.map(arg => arg.trim());
    const currentFlag = foundry.utils.getProperty(actor, `flags.${MODULE_ID}.onUseMacroName`) ?? "";
    if (args[0] === "ItemMacro" || args[0] === MQItemMacroLabel) { // rewrite the ItemMacro if possible
      if (change.effect.transfer) args[0] = `ItemMacro.${change.effect.parent.uuid}`;
      // else if (sourceId) args[0] = `ItemMacro.${sourceId}`;
      else {
        if (change.effect.origin.includes("Item.")) {
          args[0] = `ItemMacro.${change.effect.origin}`;
        } else {
          const origin = MQfromUuidSync(change.effect.origin);
          if (origin instanceof Item) args[0] = `ItemMacro.${origin.uuid}`;
          //@ts-expect-error
          else if (origin instanceof ActiveEffect) args[0] = `ItemMacro.${origin.origin}`;
        }
      }
    }
    if (change.effect?.origin?.includes("Item.")) {
      args[0] = `${args[0]}|${change.effect.origin}`;
    }
    const extraFlag = `[${args[1]}]${args[0]}`;
    const macroString = (currentFlag?.length > 0) ? [currentFlag, extraFlag].join(",") : extraFlag;
    foundry.utils.setProperty(actor, `flags.${MODULE_ID}.onUseMacroName`, macroString)
    return true;
  } else if (change.key.startsWith(`flags.${MODULE_ID}.optional.`) && (change.value.trim() === "ItemMacro" || change.value.trim() === MQItemMacroLabel)) {
    if (change.effect?.origin?.includes("Item.")) {
      const macroString = `ItemMacro.${change.effect.origin}`;
      foundry.utils.setProperty(actor, change.key, macroString)
    } else foundry.utils.setProperty(actor, change.key, change.value);
    return true;
  } /*
  TODO revisit this if going to allow item macro in flags evaluation
  else if (change.key.startsWith(`flags.${MODULE_ID}.`) && (change.value.trim().includes("ItemMacro") || change.value.trim().includes(MQItemMacroLabel))) {
    if (change.effect?.origin?.includes("Item.")) {
      const macroString = `ItemMacro.${change.effect.origin}`;
      foundry.utils.setProperty(actor, change.key, macroString)
    } else foundry.utils.setProperty(actor, change.key, change.value);
  } */
  else if (deferredEvaluation.some(k => change.key.startsWith(k))) {
    if (typeof change.value !== "string") foundry.utils.setProperty(actor, change.key, change.value);
    else if (["true", "1"].includes(change.value.trim())) foundry.utils.setProperty(actor, change.key, true);
    else if (["false", "0"].includes(change.value.trim())) foundry.utils.setProperty(actor, change.key, false);
    else foundry.utils.setProperty(actor, change.key, change.value);
  } else if (change.key.match(/system.traits.*custom/)) {
    // do the trait application here - think about how to update both trait and bypass
  } else if (typeof change.value === "string") {
    let val: any;
    try {
      switch (midiFlagTypes[change.key]) {
        case "string":
          val = change.value; break;
        case "number":
          val = Number.isNumeric(change.value) ? JSON.parse(change.value) : 0; break;
        default: // boolean by default
          val = evalCondition(change.value, actor.getRollData(), { async: false })
      }
      if (debugEnabled > 0) warn("midiCustomEffect | setting ", change.key, " to ", val, " from ", change.value, " on ", actor.name);
      foundry.utils.setProperty(actor, change.key, val);
      foundry.utils.setProperty(actor, change.key.replace(`flags.${MODULE_ID}`, `flags.${MODULE_ID}.evaluated`), { value: val, effects: [change.effect.name] });
    } catch (err) {
      const message = `midi-qol | midiCustomEffect | custom flag eval error ${change.key} ${change.value}`;
      TroubleShooter.recordError(err, message);
      console.warn(message, err);
    }
  } else {
    foundry.utils.setProperty(actor, change.key, change.value)
  }
  return true;
}

export function checkImmunity(candidate, data, options, user) {
  // Not using this in preference to marking effect unavailable
  const parent: Actor | undefined = candidate.parent;
  if (!parent || !(parent instanceof CONFIG.Actor.documentClass)) return true;

  //@ts-expect-error .traits
  const ci = parent.system.traits?.ci?.value;
  const statusId = (data.name ?? (data.label ?? "no effect")).toLocaleLowerCase(); // TODO 11 chck this
  const returnvalue = !(ci.length && ci.some(c => c === statusId));
  return returnvalue;
}

export function untargetDeadTokens() {
  if (autoRemoveTargets !== "none") {
    game.user?.targets.forEach((t: Token) => {
      //@ts-expect-error .system v10
      if (t.actor?.system.attributes.hp.value <= 0) {
        t.setTarget(false, { releaseOthers: false });
      }
    });
  }
}

function replaceAtFields(value, context, options: { blankValue: string | number, maxIterations: number } = { blankValue: "", maxIterations: 4 }) {
  if (typeof value !== "string") return value;
  let count = 0;
  if (!value.includes("@")) return value;
  let re = /@[\w\._\-]+/g
  let result = foundry.utils.duplicate(value);
  result = result.replace("@item.level", "@itemLevel") // fix for outdated item.level
  result = result.replace(`@flags.${MODULE_ID}`, "@flags.midiqol");
  // Remove @data references allow a little bit of recursive lookup
  do {
    count += 1;
    for (let match of result.match(re) || []) {
      result = result.replace(match.replace("@data.", "@"), foundry.utils.getProperty(context, match.slice(1)) ?? options.blankValue)
    }
  } while (count < options.maxIterations && result.includes("@"));
  return result;
}

export async function doOverTimeEffect(actor, effect, startTurn: boolean = true, options: any = { saveToUse: undefined, rollFlags: undefined, isActionSave: false }) {
  if (game.user?.isGM)
    return gmOverTimeEffect(actor, effect, startTurn, options);
  else
    return untimedExecuteAsGM("gmOverTimeEffect", { actorUuid: actor.uuid, effectUuid: effect.uuid, startTurn, options })
}

export async function gmOverTimeEffect(actor, effect, startTurn: boolean = true, options: any = { saveToUse: undefined, rollFlags: undefined, rollMode: undefined }) {
  const endTurn = !startTurn;
  if (effect.disabled || effect.isSuppressed) return;
  const auraFlags = effect.flags?.ActiveAuras ?? {};
  if (auraFlags.isAura && auraFlags.ignoreSelf) return;
  const rollData = createConditionData({ actor, workflow: undefined, target: undefined });
  if (!rollData.flags) rollData.flags = actor.flags;
  rollData.flags.midiqol = rollData.flags[MODULE_ID];
  const changes = effect.changes.filter(change => change.key.startsWith(`flags.${MODULE_ID}.OverTime`));
  if (changes.length > 0) for (let change of changes) {
    // flags.midi-qol.OverTime turn=start/end, damageRoll=rollspec, damageType=string, saveDC=number, saveAbility=str/dex/etc, damageBeforeSave=true/[false], label="String"
    let spec = change.value;
    spec = replaceAtFields(spec, rollData, { blankValue: 0, maxIterations: 3 });
    spec = spec.replace(/\s*=\s*/g, "=");
    spec = spec.replace(/\s*,\s*/g, ",");
    spec = spec.replace("\n", "");
    let parts;
    if (spec.includes("#")) parts = spec.split("#");
    else parts = spec.split(",");
    let details: any = {};
    for (let part of parts) {
      const p = part.split("=");
      details[p[0]] = p.slice(1).join("=");
    }
    if (details.turn === undefined) details.turn = "start";
    if (details.applyCondition || details.condition) {
      let applyCondition = details.applyCondition ?? details.condition; // maintain support for condition
      let value = replaceAtFields(applyCondition, rollData, { blankValue: 0, maxIterations: 3 });
      let result;
      try {
        result = await evalCondition(value, rollData, { async: true });
      } catch (err) {
        const message = `midi-qol | gmOverTimeEffect | error when evaluating overtime apply condition ${value} - assuming true`;
        TroubleShooter.recordError(err, message);
        console.warn(message, err);
        result = true;
      }
      if (!result) continue;
    }

    const changeTurnStart = details.turn === "start" ?? false;
    const changeTurnEnd = details.turn === "end" ?? false;
    let actionSave = details.actionSave;
    if (![undefined, "dialog", "roll"].includes(actionSave)) {
      console.warn(`midi-qol | gmOverTimeEffect | invalid actionSave: ${actionSave} for ${actor.name} ${effect.name}`);
      console.warn(`midi-qol | gmOverTimeEffect | valid values are "undefined", "dialog" or "roll"`);
      if (["0", "false"].includes(actionSave)) actionSave = undefined;
      else actionSave = "roll";
      console.warn(`midi-qol | gmOverTimeEffect | setting actionSave to ${actionSave}`);
    }

    const saveAbilityString = (details.saveAbility ?? "");
    const saveAbility = (saveAbilityString.includes("|") ? saveAbilityString.split("|") : [saveAbilityString]).map(s => s.trim().toLocaleLowerCase())
    const label = (details.name ?? details.label ?? effect.name).replace(/"/g, "");
    const chatFlavor = details.chatFlavor ?? "";
    const rollTypeString = details.rollType ?? "damage";
    const rollType = (rollTypeString.includes("|") ? rollTypeString.split("|") : [rollTypeString]).map(s => s.trim().toLocaleLowerCase())
    const saveMagic = JSON.parse(details.saveMagic ?? "false"); //parse the saving throw true/false
    const rollMode = details.rollMode;

    let actionType = "other";
    if (Object.keys(GameSystemConfig.itemActionTypes).includes(details.actionType?.toLocaleLowerCase())) actionType = details.actionType.toLocaleLowerCase();
    const messageFlavor = {
      "save": `${GameSystemConfig.abilities[saveAbilityString]?.label ?? saveAbilityString} ${i18n("midi-qol.saving-throw")}`,
      "check": `${GameSystemConfig.abilities[saveAbilityString]?.label ?? saveAbilityString} ${i18n("midi-qol.ability-check")}`,
      "skill": `${GameSystemConfig.skills[saveAbilityString]?.label ?? saveAbilityString} ${i18n("midi-qol.skill-check")}`
    };
    let saveDC;
    let value;
    let saveResultDisplayed = false;
    try {
      value = replaceAtFields(details.saveDC, rollData, { blankValue: 0, maxIterations: 3 });
      saveDC = !!value && Roll.safeEval(value);
    } catch (err) {
      TroubleShooter.recordError(err, `overTime effect | error evaluating saveDC ${value}`);
    } finally {
      if (!value) saveDC = -1
    }

    if (endTurn) {
      const chatcardUuids = effect.getFlag(MODULE_ID, "overtimeChatcardUuids");
      if (chatcardUuids) for (let chatcardUuid of chatcardUuids) {
        const chatCard = MQfromUuidSync(chatcardUuid);
        chatCard?.delete();
      }
    }

    if (options.isActionSave && actionSave === "dialog") {
      // generated by a save roll so we can ignore
      continue;
    }
    //@ts-expect-error
    let owner = playerForActor(actor) ?? game.users?.activeGM;
    //@ts-expect-error
    if (!owner?.active) owner = game.users?.activeGM;
    if (actionSave && startTurn && actionSave === "dialog") {
      if (!owner?.active) {
        error(`No active owmer to request overtime save for ${actor.name} ${effect.name}`);
        return effect.id;
      }
      let saveResult: any = await new Promise(async (resolve, reject) => {
        let timeoutId
        if (configSettings.playerSaveTimeout) timeoutId = setTimeout(() => resolve(undefined), configSettings.playerSaveTimeout * 1000)
        const content = `${actor.name} use your action to overcome ${label}`;
        const result = await socketlibSocket.executeAsUser("rollActionSave", owner?.id, {
          title: `${actor.name} Action: ${label}`,
          content,
          actorUuid: actor.uuid,
          request: rollTypeString,
          abilities: saveAbility,
          saveDC,
          actionSave,
          options: {
            simulate: false,
            targetValue: saveDC,
            messageData: { user: owner?.id, flavor: `${label} ${i18n(messageFlavor[details.rollType])}` },
            chatMessage: true,
            rollMode,
            mapKeys: false,
            // advantage: saveDetails.advantage,
            // disadvantage: saveDetails.disadvantage,
            fastForward: false,
            isMagicSave: saveMagic,
            isConcentrationCheck: false
          }
        });
        if (timeoutId) clearTimeout(timeoutId);
        resolve(result);
      });
      if (saveResult?.class) saveResult = JSON.parse(JSON.stringify(saveResult));
      const success = saveResult?.options?.success || saveResult?.total >= saveDC;
      if (saveResult?.options) saveResultDisplayed = true;
      setProperty(effect, `flags.${MODULE_ID}.actionSaveSuccess`, success === true);
    } else if (actionSave && actionSave === "roll" && options.isActionSave && options.saveToUse) {
      // player has made a save record the save/flags on the effect
      // if a match and saved then record the save success
      if (!options.rollFlags) return effect.id;
      if (options.rollFlags.type === "ability") options.rollFlags.type = "check";
      if (!rollType.includes(options.rollFlags.type) || !saveAbility.includes(options.rollFlags.abilityId ?? options.rollFlags.skillId)) continue;
      const success = options.saveToUse?.options?.success || options.saveToUse?.total >= saveDC || (checkRule("criticalSaves") && options.saveToUse.isCritical);
      if (success !== undefined) {
        const chatcardUuids = effect.getFlag(MODULE_ID, "overtimeChatcardUuids");
        for (let chatcardUuid of chatcardUuids) {
          const chatCard = MQfromUuidSync(chatcardUuid);
          await chatCard?.delete();
        }
      }
      if (success) {
        expireEffects(actor, [effect], { "expiry-reason": "midi-qol:overTime:actionSave" });
        return effect.id;
      } else {
        await effect.setFlag(MODULE_ID, "actionSaveSuccess", success === true);
      }

      /*
      if (success !== undefined && !saveResultDisplayed) {
        let content;
        if (success) {
          content = `${effect.name} ${messageFlavor[details.rollType]} ${i18n("midi-qol.save-success")}`;
        } else {
          content = `${effect.name} ${messageFlavor[details.rollType]} ${i18n("midi-qol.save-failure")}`;
        }
      }
      */
      return effect.id;
    } else if (actionSave === "roll" && startTurn) {
      const MessageClass = getDocumentClass("ChatMessage");
      let dataset;
      const chatCardUuids: string[] = [];
      for (let ability of saveAbility) {
        dataset = { type: rollTypeString, dc: saveDC, item: effect.name, action: "rollRequest", midiOvertimeActorUuid: actor.uuid, rollMode };
        if (["check", "save"].includes(rollTypeString)) dataset.ability = ability;
        // dataset = { type: rollTypeString, ability, dc: saveDC, item: effect.name, action: "rollRequest", midiOvertimeActorUuid: actor.uuid };
        else if (rollTypeString === "skill") dataset.skill = ability;
        // dataset = { type: rollTypeString, dc: saveDC, skill: ability, item: effect.name, action: "rollRequest", midiOvertimeActorUuid: actor.uuid };
        let whisper: User[] = ChatMessage.getWhisperRecipients(owner.name);
        if (owner.isGM) {
          whisper = ChatMessage.getWhisperRecipients("GM");
        }

        // const content = `${effect.name} ${i18n(messageFlavor[details.rollType])} as your action to overcome ${label}`;
        const chatData = {
          user: game.user?.id,
          whisper: whisper.map(u => u.id ?? ""),
          rollMode: rollMode ?? "public",
          content: await renderTemplate("systems/dnd5e/templates/chat/request-card.hbs", {
            //@ts-expect-error
            buttonLabel: game.system.enrichers.createRollLabel({ ...dataset, format: "short", icon: true, hideDC: !owner.isGM && !configSettings.displaySaveDC }),
            //@ts-expect-error
            hiddenLabel: game.system.enrichers.createRollLabel({ ...dataset, format: "short", icon: true, hideDC: true }),
            dataset
          }),
          flavor: `Action: ${label ?? effect.name} ${i18n(messageFlavor[details.rollType])}`,
          speaker: MessageClass.getSpeaker({ actor })
        };
        const chatCard = await ChatMessage.create(chatData);
        if (chatCard) {
          chatCardUuids.push(chatCard.uuid);
          chatCard?.setFlag(MODULE_ID, "actorUuid", actor.uuid)
        }
      }
      foundry.utils.setProperty(effect, `flags.${MODULE_ID}.actionSaveSuccess`, undefined);
      effect.setFlag(MODULE_ID, "overtimeChatcardUuids", chatCardUuids)
        .then(() => effect.setFlag(MODULE_ID, "actionSaveSuccess", undefined));

      if (changeTurnEnd) return effect.id;
    }

    let actionSaveSuccess = foundry.utils.getProperty(effect, `flags.${MODULE_ID}.actionSaveSuccess`);
    if (actionSaveSuccess === true && changeTurnEnd) {
      await expireEffects(actor, [effect], { "expiry-reason": "midi-qol:overTime:actionSave" });
      return effect.id;
    }
    if ((endTurn && changeTurnEnd) || (startTurn && changeTurnStart)) {
      const saveDamage = details.saveDamage ?? "nodamage";
      const damageRoll = details.damageRoll;
      const damageType = details.damageType ?? "piercing";
      const itemName = details.itemName;
      const damageBeforeSave = JSON.parse(details.damageBeforeSave ?? "false");
      const macroToCall = details.macro;
      const allowIncapacitated = JSON.parse(details.allowIncapacitated ?? "true");
      const fastForwardDamage = details.fastForwardDamage && JSON.parse(details.fastForwardDamage);

      const killAnim = JSON.parse(details.killAnim ?? "false");
      const saveRemove = JSON.parse(details.saveRemove ?? "true");

      if (debugEnabled > 0) warn(`gmOverTimeEffect | Overtime provided data is `, details);
      if (debugEnabled > 0) warn(`gmOverTimeEffect | OverTime label=${label} startTurn=${startTurn} endTurn=${endTurn} damageBeforeSave=${damageBeforeSave} saveDC=${saveDC} saveAbility=${saveAbility} damageRoll=${damageRoll} damageType=${damageType}`);

      let itemData: any = {
      };
      itemData.img = "icons/svg/aura.svg";
      if (typeof itemName === "string") {
        let theItem = await fromUuid(itemName);
        if (!theItem && itemName.startsWith("Actor.")) {
          const localName = itemName.replace("Actor.", "")
          theItem = actor.items.getName(localName);
        }
        if (!theItem) {
          const theItem = game.items?.getName(itemName);
        }
        if (theItem) itemData = theItem.toObject();
      }

      let activityData: any = {
        name: label,
        id: "overtime",
        type: "damage",
        damage: {
          parts: [{
            custom: {
              enabled: true,
              formula: damageRoll,
            },
            types: [damageType]
          }]
        }
      };
      activityData.img = effect.img;
      itemData.img = effect.img; // v12 icon -> img

      itemData.type = "equipment";
      foundry.utils.setProperty(itemData, "system.type.value", "trinket");
      foundry.utils.setProperty(itemData, `flags.${MODULE_ID}.noProvokeReaction`, true);
      if (saveMagic) {
        itemData.type = "spell";
        foundry.utils.setProperty(itemData, "system.preparation", { mode: "atwill" });
      }
      if (rollTypeString === "save" && !actionSave) {
        actionType = "save";
        activityData.type = "save";
        activityData.save = {
          ability: saveAbility[0],
          dc: {
            calculation: "",
            formula: `${saveDC}`,
          }
        }
        actionType = "save";
      }
      if (rollTypeString === "check" && !actionSave) {
        actionType = "check";
        activityData.type = "check";
        activityData.check = {
          ability: saveAbility[0],
          dc: {
            calculation: "",
            formula: `${saveDC}`,
          }
        }
      }
      if (rollTypeString === "skill" && !actionSave) { // skill checks for this is a fiddle - set a midi flag so that the midi save roll will pick it up.
        actionType = "check";
        activityData.type = "check";
        let skill = saveAbility[0];
        let ability = "";
        let skillEntry = GameSystemConfig.skills[skill];
        if (!GameSystemConfig.skills[skill]) { // not a skill id see if the name matches an entry
          //@ts-expect-error
          let found: any = Object.entries(GameSystemConfig.skills).find(([id, entry]) => entry.label.toLocaleLowerCase() === skill)
          if (found) {
            skill = found[0];
            skillEntry = found[1];
          }
        }
        if (skillEntry) {
          activityData.check = {
            ability: skillEntry.ability,
            dc: {
              calculation: "",
              formula: `${saveDC}`,
            },
            associated: [skill]
          }
        }
      }

      if (damageBeforeSave || saveDamage === "fulldamage") {
        activityData.damage.onSave = "full";
      } else if (saveDamage === "halfdamage" || !damageRoll) {
        activityData.damage.onSave = "half";
      } else {
        activityData.damage.onSave = "none";
      }
      itemData.name = label;
      activityData.description = { chat: chatFlavor };
      foundry.utils.setProperty(itemData, "system.description.chat", effect.description ?? "");

      itemData._id = foundry.utils.randomID();
      // roll the damage and save....
      const theTargetToken = getTokenForActor(actor);
      const theTargetId = theTargetToken?.document.id;
      const theTargetUuid = theTargetToken?.document.uuid;
      if (game.user && theTargetId) game.user.updateTokenTargets([theTargetId]);

      if (damageRoll) {
        let damageRollString = damageRoll;
        let stackCount = effect.flags.dae?.stacks ?? 1;
        if (globalThis.EffectCounter && theTargetToken) {
          const counter = globalThis.EffectCounter.findCounter(getTokenDocument(theTargetToken), effect.img ?? effect.icon) //v12 icon -> img
          if (counter) stackCount = counter.getValue();
        }
        for (let i = 1; i < stackCount; i++)
          damageRollString = `${damageRollString} + ${damageRoll}`;
        activityData.damage.parts[0].custom.formula = damageRollString;
      }
      foundry.utils.setProperty(itemData.flags, "midi-qol.forceCEOff", true);
      if (killAnim) foundry.utils.setProperty(itemData.flags, "autoanimations.killAnim", true)
      if (macroToCall) {
        foundry.utils.setProperty(itemData, `flags.${MODULE_ID}.onUseMacroName`, macroToCall);
        foundry.utils.setProperty(itemData, `flags.${MODULE_ID}.onUseMacroParts`, new OnUseMacros(macroToCall));
      }
      // Try and find the source actor for the overtime effect so that optional bonuses etc can fire.
      let origin: any = MQfromUuidSync(effect.origin);
      while (origin && !(origin instanceof Actor)) {
        origin = origin?.parent;
      }
      itemData.system.activities = { "overtime": activityData };
      let ownedItem: Item = new CONFIG.Item.documentClass(itemData, { parent: ((origin instanceof Actor) ? origin : actor) });
      // TODO: Horrible kludge to allow temporary items to be rolled since dnd5e insists on setting flags on temp items if there is damage/attacks
      ownedItem.setFlag = async (scope: string, key: string, value: any) => { return ownedItem };
      ownedItem.prepareData();
      //@ts-expect-error
      ownedItem.prepareFinalAttributes();
      //@ts-expect-error
      ownedItem.prepareEmbeddedDocuments();
      if (false && !actionSave && saveRemove && saveDC > -1)
        //@ts-expect-error
        failedSaveOverTimeEffectsToDelete[ownedItem.system.activities.contents[0].uuid] = { uuid: effect.uuid };

      if (details.removeCondition) {
        let value = replaceAtFields(details.removeCondition, rollData, { blankValue: 0, maxIterations: 3 });
        let remove;
        try {
          remove = await evalCondition(value, rollData, { errorReturn: true, async: true });
          // remove = Roll.safeEval(value);
        } catch (err) {
          const message = `midi-qol | gmOverTimeEffect | error when evaluating overtime remove condition ${value} - assuming true`;
          TroubleShooter.recordError(err, message);
          console.warn(message, err);
          remove = true;
        }
        if (remove) {
          //@ts-expect-error
          overTimeEffectsToDelete[ownedItem.system.activities.contents[0].uuid] = { uuid: effect.uuid }
        }
      }
      try {
        const options = {
          systemCard: false,
          createWorkflow: true,
          versatile: false,
          configureDialog: false,
          saveDC,
          checkGMStatus: true,
          targetUuids: [theTargetUuid],
          ignoreUserTargets: true,
          workflowOptions: { targetConfirmation: "none", autoRollDamage: "onHit", fastForwardDamage, isOverTime: true, allowIncapacitated },
          flags: {
            dnd5e: { "itemData": ownedItem.toObject() },
          }
        };
        foundry.utils.setProperty(options, `flags.${MODULE_ID}.isOverTime`, true);
        await completeItemUseV2(ownedItem, { midiOptions: options }, { configure: false }, {rollMode}); // worried about multiple effects in flight so do one at a time
        if (actionSaveSuccess) {
          await expireEffects(actor, [effect], { "expiry-reason": "midi-qol:overTime:actionSave" });
        }
        /*
        if (actionSaveSuccess !== undefined && !saveResultDisplayed) {
          let content;
          if (actionSaveSuccess) {
            content = `${effect.name} ${messageFlavor[details.rollType]} ${i18n("midi-qol.save-success")}`;
          } else {
            content = `${effect.name} ${messageFlavor[details.rollType]} ${i18n("midi-qol.save-failure")}`;
          }
          ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor }) });
        }
        */
        return effect.id;
      } catch (err) {
        const message = "midi-qol | completeItemUse | error";
        TroubleShooter.recordError(err, message);
        console.warn(message, err);
      } finally {
      }
    }
  }
}

export async function _processOverTime(combat, data, options, userId) {
  //@ts-expect-error
  if (!game.users.activeGM.isSelf) return;
  let prev = (combat.previous?.round ?? 0) * 100 + (combat.previous.turn ?? 0);
  let testTurn = combat.previous.turn ?? 0;
  let testRound = combat.previous.round ?? 0;
  const last = (data.round ?? combat.current.round) * 100 + (data.turn ?? combat.current.turn);
  // These changed since overtime moved to _preUpdate function instead of hook
  // const prev = (combat.previous.round ?? 0) * 100 + (combat.previous.turn ?? 0);
  // let testTurn = combat.previous.turn ?? 0;
  // let testRound = combat.previous.round ?? 0;
  // const last = (combat.current.round ?? 0) * 100 + (combat.current.turn ?? 0);

  let toTest = prev;
  let count = 0;
  while (toTest <= last && count < 200) { // step through each turn from prev to current
    count += 1; // make sure we don't do an infinite loop
    const actor = combat.turns[testTurn]?.actor;
    const endTurn = toTest < last;
    const startTurn = toTest > prev;

    // Remove reaction used status from each combatant
    if (actor && toTest !== prev && !installedModules.get("times-up")) {
      // do the whole thing as a GM to avoid multiple calls to the GM to set/remove flags/conditions
      await untimedExecuteAsGM("removeActionBonusReaction", { actorUuid: actor.uuid });
    }
    if (actor && toTest !== prev) {
      removeActionUsed(actor);
    }

    if (actor) for (let effect of actor.appliedEffects) {
      if (effect.changes.some(change => change.key.startsWith(`flags.${MODULE_ID}.OverTime`))) {
        await doOverTimeEffect(actor, effect, startTurn);
      }
    }
    testTurn += 1;
    if (testTurn === combat.turns.length) {
      testTurn = 0;
      testRound += 1;
      toTest = testRound * 100;
    } else toTest += 1;
  }
}
export async function completeActivityUse(activity, config: any = {}, dialog: any = {}, message: any = {}) {
  let theItem: any;
  let targetsToUse = new Set();

  if (typeof activity === "string") {
    activity = MQfromUuidSync(activity);
  }
  config.midiOptions ??= {};
  config.midiOptions.workflowOptions = { forceCompletion: true };
  // delete any existing workflow - complete item use always is fresh.
  if (Workflow.getWorkflow(activity.uuid)) await Workflow.removeWorkflow(activity.uuid);
  let localRoll = (!config.midiOptions.asUser && game.user?.isGM) || !config.midiOptions.checkGMStatus || config.midiOptions.asUser === game.user?.id;
  if (localRoll) {
    return new Promise((resolve) => {
      let saveTargets = Array.from(game.user?.targets ?? []).map(t => { return t.id });
      if (config.midiOptions.ignoreUserTargets) game.user?.updateTokenTargets([]);
      if (game.user && activity.target?.affects?.type === "self") {
        game.user?.updateTokenTargets([]);
        const selfTarget = getToken(activity.item.actor);
        if (selfTarget) {
          selfTarget.setTarget(true, { user: game.user, releaseOthers: false, groupSelection: true });
          targetsToUse.add(selfTarget);
        }
      } else if (config.midiOptions.targetUuids?.length > 0 && game.user && activity.target?.affects?.type !== "self") {
        for (let targetUuid of config.midiOptions.targetUuids) {
          const theTarget = MQfromUuidSync(targetUuid);
          if (theTarget) theTarget.object.setTarget(true, { user: game.user, releaseOthers: false, groupSelection: true });
          targetsToUse.add(theTarget.object)
        }
      } else if (config.midiOptions.targetUuids === undefined && !config.midiOptions.ignoreUserTargets) {
        targetsToUse = new Set(game.user?.targets);
      }

      let abortHookName = `midi-qol.preAbort.${activity?.uuid}`;
      if (!(activity)) {
        // Magic items create a pseudo item when doing the roll so have to hope we get the right completion
        abortHookName = "midi-qol.preAbort";
      }
      const abortHookId = Hooks.once(abortHookName, (workflow) => {
        Hooks.off(completeHookName, completeHookId);
        if (debugEnabled > 0) warn(`completeItemUse abort hook fired: ${workflow.workflowName} ${abortHookName}`)
        console.warn(`completeItemUse abort hook fired: ${workflow.workflowName} ${abortHookName}`);
        game.user?.updateTokenTargets(saveTargets);
        resolve(workflow);
      });

      let completeHookName = `midi-qol.postCleanup.${activity.uuid}`;
      if (!(activity)) {
        // Magic items create a pseudo item when doing the roll so have to hope we get the right completion
        completeHookName = "midi-qol.postCleanup";
      }
      const completeHookId = Hooks.once(completeHookName, (workflow) => {
        Hooks.off(abortHookName, abortHookId);
        if (debugEnabled > 0) warn(`completeActivityUse complete hook fired: ${workflow.workflowName} ${completeHookName}`)
        game.user?.updateTokenTargets(saveTargets);
        console.warn(`completeActivityUse complete hook fired: ${workflow.workflowName} ${completeHookName}`);
        resolve(workflow);
      });
      config.midiOptions.targetsToUse = targetsToUse;
      activity.use(config, dialog, message).then(result => { if (!result) resolve(result) });
    });
  } else {
    const targetUuids = config.midiOptions.argetUuids ? config.midiOptions.targetUuids : Array.from(game.user?.targets || []).map(t => t.document.uuid); // game.user.targets is always a set of tokens
    const data = {
      activityUuid: activity.uuid,
      actorUuid: activity.item.parent.uuid,
      targetUuids,
      config,
      dialog
    }
    const asUserActive = game.users?.get(config.midiOptions.asUser)?.active;
    //@ts-expect-error
    if (!asUserActive) options.asUser = game.users?.activeGM?.id ?? game.user?.id
    if (config.midiOptions.asUser && asUserActive)
      return await socketlibSocket.executeAsUser("completeActivityUse", config.midiOptions.asUser, data);
    else
      return await timedAwaitExecuteAsGM("completeActivityUse", data);
  }
}

export async function completeItemUse(item, config: any = {}, options: any = { checkGMstatus: false, targetUuids: undefined, asUser: undefined }, dialog: any = {}, message: any = {}) {
  config.midiOptions = options;
  return completeItemUseV2(item, config, dialog, message);
}

export async function completeItemUseV2(item, config: any = {}, dialog: any = {}, message: any = {}) {
  if (typeof item === "string") {
    //@ts-expect-error
    item = fromUuidSync(item);
  }
  if (!(item instanceof CONFIG.Item.documentClass)) {
    console.error("item use only works for items");
    return undefined;
  }
  //@ts-expect-error
  const activity = item.system.activities.contents[0];
  if (!activity) {
    error(`item ${item.name} ${item.uuid} does not have an activity`);
    return undefined;
  }
  return await completeActivityUse(activity, config, dialog, message);
}

export async function completeItemUseOld(item, config: any = {}, options: any = { checkGMstatus: false, targetUuids: undefined, asUser: undefined }) {
  let theItem: any;
  let targetsToUse = new Set();

  if (typeof item === "string") {
    theItem = MQfromUuidSync(item);
  } else if (!(item instanceof CONFIG.Item.documentClass)) {
    const magicItemUuid = item.magicItem.items.find(i => i.id === item.id)?.uuid;
    theItem = await fromUuid(magicItemUuid);
  } else theItem = item;
  options = foundry.utils.mergeObject(options, { workflowOptions: { forceCompletion: true } })
  // delete any existing workflow - complete item use always is fresh.
  if (Workflow.getWorkflow(theItem.uuid)) await Workflow.removeWorkflow(theItem.uuid);
  let localRoll = (!options.asUser && game.user?.isGM) || !options.checkGMStatus || options.asUser === game.user?.id;
  if (localRoll) {
    return new Promise((resolve) => {
      let saveTargets = Array.from(game.user?.targets ?? []).map(t => { return t.id });
      if (options.targetUuids?.length > 0 && game.user && theItem.system.target.type !== "self") {
        if (!options.ignoreUserTargets) game.user.updateTokenTargets([]);
        for (let targetUuid of options.targetUuids) {
          const theTarget = MQfromUuidSync(targetUuid);
          if (theTarget && !options.ignoreUserTargets) theTarget.object.setTarget(true, { user: game.user, releaseOthers: false, groupSelection: true });
          targetsToUse.add(theTarget.object)
        }
      } else if (options.targetUuids === undefined && !options.ignoreUserTargets) {
        targetsToUse = new Set(game.user?.targets);
      }

      let abortHookName = `midi-qol.preAbort.${item?.uuid}`;
      if (!(item instanceof CONFIG.Item.documentClass)) {
        // Magic items create a pseudo item when doing the roll so have to hope we get the right completion
        abortHookName = "midi-qol.preAbort";
      }
      const abortHookId = Hooks.once(abortHookName, (workflow) => {
        Hooks.off(completeHookName, completeHookId);
        if (debugEnabled > 0) warn(`completeItemUse abort hook fired: ${workflow.workflowName} ${abortHookName}`)
        game.user?.updateTokenTargets(saveTargets);
        resolve(workflow);
      });

      let completeHookName = `midi-qol.postCleanup.${item?.uuid}`;
      if (!(item instanceof CONFIG.Item.documentClass)) {
        // Magic items create a pseudo item when doing the roll so have to hope we get the right completion
        completeHookName = "midi-qol.postCleanup";
      }
      const completeHookId = Hooks.once(completeHookName, (workflow) => {
        Hooks.off(abortHookName, abortHookId);
        if (debugEnabled > 0) warn(`completeItemUse complete hook fired: ${workflow.workflowName} ${completeHookName}`)
        game.user?.updateTokenTargets(saveTargets);
        resolve(workflow);
      });

      if (item.magicItem) {
        item.magicItem.magicItemActor.roll(item.magicItem.id, theItem.id);
      } else {
        options.targetsToUse = targetsToUse
        theItem.use(config, options).then(result => { if (!result) resolve(result) });
      }
    })
  } else {
    const targetUuids = options.targetUuids ? options.targetUuids : Array.from(game.user?.targets || []).map(t => t.document.uuid); // game.user.targets is always a set of tokens
    const data = {
      itemData: theItem.toObject(false),
      actorUuid: theItem.parent.uuid,
      targetUuids,
      config,
      options
    }
    const asUserActive = game.users?.get(options.asUser)?.active;
    //@ts-expect-error
    if (!asUserActive) options.asUser = game.users?.activeGM?.id ?? game.user?.id
    if (options.asUser && asUserActive)
      return await socketlibSocket.executeAsUser("completeItemUse", options.asUser, data);
    else
      return await timedAwaitExecuteAsGM("completeItemUse", data);
  }
}

export function untargetAllTokens(...args) {
  let combat: Combat = args[0];
  //@ts-expect-error combat.current
  let prevTurn = combat.current.turn - 1;
  if (prevTurn === -1)
    prevTurn = combat.turns.length - 1;

  const previous = combat.turns[prevTurn];
  if ((game.user?.isGM && ["allGM", "all"].includes(autoRemoveTargets)) || (autoRemoveTargets === "all" && canvas?.tokens?.controlled.find(t => t.id === previous.token?.id))) {
    // release current targets
    game.user?.targets.forEach((t: Token) => {
      t.setTarget(false, { releaseOthers: false });
    });
  }
}

export function checkDefeated(actorRef: Actor | Token | TokenDocument | string): 0 | 1 {
  const actor = getActor(actorRef);
  if (!actor) return 0;

  //@ts-expect-error
  return hasCondition(actor, CONFIG.specialStatusEffects.DEFEATED)
    || hasCondition(actor, configSettings.midiDeadCondition);
}

export function checkIncapacitated(actorRef: Actor | Token | TokenDocument | string | undefined | null, logResult: boolean = true): string | false {
  const actor = getActor(actorRef);
  if (!actor) return false;
  //@ts-expect-error
  if (actor.system.traits?.ci?.value.has("incapacitated")) return false;
  const vitalityResource = checkRule("vitalityResource");
  if (typeof vitalityResource === "string" && foundry.utils.getProperty(actor, vitalityResource.trim()) !== undefined) {
    const vitality = foundry.utils.getProperty(actor, vitalityResource.trim()) ?? 0;
    //@ts-expect-error .system
    if (vitality <= 0 && actor?.system.attributes?.hp?.value <= 0) {
      if (logResult) log(`${actor.name} is dead and therefore incapacitated`);
      return "dead";
    }
  } else {
    //@ts-expect-error
    if (!actor.system?.attributes?.hp?.value) {
      (debug("No hp attribute for ", actor));
    }
    //@ts-expect-error .system
    if (actor?.system?.attributes?.hp?.value <= 0) {
      if (logResult) log(`${actor.name} is incapacitated`)
      return "dead";
    }
  }

  if (configSettings.midiUnconsciousCondition && hasCondition(actor, configSettings.midiUnconsciousCondition)) {
    if (logResult) log(`${actor.name} is ${getStatusName(configSettings.midiUnconsciousCondition)} and therefore incapacitated`)
    return configSettings.midiUnconsciousCondition;
  }
  if (configSettings.midiDeadCondition && hasCondition(actor, configSettings.midiDeadCondition)) {
    if (logResult) log(`${actor.name} is ${getStatusName(configSettings.midiDeadCondition)} and therefore incapacitated`)
    return configSettings.midiDeadCondition;
  }
  const incapCondition = (globalThis.MidiQOL.incapacitatedConditions ?? ["incapacitated"]).find(cond => hasCondition(actor, cond));
  if (incapCondition) {
    if (logResult) log(`${actor.name} has condition ${getStatusName(incapCondition)} so incapacitated`)
    return incapCondition;
  }
  return false;
}

export function getUnitDist(x1: number, y1: number, z1: number, token2): number {
  if (!canvas?.dimensions) return 0;
  const unitsToPixel = canvas.dimensions.size / canvas.dimensions.distance;
  z1 = z1 * unitsToPixel;
  const x2 = token2.center.x;
  const y2 = token2.center.y;
  const z2 = token2.document.elevation * unitsToPixel;

  const d =
    Math.sqrt(
      Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2) + Math.pow(z2 - z1, 2)
    ) / unitsToPixel;
  return d;
}

// not working properly yet
export function getSurroundingHexes(token: Token) {
  let start = canvas?.grid?.grid?.getGridPositionFromPixels(token.center.x, token.center.y);
  if (!start) return;

  const surrounds: any[][] = new Array(11);
  for (let r = 0; r < 11; r++) {
    surrounds[r] = new Array(11);
  }
  for (let c = -5; c <= 5; c++)
    for (let r = -5; r <= 5; r++) {
      const row = start[0] + r;
      const col = start[1] + c
      let [x1, y1] = canvas?.grid?.grid?.getPixelsFromGridPosition(row, col) ?? [0, 0];
      let x, y;
      //@ts-expect-error getCenter -> getCenterPoint v12
      if (game.release.generation > 11) {
        //@ts-expect-error
        ({ x, y } = canvas?.grid?.getCenterPoint({ x, y }) ?? { x: 0, y: 0 })
      } else {
        [x, y] = canvas?.grid?.getCenter(x1, y1) ?? [0, 0];
      }
      if (!x && !y) continue;
      const distance = distancePointToken({ x, y }, token);
      surrounds[r + 5][c + 5] = ({ r: row, c: col, d: distance })
    }
  //  for (let r = -5; r <=5; r++)
  //  console.error("Surrounds are ", ...surrounds[r+5]);
  const filtered = surrounds.map(row => row.filter(ent => {
    const entDist = ent.d / (canvas?.dimensions?.distance ?? 5);
    //@ts-expect-error .width v10
    const tokenWidth = token.document.width / 2;
    // console.error(ent.r, ent.c, ent.d, entDist, tokenWidth)
    //@ts-expect-error .width v10
    if (token.document.width % 2)
      return entDist >= tokenWidth && entDist <= tokenWidth + 0.5
    else return entDist >= tokenWidth && entDist < tokenWidth + 0.5
  }));
  const hlt = canvas?.grid?.highlightLayers["mylayer"] || canvas?.grid?.addHighlightLayer("mylayer");
  hlt?.clear();

  for (let a of filtered) if (a.length !== 0) {
    a.forEach(item => {
      let [x, y] = canvas?.grid?.grid?.getPixelsFromGridPosition(item.r, item.c) ?? [0, 0];
      // console.error("highlighting ", x, y, item.r, item.c)
      //@ts-expect-error
      canvas?.grid?.highlightPosition("mylayer", { x, y, color: game?.user?.color });
    })
    // console.error(...a);
  }
}

export function distancePointToken({ x, y, elevation = 0 }, token, wallblocking = false) {
  if (!canvas || !canvas.scene) return undefined;
  let coverACBonus = 0;
  let tokenTileACBonus = 0;
  let coverData;
  if (!canvas.grid || !canvas.dimensions) undefined;
  if (!token || x === undefined || y === undefined) return undefined;
  if (!canvas || !canvas.grid || !canvas.dimensions) return undefined;
  const t2StartX = -Math.max(0, token.document.width - 1);
  const t2StartY = -Math.max(0, token.document.height - 1);
  var d, r, segments: { ray: Ray }[] = [], rdistance, distance;
  const [row, col] = canvas.grid.grid?.getGridPositionFromPixels(x, y) || [0, 0];
  const [xbase, ybase] = canvas.grid.grid?.getPixelsFromGridPosition(row, col) || [0, 0];
  let xc, yc;
  //@ts-expect-error v12 getCenter -> getCenterPoint
  if (game.release.version > 11) {
    //@ts-expect-error v12
    ({ xc, yc } = canvas.grid.getCenterPoint.bind(canvas.grid)(xbase, ybase) || { x: 0, y: 0 });
  } else {
    [xc, yc] = canvas.grid.getCenter.bind(canvas.grid)(xbase, ybase) || [0, 0];
  }
  // const snappedOrigin = canvas?.grid?.getSnappedPosition(x,y)
  const origin = new PIXI.Point(x, y);
  const tokenCenter = token.center;
  //@ts-expect-error
  if (game.release.generation >= 12) {
    //@ts-expect-error
    distance = canvas.grid.measurePath([origin, tokenCenter]).distance;
  } else {
    const ray: Ray = new Ray(origin, tokenCenter)
    distance = canvas?.grid?.measureDistances([{ ray }], { gridSpaces: false })[0];
    distance = Math.max(0, distance);
  }
  return distance;
}

export function checkDistance(t1: any, t2: any, distance: number, options: boolean | { wallsBlock?: boolean, includeCover?: boolean } = { wallsBlock: false, includeCover: true }): boolean {
  let wallsBlock: boolean, includeCover: boolean;
  if (typeof options === "boolean") {
    wallsBlock = options;
    includeCover = true;
    //@ts-expect-error
    foundry.utils.logCompatibilityWarning("checkDistance(t1,t2,wallsBlocking?) is deprecated in favor of checkDistance(t1,t2,{wallsBlock: Boolean, includeCover: Boolean}).", { since: "11.6.26", until: "12.4.10" });
  } else {
    ({ wallsBlock = false, includeCover = true } = options);
  }
  const dist = computeDistance(t1, t2, { wallsBlock, includeCover });
  return 0 <= dist && dist <= distance;
}

/** takes two tokens of any size and calculates the distance between them
*** gets the shortest distance betwen two tokens taking into account both tokens size
*** if wallblocking is set then wall are checked
**/

export function computeDistance(t1: any /*Token*/, t2: any /*Token*/, options: boolean | { wallsBlock?: boolean, includeCover?: boolean } = { wallsBlock: false, includeCover: true }): number {
  if (!canvas || !canvas.scene) return -1;
  if (!canvas.grid || !canvas.dimensions) return -1;
  t1 = getPlaceable(t1);
  t2 = getPlaceable(t2);
  if (!t1 || !t2) return -1;
  if (!canvas || !canvas.grid || !canvas.dimensions) return -1;
  let wallsBlock: boolean, includeCover: boolean;
  if (typeof options === "boolean") {
    wallsBlock = options;
    includeCover = true;
    //@ts-expect-error
    foundry.utils.logCompatibilityWarning("computeDistance(t1, t2, wallsBlock?: boolean) is deprecated in favor of computeDistance(t1, t2, { wallsBlock: boolean, includeCover: boolean }).", { since: "11.6.26", until: "12.4.10" });
  }
  else {
    ({ wallsBlock = false, includeCover = true } = options);
  }
  const actor = t1.actor;
  const ignoreWallsFlag = foundry.utils.getProperty(actor, `flags.${MODULE_ID}.ignoreWalls`);
  // get condition data & eval the property
  if (ignoreWallsFlag) {
    wallsBlock = false;
  }
  let t1DocWidth = t1.document.width ?? 1;
  if (t1DocWidth > 10) t1DocWidth = t1DocWidth / canvas.dimensions.size;
  let t1DocHeight = t1.document.height ?? 1;
  if (t1DocHeight > 10) t1DocHeight = t1DocHeight / canvas.dimensions.size;
  let t2DocWidth = t2.document.width ?? 1;
  if (t2DocWidth > 10) t2DocWidth = t2DocWidth / canvas.dimensions.size;
  let t2DocHeight = t2.document.height ?? 1;
  if (t2DocHeight > 10) t2DocHeight = t2DocHeight / canvas.dimensions.size;

  const t1StartX = t1DocWidth >= 1 ? 0.5 : t1DocWidth / 2;
  const t1StartY = t1DocHeight >= 1 ? 0.5 : t1DocHeight / 2;
  const t2StartX = t2DocWidth >= 1 ? 0.5 : t2DocWidth / 2;
  const t2StartY = t2DocHeight >= 1 ? 0.5 : t2DocHeight / 2;
  const t1Elevation = t1.document.elevation ?? 0;
  const t2Elevation = t2.document.elevation ?? 0;
  const t1TopElevation = t1Elevation + Math.max(t1DocHeight, t1DocWidth) * (canvas?.dimensions?.distance ?? 5);
  const t2TopElevation = t2Elevation + Math.min(t2DocHeight, t2DocWidth) * (canvas?.dimensions?.distance ?? 5); // assume t2 is trying to make itself small
  let coverVisible;
  // For levels autocover and simbul's cover calculator pre-compute token cover - full cover means no attack and so return -1
  // otherwise don't bother doing los checks they are overruled by the cover check
  if (installedModules.get("levelsautocover") && game.settings.get("levelsautocover", "apiMode") && wallsBlock && configSettings.optionalRules.wallsBlockRange === "levelsautocover" && includeCover) {
    //@ts-expect-error
    const levelsautocoverData = AutoCover.calculateCover(t1, t2, getLevelsAutoCoverOptions());
    coverVisible = levelsautocoverData.rawCover > 0;
    if (!coverVisible) return -1;
  } else if (globalThis.CoverCalculator && configSettings.optionalRules.wallsBlockRange === "simbuls-cover-calculator" && includeCover) {
    if (t1 === t2) return 0; // Simbul's throws an error when calculating cover for the same token
    const coverData = globalThis.CoverCalculator.Cover(t1, t2);
    if (debugEnabled > 0) warn("computeDistance | simbuls cover calculator ", t1.name, t2.name, coverData);
    if (coverData?.data.results.cover === 3 && wallsBlock) return -1;
    coverVisible = true;
  } else if (installedModules.get("tokencover") && configSettings.optionalRules.wallsBlockRange === "tokencover" && includeCover) {
    const coverValue = calcTokenCover(t1, t2);
    if (coverValue === 3 && wallsBlock) return -1;
    coverVisible = true;

  }

  var x, x1, y, y1, d, r, segments: { ray: Ray }[] = [], rdistance, distance;
  let heightDifference = 0;
  if (!(t2.document instanceof WallDocument)) {
    for (x = t1StartX; x < t1DocWidth; x++) {
      for (y = t1StartY; y < t1DocHeight; y++) {
        let origin;
        //@ts-expect-error
        if (game.release.generation > 11) {
          //@ts-expect-error
          const point = canvas.grid.getCenterPoint({ x: Math.round(t1.document.x + (canvas.dimensions.size * x)), y: Math.round(t1.document.y + (canvas.dimensions.size * y)) });
          origin = new PIXI.Point(point.x, point.y);
        } else
          origin = new PIXI.Point(...canvas.grid.getCenter(Math.round(t1.document.x + (canvas.dimensions.size * x)), Math.round(t1.document.y + (canvas.dimensions.size * y))));
        for (x1 = t2StartX; x1 < t2DocWidth; x1++) {
          for (y1 = t2StartY; y1 < t2DocHeight; y1++) {
            let dest;
            //@ts-expect-error
            if (game.release.generation > 11) {
              //@ts-expect-error
              const point = canvas.grid.getCenterPoint({ x: Math.round(t2.document.x + (canvas.dimensions.size * x1)), y: Math.round(t2.document.y + (canvas.dimensions.size * y1)) });
              dest = new PIXI.Point(point.x, point.y);
            } else
              dest = new PIXI.Point(...canvas.grid.getCenter(Math.round(t2.document.x + (canvas.dimensions.size * x1)), Math.round(t2.document.y + (canvas.dimensions.size * y1))));
            const r = new Ray(origin, dest);
            if (wallsBlock) {
              switch (configSettings.optionalRules.wallsBlockRange) {
                case "center":
                  let collisionCheck;

                  //@ts-expect-error polygonBackends
                  collisionCheck = CONFIG.Canvas.polygonBackends.move.testCollision(origin, dest, { source: t1.document, mode: "any", type: "move" })
                  if (collisionCheck) continue;
                  break;
                case "centerLevels":
                  // //@ts-expect-error
                  // TODO include auto cover calcs in checking console.error(AutoCover.calculateCover(t1, t2));
                  if (configSettings.optionalRules.wallsBlockRange === "centerLevels" && installedModules.get("levels")) {
                    if (coverVisible === false) continue;
                    if (coverVisible === undefined) {
                      let p1 = {
                        x: origin.x,
                        y: origin.y,
                        z: t1Elevation
                      }
                      let p2 = {
                        x: dest.x,
                        y: dest.y,
                        z: t2Elevation
                      }
                      //@ts-expect-error
                      const baseToBase = CONFIG.Levels.API.testCollision(p1, p2, "collision");
                      p1.z = t1TopElevation;
                      p2.z = t2TopElevation;
                      //@ts-expect-error
                      const topToBase = CONFIG.Levels.API.testCollision(p1, p2, "collision");
                      if (baseToBase && topToBase) continue;
                    }
                  } else {
                    let collisionCheck;
                    //@ts-expect-error polygonBackends
                    collisionCheck = CONFIG.Canvas.polygonBackends.move.testCollision(origin, dest, { source: t1.document, mode: "any", type: "move" })
                    if (collisionCheck) continue;
                  }
                  break;
                case "alternative":
                case "simbuls-cover-calculator":
                  if (coverVisible === undefined) {
                    let collisionCheck;
                    //@ts-expect-error polygonBackends
                    collisionCheck = CONFIG.Canvas.polygonBackends.sight.testCollision(origin, dest, { source: t1.document, mode: "any", type: "sight" })
                    if (collisionCheck) continue;
                  }
                  break;

                case "none":
                default:
              }
            }
            segments.push({ ray: r });
          }
        }
      }
    }
    if (segments.length === 0) {
      return -1;
    }
    rdistance = segments.map(ray => midiMeasureDistances([ray], { gridSpaces: true }));
    distance = Math.min(...rdistance);
    if (configSettings.optionalRules.distanceIncludesHeight) {
      let t1ElevationRange = Math.max(t1DocHeight, t1DocWidth) * (canvas?.dimensions?.distance ?? 5);
      if ((t2Elevation > t1Elevation && t2Elevation < t1TopElevation) || (t1Elevation > t2Elevation && t1Elevation < t2TopElevation)) {
        //check if bottom elevation of each token is within the other token's elevation space, if so make the height difference 0
        heightDifference = 0;
      }
      else if (t1Elevation < t2Elevation) { // t2 above t1
        heightDifference = Math.max(0, t2Elevation - t1TopElevation) + (canvas?.dimensions?.distance ?? 5);
      }
      else if (t1Elevation > t2Elevation) { // t1 above t2
        heightDifference = Math.max(0, t1Elevation - t2TopElevation) + (canvas?.dimensions?.distance ?? 5);
      }
    }
  } else {
    const w = t2.document
    let closestPoint;
    //@ts-expect-error
    if (game.release.generation === 11) {
      //@ts-expect-error
      closestPoint = foundry.utils.closestPointToSegment(t1.center, w.object.A, w.object.B);
    } else {
      //@ts-expect-error
      closestPoint = foundry.utils.closestPointToSegment(t1.center, w.object.edge.a, w.object.edge.b);
    }
    distance = midiMeasureDistances([{ ray: new Ray(t1.center, closestPoint) }], { gridSpaces: true });
    if (configSettings.optionalRules.distanceIncludesHeight) {
      if (!w.flags?.["wall-height"]) heightDifference = 0;
      else {
        const wh = w.flags?.["wall-height"]
        if (wh.top === null && wh.botton === null) heightDifference = 0;
        else if (wh.top === null) heightDifference = Math.max(0, wh.bottom - t1Elevation);
        else if (wh.bottom === null) heightDifference = Math.max(0, t1Elevation - wh.top);
        else heightDifference = Math.max(0, wh.bottom - t1TopElevation, t1Elevation - wh.top);
      }
    }
  }
  if (configSettings.optionalRules.distanceIncludesHeight) {

    //@ts-expect-error release
    if (game.release.generation < 12) {
      let rule = safeGetGameSetting("dnd5e", "diagonalMovement") ?? "EUCL"; // V12

      if (["555", "5105"].includes(rule)) {
        let nd = Math.min(distance, heightDifference);
        let ns = Math.abs(distance - heightDifference);
        distance = nd + ns;
        let dimension = canvas?.dimensions?.distance ?? 5;
        if (rule === "5105") distance = distance + Math.floor(nd / 2 / dimension) * dimension;
      } else {
        distance = Math.sqrt(heightDifference * heightDifference + distance * distance);
      }
    } else { // TODO experimental
      let nd = Math.min(distance, heightDifference);
      let ns = Math.abs(distance - heightDifference);
      // distance = nd + ns;
      let dimension = canvas?.dimensions?.distance ?? 5;
      let diagonals = safeGetGameSetting("core", "gridDiagonals");
      //@ts-expect-error GRID_DIAGONALS
      const GRID_DIAGONALS = CONST.GRID_DIAGONALS;
      // Determine the offset distance of the diagonal moves
      let cd;
      switch (diagonals) {
        case GRID_DIAGONALS.EQUIDISTANT: cd = nd; break;
        case GRID_DIAGONALS.EXACT: cd = Math.SQRT2 * nd; break;
        case GRID_DIAGONALS.APPROXIMATE: cd = 1.5 * nd; break;
        case GRID_DIAGONALS.RECTILINEAR: cd = 2 * nd; break;
        case GRID_DIAGONALS.ALTERNATING_1:
          // TODO get the diagonals return from MidiMeasureDistances
          // if ( result.diagonals & 1 ) cd = ((nd + 1) & -2) + (nd >> 1);
          // else cd = (nd & -2) + ((nd + 1) >> 1);
          cd = ((nd + 1) & -2) + (nd >> 1);
          break;
        case GRID_DIAGONALS.ALTERNATING_2:
          // TODO get the diagonals return from MidiMeasureDistances
          // if ( result.diagonals & 1 ) cd = (nd & -2) + ((nd + 1) >> 1);
          //  else cd = ((nd + 1) & -2) + (nd >> 1);
          cd = ((nd + 1) & -2) + (nd >> 1);
          break;
        case GRID_DIAGONALS.ILLEGAL:
          // Don't think I want this to be done
          cd = 2 * nd;
          nd = 0;
          // n = di + dj;
          ns = distance + heightDifference;
          break;
      }
      distance = ns + cd;

    }
  }
  return distance;
};

let pointWarn = foundry.utils.debounce(() => {
  ui.notifications?.warn("4 Point LOS check selected but dnd5e-helpers not installed")
}, 100)

export function checkActivityRange(activityIn, tokenRef: Token | TokenDocument | string | undefined, targetsRef: Set<Token | TokenDocument | string> | undefined, showWarning: boolean = true): { result: string, attackingToken?: Token, range?: number | undefined, longRange?: number | undefined } {
  if (!canvas || !canvas.scene) return { result: "normal" };
  const checkRangeFunction = (activity, token, targets): { result: string, reason?: string, range?: number | undefined, longRange?: number | undefined } => {
    if (!canvas || !canvas.scene) return {
      result: "normal",
    }
    // check that a range is specified at all
    if (!activity.range) return {
      result: "normal",
    };

    if (!token) {
      if (debugEnabled > 0) warn(`checkRange | ${game.user?.name} no token selected cannot check range`)
      return {
        result: "fail",
        reason: `${game.user?.name} no token selected`,
      }
    }

    let actor = token.actor;
    // look at undefined versus !
    if (!(activity.range.value ?? activity.range.reach) && !activity.range.long && activity.range.units !== "touch") return {
      result: "normal",
      reason: "no range specified"
    };
    if (activity.target?.affects.type === "self") return {
      result: "normal",
      reason: "self attack",
      range: 0
    };
    // skip non mwak/rwak/rsak/msak types that do not specify a target type
    if (!allAttackTypes.includes(activity.actionType) && !["creature", "ally", "enemy"].includes(activity.target?.affects.type)) return {
      result: "normal",
      reason: "not an attack"
    };

    const attackType = activity.actionType;
    let range = (activity.range?.value ?? activity.range?.reach ?? 0);
    let longRange = (activity.range?.long ?? 0);
    if (activity.actor?.system) { // TODO revisit when/if flags move to activities
      let conditionData;
      let rangeBonus = foundry.utils.getProperty(activity.actor, `flags.${MODULE_ID}.range.${attackType}`) ?? "0"
      rangeBonus = rangeBonus + " + " + (foundry.utils.getProperty(activity.actor, `flags.${MODULE_ID}.range.all`) ?? "0");
      if (rangeBonus !== "0 + 0") {
        conditionData = createConditionData({ item: activity.item, activity, actor: activity.actor, target: token })
        const bonusValue = evalCondition(rangeBonus, conditionData, { errorReturn: 0, async: false });
        range = Math.max(0, range + bonusValue);
      };
      let longRangeBonus = foundry.utils.getProperty(activity.actor, `flags.${MODULE_ID}.long.${attackType}`) ?? "0"
      longRangeBonus = longRangeBonus + " + " + (foundry.utils.getProperty(activity.actor, `flags.${MODULE_ID}.long.all`) ?? "0");
      if (longRangeBonus !== "0 + 0") {
        if (!conditionData)
          conditionData = createConditionData({ item: activity.item, actor: activity.actor, activity, target: token })
        const bonusValue = evalCondition(longRangeBonus, conditionData, { errorReturn: 0, async: false });
        longRange = Math.max(0, longRange + bonusValue);
      };
    }
    if (longRange > 0 && longRange < range) longRange = range;
    if (activity.range?.units) {
      switch (activity.range.units) {
        case "mi": // miles - assume grid units are feet or miles - ignore furlongs/chains whatever
          //@ts-expect-error
          if (["feet", "ft"].includes(canvas?.scene?.grid.units?.toLocaleLowerCase())) {
            range *= 5280;
            longRange *= 5280;
            //@ts-expect-error
          } else if (["yards", "yd", "yds"].includes(canvas?.scene?.grid.units?.toLocaleLowerCase())) {
            range *= 1760;
            longRange *= 1760;
          }
          break;
        case "km": // kilometeres - assume grid units are meters or kilometers
          //@ts-expect-error
          if (["meter", "m", "meters", "metre", "metres"].includes(canvas?.scene?.grid.units?.toLocaleLowerCase())) {
            range *= 1000;
            longRange *= 1000;
          }
          break;
        // "none" "self" "ft" "m" "any" "spec":
        default:
          break;
      }
    }
    if (foundry.utils.getProperty(actor, `flags.${MODULE_ID}.sharpShooter`) && range < longRange) range = longRange;
    if (activity.actionType === "rsak" && foundry.utils.getProperty(actor, "flags.dnd5e.spellSniper")) {
      range = 2 * range;
      longRange = 2 * longRange;
    }
    if (activity.range.units === "touch") {
      range = canvas?.dimensions?.distance ?? 5;
      if (activity.item.system.properties?.has("rch")) range += canvas?.dimensions?.distance ?? 5;
      longRange = 0;
    }

    if (["mwak", "msak", "mpak"].includes(activity.actionType) && !activity.properties?.has("thr")) longRange = 0;
    for (let target of targets) {
      if (target === token) continue;
      // check if target is burrowing
      if (configSettings.optionalRules.wallsBlockRange !== 'none'
        && globalThis.MidiQOL.WallsBlockConditions.some(status => hasCondition(target.actor, status))) {
        return {
          result: "fail",
          reason: `${actor.name}'s has one or more of ${globalThis.MidiQOL.WallsBlockConditions} so can't be targeted`,
          range,
          longRange
        }
      }
      // check the range TODO reivew total cover flag and activity as part of midi properties
      const ignoreTotalCover = foundry.utils.getProperty(activity.item, "flags.midiProperties.ignoreTotalCover");
      const distance = computeDistance(token, target, { wallsBlock: configSettings.optionalRules.wallsBlockRange && !ignoreTotalCover, includeCover: !ignoreTotalCover });

      if ((longRange !== 0 && distance > longRange) || (distance > range && longRange === 0)) {
        log(`${target.name} is too far ${distance} from your character you cannot hit`)
        if (checkMechanic("checkRange") === "longdisadv" && ["rwak", "rsak", "rpak"].includes(activity.actionType)) {
          return {
            result: "dis",
            reason: `${actor.name}'s target is ${Math.round(distance * 10) / 10} away and your range is only ${longRange || range}`,
            range,
            longRange
          }
        } else {
          return {
            result: "fail",
            reason: `${actor.name}'s target is ${Math.round(distance * 10) / 10} away and your range is only ${longRange || range}`,
            range,
            longRange
          }
        }
      }
      if (distance > range) return {
        result: "dis",
        reason: `${actor.name}'s target is ${Math.round(distance * 10) / 10} away and your range is only ${longRange || range}`,
        range,
        longRange
      }
      if (distance < 0) {
        log(`${target.name} is blocked by a wall`)
        return {
          result: "fail",
          reason: `${actor.name}'s target is blocked by a wall`,
          range,
          longRange
        }
      }
    }
    return {
      result: "normal",
      range,
      longRange
    }
  }

  const tokenIn = getToken(tokenRef);
  //@ts-expect-error .map
  const targetsIn = targetsRef?.map(t => getToken(t));
  if (!tokenIn || !targetsIn) return { result: "fail", attackingToken: undefined };
  let attackingToken = tokenIn;
  if (!canvas || !canvas.tokens || !tokenIn || !targetsIn) return {
    result: "fail",
    attackingToken: tokenIn,
  }

  let canOverride = foundry.utils.getProperty(tokenIn.actor ?? {}, `flags.${MODULE_ID}.rangeOverride.attack.all`) || foundry.utils.getProperty(tokenIn.actor ?? {}, `flags.${MODULE_ID}.rangeOverride.attack.${activityIn.actionType}`)
  if (typeof canOverride === "string") {
    const conditionData = createConditionData({ item: activityIn.item, activity: activityIn, actor: tokenIn.actor });
    canOverride = evalCondition(canOverride, conditionData)
  }

  const { result, reason, range, longRange } = checkRangeFunction(activityIn, attackingToken, targetsIn);
  if (!canOverride) { // no overrides so just do the check
    if (result === "fail" && reason) {
      if (showWarning) ui.notifications?.warn(reason);
    }
    return { result, attackingToken, range, longRange }
  }

  const ownedTokens = canvas.tokens.ownedTokens;
  // Initial Check
  // Now we loop through all owned tokens
  let possibleAttackers: Token[] = ownedTokens.filter(t => {
    let canOverride = foundry.utils.getProperty(t.actor ?? {}, `flags.${MODULE_ID}.rangeOverride.attack.all`) || foundry.utils.getProperty(t.actor ?? {}, `flags.${MODULE_ID}.rangeOverride.attack.${activityIn.actionType}`)
    if (typeof canOverride === "string") {
      const conditionData = createConditionData({ item: activityIn.item, activity: activityIn, actor: t.actor });
      canOverride = evalCondition(canOverride, conditionData)
    }
    return canOverride;
  });

  const successToken = possibleAttackers.find(attacker => checkRangeFunction(activityIn, attacker, targetsIn).result === "normal");
  if (successToken) return { result: "normal", attackingToken: successToken, range, longRange };
  // TODO come back and fix this: const disToken = possibleAttackers.find(attacker => checkRangeFunction(itemIn, attacker, targetsIn).result === "dis");
  return { result: "fail", attackingToken, range, longRange };
}

export function checkRange(itemIn, tokenRef: Token | TokenDocument | string | undefined, targetsRef: Set<Token | TokenDocument | string> | undefined, showWarning: boolean = true): { result: string, attackingToken?: Token, range?: number | undefined, longRange?: number | undefined } {
  //@ts-expect-error
  foundry.utils.logCompatibilityWarning("checkRange(item, token, targets, showWarning) is deprecated and will be removed in Version 14. "
    + "Use checkActivityRange(activity, token, targets, showWarning) instead.",
    { since: 12.1, until: 12.5, once: true });
  if (!canvas || !canvas.scene) return { result: "normal" };
  const checkRangeFunction = (item, token, targets): { result: string, reason?: string, range?: number | undefined, longRange?: number | undefined } => {
    if (!canvas || !canvas.scene) return {
      result: "normal",
    }
    // check that a range is specified at all
    if (!item.system.range) return {
      result: "normal",
    };

    if (!token) {
      if (debugEnabled > 0) warn(`checkRange | ${game.user?.name} no token selected cannot check range`)
      return {
        result: "fail",
        reason: `${game.user?.name} no token selected`,
      }
    }

    let actor = token.actor;
    // look at undefined versus !
    if (!(item.system.range.value ?? item.system.range.reach) && !item.system.range.long && item.system.range.units !== "touch") return {
      result: "normal",
      reason: "no range specified"
    };
    if (item.system.target?.type === "self") return {
      result: "normal",
      reason: "self attack",
      range: 0
    };
    // skip non mwak/rwak/rsak/msak types that do not specify a target type
    if (!allAttackTypes.includes(item.system.actionType) && !["creature", "ally", "enemy"].includes(item.system.target?.type)) return {
      result: "normal",
      reason: "not an attack"
    };

    const attackType = item.system.actionType;
    let range = (item.system.range?.value ?? item.system.range?.reach ?? 0);
    let longRange = (item.system.range?.long ?? 0);
    if (item.parent?.system) {
      let conditionData;
      let rangeBonus = foundry.utils.getProperty(item.parent, `flags.${MODULE_ID}.range.${attackType}`) ?? "0"
      rangeBonus = rangeBonus + " + " + (foundry.utils.getProperty(item.parent, `flags.${MODULE_ID}.range.all`) ?? "0");
      if (rangeBonus !== "0 + 0") {
        conditionData = createConditionData({ item, actor: item.parent, target: token })
        const bonusValue = evalCondition(rangeBonus, conditionData, { errorReturn: 0, async: false });
        range = Math.max(0, range + bonusValue);
      };
      let longRangeBonus = foundry.utils.getProperty(item.parent, `flags.${MODULE_ID}.long.${attackType}`) ?? "0"
      longRangeBonus = longRangeBonus + " + " + (foundry.utils.getProperty(item.parent, `flags.${MODULE_ID}.long.all`) ?? "0");
      if (longRangeBonus !== "0 + 0") {
        if (!conditionData)
          conditionData = createConditionData({ item, actor: item.parent, target: token })
        const bonusValue = evalCondition(longRangeBonus, conditionData, { errorReturn: 0, async: false });
        longRange = Math.max(0, longRange + bonusValue);
      };
    }
    if (longRange > 0 && longRange < range) longRange = range;
    if (item.system.range?.units) {
      switch (item.system.range.units) {
        case "mi": // miles - assume grid units are feet or miles - ignore furlongs/chains whatever
          //@ts-expect-error
          if (["feet", "ft"].includes(canvas?.scene?.grid.units?.toLocaleLowerCase())) {
            range *= 5280;
            longRange *= 5280;
            //@ts-expect-error
          } else if (["yards", "yd", "yds"].includes(canvas?.scene?.grid.units?.toLocaleLowerCase())) {
            range *= 1760;
            longRange *= 1760;
          }
          break;
        case "km": // kilometeres - assume grid units are meters or kilometers
          //@ts-expect-error
          if (["meter", "m", "meters", "metre", "metres"].includes(canvas?.scene?.grid.units?.toLocaleLowerCase())) {
            range *= 1000;
            longRange *= 1000;
          }
          break;
        // "none" "self" "ft" "m" "any" "spec":
        default:
          break;
      }
    }
    if (foundry.utils.getProperty(actor, `flags.${MODULE_ID}.sharpShooter`) && range < longRange) range = longRange;
    if (item.system.actionType === "rsak" && foundry.utils.getProperty(actor, "flags.dnd5e.spellSniper")) {
      range = 2 * range;
      longRange = 2 * longRange;
    }
    if (item.system.range.units === "touch") {
      range = canvas?.dimensions?.distance ?? 5;
      if (item.system.properties?.has("rch")) range += canvas?.dimensions?.distance ?? 5;
      longRange = 0;
    }

    if (["mwak", "msak", "mpak"].includes(item.system.actionType) && !item.system.properties?.has("thr")) longRange = 0;
    for (let target of targets) {
      if (target === token) continue;
      // check if target is burrowing
      if (configSettings.optionalRules.wallsBlockRange !== 'none'
        && globalThis.MidiQOL.WallsBlockConditions.some(status => hasCondition(target.actor, status))) {
        return {
          result: "fail",
          reason: `${actor.name}'s has one or more of ${globalThis.MidiQOL.WallsBlockConditions} so can't be targeted`,
          range,
          longRange
        }
      }
      // check the range
      const ignoreTotalCover = foundry.utils.getProperty(item, "flags.midiProperties.ignoreTotalCover");
      const distance = computeDistance(token, target, { wallsBlock: configSettings.optionalRules.wallsBlockRange, includeCover: !ignoreTotalCover });

      if ((longRange !== 0 && distance > longRange) || (distance > range && longRange === 0)) {
        log(`${target.name} is too far ${distance} from your character you cannot hit`)
        if (checkMechanic("checkRange") === "longdisadv" && ["rwak", "rsak", "rpak"].includes(item.system.actionType)) {
          return {
            result: "dis",
            reason: `${actor.name}'s target is ${Math.round(distance * 10) / 10} away and your range is only ${longRange || range}`,
            range,
            longRange
          }
        } else {
          return {
            result: "fail",
            reason: `${actor.name}'s target is ${Math.round(distance * 10) / 10} away and your range is only ${longRange || range}`,
            range,
            longRange
          }
        }
      }
      if (distance > range) return {
        result: "dis",
        reason: `${actor.name}'s target is ${Math.round(distance * 10) / 10} away and your range is only ${longRange || range}`,
        range,
        longRange
      }
      if (distance < 0) {
        log(`${target.name} is blocked by a wall`)
        return {
          result: "fail",
          reason: `${actor.name}'s target is blocked by a wall`,
          range,
          longRange
        }
      }
    }
    return {
      result: "normal",
      range,
      longRange
    }
  }

  const tokenIn = getToken(tokenRef);
  //@ts-expect-error .map
  const targetsIn = targetsRef?.map(t => getToken(t));
  if (!tokenIn || !targetsIn) return { result: "fail", attackingToken: undefined };
  let attackingToken = tokenIn;
  if (!canvas || !canvas.tokens || !tokenIn || !targetsIn) return {
    result: "fail",
    attackingToken: tokenIn,
  }

  let canOverride = foundry.utils.getProperty(tokenIn.actor ?? {}, `flags.${MODULE_ID}.rangeOverride.attack.all`) || foundry.utils.getProperty(tokenIn.actor ?? {}, `flags.${MODULE_ID}.rangeOverride.attack.${itemIn.system.actionType}`)
  if (typeof canOverride === "string") {
    const conditionData = createConditionData({ item: itemIn, actor: tokenIn.actor });
    canOverride = evalCondition(canOverride, conditionData)
  }

  const { result, reason, range, longRange } = checkRangeFunction(itemIn, attackingToken, targetsIn);
  if (!canOverride) { // no overrides so just do the check
    if (result === "fail" && reason) {
      if (showWarning) ui.notifications?.warn(reason);
    }
    return { result, attackingToken, range, longRange }
  }

  const ownedTokens = canvas.tokens.ownedTokens;
  // Initial Check
  // Now we loop through all owned tokens
  let possibleAttackers: Token[] = ownedTokens.filter(t => {
    let canOverride = foundry.utils.getProperty(t.actor ?? {}, `flags.${MODULE_ID}.rangeOverride.attack.all`) || foundry.utils.getProperty(t.actor ?? {}, `flags.${MODULE_ID}.rangeOverride.attack.${itemIn.system.actionType}`)
    if (typeof canOverride === "string") {
      const conditionData = createConditionData({ item: itemIn, actor: t.actor });
      canOverride = evalCondition(canOverride, conditionData)
    }
    return canOverride;
  });

  const successToken = possibleAttackers.find(attacker => checkRangeFunction(itemIn, attacker, targetsIn).result === "normal");
  if (successToken) return { result: "normal", attackingToken: successToken, range, longRange };
  // TODO come back and fix this: const disToken = possibleAttackers.find(attacker => checkRangeFunction(itemIn, attacker, targetsIn).result === "dis");
  return { result: "fail", attackingToken, range, longRange };
}

function getLevelsAutoCoverOptions(): any {
  const options: any = {};
  options.tokensProvideCover = game.settings.get("levelsautocover", "tokensProvideCover");
  options.ignoreFriendly = game.settings.get("levelsautocover", "ignoreFriendly");
  options.copsesProvideCover = game.settings.get("levelsautocover", "copsesProvideCover");
  options.tokenCoverAA = game.settings.get("levelsautocover", "tokenCoverAA");
  // options.coverData ?? this.getCoverData();
  options.precision = game.settings.get("levelsautocover", "coverRestriction");
  return options;
}

export const FULL_COVER = 999;
export const THREE_QUARTERS_COVER = 5;
export const HALF_COVER = 2;

export function computeCoverBonus(attacker: Token | TokenDocument, target: Token | TokenDocument, activity: any = undefined) {
  let existingCoverBonus = foundry.utils.getProperty(target, `actor.flags.${MODULE_ID}.acBonus`) ?? 0;
  let item = activity?.item;
  if (!attacker) return existingCoverBonus;
  let coverBonus = 0;
  try {
    //@ts-expect-error .Levels
    let levelsAPI = CONFIG.Levels?.API;
    switch (configSettings.optionalRules.coverCalculation) {
      case "levelsautocover":
        //@ts-expect-error
        if (!installedModules.get("levelsautocover") || !game.settings.get("levelsautocover", "apiMode") || !AutoCover) return 0;
        //@ts-expect-error
        const coverData = AutoCover.calculateCover(attacker.document ? attacker : attacker.object, target.document ? target : target.object);
        // const coverData = AutoCover.calculateCover(attacker, target, {DEBUG: true});
        //@ts-expect-error
        const coverDetail = AutoCover.getCoverData();
        if (coverData.rawCover === 0) coverBonus = FULL_COVER;
        else if (coverData.rawCover > coverDetail[1].percent) coverBonus = 0;
        else if (coverData.rawCover < coverDetail[0].percent) coverBonus = THREE_QUARTERS_COVER;
        else if (coverData.rawCover < coverDetail[1].percent) coverBonus = HALF_COVER;
        if (coverData.obstructingToken) coverBonus = Math.max(2, coverBonus);
        console.log("midi-qol | ComputerCoverBonus - For token ", attacker.name, " attacking ", target.name, " cover data is ", coverBonus, coverData, coverDetail)
        break;
      case "simbuls-cover-calculator":
        if (!installedModules.get("simbuls-cover-calculator")) return 0;
        if (globalThis.CoverCalculator) {
          //@ts-expect-error
          const coverData = globalThis.CoverCalculator.Cover(attacker.document ? attacker : attacker.object, target);
          if (attacker === target) {
            coverBonus = 0;
            break;
          }
          if (coverData?.data?.results.cover === 3) coverBonus = FULL_COVER;
          else coverBonus = -coverData?.data?.results.value ?? 0;
          console.log("midi-qol | ComputeCover Bonus - For token ", attacker.name, " attacking ", target.name, " cover data is ", coverBonus, coverData)
        }
        break;
      case "tokencover":
        if (!installedModules.get("tokencover")) coverBonus = 0;
        else {
          const coverValue = calcTokenCover(attacker, target);
          if (coverValue === 4 || coverValue === 3) coverBonus = FULL_COVER;
          else if (coverValue === 2) coverBonus = THREE_QUARTERS_COVER;
          else if (coverValue === 1) coverBonus = HALF_COVER;
          else coverBonus = 0;
        }
        break;
      case "none":
      default:
        coverBonus = 0;
        break;
    }

    if (item?.flags?.midiProperties?.ignoreTotalCover && item.type === "spell") coverBonus = 0;
    else if (item?.flags?.midiProperties?.ignoreTotalCover && coverBonus === FULL_COVER) coverBonus = THREE_QUARTERS_COVER;
    if (item?.system.actionType === "rwak" && attacker.actor && foundry.utils.getProperty(attacker.actor, `flags.${MODULE_ID}.sharpShooter`) && coverBonus !== FULL_COVER)
      coverBonus = 0;
    if (["rsak"/*, rpak*/].includes(item?.system.actionType) && attacker.actor && foundry.utils.getProperty(attacker.actor, "flags.dnd5e.spellSniper") && coverBonus !== FULL_COVER)
      coverBonus = 0;
    if (target.actor && coverBonus > existingCoverBonus)
      foundry.utils.setProperty(target.actor, `flags.${MODULE_ID}.acBonus`, coverBonus);
    else coverBonus = existingCoverBonus;
    return coverBonus;
  } catch (err) {
    const message = "Error in computeCoverBonus";
    error(message, err);
    TroubleShooter.recordError(err, message)
    return 0;
  }
}
export function isAutoFastAttack(workflow: Workflow | undefined = undefined): boolean {
  if (workflow?.workflowOptions?.autoFastAttack !== undefined) return workflow.workflowOptions.autoFastAttack;
  if (workflow && workflow.workflowType === "DummyWorkflow") return workflow.rollOptions.fastForward;
  return game.user?.isGM ? configSettings.gmAutoFastForwardAttack : ["all", "attack"].includes(configSettings.autoFastForward);
}

export function isAutoFastDamage(workflow: Workflow | undefined = undefined): boolean {
  if (workflow?.workflowOptions?.autoFastDamage !== undefined) return workflow.workflowOptions.autoFastDamage;
  if (workflow?.workflowType === "DummyWorkflow") return workflow.rollOptions.fastForwardDamage;
  return game.user?.isGM ? configSettings.gmAutoFastForwardDamage : ["all", "damage"].includes(configSettings.autoFastForward)
}

export function isAutoConsumeResource(workflow: Workflow | undefined = undefined): string {
  if (workflow?.workflowOptions.autoConsumeResource !== undefined) return workflow?.workflowOptions.autoConsumeResource;
  return game.user?.isGM ? configSettings.gmConsumeResource : configSettings.consumeResource;
}

export function getAutoRollDamage(workflow: Workflow | undefined = undefined): string {
  if (workflow?.actor.type === configSettings.averageDamage || configSettings.averageDamage === "all") return "onHit";
  if (workflow?.workflowOptions?.autoRollDamage) {
    const damageOptions = Object.keys(geti18nOptions("autoRollDamageOptions"));
    if (damageOptions.includes(workflow.workflowOptions.autoRollDamage))
      return workflow.workflowOptions.autoRollDamage;
    console.warn(`midi-qol | getAutoRollDamage | could not find ${workflow.workflowOptions.autoRollDamage} workflowOptions.autoRollDamage must be ond of ${damageOptions} defaulting to "onHit"`)
    return "onHit";
  }
  return game.user?.isGM ? configSettings.gmAutoDamage : configSettings.autoRollDamage;
}

export function getAutoRollAttack(workflow: Workflow | undefined = undefined): boolean {
  if (workflow?.workflowOptions?.autoRollAttack !== undefined) {
    return workflow.workflowOptions.autoRollAttack;
  }

  return game.user?.isGM ? configSettings.gmAutoAttack : configSettings.autoRollAttack;
}

export function getTargetConfirmation(workflow: Workflow | undefined = undefined): string {
  if (workflow?.workflowOptions?.targetConfirmation !== undefined) return workflow?.workflowOptions?.targetConfirmation;
  return targetConfirmation;
}


export function activityHasDamage(activity) {
  return activity.damage?.parts?.length > 0;
}
export function itemHasDamage(item) {
  return item?.system.damage?.base?.formula;
}

export function itemIsVersatile(item) {
  return item?.system.properties?.has("ver");
}

export function getRemoveAttackButtons(item?: Item): boolean {
  if (item) {
    const itemSetting = foundry.utils.getProperty(item, `flags.${MODULE_ID}.removeAttackDamageButtons`);
    if (itemSetting) {
      if (["all", "attack"].includes(itemSetting)) return true;
      if (itemSetting !== "default") return false;
    }
  }
  return game.user?.isGM ?
    ["all", "attack"].includes(configSettings.gmRemoveButtons) :
    ["all", "attack"].includes(configSettings.removeButtons);
}
export function getRemoveDamageButtons(item?: Item): boolean {
  if (item) {
    const itemSetting = foundry.utils.getProperty(item, `flags.${MODULE_ID}.removeAttackDamageButtons`);
    if (itemSetting) {
      if (["all", "damage"].includes(itemSetting)) return true;
      if (itemSetting !== "default") return false;
    }
  }
  return game.user?.isGM ?
    ["all", "damage"].includes(configSettings.gmRemoveButtons) :
    ["all", "damage"].includes(configSettings.removeButtons);
}

export function getReactionSetting(player: User | null | undefined): string {
  if (!player) return "none";
  return player.isGM ? configSettings.gmDoReactions : configSettings.doReactions;
}

export function getTokenPlayerName(token: TokenDocument | Token, checkGM: boolean = false) {
  if (!token) return game.user?.name;
  let name = getTokenName(token);
  if (checkGM && game.user?.isGM) return name;
  if (game.modules.get("anonymous")?.active) {
    //@ts-expect-error .api
    const api = game.modules.get("anonymous")?.api;
    if (api.playersSeeName(token.actor)) return name;
    else return api.getName(token.actor);
  }
  return name;
}

export function getSpeaker(actor) {
  const speaker = ChatMessage.getSpeaker({ actor });
  if (!configSettings.useTokenNames) return speaker;
  let token = actor.token;
  if (!token) token = actor.getActiveTokens()[0];
  if (token) speaker.alias = token.name;
  return speaker
}

export interface ConcentrationData {
  item: any;
  targets: Set<Token>;
  templateUuid?: string;
  removeUuids?: string[];
  templates?: string[];
}

export async function addConcentration(actorRef: Actor | string, concentrationData: ConcentrationData) {
  const actor = getActor(actorRef);
  if (!actor) return;
  if (debugEnabled > 0) warn("addConcentration", actor.name, concentrationData);
  const concentrationEffect = await addConcentrationEffect(actor, concentrationData);
  await setConcentrationData(actor, concentrationData);
}

// Add the concentration marker to the character and update the duration if possible
export async function addConcentrationEffect(actor, concentrationData: ConcentrationData) {
  let duration = {};
  let item = concentrationData.item;
  let selfTarget = actor.token ? actor.token.object : getTokenForActor(actor);
  const inCombat = (game.combat?.turns.some(combatant => combatant.token?.id === selfTarget?.id));
  const convertedDuration = globalThis.DAE.convertDuration(item?.system.duration, inCombat);
  if (convertedDuration?.type === "seconds") {
    duration = { seconds: convertedDuration.seconds, startTime: game.time.worldTime }
  } else if (convertedDuration?.type === "turns") {
    duration = {
      rounds: convertedDuration.rounds,
      turns: convertedDuration.turns,
      startRound: game.combat?.round,
      startTurn: game.combat?.turn
    }
  }
  const effectData = { duration };
  return actor.beginConcentrating(concentrationData.item, effectData)
}

export async function setConcentrationData(actor, concentrationData: ConcentrationData) {
  if (!actor) return;
  const dnd5eTargets: any = [];
  if (concentrationData.item instanceof Item)
    concentrationData.item = concentrationData.item.uuid;
  const sourceItem = MQfromUuidSync(concentrationData.item);
  let selfTargeted = false;
  let targets: { tokenUuid: string | undefined, actorUuid: string | undefined }[] = [];
  let concentrationEffect = getConcentrationEffect(actor, sourceItem);

  if (concentrationData.targets) {
    const selfTargetUuid = actor.uuid;
    for (let hit of concentrationData.targets) {
      const tokenUuid = hit.document?.uuid ?? hit.uuid;
      const actorUuid = hit.actor?.uuid ?? "";
      targets.push({ tokenUuid, actorUuid });
      if (selfTargetUuid === actorUuid)
        selfTargeted = true;
      if (concentrationEffect) {
        const effects = hit.actor?.effects.filter(e =>
          //@ts-expect-error
          e.origin === concentrationData.item && e.uuid !== concentrationEffect.uuid);
        if (effects?.length) {
          for (let effect of effects) {
            //@ts-expect-error origin
            if (effect.origin !== concentrationEffect.uuid)
              await effect.update({ origin: concentrationEffect.uuid });
          }
        }
        let effectIds = effects?.map(e => ({ uuid: e.uuid }));
        if (effectIds?.length)
          dnd5eTargets.push(...effectIds);
      }
    }
  }
  if (!selfTargeted) {
    let selfTarget = actor.token ? actor.token.object : getTokenForActor(actor);
    targets.push({ tokenUuid: selfTarget.uuid, actorUuid: actor.uuid });
  }
  let templates: string[] = concentrationData.templates ?? [];
  if (concentrationData.templateUuid) templates.push(concentrationData.templateUuid)

  if (concentrationEffect) { //duplicate the concentration data into the effect dependents
    //@ts-expect-error
    let dependents = concentrationEffect.getDependents().map(e => e.uuid);
    dependents = [...dependents, ...dnd5eTargets, ...templates, ...concentrationData.removeUuids ?? []];
    dependents = dependents.map(d => ({ uuid: d.uuid ?? d.actorUuid ?? d }));
    //@ts-expect-error
    await concentrationEffect.setDependents(dependents);
  }
}

/** 
 * Find tokens nearby
 * @param {number|null} disposition. same(1), opposite(-1), neutral(0), ignore(null) token disposition
 * @param {Token} token The token to search around
 * @param {number} distance in game units to consider near
 * @param {options} canSee Require that the potential target can sense the token
 * @param {options} isSeen Require that the token can sense the potential target
 * @param {options} includeIcapacitated: boolean count incapacitated tokens
 */

function mapTokenString(disposition: string | number): number | null {
  if (typeof disposition === "number") return disposition
  if (disposition.toLocaleLowerCase().trim() === i18n("TOKEN.DISPOSITION.FRIENDLY").toLocaleLowerCase()) return 1;
  else if (disposition.toLocaleLowerCase().trim() === i18n("TOKEN.DISPOSITION.HOSTILE").toLocaleLowerCase()) return -1;
  else if (disposition.toLocaleLowerCase().trim() === i18n("TOKEN.DISPOSITION.NEUTRAL").toLocaleLowerCase()) return 0;
  else if (disposition.toLocaleLowerCase().trim() === i18n("TOKEN.DISPOSITION.SECRET").toLocaleLowerCase()) return -2;
  else if (disposition.toLocaleLowerCase().trim() === i18n("all").toLocaleLowerCase()) return null;
  const validStrings = ["TOKEN.DISPOSITION.FRIENDLY", "TOKEN.DISPOSITION.HOSTILE", "TOKEN.DISPOSITION.NEUTRAL", "TOKEN.DISPOSITION.SECRET", "all"].map(s => i18n(s))
  throw new Error(`Midi-qol | findNearby ${disposition} is invalid. Disposition must be one of "${validStrings}"`)
}

export function findNearbyCount(disposition: number | string | null | Array<string | number>, token: any /*Token | uuuidString */, distance: number,
  options: { maxSize: number | undefined, includeIncapacitated: boolean | undefined, canSee: boolean | undefined, isSeen: boolean | undefined, includeToken: boolean | undefined, relative: boolean | undefined } = { maxSize: undefined, includeIncapacitated: false, canSee: false, isSeen: false, includeToken: false, relative: true }): number {
  return findNearby(disposition, token, distance, options)?.length ?? 0;
}

/**
 * findNearby
 * @param {number} [disposition]          What disposition to match - one of CONST.TOKEN.DISPOSITIONS
 
 * @param {string} [disposition]          What disposition to match - one of (localize) Friendly, Neutral, Hostile, Secret, all
 * @param {null} [disposition]            Match any disposition
 * @param {Array<string>} [disposition]   Match any of the dispostion strings
 * @param {Array<number>} [disposition]   Match any of the disposition numbers
 * @param {Token} [token]                 The token to use for the search
 * @param {string} [token]                A token UUID
 * @param {number} [distance]             The distance from token that will match
 * @param {object} [options]
 * @param {number} [options.MaxSize]      Only match tokens whose width * length < MaxSize
 * @param {boolean} [includeIncapacitated]  Should incapacitated actors be include?
 * @param {boolean} [canSee]              Must the potential target be able to see the token?
 * @param {boolean} isSeen                Must the token token be able to see the potential target?
 * @param {boolean} [includeToken]        Include token in the return array?
 * @param {boolean} [relative]            If set, the specified disposition is compared with the token disposition. 
 *  A specified dispostion of HOSTILE and a token disposition of HOSTILE means find tokens whose disposition is FRIENDLY

*/

export function findNearby(disposition: number | string | null | Array<string | number>, token: any /*Token | uuuidString */, distance: number,
  options: { maxSize: number | undefined, includeIncapacitated: boolean | undefined, canSee: boolean | undefined, isSeen: boolean | undefined, includeToken: boolean | undefined, relative: boolean | undefined } = { maxSize: undefined, includeIncapacitated: false, canSee: false, isSeen: false, includeToken: false, relative: true }): Token[] {
  token = getToken(token);
  if (!token) return [];
  if (!canvas || !canvas.scene) return [];
  try {
    if (!(token instanceof Token)) { throw new Error("find nearby token is not of type token or the token uuid is invalid") };
    let relative = options.relative ?? true;
    let targetDisposition;
    if (typeof disposition === "string") disposition = mapTokenString(disposition);
    if (disposition instanceof Array) {
      if (disposition.some(s => s === "all")) disposition = [-1, 0, 1];
      else disposition = disposition.map(s => mapTokenString(s) ?? 0);
      targetDisposition = disposition.map(i => typeof i === "number" && [-1, 0, 1].includes(i) && relative ? token.document.disposition * i : i);
    } else if (typeof disposition === "number" && [-1, 0, 1].includes(disposition)) {
      //@ts-expect-error token.document.dispostion
      targetDisposition = relative ? [token.document.disposition * disposition] : [disposition];
    } else targetDisposition = [CONST.TOKEN_DISPOSITIONS.HOSTILE, CONST.TOKEN_DISPOSITIONS.NEUTRAL, CONST.TOKEN_DISPOSITIONS.FRIENDLY];

    let nearby = canvas.tokens?.placeables.filter(t => {
      if (!isTargetable(t)) return false;
      //@ts-expect-error .height .width v10
      if (options.maxSize && t.document.height * t.document.width > options.maxSize) return false;
      if (!options.includeIncapacitated && checkIncapacitated(t.actor, debugEnabled > 0)) return false;
      let inRange = false;
      if (t.actor &&
        (t.id !== token.id || options?.includeToken) && // not the token
        //@ts-expect-error .disposition v10      
        (disposition === null || targetDisposition.includes(t.document.disposition))) {
        const tokenDistance = computeDistance(t, token, { wallsBlock: true });
        inRange = 0 <= tokenDistance && tokenDistance <= distance
      } else return false; // wrong disposition
      if (inRange && options.canSee && !canSense(t, token)) return false; // Only do the canSee check if the token is inRange
      if (inRange && options.isSeen && !canSense(token, t)) return false;
      return inRange;

    });

    return nearby ?? [];
  } catch (err) {
    TroubleShooter.recordError(err, "findnearby error");
    error(err);
    return [];
  }
}

export function checkNearby(disposition: number | null | string, tokenRef: Token | TokenDocument | string | undefined, distance: number, options: any = {}): boolean {
  //@ts-expect-error .disposition
  const tokenDisposition = getTokenDocument(tokenRef)?.disposition;
  if (tokenDisposition === 0) options.relative = false;
  return findNearby(disposition, tokenRef, distance, options).length !== 0;
}

export function hasCondition(actorRef: Actor | Token | TokenDocument | string | undefined | null, condition: string): 0 | 1 {
  let actor = getActor(actorRef);
  if (!actor) return 0;
  //@ts-expect-error
  if (!actor.system.traits || !actor.statuses) return 0;
  //@ts-expect-error
  if (actor.system.traits.ci?.value.has(condition)) return 0;
  //@ts-expect-error
  if (actor.statuses.has(condition)) return 1;
  //@ts-expect-error specialStatusEffects
  const specials = CONFIG.specialStatusEffects;
  switch (condition?.toLocaleLowerCase()) {
    case "blind":
      //@ts-expect-error hasStatusEffect
      if (actor.statuses.has(specials.BLIND)) return 1;
      break;
    case "burrow":
    case "burrowing":
      //@ts-expect-error hasStatusEffect
      if (actor.statuses.has(specials.BURROW)) return 1;
      break;
    case "dead":
      //@ts-expect-error hasStatusEffect
      if (actor.statuses.has(specials.DEFEATED)) return 1;
      break
    case "deaf":
      //@ts-expect-error hasStatusEffect
      if (actor.statuses.has(specials.DEAF)) return 1;
      break;
    case "disease":
    case "diseased":
      //@ts-expect-error hasStatusEffect
      if (actor.statuses.has(specials.DISEASE)) return 1;
      break;
    case "fly":
    case "flying":
      //@ts-expect-error hasStatusEffect
      if (actor.statuses.has(specials.FLY)) return 1;
      break;
    case "hidden":
    case "hiding":
      //@ts-expect-error hasStatusEffect
      if (actor.statuses.has("hidden") || actor.statuses.has("hiding")) return 1;
      break;
    case "inaudible":
    case "silent":
      //@ts-expect-error hasStatusEffect
      if (actor.statuses.has(specials.INAUDIBLE)) return 1;
      break;
    case "invisible":
      //@ts-expect-error hasStatusEffect
      if (actor.statuses.has(specials.INVISIBLE)) return 1;
      break;
    case "poison":
    case "poisoned":
      //@ts-expect-error hasStatusEffect
      if (actor.statuses.has(specials.POISON)) return 1;
      break;
  }
  //@ts-expect-error hasStatusEffect
  if (actor.statuses.has(condition.toLocaleLowerCase()) || actor.statuses.has(condition)) return 1;
  return 0;
}

export async function removeInvisible() {
  if (!canvas || !canvas.scene) return;
  const token: Token | undefined = this.attackingToken ?? canvas.tokens?.get(this.tokenId);
  if (!token) return;
  removeInvisibleCondition(token);
}

export async function removeInvisibleCondition(tokenRef: Token | TokenDocument | string | undefined) {
  const token = getToken(tokenRef);
  if (!token) return;
  await removeTokenConditionEffect(token, i18n(`midi-qol.invisible`));
  //@ts-expect-error
  if (game.release.generation < 12) {
    //@ts-expect-error
    if (CONFIG.statusEffects.find(se => se.id === (CONFIG.specialStatusEffects.INVISIBLE ?? "invisible"))) {
      //@ts-expect-error
      await token.document.toggleActiveEffect({ id: CONFIG.specialStatusEffects.INVISIBLE }, { active: false });
    }
  } else {
    //@ts-expect-error
    if (CONFIG.statusEffects.find(se => se.id === (CONFIG.specialStatusEffects.INVISIBLE ?? "invisible"))) {
      //@ts-expect-error
      await token?.actor?.toggleStatusEffect(CONFIG.specialStatusEffects.INVISIBLE, { active: false })
    }
  }
  if (debugEnabled > 0) log(`Invisibility removed for ${token.name}`)
}

export async function removeHidden() {
  if (!canvas || !canvas.scene) return;
  const token: Token | undefined = this.attackingToken ?? canvas.tokens?.get(this.tokenId);
  if (!token) return;
  removeHiddenCondition(token);
}

export async function removeHiddenCondition(tokenRef: Token | TokenDocument | string | undefined) {
  const token = getToken(tokenRef);
  if (!token) return;
  //@ts-expect-error
  if (game.release.generation >= 12) {
    if (!token.actor) return
    if (CONFIG.statusEffects.find(se => se.id === "hidden")) {
      //@ts-expect-error
      await token.actor.toggleStatusEffect("hidden", { active: false });
    }
    if (CONFIG.statusEffects.find(se => se.id === "hiding")) {
      //@ts-expect-error
      await token.actor.toggleStatusEffect("hiding", { active: false });
    }
  } else {
    const hidingEffect = CONFIG.statusEffects.find(i => i.id === "hiding");
    //@ts-expect-error
    if (hidingEffect) await token.document.toggleActiveEffect(hidingEffect, { active: false });
    const hiddenEffect = CONFIG.statusEffects.find(i => i.id === "hidden");
    //@ts-expect-error
    if (hiddenEffect) await token.document.toggleActiveEffect(hiddenEffect, { active: false });
  }
  // Try and remove hidden if set by another active effect
  await removeTokenConditionEffect(token, i18n(`midi-qol.hidden`));
  if (installedModules.get("perceptive")) {
    //@ts-expect-error .api
    const api = game.modules.get("perceptive")?.api;
    api?.PerceptiveFlags.setPerceptiveStealthing(token.document, false);
  }
  if (debugEnabled > 0) log(`Hidden removed for ${token.name}`)
}

export async function removeTokenConditionEffect(token: Token, condition: string) {
  if (!token) return;
  //@ts-expect-error appliedEffects
  const hasEffect = token.actor?.appliedEffects.find(ef => ef.name === condition);
  if (hasEffect) await expireEffects(token.actor, [hasEffect], { "expiry-reason": `midi-qol:removeTokenCondition:${condition}` });
}

export async function expireMyEffects(effectsToExpire: string[]) {
  const expireHit = effectsToExpire.includes("1Hit") && !this.effectsAlreadyExpired.includes("1Hit");
  let expireAnyAction = effectsToExpire.includes("1Action") && !this.effectsAlreadyExpired.includes("1Action");
  const expireBonusAction = (effectsToExpire.includes("1Action") || effectsToExpire.includes("Bonus Action")) && !this.effectsAlreadyExpired.includes("Bonus Action");
  const expireReaction = (effectsToExpire.includes("1Action") || effectsToExpire.includes("Reaction")) && !this.effectsAlreadyExpired.includes("Reaction");
  const expireTurnAction = (effectsToExpire.includes("1Action") || effectsToExpire.includes("Turn Action")) && !this.effectsAlreadyExpired.includes("Turn Action");
  const expireSpell = effectsToExpire.includes("1Spell") && !this.effectsAlreadyExpired.includes("1Spell");
  const expireAttack = effectsToExpire.includes("1Attack") && !this.effectsAlreadyExpired.includes("1Attack");
  const expireDamage = effectsToExpire.includes("DamageDealt") && !this.effectsAlreadyExpired.includes("DamageDealt");
  const expireInitiative = effectsToExpire.includes("Initiative") && !this.effectsAlreadyExpired.includes("Initiative");
  //
  expireAnyAction ||= expireBonusAction || expireReaction || expireTurnAction;
  if (expireAnyAction) effectsToExpire.push("1Action");
  // expire any effects on the actor that require it
  if (debugEnabled && false) {
    const test = this.actor.effects.map(ef => {
      const specialDuration = foundry.utils.getProperty(ef.flags, "dae.specialDuration");
      return [(expireAnyAction && specialDuration?.includes("1Action")),
      (expireAttack && specialDuration?.includes("1Attack") && this.item?.hasAttack),
      (expireHit && this.item?.hasAttack && specialDuration?.includes("1Hit") && this.hitTargets.size > 0)]
    })
    if (debugEnabled > 1) debug("expiry map is ", test)
  }

  let allEffects = getAppliedEffects(this.actor, { includeEnchantments: true });
  const myExpiredEffects = allEffects?.filter(ef => {
    const specialDuration = foundry.utils.getProperty(ef.flags, "dae.specialDuration");
    if (!specialDuration || !specialDuration?.length) return false;
    return (expireAnyAction && specialDuration.includes("1Action")) ||
      (expireBonusAction && specialDuration.includes("Bonus Action") && this.acitvity.activation.type === "bonus") ||
      (expireReaction && specialDuration.includes("Reaction") && this.activity.activation.type === "reaction") ||
      (expireTurnAction && specialDuration.includes("Turn Action") && this.activity.activation.type === "action") ||
      (expireAttack && this.activity?.hasAttack && specialDuration.includes("1Attack")) ||
      (expireSpell && this.item?.type === "spell" && specialDuration.includes("1Spell")) ||
      (expireAttack && this.activity?.hasAttack && specialDuration.includes(`1Attack:${this.activity?.actionType}`)) ||
      (expireHit && this.activity?.hasAttack && specialDuration.includes("1Hit") && this.hitTargets.size > 0) ||
      (expireHit && this.activity?.hasAttack && specialDuration.includes(`1Hit:${this.activity?.actionType}`) && this.hitTargets.size > 0) ||
      (expireDamage && this.activity?.hasDamage && specialDuration.includes("DamageDealt")) ||
      (expireInitiative && specialDuration.includes("Initiative"))
  });
  if (debugEnabled > 1) debug("expire my effects", myExpiredEffects, expireAnyAction, expireAttack, expireHit);
  this.effectsAlreadyExpired = this.effectsAlreadyExpired.concat(effectsToExpire);
  if (myExpiredEffects?.length > 0) await expireEffects(this.actor, myExpiredEffects, { "expiry-reason": `midi-qol:${effectsToExpire}` });
}

export async function expireRollEffect(rolltype: string, abilityId: string, success: boolean | undefined) {
  const rollType = rolltype.charAt(0).toUpperCase() + rolltype.slice(1)
  const expiredEffects = this.appliedEffects?.filter(ef => {
    const specialDuration = foundry.utils.getProperty(ef.flags, "dae.specialDuration");
    if (!specialDuration) return false;
    if (specialDuration.includes(`is${rollType}`)) return true;
    if (specialDuration.includes(`is${rollType}.${abilityId}`)) return true;
    if (success === true && specialDuration.includes(`is${rollType}Success`)) return true;
    if (success === true && specialDuration.includes(`is${rollType}Success.${abilityId}`)) return true;
    if (success === false && specialDuration.includes(`is${rollType}Failure`)) return true;
    if (success === false && specialDuration.includes(`is${rollType}Failure.${abilityId}`)) return true;
    return false;
  }).map(ef => ef.uuid);
  if (expiredEffects?.length > 0) {
    await timedAwaitExecuteAsGM("removeEffectUuids", {
      actorUuid: this.uuid,
      effects: expiredEffects,
      options: { "expiry-reason": `midi:special-duration:${rollType}:${abilityId}` }
    });
  }
}

export function validTargetTokens(tokenSet: Set<Token> | undefined | any): Set<Token> {
  return tokenSet?.filter(tk => tk.actor).filter(tk => isTargetable(tk)) ?? new Set();
}

// TODO when v12 only change all refs to fromUuidSync
export function MQfromUuidSync(uuid: string | undefined | null): any {
  if (!!!uuid) return null;
  //@ts-expect-error
  return fromUuidSync(uuid);
}


export function fromActorUuid(uuid: string | undefined): any {
  let doc = MQfromUuidSync(uuid);
  if (doc instanceof Actor) return doc;
  if (doc instanceof Token) return doc.actor;
  if (doc instanceof TokenDocument) return doc.actor;
  return null;
}

export function actorFromUuid(uuid: string | undefined): any {
  let doc = MQfromUuidSync(uuid);
  if (doc instanceof Actor) return doc;
  if (doc instanceof Token) return doc.actor;
  if (doc instanceof TokenDocument) return doc.actor;
  if (doc instanceof Item) return doc.parent;
  if (doc instanceof ActiveEffect && doc.parent instanceof Actor) return doc.parent;
  if (doc instanceof ActiveEffect && doc.parent instanceof Item) return doc.parent.parent;
  return null;
}

class RollModifyDialog extends Application {
  rollExpanded: boolean;
  timeRemaining: number;
  timeoutId: any;
  secondTimeoutId: any;
  aborted: boolean = false;

  data: {
    //@ts-expect-error dnd5e v10
    actor: globalThis.dnd5e.documents.Actor5e,
    flags: string[],
    flagSelector: string,
    targetObject: any,
    // rollId: string,
    // rollTotalId: string,
    // rollHTMLId: string,
    title: string,
    content: HTMLElement | JQuery<HTMLElement> | string,
    currentRoll: Roll,
    rollHTML: string,
    callback: () => {},
    close: () => {},
    buttons: any,
    rollMode: string | undefined,
    timeout: number,
    item: Item | undefined
  }

  constructor(data, options) {
    options.height = "auto";
    options.resizable = true;
    super(options);
    this.data = data;
    this.timeRemaining = this.data.timeout;
    this.rollExpanded = false;
    if (!data.rollMode) data.rollMode = game.settings.get("core", "rollMode");
    this.timeoutId = setTimeout(() => {
      if (this.secondTimeoutId) clearTimeout(this.secondTimeoutId);
      this.timeoutId = undefined;
      this.close();
    }, this.data.timeout * 1000);
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      template: "modules/midi-qol/templates/dialog.html",
      classes: ["dialog"],
      width: 600,
      jQuery: true
    }, { overwrite: true });
  }
  get title() {
    let maxPad = 1;
    if (this.data.timeout < maxPad) maxPad = this.data.timeout
    if (this.data.timeout) {
      const padCount = Math.ceil(this.timeRemaining / (this.data.timeout ?? defaultTimeout) * maxPad);
      const pad = "-".repeat(padCount);
      return `${this.data.title ?? "Dialog"} ${pad} ${this.timeRemaining}`;
    }
    else return this.data.title ?? "Dialog";
  }

  set1SecondTimeout() {
    this.secondTimeoutId = setTimeout(() => {
      clearTimeout(this.secondTimeoutId)
      if (!this.timeoutId) return;
      this.timeRemaining -= 1;
      this.render(false);
      if (this.timeRemaining > 0) this.set1SecondTimeout();
    }, 1000)
  }

  async render(force: boolean = false, options: any = {}) {
    const result: any = await super.render(force, options);
    const element = this.element;
    const title = element.find(".window-title")[0];
    if (!this.secondTimeoutId && this.timeoutId) this.set1SecondTimeout();
    if (!title) return result;
    let color = "red";
    if (this.timeRemaining >= this.data.timeout * 0.75) color = "chartreuse";
    else if (this.timeRemaining >= this.data.timeout * 0.50) color = "yellow";
    else if (this.timeRemaining >= this.data.timeout * 0.25) color = "orange";
    title.style.color = color;
    return result;
  }

  async getData(options) {
    this.data.flags = this.data.flags.filter(flagName => {
      if ((getOptionalCountRemaining(this.data.actor, `${flagName}.count`)) < 1) return false;
      return foundry.utils.getProperty(this.data.actor, flagName) !== undefined
    });
    if (this.data.flags.length === 0) this.close();
    this.data.buttons = this.data.flags.reduce((obj, flag) => {
      let flagData = foundry.utils.getProperty(this.data.actor ?? {}, flag);
      let value = foundry.utils.getProperty(flagData ?? {}, this.data.flagSelector);
      let icon = "fas fa-dice-d20";
      if (value !== undefined) {
        let labelDetail;
        if (typeof value === "string") {
          labelDetail = Roll.replaceFormulaData(value, this.data.actor.getRollData());
          if (value.startsWith("ItemMacro")) {
            icon = CONFIG.Macro.sidebarIcon;
            if (value === "ItemMacro")
              labelDetail = this.data.item?.name ?? "Macro";
            else {
              const uuid = value.split(".").slice(1).join(".");
              const item = MQfromUuidSync(uuid);
              if (item)
                labelDetail = item.name;
              else
                labelDetail = uuid;
            }
          }
          else if (value.startsWith("function")) {
            icon = CONFIG.Macro.sidebarIcon;
            labelDetail = value.split(".").slice(-1);
          } else if (value.startsWith("Macro")) {
            icon = CONFIG.Macro.sidebarIcon;
            labelDetail = value.split(".").slice(1).join(".");
          }
        } else labelDetail = `${value}`
        obj[foundry.utils.randomID()] = {
          icon: `<i class="${icon}"></i>`,
          //          label: (flagData.label ?? "Bonus") + `  (${foundry.utils.getProperty(flagData, this.data.flagSelector) ?? "0"})`,
          label: (flagData?.label ?? "Bonus") + ` (${labelDetail})`,
          value: `${value}`,
          key: flag,
          callback: this.data.callback
        }
      }
      let selector = this.data.flagSelector.split(".");
      if (selector[selector.length - 1] !== "all") {
        selector[selector.length - 1] = "all";
        const allSelector = selector.join(".");
        value = foundry.utils.getProperty(flagData ?? {}, allSelector);
        if (value !== undefined) {
          if (typeof value !== "string") value = `${value}`
          let labelDetail = Roll.replaceFormulaData(value, this.data.actor.getRollData());
          if (value.startsWith("ItemMacro")) {
            icon = CONFIG.Macro.sidebarIcon;
            if (value === "ItemMacro")
              labelDetail = this.data.item?.name ?? "Macro";
            else {
              const uuid = value.split(".").slice(1).join(".");
              const item = MQfromUuidSync(uuid);
              if (item)
                labelDetail = item.name;
              else
                labelDetail = uuid;
            }
          } else if (value.startsWith("function")) {
            icon = CONFIG.Macro.sidebarIcon;
            labelDetail = value.split(".").slice(-1).join(".");
          } else if (value.startsWith("Macro")) {
            icon = CONFIG.Macro.sidebarIcon;
            labelDetail = value.split(".").slice(1).join(".");
          } else labelDetail = value;
          // check force condition. if true call the callback and return obj

          obj[foundry.utils.randomID()] = {
            icon: `<i class="${icon}"></i>`,
            //          label: (flagData.label ?? "Bonus") + `  (${foundry.utils.getProperty(flagData, allSelector) ?? "0"})`,
            label: (flagData?.label ?? "Bonus") + (debugEnabled > 0 ? `: ${labelDetail}` : ""),
            value,
            key: flag,
            callback: this.data.callback
          }
        }
      }
      return obj;
    }, {})
    this.data.buttons.no = {
      icon: '<i class="fas fa-times"></i>',
      label: i18n("Cancel"),
      callback: () => {
        this.data.flags = [];
        this.close();
      }
    }

    // this.data.content = await midiRenderRoll(this.data.currentRoll);
    // this.data.content = await this.data.currentRoll.render();
    return {
      content: this.data.content, // This is set by the callback
      buttons: this.data.buttons
    }
  }

  activateListeners(html) {
    html.find(".dialog-button").click(this._onClickButton.bind(this));
    $(document).on('keydown.chooseDefault', this._onKeyDown.bind(this));
    html.on("click", ".dice-roll", this._onDiceRollClick.bind(this));
  }

  _onDiceRollClick(event) {
    event.preventDefault();
    // Toggle the message flag
    let roll = event.currentTarget;
    this.rollExpanded = !this.rollExpanded

    // Expand or collapse tooltips
    const tooltips = roll.querySelectorAll(".dice-tooltip");
    for (let tip of tooltips) {
      if (this.rollExpanded) $(tip).slideDown(200);
      else $(tip).slideUp(200);
      tip.classList.toggle("expanded", this.rollExpanded);
    }
  }

  _onClickButton(event) {
    if (this.secondTimeoutId) {
      clearTimeout(this.secondTimeoutId);
      this.secondTimeoutId = 0;
    }
    const oneUse = true;
    const id = event.currentTarget.dataset.button;
    const button = this.data.buttons[id];
    this.submit(button);
  }

  _onKeyDown(event) {
    // Close dialog
    if (event.key === "Escape" || event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    }
  }

  async submit(button) {
    if (this.secondTimeoutId) {
      clearTimeout(this.secondTimeoutId);
    }
    try {
      if (button.callback) {
        await button.callback(this, button);
        // await this.getData({}; Render will do a get data, doing it twice breaks the button data?

        if (this.secondTimeoutId) {
          clearTimeout(this.secondTimeoutId);
          this.secondTimeoutId = 0;
        }
        this.render(true);
      }
      // this.close();
    } catch (err) {
      const message = "midi-qol | Optional flag roll error see console for details ";
      ui.notifications?.error(message);
      TroubleShooter.recordError(err, message);
      error(err);
    }
  }

  async close() {
    if (this.timeoutId) clearTimeout(this.timeoutId);
    this.timeoutId = undefined;
    if (this.secondTimeoutId) clearTimeout(this.secondTimeoutId);
    this.secondTimeoutId = 0;
    if (this.data.close) this.data.close();
    $(document).off('keydown.chooseDefault');
    return super.close();
  }
}

export async function processAttackRollBonusFlags() { // bound to workflow
  let attackBonus = "attack.all";
  if (this.activity && this.activity.hasAttack) attackBonus = `attack.${this.activity.actionType}`;
  const optionalFlags = foundry.utils.getProperty(this.actor ?? {}, `flags.${MODULE_ID}.optional`) ?? {};
  // If the attack roll is a fumble only select flags that allow the roll to be rerolled.
  let bonusFlags = Object.keys(optionalFlags)
    .filter(flag => {
      const hasAttackFlag = foundry.utils.getProperty(this.actor ?? {}, `flags.${MODULE_ID}.optional.${flag}.attack.all`) ||
        foundry.utils.getProperty(this.actor ?? {}, `flags.${MODULE_ID}.optional.${flag}.${attackBonus}`);
      if (hasAttackFlag === undefined) return false;
      if (this.isFumble && !hasAttackFlag?.includes("roll")) return false;
      if (!this.actor.flags[MODULE_ID].optional[flag].count) return true;
      return getOptionalCountRemainingShortFlag(this.actor, flag) > 0;
    })
    .map(flag => `flags.${MODULE_ID}.optional.${flag}`);

  if (bonusFlags.length > 0) {
    const newRoll = await bonusDialog.bind(this)(bonusFlags, attackBonus, checkMechanic("displayBonusRolls"), `${this.actor.name} - ${i18n("DND5E.Attack")} ${i18n("DND5E.Roll")}`, this.attackRoll, "attackRoll")
    this.setAttackRoll(newRoll);
  }
  if (this.targets.size === 1) {
    const targetAC = this.targets.first().actor.system.attributes.ac.value;
    this.processAttackRoll();
    const isMiss = this.isFumble || this.attackRoll.total < targetAC;
    if (isMiss) {
      attackBonus = "attack.fail.all"
      if (this.activity && this.activity.hasAttack) attackBonus = `attack.fail.${this.activity.actionType}`;
      let bonusFlags = Object.keys(optionalFlags)
        .filter(flag => {
          const hasAttackFlag = foundry.utils.getProperty(this.actor ?? {}, `flags.${MODULE_ID}.optional.${flag}.attack.fail.all`)
            || foundry.utils.getProperty(this.actor ?? {}, `flags.${MODULE_ID}.optional.${flag}.${attackBonus}`);
          if (hasAttackFlag === undefined) return false;
          if (this.isFumble && !hasAttackFlag?.includes("roll")) return false;
          if (!this.actor.flags[MODULE_ID].optional[flag].count) return true;
          return getOptionalCountRemainingShortFlag(this.actor, flag) > 0;
        })
        .map(flag => `flags.${MODULE_ID}.optional.${flag}`);
      if (bonusFlags.length > 0) {
        const newRoll = await bonusDialog.bind(this)(bonusFlags, attackBonus, checkMechanic("displayBonusRolls"), `${this.actor.name} - ${i18n("DND5E.Attack")} ${i18n("DND5E.Roll")}`, this.attackRoll, "attackRoll");
        this.setAttackRoll(newRoll);
      }
    }
  }
  return this.attackRoll;
}

export async function processDamageRollBonusFlags(damageRolls): Promise<Roll[]> { // bound to a workflow
  let damageBonus = "damage.all";
  if (this.activity) damageBonus = `damage.${this.activity.actionType}`;
  const optionalFlags = foundry.utils.getProperty(this.actor ?? {}, `flags.${MODULE_ID}.optional`) ?? {};
  const bonusFlags = Object.keys(optionalFlags)
    .filter(flag => {
      const hasDamageFlag = foundry.utils.getProperty(this.actor ?? {}, `flags.${MODULE_ID}.optional.${flag}.damage.all`) !== undefined ||
        foundry.utils.getProperty(this.actor ?? {}, `flags.${MODULE_ID}.optional.${flag}.${damageBonus}`) !== undefined;
      if (!hasDamageFlag) return false;
      return getOptionalCountRemainingShortFlag(this.actor, flag) > 0;
    })
    .map(flag => `flags.${MODULE_ID}.optional.${flag}`);
  if (bonusFlags.length > 0) {
    // this.damageRollHTML = await midiRenderDamageRoll(this.damageRoll);
    // this.damamgeRollHTML = $(this.damageRolHTML).find(".dice-roll").remove();
    // TODO dnd3 work out what this means for multiple rolls
    let newRoll = await bonusDialog.bind(this)(bonusFlags, damageBonus, false, `${this.actor.name} - ${i18n("DND5E.Damage")} ${i18n("DND5E.Roll")}`, damageRolls[0], "damageRoll")
    if (newRoll) damageRolls[0] = newRoll;
  }
  return damageRolls;
}

async function displayBeforeAfterRolls(data: { originalRoll: Roll, newRoll: Roll, rollMode, title: string, player: User | undefined, options: any, actor: Actor }) {
  let { originalRoll, newRoll, rollMode, title, player, options, actor } = data;
  if (!options) options = {};
  //TODO match the renderRoll to the roll type
  const newRollHTML = await midiRenderRoll(newRoll);
  const originalRollHTML = await midiRenderRoll(originalRoll);
  const chatData: any = foundry.utils.mergeObject({
    flavor: `${title}`,
    speaker: ChatMessage.getSpeaker({ actor: actor }),
    content: `${originalRollHTML}<br>${newRollHTML}`,
    whisper: [player?.id ?? ""],
    rolls: [originalRoll, newRoll],
    sound: CONFIG.sounds.dice,
  },
    options.messageData);
  //@ts-expect-error
  if (game.release.generation < 12) {
    chatData.type = CONST.CHAT_MESSAGE_TYPES.ROLL;
  } else {
    //@ts-expect-error
    chatData.style = CONST.CHAT_MESSAGE_STYLES.ROLL;
  }
  //@ts-expect-error
  if (originalRoll.options.rollMode) ChatMessage.applyRollMode(chatData, originalRoll.options.rollMode);
  else ChatMessage.applyRollMode(chatData, rollMode);
  foundry.utils.setProperty(newRoll, `flags.${MODULE_ID}.chatMessageShown`, true);
  return await ChatMessage.create(chatData);
}

export async function bonusDialog(bonusFlags, flagSelector, showRoll, title, roll: Roll, rollType: string, options: any = {}): Promise<Roll | undefined> {
  const showDiceSoNice = dice3dEnabled();
  let timeoutId;
  if (!roll) return undefined;
  let newRoll = roll;
  let originalRoll = roll;
  let rollHTML = await midiRenderRoll(roll);
  const player = playerForActor(this.actor);

  const callback = async (dialog, button) => {
    if (this.seconditimeoutId) {
      clearTimeout(this.seconditimeoutId);
    }

    let reRoll;
    let chatMessage;
    const undoId = foundry.utils.randomID();
    const undoData: any = {
      id: undoId,
      userId: player?.id ?? "",
      userName: player?.name ?? "Gamemaster",
      itemName: button.label,
      itemUuid: "",
      actorUuid: this.actor.uuid,
      actorName: this.actor.name,
      isReaction: true
    }
    await untimedExecuteAsGM("queueUndoDataDirect", undoData)

    const rollMode = foundry.utils.getProperty(this.actor ?? {}, button.key)?.rollMode ?? game.settings.get("core", "rollMode");
    if (!hasEffectGranting(this.actor, button.key, flagSelector)) return;
    let resultApplied = false; // This is just for macro calls
    let macroToCall;
    const allFlagSelector = flagSelector.split(".").slice(0, -1).join(".") + ".all";
    let specificMacro = false;
    const possibleMacro = foundry.utils.getProperty(this.actor ?? {}, `${button.key}.${flagSelector}`) ||
      foundry.utils.getProperty(this.actor ?? {}, `${button.key}.${allFlagSelector}`);
    if (possibleMacro && (button.value.trim().startsWith("ItemMacro") || button.value.trim().startsWith("Macro") || button.value.trim().startsWith("function"))) {
      macroToCall = button.value;
      if (macroToCall.startsWith("Macro.")) macroToCall = macroToCall.replace("Macro.", "");
      specificMacro = true;
    } else if (foundry.utils.getProperty(this.actor ?? {}, `${button.key}.macroToCall`)?.trim()) {
      macroToCall = foundry.utils.getProperty(this.actor ?? {}, `${button.key}.macroToCall`)?.trim();
    }
    if (macroToCall) {
      let result;
      let workflow;
      if (this instanceof Workflow || this.workflow) {
        workflow = this.workflow ?? this;
      } else {
        const itemUuidOrName = macroToCall.split(".").slice(1).join(".");
        let item = MQfromUuidSync(itemUuidOrName);
        if (!item && this.actor) item = this.actor.items.getName(itemUuidOrName);
        if (!item && this instanceof Actor) item = this.items.getName(itemUuidOrName);
        workflow = new DummyWorkflow(this.actor ?? this, item, ChatMessage.getSpeaker({ actor: this.actor }), [], {});
      }
      const macroData = workflow.getMacroData();
      macroData.macroPass = `${button.key}.${flagSelector}`;
      macroData.tag = "optional";
      macroData.roll = roll;

      result = await workflow.callMacro(workflow?.item, macroToCall, macroData, { roll, bonus: (!specificMacro ? button.value : undefined) });
      if (typeof result === "string")
        button.value = result;
      else if (typeof result === "number")
        button.value = `${result}`;
      else if (result instanceof Roll) {
        newRoll = result;
        resultApplied = true;
      }
      if (result === undefined && debugEnabled > 0) console.warn(`midi-qol | bonusDialog | macro ${button.value} return undefined`)
    }

    //@ts-expect-error
    const D20Roll = CONFIG.Dice.D20Roll;
    // do the roll modifications
    if (!resultApplied) switch (button.value) {
      case "reroll": reRoll = await roll.reroll();
        if (showDiceSoNice) await displayDSNForRoll(reRoll, rollType, rollMode);
        newRoll = reRoll; break;
      case "reroll-query":
        reRoll = reRoll = await roll.reroll();
        if (showDiceSoNice) await displayDSNForRoll(reRoll, rollType, rollMode);
        const newRollHTML = await midiRenderRoll(reRoll);
        if (await Dialog.confirm({ title: "Confirm reroll", content: `Replace ${rollHTML} with ${newRollHTML}`, defaultYes: true }))
          newRoll = reRoll
        else
          newRoll = roll;
        break;
      case "reroll-kh": reRoll = await roll.reroll();
        if (showDiceSoNice) await displayDSNForRoll(reRoll, rollType === "attackRoll" ? "attackRollD20" : rollType, rollMode);
        newRoll = reRoll;
        if (reRoll.total <= (roll.total ?? 0)) newRoll = roll;
        break;
      case "reroll-kl": reRoll = await roll.reroll();
        newRoll = reRoll;
        if (reRoll.total > (roll.total ?? 0)) newRoll = roll;
        if (showDiceSoNice) await displayDSNForRoll(reRoll, rollType === "attackRoll" ? "attackRollD20" : rollType, rollMode);
        break;
      case "reroll-max": newRoll = await roll.reroll({ maximize: true });
        if (showDiceSoNice) await displayDSNForRoll(newRoll, rollType === "attackRoll" ? "attackRollD20" : rollType, rollMode);
        break;
      case "reroll-min": newRoll = await roll.reroll({ minimize: true });
        if (showDiceSoNice) await displayDSNForRoll(newRoll, rollType === "attackRoll" ? "attackRollD20" : rollType, rollMode);
        break;
      case "success":
        newRoll = newRoll = await roll.clone().evaluate();
        //@ts-expect-error
        newRoll.terms[0].results.forEach(res => res.result = 99);
        //@ts-expect-error
        newRoll._total = 99;
        setProperty(newRoll, "options", duplicate(roll.options))
        setProperty(newRoll, "options.success", true);
        break;
      case "fail":
        newRoll = newRoll = await roll.clone().evaluate();
        setProperty(newRoll, "options", duplicate(roll.options))
        setProperty(newRoll, "options.success", false);
        //@ts-expect-error
        newRoll.terms[0].results.forEach(res => res.result = -1);
        //@ts-expect-error
        newRoll._total = -1;
      default:
        if (typeof button.value === "string" && button.value.startsWith("replace ")) {
          const rollParts = button.value.split(" ");
          newRoll = new Roll(rollParts.slice(1).join(" "), (this.activity ?? this.actor).getRollData());
          newRoll = await newRoll.evaluate();
          if (showDiceSoNice) await displayDSNForRoll(newRoll, rollType, rollMode);
        } else if (flagSelector.startsWith("damage.") && foundry.utils.getProperty(this.actor ?? this, `${button.key}.criticalDamage`)) {
          //@ts-expect-error .DamageRoll
          const DamageRoll = CONFIG.Dice.DamageRoll
          let rollOptions = foundry.utils.duplicate(roll.options);
          //@ts-expect-error
          rollOptions.configured = false;
          // rollOptions = { critical: (this.isCritical || this.rollOptions.critical), configured: false };
          //@ts-expect-error D20Roll
          newRoll = CONFIG.Dice.D20Roll.fromRoll(roll);
          let rollData: any = {}
          if (this instanceof Workflow) rollData = this.activity?.getRollData() ?? this.actor?.getRollData() ?? {};
          else rollData = this.actor?.getRollData() ?? {}; // 
          const tempRoll = new DamageRoll(`${button.value}`, rollData, rollOptions);
          await tempRoll.evaluate();
          setRollOperatorEvaluated(tempRoll);
          if (showDiceSoNice) await displayDSNForRoll(tempRoll, rollType, rollMode);
          newRoll = addRollTo(roll, tempRoll);
        } else {
          //@ts-expect-error
          newRoll = CONFIG.Dice.D20Roll.fromRoll(roll);
          let rollData: any = {}
          if (this instanceof Workflow) rollData = this.activity?.getRollData() ?? this.actor?.getRollData() ?? {};
          else rollData = this.actor?.getRollData() ?? this;
          const tempRoll = await (new Roll(button.value, rollData)).roll();
          if (showDiceSoNice) await displayDSNForRoll(tempRoll, rollType, rollMode);
          newRoll = addRollTo(newRoll, tempRoll);
        }
        break;
    }

    if (showRoll && this.category === "ac") { // TODO do a more general fix for displaying this stuff
      const newRollHTML = await midiRenderRoll(newRoll);
      const chatData: any = {
        flavor: game.i18n.localize("DND5E.ArmorClass"),
        content: `${newRollHTML}`,
        whisper: [player?.id ?? ""]
      };
      ChatMessage.applyRollMode(chatData, rollMode);
      chatMessage = await ChatMessage.create(chatData);
    }

    await removeEffectGranting(this.actor, button.key);
    roll = newRoll;
    const optionalsUsed = foundry.utils.getProperty(roll, `flags.${MODULE_ID}.optionalsUsed`) ?? [];
    optionalsUsed.push(`${button.key}.${flagSelector}`);
    foundry.utils.setProperty(roll, `flags.${MODULE_ID}.optionalsUsed`, optionalsUsed);
    if (dialog) {
      validFlags = validFlags.filter(bf => bf !== button.key);
      if (validFlags.length === 0) {
        dialog?.close();
        return;
      }

      const newRollHTML = /*reRoll ? await midiRenderRoll(reRoll) :*/ await midiRenderRoll(newRoll);
      dialog.data.flags = validFlags;
      dialog.data.currentRoll = newRoll;
      if (game.user?.isGM) {
        dialog.data.content = newRollHTML;
      } else {
        if (["publicroll", "gmroll", "selfroll"].includes(rollMode)) dialog.data.content = newRollHTML;
        else dialog.data.content = "Hidden Roll";
      }
      dialog.render(true);
      // dialog.close();
    }
    if (chatMessage) untimedExecuteAsGM("updateUndoChatCardUuidsById", { id: undoId, chatCardUuids: [(await chatMessage).uuid] });
  }

  const conditionData = createConditionData({ workflow: (this instanceof Workflow ? this : undefined), item: this.item, actor: this.actor, target: this.targets?.first() });
  let validFlags: string[] = [];
  let lastForceFlag = ""
  const oldRoll = foundry.utils.deepClone(roll);;
  for (let flagName of bonusFlags) {
    if ((getOptionalCountRemaining(this.actor, `${flagName}.count`)) < 1) continue;
    let activationCondition = foundry.utils.getProperty(this.actor ?? {}, `${flagName}.activation`);
    if (activationCondition !== undefined) {
      activationCondition = await evalCondition(activationCondition, conditionData, { errorReturn: true, async: true });
      if (!activationCondition) continue;
    }
    let forcedCondition = foundry.utils.getProperty(this.actor ?? {}, `${flagName}.force`);
    if (forcedCondition !== undefined) {
      forcedCondition = await evalCondition(forcedCondition, conditionData, { errorReturn: true, async: true });
      if (forcedCondition) {
        const altFlag = flagSelector.split(".").slice(0, -1).join(".") + ".all";
        await callback(undefined, {
          key: flagName,
          value: foundry.utils.getProperty(this.actor ?? {}, `${flagName}.${flagSelector}`) ?? foundry.utils.getProperty(this.actor ?? {}, `${flagName}.${altFlag}`) ?? "",
          label: "none"
        });
        lastForceFlag = flagName;
      }
      continue;
    }
    if (foundry.utils.getProperty(this.actor, flagName) !== undefined) validFlags.push(flagName);
  }
  if (showRoll && lastForceFlag !== "") {
    DSNMarkDiceDisplayed(roll);
    const rollMode = foundry.utils.getProperty(this.actor ?? {}, lastForceFlag)?.rollMode ?? options.rollMode ?? game.settings.get("core", "rollMode");
    const card = await displayBeforeAfterRolls({ originalRoll: oldRoll, newRoll: roll, rollMode, title, player, options, actor: this.actor });
    if (card?.uuid && this instanceof Workflow) { // this does not work currently since the undoId has not yet been set
      await untimedExecuteAsGM("updateUndoChatCardUuidsById", { id: this.undoId, chatCardUuids: [card.uuid] });
    }
  }
  if (validFlags.length === 0) return roll;
  let timeout = options.timeout ?? configSettings.reactionTimeout ?? defaultTimeout;
  return new Promise((resolve, reject) => {
    async function onClose() {
      if (timeoutId) clearTimeout(timeoutId);
      //@ts-expect-error
      newRoll.options.rollMode = rollMode;
      // The original roll is dsn displayed before the bonus dialog is called so mark it as displayed
      DSNMarkDiceDisplayed(originalRoll);
      // The new roll has had dsn display done for each bonus term/reroll so mark it as displayed
      DSNMarkDiceDisplayed(newRoll);

      if (showRoll && newRoll !== originalRoll) {
        const card = await displayBeforeAfterRolls({ originalRoll, newRoll, rollMode, title, player, options, actor: this.actor });
        if (card?.uuid && this instanceof Workflow) { // this does not work currently since the undoId has not yet been set
          await untimedExecuteAsGM("updateUndoChatCardUuidsById", { id: this.undoId, chatCardUuids: [card.uuid] });
        }
      }
      resolve(newRoll)
    }
    if (options.timeout) {
      timeoutId = setTimeout(() => {
        resolve(newRoll);
      }, timeout * 1000);
    }

    let content;
    let rollMode: any = options?.rollMode ?? game.settings.get("core", "rollMode");
    if (game.user?.isGM) {
      content = rollHTML;
    } else {
      if (["publicroll", "gmroll", "selfroll"].includes(rollMode)) content = rollHTML;
      else content = "Hidden Roll";
    }
    const dialog = new RollModifyDialog(
      {
        actor: this.actor,
        flags: validFlags,
        flagSelector,
        targetObject: this,
        title,
        content,
        currentRoll: roll,
        rollHTML,
        rollMode: rollType,
        callback,
        close: onClose.bind(this),
        timeout,
        item: this.item,
        workflow: this instanceof Workflow ? this : undefined
      }, {
      width: 400
    }).render(true);
  });
}

//@ts-expect-error dnd5e v10
export function getOptionalCountRemainingShortFlag(actor: globalThis.dnd5e.documents.Actor5e, flag: string) {
  const countValue = getOptionalCountRemaining(actor, `flags.${MODULE_ID}.optional.${flag}.count`);
  const altCountValue = getOptionalCountRemaining(actor, `flags.${MODULE_ID}.optional.${flag}.countAlt`);
  const countRemaining = getOptionalCountRemaining(actor, `flags.${MODULE_ID}.optional.${flag}.count`) && getOptionalCountRemaining(actor, `flags.${MODULE_ID}.optional.${flag}.countAlt`)
  return countRemaining;
}
//@ts-expect-error dnd5e v10
export function getOptionalCountRemaining(actor: globalThis.dnd5e.documents.Actor5e, flag: string) {
  const countValue = foundry.utils.getProperty(actor, flag);
  if (!countValue) return 1;

  if (["each-round", "each-turn"].includes(countValue) && game.combat) {
    let usedFlag = flag.replace(".count", ".used");
    // check for the flag
    if (foundry.utils.getProperty(actor, usedFlag)) return 0;
  } else if (["turn"].includes(countValue)) {
    let usedFlag = flag.replace(".count", ".used");
    if (foundry.utils.getProperty(actor, usedFlag) || game.combat?.turns[game.combat?.turn]?.actor !== actor) return 0;
  } else if (countValue === "reaction") {
    // return await hasUsedReaction(actor)
    return actor.getFlag(MODULE_ID, "actions.reactionCombatRound") && needsReactionCheck(actor) ? 0 : 1;
  } else if (countValue === "every") return 1;
  if (Number.isNumeric(countValue)) return countValue;
  if (countValue.startsWith("ItemUses.")) {
    const itemName = countValue.split(".")[1];
    const item = actor.items.getName(itemName);
    return item?.system.uses.value;
  }
  if (countValue.startsWith("@")) {
    let result = foundry.utils.getProperty(actor?.system ?? {}, countValue.slice(1))
    return result;
  }
  return 1;
}

//@ts-expect-error dnd5e v10
export async function removeEffectGranting(actor: globalThis.dnd5e.documents.Actor5e, changeKey: string) {
  const effect = actor.appliedEffects.find(ef => ef.changes.some(c => c.key.includes(changeKey)))
  if (effect === undefined) return;
  const effectData = effect.toObject();

  const count = effectData.changes.find(c => c.key.includes(changeKey) && c.key.endsWith(".count"));
  const countAlt = effectData.changes.find(c => c.key.includes(changeKey) && c.key.endsWith(".countAlt"));
  if (!count) {
    return expireEffects(actor, [effect], { "expiry-reason": "midi-qol:optionalConsumed" })
  }
  if (Number.isNumeric(count.value) || Number.isNumeric(countAlt?.value)) {
    if (count.value <= 1 || countAlt?.value <= 1)
      return expireEffects(actor, [effect], { "expiry-reason": "midi-qol:optionalConsumed" })
    else if (Number.isNumeric(count.value)) {
      count.value = `${count.value - 1}`; // must be a string
    } else if (Number.isNumeric(countAlt?.value)) {
      countAlt.value = `${countAlt.value - 1}`; // must be a string
    }
    await effect.update({ changes: effectData.changes });
  }
  if (typeof count.value === "string" && count.value.startsWith("ItemUses.")) {
    const itemName = count.value.split(".")[1];
    const item = actor.items.getName(itemName);
    if (!item) {
      const message = `midi-qol | removeEffectGranting | could not decrement uses for ${itemName} on actor ${actor.name}`;
      error(message);
      TroubleShooter.recordError(new Error(message), message);
      return;
    }
    await item.update({ "system.uses.spent": Math.max(0, item.system.uses.spent + 1) });
  }
  if (typeof countAlt?.value === "string" && countAlt.value.startsWith("ItemUses.")) {
    const itemName = countAlt.value.split(".")[1];
    const item = actor.items.getName(itemName);
    if (!item) {
      const message = `midi-qol | removeEffectGranting | could not decrement uses for ${itemName} on actor ${actor.name}`;
      error(message);
      TroubleShooter.recordError(new Error(message), message);
      return;
    }
    await item.update({ "system.uses.spent": Math.max(0, item.system.uses.spent + 1) });
  }

  const actorUpdates: any = {};
  if (typeof count.value === "string" && count.value.startsWith("@")) {
    let key = count.value.slice(1);
    if (key.startsWith("system.")) key = key.replace("system.", "")
    // we have an @field to consume
    let charges = foundry.utils.getProperty(actor?.system ?? {}, key)
    if (charges) {
      charges -= 1;
      actorUpdates[`system.${key}`] = charges;
    }
  }
  if (typeof countAlt?.value === "string" && countAlt.value.startsWith("@")) {
    let key = countAlt.value.slice(1);
    if (key.startsWith("system.")) key = key.replace("system.", "")
    // we have an @field to consume
    let charges = foundry.utils.getProperty(actor?.system ?? {}, key)
    if (charges) {
      charges -= 1;
      actorUpdates[`system.${key}`] = charges;
    }
  }

  if (["turn", "each-round", "each-turn"].includes(count.value)) {
    const flagKey = `${changeKey}.used`.replace(`flags.${MODULE_ID}.`, "");
    actorUpdates[`${changeKey}.used`] = true;
    // await actor.setFlag(MODULE_ID, flagKey, true);
  }
  if (["turn", "each-round", "each-turn"].includes(countAlt?.value)) {
    const flagKey = `${changeKey}.used`.replace(`flags.${MODULE_ID}.`, "");
    actorUpdates[`${changeKey}.used`] = true;
    // await actor.setFlag(MODULE_ID, flagKey, true);
  }
  //@ts-expect-error v10 isEmpty
  if (!foundry.utils.isEmpty(actorUpdates)) await actor.update(actorUpdates);

  if (count.value === "reaction" || countAlt?.value === "reaction") {
    await setReactionUsed(actor);
  }
}

//@ts-expect-error dnd5e v10
export function hasEffectGranting(actor: globalThis.dnd5e.documents.Actor5e, key: string, selector: string) {
  // Actually check for the flag being set...
  if (getOptionalCountRemainingShortFlag(actor, key) <= 0) return false;
  let changeKey = `${key}.${selector}`;
  let hasKey = foundry.utils.getProperty(actor ?? {}, changeKey);
  if (hasKey !== undefined) return true;
  let allKey = selector.split(".");
  allKey[allKey.length - 1] = "all";
  changeKey = `${key}.${allKey.join(".")}`;
  hasKey = foundry.utils.getProperty(actor ?? {}, changeKey);
  if (hasKey !== undefined) return hasKey;
  return false;

}
//@ts-expect-error dnd5e
export function isConcentrating(actor: globalThis.dnd5e.documents.Actor5e): undefined | ActiveEffect {
  //@ts-expect-error
  return actor.effects.find(e => e.statuses.has(CONFIG.specialStatusEffects.CONCENTRATING) && !e.disabled && !e.isSuppressed)
}

function maxCastLevel(actor) {
  if (configSettings.ignoreSpellReactionRestriction) return 9;
  const spells = actor.system.spells;
  if (!spells) return 0;
  let pactLevel = spells.pact?.value ? spells.pact?.level : 0;
  for (let i = 9; i > pactLevel; i--) {
    if (spells[`spell${i}`]?.value > 0) return i;
  }
  return pactLevel;
}

async function getMagicItemReactions(actor: Actor, triggerType: string): Promise<ReactionItem[]> {
  //@ts-expect-error .api
  const api = game.modules.get("magicitems")?.api ?? game.modules.get("magic-items-2")?.api;
  if (!api) return [];
  const items: ReactionItem[] = [];
  try {
    const magicItemActor: any = await api.actor(actor);
    if (!magicItemActor) return [];
    for (let magicItem of magicItemActor.items) {
      try {
        if (!magicItem.active) continue;
        for (let spell of magicItem.spells) {
          const theSpell: any = await fromUuid(spell.uuid);
          if (theSpell.system.activation.type.includes("reaction")) {
            items.push({ "itemName": magicItem.name, itemId: magicItem.id, "actionName": spell.name, "img": spell.img, "id": spell.id, "uuid": spell.uuid, baseItem: theSpell });
          }
        }
        for (let feature of magicItem.feats) {
          const theFeat: any = await fromUuid(feature.uuid)
          if (theFeat.system.activation.type.includes("reaction")) {
            items.push({ "itemName": magicItem.name, itemId: magicItem.id, "actionName": feature.name, "img": feature.img, "id": feature.id, "uuid": feature.uuid, baseItem: theFeat });
          }
        }
      } catch (err) {
        const message = `midi-qol | err fetching magic item ${magicItem.name}`;
        console.error(message, err);
        TroubleShooter.recordError(err, message);
      }
    }
  } catch (err) {
    const message = `midi-qol | getMagicItemReactions | Fetching magic item spells/features on ${actor.name} failed - ignoring`;
    TroubleShooter.recordError(err, message);
    console.error(message, err);
  }
  return items;
}

async function itemReaction(item, triggerType, maxLevel, onlyZeroCost) {
  //TODO most of the checks need to be activity checks
  if (!item.system.activities) return false;
  for (let activity of item.system.activities) {
    if (!activity.activation?.type?.includes("reaction")) continue;
    if (activity.activation.type !== "reaction") {
      console.warn(`midi-qol | itemReaction | item ${item.name} ${activity.name} has a reaction type of ${activity.activation.type} which is deprecated - please update to reaction and reaction conditions`)
    }

    if ((activity.activation?.value ?? 1) > 0 && onlyZeroCost) continue; // TODO can't specify 0 cost reactions in dnd5e 4.x - have to find another way
    if (item.type === "spell") {
      if (configSettings.ignoreSpellReactionRestriction) return true;
      if (["atwill", "innate"].includes(item.system.preparation.mode)) return true;
      if (item.system.level === 0) return true;
      if (item.system.preparation?.prepared !== true && item.system.preparation?.mode === "prepared") continue;
      if (item.system.level <= maxLevel) return true;
    }

    if (!item.system.attuned && item.system.attunement === "required") continue;
    const canUse = await activity._prepareUsageUpdates({ consume: true });
    if (canUse) return true;
  }
  //if (item._getUsageUpdates({ consumeUsage: item.hasLimitedUses, consumeResource: item.hasResource, slotLevel: false }))
  //  return true;
  return false;
}

export const reactionTypes = {
  "reaction": { prompt: "midi-qol.reactionFlavorHit", triggerLabel: "isHit" },
  "reactiontargeted": { prompt: "midi-qol.reactionFlavorTargeted", triggerLabel: "isTargeted" },
  "reactionhit": { prompt: "midi-qol.reactionFlavorHit", triggerLabel: "isHit" },
  "reactionmissed": { prompt: "midi-qol.reactionFlavorMiss", triggerLabel: "isMissed" },
  "reactioncritical": { prompt: "midi-qol.reactionFlavorCrit", triggerLabel: "isCrit" },
  "reactionfumble": { prompt: "midi-qol.reactionFlavorFumble", triggerLabel: "isFumble" },
  "reactionheal": { prompt: "midi-qol.reactionFlavorHeal", triggerLabel: "isHealed" },
  "reactiondamage": { prompt: "midi-qol.reactionFlavorDamage", triggerLabel: "isDamaged" },
  "reactionpreattack": { prompt: "midi-qol.reactionFlavorPreAttack", triggerLabel: "preAttack" },
  "reactionattacked": { prompt: "midi-qol.reactionFlavorAttacked", triggerLabel: "isAttacked" },
  "reactionsave": { prompt: "midi-qol.reactionFlavorSave", triggerLabel: "isSave" },
  "reactionsavefail": { prompt: "midi-qol.reactionFlavorSaveFail", triggerLabel: "isSaveFail" },
  "reactionsavesuccess": { prompt: "midi-qol.reactionFlavorSaveSuccess", triggerLabel: "isSaveSuccess" },
  "reactionmoved": { prompt: "midi-qol.reactionFlavorMoved", triggerLabel: "isMoved" }
};

export function reactionPromptFor(triggerType: string): string {
  if (reactionTypes[triggerType]) return reactionTypes[triggerType].prompt;
  return "midi-qol.reactionFlavorAttack";
}
export function reactionTriggerLabelFor(triggerType: string): string {
  if (reactionTypes[triggerType]) return reactionTypes[triggerType].triggerLabel;
  return "reactionHit";
}

export async function doReactions(targetRef: Token | TokenDocument | string, triggerTokenUuid: string | undefined, attackRoll: Roll, triggerType: string, options: any = {}): Promise<{ name: string | undefined, uuid: string | undefined, ac: number | undefined }> {
  const target = getToken(targetRef);
  try {
    const noResult = { name: undefined, uuid: undefined, ac: undefined };
    if (!target) return noResult;
    //@ts-expect-error attributes
    if (!target.actor || !target.actor.flags) return noResult;
    // TODO V4 Change no reactions if incapacitated - I think this makes sense.
    if (checkIncapacitated(target.actor, debugEnabled > 0)) return noResult;
    if (checkRule("incapacitated")) {
      try {
        enableNotifications(false);
        if (checkIncapacitated(target.actor, debugEnabled > 0)) return noResult;
      } finally {
        enableNotifications(true);
      }
    }

    let player = playerFor(getTokenDocument(target));
    const usedReaction = hasUsedReaction(target.actor);
    const reactionSetting = getReactionSetting(player);
    if (getReactionSetting(player) === "none") return noResult;
    if (!player || !player.active) player = ChatMessage.getWhisperRecipients("GM").find(u => u.active);
    if (!player) return noResult;
    const maxLevel = maxCastLevel(target.actor);
    enableNotifications(false);
    let reactions: ReactionItem[] = [];
    let reactionCount = 0;
    let reactionActivityList: ReactionItemReference[] = [];
    try {
      let possibleReactions: ReactionItem[] = [];
      for (let item of target.actor.items) {
        if (await itemReaction(item, triggerType, maxLevel, usedReaction)) possibleReactions.push(item);
      }
      //let possibleReactions: ReactionItem[] = target.actor.items.filter(item => temReaction(item, triggerType, maxLevel, usedReaction));
      if (false && getReactionSetting(player) === "allMI" && !usedReaction) {
        // possibleReactions = possibleReactions.concat(await getMagicItemReactions(target.actor, triggerType));
      }
      for (let item of possibleReactions) {
        const theItem = item instanceof Item ? item : item.baseItem;
        for (let activity of theItem.system.activities) {
          let reactionCondition = activity.reactionCondition;
          if (reactionCondition) {
            if (debugEnabled > 0) warn(`for ${target.actor?.name} ${theItem.name} using condition ${reactionCondition}`);
            const returnvalue = await evalReactionActivationCondition(options.workflow, reactionCondition, target, { async: true, extraData: { reaction: reactionTriggerLabelFor(triggerType) } });
            if (returnvalue) reactions.push(activity);
          } else {
            if (debugEnabled > 0) warn(`for ${target.actor?.name} ${theItem.name} using ${triggerType} filter`);
            if (activity.activation?.type === triggerType || (triggerType === "reactionhit" && activity.activation?.type === "reaction"))
              reactions.push(activity);
          }
        }
      };

      if (debugEnabled > 0)
        warn(`doReactions ${triggerType} for ${target.actor?.name} ${target.name}`, reactions, possibleReactions);
      reactionActivityList = reactions.map(activity => {
        return activity.uuid;
        // magic item details return { "itemName": item.itemName, itemId: item.itemId, "actionName": item.actionName, "img": item.img, "id": item.id, "uuid": item.uuid };
      });
    } catch (err) {
      const message = `midi-qol | fetching reactions`;
      TroubleShooter.recordError(err, message);
    } finally {
      enableNotifications(true);
    }

    // TODO Check this for magic items if that makes it to v10
    if (await asyncHooksCall("midi-qol.ReactionFilter", reactions, options, triggerType, reactionActivityList) === false) {
      console.warn("midi-qol | Reaction processing cancelled by Hook");
      return { name: "Filter", ac: 0, uuid: undefined };
    }
    reactionCount = reactionActivityList?.length ?? 0;
    if (!usedReaction) {
      //@ts-expect-error .flags
      const midiFlags: any = target.actor.flags[MODULE_ID];
      reactionCount = reactionCount + Object.keys(midiFlags?.optional ?? [])
        .filter(flag => {
          if (triggerType !== "reaction" || !midiFlags?.optional[flag].ac) return false;
          if (!midiFlags?.optional[flag].count) return true;
          return getOptionalCountRemainingShortFlag(target.actor, flag) > 0;
        }).length
    }

    if (reactionCount <= 0) return noResult;

    let chatMessage;
    const reactionFlavor = game.i18n.format(reactionPromptFor(triggerType), { itemName: (options.item?.name ?? "unknown"), actorName: target.name });
    const chatData: any = {
      content: reactionFlavor,
      whisper: [player]
    };
    const workflow = options.workflow ?? Workflow.getWorkflow(options?.item?.uuid);

    if (configSettings.showReactionChatMessage) {
      const player = playerFor(target.document)?.id ?? "";
      if (configSettings.enableddbGL && installedModules.get("ddb-game-log")) {
        if (workflow?.flagTags) chatData.flags = workflow.flagTags;
      }
      chatMessage = await ChatMessage.create(chatData);
    }
    const rollOptions = geti18nOptions("ShowReactionAttackRollOptions");
    // {"none": "Attack Hit", "d20": "d20 roll only", "d20Crit": "d20 + Critical", "all": "Whole Attack Roll"},

    let content = reactionFlavor;
    if (["isHit", "isMissed", "isCrit", "isFumble", "isDamaged", "isAttacked"].includes(reactionTriggerLabelFor(triggerType))) {
      switch (configSettings.showReactionAttackRoll) {
        case "all":
          content = `<h4>${reactionFlavor} - ${rollOptions.all} ${attackRoll?.total ?? ""}</h4>`;
          break;
        case "allCrit":
          //@ts-expect-error
          const criticalString = attackRoll?.isCritical ? `<span style="color: green">(${i18n("DND5E.Critical")})</span>` : "";
          content = `<h4>${reactionFlavor} - ${rollOptions.all} ${attackRoll?.total ?? ""} ${criticalString}</h4>`;
          break;
        case "d20":
          //@ts-expect-error
          const theRoll = attackRoll?.terms[0]?.results ? attackRoll.terms[0].results[0].result : attackRoll?.terms[0]?.total ? attackRoll.terms[0].total : "";
          content = `<h4>${reactionFlavor} ${rollOptions.d20} ${theRoll}</h4>`;
          break;
        default:
          content = reactionFlavor;
      }
    }

    let result: any = await new Promise((resolve) => {
      // set a timeout for taking over the roll
      const timeoutId = setTimeout(() => {
        resolve(noResult);
      }, (configSettings.reactionTimeout ?? defaultTimeout) * 1000 * 2);

      // Compiler does not realise player can't be undefined to get here
      player && requestReactions(target, player, triggerTokenUuid, content, triggerType, reactionActivityList, resolve, chatMessage, options).then((result) => {
        clearTimeout(timeoutId);
      })
    });
    if (result?.name) {
      let count = 100;
      do {
        await busyWait(0.05); // allow pending transactions to complete
        count -= 1;
      } while (globalThis.DAE.actionQueue.remaining && count);
      //@ts-expect-error
      target.actor._initialize();
      workflow?.actor._initialize();
      // targetActor.prepareData(); // allow for any items applied to the actor - like shield spell
    }
    return result;
  } catch (err) {
    const message = `doReactions error ${triggerType} for ${target?.name} ${triggerTokenUuid}`;
    TroubleShooter.recordError(err, message);
    throw err;
  }
}

export async function requestReactions(target: Token, player: User, triggerTokenUuid: string | undefined, reactionFlavor: string, triggerType: string, reactionActivityList: ReactionItemReference[], resolve: ({ }) => void, chatPromptMessage: ChatMessage, options: any = {}) {
  try {
    const startTime = Date.now();
    if (options.item && options.item instanceof CONFIG.Item.documentClass) {
      options.itemUuid = options.item.uuid;
      delete options.item;
    };
    /* TODO come back and look at this - adds 80k to the message.
    if (options.workflow && options.workflow instanceof Workflow)
      options.workflow = options.workflow.macroDataToObject(options.workflow.getMacroDataObject());
    */
    if (options.workflow) delete options.workflow;
    let result;
    if (player.isGM) {
      result = await untimedExecuteAsGM("chooseReactions", {
        tokenUuid: target.document?.uuid ?? target.uuid,
        reactionFlavor,
        triggerTokenUuid,
        triggerType,
        options,
        reactionActivityList
      });
    } else {
      result = await socketlibSocket.executeAsUser("chooseReactions", player.id, {
        tokenUuid: target.document?.uuid ?? target.uuid,
        reactionFlavor,
        triggerTokenUuid,
        triggerType,
        options,
        reactionActivityList
      });
    }
    const endTime = Date.now();
    if (debugEnabled > 0) warn("requestReactions | returned after ", endTime - startTime, result);
    resolve(result);
    if (chatPromptMessage) chatPromptMessage.delete();
  } catch (err) {
    const message = `requestReactions | error ${triggerType} for ${target?.name} ${triggerTokenUuid}`;
    TroubleShooter.recordError(err, message);
    error(message, err)
    throw err;
  }
}

export async function promptReactions(tokenUuid: string, reactionActivityList: ReactionItemReference[], triggerTokenUuid: string | undefined, reactionFlavor: string, triggerType: string, options: any = {}) {
  try {
    const startTime = Date.now();
    const target: Token = MQfromUuidSync(tokenUuid);
    const actor: Actor | null = target.actor;
    let player = playerFor(getTokenDocument(target));
    if (!actor) return;
    const usedReaction = hasUsedReaction(actor);
    // if ( usedReaction && needsReactionCheck(actor)) return false;
    const midiFlags: any = foundry.utils.getProperty(actor ?? {}, `flags.${MODULE_ID}`);
    let result;
    let reactionActivities: any = [];
    const maxLevel = maxCastLevel(target.actor);
    enableNotifications(false);
    let reactions;
    let reactionCount = 0;
    try {
      enableNotifications(false);
      for (let ref of reactionActivityList) {
        if (typeof ref === "string") reactionActivities.push(await fromUuid(ref));
        else reactionActivities.push(ref);
      };
    } finally {
      enableNotifications(true);
    }
    if (reactionActivities.length > 0) {
      if (await asyncHooksCall("midi-qol.ReactionFilter", reactionActivities, options, triggerType, reactionActivityList) === false) {
        console.warn("midi-qol | Reaction processing cancelled by Hook");
        return { name: "Filter" };
      }
      result = await reactionDialog(actor, triggerTokenUuid, reactionActivities, reactionFlavor, triggerType, options);
      const endTime = Date.now();
      if (debugEnabled > 0) warn("promptReactions | reaction processing returned after ", endTime - startTime, result)
      if (result.uuid) return result; //TODO look at multiple choices here
    }
    if (usedReaction) return { name: "None" };
    if (!midiFlags) return { name: "None" };
    const validFlags = Object.keys(midiFlags?.optional ?? {})
      .filter(flag => {
        if (!midiFlags.optional[flag].ac) return false;
        if (!midiFlags.optional[flag].count) return true;
        return getOptionalCountRemainingShortFlag(actor, flag) > 0;
      }).map(flag => `flags.${MODULE_ID}.optional.${flag}`);
    if (validFlags.length > 0 && triggerType === "reaction") {
      //@ts-expect-error attributes
      let acRoll = await new Roll(`${actor.system.attributes.ac.value}`).roll();
      const data = {
        actor,
        roll: acRoll,
        rollHTML: reactionFlavor,
        rollTotal: acRoll.total,
      }
      //@ts-expect-error attributes
      const newAC = await bonusDialog.bind(data)(validFlags, "ac", true, `${actor.name} - ${i18n("DND5E.AC")} ${actor.system.attributes.ac.value}`, acRoll, "roll");
      const endTime = Date.now();
      if (debugEnabled > 0) warn("promptReactions | returned via bonus dialog ", endTime - startTime)
      return { name: actor.name, uuid: actor.uuid, ac: newAC.total };
    }
    const endTime = Date.now();
    if (debugEnabled > 0) warn("promptReactions | returned no result ", endTime - startTime)
    return { name: "None" };
  } catch (err) {
    const message = `promptReactions ${tokenUuid} ${triggerType} ${reactionActivityList}`;
    TroubleShooter.recordError(err, message);
    throw err;
  }
}

export function playerFor(target: TokenDocument | Token | undefined): User | undefined {
  return playerForActor(target?.actor); // just here for syntax checker
}

export function playerForActor(actor: Actor | undefined | null): User | undefined {
  if (!actor) return undefined;
  let user;
  //@ts-expect-error DOCUMENT_PERMISSION_LEVELS
  const OWNERSHIP_LEVELS = foundry.utils.isNewerVersion(game.data.version, "12.0") ? CONST.DOCUMENT_OWNERSHIP_LEVELS : CONST.DOCUMENT_PERMISSION_LEVELS;
  //@ts-expect-error ownership v10
  const ownwership = actor.ownership;
  // find an active user whose character is the actor
  if (actor.hasPlayerOwner) user = game.users?.find(u => u.character?.id === actor?.id && u.active);
  if (!user) // no controller - find the first owner who is active
    user = game.users?.players.find(p => p.active && ownwership[p.id ?? ""] === OWNERSHIP_LEVELS.OWNER)
  if (!user) // find a non-active owner
    user = game.users?.players.find(p => p.character?.id === actor?.id);
  if (!user) // no controlled - find an owner that is not active
    user = game.users?.players.find(p => ownwership[p.id ?? ""] === OWNERSHIP_LEVELS.OWNER)
  if (!user && ownwership.default === OWNERSHIP_LEVELS.OWNER) {
    // does anyone have default owner permission who is active
    user = game.users?.players.find(p => p.active && ownwership[p.id] === OWNERSHIP_LEVELS.INHERIT)
  }
  // if all else fails it's an active gm.
  //@ts-expect-error activeGM
  if (!user) user = game.users?.activeGM
  return user;
}

//@ts-expect-error dnd5e v10
export async function reactionDialog(actor: globalThis.dnd5e.documents.Actor5e, triggerTokenUuid: string | undefined, reactionActivities: any[], rollFlavor: string, triggerType: string, options: any = { timeout }) {
  const noResult = { name: "None" };
  try {
    let timeout = (options.timeout ?? configSettings.reactionTimeout ?? defaultTimeout);
    return new Promise((resolve, reject) => {
      let timeoutId = setTimeout(() => {
        dialog.close();
        resolve({});
      }, timeout * 1000);
      const callback = async function (dialog, button) {
        clearTimeout(timeoutId);
        const activity: any = reactionActivities.find(i => i.uuid === button.key);
        if (activity) {
          // await setReactionUsed(actor);
          // No need to set reaction effect since using item will do so.
          dialog.close();
          // options = foundry.utils.mergeObject(options.workflowOptions ?? {}, {triggerTokenUuid, checkGMStatus: false}, {overwrite: true});
          const itemRollOptions = foundry.utils.mergeObject(options, {
            systemCard: false,
            createWorkflow: true,
            versatile: false,
            configureDialog: true,
            checkGMStatus: false,
            targetUuids: [triggerTokenUuid],
            isReaction: true,
            workflowOptions: { targetConfirmation: "none" },
            ignoreUserTargets: true
          });
          let useTimeoutId = setTimeout(() => {
            clearTimeout(useTimeoutId);
            resolve({})
          }, ((timeout) - 1) * 1000);
          let result: any = noResult;
          clearTimeout(useTimeoutId);
          if (activity.item instanceof CONFIG.Item.documentClass) { // a nomral item}
            const config = { midiOptions: itemRollOptions };
            result = await completeActivityUse(activity, config, {}, {});
            if (result.currentAction !== result.WorkflowState_Cleanup) resolve(noResult);
            else resolve({ name: activity?.name, uuid: activity?.uuid })
          } else if (false) { // assume it is a magic item item
            //@ts-expect-error
            const api = game.modules.get("magicitems")?.api ?? game.modules.get("magic-items-2")?.api;
            if (api) {
              let item;
              const magicItemActor = await api?.actor(actor)
              if (magicItemActor) {
                // export type ReactionItemReference = { itemName: string, itemId: string, actionName: string, img: string, id: string, uuid: string } | string;
                const magicItem = magicItemActor.items.find(i => i.id === item.itemId);
                await completeItemUse({ magicItem, id: item.id }, {}, itemRollOptions);
                resolve({ name: item?.itemName, uuid: item?.uuid })

              }
              resolve({ name: item?.itemName, uuid: item?.uuid })
            } else resolve(noResult);
          }

        }
        // actor.reset();
        resolve(noResult)
      };
      const noReaction = async function (dialog, button) {
        clearTimeout(timeoutId);
        resolve(noResult);
      }
      const dialog = new ReactionDialog({
        actor,
        targetObject: this,
        title: `${actor.name}`,
        activities: reactionActivities,
        content: rollFlavor,
        callback,
        close: noReaction,
        timeout
      }, {
        width: 400
      });

      dialog.render(true);
    });
  } catch (err) {
    const message = `reaactionDialog error ${actor?.name} ${actor?.uuid} ${triggerTokenUuid}`;
    TroubleShooter.recordError(err, message);
    throw err;
  }
}

class ReactionDialog extends Application {
  startTime: number;
  endTime: number;
  timeoutId: number;
  timeRemaining;

  data: {
    //@ts-expect-error dnd5e v10
    actor: globalThis.dnd5e.documents.Actor5e,
    activities: any[],
    title: string,
    content: HTMLElement | JQuery<HTMLElement>,
    callback: () => {},
    close: (any) => {},
    buttons: any,
    completed: boolean,
    timeout: number,
    timeRemaining: number
  }

  constructor(data, options) {
    super(options);
    this.timeRemaining = data.timeout;
    this.startTime = Date.now();
    this.data = data;
    this.data.completed = false;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      template: "modules/midi-qol/templates/dialog.html",
      classes: ["dialog"],
      width: 150,
      height: "auto",
      jQuery: true
    });
  }
  get title() {
    let maxPad = 45;
    if (this.data.timeout) {
      if (this.data.timeout < maxPad) maxPad = this.data.timeout;
      const padCount = Math.ceil(this.timeRemaining / (this.data.timeout ?? defaultTimeout) * maxPad);
      const pad = "-".repeat(padCount);
      return `${this.data.title ?? "Dialog"} ${pad} ${this.timeRemaining}`;
    }
    else return this.data.title ?? "Dialog";
  }
  getData(options) {
    this.data.buttons = this.data.activities.reduce((acc: {}, activity: any) => {
      acc[foundry.utils.randomID()] = {
        // icon: `<image src=${item.img} width="30" height="30">`,
        label: `<div style="display: flex; align-items: center; margin: 5px;"> <image src=${activity.item.img} width="40" height="40"> &nbsp ${activity.item.name}:${activity.name ?? activity.actionName} </div>`,
        value: activity.name ?? activity.actionName,
        key: activity.uuid,
        callback: this.data.callback,
      }
      return acc;
    }, {})
    return {
      content: this.data.content,
      buttons: this.data.buttons,
      timeRemaining: this.timeRemaining
    }
  }

  set1Secondtimeout() {
    //@ts-expect-error typeof setTimeout
    this.timeoutId = setTimeout(() => {
      this.timeRemaining -= 1;
      this.render(false);
      if (this.timeRemaining > 0) this.set1Secondtimeout();
    }, 1000)
  }

  async render(force: boolean = false, options: any = {}) {
    if (!this.timeoutId) this.set1Secondtimeout();
    const result: any = await super.render(force, options);
    const element = this.element;
    const title = element.find(".window-title")[0];
    if (!title) return result;
    let color = "red";
    if (this.timeRemaining >= this.data.timeout * 0.75) color = "chartreuse";
    else if (this.timeRemaining >= this.data.timeout * 0.50) color = "yellow";
    else if (this.timeRemaining >= this.data.timeout * 0.25) color = "orange";
    title.style.color = color;
    return result;
  }

  activateListeners(html) {
    html.find(".dialog-button").click(this._onClickButton.bind(this));
    $(document).on('keydown.chooseDefault', this._onKeyDown.bind(this));
    // if ( this.data.render instanceof Function ) this.data.render(this.options.jQuery ? html : html[0]);
  }

  _onClickButton(event) {
    const id = event.currentTarget.dataset.button;
    const button = this.data.buttons[id];
    debug("Reaction dialog button clicked", id, button, Date.now() - this.startTime)
    this.submit(button);
  }

  _onKeyDown(event) {
    // Close dialog
    if (event.key === "Escape" || event.key === "Enter") {
      debug("Reaction Dialog onKeyDown esc/enter pressed", event.key, Date.now() - this.startTime);
      event.preventDefault();
      event.stopPropagation();
      this.data.completed = true;
      if (this.data.close) this.data.close({ name: "keydown", uuid: undefined });
      this.close();
    }
  }

  async submit(button) {
    try {
      clearTimeout(this.timeoutId);
      debug("ReactionDialog submit", Date.now() - this.startTime, button.callback)
      if (button.callback) {
        this.data.completed = true;
        await button.callback(this, button)
        this.close();
      }
    } catch (err) {
      const message = `Reaction dialog submit`;
      TroubleShooter.recordError(err, message);
      ui.notifications?.error(err);
      error(err);
      this.data.completed = false;
      this.close()
    }
  }

  async close() {
    clearTimeout(this.timeoutId);
    debug("Reaction Dialog close ", Date.now() - this.startTime, this.data.completed)
    if (!this.data.completed && this.data.close) {
      this.data.close({ name: "Close", uuid: undefined });
    }
    $(document).off('keydown.chooseDefault');
    return super.close();
  }
}


export function reportMidiCriticalFlags() {
  let report: string[] = [];
  if (game?.actors) for (let a of game.actors) {
    for (let item of a.items.contents) {
      if (!["", "20", 20].includes((foundry.utils.getProperty(item, `flags.${MODULE_ID}.criticalThreshold`) || ""))) {
        report.push(`Actor ${a.name}'s Item ${item.name} has midi critical flag set ${foundry.utils.getProperty(item, `flags.${MODULE_ID}.criticalThreshold`)}`)
      }
    }
  }
  if (game?.scenes) for (let scene of game.scenes) {
    for (let tokenDocument of scene.tokens) { // TODO check this v10
      if (tokenDocument.actor) for (let item of tokenDocument.actor.items.contents) {
        if (!tokenDocument.isLinked && !["", "20", 20].includes((foundry.utils.getProperty(item, `flags.${MODULE_ID}.criticalThreshold`) || ""))) {
          const criticalThreshold = foundry.utils.getProperty(item, `flags.${MODULE_ID}.criticalThreshold`);
          report.push(`Scene ${scene.name}, Token Name ${tokenDocument.name}, Actor Name ${tokenDocument.actor.name}, Item ${item.name} has midi critical flag set ${criticalThreshold}`)
        }
      }
    }
  }
  console.log("Items with midi critical flags set are\n", ...(report.map(s => s + "\n")));
}

/**
 * 
 * @param actor the actor to check
 * @param itemRef the item to check. An item, an item uuid or an item name.
 * @returns the concentration effect if present and null otherwise
 */
export function getConcentrationEffect(actor, itemRef?: Item | string): ActiveEffect | undefined {
  let item;
  if (typeof itemRef === "string") {
    item = MQfromUuidSync(itemRef);
    if (!item) item = actor.concentration.items?.find(i => i.name === itemRef)
  } else item = itemRef;
  // concentration should not be a passive effect so don't need to do applied effects
  if (!item?.id)
    return actor?.effects.find(ef => ef.statuses.has(systemConcentrationId));
  else {
    return actor?.effects.find(ef => ef.statuses.has(systemConcentrationId)
      && (ef.flags?.dnd5e?.itemData === item.id || ef.flags.dnd5e?.itemData?._id === item.id)
    );
  }
}

async function confirm(title: string = "Are you sure", { content, defaultYes } = { content: "", defaultYes: true }): Promise<any> {
  return Dialog.confirm({
    title: title ?? "Confirm",
    content,
    defaultYes
  });
}
async function asyncMySafeEval(expression: string, sandbox: any, onErrorReturn: any | undefined = undefined): Promise<any> {
  let result;
  try {
    expression = expression.replace(/confirm\((.*)\)/g, "await confirm($1)");
    const src = 'with (sandbox) { return ' + expression + '}';
    //@ts-expect-error
    let AsyncFunction = foundry.utils.AsyncFunction
    if (!AsyncFunction)
      AsyncFunction = (async function () { }).constructor;
    const evl = AsyncFunction("sandbox", src);
    //@ts-expect-error
    sandbox = foundry.utils.mergeObject(sandbox, { Roll, findNearby, findNearbyCount, checkNearby, hasCondition, checkDefeated, checkIncapacitated, canSee, canSense, computeDistance, checkRange, checkDistance, contestedRoll, fromUuidSync: MQfromUuidSync, confirm, nonWorkflowTargetedToken: game.user?.targets.first()?.document.uuid, combat: game.combat });
    const sandboxProxy = new Proxy(sandbox, {
      has: () => true, // Include everything
      get: (t, k) => k === Symbol.unscopables ? undefined : (t[k] ?? Math[k]),
      //@ts-expect-error
      set: () => console.error("midi-qol | asnycMySafeEval | You may not set properties of the sandbox environment") // No-op
    });
    result = await evl.call(null, sandboxProxy);
  } catch (err) {
    const message = `midi-qol | asyncMySafeEval | activation condition (${expression}) error, actorUuid: ${sandbox.actorUuid} itemUuid: ${sandbox.item?.uuid} targetUuid: ${sandbox.targetUuid}`;
    console.warn(message, err)
    TroubleShooter.recordError(err, message);
    result = onErrorReturn;
  }
  if (Number.isNumeric(result)) return Number(result)
  return result;
};

function mySafeEval(expression: string, sandbox: any, onErrorReturn: any | undefined = undefined): any {
  let result;
  try {
    const src = 'with (sandbox) { return ' + expression + '}';
    if (expression.includes("Roll(")) {
      //@ts-expect-error
      if (game.release.generation > 11) {
        error("safeEval | Roll expressions are not supported in v12", expression)
        expression.replaceAll(/evaluate\s*\({\s*async:\s* false\s*}\)/g, "evaluateSync({strict: false})")
        error("Expression replaced with ", expression);
      } else {
        const newExpression = expression.replaceAll(/evaluate\s*\({\s*async:\s* false\s*}\)/g, "evaluateSync({strict: false})")
        console.warn(`%c safeEval | Roll expressions ${expression} are not supported in v12 and will be replaced with ${newExpression}`, "color:red;")
      }
    }
    const evl = new Function('sandbox', src);
    //@ts-expect-error
    sandbox = foundry.utils.mergeObject(sandbox, { Roll, findNearby, findNearbyCount, checkNearby, hasCondition, checkDefeated, checkIncapacitated, canSee, canSense, computeDistance, checkRange, checkDistance, fromUuidSync: MQfromUuidSync, MQfromUuidSync, nonWorkflowTargetedToken: game.user?.targets.first()?.document.uuid, combat: game.combat });

    const sandboxProxy = new Proxy(sandbox, {
      has: () => true, // Include everything
      get: (t, k) => k === Symbol.unscopables ? undefined : (t[k] ?? Math[k]),
      //@ts-expect-error
      set: () => console.error("midi-qol | mySafeEval | You may not set properties of the sandbox environment") // No-op
    });
    result = evl(sandboxProxy);
  } catch (err) {
    const message = `midi-qol | asyncMySafeEval | activation condition (${expression}) error, actorUuid: ${sandbox.actorUuid} itemUuid: ${sandbox.item?.uuid} targetUuid: ${sandbox.targetUuid}`;
    console.warn(message, err)
    TroubleShooter.recordError(err, message);
    result = onErrorReturn;
  }
  if (Number.isNumeric(result)) return Number(result)
  return result;
};

export function evalReactionActivationCondition(workflow: Workflow, condition: string | undefined | boolean, target: Token | TokenDocument, options: any = {}): boolean {
  if (options.errorReturn === undefined) options.errorReturn = false
  // if (condition === undefined || condition === "" || condition === false) return false;
  return evalActivationCondition(workflow, condition, target, options);
}
export function evalActivationCondition(workflow: Workflow, condition: string | undefined | boolean, target: Token | TokenDocument, options: any = {}): boolean {
  if (condition === undefined || condition === "" || condition === true) return true;
  if (condition === false) return false;
  createConditionData({ workflow, target, actor: workflow.actor, extraData: options?.extraData, item: options.item });
  options.errorReturn ??= true;
  const returnValue = evalCondition(condition, workflow.conditionData, options);
  return returnValue;
}

export function typeOrRace(entity: Token | Actor | TokenDocument | string): string {
  const actor: Actor | null | undefined = getActor(entity);
  //@ts-expect-error .system
  const systemData = actor?.system;
  if (!systemData) return "";
  if (systemData.details.type?.value) return systemData.details.type?.value?.toLocaleLowerCase() ?? "";
  // cater to dnd5e 2.4+ where race can be a string or an Item
  else return (systemData.details?.race?.name ?? systemData.details?.race)?.toLocaleLowerCase() ?? "";
}

export function raceOrType(entity: Token | Actor | TokenDocument | string): string {
  const actor: Actor | null | undefined = getActor(entity);
  //@ts-expect-error .system
  const systemData = actor?.system;
  if (!systemData) return "";
  if (systemData.details.race) return (systemData.details?.race?.name ?? systemData.details?.race)?.toLocaleLowerCase() ?? "";
  return systemData.details.type?.value?.toLocaleLowerCase() ?? "";
}

export function createConditionData(data: { workflow?: Workflow | undefined, target?: Token | TokenDocument | undefined, actor?: Actor | undefined | null, item?: Item | string | undefined, extraData?: any, activity?: any }) {
  const actor = data.workflow?.actor ?? data.actor;
  let item;
  if (data.item) {
    if (data.item instanceof Item) item = data.item;
    else if (typeof data.item === "string") item = MQfromUuidSync(data.item);
  }
  if (!item) item = data.activity?.item ?? data.workflow?.activity?.item ?? data.workflow?.item;
  let rollData = data.activity?.getRollData() ?? item?.getRollData() ?? actor.getRollData() ?? {};
  rollData = foundry.utils.mergeObject(rollData, data.extraData ?? {});
  rollData.isAttuned = rollData.item?.attuned || rollData.item?.attunment === "";
  try {
    if (data.target) {
      rollData.target = data.target.actor?.getRollData();
      if (data.target instanceof Token) rollData.targetUuid = data.target.document.uuid
      else rollData.targetUuid = data.target.uuid;
      rollData.targetId = data.target.id;
      rollData.targetActorUuid = data.target.actor?.uuid;
      rollData.targetActorId = data.target.actor?.id;
      rollData.raceOrType = data.target.actor ? raceOrType(data.target.actor) : "";
      rollData.typeOrRace = data.target.actor ? typeOrRace(data.target.actor) : "";
      rollData.target.saved = data.workflow?.saves.has(data.target);
      rollData.target.failedSave = data.workflow?.failedSaves.has(data.target);
      rollData.target.superSaver = data.workflow?.superSavers.has(data.target);
      rollData.semiSuperSaver = data.workflow?.semiSuperSavers.has(data.target);
      rollData.target.isHit = data.workflow?.hitTargets.has(data.target);
      rollData.target.isHitEC = data.workflow?.hitTargets.has(data.target);
      rollData.target.canSense = data.workflow?.targetsCanSense?.has(data.workflow?.token);
      rollData.target.canSee = data.workflow?.targetsCanSee?.has(data.workflow?.token);
      rollData.canSense = data.workflow?.tokenCanSense?.has(data.target);
      rollData.canSee = data.workflow?.tokenCanSee?.has(data.target);
    }

    rollData.humanoid = globalThis.MidiQOL.humanoid;
    rollData.tokenUuid = data.workflow?.tokenUuid;
    rollData.tokenId = data.workflow?.tokenId;
    rollData.effects = actor?.appliedEffects; // not needed since this is set in getRollData
    if (data.workflow) {
      rollData.w = data.workflow;
      rollData.workflow = data.workflow;
      rollData.activity = data.workflow.activity;
      rollData.otherDamageActivity = data.workflow?.otherActivity;
      rollData.hasSave = data.workflow.hasSave;
      rollData.item = data.workflow.item?.getRollData().item;
      if (data.workflow.item) rollData.item.type = data.workflow.item.type;
      rollData.otherDamageFormula = data.workflow.otherDamageFormula;
      rollData.shouldRollDamage = data.workflow.shouldRollDamage;
      rollData.hasAttack = data.workflow.activity.attack;
      rollData.hasDamage = activityHasDamage(data.workflow.activity);
    }
    if (data.activity) {
      rollData.activity = data.activity;
    }
    if (game.combat) {
      rollData.combatRound = game.combat?.round;
      rollData.combatTurn = game.combat?.turn;
      rollData.combatTime = game.combat?.round + (game.combat.turn ?? 0) /100;
    } else rollData.combatTime = 0;
    rollData.CONFIG = CONFIG;
    rollData.CONST = {};
    let exclusions: string[] = [];
    //@ts-expect-error
    if (game.release.generation > 11) {
      exclusions = ["DOCUMENT_TYPES"];
    }
    Object.keys(CONST).forEach(key => !exclusions.includes[key] && (rollData.CONST[key] = CONST[key]));
    //Only here to avoid deprecation warnings - remove when we get to v14
  } catch (err) {
    const message = `midi-qol | createConditionData`;
    TroubleShooter.recordError(err, message);
    console.warn(message, err);
  } finally {
    if (data.workflow) data.workflow.conditionData = rollData;
  }
  return rollData;
}

export async function evalAllConditionsAsync(actorRef: Token | TokenDocument | Actor | string, flag: string, conditionData, errorReturn: any = false): Promise<any> {
  if (!flag) return errorReturn;
  let actor: Actor | null | undefined = getActor(actorRef);
  if (!actor) return errorReturn;
  //@ts-expect-error .applyActiveEffects
  const effects = actor.appliedEffects.filter(ef => ef.changes.some(change => change.key === flag));
  let keyToUse = flag.replace(`flags.${MODULE_ID}.`, "flags.midi.evaluated.");
  keyToUse = keyToUse.replace("flags.dnd5e.", "flags.midi.evaluated.dnd5e.");
  let returnValue = errorReturn;
  foundry.utils.setProperty(actor, `${keyToUse}.value`, false);
  foundry.utils.setProperty(actor, `${keyToUse}.effects`, [])
  for (let effect of effects) {
    for (let change of effect.changes) {
      if (change.key === flag) {
        const condValue = await evalCondition(change.value, conditionData, { errorReturn, async: true });
        if (debugEnabled > 0) warn("evalAllConditions Async", actor.name, flag, change.value, condValue, conditionData, errorReturn);
        if (condValue) {
          returnValue = condValue;
          foundry.utils.setProperty(actor, `${keyToUse}.value`, condValue);
          foundry.utils.getProperty(actor, `${keyToUse}.effects`).push(effect.name);
        }
      }
    }
  }
  if (effects.length === 0 && foundry.utils.getProperty(actor, flag)) {
    returnValue = await evalCondition(foundry.utils.getProperty(actor, flag), conditionData, { errorReturn, async: true });
    if (returnValue) {
      foundry.utils.setProperty(actor, `${keyToUse}.value`, returnValue);
      foundry.utils.getProperty(actor, `${keyToUse}.effects`).push("flag");
    }
  }
  return returnValue;
}

export function evalAllConditions(actorRef: Token | TokenDocument | Actor | string, flag: string, conditionData, errorReturn: any = false): any {
  if (!flag) return errorReturn;
  let actor: Actor | null | undefined = getActor(actorRef);
  if (!actor) return errorReturn;
  //@ts-expect-error .applyActiveEffects
  const effects = actor.appliedEffects.filter(ef => ef.changes.some(change => change.key === flag));
  let keyToUse = flag.replace(`flags.${MODULE_ID}.`, "flags.midi.evaluated.");
  keyToUse = keyToUse.replace("flags.dnd5e.", "flags.midi.evaluated.dnd5e.");
  let returnValue = errorReturn;
  foundry.utils.setProperty(actor, `${keyToUse}.value`, false);
  foundry.utils.setProperty(actor, `${keyToUse}.effects`, [])
  for (let effect of effects) {
    for (let change of effect.changes) {
      if (change.key === flag) {
        const condValue = evalCondition(change.value, conditionData, { errorReturn, async: false });
        if (debugEnabled > 0) warn("evalAllConditions ", actor.name, flag, change.value, condValue, conditionData, errorReturn);
        if (condValue) {
          returnValue = condValue;
          foundry.utils.setProperty(actor, `${keyToUse}.value`, condValue);
          foundry.utils.getProperty(actor, `${keyToUse}.effects`).push(effect.name);
        }
      }
    }
  }
  if (effects.length === 0 && foundry.utils.getProperty(actor, flag)) {
    returnValue = evalCondition(foundry.utils.getProperty(actor, flag), conditionData, { errorReturn, async: false })
    if (returnValue) {
      foundry.utils.setProperty(actor, `${keyToUse}.value`, returnValue);
      foundry.utils.getProperty(actor, `${keyToUse}.effects`).push("flag");
    }
  }
  return returnValue;
}
export function evalCondition(condition: string, conditionData: any, options: any = { errorReturn: false, async: false }): any | Promise<any> {
  if (typeof condition === "number" || typeof condition === "boolean") return condition;
  if (condition === undefined || condition === "" || typeof condition !== "string") return options.errorReturn ?? false;
  let returnValue;
  try {
    if (condition.includes("@")) {
      condition = Roll.replaceFormulaData(condition, conditionData, { missing: "0" });
    }

    if (options.async) returnValue = asyncMySafeEval(condition, conditionData, options.errorReturn);
    else returnValue = mySafeEval(condition, conditionData, options.errorReturn ?? false);
    if (debugEnabled > 0) warn("evalCondition ", returnValue, condition, conditionData);

  } catch (err) {
    returnValue = options.errorReturn ?? false;
    const message = `midi-qol | evalCondition | activation condition (${condition}) error, actorUuid: ${conditionData.actorUuid} itemUuid: ${conditionData.item?.uuid} targetUuid: ${conditionData.targetUuid}`;
    TroubleShooter.recordError(err, message);
    console.warn(message, err, conditionData);
  }
  return returnValue;
}

export function computeTemplateShapeDistance(templateDocument: MeasuredTemplateDocument): { shape: string, distance: number } {
  //@ts-expect-error direction etc v10
  let { x, y, direction, distance } = templateDocument;
  // let { direction, distance, angle, width } = templateDocument;
  if (!canvas || !canvas.scene) return { shape: "none", distance: 0 };
  //@ts-expect-error distancePixels
  distance *= canvas.dimensions?.distancePixels;
  direction = Math.toRadians(direction);
  if (!templateDocument.object) {
    throw new Error("Template document has no object");
  }
  //@ts-expect-error
  templateDocument.object.ray = Ray.fromAngle(x, y, direction, distance);

  let shape: any;
  //@ts-expect-error ._computeShape
  templateDocument.object.shape = templateDocument.object._computeShape();
  //@ts-expect-error distance v10
  return { shape: templateDocument.object.shape, distance: templateDocument.distance };
}

var _enableNotifications = true;

export function notificationNotify(wrapped, ...args) {
  if (_enableNotifications) return wrapped(...args);
  return;
}
export function enableNotifications(enable: boolean) {
  _enableNotifications = enable;
}

export function getStatusName(statusId: string | undefined): string {
  if (!statusId) return "undefined";
  const se = CONFIG.statusEffects.find(efData => efData.id === statusId);
  //@ts-expect-error se.name
  return i18n(se?.name ?? se?.label ?? statusId);
}

export function getWoundedStatus(): any | undefined {
  //@ts-expect-error
  const dfreds = game.dfreds?.effectInterface;
  let condition = CONFIG.statusEffects.find(efData => efData.id === configSettings.midiWoundedCondition);
  if (condition || !dfreds) return condition;
  return dfreds.findEffect({ effectId: configSettings.midiWoundedCondition?.replace("zce-", "ce-") });
}

export function getUnconsciousStatus(): any | undefined {
  //@ts-expect-error
  const dfreds = game.dfreds?.effectInterface;
  let condition = CONFIG.statusEffects.find(efData => efData.id === configSettings.midiUnconsciousCondition);
  if (condition || !dfreds) return condition;
  return dfreds.findEffect({ effectId: configSettings.midiUnconsciousCondition?.replace("zce-", "ce-") });
  // return CONFIG.statusEffects.find(efData => efData.id === configSettings.midiUnconsciousCondition);
}

export function getDeadStatus(): any | undefined {
  //@ts-expect-error
  const dfreds = game.dfreds?.effectInterface;
  let condition = CONFIG.statusEffects.find(efData => efData.id === configSettings.midiDeadCondition);
  if (condition || !dfreds) return condition;
  return dfreds.findEffect({ effectId: configSettings.midiDeadCondition?.replace("zce-", "ce-") });
  // return CONFIG.statusEffects.find(efData => efData.id === configSettings.midiDeadCondition);
}

export async function ConvenientEffectsHasEffect(effectName: string, actor: Actor, ignoreInactive: boolean = true) {
  if (ignoreInactive) {
    return await CEHasEffectApplied({ effectName, uuid: actor.uuid })
    //@ ts-expect-error .dfreds
    // return game.dfreds?.effectInterface?.hasEffectApplied(effectName, actor.uuid);
  } else {
    //@ts-expect-error
    const effect = actor.appliedEffects.find(ef => ef.name === effectName);
    //@ts-expect-error
    if (foundry.utils.isNewerVersion(game.modules.get("dfreds-convenient-effects")?.version, "6.9")) {
      return !!isConvenientEffect(effect)
    } return !!effect;
  }
}

export function isInCombat(actor: Actor) {
  const actorUuid = actor.uuid;
  let combats;
  if (actorUuid.startsWith("Scene")) { // actor is a token synthetic actor
    const tokenId = actorUuid.split(".")[3]
    combats = game.combats?.combats.filter(combat =>
      //@ts-expect-error .tokenId v10
      combat.combatants.filter(combatant => combatant?.tokenId === tokenId).length !== 0
    );
  } else { // actor is not a synthetic actor so can use actor Uuid 
    const actorId = actor.id;
    combats = game.combats?.combats.filter(combat =>
      //@ts-expect-error .actorID v10
      combat.combatants.filter(combatant => combatant?.actorId === actorId).length !== 0
    );
  }
  return (combats?.length ?? 0) > 0;
}

export async function setActionUsed(actor: Actor) {
  await actor.setFlag(MODULE_ID, "actions.action", true);
}

export async function setReactionUsed(actor: Actor) {
  if (!["all", "displayOnly"].includes(configSettings.enforceReactions) && configSettings.enforceReactions !== actor.type) return;
  // await actor.update({"flags.midi-qol.actions.reaction": true, "flags.midi-qol.actions.reactionCombatRound": game.combat?.round});  
  const id = "reaction";
  await actor.effects.get(getStaticID(id))?.delete();
  const effect = foundry.utils.deepClone(getReactionEffect());
  //@ts-expect-error
  effect.updateSource({
    origin: actor.uuid,
    changes: [
      { key: 'flags.midi-qol.actions.reaction', mode: 2, value: true },
      { key: 'flags.midi-qol.actions.reactionCombatRound', mode: 2, value: game.combat?.round ?? false }
    ]
  });
  // effect.origin = actor.uuid;
  //@ts-expect-error
  await ActiveEffect.implementation.create(effect, { parent: actor, keepId: true });
}

export async function setBonusActionUsed(actor: Actor) {
  if (debugEnabled > 0) warn("setBonusActionUsed | starting");
  if (!["all", "displayOnly"].includes(configSettings.enforceBonusActions) && configSettings.enforceBonusActions !== actor.type) return;
  // await actor.update({ "flags.midi-qol.actions.bonus": true, "flags.midi-qol.actions.bonusActionCombatRound": game.combat?.round });
  const id = "bonusaction";
  await actor.effects.get(getStaticID(id))?.delete();
  const effect = foundry.utils.deepClone(midiBonusActionEffect);
  effect.updateSource({
    origin: actor.uuid,
    changes: [
      { key: 'flags.midi-qol.actions.bonus', mode: 2, value: true },
      { key: 'flags.midi-qol.actions.bonusActionCombatRound', mode: 2, value: game.combat?.round ?? false }
    ]
  });
  effect.origin = actor.uuid;
  //@ts-expect-error
  await ActiveEffect.implementation.create(effect, { parent: actor, keepId: true });
}

export async function removeActionUsed(actor: Actor) {
  if (game.user?.isGM) return await actor?.setFlag(MODULE_ID, "actions.action", false);
  else return await untimedExecuteAsGM("_gmSetFlag", { base: MODULE_ID, key: "actions.action", value: false, actorUuid: actor.uuid })
}

export async function removeReactionUsed(actor: Actor, force = false) {
  if (debugEnabled > 0) warn("removeReactionUsed | starting", actor);
  if (force || !installedModules.get("times-up")) { // if times-up installed the special duration will expire the effect
    await actor.effects.get(getStaticID("reaction"))?.delete(); // reaction always non-transfer
  }
  // safety net unset of flags - just in case.
  if (force) await actor.update({ "flags.midi-qol.actions.reaction": false, "flags.midi-qol.actions.-=reactionCombatRound": null });
}

export function hasUsedAction(actor: Actor) {
  return actor?.getFlag(MODULE_ID, "actions.action")
}

export function hasUsedReaction(actor: Actor) {
  return (actor.getFlag(MODULE_ID, "actions.reaction"));
}

export async function expirePerTurnBonusActions(combat: Combat, data, options) {
  const optionalFlagRe = /flags.midi-qol.optional.[^.]+.(count|countAlt)$/;
  for (let combatant of combat.turns) {
    const actor = combatant.actor;
    if (!actor) continue;
    //@ts-expect-error .appledEffects
    for (let effect of actor.allApplicableEffects()) {
      for (let change of effect.changes) {
        if (change.key.match(optionalFlagRe)
          && ((change.value === "each-turn")
            || (change.value === "each-round" && data.round !== combat.round))
          || (change.value === "turn" && combat?.turns[data.turn ?? combat.turn].actor === actor)) {
          const usedKey = change.key.replace(/.(count|countAlt)$/, ".used")
          const isUsed = foundry.utils.getProperty(actor, usedKey);
          if (isUsed) {
            const key = usedKey.replace(`flags.${MODULE_ID}.`, "");
            //TODO turn this into actor updates instead of each flag
            await untimedExecuteAsGM("_gmUnsetFlag", { actorUuid: actor.uuid, base: MODULE_ID, key });
          }
        }
      }
    }
  }
}

export function hasUsedBonusAction(actor: Actor) {
  return actor.getFlag(MODULE_ID, "actions.bonus");
}

export async function removeBonusActionUsed(actor: Actor, force = false) {
  if (force || !installedModules.get("times-up")) { // bonus action will be expired by times-up if installed
    await actor.effects.get(getStaticID("bonusaction"))?.delete()
  }
  // Safety net flag reset just in case
  if (force) await actor.update({ "flags.midi-qol.actions.bonus": false, "flags.midi-qol.actions.-=bonusActionCombatRound": null });
}


export function needsReactionCheck(actor) {
  return (configSettings.enforceReactions === "all" || configSettings.enforceReactions === actor.type)
}

export function needsBonusActionCheck(actor) {
  return (configSettings.enforceBonusActions === "all" || configSettings.enforceBonusActions === actor.type)
}
export function mergeKeyboardOptions(options: any, pressedKeys: Options | undefined) {
  if (!pressedKeys) return;
  options.advantage = options.advantage || pressedKeys.advantage;
  options.disadvantage = options.disadvantage || pressedKeys.disadvantage;
  options.versatile = options.versatile || pressedKeys.versatile;
  options.other = options.other || pressedKeys.other;
  options.rollToggle = options.rollToggle || pressedKeys.rollToggle;
  options.fastForward = options.fastForward || pressedKeys.fastForward;
  options.fastForwardAbility = options.fastForwardAbility || pressedKeys.fastForwardAbility;
  options.fastForwardDamage = options.fastForwardDamage || pressedKeys.fastForwardDamage;
  options.fastForwardAttack = options.fastForwardAttack || pressedKeys.fastForwardAttack;
  options.parts = options.parts || pressedKeys.parts;
  options.critical = options.critical || pressedKeys.critical;
}

export async function asyncHooksCallAll(hook, ...args): Promise<boolean | undefined> {
  if (CONFIG.debug.hooks) {
    console.log(`DEBUG | midi-qol async Calling ${hook} hook with args:`);
    console.log(args);
  }
  // console.warn(`DEBUG | midi-qol async Calling ${hook} hook with args:`, ...args);
  //@ts-expect-error
  const hookEvents = Hooks.events[hook];
  if (debugEnabled > 1) debug("asyncHooksCall", hook, "hookEvents:", hookEvents, args)
  if (!hookEvents) return undefined;
  if (debugEnabled > 0) {
    warn(`asyncHooksCall calling ${hook}`, hookEvents, args)
  }
  for (let entry of Array.from(hookEvents)) {
    //TODO see if this might be better as a Promises.all - disadvantage is that order is not guaranteed.
    try {
      if (debugEnabled > 1) {
        log(`asyncHooksCall for Hook ${hook} calling`, entry, args)
      }
      await hookCall(entry, args);
    } catch (err) {
      const message = `hooked function for hook ${hook}`;
      error(message, err);
      TroubleShooter.recordError(err, message);
    }
  }
  return true;
}

export async function asyncHooksCall(hook, ...args): Promise<boolean | undefined> {
  if (CONFIG.debug.hooks) {
    console.log(`DEBUG | midi-qol async Calling ${hook} hook with args:`);
    console.log(args);
  }
  // console.warn(`DEBUG | midi-qol async Calling ${hook} hook with args:`, ...args);

  //@ts-expect-error events
  const hookEvents = Hooks.events[hook];
  if (debugEnabled > 1) log("asyncHooksCall", hook, "hookEvents:", hookEvents, args)
  if (!hookEvents) return undefined;
  if (debugEnabled > 0) {
    warn(`asyncHooksCall calling ${hook}`, args, hookEvents)
  }
  for (let entry of Array.from(hookEvents)) {
    let callAdditional;
    try {
      if (debugEnabled > 1) {
        log(`asyncHooksCall for Hook ${hook} calling`, entry, args)
      }
      callAdditional = await hookCall(entry, args);
    } catch (err) {
      const message = `midi-qol | hooked function for hook ${hook} error`;
      error(message, err, entry);
      TroubleShooter.recordError(err, message);
      callAdditional = true;
    }
    if (callAdditional === false) return false;
  }
  return true;
}
function hookCall(entry, args) {
  const { hook, id, fn, once } = entry;

  if (once) Hooks.off(hook, id);
  try {
    return entry.fn(...args);
  } catch (err) {
    const message = `Error thrown in hooked function '${fn?.name}' for hook '${hook}'`;
    TroubleShooter.recordError(err, message);
    error(`midi | ${message}`);
    //@ts-expect-error Hooks.onError v10
    if (hook !== "error") Hooks.onError("Hooks.#call", err, { message, hook, fn, log: "error" });
  }
}

export function addAdvAttribution(roll: Roll, advAttribution: Set<string>) {
  // <section class="tooltip-part">
  let advHtml: string = "";
  if (advAttribution && advAttribution.size > 0) {
    advHtml = Array.from(advAttribution).reduce((prev, s) => prev += `${s}<br>`, "");
    foundry.utils.setProperty(roll, "options.advTooltip", advHtml);
  }
}

function getTooltip(roll, options: any = {}) {
  const parts = roll.dice?.map(d => d.getTooltipData()) ?? [];
  // parts.tooltipFormula = options?.tooltipFormula ?? false;
  // parts.formula = roll.formula;
  const templateData = {
    advTooltip: roll.options?.advTooltip,
    tooltipFormula: options?.tooltipFormula ?? false,
    formula: roll.formula,
    parts
  };
  return renderTemplate("modules/midi-qol/templates/tooltip.html", templateData);
}

export async function midiRenderRoll(roll) {
  return roll.render();
}
export async function midiRenderAttackRoll(roll, options?: any) {
  options = foundry.utils.mergeObject(options ?? {}, { tooltipFormula: ["formula", "formulaadv"].includes(configSettings.rollAlternate) });
  return midiRenderTemplateRoll(roll, "modules/midi-qol/templates/attack-roll.html", options)
}

export async function midiRenderDamageRoll(roll, options?: any) {
  options = foundry.utils.mergeObject(options ?? {}, { tooltipFormula: ["formula", "formulaadv"].includes(configSettings.rollAlternate) });
  let html = midiRenderTemplateRoll(roll, "modules/midi-qol/templates/damage-roll.html", options)
  return html;
}

export function midiRenderOtherDamageRoll(roll, options?: any) {
  options = foundry.utils.mergeObject(options ?? {}, { tooltipFormula: ["formula", "formulaadv"].includes(configSettings.rollAlternate) });
  let html = midiRenderTemplateRoll(roll, "modules/midi-qol/templates/other-damage-roll.html", options);
  return html;
}
export function midiRenderBonusDamageRoll(roll, options?: any) {
  options = foundry.utils.mergeObject(options ?? {}, { tooltipFormula: ["formula", "formulaadv"].includes(configSettings.rollAlternate) });
  let html = midiRenderTemplateRoll(roll, "modules/midi-qol/templates/bonus-damage-roll.html", options);
  return html;
}

export async function midiRenderTemplateRoll(roll: Roll | undefined, template: string, options?: any) {
  if (!roll) return "";
  const chatData = {
    formula: roll.formula,
    user: game.user?.id,
    tooltip: await getTooltip(roll, options),
    tooltipFormula: options?.tooltipFormula ?? false,
    //@ts-expect-error
    flavor: options?.flavor ?? roll.options?.flavor,
    total: (roll.total !== undefined) ? Math.round((roll.total) * 100) / 100 : "???"
  };
  return renderTemplate(template, chatData);
}
export function heightIntersects(targetDocument: any /*TokenDocument*/, flankerDocument: any /*TokenDocument*/): boolean {
  const targetElevation = targetDocument.elevation ?? 0;
  const flankerElevation = flankerDocument.elevation ?? 0;
  const targetTopElevation = targetElevation + Math.max(targetDocument.height, targetDocument.width) * (canvas?.dimensions?.distance ?? 5);
  const flankerTopElevation = flankerElevation + Math.min(flankerDocument.height, flankerDocument.width) * (canvas?.dimensions?.distance ?? 5); // assume t2 is trying to make itself small
  /* This is for requiring the centers to intersect the height range 
     Which is an alternative rule possiblity
  const flankerCenter = (flankerElevation + flankerTopElevation) / 2;
  if (flankerCenter >= targetElevation || flankerCenter <= targetTopElevation) return true;
  return false;
  */
  if (flankerTopElevation < targetElevation || flankerElevation > targetTopElevation) return false;
  return true;
}
export function findPotentialFlankers(target) {
  const allies = findNearby(-1, target, (canvas?.dimensions?.distance ?? 5));
  const reachAllies = findNearby(-1, target, 2 * (canvas?.dimensions?.distance ?? 5)).filter(
    ally => !(allies.some(tk => tk === ally)) &&
      //@ts-expect-error .system
      ally.actor?.items.contents.some(item => item.system?.properties?.rch && item.system.equipped)
  );
  return allies.concat(reachAllies);
}

export async function computeFlankedStatus(target): Promise<boolean> {
  if (!checkRule("checkFlanking") || !["ceflanked", "ceflankedNoconga"].includes(checkRule("checkFlanking"))) return false;
  if (!canvas || !target) return false;
  const allies: any /*Token v10*/[] = findPotentialFlankers(target);
  if (allies.length <= 1) return false; // length 1 means no other allies nearby
  let gridW;
  let gridH;
  //@ts-expect-error
  if (game.release.generation >= 12) {
    //@ts-expect-error
    gridW = canvas?.grid?.sizeX ?? 100;
    //@ts-expect-error
    gridH = canvas?.grid?.sizeY ?? 100;
  } else {
    gridW = canvas?.grid?.w ?? 100;
    gridH = canvas?.grid?.h ?? 100;
  }
  const tl = { x: target.x, y: target.y };
  const tr = { x: target.x + target.document.width * gridW, y: target.y };
  const bl = { x: target.x, y: target.y + target.document.height * gridH };
  const br = { x: target.x + target.document.width * gridW, y: target.y + target.document.height * gridH };
  const top: [x0: number, y0: number, x1: number, y1: number] = [tl.x, tl.y, tr.x, tr.y];
  const bottom: [x0: number, y0: number, x1: number, y1: number] = [bl.x, bl.y, br.x, br.y];
  const left: [x0: number, y0: number, x1: number, y1: number] = [tl.x, tl.y, bl.x, bl.y];
  const right: [x0: number, y0: number, x1: number, y1: number] = [tr.x, tr.y, br.x, br.y];

  while (allies.length > 1) {
    const token = allies.pop();
    if (!token) break;
    if (!heightIntersects(target.document, token.document)) continue;
    if (checkRule("checkFlanking") === "ceflankedNoconga" && installedModules.get("dfreds-convenient-effects")) {
      const CEFlanked = getFlankedEffect();
      //@ts-expect-error
      const hasFlanked = token.actor && CEFlanked && CEHasEffectApplied({ effectName: CEFlanked.name, uuid: token.actor.uuid });
      if (hasFlanked) continue;
    }
    // Loop through each square covered by attacker and ally
    const tokenStartX = token.document.width >= 1 ? 0.5 : token.document.width / 2;
    const tokenStartY = token.document.height >= 1 ? 0.5 : token.document.height / 2;
    for (let ally of allies) {
      if (ally.document.uuid === token.document.uuid) continue;
      const actor: any = ally.actor;
      if (actor?.system.attributes?.hp?.value <= 0) continue;
      if (!heightIntersects(target.document, ally.document)) continue;
      if (hasCondition(actor, "incapacitated")) continue;
      if (checkRule("checkFlanking") === "ceflankedNoconga" && installedModules.get("dfreds-convenient-effects")) {
        const CEFlanked = getFlankedEffect();
        //@ts-expect-error
        const hasFlanked = CEFlanked && CEHasEffectApplied({ effectName: CEFlanked.name, uuid: ally.actor.uuid });
        if (hasFlanked) continue;
      }
      const allyStartX = ally.document.width >= 1 ? 0.5 : ally.document.width / 2;
      const allyStartY = ally.document.height >= 1 ? 0.5 : ally.document.height / 2;
      var x, x1, y, y1, d, r;
      for (x = tokenStartX; x < token.document.width; x++) {
        for (y = tokenStartY; y < token.document.height; y++) {
          for (x1 = allyStartX; x1 < ally.document.width; x1++) {
            for (y1 = allyStartY; y1 < ally.document.height; y1++) {
              let tx = token.x + x * gridW;
              let ty = token.y + y * gridH;
              let ax = ally.x + x1 * gridW;
              let ay = ally.y + y1 * gridH;
              const rayToCheck = new Ray({ x: tx, y: ty }, { x: ax, y: ay });
              // console.error("Checking ", tx, ty, ax, ay, token.center, ally.center, target.center)
              const flankedTop = rayToCheck.intersectSegment(top) && rayToCheck.intersectSegment(bottom);
              const flankedLeft = rayToCheck.intersectSegment(left) && rayToCheck.intersectSegment(right);
              if (flankedLeft || flankedTop) {
                return true;
              }
            }
          }
        }
      }
    }
  }
  return false;
}

export function computeFlankingStatus(token, target): boolean {
  if (!checkRule("checkFlanking") || checkRule("checkFlanking") === "off") return false;
  if (!canvas) return false;
  if (!token) return false;
  // For the target see how many square between this token and any friendly targets
  // Find all tokens hostile to the target
  if (!target) return false;
  if (!heightIntersects(target.document, token.document)) return false;
  let range = 1;
  if (token.actor?.items.contents.some(item => item.system?.properties?.rch && item.system.equipped)) {
    range = 2;
  }
  if (computeDistance(token, target, { wallsBlock: true }) > range * (canvas?.dimensions?.distance ?? 5)) return false;
  // an enemy's enemies are my friends.
  const allies: any /* Token v10 */[] = findPotentialFlankers(target)

  if (!token.document.disposition) return false; // Neutral tokens can't get flanking
  if (allies.length <= 1) return false; // length 1 means no other allies nearby
  let gridW;
  let gridH;

  //@ts-expect-error
  if (game.release.generation >= 12) {
    //@ts-expect-error
    gridW = canvas?.grid?.sizeX ?? 100;
    //@ts-expect-error
    gridH = canvas?.grid?.sizeY ?? 100;
  } else {
    gridW = canvas?.grid?.w ?? 100;
    gridH = canvas?.grid?.h ?? 100;
  }
  const tl = { x: target.x, y: target.y };
  const tr = { x: target.x + target.document.width * gridW, y: target.y };
  const bl = { x: target.x, y: target.y + target.document.height * gridH };
  const br = { x: target.x + target.document.width * gridW, y: target.y + target.document.height * gridH };
  const top: [x0: number, y0: number, x1: number, y1: number] = [tl.x, tl.y, tr.x, tr.y];
  const bottom: [x0: number, y0: number, x1: number, y1: number] = [bl.x, bl.y, br.x, br.y];
  const left: [x0: number, y0: number, x1: number, y1: number] = [tl.x, tl.y, bl.x, bl.y];
  const right: [x0: number, y0: number, x1: number, y1: number] = [tr.x, tr.y, br.x, br.y];

  // Loop through each square covered by attacker and ally
  const tokenStartX = token.document.width >= 1 ? 0.5 : token.document.width / 2;
  const tokenStartY = token.document.height >= 1 ? 0.5 : token.document.height / 2;


  for (let ally of allies) {
    if (ally.document.uuid === token.document.uuid) continue;
    if (!heightIntersects(ally.document, target.document)) continue;
    const actor: any = ally.actor;
    if (checkIncapacitated(ally.actor, debugEnabled > 0)) continue;
    if (hasCondition(actor, "incapacitated")) continue;
    const allyStartX = ally.document.width >= 1 ? 0.5 : ally.document.width / 2;
    const allyStartY = ally.document.height >= 1 ? 0.5 : ally.document.height / 2;
    var x, x1, y, y1, d, r;
    for (x = tokenStartX; x < token.document.width; x++) {
      for (y = tokenStartY; y < token.document.height; y++) {
        for (x1 = allyStartX; x1 < ally.document.width; x1++) {
          for (y1 = allyStartY; y1 < ally.document.height; y1++) {
            let tx = token.x + x * gridW;
            let ty = token.y + y * gridH;
            let ax = ally.x + x1 * gridW;
            let ay = ally.y + y1 * gridH;
            const rayToCheck = new Ray({ x: tx, y: ty }, { x: ax, y: ay });
            // console.error("Checking ", tx, ty, ax, ay, token.center, ally.center, target.center)
            const flankedTop = rayToCheck.intersectSegment(top) && rayToCheck.intersectSegment(bottom);
            const flankedLeft = rayToCheck.intersectSegment(left) && rayToCheck.intersectSegment(right);
            if (flankedLeft || flankedTop) {
              return true;
            }
          }
        }
      }
    }
  }
  return false;
}

export function getFlankingEffect(): ActiveEffect | undefined {
  if (installedModules.get("dfreds-convenient-effects")) {
    //@ts-expect-error
    const dfreds = game.dfreds;
    let CEFlanking = dfreds.effects?._flanking;
    if (!CEFlanking && dfreds.effectInterface?.findEffectByName)
      CEFlanking = dfreds.effectInterface?.findEffectByName("Flanking");
    if (!CEFlanking && dfreds.effectInterface?.findEffect)
      CEFlanking = dfreds.effectInterface?.findEffect({ effectName: "Flanking" });
    return CEFlanking;
  }
  return undefined;
}

export function getFlankedEffect(): ActiveEffect | undefined {
  if (installedModules.get("dfreds-convenient-effects")) {
    //@ts-expect-error
    const dfreds = game.dfreds;
    let CEFlanked = dfreds.effects?._flanked;
    if (!CEFlanked && dfreds.effectInterface.findEffectByName)
      CEFlanked = dfreds?.effectInterface.findEffectByName("Flanked");
    if (!CEFlanked && dfreds.effectInterface?.findEffect)
      CEFlanked = dfreds?.effectInterface.findEffect({ effectName: "Flanked" });
    return CEFlanked;
  }
  return undefined;
}

export function getReactionEffect(): ActiveEffect {
  return midiReactionEffect;
}
export function getBonusActionEffect(): ActiveEffect {
  return midiBonusActionEffect;
}

export function getIncapacitatedStatusEffect() {
  let incapEffect = CONFIG.statusEffects.find(se => se.id === "incapacitated");
  //@ts-expect-error
  if (!incapEffect) incapEffect = CONFIG.statusEffects.find(se => se.statuses?.has("incapacitated"));
  //@ts-expect-error
  if (!incapEffect) incapEffect = CONFIG.statusEffects.find(se => se.name === i18n(`${SystemString}.ConIncapacitated`))
  return incapEffect;
}

export async function markFlanking(token, target): Promise<boolean> {
  // checkFlankingStatus requires a flanking token (token) and a target
  // checkFlankedStatus requires only a target token
  if (!canvas) return false;
  let needsFlanking = false;
  if (!target || !checkRule("checkFlanking") || checkRule("checkFlanking") === "off") return false;
  if (["ceonly", "ceadv"].includes(checkRule("checkFlanking"))) {
    //@ts-expect-error
    const dfreds = game.dfreds;
    if (!token) return false;
    needsFlanking = computeFlankingStatus(token, target);
    if (installedModules.get("dfreds-convenient-effects")) {
      let CEFlanking = getFlankingEffect();
      if (!CEFlanking) return needsFlanking;
      //@ ts-expect-error
      // const hasFlanking = token.actor && await game.dfreds.effectInterface?.hasEffectApplied(CEFlanking.name, token.actor.uuid)
      const hasFlanking = CEHasEffectApplied({ effectName: CEFlanking.name ?? "Flanking", uuid: token.actor.uuid });
      if (needsFlanking && !hasFlanking && token.actor) {
        await CEAddEffectWith({ effectName: CEFlanking.name ?? "Flanking", uuid: token.actor.uuid, overlay: false });
        //@ ts-expect-error
        // await game.dfreds.effectInterface?.addEffect({ effectName: CEFlanking.name, uuid: token.actor.uuid });
      } else if (!needsFlanking && hasFlanking && token.actor) {
        await CERemoveEffect({ effectName: CEFlanking.name ?? "Flanking", uuid: token.actor.uuid });
        //@ ts-expect-error
        // await game.dfreds.effectInterface?.removeEffect({ effectName: CEFlanking.name, uuid: token.actor.uuid });
      }
    }
  } else if (checkRule("checkFlanking") === "advonly") {
    if (!token) return false;
    needsFlanking = computeFlankingStatus(token, target);
  } else if (["ceflanked", "ceflankedNoconga"].includes(checkRule("checkFlanking"))) {
    if (!target.actor) return false;
    if (installedModules.get("dfreds-convenient-effects")) {
      let CEFlanked = getFlankedEffect();
      if (!CEFlanked) return false;
      const needsFlanked = await computeFlankedStatus(target);
      //@ ts-expect-error
      // const hasFlanked = target.actor && await game.dfreds.effectInterface?.hasEffectApplied(CEFlanked.name, target.actor.uuid);
      const hasFlanked = CEHasEffectApplied({ effectName: CEFlanked.name ?? "Flanked", uuid: target.actor.uuid });
      if (needsFlanked && !hasFlanked && target.actor) {
        await CEAddEffectWith({ effectName: CEFlanked.name ?? "Flanked", uuid: target.actor.uuid, overlay: false });
        //@ ts-expect-error
        // await game.dfreds.effectInterface?.addEffect({ effectName: CEFlanked.name, uuid: target.actor.uuid });
      } else if (!needsFlanked && hasFlanked && token.actor) {
        await CERemoveEffect({ effectName: CEFlanked.name ?? "Flanked", uuid: target.actor.uuid });
        //@ ts-expect-error
        // await game.dfreds.effectInterface?.removeEffect({ effectName: CEFlanked.name, uuid: target.actor.uuid });
      }
      return false;
    }
  }
  return needsFlanking;
}

export async function checkflanking(user: User, target: Token, targeted: boolean): Promise<boolean> {
  if (user !== game.user) return false;
  let token = canvas?.tokens?.controlled[0];
  if (user.targets.size === 1) return markFlanking(token, target);
  return false

}

export function getChanges(actorOrItem, key: string) {
  let contents = actorOrItem.effects.contents;
  //@ts-expect-error .appliedEffects
  if (actorOrItem instanceof Actor) contents = actorOrItem.appliedEffects.contents;
  return actorOrItem.effects.contents
    .flat()
    .map(e => {
      let c = foundry.utils.duplicate(e.changes);
      c = c.map(change => { change.effect = e; return change; })
      return c
    })
    .flat()
    .filter(c => c.key.includes(key))
    .sort((a, b) => a.key < b.key ? -1 : 1)
}

/**
 * 
 * @param token 
 * @param target 
 * 
 * @returns {boolean}
 */
export function canSense(tokenEntity: Token | TokenDocument | string, targetEntity: Token | TokenDocument | string, validModes: Array<string> = ["all"]): boolean {
  return canSenseModes(tokenEntity, targetEntity, validModes).length > 0;
}
export function canSenseModes(tokenEntity: Token | TokenDocument | string, targetEntity: Token | TokenDocument | string, validModes: Array<string> = ["all"]): Array<string> {
  const token = getToken(tokenEntity);
  const target = getToken(targetEntity);
  if (!token || !target) return [];
  return _canSenseModes(token, target, validModes);
}
export function initializeVision(tk: Token, force = false) {
  //@ts-expect-error
  const sightEnabled = tk.document.sight.enabled;

  //@ts-expect-error
  tk.document.sight.enabled = true;
  //@ts-expect-error
  tk.document._prepareDetectionModes();
  const sourceId = tk.sourceId;
  //@ts-expect-error
  if (game.release.generation >= 12) {
    //@ts-expect-error
    tk.vision = new CONFIG.Canvas.visionSourceClass({ sourceId, object: tk });
  }

  tk.vision.initialize({
    x: tk.center.x,
    y: tk.center.y,
    //@ts-expect-error
    elevation: tk.document.elevation,
    //@ts-expect-error
    radius: Math.clamp(tk.sightRange, 0, canvas?.dimensions?.maxR ?? 0),
    //@ts-expect-error
    externalRadius: tk.externalRadius, // Math.max(tk.mesh.width, tk.mesh.height) / 2,
    //@ts-expect-error
    angle: tk.document.sight.angle,
    //@ts-expect-error
    contrast: tk.document.sight.contrast,
    //@ts-expect-error
    saturation: tk.document.sight.saturation,
    //@ts-expect-error
    brightness: tk.document.sight.brightness,
    //@ts-expect-error
    attenuation: tk.document.sight.attenuation,
    //@ts-expect-error
    rotation: tk.document.rotation,
    //@ts-expect-error
    visionMode: tk.document.sight.visionMode,
    //@ts-expect-error
    color: globalThis.Color.from(tk.document.sight.color),
    //@ts-expect-error
    isPreview: !!tk._original,
    //@ts-expect-error specialStatusEffects
    blinded: tk.document.hasStatusEffect(CONFIG.specialStatusEffects.BLIND)
  });

  if (!tk.vision.los && game.modules.get("perfect-vision")?.active) {
    error(`canSense los not calcluated. Can't check if ${tk.name} can see`, tk.vision);
    return false;
  } else if (!tk.vision.los) {
    //@ts-expect-error
    tk.vision.shape = tk.vision._createRestrictedPolygon();
    //@ts-expect-error
    tk.vision.los = tk.vision.shape;
  }
  //@ts-expect-error
  tk.vision.anmimated = false;
  //@ts-expect-error
  canvas?.effects?.visionSources.set(sourceId, tk.vision);
  //@ ts-expect-error
  // tk.document.sight.enabled = sightEnabled;
  return true;
}
export function _canSenseModes(tokenEntity: Token | TokenDocument, targetEntity: Token | TokenDocument, validModesParam: Array<string> = ["all"]): Array<string> {
  //@ts-expect-error
  let target: Token = targetEntity instanceof TokenDocument ? targetEntity.object : targetEntity;
  //@ts-expect-error detectionModes
  const detectionModes = CONFIG.Canvas.detectionModes;
  //@ts-expect-error DetectionMode
  const DetectionModeCONST = DetectionMode;
  //@ts-expect-error
  let token: Token = getToken(tokenEntity);
  if (!token || !target) return ["noToken"];
  //@ts-expect-error .hidden
  if (target.document?.hidden || token.document?.hidden) return [];
  if (!token.hasSight && !configSettings.optionalRules.invisVision) return ["senseAll"];
  if ((!token.vision || !token.vision.los) && !initializeVision(token)) return ["noSight"];
  const matchedModes: Set<string> = new Set();
  // Determine the array of offset points to test
  const t = Math.min(target.w, target.h) / 4;
  const targetPoint = target.center;
  const offsets = t > 0 ? [[0, 0], [-t, -t], [-t, t], [t, t], [t, -t], [-t, 0], [t, 0], [0, -t], [0, t]] : [[0, 0]];
  const tests = offsets.map(o => ({
    point: new PIXI.Point(targetPoint.x + o[0], targetPoint.y + o[1]),
    los: new Map()
  }));
  const config = { tests, object: targetEntity };
  //@ts-expect-error
  const tokenDetectionModes = token.detectionModes;
  //@ts-expect-error
  const modes = CONFIG.Canvas.detectionModes;
  let validModes = new Set(validModesParam);

  //@ts-expect-error
  const lightSources = foundry.utils.isNewerVersion(game.system.version, "12.0") ? canvas?.effects?.lightSources : canvas?.effects?.lightSources.values();
  for (const lightSource of (lightSources ?? [])) {
    if (/*!lightSource.data.vision ||*/ !lightSource.active || lightSource.data.disabled) continue;
    if (!validModes.has(detectionModes.lightPerception?.id ?? DetectionModeCONST.BASIC_MODE_ID) && !validModes.has("all")) continue;
    const result = lightSource.testVisibility && lightSource.testVisibility(config);
    if (result === true) matchedModes.add(detectionModes.lightPerception?.id ?? DetectionModeCONST.BASIC_MODE_ID);
  }

  const lightPerception = tokenDetectionModes.find(m => m.id === modes.lightPerception?.id);
  if (lightPerception && ["lightPerception", "all"].some(mode => validModes.has(mode))) {
    // const result = modes.lightPerception.testVisibility(token.vision, basic, config);
    const result = lightPerception ? modes.lightPerception.testVisibility(token.vision, lightPerception, config) : false;
    if (result === true)
      matchedModes.add(detectionModes.lightPerception?.id ?? DetectionModeCONST.BASIC_MODE_ID);
  }

  const basic = tokenDetectionModes.find(m => m.id === DetectionModeCONST.BASIC_MODE_ID);
  if (basic && ["basicSight", "all"].some(mode => validModes.has(mode))) {
    const result = modes.basicSight.testVisibility(token.vision, basic, config);
    if (result === true)
      matchedModes.add(detectionModes.basicSight?.id ?? DetectionModeCONST.BASIC_MODE_ID);
  }
  for (const detectionMode of tokenDetectionModes) {
    if (detectionMode.id === DetectionModeCONST.BASIC_MODE_ID) continue;
    if (!detectionMode.enabled) continue;
    const dm = modes[detectionMode.id];
    if (validModes.has("all") || validModes.has(detectionMode.id)) {
      const result = dm?.testVisibility(token.vision, detectionMode, config)
      if (result === true) {
        matchedModes.add(detectionMode.id);
      }
    }
  }
  for (let tk of [token]) {
    //@ts-expect-error
    if (!tk.document.sight.enabled) {
      const sourceId = tk.sourceId;
      //@ts-expect-error
      canvas?.effects?.visionSources.delete(sourceId);
    }
  }
  return Array.from(matchedModes);
}

export function tokensForActor(actorRef: Actor | string | undefined | null): Token[] | undefined {
  let actor: Actor;
  if (!actorRef) return undefined
  if (typeof actorRef === "string") actor = fromActorUuid(actorRef);
  else actor = actorRef;
  if (!(actor instanceof Actor)) return undefined;
  //@ts-expect-error
  if (actor.token) return [actor.token.object];
  //@ts-expect-error getActiveTokens returns an array of tokens not tokenDocuments
  const tokens: Token[] = actor.getActiveTokens();
  if (!tokens.length) return undefined;
  //@ts-expect-error .controlled
  const controlled = tokens.filter(t => t.controlled);
  return controlled.length ? controlled : tokens;
}

export function tokenForActor(actor: Actor | string | undefined | null): Token | undefined {
  const tokens = tokensForActor(actor);
  if (!tokens) return undefined;
  return tokens[0];
}

export async function doConcentrationCheck(actor, saveDC) {
  const itemData = {
    "name": "Concentration Check - Midi QOL",
    "type": "weapon",
    "img": "./modules/midi-qol/icons/concentrate.png",
    "system": {
      "activities": {
        "concentrationCheck": {
          "type": "save",
          "activation": {
            "type": "special",
          },
          "target": {
            "affects": {
              "choice": false,
              "count": "",
              "type": "self"
            },
            "override": true,
            "prompt": false
          },
          "damage": {
            "parts": [],
            "onSave": "half"
          },
          "save": {
            "ability": "con",
            "dc": {
              "calculation": "",
              "formula": `${saveDC}`,
            }
          },
          "useConditionText": "",
          "forceDialog": false,
          "effectConditionText": "",
        }
      },
      "identifier": "concentration-check-midi-qol",
    },
    "flags": {
      "midi-qol": {
        "onUseMacroName": "[postActiveEffects]ItemMacro",
        "isConcentrationCheck": true,
      },
      "itemacro": {
        "macro": {
          "_id": null,
          "name": "Concentration Check - Midi QOL",
          "type": "script",
          "author": "devnIbfBHb74U9Zv",
          "img": "icons/svg/dice-target.svg",
          "scope": "global",
          "command": "\n\t\t\tif (MidiQOL.configSettings().autoCheckSaves === 'none') return;\n\t\t\tfor (let targetUuid of args[0].targetUuids) {\n\t\t\t\tlet target = await fromUuid(targetUuid);\n\t\t\t\tif (MidiQOL.configSettings().removeConcentration \n\t\t\t\t&& (target.actor.system.attributes.hp.value === 0 || args[0].failedSaveUuids.find(uuid => uuid === targetUuid))) {\n\t\t\t\tawait target.actor.endConcentration();\n\t\t\t\t}\n\t\t\t}",
          "folder": null,
          "sort": 0,
          "permission": {
            "default": 0
          },
          "flags": {}
        }
      },
      "midiProperties": {
        "confirmTargets": "none",
        "autoFailFriendly": false,
        "autoSaveFriendly": false,
      }
    }
  }

  foundry.utils.setProperty(itemData, "name", concentrationCheckItemDisplayName);
  foundry.utils.setProperty(itemData, `flags.${MODULE_ID}.noProvokeReaction`, true);
  return await _doConcentrationCheck(actor, itemData)
}

async function _doConcentrationCheck(actor, itemData) {
  let result;
  // actor took damage and is concentrating....
  let ownedItem: Item = new CONFIG.Item.documentClass(itemData, { parent: actor });
  // TODO: Horrible kludge to allow temporary items to be rolled since dnd5e insists on setting flags on temp items if there is damage/attacks
  ownedItem.setFlag = async (scope: string, key: string, value: any) => { return ownedItem };
  ownedItem.prepareData();
  //@ts-expect-error
  ownedItem.prepareFinalAttributes();
  //@ts-expect-error
  ownedItem.prepareEmbeddedDocuments();
  try {
    const midiOptions = { checkGMStatus: true, systemCard: false, createWorkflow: true, versatile: false, workflowOptions: { targetConfirmation: "none" } }
    result = await completeItemUseV2(ownedItem, { midiOptions }, { configure: false }, {}); // worried about multiple effects in flight so do one at a time
  } catch (err) {
    const message = "midi-qol | doConcentrationCheck";
    TroubleShooter.recordError(err, message);
    console.warn(message, err);
  } finally {
    return result;
  }
}

export function hasDAE(workflow: Workflow) {
  return installedModules.get("dae") && (
    workflow.item?.effects?.some(ef => ef?.transfer === false)
    || workflow.ammo?.effects?.some(ef => ef?.transfer === false)
  );
}

export function procActorSaveBonus(actor: Actor, rollType: string, item: Item): number {
  if (!item) return 0;
  //@ts-expect-error
  const bonusFlags = actor.system.bonuses?.save;
  if (!bonusFlags) return 0;
  let saveBonus = 0;
  if (bonusFlags.magic) {

    return 0;
  }
  if (bonusFlags.spell) {
    return 0;
  }
  if (bonusFlags.weapon) {
    return 0;
  }
  return 0;
}


export async function displayDSNForRoll(rolls: Roll | Roll[] | undefined, rollType: string | undefined, defaultRollMode: string | undefined = undefined) {
  if (!rolls) return;
  if (!(rolls instanceof Array)) rolls = [rolls];
  /*
  "midi-qol.hideRollDetailsOptions": {
    "none": "None",
    "detailsDSN": "Roll Formula but show DSN roll",
    "details": "Roll Formula",
    "d20Only": "Show attack D20 + Damage total",
    "hitDamage": "Show Hit/Miss + damage total",
    "hitCriticalDamage": "Show Hit/Miss/Critical/Fumble + damage total",
    "d20AttackOnly": "Show attack D20 Only",
    "all": "Entire Roll"
  },*/
  for (let roll of rolls) {
    if (dice3dEnabled()) {
      //@ts-expect-error game.dice3d
      const dice3d = game.dice3d;
      const hideRollOption = configSettings.hideRollDetails;
      let ghostRoll = false;
      let whisperIds: User[] | null = null;
      const rollMode = defaultRollMode || game.settings.get("core", "rollMode");
      let hideRoll = (["all"].includes(hideRollOption) && game.user?.isGM) ? true : false;
      if (!game.user?.isGM) hideRoll = false;
      else if (hideRollOption !== "none") {
        if (configSettings.gmHide3dDice && game.user?.isGM) hideRoll = true;
        if (game.user?.isGM && !hideRoll) {
          switch (rollType) {
            case "attackRollD20":
              if (["d20Only", "d20AttackOnly", "detailsDSN"].includes(hideRollOption)) {
                for (let i = 1; i < roll.dice.length; i++) { // hide everything except the d20
                  roll.dice[i].results.forEach(r => foundry.utils.setProperty(r, "hidden", true));
                }
                hideRoll = false;
              } else if ((["hitDamage", "all", "hitCriticalDamage", "details"].includes(hideRollOption) && game.user?.isGM))
                hideRoll = true;
              break;
            case "attackRoll":
              hideRoll = hideRollOption !== "detailsDSN";
              break;
            case "damageRoll":
              hideRoll = hideRollOption !== "detailsDSN";
              break;
            default:
              hideRoll = false;
              break;
          }
        }
      }
      if (hideRoll && configSettings.ghostRolls && game.user?.isGM && !configSettings.gmHide3dDice) {
        ghostRoll = true;
        hideRoll = false;
      } else {
        ghostRoll = rollMode === "blindroll";
      }

      if (rollMode === "selfroll" || rollMode === "gmroll" || rollMode === "blindroll") {
        whisperIds = ChatMessage.getWhisperRecipients("GM");
        if (rollMode !== "blindroll" && game.user) whisperIds.concat(game.user);
      }
      if (!hideRoll) {
        let displayRoll = Roll.fromData(JSON.parse(JSON.stringify(roll))); // make a copy of the roll
        if (game.user?.isGM && configSettings.addFakeDice) {
          for (let term of displayRoll.terms) {
            if (term instanceof Die) {
              // for attack rolls only add a d20 if only one was rolled - else it becomes clear what is happening
              if (["attackRoll", "attackRollD20"].includes(rollType ?? "") && term.faces === 20 && term.number !== 1) continue;
              let numExtra = Math.ceil(term.number * Math.random());
              let extraDice = await (new Die({ faces: term.faces, number: numExtra }).evaluate());
              term.number += numExtra;
              term.results = term.results.concat(extraDice.results);
            }
          }
        }
        displayRoll.terms.forEach(term => {
          if (term.options?.flavor) term.options.flavor = term.options.flavor.toLocaleLowerCase();
          //@ts-expect-error
          else term.options.flavor = displayRoll.options.type;
        });
        const promises: Promise<any>[] = [];
        if (ghostRoll) {
          promises.push(dice3d?.showForRoll(displayRoll, game.user, true, ChatMessage.getWhisperRecipients("GM"), !game.user?.isGM));
          if (game.settings.get("dice-so-nice", "showGhostDice")) {
            //@ts-expect-error
            displayRoll.ghost = true;
            promises.push(dice3d?.showForRoll(displayRoll, game.user, true, game.users?.players.map(u => u.id), game.user?.isGM));
          }
        } else
          promises.push(dice3d?.showForRoll(displayRoll, game.user, true, whisperIds, rollMode === "blindroll" && !game.user?.isGM));
        await Promise.allSettled(promises);
      }
    }
    //mark all dice as shown - so that toMessage does not trigger additional display on other clients
    DSNMarkDiceDisplayed(roll);
  }
}

export function DSNMarkDiceDisplayed(rolls: Roll | Roll[]) {
  if (rolls instanceof Roll) rolls = [rolls];
  for (let roll of rolls)
    roll.dice.forEach(d => d.results.forEach(r => foundry.utils.setProperty(r, "hidden", true)));
}

export function isReactionItem(item): boolean {
  if (!item) return false;
  return item.system.activation?.type?.includes("reaction");
}

export function getCriticalDamage() {
  return game.user?.isGM ? criticalDamageGM : criticalDamage;
}

export function isTargetable(target: any /*Token*/): boolean {
  if (!target.actor) return false;
  if (target.actor.type === "group") return false;
  if (foundry.utils.getProperty(target.actor, `flags.${MODULE_ID}.neverTarget`)) return false;

  const targetDocument = getTokenDocument(target);
  //@ts-expect-error hiddien
  if (targetDocument?.hidden) return false;
  if (foundry.utils.getProperty(target.actor, "system.details.type.custom")?.toLocaleLowerCase().includes("notarget")) {
    console.warn("midi-qol | system.type.custom === 'notarget' is deprecated in favour or flags.midi-qol.neverTarget = true")
    return false;
  }
  if (foundry.utils.getProperty(target.actor, "actor.system.details.race")?.toLocaleLowerCase().includes("notarget")) {
    console.warn("midi-qol | system.details.race === 'notarget' is deprecated in favour or flags.midi-qol.neverTarget = true")
    return false;
  }
  if (foundry.utils.getProperty(target.actor, "actor.system.details.race")?.toLocaleLowerCase().includes("trigger")) {
    console.warn("midi-qol | system.details.race === 'trigger' is deprecated in favour or flags.midi-qol.neverTarget = true")
    return false;
  }
  return true;
}

export function hasWallBlockingCondition(target: any /*Token*/): boolean {
  return globalThis.MidiQOL.WallsBlockConditions.some(cond => hasCondition(target.actor, cond));
}

function contestedRollFlavor(baseFlavor: string | undefined, rollType: string, ability: string): string {
  let flavor;
  let title;
  if (rollType === "test" || rollType === "abil") {
    const label = GameSystemConfig.abilities[ability]?.label ?? ability;
    flavor = game.i18n.format("DND5E.AbilityPromptTitle", { ability: label });
  } else if (rollType === "save") {
    const label = GameSystemConfig.abilities[ability].label;
    flavor = game.i18n.format("DND5E.SavePromptTitle", { ability: label });
  } else if (rollType === "skill") {
    flavor = game.i18n.format("DND5E.SkillPromptTitle", { skill: GameSystemConfig.skills[ability]?.label ?? "" });
  }
  return `${baseFlavor ?? i18n("midi-qol.ContestedRoll")} ${flavor}`;
}
export function validRollAbility(rollType: string, ability: string): string | undefined {
  if (typeof ability !== "string") return undefined;
  ability = ability.toLocaleLowerCase().trim();
  switch (rollType) {
    case "test":
    case "abil":
    case "save":
      if (GameSystemConfig.abilities[ability]) return ability;
      return Object.keys(GameSystemConfig.abilities).find(abl => GameSystemConfig.abilities[abl].label.toLocaleLowerCase() === ability.trim().toLocaleLowerCase())
    case "skill":
      if (GameSystemConfig.skills[ability]) return ability;
      return Object.keys(GameSystemConfig.skills).find(skl => GameSystemConfig.skills[skl].label.toLocaleLowerCase() === ability.trim().toLocaleLowerCase())
    default: return undefined;
  }
}
export async function contestedRoll(data: {
  source: { rollType: string, ability: string, token: Token | TokenDocument | string, rollOptions: any },
  target: { rollType: string, ability: string, token: Token | TokenDocument | string, rollOptions: any },
  displayResults: boolean,
  itemCardId: string,
  itemCardUuid: string,
  flavor: string,
  rollOptions: any,
  success: (results) => {}, failure: (results) => {}, drawn: (results) => {}
}): Promise<{ result: number | undefined, rolls: any[] }> {
  const source = data.source;
  const target = data.target;
  const sourceToken = getToken(source?.token);
  const targetToken = getToken(target?.token);
  const { rollOptions, success, failure, drawn, displayResults, itemCardId, itemCardUuid, flavor } = data;

  let canProceed = true;
  if (!source || !target || !sourceToken || !targetToken || !source.rollType || !target.rollType || !source.ability || !target.ability || !validRollAbility(source.rollType, source.ability) || !validRollAbility(target.rollType, target.ability)) {
    error(`contestRoll | source[${sourceToken?.name}], target[${targetToken?.name}], source.rollType[${source.rollType}], target.rollType[${target?.rollType}], source.ability[${source.ability}], target.ability[${target?.ability}] must all be defined`);
    canProceed = false;
  }
  if (!["test", "abil", "save", "skill"].includes(source?.rollType ?? "")) {
    error(`contestedRoll | sourceRollType must be one of test/abil/skill/save not ${source.rollType}`);
    canProceed = false;
  }
  if (!["test", "abil", "save", "skill"].includes(target?.rollType ?? "")) {
    error(`contestedRoll | target.rollType must be one of test/abil/skill/save not ${target.rollType}`);
    canProceed = false;
  }

  const sourceDocument = getTokenDocument(source?.token);
  const targetDocument = getTokenDocument(target?.token);


  if (!sourceDocument || !targetDocument) canProceed = false;
  if (!canProceed) return { result: undefined, rolls: [] }
  source.ability = validRollAbility(source.rollType, source.ability) ?? "";
  target.ability = validRollAbility(target.rollType, target.ability) ?? "";

  let player1 = playerFor(sourceToken);
  //@ts-expect-error activeGM
  if (!player1?.active) player1 = game.users?.activeGM;
  let player2 = playerFor(targetToken);
  //@ts-expect-error activeGM
  if (!player2?.active) player2 = game.users?.activeGM;
  if (!player1 || !player2) return { result: undefined, rolls: [] };
  const sourceFlavor = contestedRollFlavor(flavor, source.rollType, source.ability)
  const sourceOptions = foundry.utils.mergeObject(foundry.utils.duplicate(source.rollOptions ?? rollOptions ?? {}), {
    mapKeys: false,
    flavor: sourceFlavor,
    title: `${sourceFlavor}: ${sourceToken?.name} vs ${targetToken?.name}`
  });
  const targetFlavor = contestedRollFlavor(flavor, target.rollType, target.ability);
  const targetOptions = foundry.utils.mergeObject(foundry.utils.duplicate(target.rollOptions ?? rollOptions ?? {}), {
    mapKeys: false,
    flavor: targetFlavor,
    title: `${targetFlavor}: ${targetToken?.name} vs ${sourceToken?.name}`
  });
  const resultPromises = [
    socketlibSocket.executeAsUser("rollAbilityV2", player1.id, { request: source.rollType.trim(), targetUuid: sourceDocument?.uuid, ability: source.ability.trim(), options: sourceOptions }),
    socketlibSocket.executeAsUser("rollAbilityV2", player2.id, { request: target.rollType.trim(), targetUuid: targetDocument?.uuid, ability: target.ability.trim(), options: targetOptions }),
  ];

  let results = await Promise.all(resultPromises);
  let result: number | undefined = results[0].total - results[1].total;
  if (isNaN(result)) result = undefined;
  if (displayResults !== false) {
    let resultString;
    if (result === undefined) resultString = "";
    else resultString = result > 0 ? i18n("midi-qol.save-success") : result < 0 ? i18n("midi-qol.save-failure") : result === 0 ? i18n("midi-qol.save-drawn") : "no result"
    const skippedString = i18n("midi-qol.Skipped");
    const content = `${flavor ?? i18n("midi-qol.ContestedRoll")} ${resultString} ${results[0].total ?? skippedString} ${i18n("midi-qol.versus")} ${results[1].total ?? skippedString}`;
    displayContestedResults(itemCardUuid, content, ChatMessage.getSpeaker({ token: sourceToken }), flavor);
  }

  if (result === undefined) return { result, rolls: results };
  if (result > 0 && success) success(results);
  else if (result < 0 && failure) failure(results);
  else if (result === 0 && drawn) drawn(results)
  return { result, rolls: results };
}

function displayContestedResults(chatCardUuid: string | undefined, resultContent: string, speaker, flavor: string | undefined) {
  let itemCard = getCachedDocument(chatCardUuid) ?? MQfromUuidSync(chatCardUuid);
  if (itemCard) {
    let content = foundry.utils.duplicate(itemCard.content ?? "")
    const searchRE = /<div class="midi-qol-saves-display">[\s\S]*?<div class="end-midi-qol-saves-display">/;
    const replaceString = `<div class="midi-qol-saves-display">${resultContent}<div class="end-midi-qol-saves-display">`;
    content = content.replace(searchRE, replaceString);
    itemCard.update({ "content": content });
  } else {
    // const title = `${flavor ?? i18n("miidi-qol:ContestedRoll")} results`;
    ChatMessage.create({ content: `<p>${resultContent}</p>`, speaker });
  }
}

export function getActor(actorRef: Actor | Token | TokenDocument | string | null | undefined): Actor | undefined | null {
  if (!actorRef) return null;
  if (actorRef instanceof Actor) return actorRef;
  if (actorRef instanceof Token) return actorRef.actor;
  if (actorRef instanceof TokenDocument) return actorRef.actor;
  let entity: any = actorRef;
  //@ts-expect-error
  if (typeof actorRef === "string") entity = fromUuidSync(actorRef);
  if (entity instanceof Actor) return entity;
  if (entity instanceof TokenDocument) return entity.actor;
  if (entity instanceof Item && entity.parent instanceof Actor) return entity.parent;
  if (entity instanceof ActiveEffect && entity.parent instanceof Actor) return entity.parent;
  if (entity instanceof ActiveEffect && entity.parent instanceof Item && entity.parent.parent instanceof Actor) return entity.parent.parent;
  return null;
}

export function getTokenDocument(tokenRef: Actor | Token | TokenDocument | string | undefined): TokenDocument | undefined {
  if (!tokenRef) return undefined;
  if (tokenRef instanceof TokenDocument) return tokenRef;
  if (typeof tokenRef === "string") {
    const document = MQfromUuidSync(tokenRef);
    if (document instanceof TokenDocument) return document;
    if (document instanceof Actor) return tokenForActor(document)?.document;
  }
  if (tokenRef instanceof Token) return tokenRef.document;
  if (tokenRef instanceof Actor) return tokenForActor(tokenRef)?.document;
  return undefined;
}

export function getToken(tokenRef: Actor | Token | TokenDocument | string | undefined | null): Token | undefined {
  if (!tokenRef) return undefined;
  if (tokenRef instanceof Token) return tokenRef;
  //@ts-expect-error return cast
  if (tokenRef instanceof TokenDocument) return tokenRef.object;
  let entity: any = tokenRef;
  if (typeof tokenRef === "string") {
    entity = MQfromUuidSync(tokenRef);
  }
  if (entity instanceof Token) return entity;
  //@ts-expect-error return cast
  if (entity instanceof TokenDocument) return entity.object;
  if (entity instanceof Actor) return tokenForActor(entity);
  if (entity instanceof Item && entity.parent instanceof Actor) return tokenForActor(entity.parent);
  if (entity instanceof ActiveEffect && entity.parent instanceof Actor) return tokenForActor(entity.parent);
  if (entity instanceof ActiveEffect && entity.parent instanceof Item) return tokenForActor(entity.parent?.parent);
  return undefined;
}

export function getPlaceable(tokenRef: Actor | Token | TokenDocument | string | PlaceableObject | undefined): PlaceableObject | undefined | null {
  if (!tokenRef) return undefined;
  if (tokenRef instanceof PlaceableObject) return tokenRef;
  let entity: any = tokenRef;
  if (typeof tokenRef === "string") {
    entity = MQfromUuidSync(tokenRef);
  }
  if (entity instanceof PlaceableObject) return entity;
  if (entity.object instanceof PlaceableObject) return entity.object;
  if (entity instanceof Actor) return tokenForActor(entity);
  if (entity instanceof Item && entity.parent instanceof Actor) return tokenForActor(entity.parent);
  if (entity instanceof ActiveEffect && entity.parent instanceof Actor) return tokenForActor(entity.parent);
  if (entity instanceof ActiveEffect && entity.parent instanceof Item) return tokenForActor(entity.parent?.parent);
  return undefined;
}

export function calcTokenCover(attacker: Token | TokenDocument, target: Token | TokenDocument): number {
  const attackerToken = getToken(attacker);
  const targetToken = getToken(target);

  //@ts-expect-error .coverCalc
  const coverCalc = attackerToken.coverCalculator;
  if (!attackerToken || !targetToken || !coverCalc) {
    let message = "midi-qol | calcTokenCover | failed";
    if (!coverCalc)
      message += " tokencover not installed or cover calculator not found";
    if (!attackerToken)
      message += " atacker token not valid";
    if (!targetToken)
      message += " target token not valid";
    const err = new Error("calcTokenCover failed");
    TroubleShooter.recordError(err, message);
    console.warn(message, err);
    return 0;
  }
  let targetCover = coverCalc.targetCover(target);
  return targetCover;
}

export function itemRequiresConcentration(item): boolean {
  return item?.requiresConcentration;
  // midi properties no longer supported so just use dnd5e's function
  if (!item) return false;
  return item.system.properties.has("concentration")
    || item.flags.midiProperties?.concentration;
}

const MaxNameLength = 20;
export function getLinkText(entity: Token | TokenDocument | Actor | Item | null | undefined) {
  if (!entity) return "<unknown>";
  let name = entity.name ?? "unknown";
  if (entity instanceof Token && !configSettings.useTokenNames) name = entity.actor?.name ?? name;
  if (entity instanceof Token) return `@UUID[${entity.document.uuid}]{${name.slice(0, MaxNameLength - 5)}}`;
  return `@UUID[${entity.uuid}]{${entity.name?.slice(0, MaxNameLength - 5)}}`;
}

export function getTokenName(entity: Token | TokenDocument | undefined): string {
  if (!entity) return "<unknown>";
  entity = getToken(entity)
  if (!(entity instanceof Token)) return "<unknown>";
  if (configSettings.useTokenNames) return entity.name ?? entity.actor?.name ?? "<unknown>";
  else return entity.actor?.name ?? entity.name ?? "<unknown>";
}

export function getIconFreeLink(entity: Token | TokenDocument | Item | Actor | null | undefined) {
  if (!entity) return "<unknown>";
  let name = entity.name ?? "unknown";
  if (entity instanceof Token && !configSettings.useTokenNames) name = entity.actor?.name ?? name;
  if (entity instanceof Token) {
    return name;
    // return `<a class="content-link midi-qol" data-uuid="${entity.actor?.uuid}">${name?.slice(0, MaxNameLength)}</a>`;
  } else {
    return name;
    // return `<a class="content-link midi-qol" data-uuid="${entity.uuid}">${name?.slice(0, MaxNameLength)}</a>`
  }
}

export function midiMeasureDistances(segments: { ray: Ray }[], options: any = {}) {
  //@ts-expect-error
  if (game.release.generation > 11) {
    let isGridless = canvas?.grid?.constructor.name === "GridlessGrid";
    if (!isGridless || !options.gridSpaces || !configSettings.griddedGridless || !canvas?.grid) {
      //@ts-expect-error
      return segments.map(s => canvas?.grid?.measurePath([s.ray.A, s.ray.B])).map(d => d.distance);;
    }
    if (!canvas?.grid) return 0;
    const diagonals = safeGetGameSetting("core", "gridDiagonals");
    const canvasGridProxy = new Proxy(canvas.grid, {
      get: function (target, prop, receiver) {
        //@ts-expect-error
        if (foundry.grid.SquareGrid.prototype[prop] instanceof Function) {
          //@ts-expect-error
          return foundry.grid.SquareGrid.prototype[prop].bind(canvasGridProxy);
        } else if (prop === "diagonals") {
          return diagonals;
        } else if (prop === "isSquare") return true;
        else if (prop === "isGridless") return false;
        else if (prop === "isHex") return false;
        return Reflect.get(target, prop);
      }
    });
    //@ts-expect-error
    const GridDiagonals = CONST.GRID_DIAGONALS;
    // First snap the poins to the nearest center point for equidistant/1,2,1/2,1,2
    // I expected this would happen automatically in the proxy call - but didn't and not sure why.
    if ([GridDiagonals.APPROXIMATE, GridDiagonals.EQUIDISTANT, GridDiagonals.ALTERNATING_1, GridDiagonals.ALTERNATING_2].includes(diagonals)) {
      segments = segments.map(s => {
        const gridPosA = canvasGridProxy.getOffset(s.ray.A);
        const aCenter = canvasGridProxy.getCenterPoint(gridPosA);
        const gridPosB = canvasGridProxy.getOffset(s.ray.B);
        const bCenter = canvasGridProxy.getCenterPoint(gridPosB);
        return { ray: new Ray(aCenter, bCenter) };
      });
    }
    //@ ts-expect-error
    let distances = segments.map(s => canvasGridProxy.measurePath([s.ray.A, s.ray.B]));
    return distances = distances.map(d => {
      let distance = d.distance;
      let fudgeFactor = configSettings.gridlessFudge ?? 0;
      switch (diagonals) {
        case GridDiagonals.EQUIDISTANT:
        case GridDiagonals.ALTERNATING_1:
        case GridDiagonals.ALTERNATING_2:
          // already fudged by snapping so no extra adjustment
          break;
        case GridDiagonals.EXACT:
        case GridDiagonals.RECTILINEAR:
          if (d.diagonals > 0)
            distance = d.distance - (Math.SQRT2 * fudgeFactor);
          else distance = d.distance - fudgeFactor;
          break;
        case GridDiagonals.APPROXIMATE:
          if (d.diagonals > 0)
            distance = d.distance - fudgeFactor;
          break;
        case GridDiagonals.ILLEGAL:
        default:
          distance = d.distance;
      }
      return distance;
    });
  } else {
    let isGridless;
    isGridless = canvas?.grid?.grid?.constructor.name === "BaseGrid";
    if (!isGridless || !options.gridSpaces || !configSettings.griddedGridless) {
      const distances = canvas?.grid?.measureDistances(segments, options);
      if (!configSettings.gridlessFudge) return distances; // TODO consider other impacts of doing this
      return distances;
    }

    const rule = safeGetGameSetting("dnd5e", "diagonalMovement") ?? "EUCL"; // V12

    if (!configSettings.gridlessFudge || !options.gridSpaces || !["555", "5105", "EUCL"].includes(rule)) {
      return canvas?.grid?.measureDistances(segments, options);
    }

    // Track the total number of diagonals
    let nDiagonal = 0;
    const d = canvas?.dimensions;
    //@ts-expect-error .grid
    const grid = canvas?.scene?.grid;
    if (!d || !d.size) return 0;
    const fudgeFactor = configSettings.gridlessFudge / d.distance;
    // Iterate over measured segments
    return segments.map(s => {
      let r = s.ray;

      // Determine the total distance traveled
      let nx = Math.ceil(Math.max(0, Math.abs(r.dx / d.size) - fudgeFactor));
      let ny = Math.ceil(Math.max(0, Math.abs(r.dy / d.size) - fudgeFactor));

      // Determine the number of straight and diagonal moves
      let nd = Math.min(nx, ny);
      let ns = Math.abs(ny - nx);
      nDiagonal += nd;

      // Alternative DMG Movement
      if (rule === "5105") {
        let nd10 = Math.floor(nDiagonal / 2) - Math.floor((nDiagonal - nd) / 2);
        let spaces = (nd10 * 2) + (nd - nd10) + ns;
        return spaces * d.distance;
      }

      // Euclidean Measurement
      else if (rule === "EUCL") {
        let nx = Math.max(0, Math.abs(r.dx / d.size) - fudgeFactor);
        let ny = Math.max(0, Math.abs(r.dy / d.size) - fudgeFactor);
        return Math.ceil(Math.hypot(nx, ny) * grid?.distance);
      }

      // Standard PHB Movement
      else return Math.max(nx, ny) * grid.distance;
    });
  }
}

export function getActivityAutoTarget(activity: any): string {
  if (!activity) return configSettings.autoTarget;
  //TODO move this to per activity flag
  const midiFlags = foundry.utils.getProperty(activity.item, `flags.${MODULE_ID}`);
  const autoTarget = midiFlags.autoTarget;
  if (!autoTarget || autoTarget === "default") return configSettings.autoTarget;
  return autoTarget;
}

export function getAoETargetType(activity): string {
  let AoETargetType = foundry.utils.getProperty(activity.workflow, `item.flags.${MODULE_ID}.AoETargetType`) ?? "any";
  // think about special = allies, self = all but self and any means everyone.
  const activityTarget = activity.target;
  if (activityTarget) {
    if (activityTarget.affects.type === "ally") AoETargetType = "ally";
    if (activityTarget.affects.type === "enemy") AoETargetType = "enemy";
    if (activityTarget.affects.type === "creature") AoETargetType = "any";
  }
  if (!activityTarget?.override) {
    if ((foundry.utils.getProperty(activity, `item.flags.${MODULE_ID}.AoETargetType`) ?? "any") !== "any") {
      AoETargetType = foundry.utils.getProperty(activity, `item.flags.${MODULE_ID}.AoETargetType`);
    }
  }
  return AoETargetType;
}
export function getAutoTarget(item: Item): string {
  //@ts-expect-error
  foundry.utils.logCompatibilityWarning("getAutoTarget(item) is deprecated in favor of getActivityAutoTargetType(activity).", { since: "12.1.0", until: "12.5.0" });

  if (!item) return configSettings.autoTarget;
  const midiFlags = foundry.utils.getProperty(item, `flags.${MODULE_ID}`);
  const autoTarget = midiFlags.autoTarget;
  if (!autoTarget || autoTarget === "default") return configSettings.autoTarget;
  return autoTarget;
}
export function hasAutoPlaceTemplate(item) {
  return item && item.hasAreaTarget && ["self"].includes(item.system.range?.units) && ["radius", "squareRadius"].includes(item.system.target.type);
}

export function activityHasAutoPlaceTemplate(activity) {
  return activity && ["self"].includes(activity.range?.units) && ["radius", "squareRadius"].includes(activity.target.template.type);
}

export function activityHasEmanationNoTemplate(activity) {
  return activity && activity.target.template.type === "emanationNoTemplate";
}
export function itemOtherFormula(item): string {
  console.log("itemOtherFormula", item);
  return "";
  const isVersatle = item?.isVersatile && item?.system.properties?.has("ver");
  if ((item?.system.formula ?? "") !== "") return item.system.formula;
  if (item?.type === "weapon" && !isVersatle) return item.system.damage.versatile ?? "";
  return "";
}
export function addRollTo(roll: Roll, bonusRoll: Roll): Roll {
  //@ts-expect-error
  const OperatorTerm = foundry.dice.terms.OperatorTerm;
  if (!bonusRoll) return roll;
  if (!roll) return bonusRoll;
  //@ts-expect-error _evaluated
  if (!roll._evaluated) roll = roll.clone().evaluate({ async: false }); // V12
  else {
    for (let term of roll.terms) {
      //@ts-expect-error _evaluated
      if (!term._evaluated && term instanceof OperatorTerm) {
        term.evaluate();
      }
    }
  }
  //@ts-expect-error _evaluate
  if (!bonusRoll._evaluated) bonusRoll = bonusRoll.clone().evaluate({ async: false }) // V12
  let terms;
  if (bonusRoll.terms[0] instanceof OperatorTerm) {
    terms = roll.terms.concat(bonusRoll.terms);
  } else {
    const operatorTerm = new OperatorTerm({ operator: "+" });
    operatorTerm.evaluate();
    terms = roll.terms.concat([operatorTerm]);
    terms = terms.concat(bonusRoll.terms);
  }
  let newRoll = Roll.fromTerms(terms);
  newRoll.options = roll.options;
  return newRoll;
}

export async function chooseEffect({ speaker, actor, token, character, item, args, scope, workflow, options }) {
  let second1TimeoutId;
  let timeRemaining;
  if (!item) return false;
  const effects = item.effects.filter(
    (e) => !e.transfer && foundry.utils.getProperty(e, 'flags.dae.dontApply') === true
  );
  if (effects.length === 0) {
    if (debugEnabled > 0)
      warn(`chooseEffect | no effects found for ${item.name}`);
    return false;
  }
  let targets = workflow.effectTargets;
  let origin = item?.uuid;
  if (workflow?.chatCard.getFlag("dnd5e", "use.concentrationId")) {
    origin = workflow.actor.effects.get(workflow.chatCard.getFlag("dnd5e", "use.concentrationId"))?.uuid ?? item?.uuid;
  }
  if (!targets || targets.size === 0) return;
  let returnValue = new Promise((resolve, reject) => {
    const callback = async function (dialog, html, event) {
      clearTimeout(timeoutId);
      const effectData = this.toObject();
      effectData.origin = item.uuid;
      effectData.flags.dae.dontApply = false;
      const applyItem = item.clone({ effects: [effectData] }, { keepId: true })
      await globalThis.DAE.doEffects(
        applyItem, true, targets, {
        damageTotal: 0,
        origin,
        critical: false,
        fumble: false,
        itemCardId: "",
        itemCardUuid: "",
        metaData: {},
        selfEffects: "none",
        spellLevel: (applyItem.level ?? 0),
        toggleEffect: applyItem?.flags.midiProperties?.toggleEffect,
        tokenId: token.id,
        tokenUuid: token.document.uuid,
        actorUuid: actor.uuid,
        whisper: false,
        workflowOptions: this.workflowOptions,
        context: {
        }
      })
      if (this.toObject()) {
        if (this.debugEnabled)
          warn(
            `chooseEffect | applying effect ${this.name} to ${targets.size} targets`,
            targets
          );/*
        for (let target of targets) {
          await target.actor.createEmbeddedDocuments('ActiveEffect', [
            effectData,
          ]);
        }*/
      }
      resolve(this);
    };
    const style = `
			<style>
			.dnd5e2.effectNoTarget.dialog .dialog-buttons button.dialog-button {
			  	border: 5px;
				background: var(--dnd5e-color-grey);
				margin: 0;
				display: grid;			
				grid-template-columns: 40px 150px;
				grid-gap: 5px
			}
	   		.dnd5e2.effectNoTarget.dialog .dialog-buttons button.dialog-button span {
				overflow: hidden;
    			text-overflow: ellipsis;
		  	}
		   .dnd5e2.effectNoTarget.dialog .window-header .window-title {
				visibility: visible;
				color: initial;
				text-align: center;
				font-weight: bold;
		   	}
			</style>`;
    function render([html]) {
      html.parentElement.querySelectorAll('.dialog-button').forEach((n) => {
        const img = document.createElement('IMG');
        const eff = MQfromUuidSync(n.dataset.button);
        //@ts-expect-error
        img.src = eff.img ?? eff.icon;
        const effNameSpan = document.createElement('span');
        effNameSpan.textContent = eff.name;
        n.innerHTML = '';
        n.appendChild(img);
        n.appendChild(effNameSpan);
        n.dataset.tooltip = eff.name;
      });
    }
    let buttons = {};
    for (let effect of effects) {
      buttons[effect.uuid] = {
        label: effect.name,
        callback: callback.bind(effect),
      };
    }
    let timeout =
      options?.timeout ?? configSettings.reactionTimeout ?? defaultTimeout;
    timeRemaining = timeout;
    //@ts-expect-error
    const Mixin = game.system.applications.DialogMixin(Dialog);
    const dialogOptions = {
      classes: ['dnd5e2', 'effectNoTarget', 'dialog'],
      width: 220,
      height: 'auto',
    };
    const data = {
      title: `${i18n('CONTROLS.CommonSelect')} ${i18n(
        'DOCUMENT.ActiveEffect'
      )}: ${timeRemaining}s`,
      content: `<center><b>${i18n('EFFECT.StatusTarget')}: [</b>${[
        ...targets,
      ].map((t) => t.name)}<b>]</b></center> ${style}`,
      buttons,
      render,
    };

    let dialog = new Mixin(data, dialogOptions);
    dialog.render(true);
    const set1SecondTimeout = function () {
      second1TimeoutId = setTimeout(() => {
        if (!timeoutId) return;
        timeRemaining -= 1;
        dialog.data.title = `${i18n('CONTROLS.CommonSelect')} ${i18n(
          'DOCUMENT.ActiveEffect'
        )}: ${timeRemaining}s`;
        dialog.render(false);
        if (timeRemaining > 0) set1SecondTimeout();
      }, 1000);
    };
    let timeoutId = setTimeout(() => {
      if (debugEnabled > 0) warn(`chooseEffect | timeout fired closing dialog`);
      clearTimeout(second1TimeoutId);
      dialog.close();
      reject('timeout');
    }, timeout * 1000);
    set1SecondTimeout();
  });
  return await returnValue;
}

export function canSee(tokenEntity, targetEntity) {
  const NON_SIGHT_CONSIDERED_SIGHT = ["blindsight"];
  //@ts-expect-error
  const detectionModes = CONFIG.Canvas.detectionModes;
  const sightDetectionModes = Object.keys(detectionModes).filter(
    (d) =>
      //@ts-expect-error DetectionMode
      detectionModes[d].type === DetectionMode.DETECTION_TYPES.SIGHT ||
      NON_SIGHT_CONSIDERED_SIGHT.includes(d)
  );
  return canSense(tokenEntity, targetEntity, sightDetectionModes);
}

export function sumRolls(rolls: Array<Roll> | undefined = [], countHealing?: "ignore" | "negative" | "positive" | "negativeIgnoreTemp" | "positiveIgnoreTemp"): number {
  if (!rolls) return 0;
  if (countHealing === undefined) countHealing = "positive";
  return rolls.reduce((total, roll) => {
    //@ts-expect-error
    const type = roll.options.type;
    if (type === "midi-none") return total;
    if (["temphp"].includes(type) && countHealing === "negativeIgnoreTemp") return total;
    if (["temphp"].includes(type) && countHealing === "positiveIgnoreTemp") return total;
    if (["temphp", "healing"].includes(type) && countHealing === "ignore") return total;
    if (["temphp", "healing"].includes(type) && countHealing?.startsWith("negative")) return total - (roll?.total ?? 0);
    return total + (roll?.total ?? 0);
  }, 0);
}

const updatesCache = {};
export async function _updateAction(document) {
  if (!updatesCache[document.uuid]) return;
  const updates = updatesCache[document.uuid];
  clearUpdatesCache(document.uuid);
  if (debugEnabled > 0) warn("update action | Doing updateAction", updates);
  const baseDocument = MQfromUuidSync(document.uuid);
  return await baseDocument.update(updates);
}

export async function debouncedUpdate(document, updates, immediate = false) {
  if (!DebounceInterval) {
    if (debugEnabled > 0) console.warn("debouncedUpdate | performing update", immediate);
    const result = await document.update(updates);
    return result;
  }
  if (debugEnabled > 0) {
    if (updatesCache[document.uuid]) {
      warn("debouncedUpdate | Cache not empty");
    } else warn("debouncedUpdate | cache empty");
  }
  updatesCache[document.uuid] = foundry.utils.mergeObject((updatesCache[document.uuid] ?? {}), updates, { overwrite: true })
  if (immediate) {
    const result = await _updateAction(document);
    return result;
  }
  return await _debouncedUpdateAction(document);
}
export function getUpdatesCache(uuid: string | undefined | null) {
  if (!uuid) return {};
  if (!updatesCache[uuid]) return {};
  return updatesCache[uuid];
}
export function clearUpdatesCache(uuid: string | undefined | null) {
  if (!uuid) return;
  delete updatesCache[uuid];
}

export function getCachedDocument(uuid: string | undefined | null) {
  if (!uuid) return undefined;
  let document = MQfromUuidSync(uuid);
  let updates = document?.uuid && updatesCache[document.uuid];
  if (updates) {
    document = foundry.utils.deepClone(document);
    Object.keys(updates).forEach(key => { foundry.utils.setProperty(document, key, updates[key]) });
  }
  return document;
}

export function isEffectExpired(effect): boolean {
  if (installedModules.get("times-up") && globalThis.TimesUp.isEffectExpired) {
    return globalThis.TimesUp.isEffectExpired(effect);
  }
  // TODO find out how to check some other module can delete expired effects
  // return effect.updateDuration().remaining ?? false;
  return effect.duration.remaining <= 0;
}

export async function expireEffects(actor, effects: ActiveEffect[], options: any): Promise<any> {
  if (!effects) return {};
  const actorEffectsToDelete: string[] = [];
  const effectsToDelete: ActiveEffect[] = [];
  const effectsToDisable: ActiveEffect[] = [];
  for (let effect of effects) {
    if (!effect.id) continue;
    if (!MQfromUuidSync(effect.uuid)) continue;
    //@ts-expect-error
    if (effect.transfer)
      effectsToDisable.push(effect);
    else if (effect.parent instanceof Actor)
      actorEffectsToDelete.push(effect.id);
    else if (effect.parent instanceof Item) // this should be enchantments
      effectsToDelete.push(effect);
  }
  if (actorEffectsToDelete.length > 0) await actor.deleteEmbeddedDocuments("ActiveEffect", actorEffectsToDelete, options);
  if (effectsToDisable.length > 0) {
    for (let effect of effectsToDisable) {
      await effect.update({ "disabled": true }, options)
    }
  }
  if (effectsToDelete.length > 0) {
    for (let effect of effectsToDelete)
      await effect.delete(options);
  }
  return { deleted: actorEffectsToDelete, disabled: effectsToDisable, itemEffects: effectsToDelete };
}

export function blankOrUndefinedDamageType(s: string | undefined): string {
  if (!s) return "none";
  if (s === "") return "none";
  return s;
}

export function processConcentrationSave(message, html, data) {
  if (configSettings.doConcentrationCheck !== "chat") return;
  let elt = html.find("[data-action=concentration]");
  const hasRolled = foundry.utils.getProperty(message, `flags.${MODULE_ID}.concentrationRolled`);
  //@ts-expect-error
  if (hasRolled || !game.users?.activeGM.isSelf) return;
  if (elt.length === 1 && !hasRolled) {
    let { action, dc, type } = elt[0].dataset;
    let token, actor;
    if (action === "concentration" && type === "midi-concentration") {
      dc = Number(dc);
      let { actor, alias, scene, token } = message.speaker;
      if (scene && token) token = game.scenes?.get(scene)?.tokens.get(token);
      if (token) actor = token.actor;
      else actor = game.actors?.get(actor);
      if (actor) {
        const user = playerForActor(actor);
        if (user?.active) {
          const whisper = game.users.filter(user => actor.testUserPermission(user, "OWNER"))
          socketlibSocket.executeAsUser("rollConcentration", user.id, { actorUuid: actor.uuid, targetValue: dc, whisper });
        } else actor.rollConcentration({ targetValue: dc });
        message.setFlag(MODULE_ID, "concentrationRolled", true);
      }
    }
  }
}

export function setRollOperatorEvaluated(roll) {
  if (!roll._evaluated) return roll;
  roll.terms.forEach(t => {
    if (!t._evaluated) t.evaluate();
  })
}
export function doSyncRoll(roll, source: string | undefined) {

  if (!roll.isDeterministic) {
    console.error(`%c doSyncRoll | dice expressions not supported in v12 [${roll._formula}] and will be ignored ${source}`, "color:red;");
    //@ts-expect-error
    return new Roll("0").evaluateSync();
  } else
    return roll.evaluateSync()
}

export function setRollMinDiceTerm(roll: Roll, minValue: number) {
  roll.dice.forEach(d => {
    d.results.forEach(r => {
      if (r.result < minValue) r.result = minValue;
    });
  });
  //@ts-expect-error
  roll._total = roll._evaluateTotal();
  return roll;
}

export function setRollMaxDiceTerm(roll: Roll, maxValue: number) {
  roll.dice.forEach(d => {
    d.results.forEach(r => {
      if (r.result > maxValue) r.result = maxValue;
    });
  });
  //@ts-expect-error
  roll._total = roll._evaluateTotal();
  return roll;
}

export function addDependent (document: Document, dependent: Document) {
  //@ts-expect-error
  if (!document.addDependent) {
    //@ts-expect-error
    console.error(`midi-qol | addDependent | document ${document.uuid} does not have addDependent defined`);
    return;
  }
  //@ts-expect-error
  if (game.user?.isGM || document.isOwner) {
    //@ts-expect-error
    document.addDependent(dependent);
  } else {
    //@ts-expect-error
    return socketlibSocket.executeAsGM("addDependent", { documentUuid: document.uuid, dependentUuid: dependent.uuid });
  }
}

export async function addConcentrationDependent(actorRef: Token | TokenDocument | Actor | string, dependent: any, item?: Item) {
  if (dependent instanceof Token) dependent = dependent.document;
  if (!dependent.uuid) {
    console.warn(`midi-qol | addConcentrationDependent | dependent ${dependent?.name} must have a uuid`);
    return undefined;
  }
  const actor = getActor(actorRef);
  if (!actor) {
    console.warn(`midi-qol | addConcentrationDependent | actor not found for ${actorRef}`);
    return undefined;
  }

  if (!item) {
    log("addConcentrationDependent | item not supplied - using any concentration effect");
  }
  const concentrationEffect = getConcentrationEffect(actor, item);
  if (!concentrationEffect) {
    console.warn(`midi-qol | addConcentrationDependent | dnd5e concentration effect not found for ${actor.name} ${item?.name ?? "no item"}`);
    return undefined;
  }
  if (game.user?.isGM || actor.isOwner) {
    //@ts-expect-error
    return concentrationEffect.addDependent(dependent);
  } else
    return socketlibSocket.executeAsGM("addDependent", { documentUuid: concentrationEffect.uuid, dependentUuid: dependent.uuid });
}

export function getAppliedEffects(actor, { includeEnchantments }) {
  if (!actor) return [];
  let effects = actor.appliedEffects;
  if (includeEnchantments) {
    const enchantments = actor.items.contents.flatMap(i => i.effects.contents).filter(ae => ae.isAppliedEnchantment);
    effects = effects.concat(enchantments);
  }
  return effects;
}

export function getCEEffectByName(name: string): any | undefined {
  if (!installedModules.get("dfreds-convenient-effects")) return undefined;
  //@ts-expect-error
  const dfreds = game.dfreds;
  let effect;
  //@ts-expect-error
  if (installedModules.get("dfreds-convenient-effects") && foundry.utils.isNewerVersion("6.9.9", game.modules.get("dfreds-convenient-effects")?.version)) {
    return dfreds.effects?.all.find(e => e.name === name);
  } else {
    return dfreds.effectInterface.findEffect({ effectName: name })
  }
}
export async function CEAddEffectWith(options: { uuid: string, effectName?: string, effectId?: string, origin?: any, effectData?: any, overlay: boolean }) {
  //@ts-expect-error
  const dfredsInterface = game.dfreds?.effectInterface;
  let { uuid, effectName, origin, effectData, overlay, effectId } = options;
  if (!dfredsInterface || !(effectName || effectId) || !uuid) return undefined;
  //@ts-expect-error
  const dfredsVersion = game.modules.get("dfreds-convenient-effects")?.version;
  if (!uuid || (!effectName && !effectId)) return undefined;
  if (foundry.utils.isNewerVersion("6.9.9", dfredsVersion)) {
    const effect = getCEEffectByName(effectName ?? "")
    if (!effect) return undefined;
    const newEffectData = foundry.utils.mergeObject(effect.toObject(), effectData ?? {}, { inplace: false, insertKeys: true, insertValues: true, overwrite: true });
    return dfredsInterface.addEffectWith({ uuid, effect, origin, effectData: newEffectData, overlay });
  } else {
    if (!effectId) {
      effectId = getCEEffectByName(effectName ?? "")?.id;
    }
    if (!effectId) return undefined;
    return dfredsInterface.addEffect({ uuid, effectId, origin, effectData, overlay });
  }
}

export async function CERemoveEffect(options: { effectName: string, uuid: string, effectId?: string, origin?: string }) {
  //@ts-expect-error
  const dfredsInterface = game.dfreds?.effectInterface;
  if (!dfredsInterface) return undefined;
  const { uuid, effectId, origin, effectName } = options;
  if (!uuid || (!effectName && !effectId)) return undefined;
  return dfredsInterface.removeEffect({ uuid, effectName, effectId, origin });
}

export async function CEToggleEffect(options: { effectName?: string, uuid: string, effectId?: string, origin?: string, overlay?: boolean }) {
  //@ts-expect-error
  const dfredsInterface = game.dfreds?.effectInterface;
  if (!dfredsInterface) return undefined;
  const { uuid, effectId, origin, effectName, overlay } = options;
  //@ts-expect-error
  const dfredsVersion = game.modules.get("dfreds-convenient-effects")?.version;
  if (foundry.utils.isNewerVersion("6.9.9", dfredsVersion)) {
    return dfredsInterface.toggleEffect(effectName, { uuid, origin, overlay });
  } else {
    return dfredsInterface.toggleEffect({ uuids: [uuid], effectName, effectId, origin, overlay });
  }
}

export function CEHasEffectApplied(options: { effectName: string, uuid: string, effectId?: string, origin?: string }): boolean {
  if (!installedModules.get("dfreds-convenient-effects")) return false;
  //@ts-expect-error
  const dfredsInterface = game.dfreds?.effectInterface;
  if (!dfredsInterface) return false;
  const { uuid, effectId, origin, effectName } = options;
  if (!uuid || (!effectName && !effectId)) return false;
  //@ts-expect-error
  if (foundry.utils.isNewerVersion("6.9.9", game.modules.get("dfreds-convenient-effects")?.version)) {
    return dfredsInterface.hasEffectApplied(effectName, uuid);
  } else {
    return dfredsInterface.hasEffectApplied({ uuid, effectName, effectId, origin });
  }
}

export function isConvenientEffect(effect): boolean {
  //@ts-expect-error
  if (foundry.utils.isNewerVersion("6.9.9", game.modules.get("dfreds-convenient-effects")?.version)) {
    return !!effect?.id.startsWith("Convenient Effect:")
  } else {
    return !!(effect?.flags?.["dfreds-convenient-effects"]?.isConvenient);
  }
}

export function getActivityDefaultDamageType(activity): string {
  let defaultDamageType: string = activity?.damage?.parts[0]?.types.first();
  if (defaultDamageType) return defaultDamageType;
  if (activity.workflow) defaultDamageType = activity.workflow.defaultDamageType;
  if (!defaultDamageType) defaultDamageType = MQdefaultDamageType;
  return defaultDamageType
}

export function getDefaultDamageType(item) {
  let defaultDamageType;
  if (isdndv4) {
    const activity = item.system.activities.get("dnd5eactivity000");
    defaultDamageType = activity?.damage?.parts[0]?.types.first() ?? MQdefaultDamageType;
  }
  else
    defaultDamageType = item?.system.damage;
  return defaultDamageType
}

export function activityHasAreaTarget(activity): boolean {
  return activity.target?.template.type in GameSystemConfig.areaTargetTypes
}

export function getSaveRollModeFor(abilityId) {
  if (configSettings.rollChecksBlind.includes("all") || configSettings.rollChecksBlind.includes(abilityId))
    return "blindroll";
  return configSettings.autoCheckSaves !== "allShow" ? "gmroll" : "public";
}

export function getCheckRollModeFor(abilityId) {
  if (configSettings.rollSavesBlind.includes("all") || configSettings.rollSavesBlind.includes(abilityId))
    return "blindroll";
  return configSettings.autoCheckSaves !== "allShow" ? "gmroll" : "public";
}
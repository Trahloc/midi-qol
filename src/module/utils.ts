import { debug, i18n, error, warn, noDamageSaves, cleanSpellName, MQdefaultDamageType, allAttackTypes, gameStats, debugEnabled, overTimeEffectsToDelete, geti18nOptions, failedSaveOverTimeEffectsToDelete } from "../midi-qol.js";
import { configSettings, autoRemoveTargets, checkRule, targetConfirmation, criticalDamage, criticalDamageGM, checkMechanic, safeGetGameSetting } from "./settings.js";
import { log } from "../midi-qol.js";
import { DummyWorkflow, Workflow } from "./workflow.js";
import { socketlibSocket, timedAwaitExecuteAsGM, untimedExecuteAsGM } from "./GMAction.js";
import { dice3dEnabled, installedModules } from "./setupModules.js";
import { concentrationCheckItemDisplayName, itemJSONData, midiFlagTypes, overTimeJSONData } from "./Hooks.js";

import { OnUseMacros } from "./apps/Item.js";
import { Options } from "./patching.js";
import { TroubleShooter } from "./apps/TroubleShooter.js";
import { busyWait } from "./tests/setupTest.js";

const defaultTimeout = 30;
export type ReactionItemReference = { itemName: string, itemId: string, actionName: string, img: string, id: string, uuid: string } | String;
export type ReactionItem = { itemName: string, itemId: string, actionName: string, img: string, id: string, uuid: string, baseItem: Item } | Item;



export function getDamageType(flavorString): string | undefined {
  const validDamageTypes = Object.entries(getSystemCONFIG().damageTypes).deepFlatten().concat(Object.entries(getSystemCONFIG().healingTypes).deepFlatten())
  const allDamageTypeEntries = Object.entries(getSystemCONFIG().damageTypes).concat(Object.entries(getSystemCONFIG().healingTypes));
  if (validDamageTypes.includes(flavorString)) {
    const damageEntry: any = allDamageTypeEntries?.find(e => e[1] === flavorString);
    return damageEntry ? damageEntry[0] : flavorString
  }
  return undefined;
}

export function getDamageFlavor(damageType): string | undefined {
  const validDamageTypes = Object.entries(getSystemCONFIG().damageTypes).deepFlatten().concat(Object.entries(getSystemCONFIG().healingTypes).deepFlatten())
  const allDamageTypeEntries = Object.entries(getSystemCONFIG().damageTypes).concat(Object.entries(getSystemCONFIG().healingTypes));
  if (validDamageTypes.includes(damageType)) {
    const damageEntry: any = allDamageTypeEntries?.find(e => e[0] === damageType);
    return damageEntry ? damageEntry[1] : damageType
  }
  return undefined;
}

/**
 *  return a list of {damage: number, type: string} for the roll and the item
 */
export function createDamageDetail({ roll, item, versatile, defaultType = MQdefaultDamageType, ammo }): { damage: unknown; type: string; }[] {
  let damageParts = {};
  const rollTerms = roll?.terms ?? [];
  //@ts-expect-error .version
  const systemVersion = game.system.version;
  let evalString = "";
  let parts = duplicate(item?.system.damage.parts ?? []);
  if (versatile && item?.system.damage.versatile) {
    if (isNewerVersion(systemVersion, "2.4.99")) {
      parts[0].formula = item.system.damage.versatile;
    } else
      parts[0][0] = item.system.damage.versatile;
  }
  if (ammo) parts = parts.concat(ammo.system.damage.parts)

  // create data for a synthetic roll
  let rollData = item ? item.getRollData() : {};
  rollData.mod = 0;
  if (debugEnabled > 1) debug("CrreateDamageDetail: Passed roll is ", roll)
  if (debugEnabled > 1) debug("CrreateDamageDetail: Damage spec is ", parts)
  let partPos = 0;
  const validDamageTypes = Object.entries(getSystemCONFIG().damageTypes).deepFlatten().concat(Object.entries(getSystemCONFIG().healingTypes).deepFlatten())
  const allDamageTypeEntries = Object.entries(getSystemCONFIG().damageTypes).concat(Object.entries(getSystemCONFIG().healingTypes));

  // If we have an item we can use it to work out each of the damage lines that are being rolled
  for (let part of parts) { // each spec,type is one of the damage lines
    let spec, type;
    if (isNewerVersion(systemVersion, "2.4.99")) {
      let { damageType, formula } = part;
      spec = formula;
      type = damageType;
    } else {
      [spec, type] = part;
    }
    if (partPos >= rollTerms.length) continue;
    // TODO look at replacing this with a map/reduce
    if (debugEnabled > 1) debug("CrreateDamageDetail: single Spec is ", spec, type, item)
    let formula = Roll.replaceFormulaData(spec, rollData, { missing: "0", warn: false });
    // However will be a problem longer term when async not supported?? What to do
    let dmgSpec: Roll | undefined;
    try {
      // TODO Check if we actually have to to do the roll - intermeidate terms and simplifying the roll are the two bits to think about
      dmgSpec = new Roll(formula, rollData).evaluate({ async: false });
    } catch (err) {
      const message = `midi-qol | CrreateDamageDetail | DmgSpec not valid ${formula}`;
      TroubleShooter.recordError(err, message);
      error(message, err)
      dmgSpec = undefined;
      break;
    }
    if (!dmgSpec || dmgSpec.terms?.length < 1) break;
    // dmgSpec is now a roll with the right terms (but nonsense value) to pick off the right terms from the passed roll
    // Because damage spec is rolled it drops the leading operator terms, so do that as well
    for (let i = 0; i < dmgSpec.terms.length; i++) { // grab all the terms for the current damage line
      // rolls can have extra operator terms if mods are negative so test is
      // if the current roll term is an operator but the next damage spec term is not 
      // add the operator term to the eval string and advance the roll term counter
      // eventually rollTerms[partPos] will become undefined so it can't run forever
      while (rollTerms[partPos] instanceof CONFIG.Dice.termTypes.OperatorTerm &&
        !(dmgSpec.terms[i] instanceof CONFIG.Dice.termTypes.OperatorTerm)) {
        evalString += rollTerms[partPos].operator + " ";
        partPos += 1;
      }
      if (rollTerms[partPos]) {
        const hasDivideMultiply = rollTerms[partPos + 1] instanceof OperatorTerm && ["/", "*"].includes(rollTerms[partPos + 1].operator);
        if (rollTerms[partPos] instanceof OperatorTerm) {
          evalString += rollTerms[partPos].operator + " ";
        }

        if (rollTerms[partPos] instanceof DiceTerm || rollTerms[partPos] instanceof NumericTerm) {
          const flavorDamageType = getDamageType(rollTerms[partPos]?.options?.flavor);
          type = flavorDamageType ?? type;
          if (!rollTerms[partPos]?.options.flavor) {
            setProperty(rollTerms[partPos].options, "flavor", getDamageFlavor(type));
          }

          evalString += rollTerms[partPos]?.total;
          if (!hasDivideMultiply) {
            // let result = Roll.safeEval(evalString);
            let result = new Roll(evalString).evaluate({ async: false }).total;
            damageParts[type || defaultType] = (damageParts[type || defaultType] || 0) + result;
            evalString = "";
          }
        }
        if (rollTerms[partPos] instanceof PoolTerm) {
          const flavorDamageType = getDamageType(rollTerms[partPos]?.options?.flavor);
          type = flavorDamageType ?? type;
          if (!rollTerms[partPos]?.options.flavor) {
            setProperty(rollTerms[partPos].options, "flavor", getDamageFlavor(type));
          }
          evalString += rollTerms[partPos]?.total;
        }
      }
      partPos += 1;
    }
    // Each damage line is added together and we can skip the operator term
    partPos += 1;
    if (evalString !== "") {
      // let result = Roll.safeEval(evalString);
      let result = new Roll(evalString).evaluate({ async: false }).total;
      damageParts[type || defaultType] = (damageParts[type || defaultType] || 0) + result;
      evalString = "";
    }
  }
  // We now have all of the item's damage lines (or none if no item)
  // Now just add up the other terms - using any flavor types for the rolls we get
  // we stepped one term too far so step back one
  partPos = Math.max(0, partPos - 1);

  // process the rest of the roll as a sequence of terms.
  // Each might have a damage flavour so we do them expression by expression

  evalString = "";
  let damageType: string | undefined = defaultType;
  let numberTermFound = false; // We won't evaluate until at least 1 numeric term is found
  while (partPos < rollTerms.length) {
    // Accumulate the text for each of the terms until we have enough to eval
    const evalTerm = rollTerms[partPos];
    partPos += 1;
    if (evalTerm instanceof DiceTerm) {
      // this is a dice roll
      damageType = getDamageType(evalTerm.options?.flavor) ?? damageType;
      if (!evalTerm?.options.flavor) {
        setProperty(evalTerm, "options.flavor", getDamageFlavor(damageType));
      }
      numberTermFound = true;
      evalString += evalTerm.total;
    } else if (evalTerm instanceof Die) { // special case for better rolls that does not return a proper roll
      damageType = getDamageType(evalTerm.options?.flavor) ?? damageType;
      if (!evalTerm?.options.flavor) {
        setProperty(evalTerm, "options.flavor", getDamageFlavor(damageType));
      }
      numberTermFound = true;
      evalString += evalTerm.total;
    } else if (evalTerm instanceof NumericTerm) {
      damageType = getDamageType(evalTerm.options?.flavor) ?? damageType;
      if (!evalTerm?.options.flavor) {
        setProperty(evalTerm, "options.flavor", getDamageFlavor(damageType));
      }
      numberTermFound = true;
      evalString += evalTerm.total;
    }
    if (evalTerm instanceof PoolTerm) {
      damageType = getDamageType(evalTerm?.options?.flavor) ?? damageType;
      if (!evalTerm?.options.flavor) {
        setProperty(evalTerm, "options.flavor", getDamageFlavor(damageType));
      }
      evalString += evalTerm.total;
    }
    if (evalTerm instanceof OperatorTerm) {
      if (["*", "/"].includes(evalTerm.operator)) {
        // multiply or divide keep going
        evalString += evalTerm.total
      } else if (["-", "+"].includes(evalTerm.operator)) {
        if (numberTermFound) { // we have a number and a +/- so we can eval the term (do it straight away so we get the right damage type)
          let result = Roll.safeEval(evalString);
          damageParts[damageType || defaultType] = (damageParts[damageType || defaultType] || 0) + result;
          // reset for the next term - we don't know how many there will be
          evalString = "";
          damageType = defaultType;
          numberTermFound = false;
          evalString = evalTerm.operator;
        } else { // what to do with parenthetical term or others?
          evalString += evalTerm.total;
        }
      }
    }
  }
  // evalString contains the terms we have not yet evaluated so do them now

  if (evalString) {
    const damage = Roll.safeEval(evalString);
    // we can always add since the +/- will be recorded in the evalString
    damageParts[damageType || defaultType] = (damageParts[damageType || defaultType] || 0) + damage;
  }
  const damageDetail = Object.entries(damageParts).map(([type, damage]) => { return { damage, type } });
  if (debugEnabled > 1) debug("CreateDamageDetail: Final damage detail is ", damageDetail);
  return damageDetail;
}

export function getSelfTarget(actor): Token {
  if (actor.token) return actor.token.object; //actor.token is a token document.
  const token = tokenForActor(actor);
  if (token) return token;
  const tokenData = actor.prototypeToken.toObject();
  tokenData.actorId = actor.id;
  const cls = getDocumentClass("Token");
  //@ts-expect-error
  return new cls(tokenData, { actor });
}

export function getSelfTargetSet(actor): Set<Token> {
  const selfTarget = getSelfTarget(actor);
  if (selfTarget) return new Set([selfTarget]);
  return new Set();
}

// Calculate the hp/tempHP lost for an amount of damage of type
export function calculateDamage(a: Actor, appliedDamage, t: Token, totalDamage, dmgType, existingDamage) {
  if (debugEnabled > 1) debug("calculate damage ", a, appliedDamage, t, totalDamage, dmgType)
  let prevDamage = existingDamage?.find(ed => ed.tokenId === t.id);
  //@ts-expect-error attributes
  var hp = a.system.attributes.hp;
  var oldHP, tmp, oldVitality, newVitality;
  const vitalityResource = checkRule("vitalityResource");
  if (hp.value <= 0 && typeof vitalityResource === "string" && getProperty(a, vitalityResource) !== undefined) {
    // Damage done to vitality rather than hp
    oldVitality = getProperty(a, vitalityResource) ?? 0;
    newVitality = Math.max(0, oldVitality - appliedDamage);
  }
  if (prevDamage) {
    oldHP = prevDamage.newHP;
    tmp = prevDamage.newTempHP;
  } else {
    oldHP = hp.value;
    tmp = parseInt(hp.temp) || 0;
  }
  let value = Math.floor(appliedDamage);
  if (dmgType.includes("temphp")) { // only relevent for healing of tmp HP
    var newTemp = Math.max(tmp, -value, 0);
    var newHP: number = oldHP;
  } else {
    var dt = value > 0 ? Math.min(tmp, value) : 0;
    var newTemp = tmp - dt;
    var newHP: number = Math.clamped(oldHP - (value - dt), 0, hp.max + (parseInt(hp.tempmax) || 0));
  }
  //TODO review this awfulness
  // Stumble around trying to find the actual token that corresponds to the multi level token TODO make this sane
  //@ts-expect-error .flags v10  
  const altSceneId = getProperty(t.flags, "multilevel-tokens.sscene");
  let sceneId = altSceneId ?? t.scene?.id;
  //@ts-expect-error .flags v10
  const altTokenId = getProperty(t.flags, "multilevel-tokens.stoken");
  let tokenId = altTokenId ?? t.id;
  const altTokenUuid = (altTokenId && altSceneId) ? `Scene.${altSceneId}.Token.${altTokenId}` : undefined;
  let tokenUuid = altTokenUuid; // TODO this is nasty fix it.
  if (!tokenUuid && t.document) tokenUuid = t.document.uuid;

  if (debugEnabled > 1) debug("calculateDamage: results are ", newTemp, newHP, appliedDamage, totalDamage)
  if (game.user?.isGM)
    log(`${a.name} ${oldHP} takes ${value} reduced from ${totalDamage} Temp HP ${newTemp} HP ${newHP} `);
  // TODO change tokenId, actorId to tokenUuid and actor.uuid
  return {
    tokenId, tokenUuid, actorId: a.id, actorUuid: a.uuid, tempDamage: tmp - newTemp, hpDamage: oldHP - newHP, oldTempHP: tmp, newTempHP: newTemp,
    oldHP: oldHP, newHP: newHP, totalDamage: totalDamage, appliedDamage: value, sceneId, oldVitality, newVitality
  };
}

/** 
 * Work out the appropriate multiplier for DamageTypeString on actor
 * If configSettings.damageImmunities are not being checked always return 1
 * 
 */

export let getTraitMult = (actor, dmgTypeString, item): number => {
  dmgTypeString = dmgTypeString.toLowerCase();
  let totalMult = 1;
  if (dmgTypeString.includes("healing") || dmgTypeString.includes("temphp")) totalMult = -1;
  if (dmgTypeString.includes("midi-none")) return 0;
  if (configSettings.damageImmunities === "none") return totalMult;
  const phsyicalDamageTypes = Object.keys(getSystemCONFIG().physicalDamageTypes);

  if (dmgTypeString !== "") {
    // if not checking all damage counts as magical
    let magicalDamage = item?.system.properties?.mgc || item?.flags?.midiProperties?.magicdam;
    magicalDamage = magicalDamage || (configSettings.requireMagical === "off" && item?.system.attackBonus > 0);
    magicalDamage = magicalDamage || (configSettings.requireMagical === "off" && item?.type !== "weapon");
    magicalDamage = magicalDamage || (configSettings.requireMagical === "nonspell" && item?.type === "spell");
    const silverDamage = item?.system.properties?.sil || magicalDamage;
    const adamantineDamage = item?.system.properties?.ada;
    const physicalDamage = phsyicalDamageTypes.includes(dmgTypeString);

    let traitList = [
      { type: "di", mult: configSettings.damageImmunityMultiplier },
      { type: "dr", mult: configSettings.damageResistanceMultiplier },
      { type: "dv", mult: configSettings.damageVulnerabilityMultiplier }];
    // for sw5e use sdi/sdr/sdv instead of di/dr/dv
    if (game.system.id === "sw5e" && actor.type === "starship" && actor.system.attributes.hp.tenp > 0) {
      traitList = [{ type: "sdi", mult: 0 }, { type: "sdr", mult: configSettings.damageResistanceMultiplier }, { type: "sdv", mult: configSettings.damageVulnerabilityMultiplier }];
    }
    for (let { type, mult } of traitList) {
      let trait = deepClone(actor.system.traits[type].value);
      let customs: string[] = [];
      if (actor.system.traits[type].custom?.length > 0) {
        customs = actor.system.traits[type].custom.split(";").map(s => s.trim())
      }
      // process new bypasses settings
      //@ts-expect-error
      if (isNewerVersion(game.system.version, "2.0.3")) {
        const bypasses = actor.system.traits[type].bypasses ?? new Set();
        if (magicalDamage && physicalDamage && bypasses.has("mgc")) continue; // magical damage bypass of trait.
        if (adamantineDamage && physicalDamage && bypasses.has("ada")) continue;
        if (silverDamage && physicalDamage && bypasses.has("sil")) continue;
        // process new custom field versions
        if (!["healing", "temphp"].includes(dmgTypeString)) {
          if (customs.includes(dmgTypeString) || trait.has(dmgTypeString)) {
            totalMult = totalMult * mult;
            continue;
          }
          if (!magicalDamage && (trait.has("nonmagic") || customs.includes(getSystemCONFIG().damageResistanceTypes["nonmagic"]))) {
            totalMult = totalMult * mult;
            continue;
          } else if (!magicalDamage && physicalDamage && (trait.has("physical") || customs.includes(getSystemCONFIG().customDamageResistanceTypes?.physical))) {
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
            if (!magicalDamage && (customs.includes("nonmagic") || customs.includes(getSystemCONFIG().customDamageResistanceTypes?.nonmagic))) {
              totalMult = totalMult * mult;
              continue;
            } else if (!magicalDamage && physicalDamage && (customs.includes("physical") || customs.includes(getSystemCONFIG().customDamageResistanceTypes?.physical))) {
              totalMult = totalMult * mult;
              continue;
            } else if (magicalDamage && (customs.includes("magic") || customs.includes(getSystemCONFIG().customDamageResistanceTypes.magic))) {
              totalMult = totalMult * mult;
              continue;
            } else if (item?.type === "spell" && (customs.includes("spell") || customs.includes(getSystemCONFIG().customDamageResistanceTypes.spell))) {
              totalMult = totalMult * mult;
              continue;
            } else if (item?.type === "power" && (customs.includes("power") || customs.includes(getSystemCONFIG().customDamageResistanceTypes.power))) {
              totalMult = totalMult * mult;
              continue;
            }
          }
        }

        // Support old style leftover settings
        if (configSettings.damageImmunities === "immunityPhysical") {
          if (!magicalDamage && trait.has("physical"))
            phsyicalDamageTypes.forEach(dt => trait.add(dt))
          if (!(magicalDamage || silverDamage) && trait.has("silver"))
            phsyicalDamageTypes.forEach(dt => trait.add(dt))
          if (!(magicalDamage || adamantineDamage) && trait.has("adamant"))
            phsyicalDamageTypes.forEach(dt => trait.add(dt))
        }

        if (trait.has(dmgTypeString))
          totalMult = totalMult * mult;
      } else {
        const bypasses = actor.system.traits[type].bypasses ?? [];
        if (magicalDamage && physicalDamage && bypasses.includes("mgc")) continue; // magical damage bypass of trait.
        if (adamantineDamage && physicalDamage && bypasses.includes("ada")) continue;
        if (silverDamage && physicalDamage && bypasses.includes("sil")) continue;
        // process new custom field versions
        if (!["healing", "temphp"].includes(dmgTypeString)) {
          if (customs.includes(dmgTypeString)) {
            totalMult = totalMult * mult;
            continue;
          }
          if (!magicalDamage && (trait.includes("nonmagic") || customs.includes(getSystemCONFIG().damageResistanceTypes["nonmagic"]))) {
            totalMult = totalMult * mult;
            continue;
          } else if (magicalDamage && trait.includes("magic")) {
            totalMult = totalMult * mult;
            continue;
          }
          else if (item?.type === "spell" && trait.includes("spell")) {
            totalMult = totalMult * mult;
            continue;
          } else if (item?.type === "power" && trait.includes("power")) {
            totalMult = totalMult * mult;
            continue;
          }
          if (customs.length > 0) {
            if (!magicalDamage && (customs.includes("nonmagic") || customs.includes(getSystemCONFIG().damageResistanceTypes["nonmagic"]))) {
              totalMult = totalMult * mult;
              continue;
            } else if (magicalDamage && (customs.includes("magic") || customs.includes(getSystemCONFIG().damageResistanceTypes["magic"]))) {
              totalMult = totalMult * mult;
              continue;
            } else if (item?.type === "spell" && (customs.includes("spell") || customs.includes(getSystemCONFIG().damageResistanceTypes["spell"]))) {
              totalMult = totalMult * mult;
              continue;
            } else if (item?.type === "power" && (customs.includes("power") || customs.includes(getSystemCONFIG().damageResistanceTypes["power"]))) {
              totalMult = totalMult * mult;
              continue;
            }
          }
        }

        // Support old style leftover settings
        if (configSettings.damageImmunities === "immunityPhysical") {
          if (!magicalDamage && trait.includes("physical"))
            trait = trait.concat(phsyicalDamageTypes)
          if (!(magicalDamage || silverDamage) && trait.includes("silver"))
            trait = trait.concat(phsyicalDamageTypes)
          if (!(magicalDamage || adamantineDamage) && trait.includes("adamant"))
            trait = trait.concat(phsyicalDamageTypes)
        }

        if (trait.includes(dmgTypeString))
          totalMult = totalMult * mult;
      }
    }
  }
  return totalMult;
  // Check the custom immunities
}

export async function applyTokenDamage(damageDetail, totalDamage, theTargets, item, saves,
  options: any = { existingDamage: [], superSavers: new Set(), semiSuperSavers: new Set(), workflow: undefined, updateContext: undefined, forceApply: false, noConcentrationCheck: false }): Promise<any[]> {
  const fixedTargets: Set<Token> = theTargets.map(t => getToken(t));

  return legacyApplyTokenDamageMany([damageDetail], [totalDamage], fixedTargets, item, [saves], {
    hitTargets: options.hitTargets ?? fixedTargets,
    existingDamage: options.existingDamage,
    superSavers: options.superSavers ? [options.superSavers] : [],
    semiSuperSavers: options.semiSuperSavers ? [options.semiSuperSavers] : [],
    workflow: options.workflow,
    updateContext: options.updateContext,
    forceApply: options.forceApply ?? true,
    noConcentrationCheck: options.noConcentrationCheck
  });
}

export interface applyDamageDetails {
  label: string;
  damageDetail: any[];
  damageTotal: number;
  saves?: Set<Token | TokenDocument>;
  superSavers?: Set<Token | TokenDocument>;
  semiSuperSavers?: Set<Token | TokenDocument>;
}

export async function applyTokenDamageMany({ applyDamageDetails, theTargets, item,
  options = { hitTargets: new Set(), existingDamage: [], workflow: undefined, updateContext: undefined, forceApply: false, noConcentrationCheck: false } }:
  { applyDamageDetails: applyDamageDetails[]; theTargets: Set<Token | TokenDocument>; item: any; options?: { hitTargets: Set<Token | TokenDocument>, existingDamage: any[][]; workflow: Workflow | undefined; updateContext: any | undefined; forceApply: boolean, noConcentrationCheck: boolean }; }): Promise<any[]> {
  let damageList: any[] = [];
  let targetNames: string[] = [];
  let appliedDamage;
  let workflow: any = options.workflow ?? {};
  if (debugEnabled > 0) warn("applyTokenDamage |", applyDamageDetails, theTargets, item, workflow)
  if (!theTargets || theTargets.size === 0) {
    // TODO NW workflow.currentAction = workflow.WorkflowState_RollFinished
    // probably called from refresh - don't do anything
    return [];
  }
  if (!(item instanceof CONFIG.Item.documentClass)) {
    if (workflow.item) item = workflow.item;
    else if (item?.uuid) {
      item = MQfromUuid(item.uuid);
    } else if (item) {
      error("ApplyTokenDamage passed item must be of type Item or null/undefined");
      return [];
    }
  }
  if (item && !options.workflow) workflow = Workflow.getWorkflow(item.uuid) ?? {};
  const damageDetailArr = applyDamageDetails.map(a => a.damageDetail);
  const highestOnlyDR = false;
  let totalDamage = applyDamageDetails.reduce((a, b) => a + (b.damageTotal ?? 0), 0);

  let totalAppliedDamage = 0;
  let appliedTempHP = 0;
  for (let t of theTargets) {
    const targetToken: Token | undefined = getToken(t);
    const targetTokenDocument: TokenDocument | undefined = getTokenDocument(t);

    if (!targetTokenDocument || !targetTokenDocument.actor || !targetToken) continue;
    let targetActor: any = targetTokenDocument.actor;

    appliedDamage = 0;
    appliedTempHP = 0;
    let DRAll = 0;
    // damage absorption:
    const absorptions = getProperty(targetActor.flags, "midi-qol.absorption") ?? {};

    const firstDamageHealing = applyDamageDetails[0].damageDetail && ["healing", "temphp"].includes(applyDamageDetails[0].damageDetail[0]?.type);
    const isHealing = ("heal" === workflow.item?.system.actionType) || firstDamageHealing;
    const noDamageReactions = (item?.hasSave && item.flags?.midiProperties?.nodam && workflow?.saves?.has(t));
    const noProvokeReaction = getProperty(workflow.item, "flags.midi-qol.noProvokeReaction");

    if (totalDamage > 0
      //@ts-expect-error isEmpty
      && !isEmpty(workflow)
      && !noDamageReactions
      && !noProvokeReaction
      && options.hitTargets.has(t)
      && [Workflow].includes(workflow.constructor)) {
      // TODO check that the targetToken is actually taking damage
      // Consider checking the save multiplier for the item as a first step
      let result = await doReactions(targetToken, workflow.tokenUuid, workflow.damageRoll, !isHealing ? "reactiondamage" : "reactionheal", { item: workflow.item, workflow, workflowOptions: { damageDetail: workflow.damageDetail, damageTotal: totalDamage, sourceActorUuid: workflow.actor?.uuid, sourceItemUuid: workflow.item?.uuid, sourceAmmoUuid: workflow.ammo?.uuid } });
      if (!Workflow.getWorkflow(workflow.id)) // workflow has been removed - bail out
        return [];
    }
    let uncannyDodge = getProperty(targetActor, "flags.midi-qol.uncanny-dodge") && item?.hasAttack;
    if (uncannyDodge && workflow) uncannyDodge = canSense(targetToken, workflow?.tokenUuid);
    if (game.system.id === "sw5e" && targetActor?.type === "starship") {
      // Starship damage r esistance applies only to attacks
      if (item && ["mwak", "rwak"].includes(item?.system.actionType)) {
        // This should be a roll?
        DRAll = getProperty(t, "actor.system.attributes.equip.armor.dr") ?? 0;
      }
    } else if (getProperty(targetActor, "flags.midi-qol.DR.all") !== undefined)
      DRAll = (new Roll((`${getProperty(targetActor, "flags.midi-qol.DR.all") || "0"}`), targetActor.getRollData())).evaluate({ async: false }).total ?? 0;
    if (item?.hasAttack && getProperty(targetActor, `flags.midi-qol.DR.${item?.system.actionType}`)) {
      DRAll += (new Roll((`${getProperty(targetActor, `flags.midi-qol.DR.${item?.system.actionType}`) || "0"}`), targetActor.getRollData())).evaluate({ async: false }).total ?? 0;
    }
    let DRAllRemaining = DRAll;
    // const magicalDamage = (item?.type !== "weapon" || item?.system.attackBonus > 0 || item?.system.properties["mgc"]);
    let magicalDamage = item?.system.properties?.mgc || item?.flags?.midiProperties?.magicdam;
    magicalDamage = magicalDamage || (configSettings.requireMagical === "off" && item?.system.attackBonus > 0);
    magicalDamage = magicalDamage || (configSettings.requireMagical === "off" && item?.type !== "weapon");
    magicalDamage = magicalDamage || (configSettings.requireMagical === "nonspell" && item?.type === "spell");

    const silverDamage = magicalDamage || (item?.type === "weapon" && item?.system.properties["sil"]);
    const adamantineDamage = item?.system.properties?.ada;

    let AR = 0; // Armor reduction for challenge mode armor etc.
    const ac = targetActor.system.attributes.ac;
    let damageDetail;
    let damageDetailResolved: any[] = [];
    totalDamage = 0;
    for (let i = 0; i < applyDamageDetails.length; i++) {
      if (applyDamageDetails[i].label === "otherDamage" && !workflow.otherDamageMatches?.has(targetToken)) continue; // don't apply other damage is activationFails includes the token
      totalDamage += (applyDamageDetails[i].damageTotal ?? 0);
      damageDetail = duplicate(applyDamageDetails[i].damageDetail ?? []);
      const label = applyDamageDetails[i].label;
      const itemSaveMultiplier = getSaveMultiplierForItem(item, label);
      let attackRoll = workflow.attackTotal;
      let saves = applyDamageDetails[i].saves ?? new Set();
      let superSavers: Set<Token | TokenDocument> = applyDamageDetails[i].superSavers ?? new Set();
      let semiSuperSavers: Set<Token | TokenDocument> = applyDamageDetails[i].semiSuperSavers ?? new Set();
      var dmgType;

      // Apply saves if required

      // This is overall Damage Reduction
      let maxDR = Number.NEGATIVE_INFINITY;
      ;

      if (checkRule("challengeModeArmor") === "scale") {
        AR = workflow.isCritical ? 0 : ac.AR;
      } else if (checkRule("challengeModeArmor") === "challenge" && attackRoll) {
        AR = ac.AR;
      } else AR = 0;
      let maxDRIndex = -1;


      for (let [index, damageDetailItem] of damageDetail.entries()) {
        if (["scale", "scaleNoAR"].includes(checkRule("challengeModeArmor")) && attackRoll && workflow.hitTargetsEC?.has(t)) {
          //scale the damage detail for a glancing blow - only for the first damage list? or all?
          const scale = workflow.challengeModeScale[targetActor?.uuid ?? "dummy"] ?? 1;
          // const scale = getProperty(targetActor, "flags.midi-qol.challengeModeScale") ?? 1;
          damageDetailItem.damage *= scale;
        }
      }
      let nonMagicalDRUsed = false;
      let nonMagicalPysicalDRUsed = false;
      let nonPhysicalDRUsed = false;
      let nonSilverDRUsed = false;
      let nonAdamantineDRUsed = false;
      let physicalDRUsed = false;

      if (configSettings.saveDROrder === "SaveDRdr") {
        for (let [index, damageDetailItem] of damageDetail.entries()) {
          let { damage, type, DR } = damageDetailItem;
          if (!type) type = MQdefaultDamageType;

          let mult = saves.has(t) ? itemSaveMultiplier : 1;
          if (superSavers.has(t) && itemSaveMultiplier === 0.5) {
            mult = saves.has(t) ? 0 : 0.5;
          }
          if (semiSuperSavers.has(t) && itemSaveMultiplier === 0.5)
            mult = saves.has(t) ? 0 : 1;
          damageDetailItem.damage = damageDetailItem.damage * mult;
        }
      }
      // Calculate the Damage Reductions for each damage type
      for (let [index, damageDetailItem] of damageDetail.entries()) {
        let { damage, type } = damageDetailItem;
        type = type ?? MQdefaultDamageType;
        const physicalDamage = ["bludgeoning", "slashing", "piercing"].includes(type);

        if (absorptions[type] && absorptions[type] !== false) {
          const abMult = Number.isNumeric(absorptions[type]) ? Number(absorptions[type]) : 1;
          damageDetailItem.damage = damageDetailItem.damage * abMult;
          type = "healing";
          damageDetailItem.type = "healing"
        }
        let DRType = 0;
        if (type.toLowerCase() !== "temphp") dmgType = type.toLowerCase();
        // Pick the highest DR applicable to the damage type being inflicted.
        if (getProperty(targetActor, `flags.midi-qol.DR.${type}`)) {
          DRType = (new Roll((`${getProperty(targetActor, `flags.midi-qol.DR.${type}`) || "0"}`), targetActor.getRollData())).evaluate({ async: false }).total ?? 0;
          if (DRType < 0) {
            damageDetailItem.damage -= DRType;
            DRType = 0;
          }
        }
        if (!nonMagicalPysicalDRUsed && physicalDamage && !magicalDamage && getProperty(targetActor, `flags.midi-qol.DR.non-magical-physical`)) {
          const DR = (new Roll((`${getProperty(targetActor, `flags.midi-qol.DR.non-magical-physical`) || "0"}`), targetActor.getRollData())).evaluate({ async: false }).total ?? 0;
          if (DR < 0) {
            damageDetailItem.damage -= DR;
          } else {
            nonMagicalPysicalDRUsed = DR > DRType;
            DRType = Math.max(DRType, DR);
          }
        }
        if (!nonMagicalDRUsed && !magicalDamage && getProperty(targetActor, `flags.midi-qol.DR.non-magical`)) {
          const DR = (new Roll((`${getProperty(targetActor, `flags.midi-qol.DR.non-magical`) || "0"}`), targetActor.getRollData())).evaluate({ async: false }).total ?? 0;
          if (DR < 0) {
            damageDetailItem.damage -= DR;
          } else {
            nonMagicalDRUsed = DR > DRType;
            DRType = Math.max(DRType, DR);
          }
        }
        if (!nonSilverDRUsed && physicalDamage && !silverDamage && getProperty(targetActor, `flags.midi-qol.DR.non-silver`)) {
          const DR = (new Roll((`${getProperty(targetActor, `flags.midi-qol.DR.non-silver`) || "0"}`), targetActor.getRollData())).evaluate({ async: false }).total ?? 0;
          if (DR < 0) {
            damageDetailItem.damage -= DR;
          } else {
            nonSilverDRUsed = DR > DRType;
            DRType = Math.max(DRType, DR);
          }
        }
        if (!nonAdamantineDRUsed && physicalDamage && !adamantineDamage && getProperty(targetActor, `flags.midi-qol.DR.non-adamant`)) {
          const DR = (new Roll((`${getProperty(targetActor, `flags.midi-qol.DR.non-adamant`) || "0"}`), targetActor.getRollData())).evaluate({ async: false }).total ?? 0
          if (DR < 0) {
            damageDetailItem.damage -= DR;
          } else {
            nonAdamantineDRUsed = DR > DRType;
            DRType = Math.max(DRType, DR);
          }
        }
        if (!physicalDRUsed && physicalDamage && getProperty(targetActor, `flags.midi-qol.DR.physical`)) {
          const DR = (new Roll((`${getProperty(targetActor, `flags.midi-qol.DR.physical`) || "0"}`), targetActor.getRollData())).evaluate({ async: false }).total ?? 0;
          if (DR < 0) {
            damageDetailItem.damage -= DR;
          } else {
            physicalDRUsed = DR > DRType;
            DRType = Math.max(DRType, DR);
          }
        }
        if (!nonPhysicalDRUsed && !physicalDamage && getProperty(targetActor, `flags.midi-qol.DR.non-physical`)) {
          const DR = (new Roll((`${getProperty(targetActor, `flags.midi-qol.DR.non-physical`) || "0"}`), targetActor.getRollData())).evaluate({ async: false }).total ?? 0;
          if (DR < 0) {
            damageDetailItem.damage -= DR;
          } else {
            nonPhysicalDRUsed = DR > DRType;
            DRType = Math.max(DRType, DR);
          }
        }
        DRType = Math.min(damage, DRType);
        // We have the DRType for the current damage type
        if (DRType >= maxDR) {
          maxDR = DRType;
          maxDRIndex = index;
        }
        damageDetailItem.DR = DRType;
      }

      if (DRAll > 0 && DRAll < maxDR && checkRule("maxDRValue")) DRAll = 0;
      if (checkRule("DRAllPerDamageDetail")) DRAllRemaining = Math.max(DRAll, 0);
      // Now apportion DRAll to each damage type if required
      for (let [index, damageDetailItem] of damageDetail.entries()) {
        let { damage, type, DR } = damageDetailItem;
        if (checkRule("maxDRValue")) {
          if (index !== maxDRIndex) {
            damageDetailItem.DR = 0;
            DR = 0;
          } else if (DRAll > maxDR) {
            damageDetailItem.DR = 0;
            DR = 0;
          }
        }
        if (DR < damage && DRAllRemaining > 0 && !["healing", "temphp"].includes(damageDetailItem.type)) {
          damageDetailItem.DR = Math.min(damage, DR + DRAllRemaining);
          DRAllRemaining = Math.max(0, DRAllRemaining + DR - damage);
        }
        // Apply AR here
      }

      //Apply saves/dr/di/dv
      for (let [index, damageDetailItem] of damageDetail.entries()) {
        let { damage, type, DR } = damageDetailItem;
        if (!type) type = MQdefaultDamageType;

        let mult = 1;
        if (configSettings.saveDROrder !== "SaveDRdr") {
          mult = saves.has(t) ? itemSaveMultiplier : 1;
          if (superSavers.has(t) && itemSaveMultiplier === 0.5) {
            mult = saves.has(t) ? 0 : 0.5;
          }
          if (semiSuperSavers.has(t) && itemSaveMultiplier === 0.5)
            mult = saves.has(t) ? 0 : 1;
        }
        if (uncannyDodge) mult = mult / 2;
        const resMult = getTraitMult(targetActor, type, item);
        mult = mult * resMult;
        damageDetailItem.damageMultiplier = mult;
        /*
        if (!["healing", "temphp"].includes(type)) damage -= DR; // Damage reduction does not apply to healing
        */
        damage -= DR;
        let typeDamage = Math.floor(damage * Math.abs(mult)) * Math.sign(mult);
        let typeDamageUnRounded = damage * mult;

        if (type.includes("temphp")) {
          appliedTempHP += typeDamage
        } else {
          appliedDamage += typeDamageUnRounded;
        }

        // TODO: consider mwak damage reduction - we have the workflow so should be possible
      }
      damageDetailResolved = damageDetailResolved.concat(damageDetail);
      if (debugEnabled > 0) warn("applyTokenDamageMany | Damage Details plus resistance/save multiplier for ", targetActor.name, duplicate(damageDetail))
    }
    if (DRAll < 0 && appliedDamage > -1) { // negative DR is extra damage
      damageDetailResolved = damageDetailResolved.concat({ damage: -DRAll, type: "DR", DR: 0 });
      appliedDamage -= DRAll;
      totalDamage -= DRAll;
    }
    if (false && !Object.keys(getSystemCONFIG().healingTypes).includes(dmgType)) {
      totalDamage = Math.max(totalDamage, 0);
      appliedDamage = Math.max(appliedDamage, 0);
    }
    if (AR > 0 && appliedDamage > 0 && ["challenge", "scale"].includes(checkRule("challengeModeArmor"))
      && !Object.keys(getSystemCONFIG().healingTypes).includes(dmgType)) {
      totalDamage = appliedDamage;
      if (checkRule("challengeModeArmor") === "scale" || (checkRule("challengeModeArmor") === "challenge" && workflow.hitTargetsEC.has(t))) // TODO: the hitTargetsEC test won't ever fire?
        appliedDamage = Math.max(0, appliedDamage - AR)
    }

    totalAppliedDamage += appliedDamage;
    if (!dmgType) dmgType = "temphp";
    if (!["healing", "temphp"].includes(dmgType) && getProperty(targetActor, `flags.midi-qol.DR.final`)) {
      let DRType = (new Roll((getProperty(targetActor, `flags.midi-qol.DR.final`) || "0"), targetActor.getRollData())).evaluate({ async: false }).total ?? 0;
      appliedDamage = Math.max(0, appliedDamage - DRType)
    }

    // Deal with vehicle damage threshold.
    if (appliedDamage > 0 && appliedDamage < (targetActor.system.attributes.hp.dt ?? 0)) appliedDamage = 0;
    let ditem: any = calculateDamage(targetActor, appliedDamage, targetToken, totalDamage, dmgType, options.existingDamage);
    ditem.tempDamage = ditem.tempDamage + appliedTempHP;
    if (appliedTempHP <= 0) { // temp healing applied to actor does not add only gets the max
      ditem.newTempHP = Math.max(ditem.newTempHP, -appliedTempHP);
    } else {
      ditem.newTempHP = Math.max(0, ditem.newTempHP - appliedTempHP)
    }
    ditem.damageDetail = duplicate([damageDetailResolved]);
    ditem.critical = workflow?.isCritical;
    ditem.wasHit = options.hitTargets.has(t);
    //@ts-expect-error isEmtpy Allow macros to fiddle with the damage
    if (!isEmpty(workflow) && configSettings.allowUseMacro && workflow.item?.flags) {
      workflow.damageItem = ditem;
      await workflow.triggerTargetMacros(["preTargetDamageApplication"], [t]);
      ditem = workflow.damageItem;
    }
    workflow.damageItem = ditem;
    await asyncHooksCallAll(`midi-qol.preTargetDamageApplication`, t, { item, workflow, damageItem: ditem, ditem });
    ditem = workflow.damageItem;

    // delete workflow.damageItem
    damageList.push(ditem);
    targetNames.push(t.name)

    if (ditem.appliedDamage !== 0 && ditem.wasHit) {
      const healedDamaged = ditem.appliedDamage < 0 ? "isHealed" : "isDamaged";
      workflow.ditem = duplicate(ditem);
      await asyncHooksCallAll(`midi-qol.${healedDamaged}`, t, { item, workflow, damageItem: workflow.ditem, ditem: workflow.ditem });
      const actorOnUseMacros = getProperty(t.actor ?? {}, "flags.midi-qol.onUseMacroParts") ?? new OnUseMacros();
      // It seems applyTokenDamageMany without a workflow gets through to here - so a silly guard in place TODO come back and fix this properly
      if (workflow.callMacros) await workflow.callMacros(workflow.item,
        actorOnUseMacros?.getMacros(healedDamaged),
        "TargetOnUse",
        healedDamaged,
        { actor: t.actor, token: t });
      const expiredEffects = t?.actor?.effects.filter(ef => {
        const specialDuration = getProperty(ef, "flags.dae.specialDuration");
        if (!specialDuration) return false;
        return specialDuration.includes(healedDamaged);
      }).map(ef => ef.id)
      if (expiredEffects?.length ?? 0 > 0) {
        await timedAwaitExecuteAsGM("removeEffects", {
          actorUuid: t.actor?.uuid,
          effects: expiredEffects,
          options: { "expiry-reason": `midi-qol:${healedDamaged}` }
        });
      }
    }
  }
  if (theTargets.size > 0) {
    workflow.damageList = damageList;
    //@ts-expect-error isEmpty
    if (!isEmpty(workflow) && configSettings.allowUseMacro && workflow.item?.flags) {
      await workflow.callMacros(workflow.item, workflow.onUseMacros?.getMacros("preDamageApplication"), "OnUse", "preDamageApplication");
      if (workflow.ammo) await workflow.callMacros(workflow.ammo, workflow.ammoOnUseMacros?.getMacros("preDamageApplication"), "OnUse", "preDamageApplication");
    }

    const chatCardUuids = await timedAwaitExecuteAsGM("createReverseDamageCard", {
      autoApplyDamage: configSettings.autoApplyDamage,
      sender: game.user?.name,
      actorId: workflow.actor?.id,
      charName: workflow.actor?.name ?? game?.user?.name,
      damageList: damageList,
      targetNames,
      chatCardId: workflow.itemCardId,
      flagTags: workflow.flagTags,
      updateContext: mergeObject(options?.updateContext ?? {}, { noConcentrationCheck: options?.noConcentrationCheck }),
      forceApply: options.forceApply,
    })
    if (workflow && configSettings.undoWorkflow) {
      // Assumes workflow.undoData.chatCardUuids has been initialised
      if (workflow.undoData) {
        workflow.undoData.chatCardUuids = workflow.undoData.chatCardUuids.concat(chatCardUuids);
        untimedExecuteAsGM("updateUndoChatCardUuids", workflow.undoData);
      }
    }
  }
  if (configSettings.keepRollStats) {
    gameStats.addDamage(totalAppliedDamage, totalDamage, theTargets.size, item)
  }
  return damageList;
};

export async function legacyApplyTokenDamageMany(damageDetailArr, totalDamageArr, theTargets, item, savesArr,
  options: { hitTargets: Set<Token | TokenDocument>, existingDamage: any[][], superSavers: Set<any>[], semiSuperSavers: Set<any>[], workflow: Workflow | undefined, updateContext: any, forceApply: any, noConcentrationCheck: boolean }
    = { hitTargets: new Set(), existingDamage: [], superSavers: [], semiSuperSavers: [], workflow: undefined, updateContext: undefined, forceApply: false, noConcentrationCheck: false }): Promise<any[]> {
  const mappedDamageDetailArray: applyDamageDetails[] = damageDetailArr.map((dd, i) => {
    return {
      label: "test",
      damageDetail: dd,
      damageTotal: totalDamageArr[i],
      saves: savesArr[i],
      superSavers: options.superSavers[i],
      semiSuperSavers: options.semiSuperSavers[i],
    }
  });
  return applyTokenDamageMany({ applyDamageDetails: mappedDamageDetailArray, theTargets, item, options })
}

export async function processDamageRoll(workflow: Workflow, defaultDamageType: string) {
  if (debugEnabled > 0) warn("processDamageRoll |", workflow)
  // proceed if adding chat damage buttons or applying damage for our selves
  let appliedDamage: any[] = [];
  const actor = workflow.actor;
  let item = workflow.saveItem;

  // const re = /.*\((.*)\)/;
  // const defaultDamageType = message.flavor && message.flavor.match(re);

  // Show damage buttons if enabled, but only for the applicable user and the GM

  let hitTargets: Set<Token | TokenDocument> = new Set([...workflow.hitTargets, ...workflow.hitTargetsEC]);
  let theTargets = new Set(workflow.targets);
  if (item?.system.target?.type === "self") theTargets = getSelfTargetSet(actor) || theTargets;
  let effectsToExpire: string[] = [];
  if (hitTargets.size > 0 && item?.hasAttack) effectsToExpire.push("1Hit");
  if (hitTargets.size > 0 && item?.hasDamage) effectsToExpire.push("DamageDealt");
  if (effectsToExpire.length > 0) {
    await expireMyEffects.bind(workflow)(effectsToExpire);
  }

  if (debugEnabled > 0) warn("processDamageRoll | damage details pre merge are ", workflow.damageDetail, workflow.bonusDamageDetail);
  let totalDamage = 0;

  if (workflow.saveItem?.hasSave &&
    (getProperty(workflow.saveItem, "flags.midiProperties.saveDamage") ?? "default") !==
    (getProperty(workflow.saveItem, "flags.midiProperties.bonusSaveDamage") ?? "default")) {
    // need to keep bonus damage and base damage separate
    let merged = (workflow.bonusDamageDetail ?? []).reduce((acc, item) => {
      acc[item.type] = (acc[item.type] ?? 0) + item.damage;
      return acc;
    }, {});
    workflow.bonusDamageDetail = Object.keys(merged).map((key) => { return { damage: Math.max(0, merged[key]), type: key } });

    const baseNoDamage = workflow.damageDetail.length === 0 || (workflow.damageDetail.length === 1 && workflow.damageDetail[0] === "midi-none");
    const bonusNoDamage = workflow.bonusDamageDetail.length === 0 || (workflow.bonusDamageDetail.length === 1 && workflow.bonusDamageDetail[0] === "midi-none");
    const otherNoDamage = workflow.otherDamageDetail.length === 0 || (workflow.otherDamageDetail.length === 1 && workflow.otherDamageDetail[0] === "midi-none");
    if (baseNoDamage && bonusNoDamage && otherNoDamage) return;
    const baseTotalDamage = workflow.damageDetail.reduce((acc, value) => acc + value.damage, 0);
    const bonusTotalDamage = workflow.bonusDamageDetail.reduce((acc, value) => acc + value.damage, 0);
    workflow.bonusDamageTotal = bonusTotalDamage;
  } else { // merge bonus damage and base damage together.
    let merged = workflow.damageDetail.concat(workflow.bonusDamageDetail ?? []).reduce((acc, item) => {
      acc[item.type] = (acc[item.type] ?? 0) + item.damage;
      return acc;
    }, {});
    if ((Object.keys(merged).length === 1 && Object.keys(merged)[0] === "midi-none")
      && (workflow.otherDamageDetail.length === 0
        || (workflow.otherDamageDetail.length === 1 && workflow.otherDamageDetail[0] === "midi-none"))
    ) return;

    //TODO come back and decide if -ve damage per type should be allowed, no in the case of 1d4 -2, yes? in the case of -1d4[fire]
    const newDetail = Object.keys(merged).map((key) => { return { damage: Math.max(0, merged[key]), type: key } });
    totalDamage = newDetail.reduce((acc, value) => acc + value.damage, 0);
    workflow.damageDetail = newDetail;
    workflow.damageTotal = totalDamage;
    workflow.bonusDamageDetail = undefined;
    workflow.bonusDamageTotal = undefined;
  }
  let savesToUse = (workflow.otherDamageFormula ?? "") !== "" ? new Set() : workflow.saves;
  // TODO come back and remove bonusDamage from the args to applyTokenDamageMany
  // Don't check for critical - RAW say these don't get critical damage
  // if (["rwak", "mwak"].includes(item?.system.actionType) && configSettings.rollOtherDamage !== "none") {
  // TODO clean this up - but need to work out what save set to use for base damage
  let baseDamageSaves: Set<Token | TokenDocument> = new Set();
  let bonusDamageSaves: Set<Token | TokenDocument> = new Set();
  // If we are not doing default save damage then pass through the workflow saves
  if ((getProperty(workflow.saveItem, "flags.midiProperties.saveDamage") ?? "default") !== "default")
    baseDamageSaves = workflow.saves;
  // if default save damage then we do full full damage if other damage is being rolled.
  else if ((getProperty(workflow.saveItem, "flags.midiProperties.saveDamage") ?? "default") === "default"
    && itemOtherFormula(workflow.saveItem) === "") baseDamageSaves = workflow.saves ?? new Set();
  if ((getProperty(workflow.saveItem, "flags.midiProperties.bonusSaveDamage") ?? "default") !== "default")
    bonusDamageSaves = workflow.saves;
  // if default save damage then we do full full damage if other damage is being rolled.
  else if ((getProperty(workflow.saveItem, "flags.midiProperties.bonusSaveDamage") ?? "default") === "default"
    && itemOtherFormula(workflow.saveItem) === "") baseDamageSaves = workflow.saves ?? new Set()
  if (workflow.shouldRollOtherDamage) {
    if (workflow.otherDamageRoll && configSettings.singleConcentrationRoll) {
      appliedDamage = await applyTokenDamageMany(
        {
          applyDamageDetails: [
            {
              label: "defaultDamage",
              damageDetail: workflow.damageDetail,
              damageTotal: workflow.damageTotal,
              saves: baseDamageSaves, //((getProperty(workflow.saveItem, "flags.midiProperties.saveDamage") ?? "default") === "default") ? undefined : workflow.saves,
              superSavers: workflow.superSavers,
              semiSuperSavers: workflow.semiSuperSavers
            },
            {
              label: "otherDamage",
              damageDetail: workflow.otherDamageDetail,
              damageTotal: workflow.otherDamageTotal,
              saves: workflow.saves,
              superSavers: workflow.superSavers,
              semiSuperSavers: workflow.semiSuperSavers
            },
            {
              label: "bonusDamage",
              damageDetail: workflow.bonusDamageDetail,
              damageTotal: workflow.bonusDamageTotal,
              saves: bonusDamageSaves,
              superSavers: workflow.superSavers,
              semiSuperSavers: workflow.semiSuperSavers
            }
          ],
          theTargets,
          item,
          options: { hitTargets, existingDamage: [], workflow, updateContext: undefined, forceApply: false, noConcentrationCheck: item?.flags?.midiProperties?.noConcentrationCheck ?? false }
        }
      );
    } else {

      appliedDamage = await applyTokenDamageMany(
        {

          applyDamageDetails: [
            {
              label: "defaultDamage",
              damageDetail: workflow.damageDetail,
              damageTotal: workflow.damageTotal,
              saves: baseDamageSaves, // (getProperty(workflow.item, "flags.midiProperties.saveDamage") ?? "default") === "default" ? undefined : workflow.saves,
              superSavers: workflow.superSavers,
              semiSuperSavers: workflow.semiSuperSavers
            },
            {
              label: "bonusDamage",
              damageDetail: workflow.bonusDamageDetail,
              damageTotal: workflow.bonusDamageTotal,
              saves: bonusDamageSaves,
              superSavers: workflow.superSavers,
              semiSuperSavers: workflow.semiSuperSavers
            },
          ],
          theTargets,
          item,
          options: { hitTargets, existingDamage: [], workflow, updateContext: undefined, forceApply: false, noConcentrationCheck: item?.flags?.midiProperties?.noConcentrationCheck ?? false }
        }
      );
      if (workflow.otherDamageRoll) {
        // assume previous damage applied and then calc extra damage
        appliedDamage = await applyTokenDamageMany(
          {
            applyDamageDetails: [{
              label: "otherDamage",
              damageDetail: workflow.otherDamageDetail,
              damageTotal: workflow.otherDamageTotal,
              saves: workflow.saves,
              superSavers: workflow.superSavers,
              semiSuperSavers: workflow.semiSuperSavers
            }],
            theTargets,
            item,
            options: { hitTargets, existingDamage: [], workflow, updateContext: undefined, forceApply: false, noConcentrationCheck: item?.flags?.midiProperties?.noConcentrationCheck ?? false }
          }
        );
      }
    }
  } else {
    appliedDamage = await applyTokenDamageMany(
      {
        applyDamageDetails: [
          {
            label: "defaultDamage",
            damageDetail: workflow.damageDetail,
            damageTotal: workflow.damageTotal,
            saves: workflow.saves,
            superSavers: workflow.superSavers,
            semiSuperSavers: workflow.semiSuperSavers
          },
          {
            label: "bonusDamage",
            damageDetail: workflow.bonusDamageDetail,
            damageTotal: workflow.bonusDamageTotal,
            saves: bonusDamageSaves,
            superSavers: workflow.superSavers,
            semiSuperSavers: workflow.semiSuperSavers
          },
        ],
        theTargets,
        item,
        options: {
          existingDamage: [],
          hitTargets,
          workflow,
          updateContext: undefined,
          forceApply: false,
          noConcentrationCheck: item?.flags?.midiProperties?.noConcentrationCheck ?? false
        }
      });
  }
  workflow.damageList = appliedDamage;

  if (debugEnabled > 1) debug("process damage roll: ", configSettings.autoApplyDamage, workflow.damageDetail, workflow.damageTotal, theTargets, item, workflow.saves)
}

export let getSaveMultiplierForItem = (item: Item, itemDamageType) => {
  // find a better way for this ? perhaps item property
  if (!item) return 1;

  // Midi default - base/bonus damage full, other damage half.
  if (["defaultDamage", "bonusDamage"].includes(itemDamageType) && itemOtherFormula(item) !== ""
    && ["default", undefined].includes(getProperty(item, "flags.midiProperties.saveDamage"))) {
    return 1;
  }

  //@ts-expect-error
  if (item.actor && item.type === "spell" && item.system.level === 0) { // cantrip
    //@ts-expect-error .flags v10
    const midiFlags = getProperty(item.actor.flags, "midi-qol");
    if (midiFlags?.potentCantrip) return 0.5;
  }
  let itemDamageSave = "fulldam";
  switch (itemDamageType) {
    case "defaultDamage":
      itemDamageSave = getProperty(item, "flags.midiProperties.saveDamage");
      break;
    case "otherDamage":
      itemDamageSave = getProperty(item, "flags.midiProperties.otherSaveDamage");
      break;
    case "bonusDamage":
      itemDamageSave = getProperty(item, "flags.midiProperties.bonusSaveDamage");
      break;
  }

  //@ts-expect-error item.flags v10
  const midiItemProperties: any = item.flags.midiProperties;
  if (midiItemProperties?.nodam || itemDamageSave === "nodam") return 0;
  if (midiItemProperties?.fulldam || itemDamageSave === "fulldam") return 1;
  if (midiItemProperties?.halfdam || itemDamageSave === "halfdam") return 0.5;

  if (!configSettings.checkSaveText)
    return configSettings.defaultSaveMult;
  //@ts-expect-error item.system v10
  let description = TextEditor.decodeHTML((item.system.description?.value || "")).toLocaleLowerCase();

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

export function requestPCSave(ability, rollType, player, actor, { advantage, disadvantage, flavor, dc, requestId, GMprompt, isMagicSave, magicResistance, magicVulnerability, saveItemUuid }) {
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
      let mode = isNewerVersion(game.version ?? game.version, "0.9.236") ? "publicroll" : "roll";
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
        saveItemUuid
      }
      if (debugEnabled > 1) debug("process player save ", socketData)
      game.socket?.emit('module.lmrtfy', socketData);
      //@ts-expect-error - global variable
      LMRTFY.onMessage(socketData);
    } else { // display a chat message to the user telling them to save
      const actorName = actor.name;
      let abilityString = getSystemCONFIG().abilities[ability];
      if (abilityString.label) abilityString = abilityString.label;
      let content = ` ${actorName} ${configSettings.displaySaveDC ? "DC " + dc : ""} ${abilityString} ${i18n("midi-qol.saving-throw")}`;
      if (advantage && !disadvantage) content = content + ` (${i18n("DND5E.Advantage")}) - ${flavor})`;
      else if (!advantage && disadvantage) content = content + ` (${i18n("DND5E.Disadvantage")}) - ${flavor})`;
      else content + ` - ${flavor})`;
      const chatData = {
        content,
        whisper: [player]
      }
      // think about how to do this if (workflow?.flagTags) chatData.flags = mergeObject(chatData.flags ?? "", workflow.flagTags);
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
  //@ts-expect-error
  let mode = isNewerVersion(game.version ?? game.version, "0.9.236") ? "publicroll" : "roll";

  if (checkRule("activeDefenceShowGM"))
    mode = "gmroll"
  else
    mode = "selfroll";

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
    socketlibSocket.executeAsUser("D20Roll", player.id, { targetUuid: actor.uuid, formula, request: message, rollMode: mode, options: rollOptions }).then(result => {
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
  if (!change.key?.startsWith("flags.midi-qol")) return true;
  const deferredEvaluation = [
    "flags.midi-qol.OverTime",
    "flags.midi-qol.optional",
    "flags.midi-qol.advantage",
    "flags.midi-qol.disadvantage",
    "flags.midi-qol.superSaver",
    "flags.midi-qol.semiSuperSaver",
    "flags.midi-qol.grants",
    "flags.midi-qol.fail",
    "flags.midi-qol.max.damage",
    "flags.midi-qol.min.damage",
    "flags.critical",
    "flags.midi-qol.ignoreCover",
    "flags.midi-qol.ignoreWalls"
  ]; // These have trailing data in the change key change.key values and should always just be a string
  if (change.key === `flags.${game.system.id}.DamageBonusMacro`) {
    // DAEdnd5e - daeCustom processes these
  } else if (change.key === "flags.midi-qol.onUseMacroName") {
    const args = change.value.split(",")?.map(arg => arg.trim());
    const currentFlag = getProperty(actor, "flags.midi-qol.onUseMacroName") ?? "";
    if (args[0] === "ItemMacro") { // rewrite the ItemMacro if there is an origin
      if (change.effect?.origin.includes("Item.")) {
        args[0] = `ItemMacro.${change.effect.origin}`;
      }
    }
    const extraFlag = `[${args[1]}]${args[0]}`;
    const macroString = (currentFlag?.length > 0) ? [currentFlag, extraFlag].join(",") : extraFlag;
    setProperty(actor, "flags.midi-qol.onUseMacroName", macroString)
    return true;
  } else if (change.key.startsWith("flags.midi-qol.optional.") && change.value.trim() === "ItemMacro") {
    if (change.effect?.origin.includes("Item.")) {
      const macroString = `ItemMacro.${change.effect.origin}`;
      setProperty(actor, change.key, macroString)
    } else setProperty(actor, change.key, change.value);
    return true;
  } else if (deferredEvaluation.some(k => change.key.startsWith(k))) {
    if (typeof change.value !== "string") setProperty(actor, change.key, change.value);
    else if (["true", "1"].includes(change.value.trim())) setProperty(actor, change.key, true);
    else if (["false", "0"].includes(change.value.trim())) setProperty(actor, change.key, false);
    else setProperty(actor, change.key, change.value);
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
          val = evalCondition(change.value, actor.getRollData())
      }
      if (debugEnabled > 0) warn("midiCustomEffect | setting ", change.key, " to ", val, " from ", change.value, " on ", actor.name);
      setProperty(actor, change.key, val);
    } catch (err) {
      const message = `midi-qol | midiCustomEffect | custom flag eval error ${change.key} ${change.value}`;
      TroubleShooter.recordError(err, message);
      console.warn(message, err);
    }
  } else {
    setProperty(actor, change.key, change.value)
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
  let result = duplicate(value);
  // result = result.replace("@item.level", "@itemLevel") // fix for outdated item.level - this is wrong but will cause problems
  result = result.replace("@flags.midi-qol", "@flags.midiqol");
  // Remove @data references allow a little bit of recursive lookup
  do {
    count += 1;
    for (let match of result.match(re) || []) {
      result = result.replace(match.replace("@data.", "@"), getProperty(context, match.slice(1)) ?? options.blankValue)
    }
  } while (count < options.maxIterations && result.includes("@"));
  return result;
}

export async function processOverTime(wrapped, data, options, user) {
  if (data.round === undefined && data.turn === undefined) return wrapped(data, options, user);
  try {
    // await expirePerTurnBonusActions(this, data, options, user);
    await _processOverTime(this, data, options, user)
  } catch (err) {
    TroubleShooter.recordError(err, "processOverTime");
    error("processOverTime", err)
  } finally {
    return wrapped(data, options, user);
  }
}

export async function doOverTimeEffect(actor, effect, startTurn: boolean = true, options: any = { saveToUse: undefined, rollFlags: undefined, isActionSave: false }) {
  if (game.user?.isGM)
    return gmOverTimeEffect(actor, effect, startTurn, options);
  return untimedExecuteAsGM("gmOverTimeEffect", { actorUuid: actor.uuid, effectUuid: effect.uuid, startTurn, options })
}

export async function gmOverTimeEffect(actor, effect, startTurn: boolean = true, options: any = { saveToUse: undefined, rollFlags: undefined, rollMode: undefined }) {
  const endTurn = !startTurn;
  if (effect.disabled || effect.isSuppressed) return;
  const auraFlags = effect.flags?.ActiveAuras ?? {};
  if (auraFlags.isAura && auraFlags.ignoreSelf) return;
  const rollData = createConditionData({ actor, workflow: undefined, target: undefined });
  // const rollData = actor.getRollData();
  if (!rollData.flags) rollData.flags = actor.flags;
  rollData.flags.midiqol = rollData.flags["midi-qol"];
  const changes = effect.changes.filter(change => change.key.startsWith("flags.midi-qol.OverTime"));
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
        result = evalCondition(value, rollData);
        // result = Roll.safeEval(value);
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
    const actionSave = JSON.parse(details.actionSave ?? "false");
    const saveAbilityString = (details.saveAbility ?? "");
    const saveAbility = (saveAbilityString.includes("|") ? saveAbilityString.split("|") : [saveAbilityString]).map(s => s.trim().toLocaleLowerCase())
    const label = (details.name ?? details.label ?? "Damage Over Time").replace(/"/g, "");
    const chatFlavor = details.chatFlavor ?? "";
    if (actionSave && startTurn && changeTurnEnd) {
      const chatData = {
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `${saveAbilityString} ${i18n("midi-qol.saving-throw")} as your action to overcome ${label}`
      };
      ChatMessage.create(chatData);
    }

    if (!!!actionSave && !!options.isActionSave) continue;

    if ((endTurn && changeTurnEnd) || (startTurn && changeTurnStart) || (actionSave && options.saveToUse)) {
      let saveDC;
      let value;
      try {
        value = replaceAtFields(details.saveDC, rollData, { blankValue: 0, maxIterations: 3 });
        saveDC = !!value && Roll.safeEval(value);
      } catch (err) {
        TroubleShooter.recordError(err, `overTime effect | error evaluating saveDC ${value}`);
      } finally {
        if (!value) saveDC = -1
      }
      const saveDamage = details.saveDamage ?? "nodamage";
      const saveMagic = JSON.parse(details.saveMagic ?? "false"); //parse the saving throw true/false
      const damageRoll = details.damageRoll;
      const damageType = details.damageType ?? "piercing";
      const itemName = details.itemName;
      const damageBeforeSave = JSON.parse(details.damageBeforeSave ?? "false");
      const macroToCall = details.macro;
      const rollTypeString = details.rollType ?? "save";
      const rollType = (rollTypeString.includes("|") ? rollTypeString.split("|") : [rollTypeString]).map(s => s.trim().toLocaleLowerCase())
      const rollMode = details.rollMode;
      const allowIncapacitated = JSON.parse(details.allowIncapacitated ?? "true");
      const fastForwardDamage = details.fastForwardDamage && JSON.parse(details.fastForwardDamage);

      const killAnim = JSON.parse(details.killAnim ?? "false");
      const saveRemove = JSON.parse(details.saveRemove ?? "true");

      if (debugEnabled > 0) warn(`gmOverTimeEffect | Overtime provided data is `, details);
      if (debugEnabled > 0) warn(`gmOverTimeEffect | OverTime label=${label} startTurn=${startTurn} endTurn=${endTurn} damageBeforeSave=${damageBeforeSave} saveDC=${saveDC} saveAbility=${saveAbility} damageRoll=${damageRoll} damageType=${damageType}`);
      if (actionSave && options.saveToUse) {
        if (!options.rollFlags) return effect.id;
        if (!rollType.includes(options.rollFlags.type) || !saveAbility.includes(options.rollFlags.abilityId ?? options.rollFlags.skillId)) return effect.id;
        let content;
        if (options.saveToUse.total >= saveDC) {
          await actor.deleteEmbeddedDocuments("ActiveEffect", [effect.id]), { "expiry-reason": "midi-qol:overTime:actionSave" };
          content = `${effect.name} ${i18n("midi-qol.saving-throw")} ${i18n("midi-qol.save-success")}`;
        } else
          content = `${effect.name} ${i18n("midi-qol.saving-throw")} ${i18n("midi-qol.save-failure")}`;
        ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor }) });
        return effect.id;
      }

      let itemData: any = duplicate(overTimeJSONData);
      if (typeof itemName === "string") {
        if (itemName.startsWith("Actor.")) { // TODO check this
          const localName = itemName.replace("Actor.", "")
          const theItem = actor.items.getName(localName);
          if (theItem) itemData = theItem.toObject();
        } else {
          const theItem = game.items?.getName(itemName);
          if (theItem) itemData = theItem.toObject();
        }
      }

      itemData.img = effect.icon;
      itemData.system.save.dc = saveDC;
      itemData.system.save.scaling = "flat";
      setProperty(itemData, "flags.midi-qol.noProvokeReaction", true);
      if (saveMagic) {
        itemData.type = "spell";
        itemData.system.preparation = { mode: "atwill" }
      }
      if (rollTypeString === "save" && !actionSave) {
        itemData.system.actionType = "save";
        itemData.system.save.ability = saveAbility[0];

      }
      if (rollTypeString === "check" && !actionSave) {
        itemData.systsem.actionType = "abil";
        itemData.system.save.ability = saveAbility[0];
      }
      if (rollTypeString === "skill" && !actionSave) { // skill checks for this is a fiddle - set a midi flag so that the midi save roll will pick it up.
        itemData.system.actionType = "save";
        let skill = saveAbility[0];
        if (!getSystemCONFIG().skills[skill]) { // not a skill id see if the name matches an entry
          //@ts-expect-error
          const skillEntry = Object.entries(getSystemCONFIG().skills).find(([id, entry]) => entry.label.toLocaleLowerCase() === skill)
          if (skillEntry) skill = skillEntry[0];
          /*
          //@ts-expect-error
          const hasEntry = Object.values(getSystemCONFIG().skills).map(entry => entry.label.toLowerCase()).includes(saveAbility)

          if (hasEntry) {
            skill = Object.keys(getSystemCONFIG().skills).find(id => getSystemCONFIG().skills[id].label.toLocaleLowerCase() === saveAbility[0])
          }
          */
        }
        setProperty(itemData, "flags.midi-qol.overTimeSkillRoll", skill)
      }
      if (actionSave) {
        itemData.system.actionType = "other";
        itemData.system.save.dc = undefined;
        itemData.system.save.ability = undefined;
        itemData.system.save.scaling = undefined;
      }

      if (damageBeforeSave || saveDamage === "fulldamage") {
        setProperty(itemData.flags, "midiProperties.fulldam", true);
      } else if (saveDamage === "halfdamage" || !damageRoll) {
        setProperty(itemData.flags, "midiProperties.halfdam", true);
      } else {
        setProperty(itemData.flags, "midiProperties.nodam", true);
      }
      itemData.name = label;
      itemData.system.chatFlavor = chatFlavor;
      itemData.system.description.chat = effect.description;

      itemData._id = randomID();
      // roll the damage and save....
      const theTargetToken = getSelfTarget(actor);
      const theTargetId = theTargetToken?.document.id;
      const theTargetUuid = theTargetToken?.document.uuid;
      if (game.user && theTargetId) game.user.updateTokenTargets([theTargetId]);

      if (damageRoll) {
        let damageRollString = damageRoll;
        let stackCount = effect.flags.dae?.stacks ?? 1;
        if (globalThis.EffectCounter && theTargetToken) {
          const counter = globalThis.EffectCounter.findCounter(theTargetToken, effect.icon)
          if (counter) stackCount = counter.getValue();
        }
        for (let i = 1; i < stackCount; i++)
          damageRollString = `${damageRollString} + ${damageRoll}`;
        itemData.system.damage.parts = [[damageRollString, damageType]];
      }
      setProperty(itemData.flags, "midi-qol.forceCEOff", true);
      if (killAnim) setProperty(itemData.flags, "autoanimations.killAnim", true)
      if (macroToCall) {
        setProperty(itemData, "flags.midi-qol.onUseMacroName", macroToCall);
        setProperty(itemData, "flags.midi-qol.onUseMacroParts", new OnUseMacros(macroToCall));
      }
      // Try and find the source actor for the overtime effect so that optional bonuses etc can fire.
      //@ts-expect-error
      let origin: any = fromUuidSync(effect.origin);
      while (origin && !(origin instanceof Actor)) {
        origin = origin?.parent;
      }
      let ownedItem: Item = new CONFIG.Item.documentClass(itemData, { parent: ((origin instanceof Actor) ? origin : actor) });
      if (!actionSave && saveRemove && saveDC > -1)
        failedSaveOverTimeEffectsToDelete[ownedItem.uuid] = { actor, effectId: effect.id };

      if (details.removeCondition) {
        let value = replaceAtFields(details.removeCondition, rollData, { blankValue: 0, maxIterations: 3 });
        let remove;
        try {
          remove = evalCondition(value, rollData, true);
          // remove = Roll.safeEval(value);
        } catch (err) {
          const message = `midi-qol | gmOverTimeEffect | error when evaluating overtime remove condition ${value} - assuming true`;
          TroubleShooter.recordError(err, message);
          console.warn(message, err);
          remove = true;
        }
        if (remove) {
          overTimeEffectsToDelete[ownedItem.uuid] = { actor, effectId: effect.id }
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
          rollMode,
          workflowOptions: { targetConfirmation: "none", autoRollDamage: "onHit", fastForwardDamage, isOverTime: true, allowIncapacitated },
          flags: {
            dnd5e: { "itemData": ownedItem.toObject() },
            "midi-qol": { "isOverTime": true }
          }
        };
        await completeItemUse(ownedItem, {}, options); // worried about multiple effects in flight so do one at a time
      } catch (err) {
        const message = "midi-qol | completeItemUse | error";
        TroubleShooter.recordError(err, message);
        console.warn(message, err);
      } finally {
      }
    }
  }
}

export async function _processOverTime(combat, data, options, user) {
  let prev = (combat.current.round ?? 0) * 100 + (combat.current.turn ?? 0);
  let testTurn = combat.current.turn ?? 0;
  let testRound = combat.current.round ?? 0;
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
    if (actor && toTest !== prev) {
      // do the whole thing as a GM to avoid multiple calls to the GM to set/remove flags/conditions
      await untimedExecuteAsGM("removeActionBonusReaction", { actorUuid: actor.uuid });
    }

    /*
    // Remove any per turn optional bonus effects
    const midiFlags: any = getProperty(actor, "flags.midi-qol");
    if (actor && toTest !== prev && midiFlags) {
      if (midiFlags.optional) {
        for (let key of Object.keys(midiFlags.optional)) {
          if (midiFlags.optional[key].used) {
            untimedExecuteAsGM("_gmSetFlag", { actorUuid: actor.uuid, base: "midi-qol", key: `optional.${key}.used`, value: false })
            // await actor.setFlag("midi-qol", `optional.${key}.used`, false)
          }
        }
      }
    }
*/
    if (actor) for (let effect of actor.effects) {
      if (effect.changes.some(change => change.key.startsWith("flags.midi-qol.OverTime"))) {
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

export async function completeItemRoll(item, options: any) {
  //@ts-expect-error .version
  if (isNewerVersion(game.version, "10.278)"))
    console.warn("midi-qol | completeItemRoll(item, options) is deprecated please use completeItemUse(item, config, options)")
  return completeItemUse(item, {}, options);
}

export async function completeItemUse(item, config: any = {}, options: any = { checkGMstatus: false }) {
  let theItem: any;
  if (typeof item === "string") {
    theItem = MQfromUuid(item);
  } else if (!(item instanceof CONFIG.Item.documentClass)) {
    const magicItemUuid = item.magicItem.items.find(i => i.id === item.id)?.uuid;
    theItem = await fromUuid(magicItemUuid);
  } else theItem = item;
  // delete any existing workflow - complete item use always is fresh.
  if (Workflow.getWorkflow(theItem.uuid)) await Workflow.removeWorkflow(theItem.uuid);
  if (game.user?.isGM || !options.checkGMStatus) {
    return new Promise((resolve) => {
      let saveTargets = Array.from(game.user?.targets ?? []).map(t => { return t.id });
      let selfTarget = false;
      if (options.targetUuids && game.user && theItem.system.target.type !== "self") {
        game.user.updateTokenTargets([]);
        for (let targetUuid of options.targetUuids) {
          const theTarget = MQfromUuid(targetUuid);
          if (theTarget) theTarget.object.setTarget(true, { user: game.user, releaseOthers: false, groupSelection: true });
        }
      }
      let hookName = `midi-qol.postCleanup.${item?.uuid}`;
      if (!(item instanceof CONFIG.Item.documentClass)) {
        // Magic items create a pseudo item when doing the roll so have to hope we get the right completion
        hookName = "midi-qol.postCleanup";
      }
      Hooks.once(hookName, (workflow) => {
        if (debugEnabled > 0) warn(`completeItemUse hook fired: ${workflow.workflowName} ${hookName}`)
        if (!workflow.aborted && saveTargets && game.user) {
          game.user?.updateTokenTargets(saveTargets);
        }
        resolve(workflow);
      });

      if (item.magicItem) {
        item.magicItem.magicItemActor.roll(item.magicItem.id, item.id);
      } else {
        item.use(config, options).then(result => { if (!result) resolve(result) });
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

export function checkDefeated(tokenRef: Actor | Token | TokenDocument | string): 0 | 1 {
  const tokenDoc = getTokenDocument(tokenRef);
  //@ts-expect-error specialStatusEffects
  return hasCondition(tokenDoc, CONFIG.specialStatusEffects.DEFEATED)
    || hasCondition(tokenDoc, configSettings.midiDeadCondition);
}

export function checkIncapacitated(tokenRef: Actor | Token | TokenDocument | string, logResult: boolean = true): string | false {
  const tokenDoc = getTokenDocument(tokenRef);
  if (!tokenDoc) return false;
  if (tokenDoc.actor) {
    const vitalityResource = checkRule("vitalityResource");
    if (typeof vitalityResource === "string" && getProperty(tokenDoc.actor, vitalityResource.trim()) !== undefined) {
      const vitality = getProperty(tokenDoc.actor, vitalityResource.trim()) ?? 0;
      //@ts-expect-error .system
      if (vitality <= 0 && actor?.system.attributes?.hp?.value <= 0) {
        if (logResult) log(`${tokenDoc.actor.name} is dead and therefore incapacitated`);
        return "dead";
      }
    } else
      //@ts-expect-error .system
      if (tokenDoc.actor?.system.attributes?.hp?.value <= 0) {
        if (logResult) log(`${tokenDoc.actor.name} is incapacitated`)
        return "dead";
      }
  }
  if (configSettings.midiUnconsciousCondition && hasCondition(tokenDoc, configSettings.midiUnconsciousCondition)) {
    if (logResult) log(`${tokenDoc.name} is ${getStatusName(configSettings.midiUnconsciousCondition)} and therefore incapacitated`)
    return configSettings.midiUnconsciousCondition;
  }
  if (configSettings.midiDeadCondition && hasCondition(tokenDoc, configSettings.midiDeadCondition)) {
    if (logResult) log(`${tokenDoc.name} is ${getStatusName(configSettings.midiDeadCondition)} and therefore incapacitated`)
    return configSettings.midiDeadCondition;
  }
  const incapCondition = globalThis.MidiQOL.incapacitatedConditions.find(cond => hasCondition(tokenDoc, cond));
  if (incapCondition) {
    if (logResult) log(`${tokenDoc.name} has condition ${getStatusName(incapCondition)} so incapacitated`)
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
      let [x, y] = canvas?.grid?.getCenter(x1, y1) ?? [0, 0];
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
  const [xc, yc] = canvas.grid.grid?.getCenter(xbase, ybase) || [0, 0];
  // const snappedOrigin = canvas?.grid?.getSnappedPosition(x,y)
  const origin = new PIXI.Point(x, y);
  const tokenCenter = token.center;
  const ray: Ray = new Ray(origin, tokenCenter)
  distance = canvas?.grid?.measureDistances([{ ray }], { gridSpaces: false })[0];
  distance = Math.max(0, distance);
  return distance;
}

export function getDistanceSimpleOld(t1: Token, t2: Token, includeCover, wallBlocking = false) {
  //@ts-expect-error logCompatibilityWarning
  logCompatibilityWarning("getDistance(t1,t2,includeCover,wallBlocking) is deprecated in favor computeDistance(t1,t2,wallBlocking?).", { since: "11.2.1", untill: "12.0.0" });
  return getDistance(t1, t2, wallBlocking);
}
export function getDistanceSimple(t1: Token, t2: Token, wallBlocking = false) {
  return getDistance(t1, t2, wallBlocking);
}
/** takes two tokens of any size and calculates the distance between them
*** gets the shortest distance betwen two tokens taking into account both tokens size
*** if wallblocking is set then wall are checked
**/
export function getDistance(t1: any /*Token*/, t2: any /*Token*/, wallblocking = false): number {
  if (!canvas || !canvas.scene) return -1;
  if (!canvas.grid || !canvas.dimensions) return -1;
  t1 = getToken(t1);
  t2 = getToken(t2);
  if (!t1 || !t2) return -1;
  if (!canvas || !canvas.grid || !canvas.dimensions) return -1;

  const actor = t1.actor;
  const ignoreWallsFlag = getProperty(actor, "flags.midi-qol.ignoreWalls");
  // get condition data & eval the property
  if (ignoreWallsFlag) {
    wallblocking = false;
  }

  const t1StartX = t1.document.width >= 1 ? 0.5 : t1.document.width / 2;
  const t1StartY = t1.document.height >= 1 ? 0.5 : t1.document.height / 2;
  const t2StartX = t2.document.width >= 1 ? 0.5 : t2.document.width / 2;
  const t2StartY = t2.document.height >= 1 ? 0.5 : t2.document.height / 2;
  const t1Elevation = t1.document.elevation ?? 0;
  const t2Elevation = t2.document.elevation ?? 0;
  const t1TopElevation = t1Elevation + Math.max(t1.document.height, t1.document.width) * (canvas?.dimensions?.distance ?? 5);
  const t2TopElevation = t2Elevation + Math.min(t2.document.height, t2.document.width) * (canvas?.dimensions?.distance ?? 5); // assume t2 is trying to make itself small
  let coverVisible;
  // For levels autocover and simbul's cover calculator pre-compute token cover - full cover means no attack and so return -1
  // otherwise don't bother doing los checks they are overruled by the cover check
  if (installedModules.get("levelsautocover") && game.settings.get("levelsautocover", "apiMode") && wallblocking && configSettings.optionalRules.wallsBlockRange === "levelsautocover") {
    //@ts-expect-error
    const levelsautocoverData = AutoCover.calculateCover(t1, t2, getLevelsAutoCoverOptions());
    coverVisible = levelsautocoverData.rawCover > 0;
    if (!coverVisible) return -1;
  } else if (globalThis.CoverCalculator && configSettings.optionalRules.wallsBlockRange === "simbuls-cover-calculator") {
    if (t1 === t2) return 0; // Simbul's throws an error when calculating cover for the same token
    const coverData = globalThis.CoverCalculator.Cover(t1, t2);
    if (debugEnabled > 0) warn("getDistance | simbuls cover calculator ", t1.name, t2.name, coverData);
    if (coverData?.data.results.cover === 3 && wallblocking) return -1;
    coverVisible = true;
  } else if (installedModules.get("tokencover") && configSettings.optionalRules.wallsBlockRange === "tokencover") {
    const coverValue = calcTokenCover(t1, t2);
    if (coverValue === 3 && wallblocking) return -1;
    coverVisible = true;

  }

  var x, x1, y, y1, d, r, segments: { ray: Ray }[] = [], rdistance, distance;
  for (x = t1StartX; x < t1.document.width; x++) {
    for (y = t1StartY; y < t1.document.height; y++) {
      const origin = new PIXI.Point(...canvas.grid.getCenter(Math.round(t1.document.x + (canvas.dimensions.size * x)), Math.round(t1.document.y + (canvas.dimensions.size * y))));
      for (x1 = t2StartX; x1 < t2.document.width; x1++) {
        for (y1 = t2StartY; y1 < t2.document.height; y1++) {
          const dest = new PIXI.Point(...canvas.grid.getCenter(Math.round(t2.document.x + (canvas.dimensions.size * x1)), Math.round(t2.document.y + (canvas.dimensions.size * y1))));
          const r = new Ray(origin, dest);
          if (wallblocking) {
            switch (configSettings.optionalRules.wallsBlockRange) {
              case "center":
                let collisionCheck;

                //@ts-expect-error polygonBackends
                collisionCheck = CONFIG.Canvas.polygonBackends.move.testCollision(origin, dest, { mode: "any", type: "move" })
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
                  collisionCheck = CONFIG.Canvas.polygonBackends.move.testCollision(origin, dest, { mode: "any", type: "move" })
                  if (collisionCheck) continue;
                }
                break;
              case "alternative":
              case "simbuls-cover-calculator":
                if (coverVisible === undefined) {
                  let collisionCheck;
                  //@ts-expect-error polygonBackends
                  collisionCheck = CONFIG.Canvas.polygonBackends.sight.testCollision(origin, dest, { mode: "any", type: "sight" })
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
    let heightDifference = 0;
    let t1ElevationRange = Math.max(t1.document.height, t1.document.width) * (canvas?.dimensions?.distance ?? 5);
    if (Math.abs(t2Elevation - t1Elevation) < t1ElevationRange) {
      // token 2 is within t1's size so height difference is functionally 0
      heightDifference = 0;
    } else if (t1Elevation < t2Elevation) { // t2 above t1
      heightDifference = t2Elevation - t1TopElevation;
    } else if (t1Elevation > t2Elevation) { // t1 above t2
      heightDifference = t1Elevation - t2TopElevation;
    }
    //@ts-expect-error diagonalRule from DND5E
    const rule = canvas.grid.diagonalRule
    if (["555", "5105"].includes(rule)) {
      let nd = Math.min(distance, heightDifference);
      let ns = Math.abs(distance - heightDifference);
      distance = nd + ns;
      let dimension = canvas?.dimensions?.distance ?? 5;
      if (rule === "5105") distance = distance + Math.floor(nd / 2 / dimension) * dimension;

    } else {


    }
    distance = Math.sqrt(heightDifference * heightDifference + distance * distance);
  }
  return distance;
};

let pointWarn = debounce(() => {
  ui.notifications?.warn("4 Point LOS check selected but dnd5e-helpers not installed")
}, 100)

export function checkRange(itemIn, tokenRef: Token | TokenDocument | string, targetsRef: Set<Token | TokenDocument | string> | undefined, showWarning: boolean = true): { result: string, attackingToken?: Token, range?: number | undefined, longRange?: number | undefined } {
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
    if (!item.system.range.value && !item.system.range.long && item.system.range.units !== "touch") return {
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
    let range = (item.system.range?.value ?? 0);
    let longRange = (item.system.range?.long ?? 0);
    if (item.parent?.system) {
      let conditionData;
      let rangeBonus = getProperty(item.parent, `flags.midi-qol.range.${attackType}`) ?? "0"
      rangeBonus = rangeBonus + " + " + (getProperty(item.parent, `flags.midi-qol.range.all`) ?? "0");
      if (rangeBonus !== "0 + 0") {
        conditionData = createConditionData({ item, actor: item.parent, target: token })
        // const bonusValue = new Roll(`${rangeBonus}`, item.getRollData()).roll({ async: false }).total
        const bonusValue = evalCondition(rangeBonus, conditionData, 0);
        range = Math.max(0, range + bonusValue);
      };
      let longRangeBonus = getProperty(item.parent, `flags.midi-qol.long.${attackType}`) ?? "0"
      longRangeBonus = longRangeBonus + " + " + (getProperty(item.parent, `flags.midi-qol.long.all`) ?? "0");
      if (longRangeBonus !== "0 + 0") {
        if (!conditionData)
          conditionData = createConditionData({ item, actor: item.parent, target: token })
        // const bonusValue = new Roll(`${longRangeBonus}`, item.getRollData()).roll({ async: false }).total
        const bonusValue = evalCondition(longRangeBonus, conditionData, 0);
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
    if (getProperty(actor, "flags.midi-qol.sharpShooter") && range < longRange) range = longRange;
    if (item.system.actionType === "rsak" && getProperty(actor, "flags.dnd5e.spellSniper")) {
      range = 2 * range;
      longRange = 2 * longRange;
    }
    if (item.system.range.units === "touch") {
      range = canvas?.dimensions?.distance ?? 5;
      if (getProperty(item, "system.properties.rch")) range += canvas?.dimensions?.distance ?? 5;
      longRange = 0;
    }

    if (["mwak", "msak", "mpak"].includes(item.system.actionType) && !item.system.properties?.thr) longRange = 0;
    for (let target of targets) {
      if (target === token) continue;
      // check if target is burrowing
      if (configSettings.optionalRules.wallsBlockRange !== 'none'
        && globalThis.MidiQOL.WallsBlockConditions.some(status => hasCondition(target, status))) {
        return {
          result: "fail",
          reason: `${actor.name}'s has one or more of ${globalThis.MidiQOL.WallsBlockConditions} so can't be targeted`,
          range,
          longRange
        }
      }
      // check the range
      const distance = getDistance(token, target, configSettings.optionalRules.wallsBlockRange && !getProperty(item, "flags.midiProperties.ignoreTotalCover"));

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
  if (!tokenIn || tokenIn === null || !targetsIn) return { result: "fail", attackingToken: undefined };
  let attackingToken = tokenIn;
  if (!canvas || !canvas.tokens || !tokenIn || !targetsIn) return {
    result: "fail",
    attackingToken: tokenIn,
  }

  const canOverride = getProperty(tokenIn, "actor.flags.midi-qol.rangeOverride.attack.all") || getProperty(tokenIn, `actor.flags.midi-qol.rangeOverride.attack.${itemIn.system.actionType}`)

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
    const canOverride = getProperty(t.actor ?? {}, "flags.midi-qol.rangeOverride.attack.all") || getProperty(t.actor ?? {}, `flags.midi-qol.rangeOverride.attack.${itemIn.system.actionType}`)
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

export function computeCoverBonus(attacker: Token | TokenDocument, target: Token | TokenDocument, item: any = undefined) {
  let coverBonus = 0;
  if (!attacker) return coverBonus;
  //@ts-expect-error .Levels
  let levelsAPI = CONFIG.Levels?.API;
  switch (configSettings.optionalRules.coverCalculation) {
    case "levelsautocover":
      if (!installedModules.get("levelsautocover") || !game.settings.get("levelsautocover", "apiMode")) return 0;
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
      else if (safeGetGameSetting("tokencover", "midiqol-covercheck") === "midiqol-covercheck-none") {
        const coverValue = calcTokenCover(attacker, target);
        if (coverValue < (safeGetGameSetting("tokencover", "cover-trigger-percent-low") ?? 0.5)) coverBonus = 0;
        else if (coverValue < (safeGetGameSetting("tokencover", "cover-trigger-percent-medium") ?? 0.75)) coverBonus = HALF_COVER;
        else if (coverValue < (safeGetGameSetting("tokencover", "cover-trigger-percent-high") ?? 1)) coverBonus = THREE_QUARTERS_COVER;
        else coverBonus = FULL_COVER;
      }
      break;
    case "none":
    default:
      coverBonus = 0;
      break;
  }

  if (item?.flags?.midiProperties?.ignoreTotalCover && item.type === "spell") coverBonus = 0;
  else if (item?.flags?.midiProperties?.ignoreTotalCover && coverBonus === FULL_COVER) coverBonus = THREE_QUARTERS_COVER;
  if (item?.system.actionType === "rwak" && attacker.actor && getProperty(attacker.actor, "flags.midi-qol.sharpShooter") && coverBonus !== FULL_COVER)
    coverBonus = 0;
  if (["rsak"/*, rpak*/].includes(item?.system.actionType) && attacker.actor && getProperty(attacker.actor, "flags.dnd5e.spellSniper") && coverBonus !== FULL_COVER)
    coverBonus = 0;
  if (target.actor)
    setProperty(target.actor, "flags.midi-qol.acBonus", coverBonus);
  return coverBonus;

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
  if (configSettings.averageNPCDamage && workflow?.actor.type === "npc") return "onHit";
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

export function itemHasDamage(item) {
  return item?.system.actionType !== "" && item?.hasDamage;
}

export function itemIsVersatile(item) {
  return item?.system.actionType !== "" && item?.isVersatile;
}

export function getRemoveAttackButtons(item?: Item): boolean {
  if (item) {
    const itemSetting = getProperty(item, "flags.midi-qol.removeAttackDamageButtons");
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
    const itemSetting = getProperty(item, "flags.midi-qol.removeAttackDamageButtons");
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
  let name = token.name;
  if (!configSettings.useTokenNames) name = token.actor?.name ?? token.name;
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
  templateUuid: string;
  removeUuids?: string[];
}

export async function addConcentration(actorRef: Actor | string, concentrationData: ConcentrationData) {
  const actor = getActor(actorRef);
  if (!actor) return;
  if (debugEnabled > 0) warn("addConcentration", actor.name, concentrationData);
  await addConcentrationEffect(actor, concentrationData);
  await setConcentrationData(actor, concentrationData);
}
// Add the concentration marker to the character and update the duration if possible
export async function addConcentrationEffect(actor, concentrationData: ConcentrationData) {
  const item = concentrationData.item;
  //@ts-expect-error .dfreds
  const dfreds = game.dfreds;
  // await item.actor.unsetFlag("midi-qol", "concentration-data");
  let selfTarget = actor.token ? actor.token.object : getSelfTarget(actor);
  if (!selfTarget) return;
  const concentrationLabel = getConcentrationLabel();
  let statusEffect;
  if (installedModules.get("dfreds-convenient-effects")) {
    statusEffect = dfreds.effectInterface?.findEffectByName(concentrationLabel).toObject();
  }
  if (!statusEffect && installedModules.get("condition-lab-triggler")) {
    //@ts-expect-error se.name
    statusEffect = duplicate(CONFIG.statusEffects.find(se => se.id.startsWith("condition-lab-triggler") && (se.name ?? se.label) === concentrationLabel));
    if (!statusEffect.name) statusEffect.name = statusEffect.label;
  }
  if (statusEffect) { // found a cub or convenient status effect.
    const itemDuration = item?.system.duration;
    // set the token as concentrating
    if (installedModules.get("dae")) {
      const inCombat = (game.combat?.turns.some(combatant => combatant.token?.id === selfTarget.id));
      const convertedDuration = globalThis.DAE.convertDuration(itemDuration, inCombat);
      if (convertedDuration?.type === "seconds") {
        statusEffect.duration = { seconds: convertedDuration.seconds, startTime: game.time.worldTime }
      } else if (convertedDuration?.type === "turns") {
        statusEffect.duration = {
          rounds: convertedDuration.rounds,
          turns: convertedDuration.turns,
          startRound: game.combat?.round,
          startTurn: game.combat?.turn
        }
      }
    }
    statusEffect.origin = item?.uuid
    setProperty(statusEffect.flags, "midi-qol.isConcentration", statusEffect.origin);
    setProperty(statusEffect.flags, "dae.transfer", false);
    setProperty(statusEffect, "transfer", false);
    if (statusEffect.tint === null) delete statusEffect.tint;
    // condition-lab-triggler has a name in the label field
    const existing = selfTarget.actor?.effects.find(e => e.name === (statusEffect.name ?? statusEffect.label)); // TODO should be able to remove this .label
    // if (existing) await existing.delete();

    // return await selfTarget.document.toggleActiveEffect(statusEffect, { active: true })
    const result = await actor.createEmbeddedDocuments("ActiveEffect", [statusEffect]);
    return result;
  } else {
    const existing = selfTarget.actor?.effects.find(e => e.name === concentrationLabel);
    //if (existing) await existing.delete(); // make sure that we don't double apply concentration

    const inCombat = (game.combat?.turns.some(combatant => combatant.token?.id === selfTarget.id));
    const effectData = {
      changes: [],
      origin: item.uuid, //flag the effect as associated to the spell being cast
      disabled: false,
      icon: itemJSONData.img,
      label: concentrationLabel,
      id: concentrationLabel,
      duration: {},
      flags: {
        "midi-qol": { isConcentration: item?.uuid },
        "dae": { transfer: false }
      }
    }
    setProperty(effectData, "statuses", [concentrationLabel]);
    if (installedModules.get("dae")) {
      const convertedDuration = globalThis.DAE.convertDuration(item.system.duration, inCombat);
      if (convertedDuration?.type === "seconds") {
        effectData.duration = { seconds: convertedDuration.seconds, startTime: game.time.worldTime }
      } else if (convertedDuration?.type === "turns") {
        effectData.duration = {
          rounds: convertedDuration.rounds,
          turns: convertedDuration.turns,
          startRound: game.combat?.round,
          startTurn: game.combat?.turn
        }
      }
    }
    if (debugEnabled > 1) debug("adding concentration", actor.name)
    return await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
  }
}

export async function setConcentrationData(actor, concentrationData: ConcentrationData) {
  if (actor && concentrationData.targets) {
    let targets: { tokenUuid: string | undefined, actorUuid: string | undefined }[] = [];
    const selfTargetUuid = actor.uuid;
    let selfTargeted = false;
    for (let hit of concentrationData.targets) {
      const tokenUuid = hit.document?.uuid ?? hit.uuid;
      const actorUuid = hit.actor?.uuid ?? "";
      targets.push({ tokenUuid, actorUuid });
      if (selfTargetUuid === actorUuid) selfTargeted = true;
    }

    if (!selfTargeted) {
      let selfTarget = actor.token ? actor.token.object : getSelfTarget(actor);
      targets.push({ tokenUuid: selfTarget.uuid, actorUuid: actor.uuid })
    }
    let templates = concentrationData.templateUuid ? [concentrationData.templateUuid] : [];
    await actor.setFlag("midi-qol", "concentration-data", {
      uuid: concentrationData.item.uuid,
      targets,
      templates,
      removeUuids: concentrationData.removeUuids ?? []
    })
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
      if (!options.includeIncapacitated && checkIncapacitated(t, debugEnabled > 0)) return false;
      let inRange = false;
      if (t.actor &&
        (t.id !== token.id || options?.includeToken) && // not the token
        //@ts-expect-error .disposition v10      
        (disposition === null || targetDisposition.includes(t.document.disposition))) {
        const tokenDistance = getDistance(t, token, true);
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

export function hasCondition(tokenRef: Token | TokenDocument | string | undefined, condition: string): 0 | 1 {
  const td = getTokenDocument(tokenRef)
  if (!td) return 0;
  //@ts-expect-error specialStatusEffects
  const specials = CONFIG.specialStatusEffects;
  switch (condition?.toLocaleLowerCase()) {
    case "blind":
      //@ts-expect-error hasStatusEffect
      if (td.hasStatusEffect(specials.BLIND)) return 1;
      break;
    case "burrow":
    case "burrowing":
      //@ts-expect-error hasStatusEffect
      if (td.hasStatusEffect(specials.BURROW)) return 1;
      break;
    case "dead":
      //@ts-expect-error hasStatusEffect
      if (td.hasStatusEffect(specials.DEFEATED)) return 1;
      break
    case "deaf":
      //@ts-expect-error hasStatusEffect
      if (td.hasStatusEffect(specials.DEAF)) return 1;
      break;
    case "disease":
    case "disieased":
      //@ts-expect-error hasStatusEffect
      if (td.hasStatusEffect(specials.DISEASE)) return 1;
      break;
    case "fly":
    case "flying":
      //@ts-expect-error hasStatusEffect
      if (td.hasStatusEffect(specials.FLY)) return 1;
      break;
    case "inaudible":
    case "silent":
      //@ts-expect-error hasStatusEffect
      if (td.hasStatusEffect(specials.INAUDIBLE)) return 1;
      break;
    case "invisible":
      //@ts-expect-error hasStatusEffect
      if (td.hasStatusEffect(specials.INVISIBLE)) return 1;
      break;
    case "poison":
    case "poisoned":
      //@ts-expect-error hasStatusEffect
      if (td.hasStatusEffect(specials.POISON)) return 1;
      break;
  }
  //@ts-expect-error hasStatusEffect
  if (td.hasStatusEffect(condition.toLocaleLowerCase()) || td.hasStatusEffect(condition)) return 1;

  //@ts-expect-error
  const cub = game.cub;
  if (installedModules.get("condition-lab-triggler") && condition === "invisible" && cub.hasCondition("Invisible", [td.object], { warn: false })) return 1;
  if (installedModules.get("condition-lab-triggler") && condition === "hidden" && cub.hasCondition("Hidden", [td.object], { warn: false })) return 1;
  if (installedModules.get("dfreds-convenient-effects")) {
    //@ts-expect-error .dfreds
    const CEInt = game.dfreds?.effectInterface;
    const localCondition = i18n(`midi-qol.${condition}`);
    if (CEInt.hasEffectApplied(localCondition, td.actor?.uuid)) return 1;
    if (CEInt.hasEffectApplied(condition, td.actor?.uuid)) return 1;
  }
  return 0;
}

export async function removeInvisible() {
  if (!canvas || !canvas.scene) return;
  const token: Token | undefined = canvas.tokens?.get(this.tokenId);
  if (!token) return;
  await removeTokenCondition(token, i18n(`midi-qol.invisible`));
  //@ts-expect-error
  await token.document.toggleActiveEffect({ id: CONFIG.specialStatusEffects.INVISIBLE }, { active: false });
  log(`Hidden/Invisibility removed for ${this.actor.name}`)
}

export async function removeHidden() {
  if (!canvas || !canvas.scene) return;
  const token: Token | undefined = canvas.tokens?.get(this.tokenId);
  if (!token) return;
  await removeTokenCondition(token, i18n(`midi-qol.hidden`));
  log(`Hidden removed for ${this.actor.name}`)
}

export async function removeTokenCondition(token: Token, condition: string) {
  if (!token) return;
  const hasEffect = token.actor?.effects.find(ef => ef.name === condition);
  if (hasEffect) await hasEffect.delete();
}

// this = {actor, item, myExpiredEffects}
export async function expireMyEffects(effectsToExpire: string[]) {
  const expireHit = effectsToExpire.includes("1Hit") && !this.effectsAlreadyExpired.includes("1Hit");
  const expireAction = effectsToExpire.includes("1Action") && !this.effectsAlreadyExpired.includes("1Action");
  const expireSpell = effectsToExpire.includes("1Spell") && !this.effectsAlreadyExpired.includes("1Spell");
  const expireAttack = effectsToExpire.includes("1Attack") && !this.effectsAlreadyExpired.includes("1Attack");
  const expireDamage = effectsToExpire.includes("DamageDealt") && !this.effectsAlreadyExpired.includes("DamageDealt");
  const expireInitiative = effectsToExpire.includes("Initiative") && !this.effectsAlreadyExpired.includes("Initiative");

  // expire any effects on the actor that require it
  if (debugEnabled && false) {
    const test = this.actor.effects.map(ef => {
      const specialDuration = getProperty(ef.flags, "dae.specialDuration");
      return [(expireAction && specialDuration?.includes("1Action")),
      (expireAttack && specialDuration?.includes("1Attack") && this.item?.hasAttack),
      (expireHit && this.item?.hasAttack && specialDuration?.includes("1Hit") && this.hitTargets.size > 0)]
    })
    if (debugEnabled > 1) debug("expiry map is ", test)
  }
  const myExpiredEffects = this.actor.effects?.filter(ef => {
    const specialDuration = getProperty(ef.flags, "dae.specialDuration");
    if (!specialDuration || !specialDuration?.length) return false;
    return (expireAction && specialDuration.includes("1Action")) ||
      (expireAttack && this.item?.hasAttack && specialDuration.includes("1Attack")) ||
      (expireSpell && this.item?.type === "spell" && specialDuration.includes("1Spell")) ||
      (expireAttack && this.item?.hasAttack && specialDuration.includes(`1Attack:${this.item?.system.actionType}`)) ||
      (expireHit && this.item?.hasAttack && specialDuration.includes("1Hit") && this.hitTargets.size > 0) ||
      (expireHit && this.item?.hasAttack && specialDuration.includes(`1Hit:${this.item?.system.actionType}`) && this.hitTargets.size > 0) ||
      (expireDamage && this.item?.hasDamage && specialDuration.includes("DamageDealt")) ||
      (expireInitiative && specialDuration.includes("Initiative"))
  }).map(ef => ef.id);
  if (debugEnabled > 1) debug("expire my effects", myExpiredEffects, expireAction, expireAttack, expireHit);
  this.effectsAlreadyExpired = this.effectsAlreadyExpired.concat(effectsToExpire);
  if (myExpiredEffects?.length > 0) await this.actor?.deleteEmbeddedDocuments("ActiveEffect", myExpiredEffects, { "expiry-reason": `midi-qol:${effectsToExpire}` });
}

export async function expireRollEffect(rolltype: string, abilityId: string, success: boolean | undefined) {
  const rollType = rolltype.charAt(0).toUpperCase() + rolltype.slice(1)
  const expiredEffects = this.effects?.filter(ef => {
    const specialDuration = getProperty(ef.flags, "dae.specialDuration");
    if (!specialDuration) return false;
    if (specialDuration.includes(`is${rollType}`)) return true;
    if (specialDuration.includes(`is${rollType}.${abilityId}`)) return true;
    if (success === true && specialDuration.includes(`is${rollType}Success`)) return true;
    if (success === true && specialDuration.includes(`is${rollType}Success.${abilityId}`)) return true;
    if (success === false && specialDuration.includes(`is${rollType}Failure`)) return true;
    if (success === false && specialDuration.includes(`is${rollType}Failure.${abilityId}`)) return true;
    return false;
  }).map(ef => ef.id);
  if (expiredEffects?.length > 0) {
    await timedAwaitExecuteAsGM("removeEffects", {
      actorUuid: this.uuid,
      effects: expiredEffects,
      options: { "midi-qol": `special-duration:${rollType}:${abilityId}` }
    });
  }
}

export function validTargetTokens(tokenSet: Set<Token> | undefined | any): Set<Token> {
  return tokenSet?.filter(tk => tk.actor).filter(tk => isTargetable(tk)) ?? new Set();
}

export function MQfromUuid(uuid): any | null {
  if (!uuid || uuid === "") return null;
  //@ts-expect-error foundry v10 types
  return fromUuidSync(uuid)
}

export function MQfromActorUuid(uuid: string | undefined): any {
  let doc = MQfromUuid(uuid);
  if (doc instanceof Actor) return doc;
  if (doc instanceof Token) return doc.actor;
  if (doc instanceof TokenDocument) return doc.actor;
  return null;
}


class RollModifyDialog extends Application {
  rollExpanded: boolean;
  timeRemaining: number;
  timeoutId: any;
  seconditimeoutId: any;

  data: {
    //@ts-expect-error dnd5e v10
    actor: globalThis.dnd5e.documents.Actor5e,
    flags: string[],
    flagSelector: string,
    targetObject: any,
    rollId: string,
    rollTotalId: string,
    rollHTMLId: string,
    title: string,
    content: HTMLElement | JQuery<HTMLElement> | string,
    currentRoll: Roll,
    rollHTML: string,
    callback: () => {},
    close: () => {},
    buttons: any,
    rollMode: string | undefined,
    timeout: number
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
      if (this.seconditimeoutId) clearTimeout(this.seconditimeoutId);
      this.timeoutId = undefined;
      this.close();
    }, this.data.timeout * 1000);
  }

  static get defaultOptions() {
    return mergeObject(super.defaultOptions, {
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
    this.seconditimeoutId = setTimeout(() => {
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
    if (!this.seconditimeoutId) this.set1SecondTimeout();
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
      return getProperty(this.data.actor, flagName) !== undefined
    });
    if (this.data.flags.length === 0) this.close();
    this.data.buttons = this.data.flags.reduce((obj, flag) => {
      let flagData = getProperty(this.data.actor, flag);
      let value = getProperty(flagData, this.data.flagSelector);
      if (value !== undefined) {
        let labelDetail;
        if (typeof value === "string") {
          labelDetail = Roll.replaceFormulaData(value, this.data.actor.getRollData());
          if (value.startsWith("ItemMacro")) labelDetail = "ItemMacro"
          else if (value.startsWith("function")) labelDetail = "Function";
        } else labelDetail = `${value}`
        obj[randomID()] = {
          icon: '<i class="fas fa-dice-d20"></i>',
          //          label: (flagData.label ?? "Bonus") + `  (${getProperty(flagData, this.data.flagSelector) ?? "0"})`,
          label: (flagData.label ?? "Bonus") + `  (${labelDetail})`,
          value: `${value}`,
          key: flag,
          callback: this.data.callback
        }
      }
      let selector = this.data.flagSelector.split(".");
      if (selector[selector.length - 1] !== "all") {
        selector[selector.length - 1] = "all";
        const allSelector = selector.join(".");
        value = getProperty(flagData, allSelector);

        if (value !== undefined) {
          let labelDetail = Roll.replaceFormulaData(value, this.data.actor.getRollData());
          if (value.startsWith("ItemMacro")) labelDetail = "ItemMacro"
          else if (value.startsWith("function")) labelDetail = "Function";
          obj[randomID()] = {
            icon: '<i class="fas fa-dice-d20"></i>',
            //          label: (flagData.label ?? "Bonus") + `  (${getProperty(flagData, allSelector) ?? "0"})`,
            label: (flagData.label ?? "Bonus") + `  (${labelDetail})`,
            value,
            key: flag,
            callback: this.data.callback
          }
        }
      }
      return obj;
    }, {})
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
    if (this.seconditimeoutId) {
      clearTimeout(this.seconditimeoutId);
      this.seconditimeoutId = 0;
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
    if (this.seconditimeoutId) {
      clearTimeout(this.seconditimeoutId);
    }
    try {
      if (button.callback) {

        await button.callback(this, button);
        // await this.getData({}; Render will do a get data, doing it twice breaks the button data?
        if (this.seconditimeoutId) this.seconditimeoutId = 0;
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
    if (this.seconditimeoutId) clearTimeout(this.seconditimeoutId);
    if (this.data.close) this.data.close();
    $(document).off('keydown.chooseDefault');
    return super.close();
  }
}

export async function processAttackRollBonusFlags() { // bound to workflow
  let attackBonus = "attack.all";
  if (this.item && this.item.hasAttack) attackBonus = `attack.${this.item.system.actionType}`;
  const optionalFlags = getProperty(this, "actor.flags.midi-qol.optional") ?? {};
  // If the attack roll is a fumble only select flags that allow the roll to be rerolled.
  let bonusFlags = Object.keys(optionalFlags)
    .filter(flag => {
      const hasAttackFlag = getProperty(this.actor.flags, `midi-qol.optional.${flag}.attack.all`) ||
        getProperty(this.actor.flags, `midi-qol.optional.${flag}.${attackBonus}`);
      if (hasAttackFlag === undefined) return false;
      if (this.isFumble && !hasAttackFlag?.includes("roll")) return false;
      if (!this.actor.flags["midi-qol"].optional[flag].count) return true;
      return getOptionalCountRemainingShortFlag(this.actor, flag) > 0;
    })
    .map(flag => `flags.midi-qol.optional.${flag}`);

  if (bonusFlags.length > 0) {
    this.attackRollHTML = await midiRenderRoll(this.attackRoll);
    await bonusDialog.bind(this)(bonusFlags, attackBonus, checkMechanic("displayBonusRolls"), `${this.actor.name} - ${i18n("DND5E.Attack")} ${i18n("DND5E.Roll")}`, "attackRoll", "attackTotal", "attackRollHTML")
  }
  if (this.targets.size === 1) {
    const targetAC = this.targets.first().actor.system.attributes.ac.value;
    this.processAttackRoll();
    const isMiss = this.isFumble || this.attackRoll.total < targetAC;
    if (isMiss) {
      attackBonus = "attack.fail.all"
      if (this.item && this.item.hasAttack) attackBonus = `attack.fail.${this.item.system.actionType}`;
      let bonusFlags = Object.keys(optionalFlags)
        .filter(flag => {
          const hasAttackFlag = getProperty(this.actor.flags, `midi-qol.optional.${flag}.attack.fail.all`)
            || getProperty(this.actor.flags, `midi-qol.optional.${flag}.${attackBonus}`);
          if (hasAttackFlag === undefined) return false;
          if (this.isFumble && !hasAttackFlag?.includes("roll")) return false;
          if (!this.actor.flags["midi-qol"].optional[flag].count) return true;
          return getOptionalCountRemainingShortFlag(this.actor, flag) > 0;
        })
        .map(flag => `flags.midi-qol.optional.${flag}`);
      if (bonusFlags.length > 0) {
        this.attackRollHTML = await midiRenderRoll(this.attackRoll);
        await bonusDialog.bind(this)(bonusFlags, attackBonus, checkMechanic("displayBonusRolls"), `${this.actor.name} - ${i18n("DND5E.Attack")} ${i18n("DND5E.Roll")}`, "attackRoll", "attackTotal", "attackRollHTML")
      }
    }
  }
  return this.attackRoll;
}

export async function processDamageRollBonusFlags(): Promise<Roll> { // bound to a workflow
  let damageBonus = "damage.all";
  if (this.item) damageBonus = `damage.${this.item.system.actionType}`;
  const optionalFlags = getProperty(this, "actor.flags.midi-qol.optional") ?? {};
  const bonusFlags = Object.keys(optionalFlags)
    .filter(flag => {
      const hasDamageFlag = getProperty(this.actor.flags, `midi-qol.optional.${flag}.damage.all`) !== undefined ||
        getProperty(this.actor.flags, `midi-qol.optional.${flag}.${damageBonus}`) !== undefined;
      if (!hasDamageFlag) return false;
      return getOptionalCountRemainingShortFlag(this.actor, flag) > 0;
    })
    .map(flag => `flags.midi-qol.optional.${flag}`);
  if (bonusFlags.length > 0) {
    this.damageRollHTML = await midiRenderRoll(this.damageRoll);
    await bonusDialog.bind(this)(bonusFlags, damageBonus, false, `${this.actor.name} - ${i18n("DND5E.Damage")} ${i18n("DND5E.Roll")}`, "damageRoll", "damageTotal", "damageRollHTML")
  }
  return this.damageRoll;
}

export async function bonusDialog(bonusFlags, flagSelector, showRoll, title, rollId: string, rollTotalId: string, rollHTMLId: string, options: any = {}) {
  const showDiceSoNice = /* ["attackRoll", "damageRoll"].includes(rollId) && */ dice3dEnabled(); // && configSettings.mergeCard;
  let timeoutId;
  let timeout = options.timeout ?? configSettings.reactionTimeout ?? defaultTimeout
  return new Promise((resolve, reject) => {
    function onClose() {
      if (timeoutId) clearTimeout(timeoutId);
      resolve(null)
    }
    if (options.timeout) {
      timeoutId = setTimeout(() => {
        resolve(null);
      }, timeout * 1000);
    }
    const callback = async (dialog, button) => {
      if (this.seconditimeoutId) {
        clearTimeout(this.seconditimeoutId);
      }
      let newRoll; { }
      let reRoll;
      const player = playerForActor(this.actor);
      let chatMessage;
      const undoId = randomID();
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

      const rollMode = getProperty(this.actor, button.key)?.rollMode ?? game.settings.get("core", "rollMode");
      if (!hasEffectGranting(this.actor, button.key, flagSelector)) return;
      let resultApplied = false; // This is just for macro calls
      if (button.value.trim().startsWith("ItemMacro") || button.value.trim().startsWith("Macro") || button.value.trim().startsWith("function")) {
        let result;
        let workflow;
        if (this instanceof Workflow || this.workflow) {
          workflow = this.workflow ?? this;
        } else {
          const itemUuidOrName = button.value.split(".").slice(1).join(".");
          //@ts-expect-error
          let item = fromUuidSync(itemUuidOrName);
          if (!item && this.actor) item = this.actor.items.getName(itemUuidOrName);
          if (!item && this instanceof Actor) item = this.items.getName(itemUuidOrName);
          workflow = new DummyWorkflow(this.actor ?? this, item, ChatMessage.getSpeaker({ actor: this.actor }), [], {});
        }
        const macroData = workflow.getMacroData();
        macroData.macroPass = `${button.key}.${flagSelector}`;
        macroData.tag = "optional";
        macroData.roll = this[rollId];
        let macroToCall = button.value;
        if (macroToCall.startsWith("Macro.")) macroToCall = macroToCall.replace("Macro.", "");
        result = await workflow.callMacro(workflow?.item, macroToCall, macroData, { roll: this[rollId] });
        if (typeof result === "string")
          button.value = result;
        else {
          if (result instanceof Roll) newRoll = result;
          else newRoll = this[rollId];
          resultApplied = true;
        }
        if (result === undefined && debugEnabled > 0) console.warn(`midi-qol | bonusDialog | macro ${button.value} return undefined`)
      }
      // do the roll modifications
      if (!resultApplied) switch (button.value) {
        case "reroll": reRoll = await this[rollId].reroll({ async: true });
          if (showDiceSoNice) await displayDSNForRoll(reRoll, rollId, rollMode);
          newRoll = reRoll; break;
        case "reroll-query":
          reRoll = reRoll = await this[rollId].reroll({ async: true });
          if (showDiceSoNice) await displayDSNForRoll(reRoll, rollId, rollMode);
          const newRollHTML = await midiRenderRoll(reRoll);
          if (await Dialog.confirm({ title: "Confirm reroll", content: `Replace ${this[rollHTMLId]} with ${newRollHTML}`, defaultYes: true }))
            newRoll = reRoll
          else
            newRoll = this[rollId];
          break;
        case "reroll-kh": reRoll = await this[rollId].reroll({ async: true });
          if (showDiceSoNice) await displayDSNForRoll(reRoll, rollId === "attackRoll" ? "attackRollD20" : rollId, rollMode);
          newRoll = reRoll;
          if (reRoll.total <= this[rollId].total) newRoll = this[rollId];
          break;
        case "reroll-kl": reRoll = await this[rollId].reroll({ async: true });
          newRoll = reRoll;
          if (reRoll.total > this[rollId].total) newRoll = this[rollId];
          if (showDiceSoNice) await displayDSNForRoll(reRoll, rollId === "attackRoll" ? "attackRollD20" : rollId, rollMode);
          break;
        case "reroll-max": newRoll = await this[rollId].reroll({ async: true, maximize: true });
          if (showDiceSoNice) await displayDSNForRoll(newRoll, rollId === "attackRoll" ? "attackRollD20" : rollId, rollMode);
          break;
        case "reroll-min": newRoll = await this[rollId].reroll({ async: true, minimize: true });
          if (showDiceSoNice) await displayDSNForRoll(newRoll, rollId === "attackRoll" ? "attackRollD20" : rollId, rollMode);
          break;
        case "success": newRoll = await new Roll("99").evaluate({ async: true }); break;
        case "fail": newRoll = await new Roll("-1").evaluate({ async: true }); break;
        default:
          if (typeof button.value === "string" && button.value.startsWith("replace ")) {
            const rollParts = button.value.split(" ");
            newRoll = new Roll(rollParts.slice(1).join(" "), (this.item ?? this.actor).getRollData());
            newRoll = await newRoll.evaluate({ async: true });
            if (showDiceSoNice) await displayDSNForRoll(newRoll, rollId, rollMode);
          } else if (flagSelector.startsWith("damage.") && getProperty(this.actor ?? this, `${button.key}.criticalDamage`)) {
            //@ts-expect-error .DamageRoll
            const DamageRoll = CONFIG.Dice.DamageRoll
            let rollOptions = duplicate(this[rollId].options);
            rollOptions.configured = false;
            // rollOptions = { critical: (this.isCritical || this.rollOptions.critical), configured: false };
            //@ts-expect-error D20Roll
            newRoll = CONFIG.Dice.D20Roll.fromRoll(this[rollId]);
            newRoll.terms.push(new OperatorTerm({ operator: "+" }));
            let rollData: any = {}
            if (this instanceof Workflow) rollData = this.item?.getRollData() ?? this.actor?.getRollData() ?? {};
            else rollData = this.actor?.getRollData() ?? {}; // 
            const tempRoll = new DamageRoll(`${button.value}`, rollData, rollOptions);
            await tempRoll.evaluate({ async: true });
            if (showDiceSoNice) await displayDSNForRoll(tempRoll, rollId, rollMode);
            newRoll._total = this[rollId]._total + tempRoll.total;
            newRoll._formula = `${this[rollId]._formula} + ${tempRoll.formula}`
            newRoll.terms = newRoll.terms.concat(tempRoll.terms);
          } else {
            //@ts-expect-error
            newRoll = CONFIG.Dice.D20Roll.fromRoll(this[rollId]);
            let rollData: any = {}
            if (this instanceof Workflow) rollData = this.item?.getRollData() ?? this.actor?.getRollData() ?? {};
            else rollData = this.actor?.getRollData() ?? this;
            const tempRoll = new Roll(button.value, rollData).roll({ async: false });
            if (showDiceSoNice) await displayDSNForRoll(tempRoll, rollId, rollMode);
            newRoll = addRollTo(newRoll, tempRoll);
          }
          //newRoll = new CONFIG.Dice.D20Roll(`${this[rollId].result} + ${button.value}`, (this.item ?? this.actor).getRollData(), rollOptions);
          break;
      }

      if (showRoll && this.category === "ac") { // TODO do a more general fix for displaying this stuff
        // const oldRollHTML = await this[rollId].render() ?? this[rollId].result
        const newRollHTML = await midiRenderRoll(newRoll);
        const chatData: any = {
          // content: `${this[rollId].result} -> ${newRoll.formula} = ${newRoll.total}`,
          flavor: game.i18n.localize("DND5E.ArmorClass"),
          content: `${newRollHTML}`,
          whisper: [player?.id ?? ""]
        };
        ChatMessage.applyRollMode(chatData, rollMode);
        chatMessage = await ChatMessage.create(chatData);
      }

      const oldRollHTML = await this[rollId].render() ?? this[rollId].result

      this[rollId] = newRoll;
      this[rollTotalId] = newRoll.total;
      this[rollHTMLId] = await midiRenderRoll(newRoll);
      const macroToCall = getProperty(this.actor, `${button.key}.macroToCall`)?.trim();
      if (macroToCall) {
        if (this instanceof Workflow) {
          const macroData = this.getMacroData();
          this.callMacro(this.item, macroToCall, macroData, {})
        } else if (this.actor) {
          let item;
          if (typeof macroToCall === "string" && macroToCall.startsWith("ItemMacro.")) {
            const itemName = macroToCall.split(".").slice(1).join(".");
            item = this.actor.items.getName(itemName);
          }
          const dummyWorkflow = new DummyWorkflow(this.actor, item, ChatMessage.getSpeaker({ actor: this.actor }), [], {});
          dummyWorkflow.callMacro(item, macroToCall, dummyWorkflow.getMacroData(), {})
        } else console.warn(`midi-qol | bonusDialog | no way to call macro ${macroToCall}`)
      }

      //@ts-expect-error D20Roll
      let originalRoll = CONFIG.Dice.D20Roll.fromRoll(this[rollId]);
      dialog.data.rollHTML = this[rollHTMLId];
      dialog.data.content = this[rollHTMLId];
      await removeEffectGranting(this.actor, button.key);
      bonusFlags = bonusFlags.filter(bf => bf !== button.key)
      // this.actor.reset();
      if (bonusFlags.length === 0) {
        dialog.close();
        newRoll.options.rollMode = rollMode;
        resolve(newRoll);
        if (showRoll) {
          // const oldRollHTML = await originalRoll.render() ?? this[rollId].result
          const newRollHTML = reRoll ? await midiRenderRoll(reRoll) : await midiRenderRoll(newRoll);
          const chatData: any = {
            // content: `${this[rollId].result} -> ${newRoll.formula} = ${newRoll.total}`,
            flavor: `${title} ${button.value}`,
            content: `${oldRollHTML}<br>${newRollHTML}`,
            whisper: [player?.id ?? ""],
            rolls: [originalRoll, newRoll],
            type: CONST.CHAT_MESSAGE_TYPES.ROLL,
          };
          ChatMessage.applyRollMode(chatData, rollMode);
          chatMessage = ChatMessage.create(chatData);
        }
      }
      dialog.data.flags = bonusFlags;
      dialog.render(true);
      // dialog.close();
      if (chatMessage) untimedExecuteAsGM("updateUndoChatCardUuidsById", { id: undoId, chatCardUuids: [(await chatMessage).uuid] });
    }
    let content;
    let rollMode: any = options?.rollMode ?? game.settings.get("core", "rollMode");
    if (game.user?.isGM) content = this[rollHTMLId];
    else {
      if (["publicroll", "gmroll", "selfroll"].includes(rollMode)) content = this[rollHTMLId];
      else content = "Hidden Roll";
    }
    const dialog = new RollModifyDialog(
      {
        actor: this.actor,
        flags: bonusFlags,
        flagSelector,
        targetObject: this,
        rollId,
        rollTotalId,
        rollHTMLId,
        title,
        content,
        currentRoll: this[rollId],
        rollHTML: this[rollHTMLId],
        rollMode,
        callback,
        close: onClose.bind(this),
        timeout
      }, {
      width: 400
    }).render(true);
  });
}

//@ts-expect-error dnd5e v10
export function getOptionalCountRemainingShortFlag(actor: globalThis.dnd5e.documents.Actor5e, flag: string) {
  const countValue = getOptionalCountRemaining(actor, `flags.midi-qol.optional.${flag}.count`);
  const altCountValue = getOptionalCountRemaining(actor, `flags.midi-qol.optional.${flag}.countAlt`);
  return getOptionalCountRemaining(actor, `flags.midi-qol.optional.${flag}.count`) && getOptionalCountRemaining(actor, `flags.midi-qol.optional.${flag}.countAlt`)

  return getOptionalCountRemaining(actor, `flags.midi-qol.optional.${flag}.count`)
}
//@ts-expect-error dnd5e v10
export function getOptionalCountRemaining(actor: globalThis.dnd5e.documents.Actor5e, flag: string) {
  const countValue = getProperty(actor, flag);
  if (!countValue) return 1;

  if (["turn", "each-round", "each-turn"].includes(countValue) && game.combat) {
    let usedFlag = flag.replace(".countAlt", ".used");
    usedFlag = flag.replace(".count", ".used");
    // check for the flag
    if (getProperty(actor, usedFlag)) return 0;
  } else if (countValue === "reaction") {
    // return await hasUsedReaction(actor)
    return actor.getFlag("midi-qol", "actions.reactionCombatRound") && needsReactionCheck(actor) ? 0 : 1;
  } else if (countValue === "every") return 1;
  if (Number.isNumeric(countValue)) return countValue;
  if (countValue.startsWith("ItemUses.")) {
    const itemName = countValue.split(".")[1];
    const item = actor.items.getName(itemName);
    return item?.system.uses.value;
  }
  if (countValue.startsWith("@")) {
    let result = getProperty(actor.system, countValue.slice(1))
    return result;
  }
  return 1;
}

//@ts-expect-error dnd5e v10
export async function removeEffectGranting(actor: globalThis.dnd5e.documents.Actor5e, changeKey: string) {
  const effect = actor.effects.find(ef => ef.changes.some(c => c.key.includes(changeKey)))
  if (effect === undefined) return;
  const effectData = effect.toObject();

  const count = effectData.changes.find(c => c.key.includes(changeKey) && c.key.endsWith(".count"));
  const countAlt = effectData.changes.find(c => c.key.includes(changeKey) && c.key.endsWith(".countAlt"));
  if (!count) {
    return actor.deleteEmbeddedDocuments("ActiveEffect", [effect.id], { "expiry-reason": "midi-qol:optionalConsumed" })
  }
  if (Number.isNumeric(count.value) || Number.isNumeric(countAlt?.value)) {
    if (count.value <= 1 || countAlt?.value <= 1)
      return actor.deleteEmbeddedDocuments("ActiveEffect", [effect.id], { "expiry-reason": "midi-qol:optionalConsumed" })
    else if (Number.isNumeric(count.value)) {
      count.value = `${count.value - 1}`; // must be a string
    } else if (Number.isNumeric(countAlt?.value)) {
      countAlt.value = `${countAlt.value - 1}`; // must be a string
    }
    actor.updateEmbeddedDocuments("ActiveEffect", [effectData], { "expiry-reason": "midi-qol:optionalConsumed" })
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
    await item.update({ "system.uses.value": Math.max(0, item.system.uses.value - 1) });
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
    await item.update({ "system.uses.value": Math.max(0, item.system.uses.value - 1) });
  }

  const actorUpdates: any = {};
  if (typeof count.value === "string" && count.value.startsWith("@")) {
    let key = count.value.slice(1);
    if (key.startsWith("system.")) key = key.replace("system.", "")
    // we have an @field to consume
    let charges = getProperty(actor.system, key)
    if (charges) {
      charges -= 1;
      actorUpdates[`system.${key}`] = charges;
    }
  }
  if (typeof countAlt?.value === "string" && countAlt.value.startsWith("@")) {
    let key = countAlt.value.slice(1);
    if (key.startsWith("system.")) key = key.replace("system.", "")
    // we have an @field to consume
    let charges = getProperty(actor.system, key)
    if (charges) {
      charges -= 1;
      actorUpdates[`system.${key}`] = charges;
    }
  }

  if (["turn", "each-round", "each-turn"].includes(count.value)) {
    const flagKey = `${changeKey}.used`.replace("flags.midi-qol.", "");
    actorUpdates[`${changeKey}.used`] = true;
    // await actor.setFlag("midi-qol", flagKey, true);
  }
  if (["turn", "each-round", "each-turn"].includes(countAlt?.value)) {
    const flagKey = `${changeKey}.used`.replace("flags.midi-qol.", "");
    actorUpdates[`${changeKey}.used`] = true;
    // await actor.setFlag("midi-qol", flagKey, true);
  }
  //@ts-expect-error v10 isEmpty
  if (!isEmpty(actorUpdates)) await actor.update(actorUpdates);

  if (count.value === "reaction" || countAlt?.value === "reaction") {
    await setReactionUsed(actor);
  }
}

//@ts-expect-error dnd5e v10
export function hasEffectGranting(actor: globalThis.dnd5e.documents.Actor5e, key: string, selector: string) {
  // Actually check for the flag being set...
  if (getOptionalCountRemainingShortFlag(actor, key) <= 0) return false;
  let changeKey = `${key}.${selector}`;
  // let hasKey = actor.effects.find(ef => ef.changes.some(c => c.key === changeKey) && getOptionalCountRemainingShortFlag(actor, key) > 0)
  let hasKey = getProperty(actor, changeKey);
  if (hasKey !== undefined) return true;
  let allKey = selector.split(".");
  allKey[allKey.length - 1] = "all";
  changeKey = `${key}.${allKey.join(".")}`;
  // return actor.effects.find(ef => ef.changes.some(c => c.key === changeKey) && getOptionalCountRemainingShortFlag(actor, key) > 0)
  hasKey = getProperty(actor, changeKey);
  if (hasKey !== undefined) return hasKey;
  return false;

}
//@ts-expect-error dnd5e
export function isConcentrating(actor: globalThis.dnd5e.documents.Actor5e): undefined | ActiveEffect {
  let concentrationLabel = getConcentrationLabel();
  return actor.effects.contents.find(e => e.name === concentrationLabel && !e.disabled && !e.isSuppressed);
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
  const api = game.modules.get("magic-items-2")?.api;
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

function itemReaction(item, triggerType, maxLevel, onlyZeroCost) {
  if (!item.system.activation?.type?.includes("reaction")) return false;
  if (item.system.activation?.cost > 0 && onlyZeroCost) return false;
  if (item.type === "spell") {
    if (configSettings.ignoreSpellReactionRestriction) return true;
    if (item.system.preparation.mode === "atwill") return true;
    if (item.system.level === 0) return true;
    if (item.system.preparation?.prepared !== true && item.system.preparation?.mode === "prepared") return false;
    if (item.system.preparation.mode !== "innate") return item.system.level <= maxLevel;
  }
  if (item.system.attunement === getSystemCONFIG().attunementTypes.REQUIRED) return false;
  //@ts-expect-error .version
  if (isNewerVersion(game.system.version, "2.3.9")) {
    if (!item._getUsageUpdates({ consumeUsage: item.hasLimitedUses, consumeResource: item.hasResource, slotLevel: false }))
      return false;
  } else {
    if (!item._getUsageUpdates({ consumeRecharge: item.system.recharge?.value, consumeResource: true, consumeSpellLevel: false, consumeUsage: item.system.uses?.max > 0, consumeQuantity: item.type === "consumable" }))
      return false;
  }
  return true;
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
  "reactionattacked": { prompt: "midi-qol.reactionFlavorAttacked", triggerLabel: "isAttacked" },
  "reactionpreattack": { prompt: "midi-qol.reactionFlavorPreAttack", triggerLabel: "preAttack" },
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
    if (checkRule("incapacitated")) {
      try {
        enableNotifications(false);
        if (checkIncapacitated(target, debugEnabled > 0)) return noResult;
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
    let reactionItemList: ReactionItemReference[] = [];
    try {
      let possibleReactions: ReactionItem[] = target.actor.items.filter(item => itemReaction(item, triggerType, maxLevel, usedReaction));
      if (getReactionSetting(player) === "allMI" && !usedReaction) {
        possibleReactions = possibleReactions.concat(await getMagicItemReactions(target.actor, triggerType));
      }
      reactions = possibleReactions.filter(item => {
        const theItem = item instanceof Item ? item : item.baseItem;
        const reactionCondition = getProperty(theItem, "flags.midi-qol.reactionCondition")
        if (reactionCondition) {
          if (debugEnabled > 0) warn(`for ${target.actor?.name} ${theItem.name} using condition ${reactionCondition}`);
          const returnvalue = evalReactionActivationCondition(options.workflow, reactionCondition, target, { extraData: { reaction: reactionTriggerLabelFor(triggerType) } });
          return returnvalue;
        } else {
          if (debugEnabled > 0) warn(`for ${target.actor?.name} ${theItem.name} using ${triggerType} filter`);
          //@ts-expect-error .system
          return theItem.system.activation?.type === triggerType || (triggerType === "reactionhit" && theItem.system.activation?.type === "reaction");
        }
      });

      if (debugEnabled > 0)
        warn(`doReactions ${triggerType} for ${target.actor?.name} ${target.name}`, reactions, possibleReactions);
      reactionItemList = reactions.map(item => {
        if (item instanceof Item) return item.uuid;
        return { "itemName": item.itemName, itemId: item.itemId, "actionName": item.actionName, "img": item.img, "id": item.id, "uuid": item.uuid };
      });
    } catch (err) {
      const message = `midi-qol | fetching reactions`;
      TroubleShooter.recordError(err, message);
    } finally {
      enableNotifications(true);
    }

    // TODO Check this for magic items if that makes it to v10
    if (await asyncHooksCall("midi-qol.ReactionFilter", reactions, options, triggerType, reactionItemList) === false) {
      console.warn("midi-qol | Reaction processing cancelled by Hook");
      return { name: "Filter", ac: 0, uuid: undefined };
    }
    reactionCount = reactionItemList?.length ?? 0;
    if (!usedReaction) {
      //@ts-expect-error .flags
      const midiFlags: any = target.actor.flags["midi-qol"];
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
      player && requestReactions(target, player, triggerTokenUuid, content, triggerType, reactionItemList, resolve, chatMessage, options).then((result) => {
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

export async function requestReactions(target: Token, player: User, triggerTokenUuid: string | undefined, reactionFlavor: string, triggerType: string, reactionItemList: ReactionItemReference[], resolve: ({ }) => void, chatPromptMessage: ChatMessage, options: any = {}) {
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
        reactionItemList
      });
    } else {
      result = await socketlibSocket.executeAsUser("chooseReactions", player.id, {
        tokenUuid: target.document?.uuid ?? target.uuid,
        reactionFlavor,
        triggerTokenUuid,
        triggerType,
        options,
        reactionItemList
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

export async function promptReactions(tokenUuid: string, reactionItemList: ReactionItemReference[], triggerTokenUuid: string | undefined, reactionFlavor: string, triggerType: string, options: any = {}) {
  try {
    const startTime = Date.now();
    const target: Token = MQfromUuid(tokenUuid);
    const actor: Actor | null = target.actor;
    let player = playerFor(getTokenDocument(target));
    if (!actor) return;
    const usedReaction = hasUsedReaction(actor);
    // if ( usedReaction && needsReactionCheck(actor)) return false;
    const midiFlags: any = getProperty(actor, "flags.midi-qol");
    let result;
    let reactionItems: any = [];
    const maxLevel = maxCastLevel(target.actor);
    enableNotifications(false);
    let reactions;
    let reactionCount = 0;
    try {
      enableNotifications(false);
      enableNotifications(false);
      for (let ref of reactionItemList) {
        if (typeof ref === "string") reactionItems.push(await fromUuid(ref));
        else reactionItems.push(ref);
      };
    } finally {
      enableNotifications(true);
    }
    if (reactionItems.length > 0) {
      if (await asyncHooksCall("midi-qol.ReactionFilter", reactionItems, options, triggerType, reactionItemList) === false) {
        console.warn("midi-qol | Reaction processing cancelled by Hook");
        return { name: "Filter" };
      }
      result = await reactionDialog(actor, triggerTokenUuid, reactionItems, reactionFlavor, triggerType, options);
      const endTime = Date.now();
      if (debugEnabled > 0) warn("promptReactions | reaction processing returned after ", endTime - startTime, result)
      if (result.uuid) return result; //TODO look at multiple choices here
    }
    if (usedReaction) return { name: "None" };
    if (!midiFlags) return { name: "None" };
    const bonusFlags = Object.keys(midiFlags?.optional ?? {})
      .filter(flag => {
        if (!midiFlags.optional[flag].ac) return false;
        if (!midiFlags.optional[flag].count) return true;
        return getOptionalCountRemainingShortFlag(actor, flag) > 0;
      }).map(flag => `flags.midi-qol.optional.${flag}`);
    if (bonusFlags.length > 0 && triggerType === "reaction") {
      //@ts-expect-error attributes
      let acRoll = await new Roll(`${actor.system.attributes.ac.value}`).roll({ async: true });
      const data = {
        actor,
        roll: acRoll,
        rollHTML: reactionFlavor,
        rollTotal: acRoll.total,
      }
      //@ts-expect-error attributes
      await bonusDialog.bind(data)(bonusFlags, "ac", true, `${actor.name} - ${i18n("DND5E.AC")} ${actor.system.attributes.ac.value}`, "roll", "rollTotal", "rollHTML")
      const endTime = Date.now();
      if (debugEnabled > 0) warn("promptReactions | returned via bonus dialog ", endTime - startTime)
      return { name: actor.name, uuid: actor.uuid, ac: data.roll.total };
    }
    const endTime = Date.now();
    if (debugEnabled > 0) warn("promptReactions | returned no result ", endTime - startTime)
    return { name: "None" };
  } catch (err) {
    const message = `promptReactions ${tokenUuid} ${triggerType} ${reactionItemList}`;
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
  //@ts-expect-error DOCUMENT_PERMISSION_LEVELS.OWNER v10
  const OWNERSHIP_LEVELS = CONST.DOCUMENT_PERMISSION_LEVELS;
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
export async function reactionDialog(actor: globalThis.dnd5e.documents.Actor5e, triggerTokenUuid: string | undefined, reactionItems: Item[], rollFlavor: string, triggerType: string, options: any = { timeout }) {
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
        const item: any = reactionItems.find(i => i.id === button.key);
        if (item) {
          // await setReactionUsed(actor);
          // No need to set reaction effect since using item will do so.
          dialog.close();
          // options = mergeObject(options.workflowOptions ?? {}, {triggerTokenUuid, checkGMStatus: false}, {overwrite: true});
          const itemRollOptions = mergeObject(options, {
            systemCard: false,
            createWorkflow: true,
            versatile: false,
            configureDialog: true,
            checkGMStatus: false,
            targetUuids: [triggerTokenUuid],
            isReaction: true,
            targetConfirmation: "none"
          });
          let useTimeoutId = setTimeout(() => {
            clearTimeout(useTimeoutId);
            resolve({})
          }, ((timeout) - 1) * 1000);
          let result: any = noResult;
          clearTimeout(useTimeoutId);
          if (item instanceof Item) { // a nomral item}
            result = await completeItemUse(item, {}, itemRollOptions);
            if (!result?.preItemUseComplete) resolve(noResult);
            else resolve({ name: item?.name, uuid: item?.uuid })
          } else { // assume it is a magic item item
            //@ts-expect-error
            const api = game.modules.get("magic-items-2")?.api;
            const magicItemActor = await api?.actor(actor)
            if (magicItemActor) {
              // export type ReactionItemReference = { itemName: string, itemId: string, actionName: string, img: string, id: string, uuid: string } | string;
              const magicItem = magicItemActor.items.find(i => i.id === item.itemId);
              await completeItemUse({ magicItem, id: item.id }, {}, itemRollOptions);
              resolve({ name: item?.itemName, uuid: item?.uuid })

            }
            resolve({ name: item?.itemName, uuid: item?.uuid })
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
        items: reactionItems,
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
    items: any[],
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
    return mergeObject(super.defaultOptions, {
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
    this.data.buttons = this.data.items.reduce((acc: {}, item: any) => {
      acc[randomID()] = {
        icon: `<div class="item-image"> <image src=${item.img} width="50" height="50" style="margin:10px"></div>`,
        label: `${item.name ?? item.actionName}`,
        value: item.name ?? item.actionName,
        key: item.id,
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
      if (!["", "20", 20].includes((getProperty(item, "flags.midi-qol.criticalThreshold") || ""))) {
        report.push(`Actor ${a.name}'s Item ${item.name} has midi critical flag set ${getProperty(item, "flags.midi-qol.criticalThreshold")}`)
      }
    }
  }
  if (game?.scenes) for (let scene of game.scenes) {
    for (let tokenDocument of scene.tokens) { // TODO check this v10
      if (tokenDocument.actor) for (let item of tokenDocument.actor.items.contents) {
        if (!tokenDocument.isLinked && !["", "20", 20].includes((getProperty(item, "flags.midi-qol.criticalThreshold") || ""))) {
          report.push(`Scene ${scene.name}, Token Name ${tokenDocument.name}, Actor Name ${tokenDocument.actor.name}, Item ${item.name} has midi critical flag set ${getProperty(item, "flags.midi-qol.criticalThreshold")}`)
        }
      }
    }
  }
  console.log("Items with midi critical flags set are\n", ...(report.map(s => s + "\n")));
}

export function getConcentrationLabel(): string {
  let concentrationLabel: string = i18n("midi-qol.Concentrating");
  if (installedModules.get("dfreds-convenient-effects")) {
    //@ts-expect-error .dfreds
    const dfreds = game.dfreds;
    concentrationLabel = dfreds.effects._concentrating.name;
  }
  // for condition-lab-trigger there is no module specific way to specify the concentration effect so just use the label
  return concentrationLabel
}
/**
 * 
 * @param actor the actor to check
 * @returns the concentration effect if present and null otherwise
 */
export function getConcentrationEffect(actor): ActiveEffect | undefined {
  let concentrationLabel = getConcentrationLabel();
  const result = actor.effects.find(ef => ef.name === concentrationLabel);
  return result;
}

function mySafeEval(expression: string, sandbox: any, onErrorReturn: any | undefined = undefined) {
  let result;
  try {

    const src = 'with (sandbox) { return ' + expression + '}';
    const evl = new Function('sandbox', src);
    sandbox = mergeObject(sandbox, Roll.MATH_PROXY);
    sandbox = mergeObject(sandbox, { findNearby, checkNearby, hasCondition, checkDefeated, checkIncapacitated });
    result = evl(sandbox);
  } catch (err) {
    const message = `midi-qol | mySafeEval | expression evaluation failed ${expression}`;
    console.warn(message, err)
    TroubleShooter.recordError(err, message);
    result = onErrorReturn;
  }
  if (Number.isNumeric(result)) return Number(result)
  return result;
};

export function evalReactionActivationCondition(workflow: Workflow, condition: string | undefined, target: Token | TokenDocument, options: any = {}): boolean {
  if (options.errorReturn === undefined) options.errorReturn = false
  return evalActivationCondition(workflow, condition, target, options);
}
export function evalActivationCondition(workflow: Workflow, condition: string | undefined, target: Token | TokenDocument, options: any = {}): boolean {
  if (condition === undefined || condition === "") return true;
  createConditionData({ workflow, target, actor: workflow.actor, extraData: options?.extraData, item: options.item });
  const returnValue = evalCondition(condition, workflow.conditionData, options.errorReturn ?? true);
  return returnValue;
}

export function typeOrRace(entity: Token | Actor | TokenDocument | string): string {
  const actor: Actor | null = getActor(entity);
  //@ts-expect-error .system
  const systemData = actor?.system;
  if (!systemData) return "";
  if (systemData.details.type?.value) return systemData.details.type?.value.toLocaleLowerCase() ?? "";
  // cater to dnd5e 2.4+ where race can be a string or an Item
  else return (systemData.details?.race?.name ?? systemData.details?.race)?.toLocaleLowerCase() ?? "";
}

export function raceOrType(entity: Token | Actor | TokenDocument | string): string {
  const actor: Actor | null = getActor(entity);
  //@ts-expect-error .system
  const systemData = actor?.system;
  if (!systemData) return "";
  if (systemData.details.race) return (systemData.details?.race?.name ?? systemData.details?.race)?.toLocaleLowerCase() ?? "";
  return systemData.details.type?.value.toLocaleLowerCase() ?? "";
}

export function effectActivationConditionToUse(workflow: Workflow) {
  let conditionToUse: string | undefined = undefined;
  let conditionFlagToUse: string | undefined = undefined;
  if (getProperty(this, "flags.midi-qol.effectCondition")) {
    return getProperty(this, "flags.midi-qol.effectCondition");
  }
  // This uses the rollOtherDamage setting as a proxy for effect activation
  if (this.type === "spell" && configSettings.rollOtherSpellDamage === "activation") {
    return workflow.otherDamageItem?.system.activation?.condition
  } else if (["rwak", "mwak"].includes(this.system.actionType) && configSettings.rollOtherDamage === "activation") {
    return workflow.otherDamageItem?.system.activation?.condition;
  }
  if (workflow.otherDamageItem?.flags?.midiProperties?.rollOther)
    return workflow.otherDamageItem?.system.activation?.condition;
  return undefined;
}

export function createConditionData(data: { workflow?: Workflow | undefined, target?: Token | TokenDocument | undefined, actor?: Actor | undefined, item?: Item | string | undefined, extraData?: any }) {
  const actor = data.workflow?.actor ?? data.actor;
  let item;
  if (data.item) {
    if (data.item instanceof Item) item = data.item;
    else if (typeof data.item === "string")
      //@ts-expect-error
      item = fromUuidSync(data.item);
  }
  if (!item) item = data.workflow?.item;
  let rollData = data.workflow?.otherDamageItem?.getRollData() ?? item?.getRollData() ?? actor?.getRollData() ?? {};
  rollData = mergeObject(rollData, data.extraData ?? {});
  rollData.isAttuned = rollData.item?.attunement !== getSystemCONFIG().attunementTypes.REQUIRED;

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
      rollData.semidSuperSaver = data.workflow?.semiSuperSavers.has(data.target);
      rollData.target.isHit = data.workflow?.hitTargets.has(data.target);
      rollData.target.isHitEC = data.workflow?.hitTargets.has(data.target);
    }

    rollData.humanoid = globalThis.MidiQOL.humanoid;
    rollData.tokenUuid = data.workflow?.tokenUuid;
    rollData.tokenId = data.workflow?.tokenId;
    rollData.workflow = {};
    rollData.effects = actor?.effects;
    if (data.workflow) {
      Object.assign(rollData.workflow, data.workflow);
      rollData.spellLevel = data.workflow.spellLevel;
      rollData.workflow.otherDamageItem = data.workflow.otherDamageItem?.getRollData().item;
      rollData.workflow.hasSave = data.workflow.hasSave;
      rollData.workflow.saveItem = data.workflow.saveItem?.getRollData().item;
      rollData.workflow.otherDamageFormula = data.workflow.otherDamageFormula;
      rollData.workflow.shouldRollDamage = data.workflow.shouldRollDamage;

      delete rollData.workflow.undoData;
      delete rollData.workflow.conditionData;
    }
    if (data.workflow?.actor) rollData.workflow.actor = data.workflow.actor.getRollData();
    if (data.workflow?.item) rollData.workflow.item = data.workflow.item.getRollData()?.item;
    rollData.CONFIG = CONFIG;
    rollData.CONST = CONST;

  } catch (err) {
    const message = `midi-qol | createConditionData`;
    TroubleShooter.recordError(err, message);
    console.warn(message, err);
  } finally {
    if (data.workflow) data.workflow.conditionData = rollData;
  }
  return rollData;
}

export function evalCondition(condition: string, conditionData: any, errorReturn: any = true): any {
  if (condition === undefined || condition === "") return true;
  if (typeof condition !== "string") return condition;
  let returnValue;
  try {
    if (condition.includes("@")) {
      condition = Roll.replaceFormulaData(condition, conditionData, { missing: "0" });
    }
    returnValue = mySafeEval(condition, conditionData, errorReturn);
    if (debugEnabled > 0) warn("evalActivationCondition ", returnValue, condition, conditionData);

  } catch (err) {
    returnValue = errorReturn;
    const message = `midi-qol | evalActivationCondition | activation condition (${condition}) error `;
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

export function getConvenientEffectsReaction(): ActiveEffect | undefined {
  if (!installedModules.get("dfreds-convenient-effects")) return undefined;
  //@ts-expect-error
  const dfreds = game.dfreds;
  const reactionName = dfreds?.effects?._reaction?.name;
  if (reactionName) {
    const effect = dfreds.effects.all.find(ef => ef.name === reactionName);
    if (effect.flags?.statusId !== undefined) delete effect.flags.statusId;
    return effect;
  }
  return undefined;
}

export function getConvenientEffectsBonusAction(): ActiveEffect | undefined {
  if (!installedModules.get("dfreds-convenient-effects")) return undefined;
  //@ts-expect-error
  const dfreds = game.dfreds;
  const bonusName = dfreds?.effects?._bonusAction.name;
  let result;
  if (bonusName) return dfreds.effects.all.find(ef => ef.name === bonusName);
  return undefined;
}
export function getStatusName(statusId: string | undefined): string {
  if (!statusId) return "undefined";
  const se = CONFIG.statusEffects.find(efData => efData.id === statusId);
  //@ts-expect-error se.name
  return i18n(se?.name ?? se?.label ?? statusId);
}

export function getWoundedStatus(): any | undefined {
  return CONFIG.statusEffects.find(efData => efData.id === configSettings.midiWoundedCondition);
}

export function getUnconsciousStatus(): any | undefined {
  return CONFIG.statusEffects.find(efData => efData.id === configSettings.midiUnconsciousCondition);
}

export function getDeadStatus(): any | undefined {
  return CONFIG.statusEffects.find(efData => efData.id === configSettings.midiDeadCondition);
}

export async function ConvenientEffectsHasEffect(effectName: string, actor: Actor, ignoreInactive: boolean = true) {
  if (ignoreInactive) {
    //@ts-expect-error .dfreds
    return game.dfreds?.effectInterface?.hasEffectApplied(effectName, actor.uuid);
  } else {
    return actor.effects.find(ef => ef.name === effectName) !== undefined;
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
  await actor.setFlag("midi-qol", "actions.action", true);
}

export async function setReactionUsed(actor: Actor) {
  if (!["all", "displayOnly"].includes(configSettings.enforceReactions) && configSettings.enforceReactions !== actor.type) return;
  let effect;
  await actor.setFlag("midi-qol", "actions.reactionCombatRound", game.combat?.round);
  await actor.setFlag("midi-qol", "actions.reaction", true);
  const reactionEffect = getConvenientEffectsReaction();
  if (reactionEffect) {
    //@ts-expect-error .dfreds
    const effectInterface = game.dfreds.effectInterface;
    await effectInterface?.addEffectWith({ effectData: reactionEffect.toObject(), uuid: actor.uuid });
    //@ts-expect-error se.name
  } else if (installedModules.get("condition-lab-triggler") && (effect = CONFIG.statusEffects.find(se => (se.name ?? se.label) === i18n("DND5E.Reaction")))) {
    await actor.createEmbeddedDocuments("ActiveEffect", [effect]);
  }
}

export async function setBonusActionUsed(actor: Actor) {
  if (debugEnabled > 0) warn("setBonusActionUsed | starting");
  if (!["all", "displayOnly"].includes(configSettings.enforceBonusActions) && configSettings.enforceBonusActions !== actor.type) return;
  let effect;
  if (getConvenientEffectsBonusAction()) {
    //@ts-expect-error
    await game.dfreds?.effectInterface?.addEffect({ effectName: getConvenientEffectsBonusAction().name, uuid: actor.uuid });
  } else
    //@ts-expect-error
    if (installedModules.get("condition-lab-triggler") && (effect = CONFIG.statusEffects.find(se => (se.name ?? se.label) === i18n("DND5E.BonusAction")))) {
      await actor.createEmbeddedDocuments("ActiveEffect", [effect]);
    }
  await actor.setFlag("midi-qol", "actions.bonusActionCombatRound", game.combat?.round);
  const result = await actor.setFlag("midi-qol", "actions.bonus", true);
  if (debugEnabled > 0) warn("setBonusActionUsed | finishing");
  return result;
}

export async function removeActionUsed(actor: Actor) {
  if (game.user?.isGM) return await actor?.setFlag("midi-qol", "actions.action", false);
  else return await untimedExecuteAsGM("_gmSetFlag", { base: "midi-qol", key: "actions.action", value: false, actorUuid: actor.uuid })
}

export async function removeReactionUsed(actor: Actor, removeCEEffect = true) {
  let effectRemoved = false;
  if (removeCEEffect && getConvenientEffectsReaction() && !effectRemoved) {
    //@ts-expect-error
    if (await game.dfreds?.effectInterface?.hasEffectApplied(getConvenientEffectsReaction().name, actor.uuid)) {
      const effect = actor.effects.getName(getConvenientEffectsReaction()?.name ?? "Reaction");
      if (installedModules.get("times-up") && effect && getProperty(effect, "flags.dae.specialDuration")?.includes("turnStart")) {
        // times up will handle removing this
      }
      //@ts-expect-error
      else await game.dfreds.effectInterface?.removeEffect({ effectName: getConvenientEffectsReaction().name, uuid: actor.uuid });
      effectRemoved = true;
    }
  }

  if (installedModules.get("condition-lab-triggler") && !effectRemoved) {
    const effect = actor.effects.contents.find(ef => ef.name === i18n("DND5E.Reaction"));
    if (installedModules.get("times-up") && effect && getProperty(effect, "flags.dae.specialDuration")?.includes("turnStart")) {
    } else await effect?.delete();
    // times-up will handle removing this
    effectRemoved = true;
  }
  await actor?.unsetFlag("midi-qol", "actions.reactionCombatRound");
  return actor?.setFlag("midi-qol", "actions.reaction", false);
}

export function hasUsedAction(actor: Actor) {
  return actor?.getFlag("midi-qol", "actions.action")
}

export function hasUsedReaction(actor: Actor) {
  if (getConvenientEffectsReaction()) {
    //@ts-expect-error .dfreds
    if (game.dfreds?.effectInterface?.hasEffectApplied(getConvenientEffectsReaction().name, actor.uuid)) {
      return true;
    }
  }

  if (installedModules.get("condition-lab-triggler") && actor.effects.contents.some(ef => ef.name === i18n("DND5E.Reaction"))) {
    return true;
  }
  if (actor.getFlag("midi-qol", "actions.reaction")) return true;
  return false;
}


export async function expirePerTurnBonusActions(combat: Combat, data, options) {
  const optionalFlagRe = /flags.midi-qol.optional.[^.]+.(count|countAlt)$/;
  for (let combatant of combat.turns) {
    const actor = combatant.actor;
    if (!actor) continue;
    for (let effect of actor.effects) {
      //@ts-expect-error .changes
      for (let change of effect.changes) {
        if (change.key.match(optionalFlagRe)
          && ((change.value === "each-turn") || (change.value = "each-round" && data.round !== combat.round))) {
          const usedKey = change.key.replace(/.(count|countAlt)$/, ".used")
          const isUsed = getProperty(actor, usedKey);
          if (isUsed) {
            const key = usedKey.replace("flags.midi-qol.", "");
            //TODO turn this into actor updates instead of each flag
            await untimedExecuteAsGM("_gmUnsetFlag", { actorUuid: actor.uuid, base: "midi-qol", key });
          }
        }
      }
    }
  }
}

export function hasUsedBonusAction(actor: Actor) {
  if (getConvenientEffectsBonusAction()) {
    //@ts-expect-error
    if (game.dfreds?.effectInterface?.hasEffectApplied(getConvenientEffectsBonusAction().name, actor.uuid)) {
      return true;
    }
  }

  if (installedModules.get("condition-lab-triggler") && actor.effects.contents.some(ef => ef.name === i18n("DND5E.BonusAction"))) {
    return true;
  }

  if (actor.getFlag("midi-qol", "actions.bonus")) return true;
  return false;
}

export async function removeBonusActionUsed(actor: Actor, removeCEEffect = false) {
  if (removeCEEffect && getConvenientEffectsBonusAction()) {
    //@ts-expect-error
    if (await game.dfreds?.effectInterface?.hasEffectApplied((getConvenientEffectsBonusAction().name), actor.uuid)) {
      //@ts-expect-error
      await game.dfreds.effectInterface?.removeEffect({ effectName: (getConvenientEffectsBonusAction().name), uuid: actor.uuid });
    }
  }
  if (installedModules.get("condition-lab-triggler")) {
    const effect = actor.effects.contents.find(ef => ef.name === i18n("DND5E.BonusAction"));
    await effect?.delete();
  }
  await actor.setFlag("midi-qol", "actions.bonus", false);
  return actor?.unsetFlag("midi-qol", "actions.bonusActionCombatRound");
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

export function addAdvAttribution(html: any, advAttribution: Set<string>) {
  // <section class="tooltip-part">
  let advHtml: string = "";
  if (advAttribution && advAttribution.size > 0) {
    advHtml = Array.from(advAttribution).reduce((prev, s) => prev += `${s}<br>`, "");
    html = html.replace(`<section class="tooltip-part">`, `<section class="tooltip-part">${advHtml}`);
  }
  return html;
}

export async function midiRenderRoll(roll: Roll | undefined) {
  if (!roll) return "";
  switch (configSettings.rollAlternate) {
    case "formula":
    case "formulaadv": return roll.render({ template: "modules/midi-qol/templates/rollAlternate.html" });
    case "adv":
    case "off":
    default: return roll.render(); // "off"
  }
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
  let gridW = canvas?.grid?.w ?? 100;
  let gridH = canvas?.grid?.h ?? 100;
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
      //@ts-expect-error
      const CEFlanked = game.dfreds.effects._flanked;
      //@ts-expect-error
      const hasFlanked = token.actor && CEFlanked && await game.dfreds.effectInterface?.hasEffectApplied(CEFlanked.name, token.actor.uuid);
      if (hasFlanked) continue;
    }
    // Loop through each square covered by attacker and ally
    const tokenStartX = token.document.width >= 1 ? 0.5 : token.document.width / 2;
    const tokenStartY = token.document.height >= 1 ? 0.5 : token.document.height / 2;
    for (let ally of allies) {
      if (ally.document.uuid === token.document.uuid) continue;
      const actor: any = ally.actor;
      if (actor?.system.attrbutes?.hp?.value <= 0) continue;
      if (!heightIntersects(target.document, ally.document)) continue;
      if (installedModules.get("dfreds-convenient-effects")) {
        //@ts-expect-error
        if (actor?.effects.some(ef => ef.name === game.dfreds.effects._incapacitated.name)) continue;
      }
      if (checkRule("checkFlanking") === "ceflankedNoconga" && installedModules.get("dfreds-convenient-effects")) {
        //@ts-expect-error
        const CEFlanked = game.dfreds.effects._flanked;
        //@ts-expect-error
        const hasFlanked = CEFlanked && await game.dfreds.effectInterface?.hasEffectApplied(CEFlanked.name, ally.actor.uuid);
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
  if (getDistance(token, target, true) > range * (canvas?.dimensions?.distance ?? 5)) return false;
  // an enemy's enemies are my friends.
  const allies: any /* Token v10 */[] = findPotentialFlankers(target)

  if (!token.document.disposition) return false; // Neutral tokens can't get flanking
  if (allies.length <= 1) return false; // length 1 means no other allies nearby

  let gridW = canvas?.grid?.w ?? 100;
  let gridH = canvas?.grid?.h ?? 100;
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
    if (checkIncapacitated(ally, debugEnabled > 0)) continue;
    if (installedModules.get("dfreds-convenient-effects")) {
      //@ts-expect-error
      if (actor?.effects.some(ef => ef.name === game.dfreds.effects._incapacitated.name)) continue;
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
  return false;
}


export async function markFlanking(token, target): Promise<boolean> {
  // checkFlankingStatus requires a flanking token (token) and a target
  // checkFlankedStatus requires only a target token
  if (!canvas) return false;
  let needsFlanking = false;
  if (!target || !checkRule("checkFlanking") || checkRule["checkFlanking"] === "off") return false;
  if (["ceonly", "ceadv"].includes(checkRule("checkFlanking"))) {
    if (!token) return false;
    needsFlanking = computeFlankingStatus(token, target);
    if (installedModules.get("dfreds-convenient-effects")) {
      //@ts-expect-error
      const CEFlanking = game.dfreds.effects._flanking;
      if (!CEFlanking) return needsFlanking;
      //@ts-expect-error
      const hasFlanking = token.actor && await game.dfreds.effectInterface?.hasEffectApplied(CEFlanking.name, token.actor.uuid)
      if (needsFlanking && !hasFlanking && token.actor) {
        //@ts-expect-error
        await game.dfreds.effectInterface?.addEffect({ effectName: CEFlanking.name, uuid: token.actor.uuid });
      } else if (!needsFlanking && hasFlanking && token.actor) {
        //@ts-expect-error
        await game.dfreds.effectInterface?.removeEffect({ effectName: CEFlanking.name, uuid: token.actor.uuid });
      }
    }
  } else if (checkRule("checkFlanking") === "advonly") {
    if (!token) return false;
    needsFlanking = computeFlankingStatus(token, target);
  } else if (["ceflanked", "ceflankedNoconga"].includes(checkRule("checkFlanking"))) {
    if (!target.actor) return false;
    if (installedModules.get("dfreds-convenient-effects")) {
      //@ts-expect-error
      const CEFlanked = game.dfreds.effects._flanked;
      if (!CEFlanked) return false;
      const needsFlanked = await computeFlankedStatus(target);
      //@ts-expect-error
      const hasFlanked = target.actor && await game.dfreds.effectInterface?.hasEffectApplied(CEFlanked.name, target.actor.uuid);
      if (needsFlanked && !hasFlanked && target.actor) {
        //@ts-expect-error
        await game.dfreds.effectInterface?.addEffect({ effectName: CEFlanked.name, uuid: target.actor.uuid });
      } else if (!needsFlanked && hasFlanked && token.actor) {
        //@ts-expect-error
        await game.dfreds.effectInterface?.removeEffect({ effectName: CEFlanked.name, uuid: target.actor.uuid });
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
  return actorOrItem.effects.contents
    .flat()
    .map(e => {
      let c = duplicate(e.changes);
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

export function _canSenseModes(tokenEntity: Token | TokenDocument, targetEntity: Token | TokenDocument, validModesParam: Array<string> = ["all"]): Array<string> {
  //@ts-expect-error
  let target: Token = targetEntity instanceof TokenDocument ? targetEntity.object : targetEntity;
  //@ts-expect-error detectionModes
  const detectionModes = CONFIG.Canvas.detectionModes;
  //@ts-expect-error DetectionMode
  const DetectionModeCONST = DetectionMode;
  //@ts-expect-error
  let token: Token = tokenEntity instanceof TokenDocument ? tokenEntity.object : tokenEntity;
  if (!token || !target) return ["noToken"];
  //@ts-expect-error .hidden
  if (target.document?.hidden || token.document?.hidden) return [];
  if (!token.hasSight && !configSettings.optionalRules.invisVision) return ["senseAll"];
  for (let tk of [token]) {
    //@ts-expect-error
    if (!tk.document.sight.enabled || !token.vision.active) {
      //@ts-expect-error
      tk.document.sight.enabled = true;
      //@ts-expect-error
      tk.document._prepareDetectionModes();
      const sourceId = tk.sourceId;
      tk.vision.initialize({
        x: tk.center.x,
        y: tk.center.y,
        //@ts-expect-error
        radius: Math.clamped(tk.sightRange, 0, canvas?.dimensions?.maxR ?? 0),
        //@ts-expect-error
        externalRadius: Math.max(tk.mesh.width, tk.mesh.height) / 2,
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
        error(`canSense los not calcluated. Can't check if ${token.name} can see ${target.name}`, token.vision);
        return ["noSight"];
      } else if (!tk.vision.los) {
        //@ts-expect-error
        tk.vision.shape = token.vision._createRestrictedPolygon();
        //@ts-expect-error
        tk.vision.los = token.vision.shape;
      }
      //@ts-expect-error
      tk.vision.anmimated = false;
      //@ts-expect-error
      canvas?.effects?.visionSources.set(sourceId, tk.vision);
      //@ts-expect-error
      tk.document.sight.enabled = false;
    }
  }

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

  // First test basic detection for light sources which specifically provide vision
  //@ts-expect-error
  for (const lightSource of canvas?.effects?.lightSources.values() ?? []) {
    if (/*!lightSource.data.vision ||*/ !lightSource.active || lightSource.disabled) continue;
    if (!validModes.has(detectionModes.lightPerception?.id ?? DetectionModeCONST.BASIC_MODE_ID) && !validModes.has("all")) continue;
    const result = lightSource.testVisibility(config);
    if (result === true) matchedModes.add(detectionModes.lightPerception?.id ?? DetectionModeCONST.BASIC_MODE_ID);
  }

  const basic = tokenDetectionModes.find(m => m.id === DetectionModeCONST.BASIC_MODE_ID);
  if (basic /*&& token.vision.active*/) {
    if (["basicSight", "lightPerception", "all"].some(mode => validModes.has(mode))) {
      const result = modes.basicSight.testVisibility(token.vision, basic, config);
      if (result === true) matchedModes.add(detectionModes.lightPerception?.id ?? DetectionModeCONST.BASIC_MODE_ID);
    }
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

export function getSystemCONFIG(): any {
  switch (game.system.id) {
    //@ts-expect-error .
    case "dnd5e": return CONFIG.DND5E;
    //@ts-expect-error .
    case "sw5e": return { ...CONFIG.SW5E, skills: { ...CONFIG.SW5E.skills, ...CONFIG.SW5E.starshipSkills } };
    //@ts-expect-error .
    case "n5e": return CONFIG.N5E;
    default: return {};
  }
}

export function tokenForActor(actorRef: Actor | string): Token | undefined {
  let actor: Actor;
  if (!actorRef) return undefined
  // if (actor.token) return actor.token;
  if (typeof actorRef === "string") actor = MQfromActorUuid(actorRef);
  else actor = actorRef;
  //@ts-expect-error getActiveTokens returns an array of tokens not tokenDocuments
  const tokens: Token[] = actor.getActiveTokens();
  if (!tokens.length) return undefined;
  //@ts-expect-error .controlled
  const controlled = tokens.filter(t => t.controlled);
  return controlled.length ? controlled.shift() : tokens.shift();
}

export async function doConcentrationCheck(actor, saveDC) {
  const itemData = duplicate(itemJSONData);
  setProperty(itemData, "system.save.dc", saveDC);
  setProperty(itemData, "system.save.ability", "con");
  setProperty(itemData, "system.save.scaling", "flat");
  setProperty(itemData, "name", concentrationCheckItemDisplayName);
  setProperty(itemData, "system.target.type", "self");
  setProperty(itemData, "flags.midi-qol.noProvokeReaction", true);
  return await _doConcentrationCheck(actor, itemData)
}

async function _doConcentrationCheck(actor, itemData) {
  let result;
  // actor took damage and is concentrating....
  const saveTargets = game.user?.targets;
  const theTargetToken = getSelfTarget(actor);
  const theTarget = theTargetToken?.document.id;
  if (game.user && theTarget) game.user.updateTokenTargets([theTarget]);
  let ownedItem: Item = new CONFIG.Item.documentClass(itemData, { parent: actor })
  if (configSettings.displaySaveDC) {
    //@ts-expect-error 
    ownedItem.getSaveDC()
  }
  try {
    result = await completeItemUse(ownedItem, {}, { checkGMStatus: true, systemCard: false, createWorkflow: true, versatile: false, configureDialog: false, workflowOptions: { targetConfirmation: "none" } })
  } catch (err) {
    const message = "midi-qol | doConcentrationCheck";
    TroubleShooter.recordError(err, message);
    console.warn(message, err);
  } finally {
    if (saveTargets && game.user) game.user.targets = saveTargets;
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


export async function displayDSNForRoll(roll: Roll | undefined, rollType: string | undefined, defaultRollMode: string | undefined = undefined) {
  if (!roll) return;
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
                roll.dice[i].results.forEach(r => setProperty(r, "hidden", true));
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
      //@ts-expect-error
      let displayRoll = Roll.fromData(roll.toJSON()); // make a copy of the roll
      if (game.user?.isGM && configSettings.addFakeDice) {
        for (let term of displayRoll.terms) {
          if (term instanceof Die) {
            // for attack rolls only add a d20 if only one was rolled - else it becomes clear what is happening
            if (["attackRoll", "attackRollD20"].includes(rollType ?? "") && term.faces === 20 && term.number !== 1) continue;
            let numExtra = Math.ceil(term.number * Math.random());
            let extraDice = new Die({ faces: term.faces, number: numExtra }).evaluate();
            term.number += numExtra;
            term.results = term.results.concat(extraDice.results);
          }
        }
      }
      displayRoll.terms.forEach(term => {
        if (term.options?.flavor) term.options.flavor = term.options.flavor.toLocaleLowerCase();
      });
      if (ghostRoll) {
        const promises: Promise<any>[] = [];
        promises.push(dice3d?.showForRoll(displayRoll, game.user, true, ChatMessage.getWhisperRecipients("GM"), !game.user?.isGM));
        if (game.settings.get("dice-so-nice", "showGhostDice")) {
          //@ts-expect-error .ghost
          displayRoll.ghost = true;
          promises.push(dice3d?.showForRoll(displayRoll, game.user, true, game.users?.players.map(u => u.id), game.user?.isGM));
        }
        await Promise.allSettled(promises);
      } else
        await dice3d?.showForRoll(displayRoll, game.user, true, whisperIds, rollMode === "blindroll" && !game.user?.isGM)
    }
  }
  //mark all dice as shown - so that toMessage does not trigger additional display on other clients
  roll.dice.forEach(d => d.results.forEach(r => setProperty(r, "hidden", true)));
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
  if (getProperty(target.actor, "flags.midi-qol.neverTarget")) return false;

  const targetDocument = getTokenDocument(target);
  //@ts-expect-error hiddien
  if (targetDocument?.hidden) return false;
  if (getProperty(target.actor, "system.details.type.custom")?.toLocaleLowerCase().includes("notarget")) {
    console.warn("midi-qol | system.type.custom === 'notarget' is deprecated in favour or flags.midi-qol.neverTarget = true")
    return false;
  }
  if (getProperty(target.actor, "actor.system.details.race")?.toLocaleLowerCase().includes("notarget")) {
    console.warn("midi-qol | system.details.race === 'notarget' is deprecated in favour or flags.midi-qol.neverTarget = true")
    return false;
  }
  if (getProperty(target.actor, "actor.system.details.race")?.toLocaleLowerCase().includes("trigger")) {
    console.warn("midi-qol | system.details.race === 'trigger' is deprecated in favour or flags.midi-qol.neverTarget = true")
    return false;
  }
  return true;
}

export function hasWallBlockingCondition(target: any /*Token*/): boolean {
  return globalThis.MidiQOL.WallsBlockConditions.some(cond => hasCondition(target, cond));
}

function contestedRollFlavor(baseFlavor: string | undefined, rollType: string, ability: string): string {
  const config = getSystemCONFIG();
  let flavor;
  let title;
  if (rollType === "test" || rollType === "abil") {
    const label = config.abilities[ability]?.label ?? ability;
    flavor = game.i18n.format("DND5E.AbilityPromptTitle", { ability: label });
  } else if (rollType === "save") {
    const label = config.abilities[ability].label;
    flavor = game.i18n.format("DND5E.SavePromptTitle", { ability: label });
  } else if (rollType === "skill") {
    flavor = game.i18n.format("DND5E.SkillPromptTitle", { skill: config.skills[ability]?.label ?? "" });
  }
  return `${baseFlavor ?? i18n("midi-qol.ContestedRoll")} ${flavor}`;
}
export function validRollAbility(rollType: string, ability: string): string | undefined {
  const config = getSystemCONFIG();
  if (typeof ability !== "string") return undefined;
  ability = ability.toLocaleLowerCase().trim();
  switch (rollType) {
    case "test":
    case "abil":
    case "save":
      if (config.abilities[ability]) return ability;
      return Object.keys(config.abilities).find(abl => config.abilities[abl].label.toLocaleLowerCase() === ability.trim().toLocaleLowerCase())
    case "skill":
      if (config.skills[ability]) return ability;
      return Object.keys(config.skills).find(skl => config.skills[skl].label.toLocaleLowerCase() === ability.trim().toLocaleLowerCase())
    default: return undefined;
  }
}
export async function contestedRoll(data: {
  source: { rollType: string, ability: string, token: Token | TokenDocument | string, rollOptions: any },
  target: { rollType: string, ability: string, token: Token | TokenDocument | string, rollOptions: any },
  displayResults: boolean,
  itemCardId: string,
  flavor: string,
  rollOptions: any,
  success: (results) => {}, failure: (results) => {}, drawn: (results) => {}
}): Promise<{ result: number | undefined, rolls: any[] }> {
  const source = data.source;
  const target = data.target;
  const sourceToken = getToken(source?.token);
  const targetToken = getToken(target?.token);
  const { rollOptions, success, failure, drawn, displayResults, itemCardId, flavor } = data;

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
  const sourceOptions = mergeObject(duplicate(source.rollOptions ?? rollOptions ?? {}), {
    mapKeys: false,
    flavor: sourceFlavor,
    title: `${sourceFlavor}: ${sourceToken?.name} vs ${targetToken?.name}`
  });
  const targetFlavor = contestedRollFlavor(flavor, target.rollType, target.ability);
  const targetOptions = mergeObject(duplicate(target.rollOptions ?? rollOptions ?? {}), {
    mapKeys: false,
    flavor: targetFlavor,
    title: `${targetFlavor}: ${targetToken?.name} vs ${sourceToken?.name}`
  });
  const resultPromises = [
    socketlibSocket.executeAsUser("rollAbility", player1.id, { request: source.rollType.trim(), targetUuid: sourceDocument?.uuid, ability: source.ability.trim(), options: sourceOptions }),
    socketlibSocket.executeAsUser("rollAbility", player2.id, { request: target.rollType.trim(), targetUuid: targetDocument?.uuid, ability: target.ability.trim(), options: targetOptions }),
  ];

  let results = await Promise.all(resultPromises);
  let result: number | undefined = results[0].total - results[1].total;
  if (isNaN(result)) result = undefined;
  if (displayResults !== false) {
    let resultString;
    if (result === undefined) resultString = "";
    else resultString = result > 0 ? i18n("midi-qol.save-success") : result < 0 ? i18n("midi-qol.save-failure") : result === 0 ? i18n("midi-qol.save-drawn") : "no result"
    const skippedString = i18n("midi-qol.Skipped");
    const content = `${flavor ?? i18n("miidi-qol:ContestedRoll")} ${resultString} ${results[0].total ?? skippedString} ${i18n("midi-qol.versus")} ${results[1].total ?? skippedString}`;
    displayContestedResults(itemCardId, content, ChatMessage.getSpeaker({ token: sourceToken }), flavor);
  }

  if (result === undefined) return { result, rolls: results };
  if (result > 0 && success) success(results);
  else if (result < 0 && failure) failure(results);
  else if (result === 0 && drawn) drawn(results)
  return { result, rolls: results };
}

function displayContestedResults(chatCardId: string | undefined, resultContent: string, speaker, flavor: string | undefined) {
  let itemCard = game.messages?.get(chatCardId ?? "");
  if (itemCard && configSettings.mergeCard) {
    //@ts-expect-error content
    let content = duplicate(itemCard.content ?? "")
    const searchRE = /<div class="midi-qol-saves-display">[\s\S]*?<div class="end-midi-qol-saves-display">/;
    const replaceString = `<div class="midi-qol-saves-display">${resultContent}<div class="end-midi-qol-saves-display">`;
    content = content.replace(searchRE, replaceString);
    itemCard.update({ "content": content });
  } else {
    // const title = `${flavor ?? i18n("miidi-qol:ContestedRoll")} results`;
    ChatMessage.create({ content: `<p>${resultContent}</p>`, speaker });
  }
}

export function getActor(actorRef: Actor | Token | TokenDocument | string): Actor | null {
  if (actorRef instanceof Actor) return actorRef;
  if (actorRef instanceof Token) return actorRef.actor;
  if (actorRef instanceof TokenDocument) return actorRef.actor;
  if (typeof actorRef === "string") return MQfromActorUuid(actorRef);
  return null;
}

export function getTokenDocument(tokenRef: Actor | Token | TokenDocument | string | undefined): TokenDocument | undefined {
  if (!tokenRef) return undefined;
  if (tokenRef instanceof TokenDocument) return tokenRef;
  if (typeof tokenRef === "string") {
    const document = MQfromUuid(tokenRef);
    if (document instanceof TokenDocument) return document;
    if (document instanceof Actor) return tokenForActor(document)?.document;
  }
  if (tokenRef instanceof Token) return tokenRef.document;
  if (tokenRef instanceof Actor) return tokenForActor(tokenRef)?.document;
  return undefined;
}

export function getToken(tokenRef: Actor | Token | TokenDocument | string | undefined): Token | undefined {
  if (!tokenRef) return undefined;
  if (tokenRef instanceof Token) return tokenRef;
  //@ts-expect-error return cast
  if (tokenRef instanceof TokenDocument) return tokenRef.object;
  if (typeof tokenRef === "string") {
    const entity = MQfromUuid(tokenRef);
    //@ts-expect-error return cast
    if (entity instanceof TokenDocument) return entity.object;
    if (entity instanceof Actor) return tokenForActor(entity);
    return undefined;
  }
  if (tokenRef instanceof Actor) return tokenForActor(tokenRef);
  return undefined;
}

export function calcTokenCover(attacker: Token | TokenDocument, target: Token | TokenDocument): number {
  const attackerToken = getToken(attacker);
  const targetToken = getToken(target);

  //@ts-expect-error .coverCalc
  const coverCalc = attackerToken.tokencover?.coverCalc;
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

  return coverCalc.percentCover(targetToken) ?? 0;
}

export function itemRequiresConcentration(item): boolean {
  if (!item) return false;
  if (item.system.activation?.condition?.toLocaleLowerCase().includes(i18n("midi-qol.concentrationActivationCondition").toLocaleLowerCase())) {
    console.warn("midi-qol | itemRequiresConcentration | concentration activation condition deprecated use concentration component/midiProperty");
  }
  return item.system.components?.concentration
    || item.flags.midiProperties?.concentration
    || item.system.porperties?.concentration // for the future case of dnd5e 2.x
    || item.system.activation?.condition?.toLocaleLowerCase().includes(i18n("midi-qol.concentrationActivationCondition").toLocaleLowerCase());
}

const MaxNameLength = 20;
export function getLinkText(entity: Token | TokenDocument | Actor | Item | null | undefined) {
  if (!entity) return "<unknown>";
  let name = entity.name ?? "unknown";
  if (entity instanceof Token && !configSettings.useTokenNames) name = entity.actor?.name ?? name;
  if (entity instanceof Token) return `@UUID[${entity.document.uuid}]{${name.slice(0, MaxNameLength - 5)}}`;
  return `@UUID[${entity.uuid}]{${entity.name?.slice(0, MaxNameLength - 5)}}`;
}

export function getIconFreeLink(entity: Token | TokenDocument | Item | Actor | null | undefined) {
  if (!entity) return "<unknown>";
  let name = entity.name ?? "unknown";
  if (entity instanceof Token && !configSettings.useTokenNames) name = entity.actor?.name ?? name;
  if (entity instanceof Token) {
    return `<a class="content-link midi-qol" data-uuid="${entity.actor?.uuid}">${name?.slice(0, MaxNameLength)}</a>`;
  } else {
    return `<a class="content-link midi-qol" data-uuid="${entity.uuid}">${name?.slice(0, MaxNameLength)}</a>`
  }
}

export function midiMeasureDistances(segments, options: any = {}) {

  //@ts-expect-error .grid
  if (canvas?.grid?.grid.constructor.name !== "BaseGrid" || !options.gridSpaces || !configSettings.griddedGridless) {
    const distances = canvas?.grid?.measureDistances(segments, options);
    if (!configSettings.gridlessFudge) return distances; // TODO consider other impacts of doing this
    return distances;
    return distances?.map(d => Math.max(0, d - configSettings.gridlessFudge));
  }

  //@ts-expect-error .diagonalRule
  const rule = canvas?.grid.diagonalRule;

  if (!configSettings.gridlessFudge || !options.gridSpaces || !["555", "5105", "EUCL"].includes(rule))
    return canvas?.grid?.measureDistances(segments, options);

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

export function getAutoTarget(item: Item): string {
  if (!item) return configSettings.autoTarget;
  const midiFlags = getProperty(item, "flags.midi-qol");
  const autoTarget = midiFlags.autoTarget;
  if (!autoTarget || autoTarget === "default") return configSettings.autoTarget;
  return autoTarget;
}
export function hasAutoPlaceTemplate(item) {
  return item && item.hasAreaTarget && ["self"].includes(item.system.range?.units) && ["radius", "squareRadius"].includes(item.system.target.type);
}

export function itemOtherFormula(item): string {
  if (item?.type === "weapon" && !item?.system.properties?.ver && ((item.system.formula ?? "") === ""))
    return item?.system.damage.versatile ?? "";
  return item?.system.formula ?? "";
}
export function addRollTo(roll: Roll, bonusRoll: Roll): Roll {
  if (!bonusRoll) return roll;
  if (!roll) return bonusRoll;
  //@ts-expect-error _evaluated
  if (!roll._evaluated) roll = roll.clone().evaluate({async: false});
  //@ts-expect-error _evaluate
  if (!bonusRoll.evaluated) bonusRoll = bonusRoll.clone().evaluate({async: false})
  let terms;
  if (bonusRoll.terms[0] instanceof OperatorTerm) {
    terms = roll.terms.concat(bonusRoll.terms);
  } else {
    const operatorTerm = new OperatorTerm({ operator: "+" });
    //@ts-expect-error _evaluated
    operatorTerm._evaluated = true;
    terms = roll.terms.concat([operatorTerm]);
    terms = terms.concat(bonusRoll.terms);
  }
  let newRoll = Roll.fromTerms(terms)
  return newRoll;
}

export async function chooseEffect({ speaker, actor, token, character, item, args, scope, workflow, options }) {

  let second1TimeoutId;
  let timeRemaining;
  if (!item) return false;
  const effects = item.effects.filter(e => !e.transfer && getProperty(e, "flags.dae.dontApply") === true);
  if (effects.length === 0) {
    if (debugEnabled > 0) warn(`chooseEffect | no effects found for ${item.name}`);
    return false;
  }

  let targets = workflow.applicationTargets;
  if (!targets || targets.size === 0) return;
  let returnValue = new Promise((resolve, reject) => {
    const callback = async function (dialog, html, event) {
      clearTimeout(timeoutId);
      const effectData = this.toObject();
      effectData.origin = item.uuid;
      if (this.toObject()) {
        if (this.debugEnabled) warn(`chooseEffect | applying effect ${this.name} to ${targets.size} targets`, targets)
        for (let target of targets) {
          await target.actor.createEmbeddedDocuments("ActiveEffect", [effectData])
        }
      }
      resolve(this);
    }
    let buttons = {};
    for (let effect of effects) {
      buttons[effect.id] = {
        label: effect.name,
        callback: callback.bind(effect),
        icon: `<div class="item-image"> <image src=${effect.img} width="50" height="50" style="margin:10px"></div>`,
      };
    }
    let timeout = (options?.timeout ?? configSettings.reactionTimeout ?? defaultTimeout);
    timeRemaining = timeout;
    let dialog = new Dialog({
      title: `${i18n("CONTROLS.CommonSelect")} ${i18n("DOCUMENT.ActiveEffect")}: ${timeRemaining}s`,
      content: `${i18n("EFFECT.StatusTarget")}: [${[...targets].map(t => t.name)}]`,
      buttons,
      close: () => { clearTimeout(timeoutId); clearTimeout(second1TimeoutId); },
      default: ''
    });
    dialog.render(true);
    const set1SecondTimeout = function () {
      second1TimeoutId = setTimeout(() => {
        if (!timeoutId) return;
        timeRemaining -= 1;
        dialog.data.title = `${i18n("CONTROLS.CommonSelect")} ${i18n("DOCUMENT.ActiveEffect")}: ${timeRemaining}s`;
        dialog.render(false);
        if (timeRemaining > 0) set1SecondTimeout();
      }, 1000)
    }
    let timeoutId = setTimeout(() => {
      if (debugEnabled > 0) warn(`chooseEffect | timeout fired closing dialog`);
      clearTimeout(second1TimeoutId);
      dialog.close();
      reject("timeout");
    }, timeout * 1000);
    set1SecondTimeout();
  })
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
      NON_SIGHT_CONSIDERED_SIGHT.includes[d]
  );
  return canSense(tokenEntity, targetEntity, sightDetectionModes);
}
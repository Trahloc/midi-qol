import { log, debug, i18n, error, i18nFormat, warn, debugEnabled } from "../midi-qol.js";
import { doAttackRoll, doDamageRoll, templateTokens, doItemUse, wrappedDisplayCard } from "./itemhandling.js";
import { configSettings, autoFastForwardAbilityRolls, checkRule, checkMechanic } from "./settings.js";
import { bonusDialog, checkDefeated, checkIncapacitated, ConvenientEffectsHasEffect, createConditionData, displayDSNForRoll, evalCondition, expireRollEffect, getAutoTarget, getConcentrationEffect, getCriticalDamage, getDeadStatus, getOptionalCountRemainingShortFlag, getSelfTarget, getSpeaker, getSystemCONFIG, getUnconsciousStatus, getWoundedStatus, hasAutoPlaceTemplate, hasCondition, hasUsedAction, hasUsedBonusAction, hasUsedReaction, mergeKeyboardOptions, midiRenderRoll, MQfromActorUuid, MQfromUuid, notificationNotify, processOverTime, removeActionUsed, removeBonusActionUsed, removeReactionUsed, tokenForActor } from "./utils.js";
import { installedModules } from "./setupModules.js";
import { OnUseMacro, OnUseMacros } from "./apps/Item.js";
import { mapSpeedKeys } from "./MidiKeyManager.js";
import { socketlibSocket, untimedExecuteAsGM } from "./GMAction.js";
import { TroubleShooter } from "./apps/TroubleShooter.js";
import { busyWait } from "./tests/setupTest.js";
let libWrapper;

var d20Roll;

function _isVisionSource(wrapped) {
  const isVisionSource = wrapped();
  if (this.document.hidden && !game.user?.isGM && this.actor?.testUserPermission(game.user, "OWNER")) {
    return true;
  }
  return isVisionSource;
}

function isVisible(wrapped) {
  const isVisible = wrapped();
  //@ts-ignore
  if (!game.user.isGM && this.actor?.testUserPermission(game.user, "OWNER")) {
    return true;
  }
  return isVisible;
}

export interface Options {
  event: any,
  advantage: boolean | undefined,
  disadvantage: boolean | undefined,
  fastForward: boolean | undefined,
  fastForwardSet: boolean | undefined,
  parts: [] | undefined,
  chatMessage: boolean | undefined,
  rollToggle: boolean | undefined,
  other: boolean | undefined,
  versatile: boolean | undefined,
  critical: boolean | undefined,
  autoRollAttack: boolean | undefined,
  autoRollDamage: boolean | undefined,
  fastForwardAttack: boolean | undefined,
  fastForwardDamage: boolean | undefined,
  fastForwardAbility: boolean | undefined,
  isMagicSave?: boolean,
  saveItemUuid?: string,
  saveItem?: Item,
  item?: Item,
  itemUuid?: string,
  simulate?: boolean,
  target?: number,
  rollType?: string
};
export const defaultRollOptions: Options = {
  event: undefined,
  advantage: false,
  disadvantage: false,
  fastForward: false,
  fastForwardSet: false,
  parts: undefined,
  chatMessage: undefined,
  rollToggle: undefined,
  other: undefined,
  versatile: false,
  critical: false,
  autoRollAttack: false,
  autoRollDamage: false,
  fastForwardAttack: false,
  fastForwardDamage: false,
  fastForwardAbility: false
};

export function collectBonusFlags(actor, category, detail): any[] {
  if (!installedModules.get("betterrolls5e")) {
    let useDetail = false;
    const bonusFlags = Object.keys(actor.flags["midi-qol"]?.optional ?? [])
      .filter(flag => {
        const checkFlag = actor.flags["midi-qol"].optional[flag][category];
        if (checkFlag === undefined) return false;
        if (detail.startsWith("fail")) {
          const [_, type] = detail.split(".");
          return checkFlag.fail && checkFlag.fail[type] ? getOptionalCountRemainingShortFlag(actor, flag) > 0 : false;
        } else if (!(typeof checkFlag === "string" || checkFlag[detail] || checkFlag["all"] !== undefined)) return false;
        if (actor.flags["midi-qol"].optional[flag].count === undefined) return true;
        return getOptionalCountRemainingShortFlag(actor, flag) > 0;
      })
      .map(flag => {
        const checkFlag = actor.flags["midi-qol"].optional[flag][category];
        if (typeof checkFlag === "string") return `flags.midi-qol.optional.${flag}`;
        else return `flags.midi-qol.optional.${flag}`;
      });
    return bonusFlags;
  }
  return [];
}

export async function bonusCheck(actor, result: Roll, category, detail): Promise<Roll> {
  if (!installedModules.get("betterrolls5e")) {
    let bonusFlags = collectBonusFlags(actor, category, detail);

    if (bonusFlags.length > 0) {
      const data = {
        actor,
        roll: result,
        rollHTML: await midiRenderRoll(result),
        rollTotal: result.total,
        category,
        detail: detail
      }
      let title;
      let config = getSystemCONFIG();
      let systemString = game.system.id.toUpperCase();
      if (config.abilities[detail]?.label || config.skills[detail]?.label) {
        if (detail.startsWith("fail")) title = "Failed Save Check";
        else if (category.startsWith("check")) title = i18nFormat(`${systemString}.AbilityPromptTitle`, { ability: config.abilities[detail].label ?? "" });
        else if (category.startsWith("save")) title = i18nFormat(`${systemString}.SavePromptTitle`, { ability: config.abilities[detail].label ?? "" });
        else if (category.startsWith("skill")) title = i18nFormat(`${systemString}.SkillPromptTitle`, { skill: config.skills[detail].label ?? "" });
      } else {
        if (detail.startsWith("fail")) title = "Failed Save Check";
        else if (category.startsWith("check")) title = i18nFormat(`${systemString}.AbilityPromptTitle`, { ability: config.abilities[detail] ?? "" });
        else if (category.startsWith("save")) title = i18nFormat(`${systemString}.SavePromptTitle`, { ability: config.abilities[detail] ?? "" });
        else if (category.startsWith("skill")) title = i18nFormat(`${systemString}.SkillPromptTitle`, { skill: config.skills[detail] ?? "" });
      }
      await bonusDialog.bind(data)(
        bonusFlags,
        detail ? `${category}.${detail}` : category,
        checkMechanic("displayBonusRolls"),
        `${actor.name} - ${title}`,
        "roll", "rollTotal", "rollHTML"
      );
      result = data.roll;
    }
  }
  return result;
}

async function doRollSkill(wrapped, ...args) {
  try {
    let [skillId, options = { event: {}, parts: [], advantage: false, disadvantage: false, simulate: false, targetValue: undefined }] = args;
    const chatMessage = options.chatMessage;
    const rollTarget = options.targetValue;
    // options = foundry.utils.mergeObject(options, mapSpeedKeys(null, "ability"), { inplace: false, overwrite: true });
    const keyOptions = mapSpeedKeys(undefined, "ability");
    if (options.mapKeys !== false) {
      if (keyOptions?.advantage === true) options.advantage = true;
      if (keyOptions?.disadvantage === true) options.disadvantage = true;
      if (keyOptions?.fastForwardAbility === true) options.fastForward = true;
      if (keyOptions?.advantage || keyOptions?.disadvantage) options.fastForward = true;
    }
    // mergeKeyboardOptions(options, mapSpeedKeys(undefined, "ability"));
    options.event = {};
    let procOptions = options;
    if (configSettings.skillAbilityCheckAdvantage) {
      procOptions = procAbilityAdvantage(this, "check", this.system.skills[skillId].ability, options)

      // options = procAbilityAdvantage(actor, "check", actor.system.skills[skillId].ability, options)
    }
    // let procOptions: Options = procAbilityAdvantage(this, "check", this.system.skills[skillId].ability, options)
    procOptions = procAdvantageSkill(this, skillId, procOptions);
    if (procOptions.advantage && procOptions.disadvantage) {
      procOptions.advantage = false;
      procOptions.disadvantage = false;
    }
    if (procAutoFailSkill(this, skillId)
      || (configSettings.skillAbilityCheckAdvantage && procAutoFail(this, "check", this.system.skills[skillId].ability))) {
      options.parts = ["-100"];
    }

    let result;
    if (installedModules.get("betterrolls5e")) {
      let event = {};
      if (procOptions.advantage) { options.advantage = true; event = { shiftKey: true } };
      if (procOptions.disadvantage) { options.disadvantage = true; event = { ctrlKey: true } };
      options.event = event;
      result = wrapped(skillId, options);
      if (chatMessage !== false) return result;
      result = await result;
    } else {
      procOptions.chatMessage = false;
      if (!procOptions.parts || procOptions.parts.length === 0) delete procOptions.parts;
      // result = await wrapped.call(this, skillId, procOptions);
      result = await wrapped(skillId, procOptions);
    }
    if (!result) return result;

    const flavor = result.options?.flavor;
    const maxflags = getProperty(this.flags, "midi-qol.max") ?? {};
    const maxValue = (maxflags.skill && (maxflags.skill.all || maxflags.check[skillId])) ?? false;
    if (maxValue && Number.isNumeric(maxValue)) {
      result.terms[0].modifiers.unshift(`max${maxValue}`);
      //@ts-ignore
      result = await new Roll(Roll.getFormula(result.terms)).evaluate({ async: true });
    }
    const minflags = getProperty(this.flags, "midi-qol.min") ?? {};
    const minValue = (minflags.skill && (minflags.skill.all || minflags.skill[skillId])) ?? false
    if (minValue && Number.isNumeric(minValue)) {
      result.terms[0].modifiers.unshift(`min${minValue}`);
      //@ts-ignore
      result = await new Roll(Roll.getFormula(result.terms)).evaluate({ async: true });
    }
    let rollMode: string = result.options.rollMode ?? game.settings.get("core", "rollMode");
    if (!options.simulate) {
      result = await bonusCheck(this, result, "skill", skillId);
    }
    if (chatMessage !== false && result) {
      const saveRollMode = game.settings.get("core", "rollMode");
      const blindSkillRoll = configSettings.rollSkillsBlind.includes("all") || configSettings.rollSkillsBlind.includes(skillId);
      if (!game.user?.isGM && blindSkillRoll && ["publicroll", "roll"].includes(rollMode)) {
        rollMode = "blindroll";
        game.settings.set("core", "rollMode", "blindroll");
      }
      const args = { "speaker": getSpeaker(this), flavor };
      setProperty(args, `flags.${game.system.id}.roll`, { type: "skill", skillId });
      if (game.system.id === "sw5e") setProperty(args, "flags.sw5e.roll", { type: "skill", skillId })
      await displayDSNForRoll(result, "skill", rollMode);
      await result.toMessage(args, { rollMode });
      game.settings.set("core", "rollMode", saveRollMode);
    }
    let success: boolean | undefined = undefined;
    if (rollTarget !== undefined) {
      success = result.total >= rollTarget;
      result.options.success = success;
    }
    await expireRollEffect.bind(this)("Skill", skillId, success);
    return result;
  } catch (err) {
    const message = `doRollSkill error ${this.name}, ${this.uuid}`;
    TroubleShooter.recordError(err, message)
    throw err;
  }
}

function multiply(modifier: string) {
  const rgx = /mx([0-9])+/;
  const match = modifier.match(rgx);
  if (!match) return false;
  let [mult] = match.slice(1);
  const multiplier = parseInt(mult);
  for (let r of this.results) {
    r.count = multiplier * r.result;
    r.rerolled = true;
  }
  return true;
}

export function addDiceTermModifiers() {
  Die.MODIFIERS["mx"] = "multiply";
  setProperty(Die.prototype, "multiply", multiply);
}

export function averageDice(roll: Roll) {
  roll.terms = roll.terms.map(term => {
    if (term instanceof DiceTerm) {
      const mult = term.modifiers.includes("mx2") ? 2 : 1
      const newTerm = new NumericTerm({ number: Math.floor(term.number * mult * (term.faces + 1) / 2) });
      newTerm.options = term.options;
      return newTerm;
    }
    return term;
  });
  //@ts-expect-error _formula is private
  roll._formula = roll.constructor.getFormula(roll.terms);
  return roll;
}

function configureDamage(wrapped) {
  let useDefaultCritical = getCriticalDamage() === "default";
  useDefaultCritical ||= (getCriticalDamage() === "explodeCharacter" && this.data.actorType !== "character");
  useDefaultCritical ||= (getCriticalDamage() === "explodeNPC" && this.data.actorType !== "npc");
  if (!this.isCritical || useDefaultCritical) {
    while (this.terms.length > 0 && this.terms[this.terms.length - 1] instanceof OperatorTerm)
      this.terms.pop();
    wrapped();
    if (this.data.actorType === "npc" && configSettings.averageNPCDamage) averageDice(this);
    return;
  }
  // if (this.options.configured) return; seems this is not required.
  let bonusTerms: RollTerm[] = [];
  /* criticalDamage is one of 
    "default": "DND5e Settings Only",
    "maxDamage": "Max Normal Damage",
    "maxCrit": "Max Critical Dice (flat number)",
    "maxCritRoll": "Max Critical Dice (roll dice)",
    "maxAll": "Max All Dice",
    "doubleDice": "Double Rolled Damage",
    "explode": "Explode all critical dice",
    "explodePlayer": "Explode Player critical dice",
    "explodeGM": "Explode GM crtical dice",
    "baseDamage": "Only Weapon Extra Critical"
  },
 */
  // if (criticalDamage === "doubleDice") this.options.multiplyNumeric = true;

  for (let [i, term] of this.terms.entries()) {
    let cm = this.options.criticalMultiplier ?? 2;
    let cb = (this.options.criticalBonusDice && (i === 0)) ? this.options.criticalBonusDice : 0;
    switch (getCriticalDamage()) {
      case "maxDamage":
        if (term instanceof DiceTerm) term.modifiers.push(`min${term.faces}`);
        break;
      case "maxDamageExplode":
        if (term instanceof DiceTerm) term.modifiers.push(`min${term.faces}`);
        if (term instanceof DiceTerm) {
          bonusTerms.push(new OperatorTerm({ operator: "+" }));
          //@ts-ignore
          const newTerm = new Die({ number: term.number + cb, faces: term.faces })
          newTerm.modifiers.push(`x${term.faces}`);
          newTerm.options = term.options;
          // setProperty(newTerm.options, "sourceTerm", term);
          bonusTerms.push(newTerm);
        }
        break;
      case "maxCrit":  // Powerful critical
      case "maxCritRoll":
        if (term instanceof DiceTerm) {
          let critTerm;
          bonusTerms.push(new OperatorTerm({ operator: "+" }));
          if (getCriticalDamage() === "maxCrit")
            critTerm = new NumericTerm({ number: (term.number + cb) * term.faces });
          else {
            critTerm = new Die({ number: term.number + cb, faces: term.faces });
            critTerm.modifiers = duplicate(term.modifiers);
            critTerm.modifiers.push(`min${term.faces}`);
          }
          critTerm.options = term.options;
          bonusTerms.push(critTerm);
        } else if (term instanceof NumericTerm && this.options.multiplyNumeric) {
          term.number *= cm;
        }
        break;
      case "maxAll":
        if (term instanceof DiceTerm) {
          term.alter(cm, cb);
          term.modifiers.push(`min${term.faces}`);
        } else if (term instanceof NumericTerm && this.options.multiplyNumeric) {
          term.number *= cm;
        }
        break;
      case "doubleDice":
        if (term instanceof DiceTerm) {
          //term.alter(cm, cb);
          term.modifiers.push("mx2");
        } else if (term instanceof NumericTerm && this.options.multiplyNumeric) {
          term.number *= cm;
        }
        break;
      case "explode":
      case "explodeCharacter":
      case "explodeNPC":
        if (term instanceof DiceTerm) {
          bonusTerms.push(new OperatorTerm({ operator: "+" }));
          //@ts-ignore
          const newTerm = new Die({ number: term.number + cb, faces: term.faces })
          newTerm.modifiers.push(`x${term.faces}`);
          newTerm.options = term.options;
          // setProperty(newTerm.options, "sourceTerm", term);
          bonusTerms.push(newTerm);
        }
        break;
      case "baseDamage":
      default:
        break;
    }
  }
  if (bonusTerms.length > 0) this.terms.push(...bonusTerms);
  if (this.options.criticalBonusDamage) {
    const extra = new Roll(this.options.criticalBonusDamage, this.data);
    for (let term of extra.terms) {
      if (term instanceof DiceTerm || term instanceof NumericTerm)
        if (!term.options?.flavor) term.options = this.terms[0].options;
    }
    if (!(extra.terms[0] instanceof OperatorTerm)) this.terms.push(new OperatorTerm({ operator: "+" }));
    this.terms.push(...extra.terms);
  }
  while (this.terms.length > 0 && this.terms[this.terms.length - 1] instanceof OperatorTerm)
    this.terms.pop();
  this._formula = this.constructor.getFormula(this.terms);
  this.options.configured = true;
  if (this.data.actorType === "npc" && configSettings.averageNPCDamage) averageDice(this);
}

async function doAbilityRoll(wrapped, rollType: string, ...args) {
  let [abilityId, options = { event: {}, parts: [], chatMessage: undefined, simulate: false, targetValue: undefined, isMagicalSave: false }] = args;
  try {
    const rollTarget = options.targetValue;
    let success: boolean | undefined = undefined;
    if (procAutoFail(this, rollType, abilityId)) {
      options.parts = ["-100"];
      success = false;
    }

    if (options.event?.advantage || options.event?.altKey) options.advantage ||= true;
    if (options.event?.disadvantage || options.event?.ctrlKey) options.disadvantage ||= true;
    if (options.fromMars5eChatCard) options.fastForward ||= autoFastForwardAbilityRolls;

    const chatMessage = options.chatMessage;
    const keyOptions = mapSpeedKeys(undefined, "ability");
    if (options.mapKeys !== false) {
      if (keyOptions?.advantage === true) options.advantage = true;
      if (keyOptions?.disadvantage === true) options.disadvantage = true;
      if (keyOptions?.fastForwardAbility === true) options.fastForward = true;
      if (keyOptions?.advantage || keyOptions?.disadvantage) options.fastForward = true;
    }

    options.event = {};

    let procOptions: any = procAbilityAdvantage(this, rollType, abilityId, options);
    if (procOptions.advantage && procOptions.disadvantage) {
      procOptions.advantage = false;
      procOptions.disadvantage = false;
    }

    let result;
    if (!options.parts || procOptions.parts.length === 0) delete options.parts;
    procOptions.chatMessage = false;

    result = await wrapped(abilityId, procOptions);
    if (success === false) {
      result = new Roll("-1[auto fail]").evaluate({ async: false })
    }
    if (!result) return result;
    const maxFlags = getProperty(this.flags, "midi-qol.max.ability") ?? {};
    const flavor = result.options?.flavor;
    const maxValue = (maxFlags[rollType] && (maxFlags[rollType].all || maxFlags[rollType][abilityId])) ?? false
    if (maxValue && Number.isNumeric(maxValue)) {
      result.terms[0].modifiers.unshift(`max${maxValue}`);
      //@ts-ignore
      result = await new Roll(Roll.getFormula(result.terms)).evaluate({ async: true });
    }

    const minFlags = getProperty(this.flags, "midi-qol.min.ability") ?? {};
    const minValue = (minFlags[rollType] && (minFlags[rollType].all || minFlags[rollType][abilityId])) ?? false;
    if (minValue && Number.isNumeric(minValue)) {
      result.terms[0].modifiers.unshift(`min${minValue}`);
      //@ts-ignore
      result = await new Roll(Roll.getFormula(result.terms)).evaluate({ async: true });
    }
    let rollMode: string = result.options.rollMode ?? game.settings.get("core", "rollMode");
    let blindCheckRoll;
    let blindSaveRoll;
    if (!game.user?.isGM && ["publicroll", "roll"].includes(rollMode)) switch (rollType) {
      case "check":
        blindCheckRoll = configSettings.rollChecksBlind.includes("all") || configSettings.rollChecksBlind.includes(abilityId);
        if (blindCheckRoll) rollMode = "blindroll";
        break;
      case "save":
        blindSaveRoll = configSettings.rollSavesBlind.includes("all") || configSettings.rollSavesBlind.includes(abilityId);
        if (blindSaveRoll) rollMode = "blindroll";
        break;
    }
    await displayDSNForRoll(result, rollType, rollMode);

    if (!options.simulate) {
      result = await bonusCheck(this, result, rollType, abilityId);
      if (result.options.rollMode === "blindroll") rollMode = "blindroll";
    }

    if (chatMessage !== false && result) {
      const messageData: any = { "speaker": getSpeaker(this), flavor };
      setProperty(messageData, "flags", options.flags ?? {})
      setProperty(messageData, `flags.${game.system.id}.roll`, { type: rollType, abilityId });
      setProperty(messageData, "flags.midi-qol.lmrtfy.requestId", options.flags?.lmrtfy?.data?.requestId);
      messageData.template = "modules/midi-qol/templates/roll.html";
      const saveRollMode = game.settings.get("core", "rollMode");
      if (rollMode === "blindroll") {
        game.settings.set("core", "rollMode", rollMode);
      }
      await result.toMessage(messageData, { rollMode });
      game.settings.set("core", "rollMode", saveRollMode);
    }
    if (rollTarget !== undefined && success === undefined) {
      success = result.total >= rollTarget;
      result.options.success = success;
    }
    await expireRollEffect.bind(this)(rollType, abilityId, success);
    return result;
  } catch (err) {
    const message = `doAbilityRoll error ${this.name} ${abilityId} ${rollType} ${this.uuid}`;
    TroubleShooter.recordError(err, message);
    throw err;
  }
}

export async function rollAbilitySave(wrapped, ...args) {
  return doAbilityRoll.bind(this)(wrapped, "save", ...args);
}
async function rollAbilityTest(wrapped, ...args) {
  return doAbilityRoll.bind(this)(wrapped, "check", ...args);
}

export function preRollAbilitySaveHook(item: Item, rollData: any, abilityId: string) {
  return doPreRollAbilityHook.bind("save", item, rollData, abilityId);
}

export function rollAbilitySaveHook(item, roll, abilityId) {
  return doRollAbilityHook("save", item, roll, abilityId)
}

export function preRollAbilityTestHook(item: Item, rollData: any, abilityId: string) {
  return doPreRollAbilityHook.bind(this)("check", item, rollData, abilityId);
}

export function rollAbilityTestHook(item, roll, abilityId) {
  return doRollAbilityHook("check", item, roll, abilityId)
}

export function preRollDeathSaveHook(actor, rollData: any): boolean {
  mergeKeyboardOptions(rollData ?? {}, mapSpeedKeys(undefined, "ability"));
  const advFlags = getProperty(actor.flags, "midi-qol")?.advantage;
  const disFlags = getProperty(actor.flags, "midi-qol")?.disadvantage;
  let withAdvantage = false;
  let withDisadvantage = false;

  rollData.fastForward = autoFastForwardAbilityRolls ? !rollData.event?.fastKey : rollData.event?.fastKey;
  if (advFlags || disFlags) {
    const conditionData = createConditionData({ workflow: undefined, target: undefined, actor });
    if ((advFlags?.all && evalCondition(advFlags.all, conditionData))
      || (advFlags?.deathSave && evalCondition(advFlags.deathSave, conditionData))) {
      withAdvantage = true;
    }

    if ((disFlags?.all && evalCondition(disFlags.all, conditionData))
      || (disFlags?.deathSave && evalCondition(disFlags.deathSave, conditionData))) {
      withDisadvantage = true;
    }
  }
  rollData.advantage = withAdvantage && !withDisadvantage;
  rollData.disadvantage = withDisadvantage && !withAdvantage;

  if (rollData.advantage && rollData.disadvantage) {
    rollData.advantage = rollData.disadvantage = false;
  }
  const blindSaveRoll = configSettings.rollSavesBlind.includes("all") || configSettings.rollSavesBlind.includes("death");
  if (blindSaveRoll) rollData.rollMode = "blindroll";
  return true;
}

async function doPreRollAbilityHook(rollType: string, item, rollData: any, abilityId: string) {
  const rollTarget = rollData.targetValue;
  if (procAutoFail(this, rollType, abilityId)) {
    rollData.parts = ["-100"];
  }
  const chatMessage = rollData.chatMessage;
  const keyOptions = mapSpeedKeys(undefined, "ability");
  if (rollData.mapKeys !== false) {
    if (keyOptions?.advantage === true) rollData.advantage = rollData.advantage || keyOptions.advantage;
    if (keyOptions?.disadvantage === true) rollData.disadvantage = rollData.disadvantage || keyOptions.disadvantage;
    if (keyOptions?.fastForwardAbility === true) rollData.fastForward = rollData.fastForward || keyOptions.fastForwardAbility;
  }

  // Hack for MTB bug
  if (rollData.event?.advantage) rollData.advantage = rollData.event.advantage || rollData.advantage;
  if (rollData.event?.disadvantage) rollData.disadvantage = rollData.event.disadvantage || rollData.disadvantage;

  rollData.event = {};

  let procOptions: any = procAbilityAdvantage(this, rollType, abilityId, rollData);
  if (procOptions.advantage && procOptions.disadvantage) {
    procOptions.advantage = false;
    procOptions.disadvantage = false;
  }

  let result;
  if (!rollData.parts || procOptions.parts.length === 0) delete rollData.parts;
  rollData = mergeObject(rollData, procOptions);
  if (chatMessage !== false && result) {
    rollData.template = "modules/midi-qol/templates/roll.html";
  }
  return true;
}

function doRollAbilityHook(rollType, item, roll: any /* D20Roll */, abilityId: string) {
  const maxFlags = getProperty(item.flags, "midi-qol.max.ability") ?? {};
  let result = roll;
  const flavor = result.options?.flavor;
  const maxValue = (maxFlags[rollType] && (maxFlags[rollType].all || maxFlags[rollType][abilityId])) ?? false
  if (maxValue && Number.isNumeric(maxValue)) {
    result.terms[0].modifiers.unshift(`max${maxValue}`);
    //@ts-ignore
    result = new Roll(Roll.getFormula(result.terms)).evaluate({ async: false });
  }

  const minFlags = getProperty(item.flags, "midi-qol.min.ability") ?? {};
  const minValue = (minFlags[rollType] && (minFlags[rollType].all || minFlags[rollType][abilityId])) ?? false;
  if (minValue && Number.isNumeric(minValue)) {
    result.terms[0].modifiers.unshift(`min${minValue}`);
    result = new Roll(Roll.getFormula(result.terms)).evaluate({ async: false });
  }

  if (!roll.options.simulate) result = /* await  show stopper for this */ bonusCheck(this, result, rollType, abilityId)

  let success: boolean | undefined = undefined;
  const rollTarget = roll.options.targetValue;
  if (rollTarget !== undefined) success = result.total >= rollTarget;
    /* await - maybe ok */ expireRollEffect.bind(this)(rollType, abilityId, success);

  return result;
}


export function procAutoFail(actor, rollType: string, abilityId: string): boolean {
  const midiFlags = actor.flags["midi-qol"] ?? {};
  const fail = midiFlags.fail ?? {};
  if (fail.ability || fail.all) {
    const rollFlags = (fail.ability && fail.ability[rollType]) ?? {};
    const autoFail = fail.all || fail.ability.all || rollFlags.all || rollFlags[abilityId];
    return autoFail;
  }
  return false;
}

export function procAutoFailSkill(actor, skillId): boolean {
  const midiFlags = actor.flags["midi-qol"] ?? {};
  const fail = midiFlags.fail ?? {};
  if (fail.skill || fail.all) {
    const rollFlags = (fail.skill && fail.skill[skillId]) || false;
    const autoFail = fail.all || fail.skill.all || rollFlags;
    return autoFail;
  }
  return false;
}

export function procAbilityAdvantage(actor, rollType, abilityId, options: Options | any): Options {
  const midiFlags = actor.flags["midi-qol"] ?? {};
  const advantage = midiFlags.advantage;
  const disadvantage = midiFlags.disadvantage;
  var withAdvantage = options.advantage;
  var withDisadvantage = options.disadvantage;

  //options.fastForward = options.fastForward || (autoFastForwardAbilityRolls ? !options.event?.fastKey : options.event?.fastKey);
  if (rollType === "save" && options.isMagicSave) {
    if ((actor?.system.traits?.dr?.custom || "").includes(i18n("midi-qol.MagicResistant").trim()))
      withAdvantage = true;;

    const magicResistanceFlags = getProperty(actor, "flags.midi-qol.magicResistance");
    if (magicResistanceFlags && (magicResistanceFlags?.all || getProperty(magicResistanceFlags, abilityId))) {
      withAdvantage = true;
    }
    const magicVulnerabilityFlags = getProperty(actor, "flags.midi-qol.magicVulnerability");
    if (magicVulnerabilityFlags && (magicVulnerabilityFlags?.all || getProperty(magicVulnerabilityFlags, abilityId))) {
      withDisadvantage = true;
    }
  }

  options.fastForward = options.fastForward || options.event?.fastKey;
  if (advantage || disadvantage) {
    const conditionData = createConditionData({ workflow: options.workflow, target: tokenForActor(actor), actor, item: options.item ?? options.itemUuid ?? options.saveItem ?? options.saveItemUuid });
    if (advantage) {
      if (advantage.all && evalCondition(advantage.all, conditionData)) {
        withAdvantage = true;
      }
      if (advantage.ability) {
        if (advantage.ability.all && evalCondition(advantage.ability.all, conditionData)) {
          withAdvantage = true;
        }
        if (advantage.ability[rollType]) {
          if ((advantage.ability[rollType].all && evalCondition(advantage.ability[rollType].all, conditionData))
            || (advantage.ability[rollType][abilityId] && evalCondition(advantage.ability[rollType][abilityId], conditionData))) {
            withAdvantage = true;
          }
        }
      }
    }

    if (disadvantage) {
      if (disadvantage.all && evalCondition(disadvantage.all, conditionData)) {
        withDisadvantage = true;
      }
      if (disadvantage.ability) {
        if (disadvantage.ability.all && evalCondition(disadvantage.ability.all, conditionData)) {
          withDisadvantage = true;
        }
        if (disadvantage.ability[rollType]) {
          if ((disadvantage.ability[rollType].all && evalCondition(disadvantage.ability[rollType].all, conditionData))
            || (disadvantage.ability[rollType][abilityId] && evalCondition(disadvantage.ability[rollType][abilityId], conditionData))) {
            withDisadvantage = true;
          }
        }
      }
    }
  }
  options.advantage = withAdvantage ?? false;
  options.disadvantage = withDisadvantage ?? false;
  options.event = {};
  return options;
}

export function procAdvantageSkill(actor, skillId, options: Options): Options {
  const midiFlags = actor.flags["midi-qol"];
  const advantage = midiFlags?.advantage;
  const disadvantage = midiFlags?.disadvantage;
  var withAdvantage = options.advantage;
  var withDisadvantage = options.disadvantage;
  if (advantage || disadvantage) {
    const conditionData = createConditionData({ workflow: undefined, target: undefined, actor, item: options.item ?? options.itemUuid ?? options.saveItem ?? options.saveItemUuid });
    if (advantage?.all && evalCondition(advantage.all, conditionData)) {
      withAdvantage = true;
    }
    if (advantage?.skill) {
      if ((advantage.skill.all && evalCondition(advantage.skill.all, conditionData))
        || (advantage.skill[skillId] && evalCondition(advantage.skill[skillId], conditionData))) {
        withAdvantage = true;
      }
    }
    if (disadvantage?.all && evalCondition(disadvantage.all, conditionData)) {
      withDisadvantage = true;
    }
    if (disadvantage?.skill) {
      if ((disadvantage.skill.all && evalCondition(disadvantage.skill.all, conditionData))
        || (disadvantage.skill[skillId] && evalCondition(disadvantage.skill[skillId], conditionData))) {
        withDisadvantage = true;
      }
    }
  }
  options.advantage = withAdvantage;
  options.disadvantage = withDisadvantage;
  return options;
}


let debouncedATRefresh = debounce(_midiATIRefresh, 30);
function _midiATIRefresh(template) {
  // We don't have an item to check auto targeting with, so just use the midi setting
  if (!canvas?.tokens) return;
  let autoTarget = getAutoTarget(template.item);
  if (autoTarget === "none") return;
  if (autoTarget === "dftemplates" && installedModules.get("df-templates"))
    return; // df-templates will handle template targeting.


  if (installedModules.get("levelsvolumetrictemplates") && !["walledtemplates"].includes(autoTarget)) {
    //@ts-expect-error CONFIG.Levels
    const levelsTemplateData = CONFIG.Levels.handlers.TemplateHandler.getTemplateData();
    setProperty(template.document, "flags.levels.special", levelsTemplateData.special);
    setProperty(template.document, "flags.levels.elevation", levelsTemplateData.elevation ?? 0);
    // Filter which tokens to pass - not too far wall blocking is left to levels.
    let distance = template.distance;
    const dimensions = canvas?.dimensions || { size: 1, distance: 1 };
    distance *= dimensions.size / dimensions.distance;
    const tokensToCheck = canvas?.tokens?.placeables?.filter(tk => {
      const r: Ray = new Ray(
        { x: template.x, y: template.y },
        //@ts-ignore .width .height TODO check this v10
        { x: tk.x + tk.document.width * dimensions.size, y: tk.y + tk.document.height * dimensions.size }
      );
      //@ts-ignore .width .height TODO check this v10
      const maxExtension = (1 + Math.max(tk.document.width, tk.document.height)) * dimensions.size;
      const centerDist = r.distance;
      if (centerDist > distance + maxExtension) return false;
      if (["alwaysIgnoreIncapcitated", "wallsBlockIgnoreIncapacitated"].includes(autoTarget) && checkIncapacitated(tk, debugEnabled > 0))
        return false;
      if (["alwaysIgnoreDefeated", "wallsBlockIgnoreDefeated"].includes(autoTarget) && checkDefeated(tk))
        return false;
      return true;
    })

    if (tokensToCheck.length > 0) {
      //@ts-ignore compute3Dtemplate(t, tokensToCheck = canvas.tokens.placeables)
      VolumetricTemplates.compute3Dtemplate(template, tokensToCheck);
    }
  } else {
    const distance: number = template.distance ?? 0;
    if (template.item) {
      templateTokens(template, getSelfTarget(template.item.parent), !getProperty(template.item, "flags.midi-qol.AoETargetTypeIncludeSelf"), getProperty(template.item, "flags.midi-qol.AoETargetType"), autoTarget);
      return true;
    } else 
      templateTokens(template);
    return true;
  }
  return true;
}

function midiATRefresh(wrapped) {
  debouncedATRefresh(this);
  return wrapped();
}

export function _prepareDerivedData(wrapped, ...args) {
  wrapped(...args);
  try {
    if (!this.system.abilities?.dex) return;
    if (![false, undefined, "none"].includes(checkRule("challengeModeArmor"))) {
      const armorDetails = this.system.attributes.ac ?? {};
      const ac = armorDetails?.value ?? 10;
      const equippedArmor = armorDetails.equippedArmor;
      let armorAC = equippedArmor?.system.armor.value ?? 10;
      const equippedShield = armorDetails.equippedShield;
      const shieldAC = equippedShield?.system.armor.value ?? 0;

      if (checkRule("challengeModeArmor") !== "challenge") {
        switch (armorDetails.calc) {
          case 'flat':
            armorAC = (ac.flat ?? 10) - this.system.abilities.dex.mod;
            break;
          case 'draconic': armorAC = 13; break;
          case 'natural': armorAC = (armorDetails.value ?? 10) - this.system.abilities.dex.mod; break;
          case 'custom': armorAC = equippedArmor?.system.armor.value ?? 10; break;
          case 'mage': armorAC = 13; break; // perhaps this should be 10 if mage armor is magic bonus
          case 'unarmoredMonk': armorAC = 10; break;
          case 'unarmoredBarb': armorAC = 10; break;
          default:
          case 'default': armorAC = armorDetails.equippedArmor?.system.armor.value ?? 10; break;
        };
        const armorReduction = armorAC - 10 + shieldAC;
        const ec = ac - armorReduction;
        this.system.attributes.ac.EC = ec;
        this.system.attributes.ac.AR = armorReduction;;
      } else {
        if (!this.system.abilities) {
          console.error("midi-qol | challenge mode armor failed to find abilities");
          console.error(this);
          return;
        }
        let dexMod = this.system.abilities.dex.mod;
        if (equippedArmor?.system.armor.type === "heavy") dexMod = 0;
        if (equippedArmor?.system.armor.type === "medium") dexMod = Math.min(dexMod, 2)
        this.system.attributes.ac.EC = 10 + dexMod + shieldAC;
        this.system.attributes.ac.AR = ac - 10 - dexMod;
      }
    }
  } catch (err) {
    const message = "midi-qol failed to prepare derived data";
    console.error(message, err);
    TroubleShooter.recordError(err, message);
  }
}

export function initPatching() {
  libWrapper = globalThis.libWrapper;
  libWrapper.register("midi-qol", "CONFIG.Actor.documentClass.prototype.prepareDerivedData", _prepareDerivedData, "WRAPPER");
  // For new onuse macros stuff.
  libWrapper.register("midi-qol", "CONFIG.Item.documentClass.prototype.prepareData", itemPrepareData, "WRAPPER");
  libWrapper.register("midi-qol", "CONFIG.Actor.documentClass.prototype.prepareData", actorPrepareData, "WRAPPER");
  libWrapper.register("midi-qol", "KeyboardManager.prototype._onFocusIn", _onFocusIn, "OVERRIDE");
  libWrapper.register("midi-qol", "CONFIG.Actor.documentClass.prototype.getRollData", actorGetRollData, "WRAPPER");
  libWrapper.register("midi-qol", "CONFIG.Item.documentClass.prototype.getRollData", itemGetRollData, "WRAPPER");
  libWrapper.register("midi-qol", "CONFIG.ActiveEffect.documentClass.prototype._preCreate", _preCreateActiveEffect, "WRAPPER");
}

export function _onFocusIn(event) {
  const formElements = [
    HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement, HTMLOptionElement, /*HTMLButtonElement*/
  ];
  if (event.target.isContentEditable || formElements.some(cls => event.target instanceof cls)) this.releaseKeys();
}

export function actorPrepareData(wrapped) {
  try {
    setProperty(this, "flags.midi-qol.onUseMacroName", getProperty(this._source, "flags.midi-qol.onUseMacroName"));
    if (debugEnabled > 0) for (let effect of this.effects) {
      for (let change of effect.changes) {
        if (change.key === "flags.midi-qol.onUseMacroName") {
          if (change.mode !== CONST.ACTIVE_EFFECT_MODES.CUSTOM) {
            error("onUseMacro effect mode is not custom", `Actor ${this.name} Effect: ${effect.name} ${this.uuid}`);
            TroubleShooter.recordError(new Error("onUseMacro effect mode is not custom"), `Actor ${this.name} Effect: ${effect.name} ${this.uuid} `);
            change.mode = CONST.ACTIVE_EFFECT_MODES.CUSTOM;
          }
        }
      }
    }
    processTraits(this);
    wrapped();
    prepareOnUseMacroData(this);
    /*
    const deprecatedKeys = ["silver", "adamant", "spell", "nonmagic", "magic", "physical"];
    for (let traitKey of ["dr", "di", "dv", "sdr", "sdi", "sdv"]) {
      for (let deprecatedKey of deprecatedKeys) {
        if (this.system.traits[traitKey]?.value.has(deprecatedKey)) {
          const message = `MidiQOL ${traitKey} value ${deprecatedKey} is no longer supported in Actor ${this.name} ${this.uuid} .Set in custom traits instead`
          if (ui.notifications)
            ui.notifications?.error(message);
          else error(message);
          TroubleShooter.recordError(new Error("Trait key invalid"), message);
        }
      }
    }
    */
  } catch (err) {
    const message = `actor prepare data ${this?.name}`;
    TroubleShooter.recordError(err, message);
  }
}

export function itemPrepareData(wrapped) {
  setProperty(this, "flags.midi-qol.onUseMacroName", getProperty(this._source, "flags.midi-qol.onUseMacroName"));
  if (debugEnabled > 0) for (let effect of this.effects) {
    for (let change of effect.changes) {
      if (change.key === "flags.midi-qol.onUseMacroName") {
        if (change.mode !== CONST.ACTIVE_EFFECT_MODES.CUSTOM) {
          error("onUseMacro effect mode is not custom", `Actor: ${this.parent.name} Item: ${this.name} Effect: ${effect.name} ${this.uuid} `);
          TroubleShooter.recordError(new Error("onUseMacro effect mode is not custom - mode treated as custom"), `Actor: ${this.parent.name} Item: ${this.name} Effect: ${effect.name} ${this.uuid} `);
          change.mode = CONST.ACTIVE_EFFECT_MODES.CUSTOM;
        }
      }
    }
  }
  wrapped();
  prepareOnUseMacroData(this);
}

export function prepareOnUseMacroData(actorOrItem) {
  try {
    const macros = getProperty(actorOrItem, 'flags.midi-qol.onUseMacroName');
    setProperty(actorOrItem, "flags.midi-qol.onUseMacroParts", new OnUseMacros(macros ?? null));
  } catch (err) {
    const message = `midi-qol | failed to prepare onUse macro data ${actorOrItem?.name}`;
    console.warn(message, err);
    TroubleShooter.recordError(err, message);
  }
}

export function preUpdateItemActorOnUseMacro(itemOrActor, changes, options, user) {
  try {
    const macroChanges = getProperty(changes, "flags.midi-qol.onUseMacroParts") ?? {};
    //@ts-ignore
    if (isEmpty(macroChanges)) return true;
    const macros = getProperty(itemOrActor._source, "flags.midi-qol.onUseMacroName");
    const macroParts = new OnUseMacros(macros ?? null);

    if (!Array.isArray(macroChanges.items)) { // we have an update from editing the macro changes
      for (let keyString in macroChanges.items) {
        let key = Number(keyString);
        if (Number.isNaN(key)) continue; // just in case
        if (!macroParts.items[key]) {
          macroParts.items.push(OnUseMacro.parsePart({
            macroName: macroChanges.items[key]?.macroName ?? "",
            option: macroChanges.items[key]?.option ?? ""
          }));
          key = macroParts.items.length - 1;
        }
        if (macroChanges.items[keyString].macroName) macroParts.items[key].macroName = macroChanges.items[keyString].macroName;
        if (macroChanges.items[keyString].option) macroParts.items[key].option = macroChanges.items[keyString].option;
      }
    }
    let macroString = OnUseMacros.parseParts(macroParts).items.map(oum => oum.toString()).join(",");
    changes.flags["midi-qol"].onUseMacroName = macroString;
    delete changes.flags["midi-qol"].onUseMacroParts;
    itemOrActor.updateSource({ "flags.midi-qol.-=onUseMacroParts": null });
  } catch (err) {
    delete changes.flags["midi-qol"].onUseMacroParts;
    itemOrActor.updateSource({ "flags.midi-qol.-=onUseMacroParts": null });
    const message = `midi-qol | failed in preUpdateItemActor onUse Macro for ${itemOrActor?.name} ${itemOrActor?.uuid}`
    console.warn(message, err);
    TroubleShooter.recordError(err, message);
  }
  return true;
};

export async function rollInitiativeDialog(wrapped, rollOptions: any = { fastForward: autoFastForwardAbilityRolls }) {
  const pressedKeys = duplicate(globalThis.MidiKeyManager.pressedKeys);
  const adv = pressedKeys.advantage;
  const disadv = pressedKeys.disadvantage;
  if (autoFastForwardAbilityRolls) rollOptions.fastForward = true;
  //@ts-expect-error .dice
  const dice: any = game.system.dice.D20Roll;
  rollOptions.advantageMode = dice.ADV_MODE.NORMAL;
  if (adv && !disadv) {
    rollOptions.advantageMode = dice.ADV_MODE.ADVANTAGE;
    rollOptions.fastForward = true;
  }
  if (!adv && disadv) {
    rollOptions.advantageMode = dice.ADV_MODE.DISADVANTAGE;
    rollOptions.fastForward = true;
  }
  if (!rollOptions.fastForward) {
    return wrapped(rollOptions)
  }
  const roll = this.getInitiativeRoll(rollOptions);
  this._cachedInitiativeRoll = roll;
  rollOptions.createCombatants = true;
  await this.rollInitiative({ createCombatants: true });
  delete this._cahcedInitiativeRoll;
}

export function getInitiativeRoll(wrapped, options: any = { advantageMode: 0, fastForward: autoFastForwardAbilityRolls }) {
  //@ts-expect-error
  const D20Roll = game.dnd5e.dice.D20Roll;
  let disadv = this.getFlag(game.system.id, "initiativeDisadv") || options.advantageMode === D20Roll.ADV_MODE.DISADVANTAGE;
  let adv = this.getFlag(game.system.id, "initiativeAdv") || options.advantageMode === D20Roll.ADV_MODE.ADVANTAGE;
  const midiFlags = this.flags["midi-qol"] ?? {};
  const advFlags = midiFlags.advantage;
  const disadvFlags = midiFlags.disadvantage;
  const init: any = this.system.attributes.init;
  if (advFlags || disadvFlags) {
    const conditionData = createConditionData({ workflow: undefined, target: undefined, actor: this });
    if ((advFlags?.all && evalCondition(advFlags.all, conditionData))
      || (advFlags?.ability?.check?.all && evalCondition(advFlags.ability.check.all, conditionData))
      || (advFlags?.advantage?.ability?.check?.dex && evalCondition(advFlags.advantage.ability?.check?.dex, conditionData))) {
      adv = true;
    }
    if ((disadvFlags?.all && evalCondition(disadvFlags.all, conditionData))
      || (disadvFlags?.ability?.check?.all && evalCondition(disadvFlags.ability.check.all, conditionData))
      || (disadvFlags?.disadvantage?.ability?.check?.dex && evalCondition(disadvFlags.disadvantage.ability?.check?.dex, conditionData))) {
      disadv = true;
    }
  }
  if (adv && disadv) options.advantageMode = 0;
  else if (adv) options.advantageMode = D20Roll.ADV_MODE.ADVANTAGE;
  else if (disadv) options.advantageMode = D20Roll.ADV_MODE.DISADVANTAGE;
  if (autoFastForwardAbilityRolls) {
    options.fastForward = true;
  }
  return wrapped(options);
}

export function getItemEffectsToDelete(args: { actor: Actor, origin: string, ignore: string[], ignoreTransfer: boolean, options: any }): string[] {
  warn("getItemEffectsToDelete: started", globalThis.DAE?.actionQueue);
  let effectsToDelete;
  let { actor, origin, ignore, ignoreTransfer, options } = args;
  try {
    if (!actor) {
      return [];
    }
    effectsToDelete = actor?.effects?.filter(ef => {
      //@ts-expect-error .origin .flags
      return ef.origin === origin
        && !ignore.includes(ef.uuid)
        //@ts-expect-error .flags
        && (!ignoreTransfer || ef.flags?.dae?.transfer !== true)
    }).map(ef => ef.id);
    warn("getItemEffectsToDelete: effectsToDelete ", actor.name, effectsToDelete, options);
    return effectsToDelete;
  } catch (err) {
    const message = `getItemEffectsToDelete item effects failed for ${actor.name} ${origin} ${effectsToDelete}`;
    console.warn(message, err);
    TroubleShooter.recordError(err, message);
    return [];
  }
}
export async function removeConcentration(actor: Actor, deleteEffectUuid: string | undefined, options: any) {
  let result;
  try {
    if (debugEnabled > 0) warn("removeConcentration | ", actor?.name, deleteEffectUuid, options)
    const concentrationData: any = duplicate(actor.getFlag("midi-qol", "concentration-data") ?? {});
    // if (!concentrationData) return;
    const promises: any = [];
    await actor.unsetFlag("midi-qol", "concentration-data");
    if (!options.concentrationTemplatesDeleted && concentrationData?.templates) {
      for (let templateUuid of concentrationData.templates) {
        //@ts-expect-error fromUuidSync
        const template = fromUuidSync(templateUuid);
        if (debugEnabled > 0) warn("removeConcentration | removing template", actor?.name, templateUuid, options);
        if (template) promises.push(template.delete());
      }
    }

    if (concentrationData?.removeUuids?.length > 0 && !options.concentrationItemsDeleted) {
      for (let removeUuid of concentrationData.removeUuids) {
        //@ts-expect-error fromUuidSync
        const entity = fromUuidSync(removeUuid);
        if (debugEnabled > 0) warn("removeConcentration | removing entity", actor?.name, removeUuid, options);
        if (entity) promises.push(entity.delete())
      };
    }
    if (concentrationData?.targets && !options.concentrationEffectsDeleted) {
      if (deleteEffectUuid === undefined) options.concentrationDeleted = true; // concnetration effect will be picked up in the delete effects call
      debug("About to remove concentration effects", actor?.name);
      options.noConcentrationCheck = true;
      for (let target of concentrationData.targets) {
        const targetActor = MQfromActorUuid(target.actorUuid);
        if (targetActor) {
          const effectsToDelete = getItemEffectsToDelete({ actor: targetActor, origin: concentrationData.uuid, ignore: [deleteEffectUuid ?? ""], ignoreTransfer: true, options });
          if (effectsToDelete?.length > 0) {
            const deleteOptions = mergeObject(options, { "expiry-reason": "midi-qol:concentration" });
            if (debugEnabled > 0) warn("removeConcentration | removing effects", targetActor?.name, effectsToDelete, options);
            promises.push(untimedExecuteAsGM("deleteEffects", {
              actorUuid: target.actorUuid, effectsToDelete,
              options: mergeObject(deleteOptions, { concentrationDeleted: true, concentrationEffectsDeleted: true, noConcentrationCheck: true })
            }));
          }
        }
      }
    }
    if (!options.concentrationDeleted) {
      const concentrationEffect = getConcentrationEffect(actor);
      // remove concentration if the concentration not removed and the deleted effect is not the concentration effect
      if (concentrationEffect?.id && !options.concentrationDeleted && deleteEffectUuid !== concentrationEffect.uuid) {
        if (debugEnabled > 0) warn("removeConcentration | removing concentration effect", actor.name, concentrationEffect?.id, options);
        promises.push(actor?.deleteEmbeddedDocuments("ActiveEffect", [concentrationEffect.id],
          mergeObject(options, { concentrationDeleted: true, concentrationEffectsDeleted: true, noConcentrationCheck: true })));
      }
    }
    result = await Promise.allSettled(promises);
    if(debugEnabled > 0) warn("removeConcentration | finished", actor?.name);
  } catch (err) {
    const message = `error when attempting to remove concentration for ${actor?.name}`;
    console.warn(message, err);
    TroubleShooter.recordError(err, message);
  } finally {
    return undefined;
    // return await concentrationEffect?.delete();
  }
}

/*
export async function removeConcentrationOld(actor: Actor, concentrationUuid: string, options: any) {
  let result;
  try {
    const concentrationData: any = actor.getFlag("midi-qol", "concentration-data");
    if (!concentrationData) return;
    await actor.unsetFlag("midi-qol", "concentration-data");
    if (!options.templatesDeleted) {
      if (concentrationData.templates) {
        for (let templateUuid of concentrationData.templates) {
          const template = await fromUuid(templateUuid);
          if (template) await template.delete();
        }
      }
    }

    if (concentrationData.removeUuids?.length > 0) {
      for (let removeUuid of concentrationData.removeUuids) {
        //@ts-expect-error fromUuidSync
        const entity = fromUuidSync(removeUuid);
        await entity?.delete();
      };
    }
    if (concentrationData.targets && !options.concentrationEffectsDeleted) {
      debug("About to remove concentration effects", actor?.name);
      options.noConcentrationCheck = true;
      options.concentrationDeleted = true;
      options.concentrationEffectsDeleted = true;
      result = await untimedExecuteAsGM("deleteItemEffects", { ignore: [concentrationUuid], targets: concentrationData.targets, origin: concentrationData.uuid, ignoreTransfer: true, options });
      debug("finsihed remove concentration effects", actor?.name)
    }
  } catch (err) {
    const message = `error when attempting to remove concentration for ${actor?.name}`;
    console.warn(message, err);
    TroubleShooter.recordError(err, message);
  } finally {
    if (!options.concentrationDeleted) {
      const concentrationEffect = getConcentrationEffect(actor);
      try {
        options.concentrationEffectsDeleted = true;
        options.concenterationDeleted = true;
        if (concentrationEffect?.id)
          return await actor?.deleteEmbeddedDocuments("ActiveEffect", [concentrationEffect.id], options);
      } catch (err) {
      }
    }
    return undefined;
    // return await concentrationEffect?.delete();
  }
}
*/

export async function zeroHPExpiry(actor, update, options, user) {
  const hpUpdate = getProperty(update, "system.attributes.hp.value");
  if (hpUpdate !== 0) return;
  const expiredEffects: string[] = [];
  for (let effect of actor.effects) {
    if (effect.flags?.dae?.specialDuration?.includes("zeroHP")) expiredEffects.push(effect.id)
  }
  if (expiredEffects.length > 0) await actor.deleteEmbeddedDocuments("ActiveEffect", expiredEffects, { "expiry-reason": "midi-qol:zeroHP" })
}

export async function checkWounded(actor, update, options, user) {
  const hpUpdate = getProperty(update, "system.attributes.hp.value");
  const vitalityResource = checkRule("vitalityResource");
  //@ts-expect-error
  const dfreds = game.dfreds;
  let vitalityUpdate = vitalityResource && getProperty(update, vitalityResource.trim());
  // return wrapped(update,options,user);
  if (hpUpdate === undefined && (!vitalityResource || vitalityUpdate === undefined)) return;
  const attributes = actor.system.attributes;
  const needsBeaten = vitalityResource ? vitalityUpdate <= 0 : hpUpdate <= 0;
  if (configSettings.addWounded > 0 && hpUpdate !== undefined && configSettings.addWoundedStyle !== "none") {
    const woundedLevel = attributes.hp.max * configSettings.addWounded / 100;
    const needsWounded = hpUpdate > 0 && hpUpdate < woundedLevel && !needsBeaten;
    const woundedStatus = getWoundedStatus();
    if (!woundedStatus) {
      const message = "wounded status condition not set - please update your midi-qol dead condition on the mechanics tab";
      TroubleShooter.recordError(new Error(message), "In check wounded");
      ui.notifications?.error(`midi-qol | ${message}`);
    } else if (installedModules.get("dfreds-convenient-effects") && woundedStatus.id.startsWith("Convenient Effect:")) {
      const wounded = await ConvenientEffectsHasEffect((woundedStatus.name), actor, false);
      if (wounded !== needsWounded) {
        if (needsWounded)
          await dfreds.effectInterface?.addEffectWith({ effectData: woundedStatus, uuid: actor.uuid, overlay: configSettings.addWoundedStyle === "overlay" });
        else await actor.effects.find(ef => ef.name === woundedStatus.name)?.delete();
      }
    } else {
      const token = tokenForActor(actor);
      if (woundedStatus && token) {
        if (!needsWounded) {
          // Cater to the possibility that the setings changed while the effect was applied
          await token.toggleEffect(woundedStatus, { overlay: true, active: false });
          await token.toggleEffect(woundedStatus, { overlay: false, active: false });
        } else {
          //@ts-expect-error hasStatusEffect
          if (!token.document.hasStatusEffect(woundedStatus.id))
            await token.toggleEffect(woundedStatus, { overlay: configSettings.addWoundedStyle === "overlay", active: true });
        }
      }
    }
  }
  if (configSettings.addDead !== "none") {
    let effect: any = getDeadStatus();
    let useDefeated = true;

    if ((actor.type === "character" || actor.hasPlayerOwner) && !vitalityResource) {
      effect = getUnconsciousStatus();
      useDefeated = false;
    }
    if (effect && installedModules.get("dfreds-convenient-effects") && effect.id.startsWith("Convenient Effect:")) {
      const isBeaten = actor.effects.find(ef => ef.name === effect?.name) !== undefined;
      if ((needsBeaten !== isBeaten)) {
        let combatant;
        if (actor.token) combatant = game.combat?.getCombatantByToken(actor.token.id);
        //@ts-ignore
        else combatant = game.combat?.getCombatantByActor(actor.id);
        if (combatant && useDefeated) {
          await combatant.update({ defeated: needsBeaten })
        }
        if (needsBeaten) {
          await dfreds.effectInterface?.addEffectWith({ effectData: effect, uuid: actor.uuid, overlay: configSettings.addDead === "overlay" });
        } else { // remove beaten condition
          await dfreds.effectInterface?.removeEffect({ effectName: effect?.name, uuid: actor.uuid })
        }
      }
    } else {
      const token = tokenForActor(actor);
      if (token) {
        const isBeaten = actor.effects.find(ef => ef.name === (i18n(effect?.name ?? effect?.label ?? ""))) !== undefined;
        if (isBeaten !== needsBeaten) {
          let combatant;
          if (actor.token) combatant = game.combat?.getCombatantByToken(actor.token.id);
          //@ts-expect-error
          else combatant = game.combat?.getCombatantByActor(actor.id);
          if (combatant && useDefeated) await combatant.update({ defeated: needsBeaten });
          if (effect) await token.toggleEffect(effect, { overlay: configSettings.addDead === "overlay", active: needsBeaten });
        }
      }
    }
  }
}

async function _preUpdateActor(wrapped, update, options, user) {
  try {
    await checkWounded(this, update, options, user);
    await zeroHPExpiry(this, update, options, user);
  } catch (err) {
    const message = `midi-qol | _preUpdateActor failed `;
    console.warn(message, err);
    TroubleShooter.recordError(err, message);
  }
  finally {
    return wrapped(update, options, user);
  }
}
function itemSheetDefaultOptions(wrapped) {
  const options = wrapped();
  const modulesToCheck = ["magic-items-2", "items-with-spells-5e", "ready-set-roll-5e"];
  const installedModules = modulesToCheck.filter(mid => game.modules.get(mid)?.active).length + (configSettings.midiFieldsTab ? 1 : 0);
  const newWidth = 560 + Math.max(0, (installedModules - 2) * 100);
  if (options.width < newWidth) {
    log(`increasing item sheet width from ${options.width} to ${newWidth}`);
    options.width = newWidth;
  }
  return options;
}

export function readyPatching() {
  if (game.system.id === "dnd5e" || game.system.id === "n5e") {
    libWrapper.register("midi-qol", `game.${game.system.id}.canvas.AbilityTemplate.prototype.refresh`, midiATRefresh, "WRAPPER");
    libWrapper.register("midi-qol", "game.system.applications.actor.TraitSelector.prototype.getData", preDamageTraitSelectorGetData, "WRAPPER");
    libWrapper.register("midi-qol", "CONFIG.Actor.sheetClasses.character['dnd5e.ActorSheet5eCharacter'].cls.prototype._filterItems", _filterItems, "WRAPPER");
    libWrapper.register("midi-qol", "CONFIG.Actor.sheetClasses.npc['dnd5e.ActorSheet5eNPC'].cls.prototype._filterItems", _filterItems, "WRAPPER");
    libWrapper.register("midi-qol", "CONFIG.Item.sheetClasses.base['dnd5e.ItemSheet5e'].cls.defaultOptions", itemSheetDefaultOptions, "WRAPPER");
  } else { // TODO find out what itemsheet5e is called in sw5e TODO work out how this is set for sw5e v10
    libWrapper.register("midi-qol", "game.sw5e.canvas.AbilityTemplate.prototype.refresh", midiATRefresh, "WRAPPER");
    libWrapper.register("midi-qol", "game.system.applications.actor.TraitSelector.prototype.getData", preDamageTraitSelectorGetData, "WRAPPER");
    libWrapper.register("midi-qol", "CONFIG.Actor.sheetClasses.character['sw5e.ActorSheet5eCharacter'].cls.prototype._filterItems", _filterItems, "WRAPPER");
    libWrapper.register("midi-qol", "CONFIG.Actor.sheetClasses.npc['sw5e.ActorSheet5eNPC'].cls.prototype._filterItems", _filterItems, "WRAPPER");
  }
  libWrapper.register("midi-qol", "CONFIG.Combat.documentClass.prototype._preUpdate", processOverTime, "WRAPPER");
  libWrapper.register("midi-qol", "CONFIG.Combat.documentClass.prototype._preDelete", _preDeleteCombat, "WRAPPER");

  libWrapper.register("midi-qol", "Notifications.prototype.notify", notificationNotify, "MIXED");
  //@ts-expect-error
  const gameVersion = game.system.version;
  if ((game.system.id === "dnd5e" && isNewerVersion("2.1.0", gameVersion))) {
    if (ui.notifications)
      ui.notifications.error(`dnd5e version ${gameVersion} is too old to support midi-qol, please update to 2.2.0 or later`);
    else
      error(`dnd5e version ${gameVersion} is too old to support midi-qol, please update to 2.2.0 or later`);
  }
  libWrapper.register("midi-qol", "CONFIG.Actor.documentClass.prototype.getInitiativeRoll", getInitiativeRoll, "WRAPPER")
  libWrapper.register("midi-qol", "CONFIG.Actor.documentClass.prototype.rollInitiativeDialog", rollInitiativeDialog, "MIXED");
}

export let visionPatching = () => {
  //@ts-ignore game.version
  const patchVision = isNewerVersion(game.version ?? game?.version, "0.7.0") && game.settings.get("midi-qol", "playerControlsInvisibleTokens")
  if (patchVision) {
    ui.notifications?.warn("Player control vision is deprecated, use it at your own risk")
    console.warn("midi-qol | Player control vision is deprecated, use it at your own risk")

    log("Patching Token._isVisionSource")
    libWrapper.register("midi-qol", "Token.prototype._isVisionSource", _isVisionSource, "WRAPPER");

    log("Patching Token.isVisible")
    libWrapper.register("midi-qol", "Token.prototype.isVisible", isVisible, "WRAPPER");
  }
  log("Vision patching - ", patchVision ? "enabled" : "disabled")
}

export function configureDamageRollDialog() {
  try {
    libWrapper.unregister("midi-qol", "game.dnd5e.dice.DamageRoll.prototype.configureDialog", false);
    if (configSettings.promptDamageRoll) libWrapper.register("midi-qol", "game.dnd5e.dice.DamageRoll.prototype.configureDialog", CustomizeDamageFormula.configureDialog, "MIXED");
  } catch (err) {
    const message = `midi-qol | error when registering configureDamageRollDialog`;
    TroubleShooter.recordError(err, message);
    error(message, err);
  }
}

function _getUsageConfig(wrapped): any {
  //Radius tempalte spells with self/spec/any will auto place the template so don't prompt for it in config.
  const config = wrapped();
//  const autoCreatetemplate = this.hasAreaTarget && ["self"].includes(this.system.range?.units) && ["radius"].includes(this.system.target.type);
  const autoCreatetemplate = this.hasAreaTarget && hasAutoPlaceTemplate(this);
  if (autoCreatetemplate) config.createMeasuredTemplate = null;
  return config;
}

export let itemPatching = () => {
  libWrapper.register("midi-qol", "CONFIG.Item.documentClass.prototype.use", doItemUse, "MIXED");
  libWrapper.register("midi-qol", "CONFIG.Item.documentClass.prototype.rollAttack", doAttackRoll, "MIXED");
  libWrapper.register("midi-qol", "CONFIG.Item.documentClass.prototype.rollDamage", doDamageRoll, "MIXED");
  libWrapper.register("midi-qol", "CONFIG.Item.documentClass.prototype.displayCard", wrappedDisplayCard, "MIXED");
  if (game.system.id === "dnd5e" || game.system.id === "n5e") {
    //@ts-expect-error .version
    if (isNewerVersion(game.system.version, "2.3.99"))
      libWrapper.register("midi-qol", "CONFIG.Item.documentClass.prototype._getUsageConfig", _getUsageConfig, "WRAPPER");
    libWrapper.register("midi-qol", "CONFIG.Dice.DamageRoll.prototype.configureDamage", configureDamage, "MIXED");
  }
  configureDamageRollDialog();
};

export async function checkDeleteTemplate(templateDocument, options, user) {
  if (user !== game.user?.id) return;
  try {
    const uuid = getProperty(templateDocument, "flags.midi-qol.originUuid");
    const actor = MQfromUuid(uuid)?.actor;
    if (!(actor instanceof CONFIG.Actor.documentClass)) return true;
    const concentrationData = getProperty(actor, "flags.midi-qol.concentration-data");
    if (!concentrationData || concentrationData.templates.length === 0) return true;
    const concentrationTemplates = concentrationData.templates.filter(templateUuid => templateUuid !== templateDocument.uuid);
    if (concentrationTemplates.length === 0 // no templates left
      && concentrationData.targets.length === 1 // only one target left - me
      && concentrationData.removeUuids.length === 0 // no remove uuids left
      && ["effectsTemplates"].includes(configSettings.removeConcentrationEffects)
    ) {
      options.templatesDeleted = true;
      await removeConcentration(actor, undefined, mergeObject(options, { concentrationTemplatesDeleted: true }));
    } else if (concentrationData.templates.length >= 1) {
      // update the concentration templates
      concentrationData.templates = concentrationTemplates;
      await actor.setFlag("midi-qol", "concentration-data", concentrationData);
    }
  } catch (err) {
    const message = `checkDeleteTemplate failed for ${templateDocument?.uuid}`;
    TroubleShooter.recordError(err, message);
  } finally {
    return true;
  }
};

export let actorAbilityRollPatching = () => {

  log("Patching roll abilities Save/Test/Skill/Tool")
  libWrapper.register("midi-qol", "CONFIG.Actor.documentClass.prototype.rollAbilitySave", rollAbilitySave, "WRAPPER");
  libWrapper.register("midi-qol", "CONFIG.Actor.documentClass.prototype.rollAbilityTest", rollAbilityTest, "WRAPPER");
  libWrapper.register("midi-qol", "CONFIG.Actor.documentClass.prototype.rollSkill", doRollSkill, "WRAPPER");
  libWrapper.register("midi-qol", "CONFIG.Item.documentClass.prototype.rollToolCheck", rollToolCheck, "WRAPPER");

  // 10.0.19 rollDeath save now implemented via the preRollDeathSave Hook
}

export async function rollToolCheck(wrapped, options: any = {}) {
  const chatMessage = options.chatMessage;
  options.chatMessage = false;
  let result = await wrapped(options);
  let rollMode = result.options.rollMode ?? game.settings.get("core", "rollMode");
  await displayDSNForRoll(result, "toolCheck", rollMode);
  result = await bonusCheck(this.actor, result, "check", this.system.ability ?? "")
  if (chatMessage !== false && result) {
    const title = `${this.name} - ${game.i18n.localize("DND5E.ToolCheck")}`;
    const args: any = { "speaker": getSpeaker(this.actor), title, flavor: title };
    setProperty(args, `flags.${game.system.id}.roll`, { type: "tool", itemId: this.id, itemUuid: this.uuid });
    args.template = "modules/midi-qol/templates/roll.html";
    await result.toMessage(args, { rollMode });
  }
  return result;
}

export function patchLMRTFY() {
  if (installedModules.get("lmrtfy")) {
    log("Patching lmrtfy")
    libWrapper.register("midi-qol", "LMRTFYRoller.prototype._makeRoll", LMRTFYMakeRoll, "OVERRIDE");
    libWrapper.register("midi-qol", "LMRTFY.onMessage", LMRTFYOnMessage, "OVERRIDE");
  }
}

function LMRTFYOnMessage(data: any) {
  //console.log("LMRTF got message: ", data)
  if (data.user === "character" &&
    (!game.user?.character || !data.actors.includes(game.user.character.id))) {
    return;
  } else if (!["character", "tokens"].includes(data.user) && data.user !== game.user?.id) {
    return;
  }

  let actors: (Actor | undefined)[] = [];
  if (data.user === "character") {
    actors = [game?.user?.character];
  } else if (data.user === "tokens") {
    //@ts-expect-error
    actors = canvas?.tokens?.controlled.map(t => t.actor).filter(a => data.actors.includes(a?.id)) ?? [];
  } else {
    //@ts-expect-error
    actors = data.actors.map(aid => LMRTFY.fromUuid(aid));
  }
  actors = actors.filter(a => a);

  // remove player characters from GM's requests
  if (game.user?.isGM && data.user !== game.user.id) {
    actors = actors.filter(a => !a?.hasPlayerOwner);
  }
  if (actors.length === 0) return;
  //@ts-ignore
  new LMRTFYRoller(actors, data).render(true);
}

async function LMRTFYMakeRoll(event, rollMethod, failRoll, ...args) {
  let options = this._getRollOptions(event, failRoll);
  // save the current roll mode to reset it after this roll
  const rollMode = game.settings.get("core", "rollMode");
  game.settings.set("core", "rollMode", this.mode || CONST.DICE_ROLL_MODES);
  for (let actor of this.actors) {
    Hooks.once("preCreateChatMessage", this._tagMessage.bind(this));

    // system specific roll handling
    switch (game.system.id) {
      default: {
        setProperty(options, "flags.lmrtfy", { "message": this.data.message, "data": this.data.attach })
        actor[rollMethod].call(actor, ...args, options);
      }
    }
  }
  game.settings.set("core", "rollMode", rollMode);
  this._disableButtons(event);
  this._checkClose();
}

// This is done as a wrapper so that there is no race condition when hp reaches 0 also trying to remove condition
// This version will always fire first, remove concentration if needed and complete before the hp update is processed.
async function _preCreateActiveEffect(wrapped, data, options, user): Promise<void> {
  try {
    if (!configSettings.concentrationIncapacitatedConditionCheck) return;
    const parent: any = this.parent;
    const checkConcentration = configSettings.concentrationAutomation;
    if (!checkConcentration || options.noConcentrationCheck) return;
    if (!(parent instanceof CONFIG.Actor.documentClass)) return;
    if (globalThis.MidiQOL.incapacitatedConditions.some(condition => this.statuses.has(condition))) {
      if (debugEnabled > 0) warn(`on createActiveEffect ${this.name} ${this.id} removing concentration for ${parent.name}`)
      await removeConcentration(parent, undefined, { noConcentrationCheck: true });
    }
  } catch (err) {
    const message = "midi-qol | error in preCreateActiveEffect";
    console.error(message, err);
    TroubleShooter.recordError(err, message);
  } finally {
    return wrapped(data, options, user);
  }
}

function filterChatMessageCreate(wrapped, data: any, context: any) {
  if (!(data instanceof Array)) data = [data]
  for (let messageData of data) {
    if (messageData.flags?.lmrtfy?.data?.disableMessage) messageData.blind = true; // TODO check this v10
  }
  return wrapped(data, context);
}

export function _tagMessage(candidate, data, options) {
  let update = { flags: { lmrtfy: { "message": this.data.message, "data": this.data.attach } } }; // TODO check this
  candidate.updateSource(update);
}

export async function _makeRoll(event, rollMethod, failRoll, ...args) {
  let options;
  switch (this.advantage) {
    case -1:
      options = { disadvantage: true, fastForward: true };
      break;
    case 0:
      options = { fastForward: true };
      break;
    case 1:
      options = { advantage: true, fastForward: true };
      break;
    case 2:
      options = { event };
      break;
  }
  const rollMode = game.settings.get("core", "rollMode");
  game.settings.set("core", "rollMode", this.mode || CONST.DICE_ROLL_MODES);
  for (let actor of this.actors) {
    Hooks.once("preCreateChatMessage", this._tagMessage.bind(this));
    if (failRoll) {
      options["parts"] = [-100];
    }
    await actor[rollMethod].call(actor, ...args, options);
  }
  game.settings.set("core", "rollMode", rollMode);
  this._disableButtons(event);
  this._checkClose();
}

export async function createRollResultFromCustomRoll(customRoll: any) {
  const saveEntry = customRoll.entries?.find((e) => e.type === "multiroll");
  let saveTotal = saveEntry?.entries?.find((e) => !e.ignored)?.total ?? -1;
  let advantage = saveEntry ? saveEntry.rollState === "highest" : undefined;
  let disadvantage = saveEntry ? saveEntry.rollState === "lowest" : undefined;
  let diceRoll = saveEntry ? saveEntry.entries?.find((e) => !e.ignored)?.roll.terms[0].total : -1;
  let isCritical = saveEntry ? saveEntry.entries?.find((e) => !e.ignored)?.isCrit : false;
  //@ts-ignore
  const result = await new Roll(`${saveTotal}`).evaluate({ async: true });
  setProperty(result.terms[0].options, "advantage", advantage)
  setProperty(result.terms[0].options, "disadvantage", disadvantage)
  return result;
}

export async function _preDeleteCombat(wrapped, ...args) {
  try {
    for (let combatant of this.combatants) {
      if (combatant.actor) {
        if (hasUsedReaction(combatant.actor)) await removeReactionUsed(combatant.actor, true);
        if (hasUsedBonusAction(combatant.actor)) await removeBonusActionUsed(combatant.actor, true);
        if (hasUsedAction(combatant.actor)) await removeActionUsed(combatant.actor);
      }
    }
  } catch (err) {
    const message = `midi-qol | error in preDeleteCombat`;
    console.warn(message, err);
    TroubleShooter.recordError(err, message);
  } finally {
    return wrapped(...args)
  }
}

class CustomizeDamageFormula {
  static formula: string;
  static async configureDialog(wrapped, ...args) {
    // If the option is not enabled, return the original function - as an alternative register\unregister would be possible
    const [{ title, defaultRollMode, defaultCritical, template, allowCritical }, options] = args;
    // Render the Dialog inner HTML
    const content = await renderTemplate(
      //@ts-ignore
      template ?? this.constructor.EVALUATION_TEMPLATE,
      {
        formula: `${this.formula} + @bonus`,
        defaultRollMode,
        rollModes: CONFIG.Dice.rollModes,
      }
    );

    // Create the Dialog window and await submission of the form
    return new Promise((resolve) => {
      new Dialog(
        {
          title,
          content,
          buttons: {
            critical: {
              //@ts-ignore
              condition: allowCritical,
              label: game.i18n.localize("DND5E.CriticalHit"),
              //@ts-ignore
              callback: (html) => resolve(this._onDialogSubmit(html, true)),
            },
            normal: {
              label: game.i18n.localize(
                allowCritical ? "DND5E.Normal" : "DND5E.Roll"
              ),
              //@ts-ignore
              callback: (html) => resolve(this._onDialogSubmit(html, false)),
            },
          },
          default: defaultCritical ? "critical" : "normal",
          // Inject the formula customizer - this is the only line that differs from the original
          render: (html) => {
            try {
              CustomizeDamageFormula.injectFormulaCustomizer(this, html)
            } catch (err) {
              const message = `injectFormulaCustomizer`
              error(message, err);
              TroubleShooter.recordError(err, message);
            }
          },
          close: () => resolve(null),
        },
        options
      ).render(true);
    });
  }

  static injectFormulaCustomizer(damageRoll, html) {
    const item = damageRoll.data.item; // TODO check this v10
    const damageOptions = {
      default: damageRoll.formula,
      versatileDamage: item.damage.versatile,
      otherDamage: item.formula,
      parts: item.damage.parts,
    }
    const customizerSelect = CustomizeDamageFormula.buildSelect(damageOptions, damageRoll);
    const fg = $(html).find(`input[name="formula"]`).closest(".form-group");
    fg.after(customizerSelect);
    CustomizeDamageFormula.activateListeners(html, damageRoll);
  }

  static updateFormula(damageRoll, data) {
    //@ts-ignore
    const newDiceRoll = new CONFIG.Dice.DamageRoll(data.formula, damageRoll.data, damageRoll.options);
    CustomizeDamageFormula.updateFlavor(damageRoll, data);
    damageRoll.terms = newDiceRoll.terms;
  }

  static updateFlavor(damageRoll, data) {
    const itemName = damageRoll.options.flavor.split(" - ")[0];
    const damageType = CustomizeDamageFormula.keyToText(data.damageType);
    const special = CustomizeDamageFormula.keyToText(data.key) === damageType ? "" : CustomizeDamageFormula.keyToText(data.key);
    const newFlavor = `${itemName} - ${special} ${CustomizeDamageFormula.keyToText("damageRoll")} ${damageType ? `(${damageType.replace(" - ", "")})` : ""}`;
    Hooks.once("preCreateChatMessage", (message) => {
      message.updateSource({ flavor: newFlavor }); // TODO check this v10
    });
  }

  static buildSelect(damageOptions, damageRoll) {
    const select = $(`<select id="customize-damage-formula"></select>`);
    for (let [k, v] of Object.entries(damageOptions)) {
      if (k === "parts") {
        //@ts-ignore
        for (let part of v) {
          //@ts-ignore
          const index = v.indexOf(part);
          const adjustedFormula = CustomizeDamageFormula.adjustFormula(part, damageRoll);
          select.append(CustomizeDamageFormula.createOption(part[1], part, index));
        }
      } else {
        //@ts-ignore
        if (v) select.append(CustomizeDamageFormula.createOption(k, v));
      }
    }
    const fg = $(`<div class="form-group"><label>${CustomizeDamageFormula.keyToText("customizeFormula")}</label></div>`)
    fg.append(select);
    return fg;
  }

  static createOption(key, data, index) {
    const title = CustomizeDamageFormula.keyToText(key)
    if (typeof data === "string") {
      return $(`<option data-damagetype="" data-key="${key}" data-index="" value="${data}">${title + data}</option>`);
    } else {
      return $(`<option data-damagetype="${data[1]}" data-key="${key}" data-index="${index}" value="${data[0]}">${title + data[0]}</option>`);
    }
  }

  static adjustFormula(part, damageRoll) {
    if (damageRoll.data.item.level) { // check this v10
      //adjust for level scaling
    }
    return part;
  }

  static keyToText(key) {
    //localize stuff
    switch (key) {
      case "damageRoll":
        return "Damage Roll";
      case "customizeFormula":
        return "Customize Formula";
      case "versatileDamage":
        return "Versatile - ";
      case "otherDamage":
        return "Other - ";
      case "default":
        return "Default - ";
    }
    return key.charAt(0).toUpperCase() + key.slice(1) + " - ";
  }

  static activateListeners(html, damageRoll) {
    $(html).find(`select[id="customize-damage-formula"]`).on("change", (e) => {
      const selected = $(e.currentTarget).find(":selected");
      $(html).find(`input[name="formula"]`).val(selected.val() + " + @bonus");
      CustomizeDamageFormula.updateFormula(damageRoll, { formula: selected.val() + " + @bonus", key: selected.data("key"), damageType: selected.data("damagetype"), partsIndex: selected.data("index") });
    })
  }

}
export function processTraits(actor) {
  try {
    if (!actor.system.traits) return;
    for (let traitId of ["di", "dr", "dv", "sdi", "sdr", "sdv"]) {
      let trait = actor.system.traits[traitId];
      if (!trait) continue;
      if (!trait.value) trait.value = new Set();
      for (let traitString of trait.value) {
        switch (traitString) {
          case "silver":
            trait.bypasses.add("sil");
            addPhysicalDamages(trait.value);
            break
          case "adamant":
            trait.bypasses.add("ada");
            addPhysicalDamages(trait.value);
            break
          case "physical":
            addPhysicalDamages(trait.value);
            break;
          case "nonmagic":
            addPhysicalDamages(trait.value);
            trait.bypasses.add("mgc");
            break;
          case "spell":
            // trait.custom = addCustomTrait(trait.custom, i18n("midi-qol.spell-damage"));
            break
          case "power":
            // trait.custom = addCustomTrait(trait.custom, i18n("midi-qol.power-damage"));
            break
          case "magic":
            // trait.custom = addCustomTrait(trait.custom, i18n("midi-qol.Magical"));
            break
          case "healing":
            // trait.custom = addCustomTrait(trait.custom, getSystemCONFIG().healingTypes.healing);
            break
          case "temphp":
            // trait.custom = addCustomTrait(trait.custom, getSystemCONFIG().healingTypes.temphp);
            break
          default:
            trait.value.add(traitString);
        }
      }
    }

  } catch (err) {
    const message = `midi-qol | processTraits | error for ${actor?.name}`;
    console.warn(message, this, err);
    TroubleShooter.recordError(err, message);
  } finally {
  }
}
export function migrateTraits(actor) {
  try {
    if (!actor.system.traits) return;
    const baseData = actor.toObject(true);
    for (let traitId of ["di", "dr", "dv", "sdi", "sdr", "sdv"]) {
      let trait = actor.system.traits[traitId];
      let baseTrait = baseData.system.traits[traitId];
      if (!trait) continue;
      if (!trait.value) trait.value = new Set();

      if (trait.bypasses instanceof Set) {
        for (let traitString of baseTrait.value) {
          switch (traitString) {
            case "silver":
              trait.bypasses.add("sil");
              addPhysicalDamages(trait.value);
              trait.value.delete("silver");
              log(`${actor.name} mapping "Silver" to ${trait.value}, ${trait.bypasses}`)
              break
            case "adamant":
              trait.bypasses.add("ada");
              addPhysicalDamages(trait.value);
              trait.value.delete("adamant");
              log(`${actor.name} mapping "Adamantine" to ${trait.value}, ${trait.bypasses}`)
              break
            case "physical":
              addPhysicalDamages(trait.value);
              trait.value.delete("physical");
              log(`${actor.name} mapping "Physical" to ${trait.value}, ${trait.bypasses}`)
              break;
            case "nonmagic":
              addPhysicalDamages(trait.value);
              trait.bypasses.add("mgc");
              trait.value.delete("nonmagic");
              log(`${actor.name} mapping "nongamic" to ${trait.custom}`)
              break;
            case "spell":
              trait.custom = addCustomTrait(trait.custom, i18n("midi-qol.spell-damage"));
              trait.value.delete("spell");
              log(`${actor.name} mapping "spell" to ${trait.custom}`)
              break
            case "power":
              trait.custom = addCustomTrait(trait.custom, i18n("midi-qol.power-damage"));
              trait.value.delete("power");
              log(`${actor.name} mapping "power" to ${trait.custom}`)
              break
            case "magic":
              trait.custom = addCustomTrait(trait.custom, i18n("midi-qol.Magical"));
              trait.value.delete("magic");
              log(`${actor.name} mapping "magic" to ${trait.custom}`)
              break
            case "healing":
              trait.custom = addCustomTrait(trait.custom, getSystemCONFIG().healingTypes.healing);
              trait.value.delete("healing");
              log(`${actor.name} mapping "healing" to ${trait.custom}`)
              break
            case "temphp":
              trait.custom = addCustomTrait(trait.custom, getSystemCONFIG().healingTypes.temphp);
              trait.value.delete("temphp");
              log(`${actor.name} mapping "temphp" to ${trait.custom}`)
              break
            default:
              trait.value.add(traitString);
          }
        }
      } else {
        for (let traitString of baseTrait.value) {
          switch (traitString) {
            case "silver":
              if (!trait.bypasses.includes("sil")) trait.bypasses.push("sil");
              addPhysicalDamages(trait.value);
              trait.value = removeTraitValue(trait.value, "silver");
              log(`${actor.name} mapping "Silver" to ${trait.value}, ${trait.bypasses}`)
              break
            case "adamant":
              if (!trait.bypasses.includes("ada")) trait.bypasses.push("ada");
              addPhysicalDamages(trait.value);
              trait.value = removeTraitValue(trait.value, "adamant");
              log(`${actor.name} mapping "Adamantine" to ${trait.value}, ${trait.bypasses}`)
              break
            case "physical":
              addPhysicalDamages(trait.value);
              trait.value = removeTraitValue(trait.value, "physical");
              log(`${actor.name} mapping "Physical" to ${trait.value}, ${trait.bypasses}`)
              break;
            case "nonmagic":
              addPhysicalDamages(trait.value);
              if (!trait.bypasses.includes("mgc")) trait.bypasses.push("mgc");
              trait.value = removeTraitValue(trait.value, "nonmagic");
              log(`${actor.name} mapping "nongamic" to ${trait.custom}`)
              break;
            case "spell":
              trait.custom = addCustomTrait(trait.custom, i18n("midi-qol.spell-damage"));
              trait.value = removeTraitValue(trait.value, "spell");
              log(`${actor.name} mapping "spell" to ${trait.custom}`)
              break
            case "power":
              trait.custom = addCustomTrait(trait.custom, i18n("midi-qol.power-damage"));
              trait.value = removeTraitValue(trait.value, "power");
              log(`${actor.name} mapping "power" to ${trait.custom}`)
              break
            case "magic":
              trait.custom = addCustomTrait(trait.custom, i18n("midi-qol.Magical"));
              trait.value = removeTraitValue(trait.value, "magic");
              log(`${actor.name} mapping "magic" to ${trait.custom}`)
              break
            case "healing":
              trait.custom = addCustomTrait(trait.custom, getSystemCONFIG().healingTypes.healing);
              trait.value = removeTraitValue(trait.value, "healing");
              log(`${actor.name} mapping "healing" to ${trait.custom}`)
              break
            case "temphp":
              trait.custom = addCustomTrait(trait.custom, getSystemCONFIG().healingTypes.temphp);
              trait.value = removeTraitValue(trait.value, "temphp");
              log(`${actor.name} mapping "temphp" to ${trait.custom}`)
              break
            default:
              trait.value.push(traitString);
          }
        }
      }
    }

  } catch (err) {
    const message = `midi-qol | migrateTraits | error for ${actor?.name}`;
    console.warn(message, this, err);
    TroubleShooter.recordError(err, message);
  } finally {
  }
}

function removeTraitValue(traitValue: string[] | Set<string>, toRemove): string[] | Set<string> {
  if (traitValue instanceof Set)
    traitValue.delete(toRemove);
  else {
    const position = traitValue.indexOf(toRemove);
    if (position !== -1) return traitValue.splice(position, 1);
  }
  return traitValue;
}

function addPhysicalDamages(traitValue) {
  const phsyicalDamageTypes = Object.keys(getSystemCONFIG().physicalDamageTypes);

  for (let dt of phsyicalDamageTypes) {
    if (traitValue instanceof Set) traitValue.add(dt);
    else if (!traitValue.includes(dt)) traitValue.push(dt);
  }
}

function addCustomTrait(customTraits: string, customTrait: string): string {
  if (customTraits.length === 0) {
    return customTrait;
  }
  const traitList = customTraits.split(";").map(s => s.trim());
  if (traitList.includes(customTrait)) return customTraits;
  traitList.push(customTrait);
  return traitList.join("; ");
}

function preDamageTraitSelectorGetData(wrapped) {
  try {
    // migrate di/dr/dv and strip out active effect data.
    if (this.object instanceof Actor) processTraits(this.object);
  } catch (err) {
    const message = `preDamageTraitSelectorGetData | migrate traits error`;
    error(message, err);
    TroubleShooter.recordError(err, message);
  } finally {
    return wrapped();
  }
}

function actorGetRollData(wrapped, ...args) {
  const data = wrapped(...args);
  data.actorType = this.type;
  data.name = this.name;
  data.midiFlags = (this.flags && this.flags["midi-qol"]) ?? {};
  if (game.system.id === "dnd5e") {
    data.cfg = {};
    data.cfg.armorClasses = getSystemCONFIG().armorClasses;
    data.cfg.actorSizes = getSystemCONFIG().actorSizes;
    data.cfg.skills = getSystemCONFIG().skills;
  }
  return data;
}

function itemGetRollData(wrapped, ...args) {
  const data = wrapped(...args);
  if (!data) return data;
  if (this.system.spellLevel) data.item.spellLevel = this.system.spellLevel; // since it's wrapped the this in wrapped call does not have the spelllevel?
  data.item.flags = this.flags;
  data.item.midiFlags = getProperty(this, "flags.midi-qol");
  data.item.name = this.name;
  data.item.type = this.type;
  return data;
}
function _filterItems(wrapped, items, filters) {
  if (!filters.has("reaction")) return wrapped(items, filters);
  const revisedFilters = new Set(filters);
  revisedFilters.delete("reaction");
  let filteredItems = wrapped(items, revisedFilters);
  filteredItems = filteredItems.filter(item => {
    if (item.system.activation?.type?.includes("reaction")) return true;
    return false
  });
  return filteredItems
};
import { registerSettings, fetchParams, configSettings, checkRule, enableWorkflow, midiSoundSettings, fetchSoundSettings, midiSoundSettingsBackup, disableWorkflowAutomation, readySettingsSetup, collectSettingData, safeGetGameSetting } from './module/settings.js';
import { preloadTemplates } from './module/preloadTemplates.js';
import { checkModules, installedModules, setupModules } from './module/setupModules.js';
import { itemPatching, visionPatching, actorAbilityRollPatching, patchLMRTFY, readyPatching, initPatching, addDiceTermModifiers } from './module/patching.js';
import { initHooks, overTimeJSONData, readyHooks, setupHooks } from './module/Hooks.js';
import { SaferSocket, initGMActionSetup, setupSocket, socketlibSocket, untimedExecuteAsGM } from './module/GMAction.js';
import { setupSheetQol } from './module/sheetQOL.js';
import { TrapWorkflow, DamageOnlyWorkflow, Workflow, DummyWorkflow, DDBGameLogWorkflow, UserWorkflow } from './module/workflow.js';
import { addConcentration, addConcentrationDependent, addRollTo, applyTokenDamage, canSee, canSense, canSenseModes, checkDistance, checkIncapacitated, checkNearby, checkRange, chooseEffect, completeItemRoll, completeItemUse, computeCoverBonus, contestedRoll, createConditionData, debouncedUpdate, displayDSNForRoll, doConcentrationCheck, doOverTimeEffect, evalAllConditions, evalCondition, findNearby, findNearbyCount, getCachedDocument, getChanges, getConcentrationEffect, getDistanceSimple, getDistanceSimpleOld, getTokenDocument, getTokenForActor, getTokenForActorAsSet, getTokenPlayerName, getTraitMult, hasCondition, hasUsedBonusAction, hasUsedReaction, isTargetable, midiRenderAttackRoll, midiRenderBonusDamageRoll, midiRenderDamageRoll, midiRenderOtherDamageRoll, midiRenderRoll, fromActorUuid, playerFor, playerForActor, raceOrType, reactionDialog, removeHiddenCondition, removeInvisibleCondition, removeReactionUsed, reportMidiCriticalFlags, setBonusActionUsed, setReactionUsed, tokenForActor, typeOrRace, validRollAbility, MQfromUuidSync, actorFromUuid, createDamageDetail, removeActionUsed, removeBonusActionUsed } from './module/utils.js';
import { ConfigPanel } from './module/apps/ConfigPanel.js';
import { resolveTargetConfirmation, showItemInfo, templateTokens } from './module/itemhandling.js';
import { RollStats } from './module/RollStats.js';
import { OnUseMacroOptions } from './module/apps/Item.js';
import { MidiKeyManager } from './module/MidiKeyManager.js';
import { MidiSounds } from './module/midi-sounds.js';
import { addUndoChatMessage, getUndoQueue, removeMostRecentWorkflow, showUndoQueue, undoMostRecentWorkflow } from './module/undo.js';
import { showUndoWorkflowApp } from './module/apps/UndoWorkflow.js';
import { TroubleShooter } from './module/apps/TroubleShooter.js';
import { TargetConfirmationDialog } from './module/apps/TargetConfirmation.js';

export let debugEnabled = 0;
export let debugCallTiming: any = false;
// 0 = none, warnings = 1, debug = 2, all = 3
export let debug = (...args) => { if (debugEnabled > 1) console.log("DEBUG: midi-qol | ", ...args) };
export let log = (...args) => console.log("midi-qol | ", ...args);
export let warn = (...args) => { if (debugEnabled > 0) console.warn("midi-qol | ", ...args) };
export let error = (...args) => console.error("midi-qol | ", ...args);
export let timelog = (...args) => warn("midi-qol | ", Date.now(), ...args);
export var levelsAPI;
export var allDamageTypes;
export const MODULE_ID = "midi-qol";
//@ts-expect-error
export const ArrayField = foundry.data.fields.ArrayField;
//@ts-expect-error
export const ObjectField = foundry.data.fields.ObjectField
//@ts-expect-error
export const BooleanField = foundry.data.fields.BooleanField;
//@ts-expect-error
export const NumberField = foundry.data.fields.NumberField;
//@ts-expect-error
export const StringField = foundry.data.fields.StringField;
//@ts-expect-error
export const SchemaField = foundry.data.fields.SchemaField;

declare global {
  interface LenientGlobalVariableTypes {
    game: any; // the type doesn't matter
  }
}
export function getCanvas(): Canvas | undefined {
  if (!canvas || !canvas.scene) {
    error("Canvas/Scene not ready - roll automation will not function");
    return undefined;
  }
  return canvas;
}

export let i18n = key => {
  return game.i18n.localize(key);
};
export function i18nSystem(key) {
  const keyHeader = game.system.id.toUpperCase();
  return i18n(`${keyHeader}.${key}`);
}
export let i18nFormat = (key, data = {}) => {
  return game.i18n.format(key, data);
}
export function geti18nOptions(key) {
  const translations = game.i18n.translations[MODULE_ID] ?? {};
  //@ts-ignore _fallback not accessible
  const fallback = game.i18n._fallback[MODULE_ID] ?? {};
  let translation = foundry.utils.mergeObject(fallback[key] ?? {}, translations[key] ?? {}, { overwrite: true, inplace: false });
  return translation;
}
export function geti18nTranslations() {
  // @ts-expect-error _fallback
  return foundry.utils.mergeObject(game.i18n._fallback[MODULE_ID] ?? {}, game.i18n.translations[MODULE_ID] ?? {});
}

export function getStaticID(id: string): string {
  id = `dnd5e${id}`;
  if (id.length >= 16) return id.substring(0, 16);
  return id.padEnd(16, "0");
}

export let setDebugLevel = (debugText: string) => {
  debugEnabled = { "none": 0, "warn": 1, "debug": 2, "all": 3 }[debugText] || 0;
  // 0 = none, warnings = 1, debug = 2, all = 3
  if (debugEnabled >= 3) CONFIG.debug.hooks = true;
  debugCallTiming = game.settings.get(MODULE_ID, "debugCallTiming") ?? false;
}

export let noDamageSaves: string[] = [];
export let undoDamageText;
export let savingThrowText;
export let savingThrowTextAlt;
export let MQdefaultDamageType;
export let midiFlags: string[] = [];
export let allAttackTypes: string[] = []
export let gameStats: RollStats;
export let overTimeEffectsToDelete = {};
export let failedSaveOverTimeEffectsToDelete = {}
export let MQItemMacroLabel: string;
export let MQDeferMacroLabel: string;
export let MQOnUseOptions;
export let GameSystemConfig;
export let SystemString;
export let systemConcentrationId;
export let midiReactionEffect;
export let midiBonusActionEffect;

export const MESSAGETYPES = {
  HITS: 1,
  SAVES: 2,
  ATTACK: 3,
  DAMAGE: 4,
  ITEM: 0
};
export let cleanSpellName = (name: string): string => {
  // const regex = /[^가-힣一-龠ぁ-ゔァ-ヴーa-zA-Z0-9ａ-ｚＡ-Ｚ０-９々〆〤]/g
  const regex = /[^가-힣一-龠ぁ-ゔァ-ヴーa-zA-Z0-9ａ-ｚＡ-Ｚ０-９а-яА-Я々〆〤]/g
  return name.toLowerCase().replace(regex, '').replace("'", '').replace(/ /g, '');
}

/* ------------------------------------ */
/* Initialize module					*/
/* ------------------------------------ */
Hooks.once("levelsReady", function () {
  //@ts-ignore
  levelsAPI = CONFIG.Levels.API;
});
export let systemString = "DND5E"
export let MQDamageRollTypes = ["defaultDamage", "otherDamage", "bonusDamage"];
Hooks.once("init", () => {
  //@ts-expect-error
  CONFIG.ChatMessage.documentClass = defineChatMessageMidiClass(CONFIG.ChatMessage.documentClass);
});


Hooks.once('init', async function () {
  //@ts-expect-error
  if (game.release.generation < 12) Math.clamp = Math.clamped;
  log('Initializing midi-qol');
  //@ts-expect-error
  const systemVersion = game.system.version;
  Hooks.once('dfreds-convenient-effects.ready()', () => {
    setupMidiStatusEffects();
  });
  addConfigOptions();

  //@ts-expect-error
  if (game.release.generation < 12 && !Math.clamp) Math.clamp = Math.clamped;

  //@ts-expect-error
  GameSystemConfig = game.system.config;
  GameSystemConfig.damageTypes["none"] = { label: i18n("midi-qol.noType"), icon: `systems/${game.system.id}/icons/svg/trait-damage-immunities.svg` };
  GameSystemConfig.damageTypes["midi-none"] = { label: i18n("midi-qol.midi-none"), icon: `systems/${game.system.id}/icons/svg/trait-damage-immunities.svg` };
  SystemString = game.system.id.toUpperCase();
  allAttackTypes = ["rwak", "mwak", "rsak", "msak"];
  if (game.system.id === "sw5e")
    allAttackTypes = ["rwak", "mwak", "rpak", "mpak"];
  initHooks();

  //@ts-expect-error
  systemConcentrationId = CONFIG.specialStatusEffects.CONCENTRATING;

  globalThis.MidiQOL = { checkIncapacitated };
  // Assign custom classes and constants here

  // Register custom module settings
  registerSettings();
  fetchParams();
  fetchSoundSettings();
  // This seems to cause problems for localisation for the items compendium (at least for french)
  // Try a delay before doing this - hopefully allowing localisation to complete
  // If babele is installed then wait for it to be ready
  if (game.modules.get("babele")?.active) {
    Hooks.once("babele.ready", MidiSounds.getWeaponBaseTypes);
  } else {
    setTimeout(MidiSounds.getWeaponBaseTypes, 6000);
  }
  // Preload Handlebars templates
  preloadTemplates();
  // Register custom sheets (if any)
  initPatching();
  addDiceTermModifiers();
  globalThis.MidiKeyManager = new MidiKeyManager();
  globalThis.MidiKeyManager.initKeyMappings();
  Hooks.on("error", (...args) => {
    let [message, err] = args;
    TroubleShooter.recordError(err, message);
  });
});
Hooks.on("dae.modifySpecials", (specKey, specials, _characterSpec) => {
  specials[`flags.${MODULE_ID}.onUseMacroName`] = [new StringField(), CONST.ACTIVE_EFFECT_MODES.CUSTOM];
  specials[`flags.${MODULE_ID}.optional.NAME.macroToCall`] = [new StringField(), CONST.ACTIVE_EFFECT_MODES.CUSTOM];
  if (configSettings.v3DamageApplication) {
    for (let type of ["dm", "da", "di", "dv", "dr"]) {
      specials[`system.traits.${type}.midi.all`] = [new StringField(), -1];
      specials[`system.traits.${type}.midi.magical`] = [new StringField(), -1];
      specials[`system.traits.${type}.midi.non-magical`] = [new StringField(), -1];
      specials[`system.traits.${type}.midi.non-magical-physical`] = [new StringField(), -1];
      specials[`system.traits.${type}.midi.non-silver-physical`] = [new StringField(), -1];
      specials[`system.traits.${type}.midi.non-adamant-physical`] = [new StringField(), -1];
      specials[`system.traits.${type}.midi.non-physical`] = [new StringField(), -1];
      specials[`system.traits.${type}.midi.physical`] = [new StringField(), -1];
      specials[`system.traits.${type}.midi.spell`] = [new StringField(), -1];
      specials[`system.traits.${type}.midi.non-spell`] = [new StringField(), -1];
    }

    // specials[`system.traits.dm.midi.final`] = [new StringField(), -1];
    specials[`system.traits.idi.value`] = [new StringField(), -1];
    specials[`system.traits.idr.value`] = [new StringField(), -1];
    specials[`system.traits.idv.value`] = [new StringField(), -1];
    specials[`system.traits.ida.value`] = [new StringField(), -1];
    specials[`system.traits.idm.value`] = [new StringField(), -1];
  }
});
Hooks.on("dae.addFieldMappings", (fieldMappings) => {
  registerSettings();
  fetchParams();

  if (configSettings.v3DamageApplication) {
    //@ts-expect-error
    for (let key of Object.keys(game.system.config.damageTypes ?? {})) {
      fieldMappings[`flags.${MODULE_ID}.DR.${key}`] = `system.traits.dm.amount.${key}`;
      fieldMappings[`flags.${MODULE_ID}.absorption.${key}`] = `system.traits.da.value`;
    }
    //@ts-expect-error
    for (let key of Object.keys(game.system.config.healingTypes ?? {})) {
      fieldMappings[`flags.${MODULE_ID}.DR.${key}`] = `system.traits.dm.amount.${key}`;
      fieldMappings[`flags.${MODULE_ID}.absorption.${key}`] = `system.traits.da.value`;
    }
    fieldMappings[`flags.${MODULE_ID}.DR.all`] = "system.traits.dm.midi.all";
    fieldMappings[`flags.${MODULE_ID}.absorption.all`] = "system.traits.da.all";

    //@ts-expect-error
    Object.keys(game.system.config.itemActionTypes).forEach(aType => {
      fieldMappings[`flags.${MODULE_ID}.DR.${aType}`] = `system.traits.dm.midi.${aType}`;
    });
    fieldMappings[`flags.${MODULE_ID}.DR.all`] = `system.traits.dm.midi.all`;
    fieldMappings[`flags.${MODULE_ID}.DR.non-magical`] = `system.traits.dm.midi.non-magical`;
    fieldMappings[`flags.${MODULE_ID}.DR.non-magical-physical`] = `system.traits.dm.midi.non-magical-physical`;
    fieldMappings[`flags.${MODULE_ID}.DR.non-silver`] = `system.traits.dm.midi.non-silver-physical`;
    fieldMappings[`flags.${MODULE_ID}.DR.non-adamant`] = `system.traits.dm.midi.non-adamant-physical`;
    fieldMappings[`flags.${MODULE_ID}.DR.non-physical`] = `system.traits.dm.midi.non-physical`;
    fieldMappings[`flags.${MODULE_ID}.DR.non-spell`] = `system.traits.dm.midi.non-spell`;
    fieldMappings[`flags.${MODULE_ID}.DR.spell`] = `system.traits.dm.midi.spell`;

    // fieldMappings[`flags.${MODULE_ID}.DR.final`] = `system.traits.dm.midi.final`;
    fieldMappings[`flags.${MODULE_ID}.concentrationSaveBonus`] = "system.attributes.concentration.bonuses.save";
  }
  fieldMappings[`flags.${MODULE_ID}.fail.critical.all`] = `flags.${MODULE_ID}.grants.noCritical.all`;
  for (let attackType of allAttackTypes) {
    fieldMappings[`flags.${MODULE_ID}.fail.critical.${attackType}`] = `flags.${MODULE_ID}.grants.noCritical.${attackType}`;
  }

});
/* ------------------------------------ */
/* Setup module							*/
/* ------------------------------------ */
Hooks.once('setup', function () {
  // Do anything after initialization but before
  // ready
  setupSocket();
  fetchParams();
  fetchSoundSettings();
  itemPatching();
  visionPatching();
  setupModules();
  initGMActionSetup();
  patchLMRTFY();
  setupMidiFlags();
  setupHooks();
  undoDamageText = i18n("midi-qol.undoDamageFrom");
  savingThrowText = i18n("midi-qol.savingThrowText");
  savingThrowTextAlt = i18n("midi-qol.savingThrowTextAlt");
  MQdefaultDamageType = i18n("midi-qol.defaultDamageType");
  MQItemMacroLabel = i18n("midi-qol.ItemMacroText");
  if (MQItemMacroLabel === "midi-qol.ItemMacroText") MQItemMacroLabel = "ItemMacro";
  MQDeferMacroLabel = i18n("midi-qol.DeferText");
  if (MQDeferMacroLabel === "midi-qol.DeferText") MQDeferMacroLabel = "[Defer]";
  setupSheetQol();
  createMidiMacros();
  setupMidiQOLApi();
});

function addConfigOptions() {

  //@ts-expect-error
  let config = game.system.config;
  //@ts-expect-error
  const systemVersion = game.system.version;
  if (game.system.id === "dnd5e" || game.system.id === "n5e") {
    config.midiProperties = {};
    // Add additonal vision types? How to modify token properties doing this.
    config.midiProperties["confirmTargets"] = i18n("midi-qol.confirmTargetsProp");
    // config.midiProperties["nodam"] = i18n("midi-qol.noDamageSaveProp");
    // config.midiProperties["fulldam"] = i18n("midi-qol.fullDamageSaveProp");
    // config.midiProperties["halfdam"] = i18n("midi-qol.halfDamageSaveProp");
    config.midiProperties["autoFailFriendly"] = i18n("midi-qol.FailFriendly");
    config.midiProperties["autoSaveFriendly"] = i18n("midi-qol.SaveFriendly");
    config.midiProperties["rollOther"] = i18n("midi-qol.rollOtherProp");
    config.midiProperties["critOther"] = i18n("midi-qol.otherCritProp");
    config.midiProperties["offHandWeapon"] = i18n("midi-qol.OffHandWeapon");
    config.midiProperties["magicdam"] = i18n("midi-qol.magicalDamageProp");
    config.midiProperties["magiceffect"] = i18n("midi-qol.magicalEffectProp");
    // removed for 11.4.29 config.midiProperties["concentration"] = i18n("midi-qol.concentrationEffectProp");
    config.midiProperties["noConcentrationCheck"] = i18n("midi-qol.noConcentrationEffectProp");
    config.midiProperties["toggleEffect"] = i18n("midi-qol.toggleEffectProp");
    config.midiProperties["ignoreTotalCover"] = i18n("midi-qol.ignoreTotalCover");
    config.midiProperties["saveDamage"] = "Save Damage";
    config.midiProperties["bonusSaveDamage"] = "Bonus Damage Save";
    config.midiProperties["otherSaveDamage"] = "Other Damage Save";
    config.midiProperties["idr"] = "Ignore dr";
    config.midiProperties["idi"] = "Ignore di";
    config.midiProperties["idv"] = "Ignore dv";
    config.midiProperties["ida"] = "Ignore da";
    config.damageTypes["none"] = { label: i18n("midi-qol.noType"), icon: "systems/dnd5e/icons/svg/trait-damage-immunities.svg", toString: function () { return this.label } };
    config.damageTypes["midi-none"] = { label: i18n("midi-qol.midi-none"), icon: "systems/dnd5e/icons/svg/trait-damage-immunities.svg", toString: function () { return this.label } };

    // sliver, adamant, spell, nonmagic, maic are all deprecated and should only appear as custom
    config.customDamageResistanceTypes = {
      "spell": i18n("midi-qol.SpellDamage"),
      "non-spell": i18n("midi-qol.NonSpellDamage"),
      "magical": i18n("midi-qol.Magical"),
      "non-magical": i18n("midi-qol.NonMagical"),
      "physical": i18n("midi-qol.Physical"),
      "non-magical-physical": i18n("midi-qol.NonMagicalPhysical"),
      "non-silver-physical": i18n("midi-qol.NonSilverPhysical"),
      "non-adamant-physical": i18n("midi-qol.NonAdamantinePhysical"),
    };


    config.damageResistanceTypes = config.damageResistanceTypes ?? {};
    config.damageResistanceTypes["silver"] = i18n("midi-qol.NonSilverPhysical");
    config.damageResistanceTypes["adamant"] = i18n("midi-qol.NonAdamantinePhysical");
    config.damageResistanceTypes["physical"] = i18n("midi-qol.NonMagicalPhysical");
    config.damageResistanceTypes["spell"] = i18n("midi-qol.spell-damage");
    config.damageResistanceTypes["nonmagic"] = i18n("midi-qol.NonMagical");
    config.damageResistanceTypes["magic"] = i18n("midi-qol.Magical");
    config.damageResistanceTypes["healing"] = config.healingTypes?.healing?.label;
    config.damageResistanceTypes["temphp"] = config.healingTypes?.temphp?.label;

    config.traits.di.configKey = "damageTypes";
    config.traits.dr.configKey = "damageTypes";
    config.traits.dv.configKey = "damageTypes";
    if (!config.traits.da && game.system.id === "dnd5e") {
      config.traits.da = {
        labels: {title: "Damage Absorption", localization: "midi-qol.DamageAbsorption"},
        icon: "systems/dnd5e/icons/svg/damageresistances.svg",
        configKey: "damageTypes"
      }
    } else if (config.traits.da) {
      config.traits.da.configKey = "damageTypes"
    }
    const dnd5eReaction = `${SystemString}.Reaction`;
    config.abilityActivationTypes["reactionpreattack"] = `${i18n(dnd5eReaction)} ${i18n("midi-qol.reactionPreAttack")}`;
    config.abilityActivationTypes["reactiondamage"] = `${i18n(dnd5eReaction)} ${i18n("midi-qol.reactionDamaged")}`;
    config.abilityActivationTypes["reactionmanual"] = `${i18n(dnd5eReaction)} ${i18n("midi-qol.reactionManual")}`;
  } else if (game.system.id === "sw5e") { // sw5e
    //@ts-expect-error
    config = CONFIG.SW5E;
    config.midiProperties = {};
    config.midiProperties["nodam"] = i18n("midi-qol.noDamageSaveProp");
    config.midiProperties["fulldam"] = i18n("midi-qol.fullDamageSaveProp");
    config.midiProperties["halfdam"] = i18n("midi-qol.halfDamageSaveProp")
    // config.midiProperties["rollOther"] = i18n("midi-qol.rollOtherProp");
    config.midiProperties["critOther"] = i18n("midi-qol.otherCritProp");
    config.midiProperties["concentration"] = i18n("midi-qol.concentrationActivationCondition");
    config.midiProperties["saveDamage"] = "Save Damage";
    config.midiProperties["bonusSaveDamage"] = "Bonus Damage Save";
    config.midiProperties["otherSaveDamage"] = "Other Damage Save";
    config.damageTypes["midi-none"] = i18n("midi-qol.midi-none");
    config.abilityActivationTypes["reactiondamage"] = `${i18n("DND5E.Reaction")} ${i18n("midi-qol.reactionDamaged")}`;
    config.abilityActivationTypes["reactionmanual"] = `${i18n("DND5E.Reaction")} ${i18n("midi-qol.reactionManual")}`;
    config.customDamageResistanceTypes = {
      "spell": i18n("midi-qol.spell-damage"),
      "power": i18n("midi-qol.spell-damage"),
      "nonmagic": i18n("midi-qol.NonMagical"),
      "magic": i18n("midi-qol.Magical"),
      "physical": i18n("midi-qol.NonMagicalPhysical")
    }
  }

  if (configSettings.allowUseMacro) {
    config.characterFlags["DamageBonusMacro"] = {
      hint: i18n("midi-qol.DamageMacro.Hint"),
      name: i18n("midi-qol.DamageMacro.Name"),
      placeholder: "",
      section: i18n("midi-qol.DAEMidiQOL"),
      type: String
    };
  };
}
/* ------------------------------------ */
/* When ready							*/
/* ------------------------------------ */
Hooks.once('ready', function () {
  //@ts-expect-error
  const config = game.system.config;
  addConfigOptions();
  allDamageTypes = {};
  allDamageTypes.none = foundry.utils.duplicate(config.damageTypes["midi-none"]);
  allDamageTypes.none.label = i18n(`${SystemString}.None`);
  allDamageTypes[""] = allDamageTypes.none
  allDamageTypes = foundry.utils.mergeObject(allDamageTypes, foundry.utils.mergeObject(config.damageTypes, config.healingTypes, { inplace: false }));
  registerSettings();
  gameStats = new RollStats();
  actorAbilityRollPatching();
  setupMidiStatusEffects();

  MQOnUseOptions = {
    "preTargeting": "Called before targeting is resolved (*)",
    "preItemRoll": "Called before the item is rolled (*)",
    "templatePlaced": "Only called once a template is placed",
    "preambleComplete": "After targeting complete",
    "preAttackRoll": "Before Attack Roll",
    "preCheckHits": "Before Check Hits",
    "postAttackRoll": "After Attack Roll",
    "preSave": "Before Save",
    "postSave": "After Save",
    "preDamageRoll": "Before Damage Roll",
    "postDamageRoll": "After Damage Roll",
    "damageBonus": "return a damage bonus",
    "preDamageApplication": "Before Damage Application",
    "preActiveEffects": "Before Active Effects",
    "postActiveEffects": "After Active Effects ",
    "isTargeted": "Target is targeted but before item is rolled",
    "isPreAttacked": "Target is about to be attacked, before reactions are checked",
    "isAttacked": "Target is attacked",
    "isHit": "Target is hit",
    "preTargetSave": "Target is about to roll a saving throw",
    "isSave": "Target rolled a save",
    "isSaveSuccess": "Target rolled a successful save",
    "isSaveFailure": "Target failed a saving throw",
    "preTargetDamageApplication": "Target is about to be damaged by an item",
    "postTargetEffectApplication": "Target has an effect applied by a rolled item",
    "isDamaged": "Target is damaged by an attack",
    "all": "All"
  }
  for (let key of Object.keys(Workflow.stateTable)) {
    const camelKey = `${key.charAt(0).toUpperCase()}${key.slice(1)}`;
    if (MQOnUseOptions[`pre${camelKey}`] === undefined) {
      MQOnUseOptions[`pre${camelKey}`] = `Before state ${camelKey}`;
    } else console.error(`midi-qol | pre${camelKey} already exists`);
    if (MQOnUseOptions[`post${camelKey}`] === undefined) {
      MQOnUseOptions[`post${camelKey}`] = `After state ${camelKey}`;
    } else console.error(`midi-qol | post${camelKey} already exists`);
  }
  OnUseMacroOptions.setOptions(MQOnUseOptions);
  globalThis.MidiQOL.MQOnUseOptions = MQOnUseOptions;

  MidiSounds.midiSoundsReadyHooks();

  if (game.system.id === "dnd5e") {
    //@ts-expect-error
    game.system.config.characterFlags["spellSniper"] = {
      name: "Spell Sniper",
      hint: "Spell Sniper",
      section: i18n("DND5E.Feats"),
      type: Boolean
    };
    //@ts-expect-error
    game.system.config.areaTargetTypes["squareRadius"] = { label: i18n("midi-qol.squareRadius"), template: "rect" };

    if (game.user?.isGM) {
      const instanceId = game.settings.get(MODULE_ID, "instanceId");
      //@ts-expect-error instanceId
      if ([undefined, ""].includes(instanceId)) {
        game.settings.set(MODULE_ID, "instanceId", foundry.utils.randomID());
      }
      const oldVersion = game.settings.get(MODULE_ID, "last-run-version");
      //@ts-expect-error version
      const newVersion = game.modules.get(MODULE_ID)?.version;
      //@ts-expect-error
      if (foundry.utils.isNewerVersion(newVersion, oldVersion)) {
        console.warn(`midi-qol | instance ${game.settings.get(MODULE_ID, "instanceId")} version change from ${oldVersion} to ${newVersion}`);
        game.settings.set(MODULE_ID, "last-run-version", newVersion);
        // look at sending a new version has been installed.
      }
      readySettingsSetup();
    }
    Hooks.callAll("midi-qol.ready")
  }

  if (game.user?.isGM) {
    if (installedModules.get("levelsautocover") && configSettings.optionalRules.coverCalculation === "levelsautocover" && !game.settings.get("levelsautocover", "apiMode")) {
      game.settings.set("levelsautocover", "apiMode", true)
      if (game.user?.isGM)
        ui.notifications?.warn("midi-qol | setting levels auto cover to api mode", { permanent: true })
    } else if (installedModules.get("levelsautocover") && configSettings.optionalRules.coverCalculation !== "levelsautocover" && game.settings.get("levelsautocover", "apiMode")) {
      ui.notifications?.warn("midi-qol | Levels Auto Cover is in API mode but midi is not using levels auto cover - you may wish to disable api mode", { permanent: true })
    }
  }
  //@ts-ignore game.version
  if (foundry.utils.isNewerVersion(game.version ? game.version : game.version, "0.8.9")) {
    const noDamageSavesText: string = i18n("midi-qol.noDamageonSaveSpellsv9");
    noDamageSaves = noDamageSavesText.split(",")?.map(s => s.trim()).map(s => cleanSpellName(s));
  } else {
    //@ts-ignore
    noDamageSaves = i18n("midi-qol.noDamageonSaveSpells")?.map(name => cleanSpellName(name));
  }
  checkModules();
  if (game.user?.isGM && configSettings.gmLateTargeting !== "none") {
    ui.notifications?.notify("Late Targeting has been replaced with Target Confirmation. Please update your settings", "info", { permanent: true });
    new TargetConfirmationConfig({}, {}).render(true);
    configSettings.gmLateTargeting = "none";
    game.settings.set(MODULE_ID, "ConfigSettings", configSettings)
  }
  if (!game.user?.isGM && game.settings.get(MODULE_ID, "LateTargeting") !== "none") {
    ui.notifications?.notify("Late Targeting has been replaced with Target Confirmation. Please update your settings", "info", { permanent: true });
    new TargetConfirmationConfig({}, {}).render(true);
    game.settings.set(MODULE_ID, "LateTargeting", "none");
  }
  readyHooks();
  readyPatching();

  if (midiSoundSettingsBackup) game.settings.set(MODULE_ID, "MidiSoundSettings-backup", midiSoundSettingsBackup)

  // Make midi-qol targets hoverable
  $(document).on("mouseover", ".midi-qol-target-name", (e) => {
    const tokenid = e.currentTarget.id
    const tokenObj = canvas?.tokens?.get(tokenid)
    if (!tokenObj) return;
    //@ts-ignore
    tokenObj._hover = true
  });

  if (installedModules.get("betterrolls5e")) {
    //@ts-ignore console:
    ui.notifications?.error("midi-qol automation disabled", { permanent: true, console: true })
    //@ts-ignore console:
    ui.notifications?.error("Please make sure betterrolls5e is disabled", { permanent: true, console: true })
    //@ts-ignore console:
    ui.notifications?.error("Until further notice better rolls is NOT compatible with midi-qol", { permanent: true, console: true })
    disableWorkflowAutomation();
    setTimeout(disableWorkflowAutomation, 2000)
  }
  Hooks.callAll("midi-qol.midiReady");
  if (
    installedModules.get("lmrtfy")
    //@ts-expect-error
    && foundry.utils.isNewerVersion("3.1.8", game.modules.get("lmrtfy").version)) {
    let abbr = {};

    for (let key in CONFIG[SystemString].abilities) {
      let abb = game.i18n.localize(CONFIG[SystemString].abilities[key].abbreviation);
      let upperFirstLetter = abb.charAt(0).toUpperCase() + abb.slice(1);
      abbr[`${abb}`] = `${SystemString}.Ability${upperFirstLetter}`;
    }
    //@ts-expect-error
    LMRTFY.saves = abbr;
    //@ts-expect-error
    LMRTFY.abilities = abbr;
    //@ts-expect-error
    LMRTFY.abilityModifiers = LMRTFY.parseAbilityModifiers();
  }
  if (game.user?.isGM) { // need to improve the test
    const problems = TroubleShooter.collectTroubleShooterData().problems
    for (let problem of problems) {
      const message = `midi-qol ${problem.problemSummary} | Open TroubleShooter to fix`;
      if (problem.severity === "Error")
        ui.notifications?.error(message, { permanent: false });
      else console.warn(message);
    }
  }
});

import { setupMidiTests } from './module/tests/setupTest.js';
import { TargetConfirmationConfig } from './module/apps/TargetConfirmationConfig.js';
import { defineChatMessageMidiClass } from './module/ChatMessageMidi.js';
Hooks.once("midi-qol.midiReady", () => {
  setupMidiTests();
});

// Add any additional hooks if necessary
Hooks.on("monaco-editor.ready", (registerTypes) => {
  registerTypes("midi-qol/index.ts", `
  const MidiQOL = {
    addRollTo: function addRollTo(roll: Roll, bonusRoll: Roll): Roll,
    addConcentration: async function addConcentration(actorRef: Actor | string, concentrationData: ConcentrationData): Promise<void>,
    addConcentrationDependent: async function addConcentrationDependent(actor: ActorRef, dependent, item?: Item),
    applyTokenDamage: async function applyTokenDamage(damageDetail, totalDamage, theTargets, item, saves, options: any = { existingDamage: [], superSavers: new Set(), semiSuperSavers: new Set(), workflow: undefined, updateContext: undefined, forceApply: false, noConcentrationCheck: false }): Promise<any[]>,
    canSense: function canSense(tokenEntity: Token | TokenDocument | string, targetEntity: Token | TokenDocument | string, validModes: Array<string> = ["all"]): boolean,
    canSense: function canSee(tokenEntity: Token | TokenDocument | string, targetEntity: Token | TokenDocument | string): boolean,
    cansSenseModes: function canSenseModes(tokenEntity: Token | TokenDocument | string, targetEntity: Token | TokenDocument | string, validModes: Array<string> = ["all"]): Array<string>,
    checkDistance: function checkDistnce(tokenEntity1: Token | TokenDocument | string, tokenEntity2: Token | TokenDocument | string, distance: number, wallsBlock?: boolean): boolean,
    checkIncapacitated: function checkIncapacitated(actor: Actor, logResult?: true): boolean,
    checkNearby: function checkNearby(tokenEntity: Token | TokenDocument | string, targetEntity: Token | TokenDocument | string, range: number): boolean,
    checkRange: function checkRange(tokenEntity: Token | TokenDocument | string, targetEntity: Token | TokenDocument | string, range: number): boolean,
    checkRule: function checkRule(rule: string): boolean,
    completeItemUse: async function completeItemUse(item, config: any = {}, options: any = { checkGMstatus: false }),
    computeCoverBonus: function computeCoverBonus(attacker: Token | TokenDocument, target: Token | TokenDocument, item: any = undefined): number,
    computeDistance: function computeDistance(t1: Token, t2: Token, wallBlocking = false),
    configSettings: function configSettings(): any,
    contestedRoll: async function contestedRoll(data: {
      source: { rollType: string, ability: string, token: Token | TokenDocument | string, rollOptions: any },
      target: { rollType: string, ability: string, token: Token | TokenDocument | string, rollOptions: any },
      displayResults: boolean,
      itemCardId: string,
      flavor: string,
      rollOptions: any,
      success: (results) => {}, failure: (results) => {}, drawn: (results) => {}
    }): Promise<{ result: number | undefined, rolls: any[] }>,
    createConditionData: function createConditionData(data: { workflow?: Workflow | undefined, target?: Token | TokenDocument | undefined, actor?: Actor | undefined, item?: Item | string | undefined, extraData?: any }
    DamageOnlyWorkflow: class DamageOnlyWorkflow,
    debug: function debug(...args: any[]): void,
    displayDSNForRoll: async function displayDSNForRoll(roll: Roll | undefined, rollType: string | undefined, defaultRollMode: string | undefined = undefined),
    doMidiConcentrationCheck: async function doMidiConcentrationCheck(actor: Actor, saveDC),
    evalAllConditions: function evalAllConditions(actor: Actor | Token | TokenDocument | string, flagRef: string, conditionData: any, errorReturn: any = true): any,
    evalAllConditionsAsync: async unction evalAllConditions(actor: Actor | Token | TokenDocument | string, flagRef: string, conditionData: any, errorReturn: any = true): Promise<any>,
    evalCondition: function evalCondition(condition: string, conditionData: any, {errorReturn: any = true, async = false): any,
    findNearby(disposition: number | string | null | Array<string | number>, token: any /*Token | uuuidString */, distance: number, options: { maxSize: number | undefined, includeIncapacitated: boolean | undefined, canSee: boolean | undefined, isSeen: boolean | undefined, includeToken: boolean | undefined, relative: boolean | undefined } = { maxSize: undefined, includeIncapacitated: false, canSee: false, isSeen: false, includeToken: false, relative: true }): Token[],
    findNearbyCount(disposition: number | string | null | Array<string | number>, token: any /*Token | uuuidString */, distance: number, options: { maxSize: number | undefined, includeIncapacitated: boolean | undefined, canSee: boolean | undefined, isSeen: boolean | undefined, includeToken: boolean | undefined, relative: boolean | undefined } = { maxSize: undefined, includeIncapacitated: false, canSee: false, isSeen: false, includeToken: false, relative: true }): number;
    getCachedChatMessage(),
    getChanges: function getChanges(actorOrItem: Actor | Item, key: string): any[],
    getConcentrationEffect: function getConcentrationEffect(actor: Actor): ActiveEffect | undefined,
    geti18nOptions: function geti18nOptions(key: string): any,
    geti18nTranslations: function geti18nTranslations(): any,
    getTokenForActor: function getTokenForActor(actor: Actor): Token | undefined,
    getTokenForActorAsSet: function getTokenForActorAsSet(actor: Actor): Set<Token>,
    getTokenPlayerName: function getTokenPlayerName(token: Token | TokenDocument | string): string,
    getTraitMult: function getTraitMult(actor: Actor, damageType: string, item: Item): number,
    hasCondition: function hasCondition(tokenRef: Token | TokenDocument | UUID, condition: string): boolean,
    hasUsedBonusAction: function hasUsedBonusAction(actor: Actor): boolean,
    hasUsedReaction: function hasUsedReaction(actor: Actor): boolean,
    incapacitatedConditions: string[],
    InvisibleDisadvantageVisionModes: string[],
    isTargetable: function isTargetable(token: Token | TokenDocument | UUID): boolean,
    TargetConfirmationDialog: class TargetConfirmationDialog,
    log: function log(...args: any[]): void,
    midiFlags: string[],
    midiRenderRoll: function midiRenderRoll(roll: Roll),
    midiRenderAttackRoll: function midiRenderAttackRoll(roll, options);
    midiRenderDamageRoll: function midiRenderDamageRoll(roll, options);
    midiRenderBonusDamageRoll: function midiRenderBonusDamageRoll(roll, options);
    midiRenderOtherDamageRoll: function midiRenderOtherDamageRoll(roll, options);
    midiSoundSettings: function(): any,
    MQfromActorUuid: function MQfromActorUuid(actorUuid: string): Actor | undefined,
    MQfromUuid: function MQfromUuid(uuid: string): Actor | Item | TokenDocument | undefined,
    MQOnUseOptions: any,
    overTimeJSONData: any,
    playerFor: function playerFor(target: TokenDocument | Token | undefined): User | undefined,
    playerForActor: function playerForActor(actor: Actor): User | undefined,
    raceOrType(entity: Token | Actor | TokenDocument | string): string,
    reactionDialog: class reactionDialog,
    typeOrRace(entity: Token | Actor | TokenDocument | string): string,
    reportMidiCriticalFlags: function reportMidiCriticalFlags(): void,
    removeHiddentCondition: async function removeHiddenCondition(tokenRef: Token | TokenDocument | UUID), 
    removeInvisibleCondition: async function removeInvisibleCondition(tokenRef: Token | TokenDocument | UUID),
    resolveTargetConfirmation: async function resolveTargetConfirmation(targetConfirmation: any, item: Item, actor: Actor, token: Token, targets: any, options: any = { existingDamage: [], superSavers: new Set(), semiSuperSavers: new Set(), workflow: undefined, updateContext: undefined, forceApply: false, noConcentrationCheck: false }): Promise<any[]>,
    safeGetGameSettings function safeGetGameSetting(module: string key: string): string | undefined,
    selectTargetsForTemplate: templateTokens,
    removeBonusActionUsed: function removeBonusActionUsed(actor: Actor): boolean,
    setBonusActionUsed: function setBonusActionUsed(actor: Actor): boolean,
    removeBonusActionUsed: function removeBonusActionUsed(actor: Actor): boolean,
    setReactionUsed: function setReactionUsed(actor: Actor): boolean,
    removeReactionUsed: function removeReactionUsed(actor: Actor): boolean,
    showItemInfo: async function showItemInfo(item: Item): void,
    showUndoQueue: function showUndoQueue(): void,
    showUndoWorkflowApp: function showUndoWorkflowApp(): void,
    socket: function socket(): SaferSocket,
    testfunc,
    tokenForActor: function tokenForActor(actor: Actor): Token | undefined,
    TrapWorkflow: class TrapWorkflow extends Workflow,
    TroubleShooter: class TroubleShooter,
    undoMostRecentWorkflow,
    validRollAbility: function validRollAbility(rollType: string, ability: string): string | undefined,
    WallsBlockConditions: string[],
    warn: function warn(...args: any[]): void,
    Workflow: class Workflow,
    moveToken: async function (tokenRef: Token | TokenDocument | UUID, newCenter: { x: number, y: number }, animate: boolean = true),
    moveTokenAwayFromPoint: async function (targetRef: Token | TokenDocument | UUID, distance: number, point: { x: number, y: number }, animate: boolean = true),
  }
});

`);
});// Backwards compatability
function setupMidiQOLApi() {

  //@ts-expect-error .detectionModes
  const detectionModes = CONFIG.Canvas.detectionModes;
  let InvisibleDisadvantageVisionModes = Object.keys(detectionModes)
    .filter(dm => !detectionModes[dm].imprecise);

  let WallsBlockConditions = [
    "burrow"
  ];

  let humanoid = ["human", "humanoid", "elven", "elf", "half-elf", "drow", "dwarf", "dwarven", "halfling", "gnome", "tiefling", "orc", "dragonborn", "half-orc"];
  const Workflows = { "Workflow": Workflow, "DamageOnlyWorkflow": DamageOnlyWorkflow, "TrapWorkflow": TrapWorkflow, "DummyWorkflow": DummyWorkflow, "DDBGameLogWorkflow": DDBGameLogWorkflow };
  //@ts-ignore
  globalThis.MidiQOL = foundry.utils.mergeObject(globalThis.MidiQOL ?? {}, {
    addConcentration,
    addConcentrationDependent,
    addRollTo,
    addUndoChatMessage,
    applyTokenDamage,
    canSee,
    canSense,
    canSenseModes,
    checkIncapacitated,
    checkDistance,
    checkNearby,
    checkRange,
    checkRule,
    completeItemRoll,
    completeItemUse,
    computeCoverBonus,
    computeDistance: getDistanceSimple,
    ConfigPanel,
    configSettings: () => { return configSettings },
    get currentConfigSettings() { return configSettings },
    collectSettingData,
    contestedRoll,
    createConditionData,
    createDamageDetail,
    DamageOnlyWorkflow,
    debouncedUpdate,
    debug,
    displayDSNForRoll,
    doConcentrationCheck,
    doOverTimeEffect,
    evalAllConditions,
    evalCondition,
    DummyWorkflow,
    chooseEffect,
    enableWorkflow,
    findNearby,
    findNearbyCount,
    gameStats,
    getCachedChatMessage: getCachedDocument,
    getChanges, // (actorOrItem, key) - what effects on the actor or item target the specific key
    getConcentrationEffect,
    getDistance: getDistanceSimpleOld,
    geti18nOptions,
    geti18nTranslations,
    getTokenPlayerName,
    getTokenForActor,
    getTokenForActorAsSet,
    getTraitMult: getTraitMult,
    getUndoQueue,
    hasCondition,
    hasUsedBonusAction,
    hasUsedReaction,
    humanoid,
    incapacitatedConditions: ["incapacitated", "Convenient Effect: Incapacitated", "stunned", "Convenient Effect: Stunned", "paralyzed", "paralysis", "Convenient Effect: Paralyzed", "unconscious", "Convenient Effect: Unconscious", "dead", "Convenient Effect: Dead", "petrified", "Convenient Effect: Petrified"],
    InvisibleDisadvantageVisionModes,
    isTargetable,
    TargetConfirmationDialog,
    log,
    midiFlags,
    midiRenderRoll,
    midiRenderAttackRoll,
    midiRenderDamageRoll,
    midiRenderBonusDamageRoll,
    midiRenderOtherDamageRoll,
    midiSoundSettings: () => { return midiSoundSettings },
    MQfromActorUuid: fromActorUuid,
    actorFromUuid,
    MQfromUuid: MQfromUuidSync,
    MQfromUuidSync,
    MQOnUseOptions,
    overTimeJSONData,
    playerFor,
    playerForActor,
    raceOrType,
    typeOrRace,
    reactionDialog,
    removeHiddenCondition,
    removeInvisibleCondition,
    removeMostRecentWorkflow,
    removeActionUsed,
    removeBonusActionUsed,
    removeReactionUsed,
    reportMidiCriticalFlags,
    resolveTargetConfirmation,
    safeGetGameSetting,
    selectTargetsForTemplate: templateTokens,
    setBonusActionUsed,
    setReactionUsed,
    showItemInfo: (item) => { return showItemInfo.bind(item)() },
    showUndoQueue,
    showUndoWorkflowApp,
    socket: () => { return new SaferSocket(socketlibSocket) },
    testfunc,
    tokenForActor,
    TrapWorkflow,
    TroubleShooter,
    undoMostRecentWorkflow,
    validRollAbility,
    WallsBlockConditions,
    warn,
    Workflow,
    UserWorkflow,
    workflowClass: Workflow,
    Workflows,
    moveToken: async (tokenRef: Token | TokenDocument | string, newCenter: { x: number, y: number }, animate: boolean = true) => {
      const tokenUuid = getTokenDocument(tokenRef)?.uuid;
      if (tokenUuid) return untimedExecuteAsGM("moveToken", { tokenUuid, newCenter, animate });
    },
    moveTokenAwayFromPoint: async (targetRef: Token | TokenDocument | string, distance: number, point: { x: number, y: number }, animate: boolean = true) => {
      const targetUuid = getTokenDocument(targetRef)?.uuid;
      if (point && targetUuid && distance)
        return untimedExecuteAsGM("moveTokenAwayFromPoint", { targetUuid, distance, point, animate })
    }
  });
  globalThis.MidiDAEEval = {
    testfunc,
    canSee,
    canSense,
    canSenseModes,
    checkIncapacitated,
    checkDistance,
    checkNearby,
    checkRange,
    checkRule,
    computeCoverBonus,
    computeDistance: getDistanceSimple,
    contestedRoll,
    displayDSNForRoll,
    doConcentrationCheck,
    chooseEffect,
    findNearby,
    findNearbyCount,
    getDistance: getDistanceSimpleOld,
    getTraitMult: getTraitMult,
    hasCondition,
    hasUsedBonusAction,
    hasUsedReaction,
    humanoid,
    isTargetable,
    raceOrType,
    typeOrRace,
    safeGetGameSetting,
    setBonusActionUsed,
    setReactionUsed,
  }
  globalThis.MidiQOL.actionQueue = new foundry.utils.Semaphore();
  Hooks.callAll("midi-qol.setup", globalThis.MidiQOL);
}

export function testfunc(scope) {
  console.warn("MidiQOL testfunc called ", scope)
}

// Minor-qol compatibility patching
function doRoll(event = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, type: "none" }, itemName, options = { type: "", versatile: false }) {
  error("doRoll is deprecated. Please use item.use() instead");
}

function setupMidiFlags() {
  //@ts-expect-error
  let config = game.system.config;
  //@ts-expect-error
  const systemVersion = game.system.version;
  midiFlags.push(`flags.${MODULE_ID}.advantage.all`)
  midiFlags.push(`flags.${MODULE_ID}.disadvantage.all`)
  midiFlags.push(`flags.${MODULE_ID}.advantage.attack.all`)
  midiFlags.push(`flags.${MODULE_ID}.disadvantage.attack.all`)
  midiFlags.push(`flags.${MODULE_ID}.critical.all`)
  midiFlags.push(`flags.${MODULE_ID}.max.damage.all`);
  midiFlags.push(`flags.${MODULE_ID}.min.damage.all`);
  midiFlags.push(`flags.${MODULE_ID}.grants.max.damage.all`);
  midiFlags.push(`flags.${MODULE_ID}.grants.min.damage.all`);
  midiFlags.push(`flags.${MODULE_ID}.noCritical.all`);
  midiFlags.push(`flags.${MODULE_ID}.fail.all`);
  midiFlags.push(`flags.${MODULE_ID}.fail.attack.all`);
  midiFlags.push(`flags.${MODULE_ID}.success.attack.all`);
  midiFlags.push(`flags.${MODULE_ID}.grants.advantage.attack.all`);
  midiFlags.push(`flags.${MODULE_ID}.grants.advantage.save.all`)
  midiFlags.push(`flags.${MODULE_ID}.grants.advantage.check.all`)
  midiFlags.push(`flags.${MODULE_ID}.grants.advantage.skill.all`)
  midiFlags.push(`flags.${MODULE_ID}.grants.disadvantage.attack.all`);
  midiFlags.push(`flags.${MODULE_ID}.grants.disadvantage.save.all`)
  midiFlags.push(`flags.${MODULE_ID}.grants.disadvantage.check.all`)
  midiFlags.push(`flags.${MODULE_ID}.grants.disadvantage.skill.all`)
  midiFlags.push(`flags.${MODULE_ID}.grants.fail.advantage.attack.all`);
  midiFlags.push(`flags.${MODULE_ID}.grants.fail.disadvantage.attack.all`);
  midiFlags.push(`flags.${MODULE_ID}.neverTarget`);
  midiFlags.push(`flags.${MODULE_ID}.grants.attack.success.all`);
  midiFlags.push(`flags.${MODULE_ID}.grants.attack.fail.all`);
  midiFlags.push(`flags.${MODULE_ID}.grants.attack.bonus.all`);
  midiFlags.push(`flags.${MODULE_ID}.grants.critical.all`);
  midiFlags.push(`flags.${MODULE_ID}.grants.critical.range`);
  midiFlags.push(`flags.${MODULE_ID}.grants.criticalThreshold`);
  midiFlags.push(`flags.${MODULE_ID}.fail.critical.all`);
  midiFlags.push(`flags.${MODULE_ID}.grants.noCritical.all`);
  midiFlags.push(`flags.${MODULE_ID}.advantage.concentration`)
  midiFlags.push(`flags.${MODULE_ID}.disadvantage.concentration`)
  midiFlags.push(`flags.${MODULE_ID}.ignoreNearbyFoes`);
  midiFlags.push(`flags.${MODULE_ID}.`)
  midiFlags.push(`flags.${MODULE_ID}.concentrationSaveBonus`);
  midiFlags.push(`flags.${MODULE_ID}.potentCantrip`);
  midiFlags.push(`flags.${MODULE_ID}.sculptSpells`);
  midiFlags.push(`flags.${MODULE_ID}.carefulSpells`);
  midiFlags.push(`flags.${MODULE_ID}.magicResistance.all`);
  midiFlags.push(`flags.${MODULE_ID}.magicResistance.save.all`);
  midiFlags.push(`flags.${MODULE_ID}.magicResistance.check.all`);
  midiFlags.push(`flags.${MODULE_ID}.magicResistance.skill.all`);
  midiFlags.push(`flags.${MODULE_ID}.magicVulnerability.all`);
  midiFlags.push(`flags.${MODULE_ID}.rangeOverride.attack.all`);
  midiFlags.push(`flags.${MODULE_ID}.range.all`);
  midiFlags.push(`flags.${MODULE_ID}.long.all`);
  let attackTypes = allAttackTypes.concat(["heal", "other", "save", "util"])
  evalCondition
  attackTypes.forEach(at => {
    midiFlags.push(`flags.${MODULE_ID}.range.${at}`);
    midiFlags.push(`flags.${MODULE_ID}.long.${at}`);
    midiFlags.push(`flags.${MODULE_ID}.advantage.attack.${at}`);
    midiFlags.push(`flags.${MODULE_ID}.disadvantage.attack.${at}`);
    midiFlags.push(`flags.${MODULE_ID}.fail.attack.${at}`);
    midiFlags.push(`flags.${MODULE_ID}.success.attack.${at}`);
    midiFlags.push(`flags.${MODULE_ID}.critical.${at}`);
    midiFlags.push(`flags.${MODULE_ID}.noCritical.${at}`);
    midiFlags.push(`flags.${MODULE_ID}.grants.advantage.attack.${at}`);
    midiFlags.push(`flags.${MODULE_ID}.grants.fail.advantage.attack.${at}`);
    midiFlags.push(`flags.${MODULE_ID}.grants.disadvantage.attack.${at}`);
    midiFlags.push(`flags.${MODULE_ID}.grants.fail.disadvantage.attack.${at}`);
    midiFlags.push(`flags.${MODULE_ID}.grants.critical.${at}`);
    midiFlags.push(`flags.${MODULE_ID}.grants.noCritical.${at}`);
    midiFlags.push(`flags.${MODULE_ID}.fail.critical.${at}`);
    midiFlags.push(`flags.${MODULE_ID}.grants.attack.bonus.${at}`);
    midiFlags.push(`flags.${MODULE_ID}.grants.attack.success.${at}`);
    if (at !== "heal") midiFlags.push(`flags.${MODULE_ID}.DR.${at}`);
    midiFlags.push(`flags.${MODULE_ID}.max.damage.${at}`);
    midiFlags.push(`flags.${MODULE_ID}.min.damage.${at}`);
    midiFlags.push(`flags.${MODULE_ID}.grants.max.damage.${at}`);
    midiFlags.push(`flags.${MODULE_ID}.grants.min.damage.${at}`);
    midiFlags.push(`flags.${MODULE_ID}.optional.NAME.attack.${at}`);
    midiFlags.push(`flags.${MODULE_ID}.optional.NAME.attack.fail.${at}`);

    midiFlags.push(`flags.${MODULE_ID}.optional.NAME.damage.${at}`);
    midiFlags.push(`flags.${MODULE_ID}.rangeOverride.attack.${at}`);
  });
  midiFlags.push(`flags.${MODULE_ID}.advantage.ability.all`);
  midiFlags.push(`flags.${MODULE_ID}.advantage.ability.check.all`);
  midiFlags.push(`flags.${MODULE_ID}.advantage.ability.save.all`);
  midiFlags.push(`flags.${MODULE_ID}.disadvantage.ability.all`);
  midiFlags.push(`flags.${MODULE_ID}.disadvantage.ability.check.all`);
  midiFlags.push(`flags.${MODULE_ID}.disadvantage.ability.save.all`);
  midiFlags.push(`flags.${MODULE_ID}.fail.ability.all`);
  midiFlags.push(`flags.${MODULE_ID}.fail.ability.check.all`);
  midiFlags.push(`flags.${MODULE_ID}.fail.ability.save.all`);
  midiFlags.push(`flags.${MODULE_ID}.superSaver.all`);
  midiFlags.push(`flags.${MODULE_ID}.semiSuperSaver.all`);
  midiFlags.push(`flags.${MODULE_ID}.max.ability.save.all`);
  midiFlags.push(`flags.${MODULE_ID}.max.ability.check.all`);
  midiFlags.push(`flags.${MODULE_ID}.max.ability.save.concentration`);
  midiFlags.push(`flags.${MODULE_ID}.min.ability.save.all`);
  midiFlags.push(`flags.${MODULE_ID}.min.ability.check.all`);
  midiFlags.push(`flags.${MODULE_ID}.min.ability.save.concentration`);
  midiFlags.push(`flags.${MODULE_ID}.sharpShooter`);

  Object.keys(config.abilities).forEach(abl => {
    midiFlags.push(`flags.${MODULE_ID}.advantage.ability.check.${abl}`);
    midiFlags.push(`flags.${MODULE_ID}.disadvantage.ability.check.${abl}`);
    midiFlags.push(`flags.${MODULE_ID}.advantage.ability.save.${abl}`);
    midiFlags.push(`flags.${MODULE_ID}.disadvantage.ability.save.${abl}`);
    midiFlags.push(`flags.${MODULE_ID}.advantage.attack.${abl}`);
    midiFlags.push(`flags.${MODULE_ID}.disadvantage.attack.${abl}`);
    midiFlags.push(`flags.${MODULE_ID}.fail.ability.check.${abl}`);
    midiFlags.push(`flags.${MODULE_ID}.fail.ability.save.${abl}`);
    midiFlags.push(`flags.${MODULE_ID}.superSaver.${abl}`);
    midiFlags.push(`flags.${MODULE_ID}.semiSuperSaver.${abl}`);
    midiFlags.push(`flags.${MODULE_ID}.max.ability.save.${abl}`);
    midiFlags.push(`flags.${MODULE_ID}.min.ability.save.${abl}`);
    midiFlags.push(`flags.${MODULE_ID}.max.ability.check.${abl}`);
    midiFlags.push(`flags.${MODULE_ID}.min.ability.check.${abl}`);
    midiFlags.push(`flags.${MODULE_ID}.optional.NAME.save.${abl}`);
    midiFlags.push(`flags.${MODULE_ID}.optional.NAME.save.fail.${abl}`);
    midiFlags.push(`flags.${MODULE_ID}.optional.NAME.check.${abl}`);
    midiFlags.push(`flags.${MODULE_ID}.optional.NAME.check.fail.${abl}`);
    midiFlags.push(`flags.${MODULE_ID}.magicResistance.${abl}`);
    midiFlags.push(`flags.${MODULE_ID}.magicVulnerability.all.${abl}`);
    midiFlags.push(`flags.${MODULE_ID}.grants.advantage.save.${abl}`);
    midiFlags.push(`flags.${MODULE_ID}.grants.advantage.check.${abl}`);
    midiFlags.push(`flags.${MODULE_ID}.grants.advantage.skill.${abl}`);
    midiFlags.push(`flags.${MODULE_ID}.grants.disadvantage.save.${abl}`);
    midiFlags.push(`flags.${MODULE_ID}.grants.disadvantage.check.${abl}`);
    midiFlags.push(`flags.${MODULE_ID}.grants.disadvantage.skill.${abl}`);
  })

  midiFlags.push(`flags.${MODULE_ID}.advantage.skill.all`);
  midiFlags.push(`flags.${MODULE_ID}.disadvantage.skill.all`);
  midiFlags.push(`flags.${MODULE_ID}.fail.skill.all`);
  midiFlags.push(`flags.${MODULE_ID}.max.skill.all`);
  midiFlags.push(`flags.${MODULE_ID}.min.skill.all`);
  Object.keys(config.skills).forEach(skill => {
    midiFlags.push(`flags.${MODULE_ID}.advantage.skill.${skill}`);
    midiFlags.push(`flags.${MODULE_ID}.disadvantage.skill.${skill}`);
    midiFlags.push(`flags.${MODULE_ID}.fail.skill.${skill}`);
    midiFlags.push(`flags.${MODULE_ID}.max.skill.${skill}`);
    midiFlags.push(`flags.${MODULE_ID}.min.skill.${skill}`);
    midiFlags.push(`flags.${MODULE_ID}.optional.NAME.skill.${skill}`);
  })
  midiFlags.push(`flags.${MODULE_ID}.advantage.deathSave`);
  midiFlags.push(`flags.${MODULE_ID}.disadvantage.deathSave`);

  if (game.system.id === "dnd5e") {
    // fix for translations
    ["vocal", "somatic", "material"].forEach(comp => {
      midiFlags.push(`flags.${MODULE_ID}.fail.spell.${comp.toLowerCase()}`);
    });
    midiFlags.push(`flags.${MODULE_ID}.DR.all`);

    midiFlags.push(`flags.${MODULE_ID}.DR.non-magical`);
    midiFlags.push(`flags.${MODULE_ID}.DR.non-magical-physical`);
    midiFlags.push(`flags.${MODULE_ID}.DR.non-silver`);
    midiFlags.push(`flags.${MODULE_ID}.DR.non-adamant`);
    midiFlags.push(`flags.${MODULE_ID}.DR.non-physical`);
    midiFlags.push(`flags.${MODULE_ID}.DR.final`);
    midiFlags.push(`flags.${MODULE_ID}.damage.reroll-kh`);
    midiFlags.push(`flags.${MODULE_ID}.damage.reroll-kl`);

    Object.keys(config.damageTypes).forEach(key => {
      midiFlags.push(`flags.${MODULE_ID}.DR.${key}`);

      // TODO dbd3 - see how to present label but check key  midiFlags.push(`flags.${MODULE_ID}.DR.${config.damageTypes[key].label}`);
    });

    midiFlags.push(`flags.${MODULE_ID}.DR.healing`);
    midiFlags.push(`flags.${MODULE_ID}.DR.temphp`);
  } else if (game.system.id === "sw5e") {
    midiFlags.push(`flags.${MODULE_ID}.DR.all`);
    midiFlags.push(`flags.${MODULE_ID}.DR.final`);
    Object.keys(config.damageResistanceTypes).forEach(dt => {
      midiFlags.push(`flags.${MODULE_ID}.DR.${dt}`);
    })
    midiFlags.push(`flags.${MODULE_ID}.DR.healing`);
    midiFlags.push(`flags.${MODULE_ID}.DR.temphp`);
  }

  midiFlags.push(`flags.${MODULE_ID}.optional.NAME.attack.all`);
  midiFlags.push(`flags.${MODULE_ID}.optional.NAME.attack.fail.all`);
  midiFlags.push(`flags.${MODULE_ID}.optional.NAME.damage.all`);
  midiFlags.push(`flags.${MODULE_ID}.optional.NAME.check.all`);
  midiFlags.push(`flags.${MODULE_ID}.optional.NAME.save.all`);
  midiFlags.push(`flags.${MODULE_ID}.optional.NAME.check.fail.all`);
  midiFlags.push(`flags.${MODULE_ID}.optional.NAME.save.fail.all`);
  midiFlags.push(`flags.${MODULE_ID}.optional.NAME.label`);
  midiFlags.push(`flags.${MODULE_ID}.optional.NAME.skill.all`);
  midiFlags.push(`flags.${MODULE_ID}.optional.NAME.skill.fail.all`);
  midiFlags.push(`flags.${MODULE_ID}.optional.NAME.count`);
  midiFlags.push(`flags.${MODULE_ID}.optional.NAME.countAlt`);
  midiFlags.push(`flags.${MODULE_ID}.optional.NAME.ac`);
  midiFlags.push(`flags.${MODULE_ID}.optional.NAME.criticalDamage`);
  midiFlags.push(`flags.${MODULE_ID}.optional.NAME.activation`);
  midiFlags.push(`flags.${MODULE_ID}.optional.NAME.force`);

  midiFlags.push(`flags.${MODULE_ID}.uncanny-dodge`);
  midiFlags.push(`flags.${MODULE_ID}.OverTime`);
  midiFlags.push(`flags.${MODULE_ID}.inMotion`);
  //@ts-ignore
  const damageTypes = Object.keys(config.damageTypes);
  for (let key of damageTypes) {
    midiFlags.push(`flags.${MODULE_ID}.absorption.${key}`);
  }
  midiFlags.push(`dlags.${MODULE_ID}.fail.disadvantage.heavy`);

  /*
  midiFlags.push(`flags.${MODULE_ID}.grants.advantage.attack.all`);
  midiFlags.push(`flags.${MODULE_ID}.grants.disadvantage.attack.all`);
  midiFlags.push(``);

  midiFlags.push(``);
  midiFlags.push(``);
  */
  if (installedModules.get("dae")) {
    const initDAE = async () => {
      for (let i = 0; i < 100; i++) {
        if (globalThis.DAE) {
          globalThis.DAE.addAutoFields(midiFlags);
          return true;
        } else {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      return false;
    };
    initDAE().then(value => { if (!value) console.error(`midi-qol | initDae settings failed`) });
  }
}

// Revisit to find out how to set execute as GM
const MQMacros = [
  {
    name: "MidiQOL.showTroubleShooter",
    checkVersion: true,
    version: "11.0.9",
    permission: { default: 1 },
    commandText: `
    new MidiQOL.TroubleShooter().render(true)`
  },
  {
    name: "MidiQOL.exportTroubleShooterData",
    checkVersion: true,
    version: "11.0.9.1",
    permission: { default: 1 },
    commandText: `MidiQOL.TroubleShooter.exportTroubleShooterData()`
  },
  {
    name: "MidiQOL.GMShowPlayerDamageCards",
    checkVersion: true,
    version: "11.4.10",
    commandText: `
    const matches = document.querySelectorAll(".midi-qol-player-damage-card");
    matches.forEach(element => {
      let target = element.parentElement.parentElement.parentElement;
      target.style.display = "inherit";
    })`
  }
]
export async function createMidiMacros() {
  const midiVersion = "11.0.9"
  if (game?.user?.isGM) {
    for (let macroSpec of MQMacros) {
      try {
        let existingMacros = game.macros?.filter(m => m.name === macroSpec.name) ?? [];
        if (existingMacros.length > 0) {
          for (let macro of existingMacros) {
            if (macroSpec.checkVersion
              //@ts-expect-error .flags
              && !foundry.utils.isNewerVersion(macroSpec.version, (macro.flags["midi-version"] ?? "0.0.0")))
              continue; // already up to date
            await macro.update({
              command: macroSpec.commandText,
              "flags.midi-version": macroSpec.version
            });
          }
        } else {
          const macroData = {
            _id: null,
            name: macroSpec.name,
            type: "script",
            author: game.user.id,
            img: 'icons/svg/dice-target.svg',
            scope: 'global',
            command: macroSpec.commandText,
            folder: null,
            sort: 0,
            permission: {
              default: 1,
            },
            flags: { "midi-version": macroSpec.version ?? "midiVersion" }
          };
          //@ts-expect-error
          await Macro.createDocuments([macroData]);
          log(`Macro ${macroData.name} created`);
        }
      } catch (err) {
        const message = `createMidiMacros | falied to create macro ${macroSpec.name}`
        TroubleShooter.recordError(err, message);
        error(err, message);
      }
    }
  }
}


const midiOldErrorHandler = globalThis.onerror;
function midiOnerror(event: string | Event, source?: string | undefined, lineno?: number | undefined, colno?: number | undefined, error?: Error) {
  console.warn("midi-qol detected error", event, source, lineno, colno, error);
  TroubleShooter.recordError(error, "uncaught global error");
  if (midiOldErrorHandler) return midiOldErrorHandler(event, source, lineno, colno, error);
  return false;
}

export function setupMidiStatusEffects() {
  //@ts-expect-error
  systemConcentrationId = CONFIG.specialStatusEffects.CONCENTRATING;
  //@ts-expect-error
  const imgSource = game.version < 12 ? "icon" : "img";
  if (!CONFIG.statusEffects.find(e => e.id === systemConcentrationId)) {
    //@ts-expect-error name
    CONFIG.statusEffects.push({ id: systemConcentrationId, name: i18n(`EFFECT.${SystemString}.StatusConcentrating`), [imgSource]: "systems/dnd5e/icons/svg/statuses/concentrating.svg", special: "CONCENTRATING" });
  }
  // Initialise these effects so that we don't need to make a raft of code aysnc only to fetch these
  if (configSettings.enforceBonusActions !== "none") {
    //@ts-expect-error
    if (!CONFIG.statusEffects.find(e => e._id === getStaticID("bonusaction"))) {
      //@ts-expect-error
      CONFIG.statusEffects.push({ id: "bonusaction", _id: getStaticID("bonusaction"), name: i18n("midi-qol.bonusActionUsed"), changes: [{ key: "flags.midi-qol.actions.bonus", mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: true }], [imgSource]: "modules/midi-qol/icons/bonus-action.svg", flags: { dae: { specialDuration: ["turnStart", "combatEnd", "shortRest"] } } });
    }
    //@ts-expect-error
    ActiveEffect.implementation.fromStatusEffect("bonusaction", { keepId: true }).then(effect => {
      midiBonusActionEffect = effect
      globalThis.MidiQOL.midiBonusActionEffect = effect;
    });
  }

  if (configSettings.enforceReactions !== "none") {
    //@ts-expect-error
    if (!CONFIG.statusEffects.find(e => e._id === getStaticID("reaction"))) {
      //@ts-expect-error
      CONFIG.statusEffects.push({ id: "reaction", _id: getStaticID("reaction"), name: i18n("midi-qol.reactionUsed"), changes: [{ key: "flags.midi-qol.actions.reaction", mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: true }], [imgSource]: "modules/midi-qol/icons/reaction.svg", effectData: { transfer: false }, flags: { dae: { specialDuration: ["turnStart", "combatEnd", "shortRest"] } } });
    }
    //@ts-expect-error
    ActiveEffect.implementation.fromStatusEffect("reaction", { keepId: true }).then(effect => {
      midiReactionEffect = effect;
      globalThis.MidiQOL.midiReactionEffect = effect;
    });

  }
}
// globalThis.onerror = midiOnerror;

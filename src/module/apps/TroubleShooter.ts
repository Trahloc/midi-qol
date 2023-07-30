import { data } from "@league-of-foundry-developers/foundry-vtt-types/src/foundry/common/module.mjs";
import { i18n } from "../../midi-qol.js";
import { processCreateDDBGLMessages } from "../chatMesssageHandling.js";
import { checkedModuleList, collectSettingData, configSettings } from "../settings.js";
import { getDamageType } from "../utils.js";

export class TroubleShooter extends FormApplication {
  public static errors: [{timestamp: number, error: any}];
  public static MAX_ERRORS = 10;
  constructor(object, options) {
    super(object, options);
  }

  public static recordError(...args) {
    while (this.errors.length >= this.MAX_ERRORS) this.errors.shift();
    this.errors.push({timestamp: Date.now(), error: args})
  }
  public static logErrors() {

  }
  async _updateObject(event, formData) {
  };

  static get defaultOptions() {
    const options = super.defaultOptions;
    options.title = i18n("midi-qol.TroubleShooter.Name");
    options.id = 'midi-trouble-shooter';
    options.template = 'modules/midi-qol/templates/troubleShooter.html';
    options.closeOnSubmit = true;
    options.popOut = true;
    options.width = 900;
    options.resizable = true;
    options.height = "auto";
    options.scrollY = [".tab.summary"];
    options.tabs = [{ navSelector: ".tabs", contentSelector: ".content", initial: "summary" }];
    return options;
  }

  static async troubleShooter(app) {
    await exportTroubleShooter();
  }

  getData(options: any): any {
    let data: any;
    if (!options.loadFile) data = collectTroubleShootingData();
    data.hasIncompatible = data.summary.incompatible.length > 0;
    data.hasOutOfDate = data.summary.outOfDate.length > 0;
    data.hasPossibleOutOfData = data.summary.possibleOutOfDate.length > 0;
    data.hasProblems = data.problems.length > 0;
    for (let problem of data.problems) {
      problem.fixerIsString = typeof problem.fixer === "string";
      if (problem.problemDetail) problem.problemDetail = JSON.stringify(problem.problemDetail);
    }
    console.error("data is ", data);
    return data;
  }
}

interface ProblemSpec {
  moduleId: string | undefined,
  severity: "Error" | "Warn" | "Inform",
  problemSummary: string,
  problemDetail: any | undefined,
  fixer: (() => Promise<void>) | string,
}
interface TroubleShooterData {
  summary: any,
  problems: ProblemSpec[],
  modules: any
}
function collectTroubleShootingData() {
  let data: TroubleShooterData = {
    summary: {},
    problems: [],
    modules: {}
  };

  //@ts-expect-error game.version
  const gameVersion = game.version;
  const gameSystemId = game.system.id;
  data.summary.gameSystemId = gameSystemId;
  data.summary = {
    "foundry-version": gameVersion,
    "Game System": gameSystemId,
    //@ts-expect-error .version
    "Game Version Version": game.system.version,
    //@ts-expect-error .version
    "midi-qol-version": game.modules.get("midi-qol")?.version,
    //@ts-expect-error .version
    "Dynamic Active Effects Version": game.modules.get("dae")?.version,
    "coreSettings": {
      "Photo Sensitivity": game.settings.get("core", "photosensitiveMode")
    },
    "gameSystemSettings": {
      "Diagonal Distance Setting": game.settings.get(gameSystemId, "diagonalMovement"),
      "Proficiency Variant": game.settings.get(gameSystemId, "proficiencyModifier"),
      "Collapse Item Cards": game.settings.get(gameSystemId, "autoCollapseItemCards"),
      "Critical Damage Maximize Dice": game.settings.get(gameSystemId, "criticalDamageMaxDice"),
      "Critical Damage Modifiers": game.settings.get(gameSystemId, "criticalDamageModifiers")
    }
  };

  data.summary.knownModules = {};
  checkedModuleList.forEach(moduleName => {
    if (game.modules.get(moduleName)?.active)
      //@ts-expect-error .version
      setProperty(data.summary.knownModules, moduleName, { title: game.modules.get(moduleName).title, moduleVersion: game.modules.get(moduleName)?.version, foundryVersion: game.modules.get(moduleName).compatibility?.verified });
    else
      setProperty(data.summary.knownModules, moduleName, { moduleVersion: "not installed", foundryVersion: "" });
  });

  for (let moduleData of game.modules) {
    let module: any = moduleData;
    if (!module.active && !checkedModuleList.includes(module.id)) continue;
    let moduleId = module.id === "plutonium" ? "unsupported-importer" : module.id
    data.modules[moduleId] = {
      title: module.id === "plutonium" ? "unsupported-importer" : module.title,
      active: module.active,
      version: module.version,
      compatibility: module.compatibility?.verified
    }
    switch (module.id) {
      case "about-time":
        break;
      case "anonymous":
        setProperty(data.modules[module.id], "settings", getDetailedSettings(module.id));
        break;
      case "combat-utility-belt":
        break;
      case "condition-lab-triggler":
        break;
      case "dae":
        break;
      case "ddb-game-log":
        break;
      case "df-templates":
        break;
      case "dfreds-convenient-effects":
        break;
      case "dice-so-nice":
        break;
      case "itemacro":
        setProperty(data.modules[module.id], "settings", getDetailedSettings(module.id));
        if (game.modules.get("itemacro")?.active && game.settings.get('itemacro', 'charsheet')) {
          data.problems.push({
            moduleId: "itemacro",
            severity: "Error",
            problemSummary: "Item Macro Character sheet hook is enabled. Should be turned off",
            problemDetail: undefined,
            fixer: async () => {
              await game.settings.set("itemacro", "charsheet", false);
            }
          })
        }
        break;
      case "levels":
        break;
      case "levelsautocover":
        break;
      case "levelsvolumetrictemplates":
        break;
      case "lib-changelogs":
        break;
      case "lib-wrapper":
        break;
      case "lmrtfy":
        break;
      case "midi-qol":
        setProperty(data.modules[module.id], "settings", getDetailedSettings(module.id));
        break;
      case "monks-tokenbar":
        break;
      case "multilevel-tokens":
        break;
      case "simbuls-cover-calculator":
        break;
      case "socketlib":
        break;
      case "times-up":
        if (!(game.modules.get("times-up")?.active)) {
          data.problems.push({
            moduleId: "times-up",
            severity: "Warn",
            problemSummary: "Times Up is not installed or not active. Effects won't expire",
            fixer: "Install and activate times-up",
            problemDetail: undefined
          });
        }
        break;
      case "walledtemplates":
        break;
      case "warpgate":
        setProperty(data.modules[module.id], "settings", getDetailedSettings(module.id));
        if (game.modules.get("warpgate")?.active) checkWarpgateUserPermissions(data);
        break;
      case "wjmaia":
        break;
      case "ready-set-roll-5e":
      case "betterrolls5e":
      case "rollgroups":
      case "faster-rolling-by-default-5e":
      case "quick-rolls":
      case "dice-tooltip":
      case "gm-paranoia-taragnor":
      case "wire":
      case "mre-dnd5e":
      case "retroactive-advantage-5e":
      case "max-crit":
      case "multiattack-5e":
      case "effective-transferral":
      case "attack-roll-check-5e":
      case "advancedspelleffects":
      case "obsidian":
      case "heartbeat":
      case "dice-rng-protector":
        data.modules[module.id].incompatible = true;
        break;
    }
  }
  // Check Incompatible modules
  data.summary.incompatible = Object.keys(data.modules)
    .filter(key => data.modules[key].incompatible).map(key => ({key, title: data.modules[key].title}));
  data.summary.outOfDate = Object.keys(data.modules).filter(key =>
    isNewerVersion("11", data.modules[key].compatibility ?? 0)).map(key =>
      ({ key, title: data.modules[key].title, moduleVersion: data.modules[key].version, foundryVersion: data.modules[key].compatibility }));
  data.summary.possibleOutOfDate = Object.keys(data.modules).filter(key => {
    const moduleVersion = data.modules[key].compatibility ?? "0.0.0";
    if (isNewerVersion("11", moduleVersion)) return false;
    return isNewerVersion(gameVersion, data.modules[key].compatibility ?? "0.0.0")
  }).map(key =>
    ({ key, title: data.modules[key].title, version: data.modules[key].compatibility }))

  checkCommonProblems(data);
  return data;
}

function checkWarpgateUserPermissions(data: TroubleShooterData) {
  if (!game.permissions?.TOKEN_CREATE.includes(1)) {
    const problem: ProblemSpec = {
      moduleId: "warpgate",
      severity: "Warn",
      problemSummary: "Players Do not have permission to create tokens",
      problemDetail: undefined,
      fixer: "Edit player permissions"
    }
    data.problems.push(problem);
  }
  if (!game.permissions?.TOKEN_CONFIGURE.includes(1)) {
    const problem: ProblemSpec = {
      moduleId: "warpgate",
      severity: "Warn",
      problemSummary: "Players Do not have permission to configure tokens",
      problemDetail: undefined,
      fixer: "Edit player permissions"
    }
    data.problems.push(problem);
  }
  if (!game.permissions?.FILES_BROWSE.includes(1)) {
    const problem: ProblemSpec = {
      moduleId: "warpgate",
      severity: "Warn",
      problemSummary: "Players Do not have permission to browse files",
      problemDetail: undefined,
      fixer: "Edit player permissions"
    }
    data.problems.push(problem);
  }
}
// Check for tokens with no actors
function checkNoActorTokens(data: TroubleShooterData) {
  const problemTokens = canvas?.tokens?.placeables.filter(token => !token.actor);
  if (problemTokens?.length) {
    let problem: ProblemSpec = {
      moduleId: "midi-qol",
      severity: "Error",
      problemSummary: "There are tokens with no actor in the scene",
      problemDetail: problemTokens.map(t => {
        const detail = {};
        detail[t.name] = t.document.uuid;
        return detail;
      }),
      fixer: "You should edit or remove them"
    }
    data.problems.push(problem);
  }
}

function checkMidiSettings(data: TroubleShooterData) {
  if (!Boolean(game.settings.get("midi-qol", "EnableWorkflow"))) {
    data.problems.push({
      moduleId: "midi-qol",
      severity: "Warn",
      problemSummary: "Combat automation is disabled. Need to check all clients",
      problemDetail: undefined,
      fixer: async () => {
        await game.settings.get("midi-qol", "EnableWorkflow")
      }
    });

  }
}

function checkItemMacro(data: TroubleShooterData) {
  if (game.settings.get('itemacro', 'charsheet')) {
    data.problems.push({
      moduleId: "itemacro",
      severity: "Error",
      problemSummary: "Item Macro Character sheet hook is enabled. Should be turned off",
      problemDetail: undefined,
      fixer: async () => {
        await game.settings.set("itemacro", "charsheet", false);
      }
    })
  }
}

function checkCommonProblems(data: TroubleShooterData) {
  checkMidiSettings(data);
  // checkItemMacro(data);
  checkNoActorTokens(data);
  // checkWarpgateUserPermissions(data);
}

function getDetailedSettings(moduleId: string): any {
  const returnValue = {};
  //@ts-expect-error
  let settings = Array.from(game.settings.settings).filter(i => i[0].includes(moduleId) && i[1].namespace === moduleId);
  settings.forEach(i => {
    if (typeof i[1].name !== "string") return;
    let value: any = game.settings.get(moduleId, i[1].key);
    if (typeof value !== "string") value = JSON.stringify(value);
    returnValue[i18n(i[1].name)] = value;
  });
  return returnValue;
}

export async function exportTroubleShooter() {
  const data = collectTroubleShootingData();
  const filename = "fvtt-midi-qol-troubleshooting.json"
  await saveDataToFile(JSON.stringify(data, null, 2), "text/json", filename);
}

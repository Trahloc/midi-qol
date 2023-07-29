import { i18n } from "../../midi-qol.js";
import { checkedModuleList, collectSettingData, configSettings } from "../settings.js";

export class TroubleShooter extends FormApplication {
  constructor(object, options) {
    super(object, options);
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
    // options.width = 1;
    // options.height = 1;
    return options;
  }

  static async troubleShooter(app) {
    await exportTroubleShooter();
    app.close({ force: true });

  }
}
interface ProblemSpec {
  moduleId: string | undefined,
  problemSummary: string,
  prolbemDetail: {},
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

  data.summary = {
    "Game version ": gameVersion,
    //@ts-expect-error .version
    "Midi QOL verison": game.modules.get("midi-qol")?.version,
    //@ts-expect-error .version
    "DND Version": game.system.version
  };

  data.summary.knownModules = {};
  checkedModuleList.forEach(moduleName => {
    if (game.modules.get(moduleName)?.active)
      //@ts-expect-error .version
      setProperty(data.summary.knownModules, moduleName, game.modules.get(moduleName)?.version)
    else
      setProperty(data.summary.knownModules, moduleName, "not installed");
  });

  for (let moduleData of game.modules) {
    let module: any = moduleData;
    if (!module.active && !checkedModuleList.includes(module.id)) continue;
    let moduleId = module.id === "plutonium" ? "Unsupported Importer" : module.id
    data.modules[moduleId] = {
      title: module.id === "plutonium" ? "Unsupported Importer" : module.title,
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
      case "ready-set-roll-5e":
        break;
      case "simbuls-cover-calculator":
        break;
      case "socketlib":
        break;
      case "times-up":
        break;
      case "walledtemplates":
        break;
      case "warpgate":
        data.modules["warpgate"]['Create Token'] = game.permissions?.TOKEN_CREATE.includes(1);
        data.modules["warpgate"]['Configure Token'] = game.permissions?.TOKEN_CONFIGURE.includes(1);
        data.modules["warpgate"]['Browse Files'] = game.permissions?.FILES_BROWSE.includes(1);
        setProperty(data.modules[module.id], "settings", getDetailedSettings(module.id));
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
        data.modules[module.id]["Incompatible"] = true;
        break;
    }
  }
  // Check Incompatible modules
  data.summary.incompatible = Object.keys(data.modules)
    .filter(key => data.modules[key].Incompatible);
  data.summary.outOfDate = Object.keys(data.modules).filter(key =>
    isNewerVersion("11", data.modules[key].compatibility ?? 10)).map(key =>
      ({ key, version: data.modules[key].compatibility }));
  data.summary.possibleOutOfDate = Object.keys(data.modules).filter(key => {
    const moduleVersion = data.modules[key].compatibility ?? 10;
    if (isNewerVersion("11", moduleVersion)) return false;
    return isNewerVersion(gameVersion, data.modules[key].compatibility ?? 10)
  }).map(key =>
    ({ key, version: data.modules[key].compatibility }))

    checkCommonProblems(data);
  return data;
}

// Check for tokens with no actors
function checkNoActorTokens(data: TroubleShooterData) {
  const problemTokens = canvas?.tokens?.placeables.filter(token => !token.actor);
  if (problemTokens?.length) {
    let problem: ProblemSpec = {
      moduleId: "midi-qol",
      problemSummary: "There are tokens with no actor in the scene",
      prolbemDetail: problemTokens.map(t => ({ name: t.name, id: t.id, uuid: t.document?.uuid })),
      fixer: "You will need to edit those tokens or remove them"
    }
    data.problems.push(problem);
  }
}

function checkMidiSettings(data: TroubleShooterData) {
  if (!Boolean(game.settings.get("midi-qol", "EnableWorkflow"))) {
    data.problems.push({
      moduleId: "midi-qol",
      problemSummary: "Combat automation is disabled. Need to check all clients",
      prolbemDetail: {},
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
      problemSummary: "Item Macro Character sheet hook is enabled. Should be turned off",
      prolbemDetail: {},
      fixer: async () => {
        await game.settings.set("itemacro", "charsheet", false);
      }
    })
  }
}
function checkTimesup(data) {
  if (data.summary.knownModules["times-up"] === "not installed") 
    data.problems.push({
      moduleId: "times-up",
      problemSummary: "Times Up is not installed or not active. Effects won't expire",
      fixer: "Install and activate times-up"
    })
}
function checkCommonProblems(data: TroubleShooterData) {
  checkMidiSettings(data);
  checkItemMacro(data);
  checkNoActorTokens(data);
}
function getDetailedSettings(moduleId: string): any {
  const returnValue = {};
  //@ts-expect-error
  let settings = Array.from(game.settings.settings).filter(i => i[0].includes(moduleId) && i[1].namespace === moduleId);
  settings.forEach(i => {
    if (typeof i[1].name !== "string") return;
    setProperty(returnValue, i[1].name, game.settings.get(moduleId, i[1].key));
  });
  return returnValue;
}

export async function exportTroubleShooter() {
  const data = collectTroubleShootingData();
  const filename = "fvtt-midi-qol-troubleshooting.json"
  await saveDataToFile(JSON.stringify(data, null, 2), "text/json", filename);
}

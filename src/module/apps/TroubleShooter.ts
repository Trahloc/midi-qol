import stringify from "json-stringify-pretty-compact";
import { geti18nOptions, i18n } from "../../midi-qol.js";
import { checkedModuleList, checkMechanic, configSettings, enableWorkflow } from "../settings.js";

const minimumMidiVersion = "11.0.7";

export class TroubleShooter extends FormApplication {
  public static errors: { timestamp: number, timeString: string, error: any, message: string | undefined }[] = [];
  public static MAX_ERRORS = 10;
  static _data : TroubleShooterData;
  public static set data(data) {this._data = data};
  public static get data() {return this._data}
  _hookId;

  constructor(object: any = {}, options: any = {}) {
    super(object, options);
    TroubleShooter.data = collectTroubleShootingData();
    this.options.editable = true;
    this._hookId = Hooks.on("midi-qol.TroubleShooter.recordError", (errorDetail) => {
      if (TroubleShooter.data.isLocal) {
        TroubleShooter.data = collectTroubleShootingData();
        this.render(true);
      }
    });
  }
 
  public static recordError(err, message?: string | undefined) {
    if (!this.errors) this.errors = [];
    while (this.errors.length >= this.MAX_ERRORS) this.errors.shift();
    const timestamp = Date.now()
    const timeString = `${new Date(timestamp).toLocaleDateString()} - ${new Date(timestamp).toLocaleTimeString()}`;
    const stack = err.stack.split("\n");
    const errorDetail = { timestamp, timeString, error: { message: err.message, stack }, message };
    this.errors.push(errorDetail)
    Hooks.callAll("midi-qol.TroubleShooter.recordError", errorDetail);
  }

  public static clearErrors() {
    this.errors = [];
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
    options.closeOnSubmit = false;
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

  async _onSubmit(...args): Promise<any> {
    let [event, options] = args;
    console.error("On Submit", event, options.updateData, options.preventClose, options.preventRender);
    return {};
  }

  async close(...args) {
    Hooks.off("midi-qol.TroubleShooter.recordError", this._hookId);
    super.close(...args)
  }

  activateListeners(html) {
    html.find("#midi-qol-export-troubleshooter").on("click", exportTroubleShooter)
    html.find("#midi-qol-import-troubleshooter").on("click", async () => {
      if (await importFromJSONDialog()) {
        this.render(true);
      }
    });
    html.find("#midi-qol-regenerate-troubleshooter").on("click", () => {
      TroubleShooter.data = collectTroubleShootingData();
      this.render(true);
    });
    html.find("#midi-qol-clear-errors-troubleshooter").on("click", () => {
      TroubleShooter.clearErrors();
      TroubleShooter.data = collectTroubleShootingData();
      this.render(true);
    });
  }
  getData(options: any): any {
    let data: any = duplicate(TroubleShooter.data);
    data.hasIncompatible = data.summary.incompatible.length > 0;
    data.hasOutOfDate = data.summary.outOfDate.length > 0;
    data.hasPossibleOutOfData = data.summary.possibleOutOfDate.length > 0;
    data.hasProblems = data.problems.length > 0;
    data.hasErrors = data.errors.length > 0;
    for (let problem of data.problems) {
      problem.fixerIsString = typeof problem.fixer === "string";
      if (problem.problemDetail) problem.problemDetail = JSON.stringify(problem.problemDetail);
    }
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
  midiVersion: string;
  isLocal: boolean;
  fileName: string;
  summary: any,
  problems: ProblemSpec[],
  modules: any
  errors: any
}
function collectTroubleShootingData() {
  let data: TroubleShooterData = {
    //@ts-expect-error .version
    midiVersion: game.modules.get("midi-qol")?.version,
    isLocal: true,
    fileName: "Local Settings",
    summary: {},
    problems: [],
    modules: {},
    errors: {}
  };

  //@ts-expect-error game.version
  const gameVersion = game.version;
  const gameSystemId = game.system.id;
  data.summary.gameSystemId = gameSystemId;
  data.summary = {
    "foundry-version": gameVersion,
    "Game System": gameSystemId,
    //@ts-expect-error .version
    "Game System Version": game.system.version,
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
    },
    "moduleSettings": {}
  }
  if (game.modules.get("ActiveAuras")?.active) {
    data.summary.moduleSettings["Active Auras In Combat"] = game.settings.get("ActiveAuras", "combatOnly");
  }
  if (game.modules.get("ddb-importer")?.active) {
    data.summary.moduleSettings["DDB Importer CPR"] = game.settings.get("ddb-importer", "munching-policy-use-chris-premades");
    data.summary.moduleSettings["DDB Importer Use DAE"] = game.settings.get("ddb-importer", "munching-policy-use-dae-effects");
    data.summary.moduleSettings["DDB Importer Add Spell Effects"] = game.settings.get("ddb-importer", "munching-policy-add-spell-effects");
    data.summary.moduleSettings["DDB Importer Add Monster Effects"] = game.settings.get("ddb-importer", "munching-policy-add-monster-effects");
    data.summary.moduleSettings["DDB Importer Add Armor Effects"] = game.settings.get("ddb-importer", "munching-policy-add-ac-armor-effects");
  } else data.summary.moduleSettings["DDB Importer"] = i18n("midi-qol.Inactive");
  if (game.modules.get("dfreds-convenient-effects")?.active) {
    data.summary.moduleSettings["Convenient Effects Modify Status Effects"] = game.settings.get("dfreds-convenient-effects", "modifyStatusEffects");
  } else data.summary.moduleSettings["Convenient Effects"] = i18n("midi-qol.Inactive");
  if (game.modules.get("monks-little-details")?.active) {
    data.summary.moduleSettings["Monk's Little Details Status Effects"] = game.settings.get("monks-little-details", "add-extra-statuses");
    data.summary.moduleSettings["Monk's Little Clear Targets"] = game.settings.get("monks-little-details", "clear-targets");
    data.summary.moduleSettings["Monk's Little Remember Targets"] = game.settings.get("monks-little-details", "remember-previous");
  } else data.summary.moduleSettings["Monk's Little Details"] = i18n("midi-qol.Inactive");
  if (game.modules.get("monks-tokenbar")?.active) {
    data.summary.moduleSettings["Monk's Token Bar "] = game.settings.get("monks-tokenbar", "allow-player");
  } else data.summary.moduleSettings["Monks Token Bar"] = i18n("midi-qol.Inactive");
  if (game.modules.get("sequencer")?.active) {
    data.summary.moduleSettings["Sequencer Enable Effects"] = game.settings.get("sequencer", "effectsEnabled");
    data.summary.moduleSettings["Sequencer Enable Sounds"] = game.settings.get("sequencer", "soundsEnabled")
  } else data.summary.moduleSettings["Sequencer"] = i18n("midi-qol.Inactive");
  if (game.modules.get("times-up")?.active) {
    data.summary.moduleSettings["Times Up Disable Passive Effects Expiry"] = game.settings.get("times-up", "DisablePassiveEffects");
  } else data.summary.moduleSettings["Times-Up"] = "midi-qol.Inactive";
  if (game.modules.get("tokenmagic")?.active) {
    data.summary.moduleSettings["Token Magic FX Automatic Template Effects "] = game.settings.get("tokenmagic", "autoTemplateEnabled");
    data.summary.moduleSettings["Token Magic FX Default Template Grid on Hover "] = game.settings.get("tokenmagic", "defaultTemplateOnHover");
    data.summary.moduleSettings["Token Magic FX Autoa Hide Template Elements "] = game.settings.get("tokenmagic", "autohideTemplateElements");
  } else data.summary.moduleSettings["Token Magic FX"] = i18n("midi-qol.Inactive");

  data.summary.midiSettings = {};
  data.summary.midiSettings["Enable Roll Automation Support (Client Setting)"] = enableWorkflow;
  data.summary.midiSettings["Auto Target on Template Draw"] = geti18nOptions("autoTargetOptions")[configSettings.autoTarget];
  data.summary.midiSettings["Auto Target for Ranged Targets/Spells"] = geti18nOptions("rangeTargetOptions")[configSettings.rangeTarget];
  data.summary.midiSettings["Auto Apply Item Effects"] = geti18nOptions("AutoEffectsOptions")[configSettings.autoItemEffects];
  data.summary.midiSettings["Apply Convenient Effects"] = geti18nOptions("AutoCEEffectsOptions")[configSettings.autoCEEffects];
  data.summary.midiSettings["Auto Check Hits"] = geti18nOptions("autoCheckHitOptions")[configSettings.autoCheckHit];
  data.summary.midiSettings["Roll Seperate Attacks per Target"] = configSettings.attackPerTarget;
  data.summary.midiSettings["Auto Check Saves"] = geti18nOptions("autoCheckSavesOptions")[configSettings.autoCheckSaves];
  data.summary.midiSettings["Auto Apply Damage to Target"] = geti18nOptions("autoApplyDamageOptions")[configSettings.autoApplyDamage];
  data.summary.midiSettings["Enable Concentration Automation"] = configSettings.concentrationAutomation;
  data.summary.midiSettings["Expire 1Hit/1Attack/1Action on roll"] = checkMechanic("actionSpecialDurationImmediate");
  data.summary.midiSettings["Inapacitated Actors can't Take Actions"] = checkMechanic("incapacitated");
  data.summary.midiSettings["Calculate Cover"] = geti18nOptions("CoverCalculationOptions")[configSettings.optionalRules.coverCalculation];
  data.summary.knownModules = {};
  checkedModuleList.forEach(moduleId => {
    const moduleData = game.modules.get(moduleId);
    if (moduleData)
      //@ts-expect-error .version
      setProperty(data.summary.knownModules, moduleId, { title: moduleData.title, active: moduleData?.active, ibstalled: true, moduleVersion: moduleData?.version, foundryVersion: moduleData.compatibility?.verified });
    else
      setProperty(data.summary.knownModules, moduleId, { title: "Not installed", active: false, installed: false, moduleVersion: ``, foundryVersion: `` });
  });

  for (let moduleData of game.modules) {
    let module: any = moduleData;
    if (!module.active && !checkedModuleList.includes(module.id)) continue;
    let moduleId = module.id === "plutonium" ? "unsupported-importer" : module.id
    data.modules[moduleId] = {
      title: module.id === "plutonium" ? "unsupported-importer" : module.title,
      active: module.active,
      installed: true,
      version: module.version,
      compatibility: module.compatibility?.verified
    }
    switch (module.id) {
      case "ATL":
        setProperty(data.modules[module.id], "settings", getDetailedSettings(module.id));
        break;
      case "ActiveAuras":
        setProperty(data.modules[module.id], "settings", getDetailedSettings(module.id));
        break;
      case "about-time":
        break;
      case "anonymous":
        setProperty(data.modules[module.id], "settings", getDetailedSettings(module.id));
        break;
      case "autoanimations":
        setProperty(data.modules[module.id], "settings", getDetailedSettings(module.id));
        if (game.modules.get("autoanimations")?.active) checkAutoAnimations(data);
        break;
      case "combat-utility-belt":
        break;
      case "condition-lab-triggler":
        setProperty(data.modules[module.id], "settings", getDetailedSettings(module.id));
        break;
      case "dae":
        setProperty(data.modules[module.id], "settings", getDetailedSettings(module.id));
        break;
      case "ddb-game-log":
        break;
      case "df-templates":
        setProperty(data.modules[module.id], "settings", getDetailedSettings(module.id));
        break;
      case "dfreds-convenient-effects":
        setProperty(data.modules[module.id], "settings", getDetailedSettings(module.id));
        break;
      case "dice-so-nice":
        break;
      case "effect-macro":
        setProperty(data.modules[module.id], "settings", getDetailedSettings(module.id));
        break;
      case "foundryvtt=simple-calendar":
        setProperty(data.modules[module.id], "settings", getDetailedSettings(module.id));
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
        setProperty(data.modules[module.id], "settings", getDetailedSettings(module.id));
        break;
      case "levelsautocover":
        setProperty(data.modules[module.id], "settings", getDetailedSettings(module.id));
        break;
      case "levelsvolumetrictemplates":
        setProperty(data.modules[module.id], "settings", getDetailedSettings(module.id));
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
      case "monks-little-details":
        setProperty(data.modules[module.id], "settings", getDetailedSettings(module.id));
        break;
      case "monks-tokenbar":
        setProperty(data.modules[module.id], "settings", getDetailedSettings(module.id));
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
        };
        setProperty(data.modules[module.id], "settings", getDetailedSettings(module.id));
        break;
      case "walledtemplates":
        break;
      case "warpgate":
        setProperty(data.modules[module.id], "settings", getDetailedSettings(module.id));
        if (game.modules.get("warpgate")?.active) checkWarpgateUserPermissions(data);
        break;
      case "wjmaia":
        break;
      case "advancedspelleffects":
      case "attack-roll-check-5e":
      case "betterrolls5e":
      case "dice-rng-protector":
      case "dice-tooltip":
      case "effective-transferral":
      case "fast-rolls":
      case "faster-rolling-by-default-5e":
      case "gm-paranoia-taragnor":
      case "heartbeat":
      case "max-crit":
      case "mre-dnd5e":
      case "multiattack-5e":
      case "obsidian":
      case "quick-rolls":
      case "ready-set-roll-5e":
      case "roll-tooltips-5e":
      case "retroactive-advantage-5e":
      case "rollgroups":
      case "wire":
        data.modules[module.id].incompatible = true;
        break;
    }
  }
  // Check Incompatible modules
  data.summary.incompatible = Object.keys(data.modules)
    .filter(key => data.modules[key].incompatible)
    .map(key => ({ key, title: data.modules[key].title }));
  
  data.summary.outOfDate = Object.keys(data.modules)
  .filter(key => isNewerVersion("11", data.modules[key].compatibility ?? 0))
  .map(key => {
    const versionString = `${data.modules[key].active ? i18n("midi-qol.Active") : i18n("midi-qol.Inactive")} ${data.modules[key].version}`
    return {
      key, 
      title: data.modules[key].title,
      active: data.modules[key].active,
      moduleVersion: data.modules[key].version, //versionString,
      foundryVersion: data.modules[key].compatibility
    }
  });
  data.summary.possibleOutOfDate = Object.keys(data.modules).filter(key => {
    const moduleVersion = data.modules[key].compatibility ?? "0.0.0";
    // if (!data.modules[key].active) return false;
    if (isNewerVersion("11", moduleVersion)) return false;
    return isNewerVersion(gameVersion, data.modules[key].compatibility ?? "0.0.0")
  }).map(key =>
    ({ 
      key, 
      title: data.modules[key].title, 
      active: data.modules[key].active,
      moduleVersion: data.modules[key].version,
      version: data.modules[key].compatibility 
    }))
  checkCommonProblems(data);
  data.errors = duplicate(TroubleShooter.errors).reverse();
  return data;
}
async function importFromJSONDialog() {
  const content = await renderTemplate("templates/apps/import-data.html",
  { hint1: "Choose a Trouble Shooter JSON file to import"});
  let dialog = new Promise((resolve, reject) => {
    new Dialog({
      title: `Import Trouble Shooter Data`,
      content: content,
      buttons: {
        import: {
          icon: '<i class="fas fa-file-import"></i>',
          label: "Import",
          callback: html => {
            //@ts-ignore
            const form = html.find("form")[0];
            if (!form.data.files.length) return ui.notifications?.error("You did not upload a data file!");
            readTextFromFile(form.data.files[0]).then(json => {
              const jsonData = JSON.parse(json);
              if (isNewerVersion(minimumMidiVersion,jsonData.midiVersion ?? "0.0.0")) {
                ui.notifications?.error("Trouble Shooter Data is too old to use");
                resolve(false);
                return;
              }
              jsonData.isLocal = false;
              jsonData.fileName = form.data.files[0].name;
              TroubleShooter.data = jsonData;
              for (let error of TroubleShooter.data.errors) {
                error.timeString = `${new Date(error.timestamp).toLocaleDateString()} - ${new Date(error.timestamp).toLocaleTimeString()}`;

              }
              resolve(true);
            });
          }
        },
        no: {
          icon: '<i class="fas fa-times"></i>',
          label: "Cancel",
          callback: html => resolve(false)
        }
      },
      default: "import"
    }, {
      width: 400
    }).render(true);
  });
  return await dialog;
}

function checkAutoAnimations(data: TroubleShooterData) {

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
    if (!i[1].config) return;
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

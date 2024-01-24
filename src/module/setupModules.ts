import { error, debugEnabled, i18n } from "../midi-qol.js";
import { log } from "../midi-qol.js";
import { TroubleShooter } from "./apps/TroubleShooter.js";
import { configSettings } from "./settings.js";

export const DAE_REQUIRED_VERSION = "11.0.24";
export const REQUIRED_MODULE_VERSIONS = {
  "about-time": "0.0", 
  "anonymous": "0.0.0",
  "chris-premades": "0.5.52",
  "combat-utility-belt": "1.3.8",
  "condition-lab-triggler": "1.4",
  "dae": DAE_REQUIRED_VERSION,
  "ddb-game-log": "0.0.0",
  "df-templates": "1.0.0",
  "dfreds-convenient-effects": "5.0.4",
  "dice-so-nice": "4.1.1", 
  "levels": "3.0.6", 
  "levelsautocover": "1.4",
  "levelsvolumetrictemplates": "0.0.0",
  "lib-changelogs": "0.0.0",
  "lib-wrapper": "1.3.5",
  "lmrtfy": "0.0.0",
  "monks-tokenbar": "1.0.55",
  "multilevel-tokens": "1.6.0",
  "perceptive": "3.1.7",
  "ready-set-roll-5e": "1.2.0",
  "simbuls-cover-calculator":  "1.0.2",
  "socketlib": "0.0",
  "times-up": "11.0.4",
  "tokencover": "0.6.0",
  "walledtemplates": "0.0.0",
  "wjmais": "0.0.0",
};
export let installedModules = new Map();

export function getModuleVersion(moduleName): string {
  //@ts-expect-error .version
  let modVer = game.modules.get(moduleName)?.version || "0.0.0";
  if (!/[0-9\.]+/.test(modVer)) {
    console.warn(`midi-qol | module ${moduleName} has unrecognised version ${modVer} using ${REQUIRED_MODULE_VERSIONS[moduleName]} instead}`);
    modVer = REQUIRED_MODULE_VERSIONS[moduleName];
  }
  return modVer;
}
export let setupModules = () => {
  //@ts-expect-error .version
  if (isNewerVersion(game.system.version, "2.4.99")) {
    ui.notifications?.error("Midi qol has not been tested with dnd 2.5.0 and there are known breaking changes");
  }
  for (let name of Object.keys(REQUIRED_MODULE_VERSIONS)) { 
    const modVer = getModuleVersion(name);
    const neededVer = REQUIRED_MODULE_VERSIONS[name];
    const isValidVersion = isNewerVersion(modVer, neededVer) || !isNewerVersion(neededVer, modVer);
    if (!installedModules.get(name)) installedModules.set(name, game.modules.get(name)?.active && isValidVersion) 
    if (!installedModules.get(name)) {
      if (game.modules.get(name)?.active) {
        //@ts-ignore game.module.version
        const message = `midi-qol requires ${name} to be of version ${REQUIRED_MODULE_VERSIONS[name]} or later, but it is version ${game.modules.get(name)?.version}`;
        error(message);
        TroubleShooter.recordError(new Error(message), message);
      } else console.warn(`midi-qol | optional module ${name} not active - some features disabled`)
    }
  }
  if (debugEnabled > 0) {
    for (let module of installedModules.keys()) 
      log(`module ${module} has valid version ${installedModules.get(module)}`);
  }
}

export function dice3dEnabled() {
  //@ts-ignore
  // return installedModules.get("dice-so-nice") && game.dice3d?.isEnabled();
  return installedModules.get("dice-so-nice") && (game.dice3d?.config?.enabled || game.dice3d?.isEnabled());
}

export function checkModules() { // this really should happen in TroubleShooter
  if (game.user?.isGM && !installedModules.get("socketlib")) {
    ui.notifications?.error("midi-qol.NoSocketLib", {permanent: true, localize: true});
  }
  //@ts-ignore
  const midiVersion = game.modules.get("midi-qol").version;
  const notificationVersion = game.settings.get("midi-qol", "notificationVersion");

  checkCubInstalled();
}

export function checkCubInstalled() {
  if (game.user?.isGM && installedModules.get("combat-utility-belt")) {
    ui.notifications?.warn("midi-qol.cubNotSupported", {permanent: true, localize: true})
  }
}

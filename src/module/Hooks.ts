import { warn, error, debug, i18n, debugEnabled, overTimeEffectsToDelete, allAttackTypes, failedSaveOverTimeEffectsToDelete, geti18nOptions, log } from "../midi-qol.js";
import { colorChatMessageHandler, nsaMessageHandler, hideStuffHandler, chatDamageButtons, processItemCardCreation, hideRollUpdate, hideRollRender, onChatCardAction, betterRollsButtons, processCreateDDBGLMessages, ddbglPendingHook, betterRollsUpdate, checkOverTimeSaves } from "./chatMesssageHandling.js";
import { processUndoDamageCard } from "./GMAction.js";
import { untargetDeadTokens, untargetAllTokens, midiCustomEffect, MQfromUuid, getConcentrationEffect, removeReactionUsed, removeBonusActionUsed, checkflanking, getSystemCONFIG, expireRollEffect, doConcentrationCheck, MQfromActorUuid, removeActionUsed, getConcentrationLabel, getConvenientEffectsReaction, getConvenientEffectsBonusAction, expirePerTurnBonusActions, itemIsVersatile } from "./utils.js";
import { OnUseMacros, activateMacroListeners } from "./apps/Item.js"
import { checkMechanic, checkRule, configSettings, dragDropTargeting } from "./settings.js";
import { installedModules } from "./setupModules.js";
import { checkWounded, checkDeleteTemplate, preRollDeathSaveHook, preUpdateItemActorOnUseMacro, removeConcentration, zeroHPExpiry } from "./patching.js";
import { preItemUsageConsumptionHook, preRollDamageHook, showItemInfo } from "./itemhandling.js";
import { TroubleShooter } from "./apps/TroubleShooter.js";
import { Workflow } from "./workflow.js";
import { updateJsxSelfClosingElement } from "typescript";

export const concentrationCheckItemName = "Concentration Check - Midi QOL";
export var concentrationCheckItemDisplayName = "Concentration Check";
export var midiFlagTypes: {} = {};



export let readyHooks = async () => {
  // need to record the damage done since it is not available in the update actor hook
  Hooks.on("preUpdateActor", (actor, update: any, options: any, user: string) => {
    const hpUpdate = getProperty(update, "system.attributes.hp.value");
    const temphpUpdate = getProperty(update, "system.attributes.hp.temp");
    let concHPDiff = 0;
    if (!options.noConcentrationCheck) {
      if (hpUpdate !== undefined) {
        let hpChange = actor.system.attributes.hp.value - hpUpdate;
        // if (hpUpdate >= (actor.system.attributes.hp.tempmax ?? 0) + actor.system.attributes.hp.max) hpChange = 0;
        if (hpChange > 0) concHPDiff += hpChange;
      }
      if (configSettings.tempHPDamageConcentrationCheck && temphpUpdate !== undefined) {
        let temphpDiff = actor.system.attributes.hp.temp - temphpUpdate;
        if (temphpDiff > 0) concHPDiff += temphpDiff
      }
    }
    setProperty(update, "flags.midi-qol.concentration-damage", concHPDiff);
    return true;
  })

  // Handle removing effects when the token is moved.
  Hooks.on("updateToken", (tokenDocument, update, diff, userId) => {
    if (game.user?.id !== userId) return;
    if ((update.x || update.y) === undefined) return;
    const actor = tokenDocument.actor;
    const expiredEffects = actor?.effects.filter(ef => {
      const specialDuration = getProperty(ef.flags, "dae.specialDuration");
      return specialDuration?.includes("isMoved");
    }) ?? [];
    if (expiredEffects.length > 0) actor?.deleteEmbeddedDocuments("ActiveEffect", expiredEffects.map(ef => ef.id), { "expiry-reason": "midi-qol:isMoved" });
  });

  Hooks.on("template3dUpdatePreview", (at, t) => {
    //@ts-expect-error Volumetrictemplates
    VolumetricTemplates.compute3Dtemplate(t);
  });

  Hooks.on("targetToken", debounce(checkflanking, 150));

  Hooks.on("ddb-game-log.pendingRoll", (data) => {
    ddbglPendingHook(data);
  });

  Hooks.on("deleteMeasuredTemplate", checkDeleteTemplate);

  // Handle updates to the characters HP
  // Handle concentration checks
  Hooks.on("updateActor", async (actor, update, options, user) => {
    if (user !== game.user?.id) return;
    const hpUpdate = getProperty(update, "system.attributes.hp.value");
    const temphpUpdate = getProperty(update, "system.attributes.hp.temp");
    const vitalityResource = checkRule("vitalityResource");
    const vitalityUpdate = typeof vitalityResource === "string" ? getProperty(update, vitalityResource) : undefined;
    if (hpUpdate !== undefined || temphpUpdate !== undefined || vitalityUpdate !== undefined) {
      let hpDiff = getProperty(actor, "flags.midi-qol.concentration-damage") ?? 0;

      const hpUpdateFunc = async () => {
        await checkWounded(actor, update, options, user);
        await zeroHPExpiry(actor, update, options, user);
      }
      // if (globalThis.DAE?.actionQueue && !globalThis.DAE.actionQueue.remaining) await globalThis.DAE.actionQueue.add(hpUpdateFunc);
      // else await hpUpdateFunc();
      await hpUpdateFunc();
      if (configSettings.concentrationAutomation && configSettings.concentrationDamageCheck && hpDiff > 0 && !options.noConcentrationCheck) {
        // expireRollEffect.bind(actor)("Damaged", ""); - not this simple - need to think about specific damage types
        concentrationCheckItemDisplayName = i18n("midi-qol.concentrationCheckName");
        const concentrationEffect: ActiveEffect | undefined = getConcentrationEffect(actor)
        if (concentrationEffect) {
          if (actor.system.attributes.hp.value <= 0) {
            if (globalThis.DAE?.actionQueue) globalThis.DAE.actionQueue.add(concentrationEffect.delete.bind(concentrationEffect));
            else await concentrationEffect.delete();
          } else {
            const saveDC = Math.max(10, Math.floor(hpDiff / 2));
            if (globalThis.DAE?.actionQueue) globalThis.DAE.actionQueue.add(doConcentrationCheck, actor, saveDC);
            else await doConcentrationCheck(actor, saveDC);
          }
        }
      }
    }
    return true;
  });

  Hooks.on("renderActorArmorConfig", (app, html, data) => {
    if (!["none", undefined, false].includes(checkRule("challengeModeArmor"))) {
      const ac = data.ac;
      const element = html.find(".stacked"); // TODO do this better
      let ARHtml = $(`<div>EC: ${ac.EC}</div><div>AR: ${ac.AR}</div>`);
      element.append(ARHtml);
    }
  });

  // Handle removal of concentration
  Hooks.on("deleteActiveEffect", (...args) => {
    let [deletedEffect, options, user] = args;
    const checkConcentration = configSettings.concentrationAutomation;
    if (debugEnabled > 0) warn("Deleted effects is ", deletedEffect, options);

    if (!checkConcentration || options.noConcentrationCheck) return;

    //@ts-expect-error activeGM
    if (!game.users?.activeGM?.isSelf) return;
    if (!(deletedEffect.parent instanceof CONFIG.Actor.documentClass)) return;
    if (debugEnabled > 0) warn("deleteActiveEffectHook", deletedEffect, deletedEffect.parent.name, options);
    const concentrationLabel: any = getConcentrationLabel();
    let isConcentration = deletedEffect.name === concentrationLabel;
    async function changefunc() {
      try {
        const origin = await fromUuid(deletedEffect.origin);
        if (isConcentration && !options.noConcentrationCheck) {
          options.concentrationEffectsDeleted = false;
          options.concentrationDeleted = true;
          return await removeConcentration(deletedEffect.parent, deletedEffect.uuid, mergeObject(options, { concentrationDeleted: true }));
        }
        if (origin instanceof CONFIG.Item.documentClass && origin.parent instanceof CONFIG.Actor.documentClass && !options.noConcentrationCheck) {
          const concentrationData = getProperty(origin.parent, "flags.midi-qol.concentration-data");
          if (concentrationData && deletedEffect.origin === concentrationData.uuid) {

            const allConcentrationTargets = concentrationData.targets.filter(target => {
              let actor = MQfromActorUuid(target.actorUuid);
              const hasEffects = actor?.effects.some(effect =>
                effect.origin === concentrationData.uuid
                && !effect.flags.dae.transfer
                && effect.uuid !== deletedEffect.uuid);
              return hasEffects;
            });
            const concentrationTargets = concentrationData.targets.filter(target => {
              let actor = MQfromActorUuid(target.actorUuid);
              const hasEffects = actor?.effects.some(effect =>
                effect.origin === concentrationData.uuid
                && !effect.flags.dae.transfer
                && effect.uuid !== deletedEffect.uuid
                && effect.name !== concentrationLabel);
              return hasEffects;
            });
            if (!options.noConcentrationCheck
              && ["effects", "effectsTemplates"].includes(configSettings.removeConcentrationEffects)
              && concentrationTargets.length < 1
              && concentrationTargets.length < concentrationData.targets.length
              && concentrationData.templates.length === 0
              && concentrationData.removeUuids.length === 0) {
              // only non concentration effects left
              await removeConcentration(origin.parent, deletedEffect.uuid, mergeObject(options, { concentrationEffectsDeleted: true, concentrationDeleted: undefined }));
            } else if (concentrationData.targets.length !== allConcentrationTargets.length) {
              // update the concentration data
              concentrationData.targets = allConcentrationTargets;
              await origin.parent.setFlag("midi-qol", "concentration-data", concentrationData);
            }
          }
        }
        if (getConvenientEffectsReaction() && deletedEffect.name === getConvenientEffectsReaction()?.name && deletedEffect.parent instanceof CONFIG.Actor.documentClass) {
          // TODO see if this can massaged into a single transaction
          await deletedEffect.parent?.unsetFlag("midi-qol", "actions.reactionCombatRound");
          await deletedEffect.parent?.setFlag("midi-qol", "actions.reaction", false);
        }
        if (getConvenientEffectsBonusAction() && deletedEffect.name === getConvenientEffectsBonusAction()?.name && deletedEffect.parent instanceof CONFIG.Actor.documentClass) {
          // TODO see if this can massaged into a single transaction
          await deletedEffect.parent.setFlag("midi-qol", "actions.bonus", false);
          await deletedEffect.parent.unsetFlag("midi-qol", "actions.bonusActionCombatRound");
        }
        return true;
      } catch (err) {
        console.warn("Error in deleteActiveEffect", err, deletedEffect, options);
        return true;
      }
    }
    // if (globalThis.DAE?.actionQueue) globalThis.DAE.actionQueue.add(changefunc);
    return changefunc();
  })

  // Hooks.on("restCompleted", restManager); I think this means 1.6 is required.
  Hooks.on("dnd5e.restCompleted", restManager);

  Hooks.on("dnd5e.preItemUsageConsumption", preItemUsageConsumptionHook);

  Hooks.on("dnd5e.preRollAttack", (item, rollConfig) => {
    if (rollConfig.fastForward && rollConfig.dialogOptions.babonus?.optionals?.length) rollConfig.fastForward = false;
  });

  Hooks.on("dnd5e.preRollDamage", (item, rollConfig) => {
    if (rollConfig.fastForward && rollConfig.dialogOptions.babonus?.optionals?.length) rollConfig.fastForward = false;
    return preRollDamageHook(item, rollConfig)
  });
  // Hooks.on("dnd5e.rollDamage", rollDamageMacro);

  Hooks.on("updateCombat", (combat: Combat, update, options, userId) => {
    if (userId !== game.user?.id) return;
    if (!update.hasOwnProperty("round")) return;
    if (!checkMechanic("autoRerollInitiative")) return;
    let combatantIds: any = combat.combatants.map(c => c.id);
    if (combat.combatants?.size > 0) {
      combat.rollInitiative(combatantIds, { updateTurn: true }).then(() => combat.update({ turn: 0 }));
    }
  });

  Hooks.on("dnd5e.preRollDeathSave", preRollDeathSaveHook);
  // Concentration Check is rolled as an item roll so we need an item.
  itemJSONData.name = concentrationCheckItemName;
}

export function restManager(actor, result) {
  if (!actor || !result) return;
  removeReactionUsed(actor); // remove reaction used for a rest
  removeBonusActionUsed(actor);
  removeActionUsed(actor);
  const myExpiredEffects = actor.effects.filter(ef => {
    const specialDuration = getProperty(ef.flags, "dae.specialDuration");
    return specialDuration && ((result.longRest && specialDuration.includes(`longRest`))
      || (result.newDay && specialDuration.includes(`newDay`))
      || specialDuration.includes(`shortRest`));
  }).map(ef => ef.id);
  if (myExpiredEffects?.length > 0) actor?.deleteEmbeddedDocuments("ActiveEffect", myExpiredEffects, { "expiry-reason": "midi-qol:rest" });
}

export function initHooks() {
  if (debugEnabled > 0) warn("Init Hooks processing");
  Hooks.on("preCreateChatMessage", (message: ChatMessage, data, options, user) => {
    if (debugEnabled > 1) debug("preCreateChatMessage entering", message, data, options, user)
    nsaMessageHandler(message, data, options, user);
    checkOverTimeSaves(message, data, options, user);
    return true;
  });

  Hooks.on("createChatMessage", (message: ChatMessage, options, user) => {
    if (debugEnabled > 1) debug("Create Chat Message ", message.id, message, options, user)
    processItemCardCreation(message, user);
    processCreateDDBGLMessages(message, options, user);
    return true;
  });

  Hooks.on("updateChatMessage", (message, update, options, user) => {
    hideRollUpdate(message, update, options, user);
    betterRollsUpdate(message, update, options, user);
    //@ts-ignore scrollBottom
    ui.chat?.scrollBottom();
  });

  Hooks.on("updateCombat", (combat, data, options, user) => {
    if (data.round === undefined && data.turn === undefined) return;
    untargetAllTokens(combat, data.options, user);
    untargetDeadTokens();
    // updateReactionRounds(combat, data, options, user); This is handled in processOverTime
  });

  Hooks.on("renderChatMessage", (message, html, data) => {
    if (debugEnabled > 1) debug("render message hook ", message.id, message, html, data);
    chatDamageButtons(message, html, data);
    processUndoDamageCard(message, html, data);
    colorChatMessageHandler(message, html, data);
    hideRollRender(message, html, data);
    betterRollsButtons(message, html, data);
    hideStuffHandler(message, html, data);
  });

  Hooks.on("deleteChatMessage", (message, options, user) => {
    if (message.user.id !== game.user?.id) return;
    const workflowId = getProperty(message, "flags.midi-qol.workflowId");
    if (workflowId && Workflow.getWorkflow(workflowId)) Workflow.removeWorkflow(workflowId)
  });

  Hooks.on("midi-qol.RollComplete", async (workflow) => {
    const wfuuid = workflow.uuid;

    if (failedSaveOverTimeEffectsToDelete[wfuuid]) {
      if (workflow.saves.size === 1 || !workflow.hasSave) {
        let effectId = failedSaveOverTimeEffectsToDelete[wfuuid].effectId;
        let actor = failedSaveOverTimeEffectsToDelete[wfuuid].actor;
        await actor.deleteEmbeddedDocuments("ActiveEffect", [effectId]), { "expiry-reason": "midi-qol:overTime" };
      }
      delete failedSaveOverTimeEffectsToDelete[wfuuid];
    }
    if (overTimeEffectsToDelete[wfuuid]) {
      let effectId = overTimeEffectsToDelete[wfuuid].effectId;
      let actor = overTimeEffectsToDelete[wfuuid].actor;
      await actor.deleteEmbeddedDocuments("ActiveEffect", [effectId]), { "expiry-reason": "midi-qol:overTime" };
      delete overTimeEffectsToDelete[wfuuid];
    }
    if (debugEnabled > 1) debug("Finished the roll", wfuuid)
  });

  setupMidiFlagTypes();
  Hooks.on("applyActiveEffect", midiCustomEffect);
  // Hooks.on("preCreateActiveEffect", checkImmunity); Disabled in lieu of having effect marked suppressed
  Hooks.on("preUpdateItem", preUpdateItemActorOnUseMacro);
  Hooks.on("preUpdateActor", preUpdateItemActorOnUseMacro);
  Hooks.on("combatRound", expirePerTurnBonusActions);
  Hooks.on("combatTurn", expirePerTurnBonusActions);
  Hooks.on("updateCombatant", (combatant, updates, options, user) => {
    if (game?.user?.id !== user) return true;
    if (combatant.actor && updates.initiative) expireRollEffect.bind(combatant.actor)("Initiative", "none");
    return true;
  });

  function getItemSheetData(data, item) {
    const config = getSystemCONFIG();
    const midiProps = config.midiProperties;
    if (!item) {
      const message = "item not defined in getItemSheetData";
      console.error(message, data);
      TroubleShooter.recordError(new Error(message));
      return;
    }
    //@ts-expect-error
    const ceForItem = game.dfreds?.effects?.all.find(e => e.name === item.name);
    data = mergeObject(data, {
      allowUseMacro: configSettings.allowUseMacro,
      MacroPassOptions: Workflow.allMacroPasses,
      showCEOff: false,
      showCEOn: false,
      hasSave: item.hasSave,
      midiPropertyLabels: midiProps,
      SaveDamageOptions: geti18nOptions("SaveDamageOptions"),
      ConfirmTargetOptions: geti18nOptions("ConfirmTargetOptions")
    });
    if (ceForItem) {
      data.showCEOff = ["both", "cepri", "itempri"].includes(configSettings.autoCEEffects);
      data.showCEOn = ["none", "itempri"].includes(configSettings.autoCEEffects);
    }
    setProperty(data, "flags.midiProperties", item.flags?.midiProperties ?? {});
    if (item && ["spell", "feat", "weapon", "consumable", "equipment", "power", "maneuver"].includes(item.type)) {
      for (let prop of Object.keys(midiProps)) {
        if (getProperty(item, `system.properties.${prop}`) !== undefined
          && item.flags?.midiProperties[prop] === undefined) {
          data.flags.midiProperties[prop] = item.system.properties[prop];
        } else if (getProperty(item, `flags.midiProperties.${prop}`) === undefined) {
          if (prop==="saveDamage") {
          } else data.flags.midiProperties[prop] = false;
        }
      }
      // Migrate existing saving throw damage multipliers to the new saveDamage
      if (data.flags.midiProperties?.fulldam !== undefined) {
        if (data.flags.midiProperties?.fulldam) data.flags.midiProperties["saveDamage"] = "fulldam";
        item.updateSource({"flags.midiProperties.-=fulldam": null});
      } 
      if (data.flags.midiProperties?.halfdam !== undefined) {
        if (data.flags.midiProperties?.halfdam) data.flags.midiProperties["saveDamage"] = "halfdam";
        item.updateSource({"flags.midiProperties.-=halfdam": null});
      } 
      if (data.flags.midiProperties?.nodam !== undefined) {
        if (data.flags.midiProperties?.nodam) data.flags.midiProperties["saveDamage"] = "nodam";
        item.updateSource({"flags.midiProperties.-=nodam": null});
      } 
      if (data.flags.midiProperties["saveDamage"] === undefined)
        data.flags.midiProperties["saveDamage"] = "default";
      if (data.flags.midiProperties["confirmTargets"] === true)
        data.flags.midiProperties["confirmTargets"] = "always";
      else if (data.flags.midiProperties["confirmTargets"] === false)
        data.flags.midiProperties["confirmTargets"] = "never";
      else if (data.flags.midiProperties["confirmTargets"] === undefined)
        data.flags.midiProperties["confirmTargets"] = "default";

      delete data.flags.midiProperties.fulldam;
      delete data.flags.midiProperties.halfdam;
      delete data.flags.midiProperties.nodam;
    }
    data.showHeader = true;
    if (item.system.properties?.fulldam !== undefined) {
      item.updateSource({ // TODO check this v10
        "system.properties.-=fulldam": null,
        "system.properties.-=halfdam": null,
        "system.properties.-=nodam": null,
        "system.properties.-=critOther": null,
        "flags.midiProperties": data.flags.midiProperties
      })
    }
    return data;
  }

  Hooks.once('tidy5e-sheet.ready', (api) => {
    const myTab = new api.models.HandlebarsTab({
      title: 'Midi Qol',
      tabId: "midi-qol-properties-tab",
      path: '/modules/midi-qol/templates/midiPropertiesForm.hbs',
      enabled: (data) => { return ["spell", "feat", "weapon", "consumable", "equipment", "power", "maneuver"].includes(data.item.type) },
      getData: (data) => {
        data = getItemSheetData(data, data.item);
        data.showHeader = false;
        return data;
      },
      onRender: (params: any) => {
        activateMacroListeners(params.app, params.tabContentsElement);
      }
    });
    api.registerItemTab(myTab);

    api.itemSummary.registerCommands([
      {
        label: i18n("midi-qol.buttons.roll"),
        enabled: (params) => ["weapon", "spell", "power", "feat"].includes(params.item.type),
        iconClass: 'fas fa-dice-d20',
        execute: (params) => {
          if (debugEnabled > 1) log('roll', params.item);
          Workflow.removeWorkflow(params.item.uuid);
          params.item.use({}, { event: params.event, configureDialog: true, systemCard: true });
        },
      },
      {
        label: i18n("midi-qol.buttons.attack"),
        enabled: (params) => params.item.hasAttack,
        execute: (params) => {
          if (debugEnabled > 1) log('attack', params);
          params.item.rollAttack({ event: params.event, versatile: false, resetAdvantage: true, systemCard: true })
        },
      },
      {
        label: i18n("midi-qol.buttons.damage"),
        enabled: (params) => params.item.hasDamage,
        execute: (params) => {
          if (debugEnabled > 1) log('Clicked damage', params);
          params.item.rollDamage({ event: params.event, versatile: false, systemCard: true })
        },
      },
      {
        label: i18n("midi-qol.buttons.versatileDamage"),
        enabled: (params) => itemIsVersatile(params.item),
        execute: (params) => {
          if (debugEnabled > 1) log('Clicked versatile', params);
          params.item.rollDamage({ event: params.event, versatile: true, systemCard: true })
        }
      },
      {
        label: i18n("midi-qol.buttons.itemUse"),
        enabled: (params) => params.item.type === "consumable",
        execute: (params) => {
          if (debugEnabled > 1) log('Clicked consume', params);
          params.item.use({ event: params.event, systemCard: true }, {})
        },
      },
      {
        label: i18n("midi-qol.buttons.itemUse"),
        enabled: (params) => params.item.type === "tool",
        execute: (params) => {
          if (debugEnabled > 1) log('Clicked tool check', params);
          params.item.rollToolCheck({ event: params.event, systemCard: true })
        },
      },
      {
        label: i18n("midi-qol.buttons.info"),
        enabled: (params) => true,
        execute: (params) => {
          if (debugEnabled > 1) log('Clicked info', params);
          showItemInfo.bind(params.item)()
        },
      },
    ]);
  });

  Hooks.on("renderItemSheet", (app, html, data) => {
    const item = app.object;
    if (!item) return;
    if (app.constructor.name !== "Tidy5eKgarItemSheet") {
      if (item && ["spell", "feat", "weapon", "consumable", "equipment", "power", "maneuver"].includes(data.item.type)) {
        data = mergeObject(data, getItemSheetData(data, item));
        renderTemplate("modules/midi-qol/templates/midiPropertiesForm.hbs", data).then(templateHtml => {
          const element = html.find('input[name="system.chatFlavor"]').parent().parent();
          element.append(templateHtml);
          activateMacroListeners(app, html);
        });
      }
      //@ts-expect-error
      if (isNewerVersion(game.system.version, "2.2") && game.system.id === "dnd5e") {
        if (["creature", "ally", "enemy"].includes(item.system.target?.type) && !item.hasAreaTarget) { // stop gap for dnd5e2.2 hiding this field sometimes
          const targetElement = html.find('select[name="system.target.type"]');
          const targetUnitHTML = `
              <select name="system.target.units" data-tooltip="${i18n(getSystemCONFIG().TargetUnits)}">
              <option value="" ${item.system.target.units === '' ? "selected" : ''}></option>
              <option value="ft" ${item.system.target.units === 'ft' ? "selected" : ''}>Feet</option>
              <option value="mi " ${item.system.target.units === 'mi' ? "selected" : ''}>Miles</option>
              <option value="m" ${item.system.target.units === 'm' ? "selected" : ''}>Meters</option>
              <option value="km" ${item.system.target.units === 'km' ? "selected" : ''}>Kilometers</option>
              </select>
            `;
          targetElement.before(targetUnitHTML);
        }
      }
    }


    // activateMacroListeners(app, html);
  })

  Hooks.on("preUpdateItem", (candidate, updates, options, user) => {
    if (updates.system?.target) {
      const targetType = updates.system.target?.type ?? candidate.system.target?.type;
      const noUnits = !["creature", "ally", "enemy"].includes(targetType) && !(targetType in getSystemCONFIG().areaTargetTypes);
      if (noUnits) {
        setProperty(updates, "system.target.units", null);
      }
      // One of the midi specials must specify a count before you can set units
      if (["creature", "ally", "enemy"].includes(targetType) && (updates.system?.target?.value === null || !candidate.system.target.value)) {
        setProperty(updates, "system.target.units", null);
      }
    }
    return true;
  });

  function _chatListeners(html) {
    html.on("click", '.card-buttons button', onChatCardAction.bind(this))
  }

  Hooks.on("renderChatLog", (app, html, data) => _chatListeners(html));

  Hooks.on('dropCanvasData', function (canvas: Canvas, dropData: any) {
    if (!dragDropTargeting) return true;
    if (dropData.type !== "Item") return true;
    if (!canvas?.grid?.grid) return;
    //@ts-ignore .grid v10
    let grid_size = canvas.scene?.grid
    let coords = canvas.grid.grid.getPixelsFromGridPosition(...canvas.grid.grid.getGridPositionFromPixels(dropData.x, dropData.y));
    const targetCount = canvas.tokens?.targetObjects({
      x: coords[0],
      y: coords[1],
      height: grid_size?.size!,
      width: grid_size?.size!
    }, { releaseOthers: true });
    if (targetCount === 0) {
      ui.notifications?.warn("No target selected");
      return true;
    }
    const item = MQfromUuid(dropData.uuid)
    if (!item) {
      const message = `actor / item broke for ${dropData?.uuid}`;
      error(message);
      TroubleShooter.recordError(new Error(message), message);
    }
    item?.use();
    return true;
  })
}

function setupMidiFlagTypes() {
  let config: any = getSystemCONFIG();
  let attackTypes = allAttackTypes.concat(["heal", "other", "save", "util"])

  attackTypes.forEach(at => {
    midiFlagTypes[`flags.midi-qol.DR.${at}`] = "number"
    //  midiFlagTypes[`flags.midi-qol.optional.NAME.attack.${at}`] = "string"
    //  midiFlagTypes[`flags.midi-qol.optional.NAME.damage.${at}`] = "string"
  });
  midiFlagTypes["flags.midi-qol.onUseMacroName"] = "string";

  Object.keys(config.abilities).forEach(abl => {
    // midiFlagTypes[`flags.midi-qol.optional.NAME.save.${abl}`] = "string";
    // midiFlagTypes[`flags.midi-qol.optional.NAME.check.${abl}`] = "string";

  })

  Object.keys(config.skills).forEach(skill => {
    // midiFlagTypes[`flags.midi-qol.optional.NAME.skill.${skill}`] = "string";

  })

  if (game.system.id === "dnd5e") {
    midiFlagTypes[`flags.midi-qol.DR.all`] = "string";
    midiFlagTypes[`flags.midi-qol.DR.non-magical`] = "string";
    midiFlagTypes[`flags.midi-qol.DR.non-silver`] = "string";
    midiFlagTypes[`flags.midi-qol.DR.non-adamant`] = "string";
    midiFlagTypes[`flags.midi-qol.DR.non-physical`] = "string";
    midiFlagTypes[`flags.midi-qol.DR.final`] = "number";

    Object.keys(config.damageResistanceTypes).forEach(dt => {
      midiFlagTypes[`flags.midi-qol.DR.${dt}`] = "string";
    })
  }

  // midiFlagTypes[`flags.midi-qol.optional.NAME.attack.all`] = "string";
  // midiFlagTypes[`flags.midi-qol.optional.NAME.damage.all`] = "string";
  // midiFlagTypes[`flags.midi-qol.optional.NAME.check.all`] = "string";
  // midiFlagTypes[`flags.midi-qol.optional.NAME.save.all`] = "string";
  // midiFlagTypes[`flags.midi-qol.optional.NAME.label`] = "string";
  // midiFlagTypes[`flags.midi-qol.optional.NAME.skill.all`] = "string";
  // midiFlagTypes[`flags.midi-qol.optional.NAME.count`] = "string";
  // midiFlagTypes[`flags.midi-qol.optional.NAME.ac`] = "string";
  // midiFlagTypes[`flags.midi-qol.optional.NAME.criticalDamage`] = "string";
  // midiFlagTypes[`flags.midi-qol.OverTime`] = "string";

}
export function setupHooks() {
}
export const overTimeJSONData = {
  "name": "OverTime Item",
  "type": "weapon",
  "img": "icons/svg/aura.svg",
  "system": {
    "description": {
      "value": "",
      "chat": "",
      "unidentified": ""
    },
    "source": "",
    "quantity": 1,
    "weight": 0,
    "price": 0,
    "attuned": false,
    "attunement": 0,
    "equipped": false,
    "rarity": "",
    "identified": true,
    "activation": {
      "type": "special",
      "cost": 0,
      "condition": ""
    },
    "duration": {
      "value": null,
      "units": ""
    },
    "target": {
      "value": null,
      "width": null,
      "units": "",
      "type": "creature"
    },
    "range": {
      "value": null,
      "long": null,
      "units": ""
    },
    "uses": {
      "value": 0,
      "max": "0",
      "per": ""
    },
    "consume": {
      "type": "",
      "target": "",
      "amount": null
    },
    "preparation": { "mode": "atwill" },
    "ability": "",
    "actionType": "save",
    "attackBonus": 0,
    "chatFlavor": "",
    "critical": null,
    "damage": {
      "parts": [],
      "versatile": ""
    },
    "formula": "",
    "save": {
      "ability": "con",
      "dc": 10,
      "scaling": "flat"
    },
    "armor": {
      "value": 0
    },
    "hp": {
      "value": 0,
      "max": 0,
      "dt": null,
      "conditions": ""
    },
    "weaponType": "simpleM",
    "properties": {
      "ada": false,
      "amm": false,
      "fin": false,
      "fir": false,
      "foc": false,
      "hvy": false,
      "lgt": false,
      "lod": false,
      "mgc": false,
      "rch": false,
      "rel": false,
      "ret": false,
      "sil": false,
      "spc": false,
      "thr": false,
      "two": false,
      "ver": false,
      "nodam": false,
      "fulldam": false,
      "halfdam": false
    },
    "proficient": false,
    "attributes": {
      "spelldc": 10
    }
  },
  "effects": [],
  "sort": 0,
  "flags": {
    "midi-qol": {
      "noCE": true
    }
  }
};

export const itemJSONData = {
  "name": "Concentration Check - Midi QOL",
  "type": "weapon",
  "img": "./modules/midi-qol/icons/concentrate.png",
  "system": {
    "description": {
      "value": "",
      "chat": "",
      "unidentified": ""
    },

    "activation": {
      "type": "special",
      "cost": 0,
      "condition": ""
    },
    "target": {
      "type": ""
    },
    "ability": "",
    "actionType": "save",
    "attackBonus": 0,
    "chatFlavor": "",
    "weaponType": "simpleM",
    "proficient": false,
    "attributes": {
      "spelldc": 10
    }
  },
  "effects": [],
  "sort": 0,
  "flags": {
    "midi-qol": {
      "onUseMacroName": "ItemMacro",
      "isConcentrationCheck": true
    },
    "itemacro": {
      "macro": {

        "_id": null,
        "name": "Concentration Check - Midi QOL",
        "type": "script",
        "author": "devnIbfBHb74U9Zv",
        "img": "icons/svg/dice-target.svg",
        "scope": "global",
        "command": `
              if (MidiQOL.configSettings().autoCheckSaves === 'none') return;
              for (let targetUuid of args[0].targetUuids) {
                let target = await fromUuid(targetUuid);
                if (MidiQOL.configSettings().removeConcentration 
                  && (target.actor.system.attributes.hp.value === 0 || args[0].failedSaveUuids.find(uuid => uuid === targetUuid))) {
                const concentrationEffect = MidiQOL.getConcentrationEffect(target.actor);
                if (concentrationEffect) await concentrationEffect.delete();
                }
              }`,
        "folder": null,
        "sort": 0,
        "permission": {
          "default": 0
        },
        "flags": {}
      }
    },
  }
}
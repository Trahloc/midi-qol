import { debug, warn, i18n, error, debugEnabled, MQdefaultDamageType, i18nFormat, GameSystemConfig } from "../midi-qol.js";
import { DDBGameLogWorkflow, Workflow } from "./workflow.js";
import { nsaFlag, coloredBorders, addChatDamageButtons, configSettings, forceHideRoll } from "./settings.js";
import { createDamageDetail, MQfromUuid, playerFor, playerForActor, applyTokenDamage, doOverTimeEffect, isInCombat } from "./utils.js";
import { socketlibSocket, untimedExecuteAsGM } from "./GMAction.js";
import { TroubleShooter } from "./apps/TroubleShooter.js";
export const MAESTRO_MODULE_NAME = "maestro";
export const MODULE_LABEL = "Maestro";

export let colorChatMessageHandler = (message, html, data) => {
  if (coloredBorders === "none") return true;
  let actorId = message.speaker.actor;
  let userId = message.user;
  let actor = game.actors?.get(actorId);
  let user = game.users?.get(userId);

  if (actor) user = playerForActor(actor);
  if (!user) return true;
  //@ts-ignore .color not defined
  html[0].style.borderColor = user.color;
  const sender = html.find('.message-sender')[0];
  if (!sender) return;
  if (coloredBorders === "borderNamesBackground") {
    sender.style["text-shadow"] = `1px 1px 1px #FFFFFF`;
    //@ts-ignore .color not defined
    sender.style.backgroundColor = user.color;
  } else if (coloredBorders === "borderNamesText") {
    //@ts-ignore .color not defined
    sender.style.color = user.color;
    sender.style["text-shadow"] = `1px 1px 1px ${sender.style.color}`;
  }
  return true;
}

// TODO think about monks tb on preUpdateChatMessage?
// Also should ideally be async.
export function checkOverTimeSaves(message, data, options, user) {
  if (!message.rolls?.length || !["skill", "save", "ability"].includes(data.flags?.dnd5e?.roll?.type)) return true;
  let actor: Actor | undefined | null = game.actors?.get(message.speaker.actor);
  if (message.speaker.token) {
    actor = game.scenes?.get(message.speaker.scene)?.tokens?.get(message.speaker.token)?.actor;
  }
  if (!actor) return true;
  // Check that it is the actor's turn
  let activeCombatants = game.combats?.combats.map(combat => combat.combatant?.token?.id)
  const isTurn = activeCombatants?.includes(ChatMessage.getSpeaker({ actor })?.token);
  const inCombat = isInCombat(actor);
  if (!isTurn && inCombat) {
    return true;
  }

  try {
    let func = async (actor: Actor, rollFlags: any, roll: Roll) => {
      //@ts-ignore .changes v10
      for (let effect of actor.effects.filter(ef => ef.changes.some(change => change.key === "flags.midi-qol.OverTime"))) {
        await doOverTimeEffect(actor, effect, true, { saveToUse: roll, rollFlags: data.flags?.dnd5e?.roll, isActionSave: true })
      }
    };
    func(actor, data.flags.dnd5e.roll, message.rolls[0]);
  } catch (err) {
    const message = `checkOverTimeSaves error for ${actor?.name} ${actor.uuid}`;
    console.warn(message, err);
    TroubleShooter.recordError(err, message);
  } finally {
    return true;
  }
}

export let nsaMessageHandler = (message, data, ...args) => {
  if (!nsaFlag || !message.whisper || message.whisper.length === 0) return true;
  let gmIds = ChatMessage.getWhisperRecipients("GM").filter(u => u.active)?.map(u => u.id);
  let currentIds = message.whisper.map(u => typeof (u) === "string" ? u : u.id);
  gmIds = gmIds.filter(id => !currentIds.includes(id));
  if (debugEnabled > 1) debug("nsa handler active GMs ", gmIds, " current ids ", currentIds, "extra gmIds ", gmIds)
  if (gmIds.length > 0) message.updateSource({ "whisper": currentIds.concat(gmIds) });
  return true;
}

let _highlighted: Token | null = null;

let _onTargetHover = (event) => {
  event.preventDefault();
  if (!canvas?.scene?.active) return;
  const token: Token | undefined = canvas?.tokens?.get(event.currentTarget.id);
  if (token?.isVisible) {
    //@ts-ignore _controlled, _onHoverIn
    if (!token?._controlled) token._onHoverIn(event);
    _highlighted = token;
  }
}

/* -------------------------------------------- */

/**
 * Handle mouse-unhover events for a combatant in the chat card
 * @private
 */
let _onTargetHoverOut = (event) => {
  event.preventDefault();
  if (!canvas?.scene?.active) return;
  //@ts-ignore onHoverOut
  if (_highlighted) _highlighted._onHoverOut(event);
  _highlighted = null;
}

let _onTargetSelect = (event) => {
  event.preventDefault();
  if (!canvas?.scene?.active) return;
  const token = canvas.tokens?.get(event.currentTarget.id);
  //@ts-ignore multiSelect
  token?.control({ multiSelect: false, releaseOthers: true });
};

function _onTargetShow(event) {
  event.stopImmediatePropagation();
  event.preventDefault();
  if (!canvas?.scene?.active) return;
  const token = canvas.tokens?.get(event.currentTarget.id);
  if (token) token.actor?.sheet?.render(true);
}

export let hideRollRender = (msg, html, data) => {
  if (forceHideRoll && (msg.whisper.length > 0 || msg?.blind)) {
    if (!game.user?.isGM && !msg.isAuthor && msg.whisper.indexOf(game.user?.id) === -1) {
      if (debugEnabled > 0) warn("hideRollRender | hiding message", msg.whisper)
      // html.hide();
      html.remove();
    }
  }
  return true;
};

export let hideRollUpdate = (message, data, diff, id) => {
  if (forceHideRoll && message.whisper.length > 0 || message.blind) {
    if (!game.user?.isGM && ((!message.isAuthor && (message.whisper.indexOf(game.user?.id) === -1) || message.blind))) {
      let messageLi = $(`.message[data-message-id=${data._id}]`);
      if (debugEnabled > 0) warn("hideRollUpdate: Hiding ", message.whisper, messageLi)
      messageLi.hide();
      //@ts-ignore
      if (window.ui.sidebar.popouts.chat) {
        //@ts-ignore
        let popoutLi = window.ui.sidebar.popouts.chat.element.find(`.message[data-message-id=${data._id}]`)
        popoutLi.hide();
      }
    }
  }
  return true;
};

export let hideStuffHandler = (message, html, data) => {
  if (debugEnabled > 1) debug("hideStuffHandler message: ", message.id, message)
  // if (getProperty(message, "flags.monks-tokenbar")) return;
  const midiqolFlags = getProperty(message, "flags.midi-qol");
  // Hide rolls which are blind and not the GM if force hide is true
  if (forceHideRoll && message.blind && !game.user?.isGM) {
    html.hide();
    return;
  }

  // If force hide rolls and your are not the author/target of a whisper roll hide it.
  if (forceHideRoll
    && !game.user?.isGM
    && message.whisper.length > 0 && !message.whisper.includes(game.user?.id)
    && !message.isAuthor) {
    html.remove();
    return;
  }

  if (game.user?.id !== message.user?.id) {
    html.find(".midi-qol-attack-buttons").hide();
    html.find(".midi-qol-damage-buttons").hide();
    html.find(".midi-qol-otherDamage-button").hide();
    html.find(".midi-qol-versatile-damage-button").hide();
  }


  if (game.user?.isGM) {
    let ids = html.find(".midi-qol-target-name")
    ids.hover(_onTargetHover, _onTargetHoverOut)
    ids.click(_onTargetSelect);
    ids.contextmenu(_onTargetShow)
    html.find(".midi-qol-playerTokenName").remove();
    if (configSettings.hidePlayerDamageCard && $(html).find(".midi-qol-player-damage-card").length) html.hide();

    if ($(html).find(".midi-qol-hits-display").length) {
      if (configSettings.mergeCard) {
        $(html).find(".midi-qol-hits-display").show();
      } else {
        html.show();
      }
    }
    html.find(".midi-qol-target-npc-Player").hide();

    //@ts-ignore
    ui.chat.scrollBottom
    return;

  } else {
    // hide tool tips from non-gm
    html.find(".midi-qol-save-tooltip").hide();
    // if not showing saving throw total hide from players
    if (configSettings.autoCheckSaves === "allNoRoll") {
      html.find(".midi-qol-save-total").remove();
      html.find(".midi-qol-save-full-display").hide();
    }
    // Hide the save dc if required
    if (!configSettings.displaySaveDC) {
      html.find(".midi-qol-saveDC").hide();
    }
    if (message.blind) {
      html.find(".midi-attack-roll .dice-roll").replaceWith(`<span>${i18n("midi-qol.DiceRolled")}</span>`);
      // html.find(".midi-damage-roll .dice-roll").replaceWith(`<span>${i18n("midi-qol.DiceRolled")}</span>`);
      if (!(message.flags && message.flags["monks-tokenbar"])) // not a monks roll
        html.find(".dice-roll").replaceWith(`<span>${i18n("midi-qol.DiceRolled")}</span>`);
      // html.find(".dice-result").replaceWith(`<span>${i18n("midi-qol.DiceRolled")}</span>`); Monks saving throw css
      //TODO this should probably just check formula
    }
    if ((configSettings.autoCheckHit === "whisper" || message.blind)) {
      if (configSettings.mergeCard) {
        html.find(".midi-qol-hits-display").hide();
      } else if (html.find(".midi-qol-single-hit-card").length === 1 && data.whisper) {
        html.hide();
      }
    }
    if ((configSettings.autoCheckSaves === "whisper" || message.blind)) {
      if (configSettings.mergeCard) {
        html.find(".midi-qol-saves-display").hide();
      } else if (html.find(".midi-qol-saves-display").length === 1 && data.whisper) {
        html.hide();
      }
    }
    if (!configSettings.displayHitResultNumeric) {
      html.find(".midi-qol-npc-ac").remove();
    }

    if (message.user?.id !== game.user?.id || configSettings.confirmAttackDamage === "gmOnly") {
      html.find(".midi-qol-confirm-damage-roll-complete-hit").hide();
      html.find(".midi-qol-confirm-damage-roll-complete-miss").hide();
      html.find(".midi-qol-confirm-damage-roll-complete-critical").hide();
    }

    if (!game.user?.isGM) {
      // Can update the attack roll here, but damage rolls are redone in the ChatmessageMidi code so do the hiding for those there
      html.find(".midi-qol-confirm-damage-roll-cancel").hide();
      // hide the gm version of the name from` players
      html.find(".midi-qol-gmTokenName").remove();
    }
  }
  //@ts-ignore
  setTimeout(() => ui.chat.scrollBottom(), 0);
  return true;

}

export let chatDamageButtons = (message, html, data) => {
  if (debugEnabled > 1) debug("Chat Damage Buttons ", addChatDamageButtons, message, message.flags?.dnd5e?.roll?.type, message.flags)
  const shouldAddButtons = addChatDamageButtons === "both"
    || (addChatDamageButtons === "gm" && game.user?.isGM)
    || (addChatDamageButtons === "pc" && !game.user?.isGM);

  if (!shouldAddButtons || configSettings.v3DamageApplication) {
    return true;
  }
  let targetField = ".dice-formula";
  if (["formula", "formulaadv"].includes(configSettings.rollAlternate))
    targetField = ".dice-total";
  if (["damage", "other"].includes(message.flags?.dnd5e?.roll?.type)) {
    let item;
    let itemId;
    let actorId = message.speaker.actor;
    //@ts-expect-error
    let theRolls = message.rolls.filter(r => r instanceof CONFIG.Dice.DamageRoll || message.flags.dnd5e.roll.type === "other");
    if (theRolls.length === 0) return;
    if (["damage", "other"].includes(message.flags?.dnd5e?.roll?.type)) {
      itemId = message.flags.dnd5e?.roll.itemId;
      if (game.system.id === "sw5e" && !itemId) itemId = message.flags.sw5e?.roll.itemId;

      item = game.actors?.get(actorId)?.items.get(itemId);
      if (!item) {
        if (debugEnabled > 0) warn("Damage roll for non item");
        return;
      }
    }
    let itemUuid = `Actor.${actorId}.Item.${itemId}`;
    // find the item => workflow => damageList, totalDamage
    let defaultDamageType;
    //@ts-expect-error .version
    if (isNewerVersion(game.system.version, "2.4.99")) {
      defaultDamageType = (item?.system.damage?.parts[0]?.damageType) ?? "bludgeoning";
    } else {
      defaultDamageType = (item?.system.damage?.parts[0] && item?.system.damage.parts[0][1]) ?? "bludgeoning";
    }
    // TODO fix this for versatile damage
    const damageList = createDamageDetail({ roll: theRolls, item, ammo: null, versatile: false, defaultType: defaultDamageType });
    const totalDamage = theRolls.reduce((acc, r) => r.total + acc, 0);
    addChatDamageButtonsToHTML(totalDamage, damageList, html, actorId, itemUuid, "damage", targetField, "position:relative; top:0px; color:black");
  } else if (getProperty(message, "flags.midi-qol.damageDetail") || getProperty(message, "flags.midi-qol.otherDamageDetail")) {
    let midiFlags = getProperty(message, "flags.midi-qol");
    let targetField = ".dice-formula";
    if (["formula", "formulaadv"].includes(configSettings.rollAlternate))
      targetField = ".dice-formula";
    addChatDamageButtonsToHTML(midiFlags.damageTotal, midiFlags.damageDetail, html, midiFlags.actorUuid, midiFlags.itemUuid, "damage", `.midi-qol-damage-roll ${targetField}`);
    addChatDamageButtonsToHTML(midiFlags.otherDamageTotal, midiFlags.otherDamageDetail, html, midiFlags.actorUuid, midiFlags.itemUuid, "other", `.midi-qol-other-damage-roll ${targetField}`);
    addChatDamageButtonsToHTML(midiFlags.bonusDamageTotal, midiFlags.bonusDamageDetail, html, midiFlags.actorUuid, midiFlags.itemUuid, "bonus", `.midi-qol-bonus-damage-roll ${targetField}`);
  }
  return true;
}

export function addChatDamageButtonsToHTML(totalDamage, damageList, html, actorId, itemUuid, tag = "damage", toMatch = ".dice-total", style = "margin: 0px;") {
  if (debugEnabled > 1) debug("addChatDamageButtons", totalDamage, damageList, html, actorId, itemUuid, toMatch, $(html).find(toMatch))
  const btnContainer = $('<span class="dmgBtn-container-mqol"></span>');
  let btnStylingLimeGreen = `background-color:var(--dnd5e-color-success); ${style}`;
  let btnStylingLightGreen = `background-color:var(--dnd5e-color-success-background); ${style}`;
  let btnStylingRed = `background-color: var(--dnd5e-color-failure-background); ${style}`;
  const fullDamageButton = $(`<button class="dice-total-full-${tag}-button dice-total-full-button" style="${btnStylingRed}"><i class="fas fa-user-minus" title="Click to apply up to ${totalDamage} damage to selected token(s)."></i></button>`);
  const halfDamageButton = $(`<button class="dice-total-half-${tag}-button dice-total-half-button" style="${btnStylingRed}"><i title="Click to apply up to ${Math.floor(totalDamage / 2)} damage to selected token(s).">&frac12;</i></button>`);
  const quarterDamageButton = $(`<button class="dice-total-quarter-${tag}-button dice-total-quarter-button" style="${btnStylingRed}"><i title="Click to apply up to ${Math.floor(totalDamage / 4)} damage to selected token(s).">&frac14;</i></button>`);
  const doubleDamageButton = $(`<button class="dice-total-double-${tag}-button dice-total-double-button" style="${btnStylingRed}"><i title="Click to apply up to ${totalDamage * 2} damage to selected token(s).">2</i></button>`);
  const fullHealingButton = $(`<button class="dice-total-full-${tag}-healing-button dice-total-healing-button" style="${btnStylingLimeGreen}"><i class="fas fa-user-plus" title="Click to heal up to ${totalDamage} to selected token(s)."></i></button>`);
  const fullTempHealingButton = $(`<button class="dice-total-full-${tag}-temp-healing-button dice-total-healing-button" style="${btnStylingLightGreen}"><i class="fas fa-user-plus" title="Click to add up to ${totalDamage} to selected token(s) temp HP."></i></button>`);

  btnContainer.append(fullDamageButton);
  btnContainer.append(halfDamageButton);
  // if (!configSettings.mergeCardCondensed) btnContainer.append(quarterDamageButton);
  btnContainer.append(quarterDamageButton);
  btnContainer.append(doubleDamageButton);
  btnContainer.append(fullHealingButton);
  btnContainer.append(fullTempHealingButton);

  const toMatchElement = $(html).find(toMatch);
  toMatchElement.addClass("dmgBtn-mqol");
  toMatchElement.append(btnContainer);

  // html.querySelectorAll(toMatch).forEach(el => {el.classList.add("dmgBtn-mdqol"); el.append(btnContainer)});
  // Handle button clicks
  let setButtonClick = (buttonID, mult) => {
    let button = btnContainer.find(buttonID);
    button.off("click");
    button.on("click", async (ev) => {
      ev.stopPropagation();
      // const item = game.actors.get(actorId).items.get(itemId);
      const item = MQfromUuid(itemUuid);
      const modDamageList = duplicate(damageList).map(di => {
        if (mult === -1) di.type = "healing";
        else if (mult === -2) di.type = "temphp";
        else di.damage = Math.floor(di.damage * mult);
        return di;
      });

      // find solution for non-magic weapons
      let promises: Promise<any>[] = [];
      if (canvas?.tokens?.controlled && canvas?.tokens?.controlled?.length > 0) {
        const totalDamage = modDamageList.reduce((acc, value) => value.damage + acc, 0);
        await applyTokenDamage(modDamageList, totalDamage, new Set(canvas.tokens.controlled), item, new Set(),
          { existingDamage: [], superSavers: new Set(), semiSuperSavers: new Set(), workflow: undefined, updateContext: undefined, forceApply: true });
      }
    });
  };
  setButtonClick(`.dice-total-full-${tag}-button`, 1);
  setButtonClick(`.dice-total-half-${tag}-button`, 0.5);
  setButtonClick(`.dice-total-double-${tag}-button`, 2);
  setButtonClick(`.dice-total-quarter-${tag}-button`, 0.25);

  setButtonClick(`.dice-total-full-${tag}-healing-button`, -1);
  setButtonClick(`.dice-total-full-${tag}-temp-healing-button`, -2);

  // logic to only show the buttons when the mouse is within the chat card and a token is selected
  btnContainer.hide
  $(html).hover(evIn => {
    if (canvas?.tokens?.controlled && canvas.tokens.controlled.length > 0) {
      btnContainer.show();
    }
  }, evOut => {
    btnContainer.show();
  });
  return html;
}

export function processItemCardCreation(message, user) {
  const midiFlags = message.flags["midi-qol"];
  if (user === game.user?.id && midiFlags?.workflowId) { // check to see if it is a workflow
    const workflow = Workflow.getWorkflow(midiFlags.workflowId);
    if (!workflow) return;
    if (debugEnabled > 0) warn("processItemCardCreation", message.id, workflow.itemCardId, workflow.ItemCardUuid, workflow.workflowName)
    workflow.itemCardId = message.id;
    workflow.itemCardUuid = message.uuid;
    workflow.needItemCard = false;
    const shouldUnsuspend = ([workflow.WorkflowState_AwaitItemCard, workflow.WorkflowState_AwaitTemplate, workflow.WorkflowState_NoAction].includes(workflow.currentAction) && workflow.suspended && !workflow.needTemplate && !workflow.needItemCard && workflow.preItemUseComplete); if (debugEnabled > 0) warn(`chat card created: unsuspending ${workflow.workflowName} ${workflow.nameForState(workflow.currentAction)} unsuspending: ${shouldUnsuspend}, workflow suspended: ${workflow.suspended} needs template: ${workflow.needTemplate}, needs Item card ${workflow.needItemCard}, itemUseomplete: ${workflow.preItemUseComplete}`);
    if (shouldUnsuspend) {
      workflow.unsuspend({ itemCardId: message.id, itemCarduuid: message.uuid, itemUseComplete: true });
    }
  }
}

export async function onChatCardAction(event) {
  event.preventDefault();
  // Extract card data - TODO come back and clean up this nastiness
  const button = event.currentTarget;
  button.disabled = true;
  const card = button.closest(".chat-card");
  const messageId = card.closest(".message").dataset.messageId;
  const message = game.messages?.get(messageId);
  const action = button.dataset.action;
  let targets = game.user?.targets;

  // Validate permission to proceed with the roll
  if (!(game.user?.isGM || message?.isAuthor)) return;
  if (!["confirm-damage-roll-complete", "confirm-damage-roll-complete-hit", "confirm-damage-roll-complete-miss", "confirm-damage-roll-cancel", "applyEffects", "attack-adv", "attack-dis", "damage-critical", "damage-nocritical"].includes(action)) return;
  if (!message?.user) return;

  //@ts-ignore speaker
  var actor, item;

  // Recover the actor for the chat card
  //@ts-ignore
  actor = await CONFIG.Item.documentClass._getChatCardActor(card);
  if (!actor) return;

  // Get the Item from stored flag data or by the item ID on the Actor
  const storedData = message?.getFlag(game.system.id, "itemData");
  //@ts-ignore
  item = storedData ? new CONFIG.Item.documentClass(storedData, { parent: actor }) : actor.items.get(card.dataset.itemId);

  const spellLevel = parseInt(card.dataset.spellLevel) || null;
  const workflowId = getProperty(message, "flags.midi-qol.workflowId");

  switch (action) {
    case "applyEffects":
      if (!actor || !item) return;
      if ((targets?.size ?? 0) === 0) return;
      button.disabled = false;
      if (game.user?.id !== message.user?.id) {
        // applying effects on behalf of another user;
        if (!game.user?.isGM) {
          ui.notifications?.warn("Only the GM can apply effects for other players")
          return;
        }
        if (game.user.targets.size === 0) {
          ui.notifications?.warn(i18n("midi-qol.noTokens"));
          return;
        }
        const result = (await socketlibSocket.executeAsUser("applyEffects", message.user?.id, {
          workflowId: item.uuid,
          targets: Array.from(game.user.targets).map(t => t.document.uuid)
        }));
      } else {
        let workflow = Workflow.getWorkflow(item.uuid);
        if (workflow) {
          workflow.forceApplyEffects = true; // don't overwrite the application targets
          workflow.applicationTargets = game.user?.targets;
          if (workflow.applicationTargets.size > 0) workflow.performState(workflow.WorkflowState_ApplyDynamicEffects)
        } else {
          ui.notifications?.warn(i18nFormat("midi-qol.NoWorkflow", { itemName: item.name }));
        }
      }
      break;
    case "Xconfirm-damage-roll-cancel":
      if (!await untimedExecuteAsGM("undoTillWorkflow", item.uuid, true, true)) {
        await game.messages?.get(messageId)?.delete();
      };
      break;
    case "confirm-damage-roll-complete":
    case "confirm-damage-roll-complete-hit":
    case "confirm-damage-roll-complete-miss":
    case "confirm-damage-roll-cancel":
      if (message.user?.id) {
        if (!game.user?.isGM && configSettings.confirmAttackDamage === "gmOnly") {
          return;
        }
        const user = game.users?.get(message.user?.id);
        if (user?.active) {
          let actionToCall = {
            "confirm-damage-roll-complete": "confirmDamageRollComplete",
            "confirm-damage-roll-complete-hit": "confirmDamageRollCompleteHit",
            "confirm-damage-roll-complete-miss": "confirmDamageRollCompleteMiss",
            "confirm-damage-roll-cancel": "cancelWorkflow"
          }[action];
          socketlibSocket.executeAsUser(actionToCall, message.user?.id, { workflowId, itemCardId: message.id, itemCardUuid: message.uuid }).then(result => {
            if (typeof result === "string") ui.notifications?.warn(result);
          });
        } else {
          await Workflow.removeItemCardAttackDamageButtons(messageId);
          await Workflow.removeItemCardConfirmRollButton(messageId);
        }
      }
      break;
    case "attack-adv":
    case "attack-dis":
      await item.rollAttack({
        event,
        spellLevel,
        advantage: action === "attack-adv",
        disadvantage: action === "attack-dis",
        fastForward: true
      })
      break;
    case "damage-critical":
    case "damage-nocritical":
      await item.rollDamage({
        event,
        spellLevel,
        options: { critical: action === 'damage-critical' }
      })
    default:
      break;
  }
  button.disabled = false;
}

export function ddbglPendingFired(data) {
  let { sceneId, tokenId, actorId, itemId, actionType } = data;
  if (!itemId || !["attack", "damage", "heal"].includes(actionType)) {
    error("DDB Game Log - no item/action for pending roll"); return
  }
  // const tokenUuid = `Scene.${sceneId??0}.Token.${tokenId??0}`;
  const token = MQfromUuid(`Scene.${sceneId ?? 0}.Token.${tokenId ?? 0}`);
  const actor = (token instanceof CONFIG.Token.documentClass) ? token?.actor ?? game.actors?.get(actorId ?? "") : undefined;
  if (!actor || !(token instanceof CONFIG.Token.documentClass)) {
    warn(" ddb-game-log hook could not find actor");
    return;
  }
  // find the player who controls the character.
  let player;
  if (token) {
    player = playerFor(token);
  } else {
    player = game.users?.players.find(p => p.active && actor?.permission[p.id ?? ""] === CONST.ENTITY_PERMISSIONS.OWNER)
  }
  if (!player || !player.active) player = ChatMessage.getWhisperRecipients("GM").find(u => u.active);
  if (player?.id !== game.user?.id) return;

  let item = actor.items.get(itemId);
  if (!item) {
    warn(` ddb-game-log - hook could not find item ${itemId} on actor ${actor.name}`);
    return;
  }

  let workflow: Workflow | undefined = DDBGameLogWorkflow.get(item.uuid);
  if (actionType === "attack") workflow = undefined;
  //@ts-ignore .hasAttack
  if (["damage", "heal"].includes(actionType) && item.hasAttack && !workflow) {
    warn(` ddb-game-log damage roll without workflow being started ${actor.name} using ${item.name}`);
    return;
  }

  if (!workflow) {
    const speaker = {
      scene: sceneId,
      token: tokenId,
      actor: actorId,
      alias: token?.name ?? actor.name
    }
    //@ts-ignore
    workflow = new DDBGameLogWorkflow(actor, item, speaker, game.user.targets, {});
    //@ts-ignore .displayCard
    item.displayCard({ showFullCard: false, workflow, createMessage: false, defaultCard: true });
    // showItemCard.bind(item)(false, workflow, false, true);

    return;
  }

}
export function ddbglPendingHook(data) { // need to propagate this to all players.
  if (!configSettings.optionalRules.enableddbGL) return;
  socketlibSocket.executeForEveryone("ddbglPendingFired", data);
}

export function processCreateDDBGLMessages(message: ChatMessage, options: any, user: string) {
  if (!configSettings.optionalRules.enableddbGL) return;
  //@ts-ignore flags v10
  const flags: any = message.flags;
  if (!flags || !flags["ddb-game-log"] || !game.user) return;
  const ddbGLFlags: any = flags["ddb-game-log"];
  if (!ddbGLFlags || ddbGLFlags.pending) return;
  // let sceneId, tokenId, actorId, itemId;
  //@ts-ignore
  if (!(["attack", "damage", "heal"].includes(flags.dnd5e?.roll?.type))) return;
  const itemId = flags.dnd5e?.roll?.itemId;
  if (!itemId) { error("Could not find item for fulfilled roll"); return }
  //@ts-ignore speaker v10
  const token = MQfromUuid(`Scene.${message.speaker.scene}.Token.${message.speaker.token}`);
  //@ts-ignore speaker v10
  const actor = token.actor ?? game.actors?.get(message.speaker.actor ?? "");
  if (!actor) {
    error("ddb-game-log could not find actor for roll");
    return;
  }
  // find the player who controls the charcter.
  let player;
  if (token) {
    player = playerFor(token);
  } else {
    player = game.users?.players.find(p => p.active && actor?.permission[p.id ?? ""] === CONST.ENTITY_PERMISSIONS.OWNER)
  }
  if (!player || !player.active) player = ChatMessage.getWhisperRecipients("GM").find(u => u.active);
  if (player?.id !== game.user?.id) return;

  const item = actor.items.get(itemId);
  if (!item) {
    error(`ddb-game-log roll could not find item ${flags.dnd5e.roll.itemId} on actor ${actor.name}`);
    return;
  }

  let workflow: Workflow | undefined = DDBGameLogWorkflow.get(item.uuid);
  if (!workflow && flags.dnd5e.roll.type === "damage" && item.hasAttack && ["rwak", "mwak"].includes(item.actionType)) {
    warn(`ddb-game-log roll damage roll wihtout workflow being started ${actor.name} using ${item.name}`);
    return;
  }
  if (!workflow) {
    error(`ddb-game-log roll no workflow for ${item.name}`)
    return;
  }
  if (flags.dnd5e.roll.type === "attack") {
    workflow.needItemCard = false;
    workflow.attackRoll = message.roll ?? undefined;
    workflow.attackTotal = message.roll?.total ?? 0;
    //@ts-ignore content v10
    workflow.attackRollHTML = message.content;
    workflow.attackRolled = true;
    if (workflow.currentAction === workflow.WorkflowState_WaitForAttackRoll) {
      if (workflow.suspended) workflow.unsuspend({ attackRoll: workflow.attackRoll })
      // TODO NW workflow.performState(workflow.WorkflowState_WaitForAttackRoll,{attackRoll: workflow.attackRoll});
    }
  }

  if (["damage", "heal"].includes(flags.dnd5e.roll.type)) {
    workflow.needItemCard = false;
    workflow.attackRolled = true;
    if (!workflow.damageRolled && message.roll) {
      workflow.setDamageRolls(message.roll);
    } else if (workflow.needsOtherDamage && message.roll) {
      workflow.setOtherDamageRoll(message.roll);
      workflow.needsOtherDamage = false;
    }
    workflow.damageRolled = true;
    if (workflow.currentAction === workflow.WorkflowState_WaitForDamageRoll) {
      if (workflow.suspended) workflow.unsuspend({ damageRoll: workflow.damageRoll })
      // TODO NW workflow.performState(workflow.WorkflowState_WaitForDamageRoll);
    }
  }
}

function legacyApplyTokenDamageMany(arg0: any[], arg1: Set<Token>, arg2: null, arg3: { existingDamage: never[]; workflow: undefined; updateContext: undefined; }) {
  throw new Error("Function not implemented.");
}

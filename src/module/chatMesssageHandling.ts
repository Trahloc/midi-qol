import { debug, log, warn, i18n, error, MESSAGETYPES, timelog } from "../midi-qol";
//@ts-ignore
import Actor5e from "../../../systems/dnd5e/module/actor/entity.js"
//@ts-ignore
import Item5e  from "../../../systems/dnd5e/module/item/entity.js"

import { installedModules } from "./setupModules";
import { BetterRollsWorkflow, Workflow, WORKFLOWSTATES } from "./workflow";
import { nsaFlag, coloredBorders, criticalDamage, saveRequests, saveTimeouts, checkBetterRolls, addChatDamageButtons, configSettings, forceHideRoll, enableWorkflow } from "./settings";
import { createDamageList, getTraitMult, calculateDamage, getSelfTargetSet, getSelfTarget, addConcentration } from "./utils";
import { config } from "process";
import { setupSheetQol } from "./sheetQOL";

export const MAESTRO_MODULE_NAME = "maestro";

export const MODULE_LABEL = "Maestro";

export function mergeCardSoundPlayer(message, update, options, user) {
  debug("Merge card sound player ", message.data, getProperty(update, "flags.midi-qol.playSound"), message.data.sound)
  const firstGM = game.user; //game.users.find(u=> u.isGM && u.active);
  if (game.user !== firstGM) return;
  const updateFlags = getProperty(update, "flags.midi-qol") || {};
  const midiqolFlags = mergeObject(getProperty(message.data, "flags.midi-qol") || {}, updateFlags, { inplace: false, overwrite: true })
  if (midiqolFlags.playSound && configSettings.useCustomSounds) {
    const playlist = game.playlists.get(configSettings.customSoundsPlaylist);
    const sound = playlist?.sounds.find(s=>s._id === midiqolFlags.sound)
    const dice3dActive = game.dice3d && (game.settings.get("dice-so-nice", "settings")?.enabled)
    const delay = (dice3dActive && midiqolFlags?.waitForDiceSoNice && [MESSAGETYPES.HITS].includes(midiqolFlags.type)) ? 500 : 0;
    debug("mergeCardsound player ", update, playlist, sound, sound?'playing sound':'not palying sound', delay)

    if (sound) {
      setTimeout(() => {
       sound.playing = true;
        playlist.playSound(sound);
      }, delay)
    }

    //@ts-ignore
    // AudioHelper.play({ src: update.sound || midiqolFlags.sound }, true);
    return true;
  }
}

export function processcreateBetterRollMessage(message, options, user) {
  const flags = message.data.flags?.betterrolls5e;
  if (!flags) return;
  const uuid = `Actor.${flags.actorId}.OwnedItem.${flags.itemId}`;
  let workflow: BetterRollsWorkflow = BetterRollsWorkflow.get(uuid);

  if (workflow) {
    workflow.itemCardId = message.id;
    workflow.next(WORKFLOWSTATES.NONE);
  }
  return true;
}

export let processpreCreateBetterRollsMessage = (data: any, options:any, user: any) => {
  const brFlags = data.flags?.betterrolls5e;
  if (installedModules["betterrolls5e"] || !brFlags) return true;
  debug("process precratebetteerrollscard ", data, options, installedModules["betterrolls5e"], data.content?.startsWith('<div class="dnd5e red-full chat-card"') )

  let token: Token = canvas.tokens.get(data.speaker.token)
  let actor: Actor5e = token?.actor;
  let speaker;
  if (!actor) {
    actor = game.actors.get(data.speaker.actor);
    speaker = ChatMessage.getSpeaker({actor})
    token = canvas.tokens.get(speaker.token);
    if (!token) {
      console.error("too bad - no token selected");
      return true;
    } 
  } else speaker = data.speaker;
  let item: Item5e = actor.items.get(brFlags.itemId);

  // Try and help name hider
  if (!data.speaker.scene) data.speaker.scene = canvas.scene.id;
  if (!data.speaker.token) data.speaker.token = token.id;
  let damageStart = 0;
  let attackTotal = -1;
  let diceRoll;
  let html = $(data.content);
  let rollDivs = html.find(".dice-roll.red-dual");//.find(".dice-row-item");

  if (item.hasAttack) {
    damageStart = 1
    const attackRolls = $(rollDivs[0]).find(".dice-total");
    let diceRolls = $(rollDivs[0]).find(".roll.die.d20");
    for (let i = 0; i < attackRolls.length; i++) {
      if (!attackRolls[i].classList.value.includes("ignore")) {
        attackTotal = parseInt(attackRolls[i]?.innerHTML);
        diceRoll = parseInt(diceRolls[i]?.innerHTML);
        break;
      }
    }
  }

  let damageList = [];
  let otherDamageList = [];
  for (let entry of brFlags.entries) {
    if (entry.type === "damage") {
      let damage = entry.baseRoll.total;
      let type = entry.damageType;
      if (brFlags.isCrit && entry.critRoll) damage += entry.critRoll.total;
      // Check for versatile and flag set.
      if (entry.damageIndex !== "other")
        damageList.push({type, damage});
      else if(configSettings.rollOtherDamage)
        otherDamageList.push({type, damage});
    }
  }

  BetterRollsWorkflow.removeWorkflow(item.uuid);
  const targets = (item?.data.data.target?.type === "self") ? new Set([token]) : new Set(game.user.targets);
  let workflow = new BetterRollsWorkflow(actor, item, speaker, targets, null);
  workflow.isCritical = brFlags.isCrit;
  workflow.isFumble = diceRoll === 1;
  workflow.attackTotal = attackTotal;
  workflow.attackRoll = new Roll(`${attackTotal}`).roll();

  workflow.damageDetail = damageList;
  workflow.damageTotal = damageList.reduce((acc, a) => a.damage + acc, 0);

  if (otherDamageList.length > 0) {
    workflow.otherDamageTotal = otherDamageList.reduce((acc, a) => a.damage + acc, 0);
    workflow.otherDamageRoll = new Roll(`${workflow.otherDamageTotal}`).roll();
  }

  workflow.itemLevel = brFlags.params.slotLevel ?? 0;
  workflow.itemCardData = data;
  workflow.advantage = brFlags.params.adv === 1;
  workflow.disadvantage = brFlags.params.disadv === 1;
  if (!workflow.tokenId) workflow.tokenId = token.id;
  if (configSettings.concentrationAutomation) {
    let doConcentration = async () => {
      const concentrationName = game.settings.get("combat-utility-belt", "concentratorConditionName");
      const needsConcentration = workflow.item.data.data.components?.concentration;
      const checkConcentration = installedModules.get("combat-utility-belt") && configSettings.concentrationAutomation;
      if (needsConcentration && checkConcentration) {
        const concentrationCheck = item.actor.data.effects.find(i => i.label === concentrationName);
        if (concentrationCheck) {
          await game.cub.removeCondition(concentrationName, [token], {warn: false});
          // await item.actor.unsetFlag("midi-qol", "concentration-data");
        }
        if (needsConcentration)
          addConcentration({workflow});
      }
    }
    doConcentration();
  }
  const hasEffects = workflow.hasDAE && item.data.effects.find(ae=> !ae.transfer);
  if (hasEffects && !configSettings.autoItemEffects) {
    //@ts-ignore
    const searchString = '<footer class="card-footer">';
    const button = `<button data-action="applyEffects">${i18n("midi-qol.ApplyEffects")}</button>`
    const replaceString = `<div class="card-buttons-midi-br">${button}</div><footer class="card-footer">`;
    data.content = data.content.replace(searchString, replaceString);
  }
  // Workflow will be advanced when the better rolls card is displayed.
  return true;
}

var DSNHandlers;

let showHandler = (hideTags, displayId, html, header, message, id) => {
  debug("Show Handler:", header, hideTags, displayId, html, id, message)
  if (id !== displayId) return;
  if (hideTags) hideTags.forEach(hideTag => html.find(hideTag).show()); 
  //@ts-ignore
  let li = ui.chat.element.find(`.message[data-message-id="${message.id}"]`);
  li.replaceWith(html);
  //@ts-ignore
  ui.chat.scrollBottom()
};

export let diceSoNiceHandler = async (message, html, data) => {
  if (!game.dice3d || !installedModules.get("dice-so-nice") || game.dice3d.messageHookDisabled || !game.dice3d.isEnabled()) return;
  debug("Dice so nice handler ", message, html, data);
  // Roll the 3d dice if we are a gm, or the message is not blind and we are the author or a recipient (includes public)
  let rollDice = game.user.isGM ||
        (!message.data.blind && (message.isAuthor || message.data.whisper.length === 0 || message.data.whisper?.includes(game.user.id)));
  if (!rollDice) {
    return;
  }

  if (configSettings.mergeCard) {
    return;
  }
    if (!getProperty(message.data, "flags.midi-qol.waitForDiceSoNice")) return;
    debug("dice so nice handler - non-merge card", html)
    html.hide();
    Hooks.once("diceSoNiceRollComplete", (id) => {
      html.show(); 
      //@ts-ignore
      ui.chat.scrollBottom()
    });
    setTimeout(() => {
      html.show(); 
      //@ts-ignore
      ui.chat.scrollBottom()
    }, 3000); // backup display of messages
  return true;
}

export let colorChatMessageHandler = (message, html, data) => {

  if (coloredBorders === "none") return true;
  let actorId = message.data.speaker.actor;
  let userId = message.data.user;
  let actor = game.actors.get(actorId);
  let user = game.users.get(userId);
  if (!user || !actor) return true;
  //@ts-ignore permission is actually not a boolean
  if (actor.data.permission[userId] !== CONST.ENTITY_PERMISSIONS.OWNER && !user.isGM) {
    user = game.users.find(p=>p.isGM && p.active)
  }

  //@ts-ignore .color not defined
  html[0].style.borderColor = user.data.color;
  // const oldColor = html[0].children[0].children[0].style.backgroundColor;
  const oldColor = html[0].children[0].children[0].style.backgroundColor;
  if (coloredBorders === "borderNamesBackground") {
    html[0].children[0].children[0].style["text-shadow"] = `1px 1px 1px #FFFFFF`;
    //@ts-ignore .color not defined
    html[0].children[0].children[0].style.backgroundColor = user.data.color;
  } else if (coloredBorders === "borderNamesText") {
    //@ts-ignore .color not defined
    html[0].children[0].children[0].style["text-shadow"] = `1px 1px 1px ${html[0].children[0].children[0].style.color}`;
    //@ts-ignore .color not defined
    html[0].children[0].children[0].style.color = user.data.color;
  }
 return true;
}

export let nsaMessageHandler = (message, html, data) => {
  if (!nsaFlag || !data.whisper  || data.whisper.length === 0) return true;
  let gmIds = ChatMessage.getWhisperRecipients("GM").filter(u=>u.active).map(u=>u.id);
  let currentIds = data.whisper.map(u=>typeof(u) === "string" ? u : u.id);
  gmIds = gmIds.filter(id => !currentIds.includes(id));
  debug("nsa handler active GMs ", gmIds, " current ids ", currentIds, "extra gmids ", gmIds)
  data.whisper = data.whisper.concat(gmIds);
  return true;
}

let _highlighted = null;

let _onTargetHover = (event) => {

  event.preventDefault();
  if ( !canvas?.scene?.data.active ) return;
  const token = canvas.tokens.get(event.currentTarget.id);
  if ( token?.isVisible ) {
    if ( !token._controlled ) token._onHoverIn(event);
    _highlighted = token;
  }
}

/* -------------------------------------------- */

/**
 * Handle mouse-unhover events for a combatant in the tracker
 * @private
 */
let _onTargetHoverOut = (event) => {
  event.preventDefault();
  if ( !canvas?.scene?.data.active ) return;
  if (_highlighted ) _highlighted._onHoverOut(event);
  _highlighted = null;
}

let _onTargetSelect = (event) => {
  event.preventDefault();
  if ( !canvas?.scene?.data.active ) return;
  const token = canvas.tokens.get(event.currentTarget.id);
  token.control({ multiSelect: false, releaseOthers: true });
};

export let hideRollRender = (msg, html, data) => {
  if (forceHideRoll && (msg.data.whisper.length > 0 || msg.data?.blind)) {
      if (!game.user.isGM && !msg.isAuthor && msg.data.whisper.indexOf(game.user.id) === -1) {
        warn("hideRollRender | hiding message", msg.data.whisper)
        html.hide();
      }
  }
  return true;
};

export let hideRollUpdate = (message, data, diff, id) => {
  if (forceHideRoll && message.data.whisper.length > 0 || message.data.blind) {
    if (!game.user.isGM && ((!message.isAuthor && (message.data.whisper.indexOf(game.user.id) === -1) || message.data.blind))) {
      let messageLi = $(`.message[data-message-id=${data._id}]`);
      warn("hideRollUpdate: Hiding ", message.data.whisper, messageLi)
      messageLi.hide();
    }
  }
  return true;
};

export let hideStuffHandler = (message, html, data) => {
  debug("hideStuffHandler message: ", message.id, message)

  const midiqolFlags = getProperty(message.data, "flags.midi-qol");
  let ids = html.find(".midi-qol-target-name")
  // const actor = game.actors.get(message?.speaker.actor)
    // let buttonTargets = html.getElementsByClassName("minor-qol-target-npc");
  ids.hover(_onTargetHover, _onTargetHoverOut)
  if (game.user.isGM)  {
    ids.click(_onTargetSelect);
  }

  if (game.user.isGM) {
    html.find(".midi-qol-target-npc-Player").hide();
  } else {
    html.find(".midi-qol-target-npc-GM").hide();
  }
  if (game.user.isGM) {
    //@ts-ignore
    ui.chat.scrollBottom
    return;
  }

  if (
    (message.user?.isGM && !game.user.isGM && configSettings.hideRollDetails === "all")
     || message.data.blind) {
    html.find(".dice-roll").replaceWith(i18n("midi-qol.DiceRolled"));
  } else if (message.user?.isGM && !game.user.isGM && ["details", "d20Only"].includes(configSettings.hideRollDetails)) {
    html.find(".dice-tooltip").remove();
    html.find(".dice-formula").remove();
  } 
  if (message.user?.isGM && !game.user.isGM && ["d20Only"].includes(configSettings.hideRollDetails)) {
    const d20AttackRoll = getProperty(message.data.flags, "midi-qol.d20AttackRoll");
    if (d20AttackRoll) {
      html.find(".midi-qol-attack-roll .dice-total").text(`(d20) ${d20AttackRoll}`);
    }
  }

  if (configSettings.autoCheckHit === "whisper" || message.data.blind) {
    if (configSettings.mergeCard) {
      $(html).find(".midi-qol-hits-display").hide();
    } else {
      if ($(html).find(".midi-qol-hits-display").length === 1) {
        html.hide();
      }
    }
  }
  if (configSettings.autoCheckSaves === "whisper" || message.data.blind) {
    if (configSettings.mergeCard) {
      $(html).find(".midi-qol-saves-display").hide();
    } else {
      if ($(html).find(".midi-qol-saves-display").length === 1) {
        html.hide();
      }
    }
  }
  //@ts-ignore
  setTimeout( () => ui.chat.scrollBottom(), 0);
}

export let recalcCriticalDamage = (data, ...args) => {
  if (enableWorkflow) return true;
  if (data.flags?.dnd5e?.roll.type === "damage") {
    debug("recalcCriticalDamage ", data.flags?.dnd5e?.roll.type, data, ...args)
    let actor: Actor5e = game.actors.tokens[data.speaker.token];
    if (!actor) game.actors.tokens[data.speaker.token]?.actor;
    if (!actor) actor = game.actors.get(data.speaker.actor);
    let item: Item5e = actor?.items.get((data.flags.dnd5e.roll.itemId));
    if (!item) return true;
    if (data.flags.dnd5e.roll.critical) {
      //TODO look at item to get correct damage roll
      if (criticalDamage === "default") return;
      let r = Roll.fromJSON(data.roll);
      let rollBase = new Roll(r.formula);
      if (criticalDamage === "maxDamage") {
        //@ts-ignore .terms not defined
        rollBase.terms = rollBase.terms.map(t => {
          if (t?.number) t.number = Math.floor(t.number/2);
          return t;
        });
        //@ts-ignore .evaluate not defined
        rollBase.evaluate({maximize: true});
        rollBase._formula = rollBase.formula;
        data.roll = JSON.stringify(rollBase);
        data.content = `${rollBase.total}`;
      } else if (criticalDamage === "maxCrit") {
        //TODO validate #crit dice from item details
        let rollCrit = new Roll(r.formula);
        //@ts-ignore .terms not defined
        rollCrit.terms = rollCrit.terms.map(t => {
          if (t?.number) t.number = Math.ceil(t.number/2);
          if (typeof t === "number") t = 0;
          return t;
        });
        //@ts-ignore .terms not defined
        rollBase.terms = rollBase.terms.map(t => {
          if (t?.number) t.number = Math.floor(t.number/2);
          return t;
        });
        //@ts-ignore .evaluate not defined
        rollCrit.evaluate({maximize: true});
        //@ts-ignore.terms not defined
        rollBase.terms.push("+")
        //@ts-ignore .terms not defined
        rollBase.terms.push(rollCrit.total)
        rollBase._formula = rollBase.formula;
        rollBase.roll();
        data.total = rollBase.total;
        data.roll = JSON.stringify(rollBase);
      } else if (criticalDamage === "maxAll") {
        //@ts-ignore .evaluate not defined
        rollBase.evaluate({maximize: true});
        data.roll = JSON.stringify(rollBase);
        data.content = `${rollBase.total}`;
      }
    }
  }
  return true;
}

export let processBetterRollsChatCard = (message, html, data) => {
  if (!checkBetterRolls && message?.data?.content?.startsWith('<div class="dnd5e red-full chat-card"'))  return;
  debug("processBetterRollsChatCard", message. html, data)
  const requestId = message.data.speaker.actor;
  if (!saveRequests[requestId]) return true;
  const title = html.find(".item-name")[0]?.innerHTML
  if (!title) return true;
  if (!title.includes("Save")) return true;
  const formula = "1d20";
  const total = html.find(".dice-total")[0]?.innerHTML;
  clearTimeout(saveTimeouts[requestId]);
  saveRequests[requestId]({total, formula})
  delete saveRequests[requestId];
  delete saveTimeouts[requestId];
  return true;
}

export function betterRollsButtons(message, html, data) {
  if (!message.data.flags.betterrolls5e) return;
  //@ts-ignore speaker
  const betterRollsBinding = message.BetterRollsCardBinding;
  const item = betterRollsBinding?.roll.item;
  if (!item || !Workflow.getWorkflow(item.uuid)) {
    html.find('.card-buttons-midi-br').remove();
  } else {
    html.find('.card-buttons-midi-br').off("click", 'button');
    html.find('.card-buttons-midi-br').on("click", 'button', onChatCardAction.bind(this))
  }
}

export let chatDamageButtons = (message, html, data) => {
  debug("Chat Damage Buttons ", addChatDamageButtons, message, message.data.flags?.dnd5e?.roll?.type, message.data.flags)
  if (!addChatDamageButtons) {
    return true;
  }
  if (["other", "damage"].includes(message.data.flags?.dnd5e?.roll?.type)) {
    let item;
    if (message.data.flags?.dnd5e?.roll?.type === "damage") {
      const itemId = message.data.flags.dnd5e.roll.itemId;
      item = game.actors.get(message.data.speaker.actor).items.get(itemId);
      if (!item) {
        warn("Damage roll for non item");
        return;
      }
    }
    // find the item => workflow => damageList, totalDamage
    const defaultDamageType = (item?.data.data.damage.parts[0] && item?.data.data.damage?.parts[0][1]) ?? "bludgeoning";
    const damageList = createDamageList(message.roll, item, defaultDamageType);
    const totalDamage = message.roll.total;
    addChatDamageButtonsToHTML(totalDamage, damageList, html, item, "damage");
  } else if (getProperty(message.data, "flags.midi-qol.damageDetail")) {
    let midiFlags = getProperty(message.data, "flags.midi-qol");
    // if (midiFlags.type !== MESSAGETYPES.DAMAGE) return; - cant do this as each update overwrites the html
    const item = game.actors.get(midiFlags.actor)?.getOwnedItem(midiFlags.item);
    addChatDamageButtonsToHTML(midiFlags.damageTotal, midiFlags.damageDetail, html, item, "damage", ".midi-qol-damage-roll .dice-total");
    addChatDamageButtonsToHTML(midiFlags.otherDamageTotal, midiFlags.otherDamageDetail, html, item, "other", ".midi-qol-other-roll .dice-total");
  }
  return true;
}

export function addChatDamageButtonsToHTML(totalDamage, damageList, html, item, tag="damage",toMatch=".dice-total") {

  debug("addChatDamageButtons", totalDamage, damageList, html, item, toMatch, $(html).find(toMatch))
  const btnContainer = $('<span class="dmgBtn-container-mqol" style="position:relative; right:0; bottom:1px;"></span>');
  let btnStyling = "width: 20%; margin-top: 5%; height: 90%; background-color: #ffffff; font-size:14px;line-height:1px";
  const fullDamageButton = $(`<button class="dice-total-full-${tag}-button" style="${btnStyling}"><i class="fas fa-user-minus" title="Click to apply full damage to selected token(s)."></i></button>`);
  const halfDamageButton = $(`<button class="dice-total-half-${tag}-button" style="${btnStyling}"><i class="fas fa-user-shield" title="Click to apply half damage to selected token(s)."></i></button>`);
  const doubleDamageButton = $(`<button class="dice-total-double-${tag}-button" style="${btnStyling}"><i class="fas fa-user-injured" title="Click to apply double damage to selected token(s)."></i></button>`);
  const fullHealingButton = $(`<button class="dice-total-full-${tag}-healing-button" style="${btnStyling}"><i class="fas fa-user-plus" title="Click to apply full healing to selected token(s)."></i></button>`);
  btnContainer.append(fullDamageButton);
  btnContainer.append(halfDamageButton);
  btnContainer.append(doubleDamageButton);
  btnContainer.append(fullHealingButton);
  $(html).find(toMatch).append(btnContainer);
  // Handle button clicks
  let setButtonClick = (buttonID, mult) => {
      let button = $(html).find(buttonID);
      button.off("click");
      button.click(async (ev) => {
          ev.stopPropagation();
          if (canvas && canvas.tokens.controlled.length === 0) {
              console.warn(`Midi-qol | user ${game.user.name} ${i18n("midi-qol.noTokens")}`);
              return ui.notifications.warn(`${game.user.name} ${i18n("midi-qol.noTokens")}`);
          }
          // find solution for non-magic weapons
          let promises = [];
          for (let t of canvas.tokens.controlled) {
              let a = t.actor;
              let appliedDamage = 0;
              for (let { damage, type } of damageList) {
                  appliedDamage += Math.floor(damage * getTraitMult(a, type, item));
              }
              appliedDamage = Math.floor(Math.abs(appliedDamage)) * mult;

              let damageItem = calculateDamage(a, appliedDamage, t, totalDamage, "");
              promises.push(a.update({ "data.attributes.hp.temp": damageItem.newTempHP, "data.attributes.hp.value": damageItem.newHP }));
          }
          let retval = await Promise.all(promises);
          return retval;
      });
  };
  setButtonClick(`.dice-total-full-${tag}-button`, 1);
  setButtonClick(`.dice-total-half-${tag}-button`, 0.5);
  setButtonClick(`.dice-total-double-${tag}-button`, 2);
  setButtonClick(`.dice-total-full-${tag}-healing-button`, -1);
  // logic to only show the buttons when the mouse is within the chatcard and a token is selected
  html.find('.dmgBtn-container-mqol').hide();
  $(html).hover(evIn => {
  if (canvas?.tokens.controlled.length > 0) {
    html.find('.dmgBtn-container-mqol').show();
  }
  }, evOut => {
      html.find('.dmgBtn-container-mqol').hide();
  });
  return html;
}

export function processItemCardCreation(message, options, user) {
  const midiqolFlags = message.data.flags["midi-qol"];
  debug("Doing item card creation", configSettings.useCustomSounds, configSettings.itemUseSound, midiqolFlags?.type)
  if (configSettings.useCustomSounds && midiqolFlags?.type === MESSAGETYPES.ITEM) {
    const playlist = game.playlists.get(configSettings.customSoundsPlaylist);
    const sound = playlist?.sounds.find(s=>s._id === midiqolFlags?.sound);
    const delay = 0;
    if (sound) {
      setTimeout(() => {
      sound.playing = true;
        playlist.playSound(sound);
      }, delay)
    }
  }
}

export async function onChatCardAction(event) {
  event.preventDefault();
  // Extract card data
  const button = event.currentTarget;
  button.disabled = true;
  const card = button.closest(".chat-card");
  const messageId = card.closest(".message").dataset.messageId;
  const message =  game.messages.get(messageId);
  const action = button.dataset.action;
  let targets = game.user.targets;

  // Validate permission to proceed with the roll
  if ( !(game.user.isGM || message.isAuthor ) ) return;
  if (!(targets?.size > 0)) return; // cope with targets undefined
  if (action !== "applyEffects") return;
  
  //@ts-ignore speaker
  const betterRollsBinding = message.BetterRollsCardBinding;
  var actor, item;
  if (betterRollsBinding) {
    actor = betterRollsBinding.roll.actor;
    item = betterRollsBinding.roll.item;
  } else {
    // Recover the actor for the chat card
    //@ts-ignore
    actor = CONFIG.Item.entityClass._getChatCardActor(card);
    if ( !actor ) return;

    // Get the Item from stored flag data or by the item ID on the Actor
    const storedData = message.getFlag("dnd5e", "itemData");
    item = storedData ? this.createOwned(storedData, actor) : actor.getOwnedItem(card.dataset.itemId);
    if ( !item ) {
      return ui.notifications.error(game.i18n.format("DND5E.ActionWarningNoItem", {item: card.dataset.itemId, name: actor.name}))
    }
  }
  if (!actor || !item) return;
  let workflow = Workflow.getWorkflow(item.uuid);
  const hasDAE = installedModules.get("dae") && (item?.effects?.entries.some(ef => ef.data.transfer === false));
  if (hasDAE) {
    //@ts-ignore
    let dae = window.DAE;
    dae.doEffects(item, true, game.user.targets, {whisper: false, spellLevel: workflow?.itemLevel, damageTotal: workflow?.damageTotal, critical: workflow?.isCritical, fumble: workflow?.isFumble, itemCardId: workflow?.itemCardId})
  }

  // Re-enable the button
  button.disabled = false;
}

/*
export let processpreCreateBetterRollsMessageOld = async (data: any, options:any, user: any) => {
  if (installedModules["betterrolls5e"] || !data.content?.startsWith('<div class="dnd5e red-full chat-card"')) return true;
  debug("process precratebetteerrollscard ", data, options, installedModules["betterrolls5e"], data.content?.startsWith('<div class="dnd5e red-full chat-card"') )

  const brFlags = data.flags;
  let html = $(data.content);
  const title = html.find(".item-name")[0]?.innerHTML;

  let rollDivs = html.find(".dice-roll.red-dual");//.find(".dice-row-item");
  let rollData = html.find("red-full");

  let itemId = html[0].attributes["data-item-id"];

  debug("better rolls ", rollData, rollDivs, itemId)
  if (!itemId) return true; // not an item roll.
 
  itemId = itemId.nodeValue;

  let itemRe = /[^(]\(([\d]*)[^)]*\)/
  let token: Token = canvas.tokens.get(data.speaker.token)
  let actor: Actor5e = token?.actor;
  if (!actor) actor = game.actors.get(data.speaker.actor);
  let item: Item5e = actor.items.get(itemId);

  let levelMatch =  title.match(itemRe);
  let itemLevel = levelMatch ? levelMatch[1] : (item?.data.data.level || 0);
  let damageStart = 0;
  let attackTotal = -1;
  let diceRoll;

  if (item.hasAttack) {
    damageStart = 1
    const attackRolls = $(rollDivs[0]).find(".dice-total");
    let diceRolls = $(rollDivs[0]).find(".roll.die.d20");
    for (let i = 0; i < attackRolls.length; i++) {
      if (!attackRolls[i].classList.value.includes("ignore")) {
        attackTotal = parseInt(attackRolls[i]?.innerHTML);
        diceRoll = parseInt(diceRolls[i]?.innerHTML);
        break;
      }
    }
  }

  // each weapon has it's own critical threshold
  let criticalThreshold = item.data.flags.betterRolls5e?.critRange?.value || 20;
  if (item.data.type === "weapon") criticalThreshold = Math.min(criticalThreshold, actor.data.flags.dnd5e?.weaponCriticalThreshold || 20);
// critical calc removed - oops
  let damageList = [];
  // document.activeElement.blur();
  for (let i = damageStart; i < rollDivs.length; i++) {
    let child = rollDivs[i].children;
    let damage = 0;
    // Structure is [flavor-text, dice-result]. If there is no flavor-text use the first else the second
    let resultIndex = child.length === 1 ? 0 : 1;
    for (let j = 0; j < $(child[resultIndex]).find(".dice-total")[0]?.children?.length; j++) {
      let damageDiv = $(child[resultIndex]).find(".dice-total")[0].children[j];
      // see if this damage is critical damage or not
      let isCriticalDamage = false;
      if (!isCritical) {
        for (let k = 0; k < damageDiv.classList.length; k++) {
          if (damageDiv.classList[k] === "red-crit-damage" ) isCriticalDamage = true;
        }
      }
      if (!isCritical && isCriticalDamage) continue;
      let damageitem = parseInt(damageDiv.innerHTML);
      if (!isNaN(damageitem)) damage += damageitem;
    }
    const typeString = child[0].innerHTML;
    //@ts-ignore - entry[1] type unknown
    let type = (Object.entries(CONFIG.DND5E.damageTypes).find(entry => typeString.includes(entry[1])) || ["unmatched"])[0];
    //@ts-ignore - entry[1] type unknown
    if (type === "unmatched") type = (Object.entries(CONFIG.DND5E.healingTypes).find(entry => typeString.includes(entry[1])) || ["unmatched"])[0];
    damageList.push({type, damage})
  };

  const selfTarget = await getSelfTarget(actor);

  BetterRollsWorkflow.removeWorkflow(item.uuid);
  const targets = (item?.data.data.target?.type === "self") ? new Set([selfTarget]) : new Set(game.user.targets);
  let workflow = new BetterRollsWorkflow(actor, item, data.speaker, targets, null);
  workflow.isCritical = diceRoll >= criticalThreshold;
  workflow.isFumble = diceRoll === 1;
  workflow.attackTotal = attackTotal;
  workflow.attackRoll = new Roll(`${attackTotal}`).roll();
  workflow.damageDetail = damageList;
  workflow.damageTotal = damageList.reduce((acc, a) => a.damage + acc, 0);
  workflow.itemLevel = itemLevel;
  workflow.itemCardData = data;
  workflow.advantage = brFlags.params.adv === 1;
  workflow.disadvantage = brFlags.params.disadv === 1;
  if (!workflow.tokenId) workflow.tokenId = selfTarget.id;
  console.error("Better rolls workflow ", configSettings.concentrationAutomation, data.speaker, workflow.speaker, workflow.tokenId, workflow)
  if (configSettings.concentrationAutomation) {
    const concentrationName = game.settings.get("combat-utility-belt", "concentratorConditionName");
    const needsConcentration = workflow.item.data.data.components?.concentration;
    const checkConcentration = installedModules.get("combat-utility-belt") && configSettings.concentrationAutomation;
    const itemDuration = workflow.item.data.data.duration;
    console.error("Concentration check", concentrationName, needsConcentration, checkConcentration, selfTarget)

    if (needsConcentration && checkConcentration) {
      const concentrationCheck = item.actor.data.effects.find(i => i.label === concentrationName);
      if (concentrationCheck) {
        await game.cub.removeCondition(concentrationName, selfTarget, {warn: false});
        // await item.actor.unsetFlag("midi-qol", "concentration-data");
      }
      if (needsConcentration)
        await game.cub.addCondition(concentrationName, [selfTarget], { warn: false });
    }
     // Update the duration of the concentration effect - TODO remove it CUB supports a duration
     if (workflow.hasDAE) {
      const ae = duplicate(selfTarget.actor.data.effects.find(ae => ae.label === concentrationName));
      if (ae) {
        //@ts-ignore
        const inCombat = (game.combat?.turns.some(turnData => turnData.tokenId === selfTarget.data._id));
        const convertedDuration = workflow.dae.convertDuration(itemDuration, inCombat);
        if (convertedDuration.type === "seconds") {
          ae.duration.seconds = convertedDuration.seconds;
          ae.duration.startTime = game.time.worldTime;
        } else if (convertedDuration.type === "turns") {
          ae.duration.rounds = convertedDuration.rounds;
          ae.duration.turns = convertedDuration.turns;
          ae.duration.startRound = game.combat?.round;
          ae.duration.startTurn = game.combat?.turn;
        }
        await selfTarget.actor.updateEmbeddedEntity("ActiveEffect", ae)
      }
    }
  }
  // Workflow will be advanced when the better rolls card is displayed.
  return true;
}
*/
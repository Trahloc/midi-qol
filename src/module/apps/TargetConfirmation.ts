import { i18n, error, i18nFormat } from "../../midi-qol.js";
import { checkMechanic, checkRule, configSettings, targetConfirmation } from "../settings.js";
import { FULL_COVER, HALF_COVER, THREE_QUARTERS_COVER, checkRange, computeCoverBonus, computeFlankingStatus, getIconFreeLink, getLinkText, getToken, isTargetable, markFlanking, tokenForActor } from "../utils.js";
import { getAutoRollAttack, getTokenPlayerName, isAutoFastAttack } from "../utils.js";
import { TroubleShooter } from "./TroubleShooter.js";

export class TargetConfirmationDialog extends Application {
  callback: ((data) => {}) | undefined
  data: {
    //@ts-ignore
    actor: CONFIG.Actor.documentClass,
    //@ts-ignore
    item: CONFIG.Item.documentClass,
    user: User | null,
    targets: Token[],
    options: any
  };
  hookId: number;

  //@ts-ignore .Actor, .Item
  constructor(actor: CONFIG.Actor.documentClass, item: CONFIG.Item.documentClass, user, options: any = {}) {
    super(options);
    this.data = { actor, item, user, targets: [], options }

    // Handle alt/ctrl etc keypresses when completing the dialog
    this.callback = function (value) {
      setProperty(options, "workflowOptions.advantage", options.worfkflowOptions?.advantage || options.pressedKeys?.advantage);
      setProperty(options, "workflowOptions.disadvantage", options.worfkflowOptions?.disadvantage || options.pressedKeys?.disadvantage);
      setProperty(options, "workflowOptions.versatile", options.worfkflowOptions?.versatile || options.pressedKeys?.versatile);
      setProperty(options, "workflowOptions.fastForward", options.worfkflowOptions?.fastForward || options.pressedKeys?.fastForward);
      return options.callback ? options.callback(value) : value;
    }
    if (["ceflanked", "ceflankedNoconga"].includes(checkRule("checkFlanking")) && game.user?.targets) {
      const actor = this.data.item.actor;
      const token = tokenForActor(actor);
      if (token)
        for (let target of game.user?.targets)
          markFlanking(token, target)
    }
    // this.callback = options.callback;
    return this;
  }

  get title() {
    return this.data.options.title ?? i18n("midi-qol.TargetConfirmation.Name");
  }

  static get defaultOptions() {
    let left = 100;
    let top = 100;
    let middleX = window.innerWidth / 2 - 155;
    let middleY = window.innerHeight / 2 - 100;
    //@ts-ignore _collapsed
    let right = window.innerWidth - 310 - (ui.sidebar?._collapsed ? 10 : (ui.sidebar?.position.width ?? 300));
    let bottom = window.innerHeight - 200;
    let xposition = middleX;
    let yposition = middleY;
    switch (targetConfirmation.gridPosition?.x) {
      case -1: xposition = left; break;
      case 0: xposition = middleX; break;
      default:
      case 1: xposition = right; break;
    }
    switch (targetConfirmation.gridPosition?.y) {
      case -1: yposition = top; break;
      case 0: yposition = middleY; break;
      default:
      case 1: yposition = bottom; break;
    }
    return foundry.utils.mergeObject(super.defaultOptions, {
      title: i18n("midi-qol.TargetConfirmation.Name"),
      classes: ["midi-targeting"],
      template: "modules/midi-qol/templates/targetConfirmation.html",
      id: "midi-qol-targetConfirmation",
      width: 300,
      left: xposition,
      top: yposition,
      height: "auto",
      resizeable: "true",
      closeOnSubmit: true
    });
  }

  async getData(options = {}) {
    let data: any = mergeObject(this.data, await super.getData(options));
    const targets = Array.from(game.user?.targets ?? []);
    data.targets = [];
    for (let target of targets) {
      //@ts-expect-error .texture
      let img = target.document.texture.src;
      if (VideoHelper.hasVideoExtension(img)) {
        img = await game.video.createThumbnail(img, { width: 50, height: 50 });
      }
      const actor = this.data.item.actor;
      const token = tokenForActor(actor);
      let details: string[] = [];
      if (["ceflanked", "ceflankedNoconga"].includes(checkRule("checkFlanking"))) {
        if (token && computeFlankingStatus(token, target)) details.push((i18n("midi-qol.Flanked")));
      }

      let attackerToken = token;
      if (token && checkMechanic("checkRange") !== "none" && (["mwak", "msak", "mpak", "rwak", "rsak", "rpak"].includes(this.data.item.system.actionType))) {
        const { result, attackingToken } = checkRange(this.data.item, token, new Set([target]), false);
        if (attackingToken) attackerToken = attackingToken;
        switch (result) {
          case "normal":
            details.push(`${i18n("DND5E.RangeNormal")}`);
            break;
          case "dis":
            details.push(`${i18n("DND5E.RangeLong")}`);
            break;
          case "fail":
            details.push(`${i18n("midi-qol.OutOfRange")}`);
            break;
        }
      }
      // TODO look at doing save cover bonus calculations here - need the template
      if (typeof configSettings.optionalRules.coverCalculation === "string" && configSettings.optionalRules.coverCalculation !== "none") {
        const isRangeTargeting = ["ft", "m"].includes(this.data.item?.system.target?.units) && ["creature", "ally", "enemy"].includes(this.data.item?.system.target?.type);
        if (!this.data.item?.hasAreaTarget && !isRangeTargeting) {
          const targetCover = attackerToken ? computeCoverBonus(attackerToken, target, this.data.item) : 0;
          switch (targetCover) {
            case HALF_COVER:
              details.push(`${i18n("DND5E.CoverHalf")} ${i18n("DND5E.Cover")}`);
              break;
            case THREE_QUARTERS_COVER:
              details.push(`${i18n("DND5E.CoverThreeQuarters")} ${i18n("DND5E.Cover")}`);
              break;
            case FULL_COVER:
              details.push(`${i18n("DND5E.CoverTotal")} ${i18n("DND5E.Cover")}`);
              break;
            default:
              details.push(`${i18n("No")} ${i18n("DND5E.Cover")}`);
              break;
          }
        }
      }

      let name;
      if (game.user?.isGM) {
        name = getIconFreeLink(target);
      } else {
        name = getTokenPlayerName(target);
      }
      //@ts-expect-error .disposition
      const relativeDisposition = token?.document.disposition * target.document.disposition;
      let displayedDisposition: any = undefined;
      //@ts-expect-error .disposition .SECRET
      if (target.document.disposition !== CONST.TOKEN_DISPOSITIONS.SECRET) {
        if (relativeDisposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY) {
          displayedDisposition = i18n("TOKEN.DISPOSITION.FRIENDLY");
        } /*else if (relativeDisposition === CONST.TOKEN_DISPOSITIONS.NEUTRAL) {
          displayedDisposition = i18n("TOKEN.DISPOSITION.NEUTRAL");
        } else if (relativeDisposition === CONST.TOKEN_DISPOSITIONS.HOSTILE) {
          displayedDisposition = i18n("TOKEN.DISPOSITION.HOSTILE");
        }*/
      }
      data.targets.push({
        name, // : namegame.user?.isGM ? getLinkText(target.actor) : getTokenPlayerName(target),
        img,
        displayedDisposition,
        details: details.join(" - "),
        hasDetails: details.length > 0,
        uuid: target.document.uuid
      });
    }
    if (this.data.item.system.target) {
      if (this.data.item.system.target.type === "creature" && this.data.item.system.target.units === "" && this.data.item.system.target.value)
        data.blurb = i18nFormat("midi-qol.TargetConfirmation.Blurb", { targetCount: this.data.item.system.target.value })

      else data.blurb = i18n("midi-qol.TargetConfirmation.BlurbAny");
    }
    return data;
  }

  activateListeners(html) {
    super.activateListeners(html);
    if (!this.hookId) {
      this.hookId = Hooks.on("targetToken", (user, token, targeted) => {
        if (user !== game.user) return;
        if (game.user?.targets) {
          const validTargets: Array<string> = [];
          for (let target of game?.user?.targets)
            if (isTargetable(target)) validTargets.push(target.id);
          game.user?.updateTokenTargets(validTargets);
        }
        this.data.targets = Array.from(game.user?.targets ?? [])
        this.render();
      });
    }
    html.find(".midi-roll-confirm").on("click", () => {
      this.doCallback(true);
      this.close();
    })
    html.find(".midi-roll-cancel").on("click", () => {
      this.doCallback(false);
      this.close();
    })

    if (canvas) {
      let targetNames = html[0].getElementsByClassName("content-link midi-qol");
      for (let targetName of targetNames) {
        targetName.addEventListener("click", async (event) => {
          event.stopPropagation();
          const doc = await fromUuid(event.currentTarget.dataset.uuid);
          //@ts-expect-error .sheet
          return doc?.sheet.render(true);
        });
      }
      let imgs = html[0].getElementsByTagName('img');
      for (let i of imgs) {
        i.style.border = 'none';
        i.closest(".midi-qol-box").addEventListener("contextmenu", (event) => {
          const token = getToken(i.id);
          if (token) {
            token.setTarget(false, { user: game.user, releaseOthers: false, groupSelection: true });
          }
        });
        i.closest(".midi-qol-box").addEventListener('click', async function () {
          const token = getToken(i.id);
          //@ts-expect-error .ping
          if (token) await canvas?.ping(token.center);
        });
        i.closest(".midi-qol-box").addEventListener('mouseover', function () {
          const token = getToken(i.id);
          if (token) {
            //@ts-expect-error .ping
            token.hover = true;
            token.refresh();
          }
        });
        i.closest(".midi-qol-box").addEventListener('mouseout', function () {
          const token = getToken(i.id);
          if (token) {
            //@ts-expect-error .ping
            token.hover = false;
            token.refresh();
          }
        });
      }
    }
  }

  close(options = {}) {
    Hooks.off("targetToken", this.hookId);
    this.doCallback(false);
    return super.close(options);
  }

  doCallback(value = false) {
    try {
      if (this.callback) this.callback(value);
    } catch (err) {
      const message = `TargetConfirmation | calling callback failed`;
      TroubleShooter.recordError(err, message);
      error(message, err);
    }
    this.callback = undefined;
  }
}

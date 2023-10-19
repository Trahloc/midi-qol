import { i18n, error, i18nFormat } from "../../midi-qol.js";
import { checkMechanic, checkRule, configSettings } from "../settings.js";
import { FULL_COVER, HALF_COVER, THREE_QUARTERS_COVER, checkRange, computeCoverBonus, computeFlankingStatus, isTargetable, markFlanking, tokenForActor } from "../utils.js";
import { getAutoRollAttack, getTokenPlayerName, isAutoFastAttack } from "../utils.js";
import { TroubleShooter } from "./TroubleShooter.js";

export class LateTargetingDialog extends Application {
  callback: ((data) => {}) | undefined
  data: {
    //@ts-ignore
    actor: CONFIG.Actor.documentClass,
    //@ts-ignore
    item: CONFIG.Item.documentClass,
    user: User | null,
    targets: Token[],
  };
  hookId: number;

  //@ts-ignore .Actor, .Item
  constructor(actor: CONFIG.Actor.documentClass, item: CONFIG.Item.documentClass, user, options: any = {}) {
    super(options);
    this.data = { actor, item, user, targets: [] }

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
    return this.options.title ?? i18n("midi-qol.LateTargeting.Name");
  }

  static get defaultOptions() {
    //@ts-ignore _collapsed
    let left = window.innerWidth - 310 - (ui.sidebar?._collapsed ? 10 : (ui.sidebar?.position.width ?? 300));
    let top = window.innerHeight - 200;

    return foundry.utils.mergeObject(super.defaultOptions, {
      title: i18n("midi-qol.LateTargeting.Name"),
      classes: ["midi-targeting"],
      template: "modules/midi-qol/templates/lateTargeting.html",
      id: "midi-qol-lateTargeting",
      width: 300,
      left: (getAutoRollAttack() && isAutoFastAttack()) ? undefined : left,
      top: (getAutoRollAttack() && isAutoFastAttack()) ? undefined : top,
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
      let details: string [] = [];
      if (["ceflanked", "ceflankedNoconga"].includes(checkRule("checkFlanking"))) {
        if (token && computeFlankingStatus(token, target)) details.push((i18n("midi-qol.Flanked")));
      }
      if (typeof configSettings.optionalRules.coverCalculation === "string" && configSettings.optionalRules.coverCalculation !== "none") {
        const targetCover = token ? computeCoverBonus(token, target, this.data.item) : 0;
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
      if (token && checkMechanic("checkRange") !== "none" && (["mwak", "msak", "mpak", "rwak", "rsak", "rpak"].includes(this.data.item.system.actionType))) {
        const { result, attackingToken } = checkRange(this.data.item, token, new Set([target]));
        switch (result) {
          case "normal":
            details.push(`${i18n("DND5E.RangeNormal")}`);
            break;
          case "dis":
            details.push(`${i18n("DND5E.RangeLong")}`);
            break;
          case "fail":
            details.push(`Out of Range`);
            break;
        }
      }

      data.targets.push({
        name: game.user?.isGM ? target.name : getTokenPlayerName(target),
        img,
        details: details.join(" - "),
        hasDetails: details.length > 0
      });
    }
    if (this.data.item.system.target) {
      if (this.data.item.system.target.type === "creature" && !this.data.item.system.target.type && this.data.item.system.target.value)
        data.targetCount = this.data.item.system.target.value;
      else data.targetCount = "";
      data.blurb = i18nFormat("midi-qol.LateTargeting.Blurb", { targetCount: data.targetCount })
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
      const message = `LateTargetingDialog | calling callback failed`;
      TroubleShooter.recordError(err, message);
      error(message, err);
    }
    this.callback = undefined;
  }
}

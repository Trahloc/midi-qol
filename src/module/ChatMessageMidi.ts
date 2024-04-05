import { GameSystemConfig, debugEnabled, i18n, log, warn } from "../midi-qol.js";
import { chatDamageButtons } from "./chatMessageHandling.js";
import { addChatDamageButtons, configSettings } from "./settings.js";
import { getDamageType } from "./utils.js";

export class ChatMessageMidi extends globalThis.dnd5e.documents.ChatMessage5e {
  constructor(...args) {
    super(...args);
    if (debugEnabled > 1) log("Chat message midi constructor", ...args)
  }

  _enrichAttackTargets(html) { return }

  collectRolls(rollsToAccumulate: Roll[], multiRolls: boolean = false): any[] {
    let returns: any[] = [];
    let rolls: Roll[] = [];
    for (let i = 0; i < rollsToAccumulate.length; i++) {
      if (!multiRolls && i < rollsToAccumulate.length - 1) {
        continue;
      } else if (multiRolls) rolls = [rollsToAccumulate[i]];
      else rolls = rollsToAccumulate;
      //@ts-expect-error
      let { formula, total, breakdown } = game.system.dice.aggregateDamageRolls(rolls).reduce((obj: any, r) => {
        obj.formula.push(r.formula);
        obj.total += r.total;
        this._aggregateDamageRoll(r, obj.breakdown);
        return obj;
      }, { formula: [], total: 0, breakdown: {} });
      formula = formula.join(" ");
      formula = formula.replace(/^\s+\+\s+/, "");
      formula = formula.replaceAll(/  /g, " ");
      if (multiRolls) {
        setProperty(rolls[0], "flags.midi-qol.breakdown", breakdown);
        setProperty(rolls[0], "flags.midi-qol.total", total);
      }
      let formulaInToolTip = ["formula", "formulaadv"].includes(configSettings.rollAlternate);
      let hideDetails = this.user.isGM && !game.user?.isGM && (configSettings.hideRollDetails ?? "none") !== "none";
      let hideFormula = this.user.isGM && !game.user?.isGM && (configSettings.hideRollDetails ?? "none") !== "none";
      if (this.user.isGM && !game.user?.isGM && (configSettings.hideRollDetails ?? "none") !== "none") {
        switch (configSettings.hideRollDetails) {
          case "none":
            break;
          case "detailsDSN":
            break;
          case "details":
            break;
          case "d20Only":
            break;
          case "hitDamage":
            break;
          case "hitCriticalDamage":
            break;
          case "d20AttackOnly":
            total = "Damage Roll";
            break;
          case "all":
            total = "Damage Roll";
            break;
        }
      }

      const roll = document.createElement("div");
      roll.classList.add("dice-roll");
      let tooltipContents = ""
      //@ts-expect-error
      if (!hideDetails) tooltipContents = Object.entries(breakdown).reduce((str, [type, { total, constant, dice }]) => {
        const config = GameSystemConfig.damageTypes[type] ?? GameSystemConfig.healingTypes[type];
        return `${str}
              <section class="tooltip-part">
                <div class="dice">
                  <ol class="dice-rolls">
                    ${dice.reduce((str, { result, classes }) => `
                      ${str}<li class="roll ${classes}">${result}</li>
                    `, "")}
                    ${constant ? `
                    <li class="constant"><span class="sign">${constant < 0 ? "-" : "+"}</span>${Math.abs(constant)}</li>
                    ` : ""}
                  </ol>
                  <div class="total">
                    ${config ? `<img src="${config.icon}" alt="${config.label}">` : ""}
                    <span class="label">${config?.label ?? ""}</span>
                    <span class="value">${total}</span>
                  </div>
                </div>
              </section>
            `;
      }, "");

      let diceFormula = "";
      if (!hideFormula) diceFormula = `<div class="dice-formula">${formula}</div>`;
      roll.innerHTML = `
      <div class="dice-result">
      ${formulaInToolTip ? "" : diceFormula}
        <div class="dice-tooltip-collapser">
          <div class="dice-tooltip">
            ${formulaInToolTip ? diceFormula : ""}
            ${tooltipContents}
          </div>
        </div>
        <h4 class="dice-total">${total}</h4>
      </div>
    `;
      returns.push(roll);
    }
    return returns;
  }

  _enrichDamageTooltip(rolls, html) {
    if (!configSettings.mergeCard) {
      return super._enrichDamageTooltip(rolls, html);
    }
    if (getProperty(this, "flags.dnd5e.roll.type") !== "midi") return;
    for (let rType of ["damage", "other-damage", "bonus-damage"]) {
      const rollsToCheck = this.rolls.filter(r => getProperty(r, "options.midi-qol.rollType") === rType);
      if (rollsToCheck?.length) {
        html.querySelectorAll(`.midi-${rType}-roll`)?.forEach(el => el.remove());
        for (let roll of this.collectRolls(rollsToCheck, configSettings.mergeCardMultiDamage)) {
          roll.classList.add(`midi-${rType}-roll`);
          if (rType === "bonus-damage") {
            const flavor = document.createElement("div");
            const flavors = rollsToCheck.map(r => r.options.flavor ?? r.options.type);
            const bonusDamageFlavor = flavors.join(", ");
            flavor.classList.add("midi-bonus-damage-flavor");
            flavor.innerHTML = bonusDamageFlavor;
            html.querySelector(`.midi-qol-${rType}-roll`)?.appendChild(flavor);
          }
          html.querySelector(`.midi-qol-${rType}-roll`)?.appendChild(roll);
          if ((configSettings.hideRollDetails ?? "none") !== "none" && !game.user?.isGM && this.user.isGM) {
            html.querySelectorAll(".dice-roll").forEach(el => el.addEventListener("click", this.noDiceClicks.bind(this)));
          }
        }
      }
    }
    if (game.user?.isGM && configSettings.v3DamageApplication) {
      const shouldAddButtons = addChatDamageButtons === "both"
      || (addChatDamageButtons === "gm" && game.user?.isGM)
      || (addChatDamageButtons === "pc" && !game.user?.isGM);
        if (shouldAddButtons) {
        for (let rType of ["damage", "other-damage", "bonus-damage"]) {
          rolls = this.rolls.filter(r => getProperty(r, "options.midi-qol.rollType") === rType);
          if (!rolls.length) continue;
          let damageApplication = document.createElement("damage-application");
          damageApplication.classList.add("dnd5e2");
          //@ts-expect-error
          damageApplication.damages = game.system.dice.aggregateDamageRolls(rolls, { respectProperties: true }).map(roll => ({
            value: roll.total,
            type: roll.options.type,
            properties: new Set(roll.options.properties ?? [])
          }));
          html.querySelector(".message-content").appendChild(damageApplication);
        }
      }
    }
  }
  enrichAttackRolls(html) {
    if (!this.user.isGM || game.user?.isGM) return;
    const hitFlag = getProperty(this.flags, "midi-qol.isHit");
    const hitString = hitFlag === undefined ? "" : hitFlag ? i18n("midi-qol.hits") : i18n("midi-qol.misses");
    let attackRollText;
    let removeFormula = (configSettings.hideRollDetails ?? "none") !== "none";
    switch (configSettings.hideRollDetails) {
      case "none":
        break;
      case "detailsDSN":
        break;
      case "details":
        break;
      case "d20Only":
        attackRollText = `(d20) ${this.rolls[0]?.terms[0].total ?? "--"}`;
        break;
      case "hitDamage":
        html.querySelectorAll(".midi-qol-attack-roll .dice-total")?.forEach(el => el.classList.remove("critical"));
        html.querySelectorAll(".midi-qol-attack-roll .dice-total")?.forEach(el => el.classList.remove("fumble"));
        attackRollText = hitString;
        break;
      case "hitCriticalDamage":
        attackRollText = hitString;
        break;
      case "d20AttackOnly":
        attackRollText = `(d20) ${this.rolls[0]?.terms[0].total ?? "--"}`;
        break;
      case "all":
        html.querySelectorAll(".midi-qol-attack-roll .dice-total")?.forEach(el => el.classList.remove("critical"));
        html.querySelectorAll(".midi-qol-attack-roll .dice-total")?.forEach(el => el.classList.remove("fumble"));
        attackRollText = "Attack Roll";
        break;
    }
    if (attackRollText) html.querySelectorAll(".midi-attack-roll .dice-total")?.forEach(el => el.innerHTML = attackRollText);
    if (this.user.isGM && !game.user?.isGM && removeFormula) {
      html.querySelectorAll(".midi-attack-roll .dice-formula")?.forEach(el => el.remove());
      html.querySelectorAll(".midi-attack-roll .dice-tooltip")?.forEach(el => el.remove());
      html.querySelectorAll(".dice-roll").forEach(el => el.addEventListener("click", this.noDiceClicks.bind(this)));
    }
  }
  _enrichChatCard(html) {
    if (!getProperty(this, "flags.dnd5e.roll")) return super._enrichChatCard(html);
    if ((getProperty(this, "flags.midi-qol.roll")?.length > 0) && getProperty(this, "flags.dnd5e.roll.type") !== "midi") {
      this.rolls = getProperty(this, "flags.midi-qol.roll");
      super._enrichChatCard(html);
      html.querySelectorAll(".dice-tooltip").forEach(el => el.style.height = "0");
      chatDamageButtons(this, html, {});
      return; // Old form midi chat card tht causes dnd5e to throw errors
    }
    if (getProperty(this, "flags.dnd5e.roll.type") !== "midi") {
      super._enrichChatCard(html);
      chatDamageButtons(this, html, {});
      return;
    }
    if (debugEnabled > 1) warn("Enriching chat card", this.id);
    this.enrichAttackRolls(html); // This has to run first to stop errors when ChatMessage5e._enrichDamageTooltip runs
    super._enrichChatCard(html);
    if (this.user.isGM && (configSettings.hideRollDetails ?? "none") !== "none" && !game.user?.isGM) {
      html.querySelectorAll(".dice-roll").forEach(el => el.addEventListener("click", this.noDiceClicks.bind(this)));
      html.querySelectorAll(".dice-tooltip").forEach(el => el.style.height = "0");
    }
    chatDamageButtons(this, html, {});
  }

  noDiceClicks(event) {
    event.stopImmediatePropagation();
    return;
  }
}

Hooks.once("init", () => {
  log("Registering ChatMessageMidi");
  //@ts-expect-error
  CONFIG.ChatMessage.documentClass = ChatMessageMidi;
});
Hooks.once("setup", () => {
  log("Registering ChatMessageMidi");
  //@ts-expect-error
  CONFIG.ChatMessage.documentClass = ChatMessageMidi;
});
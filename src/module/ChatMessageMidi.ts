import { get } from "jquery";
import { GameSystemConfig, debugEnabled, i18n, log, warn } from "../midi-qol.js";
import { RollStatsDisplay } from "./apps/RollStatsDisplay.js";
import { configSettings } from "./settings.js";

export class ChatMessageMidi extends globalThis.dnd5e.documents.ChatMessage5e {
  constructor(...args) {
    super(...args);
    if (debugEnabled > 0) log("Chat message midi constructor", ...args)
  }

  collectRolls(rolls) {
    let { formula, total, breakdown } = rolls.reduce((obj: any, r) => {
      obj.formula.push(r.formula);
      obj.total += r.total;
      this._aggregateDamageRoll(r, obj.breakdown);
      return obj;
    }, { formula: [], total: 0, breakdown: {} });
    formula = formula.join(" + ");
    let hideToolTip = false;
    let tooltipFormula = ["formula", "formulaadv"].includes(configSettings.rollAlternate);
    let diceFormula = `<div class="dice-formula">${formula}</div>`;
    if (this.user.isGM && !game.user?.isGM) {
      switch (configSettings.hideRollDetails) {
        case "none":
          break;
        case "detailsDSN":
          hideToolTip = true;
          tooltipFormula = true;
          break;
        case "details":
          hideToolTip = true;
          tooltipFormula = true;
          break;
        case "d20Only":
          hideToolTip = true;
          tooltipFormula = true;
          break;
        case "hitDamage":
          hideToolTip = true;
          tooltipFormula = true;
          break;
        case "hitCriticalDamage":
          hideToolTip = true;
          tooltipFormula = true;
          break;
        case "d20AttackOnly":
          total = "Damage Roll";
          hideToolTip = true;
          tooltipFormula = true;
          break;
        case "all":
          total = "Damage Roll";
          hideToolTip = true;
          tooltipFormula = true;
          break;
      }
    }

    const roll = document.createElement("div");
    roll.classList.add("dice-roll");
    const tooltip =
      roll.innerHTML = `
      <div class="dice-result">
        ${tooltipFormula ? "" : diceFormula}
        <div class="dice-tooltip">
          ${ //@ts-expect-error
      Object.entries(breakdown).reduce((str, [type, { total, constant, dice }]) => {
        const config = GameSystemConfig.damageTypes[type] ?? GameSystemConfig.healingTypes[type];
        return `${str}
              <section class="tooltip-part">
              ${tooltipFormula && str === "" ? diceFormula : ""}
              </section>
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
      }, "")}
        </div>
        <h4 class="dice-total">${total}</h4>
      </div>
    `;
    return roll;
  }
  _enrichDamageTooltip(rolls, html) {
    if (!configSettings.mergeCard) {
      return super._enrichDamageTooltip(rolls, html);
    }
    if (getProperty(this, "flags.dnd5e.roll.type") !== "midi") return;
    for (let rType of ["damage", "other-damage", "bonus-damage"]) {
      const rollsToCheck = this.rolls.filter(r => getProperty(r, "options.midi-qol.rollType") === rType);
      if (rollsToCheck?.length) {
        let roll = this.collectRolls(rollsToCheck);
        roll.classList.add(`midi-${rType}-roll`);

        html.querySelectorAll(`.midi-${rType}-roll`)?.forEach(el => el.remove());
        if (rType === "bonus-damage") {
          const flavor = document.createElement("div");
          const flavors = rollsToCheck.map(r => r.options.flavor ?? r.options.type);
          const bonusDamageFlavor = flavors.join(", ");
          flavor.classList.add("midi-bonus-damage-flavor");
          flavor.innerHTML = bonusDamageFlavor;
          html.querySelector(`.midi-qol-${rType}-roll`)?.appendChild(flavor);
        }
        html.querySelector(`.midi-qol-${rType}-roll`)?.appendChild(roll);
        if (this.user.isGM && !game.user?.isGM && configSettings.hideRollDetails !== "none") {
          html.querySelectorAll(".dice-roll").forEach(el => el.removeEventListener("click", this._onClickDiceRoll.bind(this)));
          if (configSettings.hideRollDetails !== "none") html.querySelectorAll(`.midi-${rType}-roll .dice-tooltip`)?.forEach(el => el.remove());
          if (configSettings.hideRollDetails !== "none") html.querySelectorAll(`.midi-${rType}-roll .dice-formula`)?.forEach(el => el.remove());
        }
      }
    }
  }
  enrichAttackRolls(html) {
    if (this.user.isGM && game.user?.isGM) return;
    const hitFlag = getProperty(this.flags, "midi-qol.isHit");
    const hitString = hitFlag === undefined ? "" : hitFlag ? i18n("midi-qol.hits") : i18n("midi-qol.misses");
    let attackRollText;
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
    if (this.user.isGM && !game.user?.isGM && configSettings.hideRollDetails) {
      if (configSettings.hideRollDetails !== "none") html.querySelectorAll(".midi-attack-roll .dice-tooltip")?.forEach(el => el.classList.add("secret-roll"));
      if (configSettings.hideRollDetails !== "none") html.querySelectorAll(".midi-attack-roll .dice-formula")?.forEach(el => el.classList.add("secret-roll"));
      
    }
  }
  _enrichChatCard(html) {
    if (getProperty(this, "flags.dnd5e.roll.type") && getProperty(this, "flags.dnd5e.roll.type") !== "midi") return super._enrichChatCard(html);
    if (!getProperty(this, "flags.dnd5e.roll.type") && this.rolls.length > 0) return super._enrichChatCard(html);
    if (!getProperty(this, "flags.dnd5e.roll.type")) {
      html.querySelectorAll(".dice-tooltip").forEach(el => el.style.height = "0");
      return;
    }
    if (debugEnabled > 1) warn("Enriching chat card", this.id);
    super._enrichChatCard(html);
    this.enrichAttackRolls(html); // This has to run first to stop errors when ChatMessage5e._enrichDamageTooltip runs
    html.querySelectorAll(".dice-roll").forEach(el => el.removeEventListener("click", super._onClickDiceRoll.bind(this)));
    html.querySelectorAll(".dice-roll").forEach(el => el.removeEventListener("click", super._onClickDiceRoll.bind(this)));
  }
}

Hooks.once("init", () => {
  console.warn("Registering ChatMessageMidi");
  //@ts-expect-error
  CONFIG.ChatMessage.documentClass = ChatMessageMidi;
});
Hooks.once("setup", () => {
  console.warn("Registering ChatMessageMidi");
  //@ts-expect-error
  CONFIG.ChatMessage.documentClass = ChatMessageMidi;
});
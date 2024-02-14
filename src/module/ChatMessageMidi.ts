import { GameSystemConfig, debugEnabled, i18n, log } from "../midi-qol.js";
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
      /*
      if (message.user?.isGM) {
        const d20AttackRoll = getProperty(message.flags, "midi-qol.d20AttackRoll");
        if (configSettings.hideRollDetails === "all" || getProperty(message.flags, "midi-qol.GMOnlyAttackRoll")) {
          html.find(".dice-tooltip").remove();
          // html.find(".midi-qol-attack-roll .dice-total").text(`<span>${i18n("midi-qol.DiceRolled")}</span>`);
          html.find(".midi-qol-attack-roll .dice-roll").replaceWith(`<span>${i18n("midi-qol.DiceRolled")}</span>`);
          html.find(".midi-qol-damage-roll").find(".dice-roll").replaceWith(`<span>${i18n("midi-qol.DiceRolled")}</span>`);
          html.find(".midi-qol-other-roll").find(".dice-roll").replaceWith(`<span>${i18n("midi-qol.DiceRolled")}</span>`);
          html.find(".midi-qol-bonus-roll").find(".dice-roll").replaceWith(`<span>${i18n("midi-qol.DiceRolled")}</span>`);
          if (!(message.flags && message.flags["monks-tokenbar"])) // not a monks roll
            html.find(".dice-roll").replaceWith(`<span>${i18n("midi-qol.DiceRolled")}</span>`);
          // html.find(".dice-result").replaceWith(`<span>${i18n("midi-qol.DiceRolled")}</span>`); Monks saving throw css
          //TODO this should probably just check formula
        } else if (configSettings.hideRollDetails !== "none") {
          // in all cases remove the tooltip and formula from the non gm client
          html.find(".dice-tooltip").remove();
          html.find(".dice-formula").remove();
  
          if (d20AttackRoll && configSettings.hideRollDetails === "d20AttackOnly") {
            html.find(".midi-qol-attack-roll .dice-total").text(`(d20) ${d20AttackRoll}`);
            html.find(".midi-qol-damage-roll").find(".dice-roll").replaceWith(`<span>${i18n("midi-qol.DiceRolled")}</span>`);
            html.find(".midi-qol-other-roll").find(".dice-roll").replaceWith(`<span>${i18n("midi-qol.DiceRolled")}</span>`);
            html.find(".midi-qol-bonus-roll").find(".dice-roll").replaceWith(`<span>${i18n("midi-qol.DiceRolled")}</span>`);
          } else if (d20AttackRoll && configSettings.hideRollDetails === "d20Only") {
            html.find(".midi-qol-attack-roll .dice-total").text(`(d20) ${d20AttackRoll}`);
            html.find(".midi-qol-other-roll").find(".dice-tooltip").remove();
            html.find(".midi-qol-other-roll").find(".dice-formula").remove();
            html.find(".midi-qol-bonus-roll").find(".dice-tooltip").remove();
            html.find(".midi-qol-bonus-roll").find(".dice-formula").remove();
            /* TODO remove this pending feedback
                  html.find(".midi-qol-damage-roll").find(".dice-roll").replaceWith(`<span>${i18n("midi-qol.DiceRolled")}</span>`);
                  html.find(".midi-qol-other-roll").find(".dice-roll").replaceWith(`<span>${i18n("midi-qol.DiceRolled")}</span>`);
                  html.find(".midi-qol-bonus-roll").find(".dice-roll").replaceWith(`<span>${i18n("midi-qol.DiceRolled")}</span>`);
            * /
          } else if (d20AttackRoll && ["hitDamage", "hitCriticalDamage"].includes(configSettings.hideRollDetails)) {
            const hitFlag = getProperty(message.flags, "midi-qol.isHit");
            const hitString = hitFlag === undefined ? "" : hitFlag ? i18n("midi-qol.hits") : i18n("midi-qol.misses");
            html.find(".midi-qol-attack-roll .dice-total").text(`${hitString}`);
            if (configSettings.hideRollDetails === "hitDamage") {
              html.find(".midi-qol-attack-roll .dice-total").removeClass("critical");
              html.find(".midi-qol-attack-roll .dice-total").removeClass("fumble");
            }
  
            html.find(".midi-qol-other-roll").find(".dice-tooltip").remove();
            html.find(".midi-qol-other-roll").find(".dice-formula").remove();
            html.find(".midi-qol-bonus-roll").find(".dice-tooltip").remove();
            html.find(".midi-qol-bonus-roll").find(".dice-formula").remove();
          } else if (["details", "detailsDSN"].includes(configSettings.hideRollDetails)) {
            // html.find(".dice-tooltip").remove();
            // html.find(".dice-formula").remove();
          }
        }
      }
      */
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
    roll.innerHTML = `
      <div class="dice-result">
        ${tooltipFormula ? "" : diceFormula}
        <div class="dice-tooltip">
          ${hideToolTip ? "" :
        //@ts-expect-error
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
          // const bonusDamageFlavor = `<span>(${rollsToCheck.map(r => r.options.flavor ?? r.options.type)})</span>`;
          flavor.classList.add("midi-bonus-damage-flavor");
          flavor.innerHTML = bonusDamageFlavor;
          html.querySelector(`.midi-qol-${rType}-roll`)?.appendChild(flavor);
        }
        html.querySelector(`.midi-qol-${rType}-roll`)?.appendChild(roll);
      }
    }
    /*
    const otherRolls = this.rolls.filter(r => getProperty(r, "options.midi-qol.rollType") === "other");
    // otherRolls.forEach(r => r.terms.forEach(t => t.options.flavor = t.options?.flavor.label ?? ""))
    if (otherRolls?.length) {
      let roll = this.collectRolls(otherRolls);
      html.querySelectorAll(".midi-other-damage-roll")?.forEach(el => el.remove());
      roll.classList.add("midi-other-roll");
      html.querySelector(".midi-qol-other-roll")?.appendChild(roll);
    }
    */
  }
  enrichAttackRolls(html) {
    if (this.user.isGM && game.user?.isGM) return;
    const hitFlag = getProperty(this.flags, "midi-qol.isHit");
    const hitString = hitFlag === undefined ? "" : hitFlag ? i18n("midi-qol.hits") : i18n("midi-qol.misses");
    let attackRollText;;
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
    if (configSettings.hideRollDetails !== "none") html.querySelectorAll(".midi-attack-roll .dice-tooltip")?.forEach(el => el.remove());
    if (configSettings.hideRollDetails !== "none") html.querySelectorAll(".midi-attack-roll .dice-formula")?.forEach(el => el.remove());
  }

  _enrichChatCard(html) {
    if (getProperty(this, "flags.dnd5e.roll.type") !== "midi") return super._enrichChatCard(html);
    this.enrichAttackRolls(html);
    super._enrichChatCard(html);
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
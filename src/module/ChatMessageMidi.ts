import { GameSystemConfig, debugEnabled, i18n, log, warn } from "../midi-qol.js";
import { configSettings } from "./settings.js";
import { getDamageType } from "./utils.js";

export class ChatMessageMidi extends globalThis.dnd5e.documents.ChatMessage5e {
  constructor(...args) {
    super(...args);
    if (debugEnabled > 1) log("Chat message midi constructor", ...args)
  }

  _aggregateDamageRoll(roll, breakdown) {
    for ( let i = roll.terms.length - 1; i >= 0; ) {
      const term = roll.terms[i--];
      if ( !(term instanceof NumericTerm) && !(term instanceof DiceTerm) ) continue;
      const flavor = term.flavor?.toLowerCase();
      const damageType = flavor === "" ? undefined : getDamageType(flavor);
      const type = damageType ? damageType : roll.options.type;
      const aggregate = breakdown[type] ??= { total: 0, constant: 0, dice: [] };
      const value: number = Number(term.total ?? 0);
      if ( term instanceof DiceTerm ) aggregate.dice.push(...term.results.map(r => ({
        result: term.getResultLabel(r), classes: term.getResultCSS(r).filterJoin(" ")
      })));
      let multiplier = 1;
      let operator = roll.terms[i];
      while ( operator instanceof OperatorTerm ) {
        if ( operator.operator === "-" ) multiplier *= -1;
        operator = roll.terms[--i];
      }
      aggregate.total += value * multiplier;
      if ( term instanceof NumericTerm ) aggregate.constant += value * multiplier;
    }
  }

  collectRolls(rolls) {
    let { formula, total, breakdown } = rolls.reduce((obj: any, r) => {
      obj.formula.push(r.formula);
      obj.total += r.total;
      this._aggregateDamageRoll(r, obj.breakdown);
      return obj;
    }, { formula: [], total: 0, breakdown: {} });
    formula = formula.join(" + ");
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
        <div class="dice-tooltip">
          ${formulaInToolTip ? diceFormula : ""}
          ${tooltipContents}
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
        if ((configSettings.hideRollDetails ?? "none") !== "none" && !game.user?.isGM && this.user.isGM) {
          html.querySelectorAll(".dice-roll").forEach(el => el.addEventListener("click", this.noDiceClicks.bind(this)));
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
    if ((getProperty(this, "flags.midi-qol.roll")?.length > 0) && getProperty(this, "flags.dnd5e.roll.type") !== "midi") {
      // this.rolls = getProperty(this, "flags.midi-qol.roll");
      super._enrichChatCard(html);
      html.querySelectorAll(".dice-tooltip").forEach(el => el.style.height = "0");
      return; // Old form midi chat card tht causes dnd5e to throw errors
    }
    if (getProperty(this, "flags.dnd5e.roll.type") !== "midi") return super._enrichChatCard(html);
    if (debugEnabled > 1) warn("Enriching chat card", this.id);
    this.enrichAttackRolls(html); // This has to run first to stop errors when ChatMessage5e._enrichDamageTooltip runs
    super._enrichChatCard(html);
    if (this.user.isGM && (configSettings.hideRollDetails ?? "none") !== "none" && !game.user?.isGM) {
      html.querySelectorAll(".dice-roll").forEach(el => el.addEventListener("click", this.noDiceClicks.bind(this)));
      html.querySelectorAll(".dice-tooltip").forEach(el => el.style.height = "0");
    }
  }

  noDiceClicks(event) { 
    event.stopImmediatePropagation();
    return;
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
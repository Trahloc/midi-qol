import { GameSystemConfig, debugEnabled, log } from "../midi-qol.js";
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
    const roll = document.createElement("div");
    roll.classList.add("dice-roll");
    roll.innerHTML = `
      <div class="dice-result">
        <div class="dice-formula">${formula}</div>
        <div class="dice-tooltip">
          ${
      //@ts-expect-error
      Object.entries(breakdown).reduce((str, [type, { total, constant, dice }]) => {
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
    if (rolls?.length) {
      let roll = this.collectRolls(rolls);
      html.querySelectorAll(".midi-damage-roll").forEach(el => el.remove());
      html.querySelector(".midi-qol-damage-roll").append(roll);
    }
    const otherRolls = this.rolls.filter(r =>  getProperty(r, "options.midi-qol.rollType") === "other");
    // otherRolls.forEach(r => r.terms.forEach(t => t.options.flavor = t.options?.flavor.label ?? ""))
    if (otherRolls?.length) {
      let roll = this.collectRolls(otherRolls);
      html.querySelectorAll(".midi-other-damage-roll").forEach(el => el.remove());
      html.querySelector(".midi-qol-other-roll").append(roll);
    }
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
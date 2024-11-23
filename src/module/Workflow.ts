import { warn, debug, log, i18n, MESSAGETYPES, error, MQdefaultDamageType, debugEnabled, MQItemMacroLabel, debugCallTiming, geti18nOptions, i18nFormat, GameSystemConfig, i18nSystem, allDamageTypes, MODULE_ID, NumericTerm } from "../midi-qol.js";
import { socketlibSocket, timedAwaitExecuteAsGM, timedExecuteAsGM, untimedExecuteAsGM } from "./GMAction.js";
import { installedModules } from "./setupModules.js";
import { configSettings, autoRemoveTargets, checkRule, autoFastForwardAbilityRolls, checkMechanic } from "./settings.js";
import { createDamageDetailV4, processDamageRoll, untargetDeadTokens, applyTokenDamage, checkIncapacitated, getAutoRollDamage, isAutoFastAttack, getAutoRollAttack, getRemoveDamageButtons, getRemoveAttackButtons, getTokenPlayerName, checkNearby, hasCondition, expireMyEffects, validTargetTokens, getTokenForActorAsSet, doReactions, playerFor, requestPCActiveDefence, evalActivationCondition, processDamageRollBonusFlags, asyncHooksCallAll, asyncHooksCall, MQfromUuidSync, midiRenderRoll, markFlanking, canSense, tokenForActor, getTokenForActor, createConditionData, evalCondition, removeHidden, hasDAE, computeCoverBonus, FULL_COVER, isInCombat, displayDSNForRoll, setActionUsed, removeInvisible, isTargetable, hasWallBlockingCondition, getTokenDocument, getToken, checkDefeated, getIconFreeLink, activityHasAutoPlaceTemplate, itemOtherFormula, addRollTo, sumRolls, midiRenderAttackRoll, midiRenderDamageRoll, midiRenderBonusDamageRoll, midiRenderOtherDamageRoll, debouncedUpdate, getCachedDocument, clearUpdatesCache, getDamageType, getTokenName, setRollOperatorEvaluated, evalAllConditionsAsync, getAppliedEffects, canSee, CEAddEffectWith, getCEEffectByName, CEHasEffectApplied, CERemoveEffect, CEToggleEffect, getActivityDefaultDamageType, activityHasAreaTarget, getsaveMultiplierForActivity, checkActivityRange, computeDistance, getAoETargetType, getActivityAutoTarget, activityHasEmanationNoTemplate, isAutoFastDamage } from "./utils.js"
import { OnUseMacros } from "./apps/Item.js";
import { bonusCheck, collectBonusFlags, defaultRollOptions, procAbilityAdvantage, procAutoFail } from "./patching.js";
import { saveTargetsUndoData, saveUndoData } from "./undo.js";
import { TroubleShooter } from "./apps/TroubleShooter.js";
import { busyWait } from "./tests/setupTest.js";
import { MidiSummonActivity } from "./activities/SummonActivity.js";
import { postTemplateConfirmTargets, selectTargets, templateTokens } from "./activities/activityHelpers.js";

export const shiftOnlyEvent = { shiftKey: true, altKey: false, ctrlKey: false, metaKey: false, type: "" };
export function noKeySet(event) { return !(event?.shiftKey || event?.ctrlKey || event?.altKey || event?.metaKey) }

type damageBonusMacroSingleResult = {
  damageRoll: string | undefined;
  flavor: string | undefined;
  damageType: string | undefined;
};
type damageBonusMacroResult = damageBonusMacroSingleResult[] | damageBonusMacroSingleResult;

export type WorkflowState = undefined | ((context: any) => Promise<WorkflowState>);

export class Workflow {
  [x: string]: any;
  static _workflows: {} = {};

  //@ts-expect-error dnd5e v10
  actor: globalThis.dnd5e.documents.Actor5e;
  //@ts-expect-error dnd5e v10
  item: globalThis.dnd5e.documents.Item5e;
  itemCardId: string | undefined | null;
  itemCardUuid: string | undefined | null;
  itemCardData: {};
  displayHookId: number | null;

  event: { shiftKey: boolean, altKey: boolean, ctrlKey: boolean, metaKey: boolean, type: string };
  capsLock: boolean;
  speaker: any;
  tokenUuid: string | undefined;  // TODO change tokenId to tokenUuid
  targets: Set<Token | TokenDocument>;
  placeTemplateHookId: number | null;
  inCombat: boolean; // Is the item wielder in combat.
  isTurn: boolean; // Is it the item wielder's turn.
  AoO: boolean; // Is the attack an attack of
  damageList: any[];

  _id: string;
  saveDisplayFlavor: string;
  showCard: boolean;
  get id() { return this._id }
  get uuid() { return this._id }
  itemId: string;
  itemUuid: string;
  _currentState: number;
  public workflowAction: WorkflowState;
  isCritical: boolean;
  isFumble: boolean;
  hitTargets: Set<Token | TokenDocument>;
  hitTargetsEC: Set<Token | TokenDocument>;
  attackRoll: Roll | undefined;
  diceRoll: number | undefined;
  attackTotal: number;
  attackCardData: ChatMessage | undefined;
  attackRollHTML: HTMLElement | JQuery<HTMLElement> | string;
  attackRollCount: number;
  noAutoAttack: boolean; // override attack roll for standard care

  hitDisplayData: any;

  get damageRoll(): Roll | undefined {
    if (!this.damageRolls || this.damageRolls.length === 0) return undefined;
    let finalRoll = this.damageRolls.slice(1).reduce((rolls, roll) => addRollTo(rolls, roll), this.damageRolls[0]);
    return finalRoll;
  }
  set damageRoll(roll: Roll | undefined) {
    if (roll) this.setDamageRoll(roll);
  }
  set bonusDamageRoll(roll: Roll | undefined) {
    if (roll) this.setBonusDamageRoll(roll);
  }
  get bonusDamageRoll(): Roll | undefined {
    if (!this.bonusDamageRolls || this.bonusDamageRolls.length === 0) return undefined;
    let finalRoll = this.bonusDamageRolls.slice(1).reduce((rolls, roll) => addRollTo(rolls, roll), this.bonusDamageRolls[0]);
    return finalRoll;
  }
  get otherActivity() {
    return this.activity.otherActivity;
  }
  get activityHasSave() {
    return this.saveActivity?.save || this.saveActvity?.check;
  }
  get saveActivity() {
    if (this.activity.save || this.activity.check) return this.activity;
    return this.otherActivity;
  }

  damageRolls: Roll[] | undefined;
  extraRolls: Roll[] | undefined;
  saveRolls: Roll[] | undefined;
  damageTotal: number;
  rawDamageDetail: any[];
  rawOtherDamageDetail: any[];
  rawBonusDamageDetail: any[];
  damageRollHTML: HTMLElement | JQuery<HTMLElement> | string;
  damageRollCount: number;
  damageCardData: ChatMessage | undefined;
  defaultDamageType: string | undefined;
  noAutoDamage: boolean; // override damage roll for damage rolls
  isVersatile: boolean;

  saves: Set<Token | TokenDocument>;
  superSavers: Set<Token | TokenDocument>;
  semiSuperSavers: Set<Token | TokenDocument>;
  failedSaves: Set<Token | TokenDocument>;
  fumbleSaves: Set<Token | TokenDocument>;
  criticalSaves: Set<Token | TokenDocument>;
  advantageSaves: Set<Token | TokenDocument>;
  saveRequests: any;
  saveTimeouts: any;

  saveDisplayData;

  chatMessage: ChatMessage;
  displayId: string;
  //@ts-expect-error dnd5e v10
  reactionUpdates: Set<globalThis.dnd5e.documents.Actor5e>;
  flagTags: {} | undefined;
  onUseMacros: OnUseMacros | undefined;
  ammoOnuseMacros: OnUseMacros | undefined;

  attackAdvAttribution: Set<string>;
  advReminderAttackAdvAttribution: Set<string>;
  undoData: any = undefined;
  content: string | undefined; // since we batch updates need to cache content changes

  static get workflows() { return Workflow._workflows }
  static getWorkflow(id: string): Workflow | undefined {
    if (debugEnabled > 1) debug("Get workflow ", id, Workflow._workflows, Workflow._workflows[id])
    return Workflow._workflows[id];
  }

  get bonusDamageFlavor() {
    return `(${this.bonusDamageRolls.map(r => r.options.flavor ?? r.options.type)})`;
  }

  public get chatCard() {
    return getCachedDocument(this.itemCardUuid)
  }

  get damageFlavor() {
    return i18n("midi-qol.BaseDamageFlavor");
    // See what the reception to a simple header is
    if (this.rawDamageDetail.filter(d => d.damage !== 0).length === 0) return `(${allDamageTypes[this.defaultDamageType ?? "none"].label})`
    return `(${this.rawDamageDetail.filter(d => d.damage !== 0).map(d => allDamageTypes[d.type].label || d.type)})`;
  }

  get otherDamageFlavor() {
    return i18n("midi-qol.OtherDamageFlavor");
  }

  get useCondition() {
    if (this.activity?.useCondition) return this.activity.useCondition;
    return foundry.utils.getProperty(this, `flags.${MODULE_ID}.itemCondition`);
  }

  get effectActivationCondition() {
    if (this.activity.effectCondition) return this.activity.effectCondition;
    return foundry.utils.getProperty(this, `flags.${MODULE_ID}.effectCondition`);
  }

  get hasSave(): boolean {
    return this.activity.save || this.activity.check || this.otherActivity?.save || this.otherActivity?.check;
  }


  get otherDamageFormula() {
    return itemOtherFormula(this.otherDamageItem);
  }

  get otherUseCondition() {
    if (this.otherActivity?.useCondition) return this.otherActivity?.useCondition;
    return foundry.utils.getProperty(this, `item.flags.${MODULE_ID}.otherCondition`);
  }

  get otherEffectActivationCondition() {
    if (this.otherActivity?.effectCondition) return this.otherActivity?.effectCondition;
    return foundry.utils.getProperty(this, `item.flags.${MODULE_ID}.otherCondition`);
  }

  get shouldRollDamage(): boolean {
    if (this.systemCard) return false;
    if (this.actor.type === configSettings.averageDamage || configSettings.averageDamage === "all") return true;
    const normalRoll = getAutoRollDamage(this) === "always"
      || (getAutoRollDamage(this) === "saveOnly" && this.activity.save && !this.activity.attackl)
      || (getAutoRollDamage(this) !== "none" && !this.activity.attack)
      || (getAutoRollDamage(this) === "onHit" && (this.hitTargets.size > 0 || this.hitTargetsEC?.size > 0 || this.targets.size === 0))
      || (getAutoRollDamage(this) === "onHit" && (this.hitTargetsEC?.size > 0));
    return this.rollToggle ? !normalRoll : normalRoll;
  }

  get spellLevel(): number {
    let spellLevel;
    if (this.chatCard) spellLevel = foundry.utils.getProperty(this.chatCard, "flags.dnd5e.use.spellLevel")
    return spellLevel ?? this.item.level ?? 0;
  }

  get workflowType() { return "BaseWorkflow" };

  constructor(actor: any /* Actor5e*/, activity: any /* Item5e*/, speaker, targets, options: any = {}) {
    this.actor = actor;
    this.item = activity.item;
    this.activity = activity;
    activity.workflow = this;
    if (this.workflowType === "BaseWorkflow") {
      const existing = Workflow.getWorkflow(activity.uuid);
      if (existing) {
        Workflow.removeWorkflow(activity.uuid);
        //TODO check this
        if ([existing.WorkflowState_RollFinished, existing.WorkflowState_WaitForDamageRoll].includes(existing.currentAction) && existing.itemCardUuid) {
          clearUpdatesCache(existing.itemCardUuid);
          const existingCard = MQfromUuidSync(existing.itemCardUuid);
          if (existingCard) existingCard.delete();
          // game.messages?.get(existing.itemCardId ?? "")?.delete();
        }
      }
    }

    if (!this.item || this instanceof DummyWorkflow) {
      this.itemId = foundry.utils.randomID();
      this._id = foundry.utils.randomID();
      this.workflowName = `workflow ${this._id}`;
    } else {
      this.itemId = this.item.id;
      this.itemUuid = this.item.uuid;
      this._id = this.activity.uuid;
      this.workflowName = options.workflowOptions?.workflowName ?? this.item?.name ?? "no item";
      this.workflowName = `${this.constructor.name} ${this.workflowName} ${foundry.utils.randomID()}`;
      const consume = this.activity.consumption;
      if (consume?.type === "ammo") {
        this.ammo = this.item.actor.items.get(consume.target);
      }
    }

    this.tokenId = speaker.token;
    const token: Token | undefined = canvas?.tokens?.get(this.tokenId);
    this.tokenUuid = token?.document?.uuid; // TODO see if this could be better
    this.token = token;
    if (!this.token) {
      this.token = tokenForActor(this.actor);
    }
    this.speaker = speaker;
    if (this.speaker.scene) this.speaker.scene = canvas?.scene?.id;
    this.targets = new Set(targets ? targets : []);
    if (this.activity?.target?.affects.type === "self") this.targets = new Set(this.token ? [this.token] : []);
    this.saves = new Set();
    this.superSavers = new Set();
    this.semiSuperSavers = new Set();
    this.failedSaves = new Set(this.targets)
    this.hitTargets = new Set(this.targets);
    this.hitTargetsEC = new Set();
    this.criticalSaves = new Set();
    this.fumbleSaves = new Set();
    this.isCritical = false;
    this.isFumble = false;
    this.currentAction = this.WorkflowState_NoAction;
    this.suspended = true;
    this.aborted = false;
    // this.spellLevel = item?.level || 0;
    this.displayId = this.id;
    this.itemCardData = {};
    this.attackCardData = undefined;
    this.damageCardData = undefined;
    this.event = options?.event;
    this.capsLock = options?.event?.getModifierState && options?.event.getModifierState("CapsLock");
    this.noOptionalRules = options?.noOptionalRules ?? false;
    this.attackRollCount = 0;
    this.damageRollCount = 0;
    this.advantage = undefined;
    this.disadvantage = undefined;
    this.isVersatile = false;
    this.templateId = null;
    this.templateUuid = null;
    this.template = undefined;
    this.targetsCanSense = new Set();
    this.targetsCanSee = new Set();
    this.tokenCanSense = new Set();
    this.tokenCanSee = new Set();

    this.saveRequests = {};
    this.defenceRequests = {};
    this.saveTimeouts = {};
    this.defenceTimeouts = {}
    this.shouldRollOtherDamage = true;
    this.forceApplyEffects = false;

    this.placeTemplateHookId = null;
    this.rawDamageDetail = [];
    this.rawOtherDamageDetail = [];
    this.displayHookId = null;
    this.onUseCalled = false;
    this.effectsAlreadyExpired = [];
    this.reactionUpdates = new Set();
    if (!(this instanceof DummyWorkflow)) Workflow._workflows[this.id] = this;
    this.needTemplate = activityHasAreaTarget(this.activity);
    this.attackRolled = false;
    this.flagTags = undefined;
    this.workflowOptions = options?.workflowOptions ?? {};
    this.rollOptions = foundry.utils.mergeObject(this.rollOptions ?? foundry.utils.duplicate(defaultRollOptions), { autoRollAttack: getAutoRollAttack(this), autoRollDamage: getAutoRollDamage() }, { overwrite: true });
    this.attackAdvAttribution = new Set();
    this.advReminderAttackAdvAttribution = new Set();
    this.systemString = game.system.id.toUpperCase();
    this.options = options;
    this.initSaveResults();
    this.extraRolls = [];
    this.needsAttackAdvantageCheck = true;

    this.defaultDamageType = getActivityDefaultDamageType(this.activity) ?? MQdefaultDamageType;
    if (this.activity.actionType === "heal" && !Object.keys(GameSystemConfig.healingTypes).includes(this.defaultDamageType ?? "")) this.defaultDamageType = "healing";

    if (configSettings.allowUseMacro) {
      this.onUseMacros = new OnUseMacros();
      this.ammoOnUseMacros = new OnUseMacros();
      const itemOnUseMacros = foundry.utils.getProperty(this.item ?? {}, `flags.${MODULE_ID}.onUseMacroParts`) ?? new OnUseMacros();
      const ammoOnUseMacros = foundry.utils.getProperty(this.ammo ?? {}, `flags.${MODULE_ID}.onUseMacroParts`) ?? new OnUseMacros();
      const actorOnUseMacros = foundry.utils.getProperty(this.actor ?? {}, `flags.${MODULE_ID}.onUseMacroParts`) ?? new OnUseMacros();
      if (this.workflowOptions?.onlyOnUseItemMacros) {
        this.onUseMacros.items = [...itemOnUseMacros.items];
      } else {
        this.onUseMacros.items = [...itemOnUseMacros.items, ...actorOnUseMacros.items];
      }
      //@ this.onUseMacros.items = [...itemOnUseMacros.items, ...actorOnUseMacros.items];
      this.ammoOnUseMacros.items = ammoOnUseMacros.items;
    }
    this.preSelectedTargets = canvas?.scene ? new Set(game.user?.targets) : new Set(); // record those targets targeted before cast.
    if (this.item && ["spell", "feat", "weapon"].includes(this.item.type)) {
      if (!this.item?.flags.midiProperties) {
        this.item.flags.midiProperties = {};
      }
    }
    this.needTemplate = (getActivityAutoTarget(this.activity) !== "none" && activityHasAreaTarget(this.activity) && !activityHasAutoPlaceTemplate(this.item));
    if (this.needTemplate && options.noTemplateHook !== true) {
      if (debugEnabled > 0) warn("registering for preCreateMeasuredTemplate, createMeasuredTemplate")
      this.preCreateTemplateHookId = Hooks.once("preCreateMeasuredTemplate", this.setTemplateFlags.bind(this));
      this.placeTemplateHookId = Hooks.once("createMeasuredTemplate", selectTargets.bind(this));
    }
    if (this.activity instanceof MidiSummonActivity && configSettings.autoRemoveSummonedCreature) {
      this.postSummonHookId = Hooks.once("dnd5e.postSummon", (activity, profile, createdTokens, options) => {
        this.summonedCreatures = createdTokens;
      })
    }
    this.needItemCard = true;
    this.preItemUseComplete = false;
    this.kickStart = false;
  }

  public someEventKeySet() {
    return this.event?.shiftKey || this.event?.altKey || this.event?.ctrlKey || this.event?.metaKey;
  }

  public someAutoRollEventKeySet() {
    return this.event?.altKey || this.event?.ctrlKey || this.event?.metaKey;
  }

  public processAttackEventOptions() { }

  setTemplateFlags(templateDoc, data, context, user): boolean {
    if (debugEnabled > 0) warn("setTemplateFlags", templateDoc, this.item?.uuid, this.actor.uuid)
    if (this.item) templateDoc.updateSource({ "flags.midi-qol.itemUuid": this.item.uuid });
    if (this.actor) templateDoc.updateSource({ "flags.midi-qol.actorUuid": this.actor.uuid });
    if (this.activity) templateDoc.updateSource({ "flags.midi-qol.activityUuid": this.activity.uuid });
    if (!foundry.utils.getProperty(templateDoc, "flags.dnd5e.origin")) templateDoc.updateSource({ "flags.dnd5e.origin": this.uuid });
    return true;
  }

  static async removeItemCardConfirmRollButton(itemCardUuid: string) {
    const chatMessage = getCachedDocument(itemCardUuid);
    let content = chatMessage?.content && foundry.utils.duplicate(chatMessage.content);
    if (!content) return;
    const confirmMissRe = /<button class="midi-qol-confirm-damage-roll-complete-miss" data-action="confirm-damage-roll-complete-miss">[^<]*?<\/button>/;
    content = content?.replace(confirmMissRe, "");
    const confirmRe = /<button class="midi-qol-confirm-damage-roll-complete" data-action="confirm-damage-roll-complete">[^<]*?<\/button>/;
    content = content?.replace(confirmRe, "");
    const confirmHitRe = /<button class="midi-qol-confirm-damage-roll-complete-hit" data-action="confirm-damage-roll-complete-hit">[^<]*?<\/button>/;
    content = content?.replace(confirmHitRe, "");
    const cancelRe = /<button class="midi-qol-confirm-damage-roll-cancel" data-action="confirm-damage-roll-cancel">[^<]*?<\/button>/;
    content = content?.replace(cancelRe, "");
    // TODO come back and make this cached.
    return debouncedUpdate(chatMessage, { content });
  }

  static async removeItemCardAttackDamageButtons(itemCardUuid: string, removeAttackButtons: boolean = true, removeDamageButtons: boolean = true) {
    try {
      const chatMessage = getCachedDocument(itemCardUuid);
      let content = chatMessage?.content && foundry.utils.duplicate(chatMessage.content);
      if (!content) return;
      // TODO work out what to do if we are a damage only workflow and betters rolls is active - display update wont work.
      const attackRe = /<div class="midi-qol-attack-buttons[^"]*">[\s\S]*?<\/div>/
      // const otherAttackRe = /<button data-action="attack">[^<]*<\/button>/;
      const damageRe = /<div class="midi-qol-damage-buttons[^"]*">[\s\S]*?<\/div>/
      const versatileRe = /<button class="midi-qol-versatile-damage-button" data-action="versatile">[^<]*<\/button>/
      const otherDamageRe = /<button class="midi-qol-otherDamage-button" data-action="formula">[^<]*<\/button>/

      const formulaRe = /<button data-action="formula">[^<]*<\/button>/
      if (removeAttackButtons) {
        content = content?.replace(attackRe, "")
      }
      if (removeDamageButtons) {
        content = content?.replace(damageRe, "")
        content = content?.replace(otherDamageRe, "")
        content = content?.replace(formulaRe, "")
        content = content?.replace(versatileRe, "<div></div>");
      }
      // Come back and make this cached.
      await debouncedUpdate(chatMessage, { content });
      if (removeDamageButtons) {
        setTimeout(() => {
          const chatmessageElt = document?.querySelector(`[data-message-id="${chatMessage.id ?? "XXX"}"]`);
          // if (chatmessageElt) chatmessageElt?.querySelectorAll(".collapsible").forEach(ce => { if (!ce.classList.contains("collapsed")) ce.classList.add("collapsed") });
        }, 1);
      }
    } catch (err) {
      const message = `removeAttackDamageButtons`;
      TroubleShooter.recordError(err, message);
      throw err;
    }
  }

  static async removeWorkflow(id: string) {
    const workflow = Workflow.getWorkflow(id);
    if (!workflow) {
      if (debugEnabled > 0) warn("removeWorkflow | No such workflow ", id);
      return;
    }
    // If the attack roll broke and we did we roll again will have an extra hook laying around.
    if (workflow.displayHookId) Hooks.off("preCreateChatMessage", workflow.displayHookId);
    // This can lay around if the template was never placed.
    if (workflow.placeTemplateHookId) {
      Hooks.off("createMeasuredTemplate", workflow.placeTemplateHookId)
      Hooks.off("preCreateMeasuredTemplate", workflow.preCreateTemplateHookId);
    }
    if (workflow.postSummonHookId) Hooks.off("dnd5e.postSummon", workflow.postSummonHookId);
    if (debugEnabled > 0) warn(`removeWorkflow deleting ${id}`, Workflow._workflows[id]);
    delete Workflow._workflows[id];
    // Remove buttons
    if (workflow.itemCardUuid) {
      if (workflow.currentAction === workflow.WorkflowState_ConfirmRoll) {
        const itemCard = workflow.chatCard;
        if (itemCard) await itemCard.delete();
        clearUpdatesCache(workflow.itemCardUuid);
      } else {
        await Workflow.removeItemCardAttackDamageButtons(workflow.itemCardUuid);
        await Workflow.removeItemCardConfirmRollButton(workflow.itemCardUuid);
        setTimeout(() => {
          const chatmessageElt = document?.querySelector(`[data-message-id="${workflow.itemCardId ?? "XXX"}"]`);
          if (chatmessageElt) chatmessageElt?.querySelectorAll(".collapsible").forEach(ce => { if (!ce.classList.contains("collapsed")) ce.classList.add("collapsed") });
        }, 1)
      }
    }
  }

  public static get stateTable(): ({ name: string, value: WorkflowState } | {}) {
    const table = {};
    Reflect.ownKeys(this.prototype).filter(k => k.toString().startsWith("WorkflowState_")).forEach(k => table[k.toString()] = this.prototype[k.toString()]);
    return table;
  }

  public static get stateHooks(): any {
    const hooks: any = {};
    for (let key of Object.keys(this.stateTable)) {
      const name = this.nameForState(this.stateTable[key]);
      hooks[`pre${name}`] = `before ${name} (S*)`;
      hooks[`post${name}`] = `after ${name} (S*)`;
    }
    return hooks;
  }
  public static get allHooks(): any {
    const allHooks = foundry.utils.mergeObject(geti18nOptions("onUseMacroOptions"), this.stateHooks);
    return allHooks;
  }

  public static get allMacroPasses(): any {
    return this.allHooks;
  }

  async callHooksForAction(prePost: ("pre" | "post"), action: WorkflowState): Promise<boolean | undefined> {
    if (!action) {
      console.warn("midi-qol | callPreHooksForAction | No action");
      return true;
    }
    if (debugEnabled > 1) log(`callHooksForAction | ${prePost} ${this.nameForState(action)}`)
    let hookName = `midi-qol.${prePost}${this.nameForState(action)}`
    if (await asyncHooksCall(hookName, this) === false) return false;
    if (this.item && await asyncHooksCall(`${hookName}.${this.item.uuid}`, this) === false) return false;
    if (this.activity && await asyncHooksCall(`${hookName}.${this.activity.uuid}`, this) === false) return false;
    hookName = `midi-qol.premades.${prePost}${this.nameForState(action)}`
    if (await asyncHooksCall(hookName, this) === false) return false;
    if (this.item && await asyncHooksCall(`${hookName}.${this.item.uuid}`, this) === false) return false;
    if (this.activity && await asyncHooksCall(`${hookName}.${this.activity.uuid}`, this) === false) return false;
    return true;
  }
  async callOnUseMacrosForAction(prePost: ("pre" | "post"), action: WorkflowState): Promise<(damageBonusMacroResult | boolean | undefined)[]> {
    if (!configSettings.allowUseMacro || this.options.noOnUseMacro === true) {
      warn(`Calling ${prePost}${this.nameForState(action)} disabled due to macro call settings`);
      return [];
    }
    if (!action) {
      console.warn("midi-qol | callOnUseMacrosForAction | No action");
      return [];
    }
    if (debugEnabled > 1) log(`callOnUseMacrosForAction | ${prePost} ${this.nameForState(action)}`)
    const macroPass = `${prePost}${this.nameForState(action)}`;

    return this.callMacros(this.item, this.onUseMacros?.getMacros(macroPass), "OnUse", macroPass);
  };

  public static nameForState(state: WorkflowState | undefined): string {
    if (state === undefined) return "undefined";
    return state?.name.replace(/^WorkflowState_/, "") ?? state.name;
  }

  public nameForState(state: WorkflowState | undefined): string {
    return Workflow.nameForState(state);
  }

  /**
   * 
   * @param context context to be passed to the state call. Typically the data that caused the an unsuspend to fire, but can be others
   * Trigger execution of the current state with the context that triggered the unsuspend. e.g. attackRoll or damageRoll
   */
  public async unSuspend(context: any) {
    if (context.templateDocument) {
      this.templateId = context.templateDocument?.id;
      this.templateUuid = context.templateDocument?.uuid;
      this.template = context.templateDocument;
      this.needTemplate = false;
      if (!this.needItemCard) context.itemUseComplete = true;
      if (debugEnabled > 0) warn(`${this.workflowName} unsuspend with template ${this.templateId}`, this.suspended, context.templateDocument.flags, this.nameForState(this.currentAction));
    }
    if (context.itemCardUuid) {
      this.itemCardId = context.itemCardId;
      this.itemCardUuid = context.itemCardUuid;
      this.needItemCard = false;
    }
    if (context.itemUseComplete) this.preItemUseComplete = true;

    // Currently this just brings the workflow to life.
    // next version it will record the contexts in the workflow and bring the workflow to life.
    if (this.suspended) {
      this.suspended = false;
      // Need to record each of the possible things
      // attackRoll
      // damageRoll
      this.performState(this.currentAction, context);
    }
  }

  /**
   * 
   * @param newState the state to execute
   * @param context context to be passed to the state call. Typically the data that caused the an unsuspend to fire, but can be others
   * Continues to execute states until suspended, aborted or the state transition count is exceeded.
   */

  public async performState(newState: (() => Promise<WorkflowState>) | undefined, context: any = {}) {
    if (this.stateTransitionCount === undefined) this.stateTransitionCount = 0;
    const MaxTransitionCount = 150;
    let isAborting = this.aborted;

    try {
      while (this.stateTransitionCount < (this.MaxTransitionCount ?? MaxTransitionCount)) {
        const currentName = this.nameForState(this.currentAction);
        this.suspended = false;
        this.stateTransitionCount += 1;
        isAborting ||= this.aborted || (newState === this.WorkflowState_Abort);
        if (newState === undefined) {
          const message = `${this.workflowName} Perform state called with undefined action - previous state was ${this.nameForState(this.currentAction)}`
          error(message);
          TroubleShooter.recordError(new Error(message), message);
          this.suspended === true;
          break;
        }
        const name = this.nameForState(newState);
        await busyWait(0.01);
        if (this.currentAction !== newState) {
          if (!isAborting || this.currentAction === this.WorkflowState_Completed) {
            await this.callOnUseMacrosForAction("post", this.currentAction);
            if (await this.callHooksForAction("post", this.currentAction) === false && !isAborting) {
              console.warn(`${this.workflowName} ${currentName} -> ${name} aborted by post ${this.nameForState(this.currentAction)} Hook`)
              newState = this.aborted ? this.WorkflowState_Abort : this.WorkflowState_RollFinished;
            }
            if (debugEnabled > 0) warn(`${this.workflowName} finished ${currentName}`);
            if (debugEnabled > 0) warn(`${this.workflowName} transition ${this.nameForState(this.currentAction)} -> ${name}`);

            if (!isAborting && this.aborted) {
              console.warn(`${this.workflowName} ${currentName} -> ${name} aborted by pre ${this.nameForState(this.currentAction)} macro pass`)
              newState = this.WorkflowState_Abort;
              continue;
            }
          }
          await this.callOnUseMacrosForAction("pre", newState);
          if (await this.callHooksForAction("pre", newState) === false && !isAborting) {
            console.warn(`${this.workflowName} ${currentName} -> ${name} aborted by pre ${this.nameForState(newState)} Hook`)
            newState = this.aborted ? this.WorkflowState_Abort : this.WorkflowState_RollFinished;
            continue;
          }
          if (this.aborted && !isAborting) {
            console.warn(`${this.workflowName} ${currentName} -> ${name} aborted by pre ${this.nameForState(newState)} macro pass`)
            newState = this.WorkflowState_Abort;
            continue;
          }
          this.currentAction = newState;
        }
        let nextState = await this.currentAction.bind(this)(context);

        if (nextState === this.WorkflowState_Suspend) {
          this.suspended = true;
          // this.currentAction = this.WorkflowState_Suspend;
          if (debugEnabled > 0) warn(`${this.workflowName} ${this.nameForState(this.currentAction)} -> suspended Workflow ${this.id}`);
          break;
        }
        newState = nextState;
        context = {};
      }

      if (this.stateTransitionCount >= (this.MaxTransitionCount ?? MaxTransitionCount)) {
        const messagae = `performState | ${this.workflowName} Workflow ${this.id} exceeded ${this.maxTransitionCount ?? MaxTransitionCount} iterations`;
        error(messagae);
        TroubleShooter.recordError(new Error(messagae), messagae);
        if (Workflow.getWorkflow(this.id)) await Workflow.removeWorkflow(this.id);
      }
    } catch (err) {
      const message = `performState | ${this.workflowName} Workflow ${this.id}`;
      error(message, err);
      TroubleShooter.recordError(err, message);
    }
  }

  async WorkflowState_Suspend(context: any = {}): Promise<WorkflowState> {
    const message = `${this.workflowName} Workflow ${this.id} suspend should never be called`;
    error(message);
    TroubleShooter.recordError(new Error(message), message);
    return undefined;
  }

  async WorkflowState_NoAction(context: any = {}): Promise<WorkflowState> {
    if (debugEnabled > 0) warn("WorkflowState_NoAction", context);
    if (context.itemUseComplete) return this.WorkflowState_Start;
    return this.WorkflowState_Suspend;
  }

  async WorkflowState_Start(context: any = {}): Promise<WorkflowState> {
    this.selfTargeted = false;
    if (this.activity?.target?.affects.type === "self") {
      this.targets = getTokenForActorAsSet(this.actor);
      this.hitTargets = new Set(this.targets);
      this.failedSaves = new Set(this.targets);
      this.selfTargeted = true;
    }
    this.rangeTargeting = activityHasEmanationNoTemplate(this.activity);
    if (this.rangeTargeting) {
      this.setRangedTargets(this.activity.target);
      this.targets = validTargetTokens(this.targets);
      this.failedSaves = new Set(this.targets)
      this.hitTargets = new Set(this.targets);
      this.hitTargetsEC = new Set();
      return this.WorkflowState_AoETargetConfirmation;
    }

    this.temptargetConfirmation = getActivityAutoTarget(this.activity) !== "none" && activityHasAreaTarget(this.activity);
    if (debugEnabled > 1) debug("WORKFLOW NONE", getActivityAutoTarget(this.activity), activityHasAreaTarget(this.activity));
    if (this.temptargetConfirmation) {
      return this.WorkflowState_AwaitTemplate;
    }
    return this.WorkflowState_AoETargetConfirmation;
  }
  async WorkflowState_AwaitItemCard(context: any = {}): Promise<WorkflowState> {
    if (this.needItemCard || !this.preItemUseComplete) {
      if (debugEnabled > 0) warn("WorkflowState_AwaitItemCard suspending because needItemCard/preItemUseComplete", this.needItemCard, this.preItemUseComplete);
      return this.WorkflowState_Suspend;
    }
    if (this.needTemplate) {
      if (debugEnabled > 0) warn("WorkflowState_AwaitItemCard  needTemplate -> await template");
      return this.WorkflowState_AwaitTemplate;
    }
    if (debugEnabled > 0) warn("WorkflowState_AwaitItemCard  -> TemplatePlaced");
    return this.WorkflowState_TemplatePlaced;
  }
  async WorkflowState_AwaitTemplate(context: any = {}): Promise<WorkflowState> {
    if (debugEnabled > 0) warn("WorkflowState_AwaitTemplate started");
    if (context.templateDocument) {
      this.needTemplate = false;
      if (debugEnabled > 0) warn("WorkflowState_AwaitTemplate context - template placed", "needTemplate", this.needTemplate, "needItemCard", this.needItemCard, "preItemUseComplete", this.preItemUseComplete);
      if (this.needItemCard) return this.WorkflowState_Suspend;
      if (!this.preItemUseComplete) return this.WorkflowState_Suspend;
      if (this.tempTargetConfirmation) return this.WorkflowState_AoETargetConfirmation;
      return this.WorkflowState_TemplatePlaced;
    }
    if (context.itemUseComplete || !this.needTemplate) {
      if (debugEnabled > 0) warn("WorkflowState_AwaitTemplate context itemUseComplete", "needTemplate", this.needTemplate, "needItemCard", this.needItemCard, "preItemUseComplete", this.preItemUseComplete);
      return this.tempTargetConfirmation ? this.WorkflowState_AoETargetConfirmation : this.WorkflowState_TemplatePlaced;
    }
    if (debugEnabled > 0) warn("WorkflowState_AwaitTemplate suspending", "needTemplate", this.needTemplate, "needItemCard", this.needItemCard, "preItemUseComplete", this.preItemUseComplete);
    return this.WorkflowState_Suspend;
  }
  async WorkflowState_TemplatePlaced(context: any = {}): Promise<WorkflowState> {
    if (configSettings.allowUseMacro && this.options.noOnUseMacro !== true) {
      await this.callMacros(this.item, this.onUseMacros?.getMacros("templatePlaced"), "OnUse", "templatePlaced");
      if (this.ammo) await this.callMacros(this.ammo, this.ammoOnUseMacros?.getMacros("templatePlaced"), "OnUse", "templatePlaced");
    }

    // Some modules stop being able to get the item card id.
    if (!this.itemCardUuid) return this.WorkflowState_AoETargetConfirmation;

    const chatMessage = this.chatCard;
    if (!chatMessage?.content) return this.WorkflowState_AoETargetConfirmation;
    // remove the place template button from the chat card.
    this.targets = validTargetTokens(this.targets);
    this.hitTargets = new Set(this.targets)
    this.hitTargetsEC = new Set();
    let content = chatMessage && foundry.utils.duplicate(chatMessage.content)
    let buttonRe = /<button data-action="placeTemplate">[^<]*<\/button>/
    content = content?.replace(buttonRe, "");
    //@ts-expect-error
    if (game.release.generation > 11) {
      //@ts-expect-error
      await debouncedUpdate(chatMessage, { content, "flags.midi-qol.type": MESSAGETYPES.ITEM, style: CONST.CHAT_MESSAGE_STYLES.OTHER });
    } else {
      await debouncedUpdate(chatMessage, { content, "flags.midi-qol.type": MESSAGETYPES.ITEM, type: CONST.CHAT_MESSAGE_TYPES.OTHER });
    }
    return this.WorkflowState_AoETargetConfirmation;
  }
  async WorkflowState_AoETargetConfirmation(context: any = {}): Promise<WorkflowState> {
    if (this.activity?.target?.affects.type !== "" && this.workflowOptions.targetConfirmation !== "none") {
      if (!await postTemplateConfirmTargets(this.activity, this.workflowOptions, this)) {
        return this.WorkflowState_Abort;
      }
    }
    return this.WorkflowState_ValidateRoll;
  }
  async WorkflowState_ValidateRoll(context: any = {}): Promise<WorkflowState> {
    if (configSettings.allowUseMacro && this.options.noTargetOnusemacro !== true) {
      await this.triggerTargetMacros(["isTargeted"]);
      if (this.aborted) return this.WorkflowState_Abort;
    }

    // do pre roll checks
    if (checkMechanic("checkRange") !== "none" && (!this.AoO || ["rwak", "rsak", "rpak"].includes(this.activity.actionType)) && this.tokenId) {
      const { result, attackingToken, range, longRange } = checkActivityRange(this.activity, canvas?.tokens?.get(this.tokenId) ?? "invalid", this.targets);
      switch (result) {
        case "fail": return this.WorkflowState_RollFinished;
        case "dis": this.disadvantage = true;
          this.attackAdvAttribution.add("DIS:range");
          this.advReminderAttackAdvAttribution.add("DIS:Long Range");
      }
      if (this.attackingToken !== attackingToken) { // changed the attacking token so update the canSee data
        // need to clean this up
        for (let tokenRef of this.targets) {
          const target = getToken(tokenRef);
          this.attackingToken = attackingToken;
          const token = this.attackingToken;
          if (!target) continue;
          const tokenCanSense = token ? canSense(token, target, globalThis.MidiQOL.InvisibleDisadvantageVisionModes) : true;
          const targetCanSense = token ? canSense(target, token, globalThis.MidiQOL.InvisibleDisadvantageVisionModes) : true;
          if (targetCanSense) this.targetsCanSense.add(token);
          else this.targetsCanSense.delete(token);
          if (tokenCanSense) this.tokenCanSense.add(target);
          else this.tokenCanSense.delete(target);
          const tokenCanSee = token ? canSee(token, target) : true;
          const targetCanSee = token ? canSee(target, token) : true;
          if (targetCanSee) this.targetsCanSee.add(token);
          else this.targetsCanSee.delete(token);
          if (tokenCanSee) this.tokenCanSee.add(target);
        }
      }
    }
    if (!this.workflowOptions.allowIncapacitated && checkMechanic("incapacitated") && checkIncapacitated(this.actor, debugEnabled > 0)) return this.WorkflowState_RollFinished
    return this.WorkflowState_PreambleComplete;
  }
  async WorkflowState_PreambleComplete(context: any = {}): Promise<WorkflowState> {
    if (configSettings.undoWorkflow) await saveTargetsUndoData(this);
    this.effectsAlreadyExpired = [];

    if (configSettings.allowUseMacro && this.options.noOnUseMacro !== true) {
      // TODO check if this is called form ammo in the performState
      if (this.ammo) await this.callMacros(this.ammo, this.ammoOnUseMacros?.getMacros("prePreambleComplete"), "OnUse", "prePreambleComplete");
    }

    const tokensToCheck = this.targets.size > 0 ? this.targets : new Set([this.token]);
    for (let token of tokensToCheck) {
      for (let theItem of [this.item, this.ammo]) {
        if (!theItem) continue;
        const activationCondition = foundry.utils.getProperty(theItem, `flags.${MODULE_ID}.itemCondition`);
        if (activationCondition) {
          if (!(await evalActivationCondition(this, activationCondition, token, { async: true }))) {
            ui.notifications?.warn(`midi-qol | Activation condition ${activationCondition} failed roll cancelled`)
            return this.WorkflowState_Cancel;
          }
        }
      }
    }
    if (!getAutoRollAttack(this) && this.activity?.attack) {
      // Not auto rolling so display targets
      const rollMode = game.settings.get("core", "rollMode");
      this.whisperAttackCard = configSettings.autoCheckHit === "whisper" || rollMode === "blindroll" || rollMode === "gmroll";
      if (this.activity.target?.type !== "self") {
        await this.displayTargets(this.whisperAttackCard);
      }
    }
    return this.WorkflowState_WaitForAttackRoll;
  }
  async WorkflowState_WaitForAttackRoll(context: any = {}): Promise<WorkflowState> {
    if (context.attackRoll) {
      // received an attack roll so advance the state
      // Record the data? (currently done in itemhandling)
      return this.WorkflowState_AttackRollComplete;
    }
    if (this.item.type === "tool") {
      const abilityId = this.item?.abilityMod;
      if (procAutoFail(this.actor, "check", abilityId)) this.rollOptions.parts = ["-100"];
      //TODO Check this
      let procOptions = await procAbilityAdvantage(this.actor, "check", abilityId, this.rollOptions);
      this.advantage = procOptions.advantage;
      this.disadvantage = procOptions.disadvantage;

      if (autoFastForwardAbilityRolls) {
        const options: any = foundry.utils.mergeObject(procOptions, { critical: this.item.criticalThreshold ?? 20, fumble: 1 });
        delete options.event;
        const result = await this.item.rollToolCheck(options); // TODO come back and make this compatible with v4
        this.toolRoll = result;
        return this.WorkflowState_WaitForDamageRoll;
      }
    }
    if (!this.activity.attack) {
      this.hitTargets = new Set(this.targets);
      this.hitTargetsEC = new Set();
      return this.WorkflowState_WaitForDamageRoll;
    }

    if (this.noAutoAttack) return this.WorkflowState_Suspend;
    this.autoRollAttack = this.rollOptions.advantage || this.rollOptions.disadvantage || this.rollOptions.autoRollAttack;
    const isFastRoll = this.rollOptions.fastForwardAttack ?? isAutoFastAttack(this);
    if (!this.autoRollAttack) {
      // Not auto rolling attack so setup the buttons to display advantage/disadvantage
      const chatMessage = this.chatCard;
      let content = chatMessage?.content && foundry.utils.duplicate(chatMessage.content)
      if (content && (!this.autoRollAttack || !isFastRoll)) {
        // provide a hint as to the type of roll expected.
        let content = chatMessage && foundry.utils.duplicate(chatMessage.content)
        let searchRe = /<button data-action="attack">[^<]+<\/button>/;
        searchRe = /<div class="midi-attack-buttons".*<\/div>/;

        const hasAdvantage = this.advantage && !this.disadvantage;
        const hasDisadvantage = this.disadvantage && !this.advantage;
        let attackString = hasAdvantage ? i18n(`${this.systemString}.Advantage`) : hasDisadvantage ? i18n(`${this.systemString}.Disadvantage`) : i18n(`${this.systemString}.Attack`)
        if (isFastRoll && configSettings.showFastForward) attackString += ` ${i18n("midi-qol.fastForward")}`;
        let replaceString = `<button data-action="attack">${attackString}</button>`
        content = content.replace(searchRe, replaceString);
        await debouncedUpdate(chatMessage, { content });
      } else if (!chatMessage) {
        const message = `WaitForAttackRoll | no chat message`;
        error(message);
        TroubleShooter.recordError(new Error(message), message);
      }
    }

    if (configSettings.allowUseMacro && this.options.noOnUseMacro !== true) {
      await this.callMacros(this.item, this.onUseMacros?.getMacros("preAttackRoll"), "OnUse", "preAttackRoll");
      if (this.ammo) await this.callMacros(this.ammo, this.ammoOnUseMacros?.getMacros("preAttackRoll"), "OnUse", "preAttackRoll");
    }
    if (this.autoRollAttack) {
      this.rollOptions.fastForwardAttack ||= isFastRoll;
      // REFACTOR -await
      const rolls = await this.activity.rollAttack({event: this.event,  midiOptions: this.rollOptions }, {}, {});
      if (!rolls || this.abort) return this.WorkflowState_Abort;
      return this.WorkflowState_AttackRollComplete;
    }
    return this.WorkflowState_Suspend;
  }

  async WorkflowState_AttackRollComplete(context: any = {}): Promise<WorkflowState> {
    const attackRollCompleteStartTime = Date.now();
    const attackBonusMacro = foundry.utils.getProperty(this.actor.flags, `${game.system.id}.AttackBonusMacro`);
    if (configSettings.allowUseMacro && attackBonusMacro && this.options.noOnUseMacro !== true) {
      // dnd3 await this.rollAttackBonus(attackBonusMacro);
    }
    if (configSettings.allowUseMacro && this.options.noTargetOnusemacro !== true) await this.triggerTargetMacros(["isAttacked"]);
    await this.processAttackRoll();
    // REFACTOR look at splitting this into a couple of states
    await asyncHooksCallAll("midi-qol.preCheckHits", this);
    if (this.item) await asyncHooksCallAll(`midi-qol.preCheckHits.${this.item.uuid}`, this);
    if (this.activity) await asyncHooksCallAll(`midi-qol.preCheckHits.${this.activity.uuid}`, this);
    if (this.aborted) return this.WorkflowState_Abort;

    if (configSettings.allowUseMacro && this.options.noOnUseMacro !== true) {
      await this.callMacros(this.item, this.onUseMacros?.getMacros("preCheckHits"), "OnUse", "preCheckHits");
      if (this.ammo) await this.callMacros(this.ammo, this.ammoOnUseMacros?.getMacros("preCheckHits"), "OnUse", "preCheckHits");
    }

    await this.processAttackRoll();
    this.needsAttackAdvantageCheck = true;

    if (configSettings.autoCheckHit !== "none") {
      await this.displayAttackRoll({ GMOnlyAttackRoll: true });
      await this.checkHits();
      await this.displayAttackRoll();

      const rollMode = game.settings.get("core", "rollMode");
      this.whisperAttackCard = configSettings.autoCheckHit === "whisper" || rollMode === "blindroll" || rollMode === "gmroll";
      await asyncHooksCallAll("midi-qol.hitsChecked", this);
      if (this.item)
        await asyncHooksCallAll(`midi-qol.hitsChecked.${this.item?.uuid}`, this);
      if (this.activity) 
        await asyncHooksCallAll(`midi-qol.hitsChecked.${this.activity?.uuid}`, this);
      if (this.aborted)
        return this.WorkflowState_Abort;
      await this.displayHits(this.whisperAttackCard);
    } else {
      await this.displayAttackRoll();
    }
    if (checkRule("removeHiddenInvis")) await removeHidden.bind(this)();
    if (checkRule("removeHiddenInvis")) await removeInvisible.bind(this)();
    /*
    const attackExpiries = [
      "isAttacked"
    ];
    await this.expireTargetEffects(attackExpiries);
    */

    await asyncHooksCallAll("midi-qol.AttackRollComplete", this);
    if (this.item) await asyncHooksCallAll(`midi-qol.AttackRollComplete.${this.id}`, this);
    if (this.aborted) return this.WorkflowState_Abort;

    if (configSettings.allowUseMacro && this.options.noOnUseMacro !== true) {
      await this.callMacros(this.item, this.onUseMacros?.getMacros("postAttackRoll"), "OnUse", "postAttackRoll");
      if (this.ammo) await this.callMacros(this.ammo, this.ammoOnUseMacros?.getMacros("postAttackRoll"), "OnUse", "postAttackRoll");
      if (this.aborted) return this.WorkflowState_Abort;
    }

    if (configSettings.autoCheckHit === "none") {
      this.hitTargets = new Set();
      this.hitTargetsEC = new Set();
      return this.WorkflowState_WaitForDamageRoll;
    }
    if (getAutoRollDamage(this) === "always") return this.WorkflowState_WaitForDamageRoll;
    const noHits = this.hitTargets.size === 0 && this.hitTargetsEC.size === 0;
    const allMissed = noHits && this.targets.size !== 0;
    if (allMissed) {
      if (configSettings.confirmAttackDamage !== "none" && !this.workflowOptions.forceCompletion)
        return this.WorkflowState_ConfirmRoll;
      if (this.workflowOptions.forceCompletion) {
        expireMyEffects.bind(this)(["1Attack", "1Action", "1Spell"])
        await this.expireTargetEffects(["isAttacked"]);
        return this.WorkflowState_RollFinished;
      }
      // if (configSettings.autoRollDamage !== "always") return this.WorkflowState_RollFinished;
      // else return this.WorkflowState_WaitForDamageRoll;
    }
    if (debugCallTiming) log(`AttackRollComplete elapsed ${Date.now() - attackRollCompleteStartTime}ms`)

    return this.WorkflowState_WaitForDamageRoll;
  }

  _formatAttackTargets() {
    const targets = new Map();
    for (const token of this.targets) {
      const { name } = token;
      //@ts-expect-error
      const { img, system, uuid } = token.actor ?? {};
      const ac = system?.attributes?.ac ?? {};
      if (uuid && Number.isNumeric(ac.value)) targets.set(uuid, { name, img, uuid, ac: ac.value });
    }
    return Array.from(targets.values());
  }

  async WorkflowState_WaitForDamageRoll(context: any = {}): Promise<WorkflowState> {
    if (context.damageRoll || context.otherDamageRoll) {
      // record the data - currently done in item handling
      return this.WorkflowState_ConfirmRoll;
    }
    const hasDamageRoll = this.activity.hasDamage || this.otherActivity?.hasDamage || this.activity.hasHealing || this.otherActivity?.hasHealing;
    if (!hasDamageRoll) return this.WorkflowState_WaitForSaves;
    if (context.attackRoll) return this.WorkflowState_AttackRollComplete;
    if (debugEnabled > 1) debug(`wait for damage roll has damage roll ${hasDamageRoll} isfumble ${this.isFumble} no auto damage ${this.noAutoDamage}`);

    if (checkMechanic("actionSpecialDurationImmediate"))
      expireMyEffects.bind(this)(["1Attack", "1Action", "1Spell"]);
    if (checkMechanic("actionSpecialDurationImmediate") && this.hitTargets.size)
      expireMyEffects.bind(this)(["1Hit"]);

    if (configSettings.allowUseMacro && this.options.noOnUseMacro !== true) {
      await this.callMacros(this.item, this.onUseMacros?.getMacros("preDamageRoll"), "OnUse", "preDamageRoll");
      if (this.ammo) await this.callMacros(this.ammo, this.ammoOnUseMacros?.getMacros("preDamageRoll"), "OnUse", "preDamageRoll");
    }

    // if (this.noAutoDamage) return; // we are emulating the standard card specially.

    if (this.shouldRollDamage) {
      if (debugEnabled > 0) warn("waitForDamageRoll | rolling damage ", this.event, configSettings.autoRollAttack, configSettings.autoFastForward)
      const storedData: any = this.chatCard?.getFlag(game.system.id, "item.data");
      if (storedData) { // If magic items is being used it fiddles the roll to include the item data
        this.item = new CONFIG.Item.documentClass(storedData, { parent: this.actor })
      }

      this.rollOptions.spellLevel = this.spellLevel;
      this.rollOptions.isCritical = this.isCritical;
      this.rollOptions.isFumble = this.isFumble;
      this.rollOptions.fastForwardDamage = isAutoFastDamage(this);
      this.activity.rollDamage({ midiOptions: this.rollOptions }, {}, { create: false });
      return this.WorkflowState_Suspend;
    } else {
      const chatMessage = this.chatCard;
      if (chatMessage?.content) {
        // provide a hint as to the type of roll expected.
        let content = chatMessage && foundry.utils.duplicate(chatMessage.content)
        let searchRe = /<button data-action="damage">[^<]+<\/button>/;
        const damageTypeString = (this.activity.actionType === "heal") ? i18n(`${this.systemString}.Healing`) : i18n(`${this.systemString}.Damage`);
        let damageString = (this.rollOptions.critical || this.isCritical) ? i18n(`${this.systemString}.Critical`) : damageTypeString;
        if (this.rollOptions.fastForwardDamage && configSettings.showFastForward) damageString += ` ${i18n("midi-qol.fastForward")}`;
        let replaceString = `<button data-action="damage">${damageString}</button>`
        content = content.replace(searchRe, replaceString);
        searchRe = /<button data-action="versatile">[^<]+<\/button>/;
        damageString = i18n(`${this.systemString}.Versatile`)
        if (this.rollOptions.fastForwardDamage && configSettings.showFastForward) damageString += ` ${i18n("midi-qol.fastForward")}`;
        replaceString = `<button data-action="versatile">${damageString}</button>`
        content = content.replace(searchRe, replaceString);
        await debouncedUpdate(chatMessage, { content });
      }
    }
    return this.WorkflowState_Suspend; // wait for a damage roll to advance the state.
  }
  async WorkflowState_ConfirmRoll(context: any = {}): Promise<WorkflowState> {
    if (context.attackRoll) return this.WorkflowState_AttackRollComplete;
    if (configSettings.confirmAttackDamage !== "none" && (this.activity.attack || this.activity.damage)) {
      await this.displayDamageRolls();
      return this.WorkflowState_Suspend; // wait for the confirm button
    }
    return this.WorkflowState_DamageRollStarted;
  }
  async WorkflowState_RollConfirmed(context: any = {}): Promise<WorkflowState> {
    expireMyEffects.bind(this)(["1Attack", "1Action", "1Spell"])
    await this.expireTargetEffects(["isAttacked"]);
    return this.WorkflowState_DamageRollStarted;
  }
  async WorkflowState_DamageRollStarted(context: any = {}): Promise<WorkflowState> {
    if (this.itemCardUuid) {
      await Workflow.removeItemCardAttackDamageButtons(this.itemCardUuid, getRemoveAttackButtons(this.item), getRemoveDamageButtons(this.item));
      await Workflow.removeItemCardConfirmRollButton(this.itemCardUuid);
    }
    if (getActivityAutoTarget(this.activity) === "none" && activityHasAreaTarget(this.activity) && !this.activity.attack) {
      // we are not auto targeting so for area effect attacks, without hits (e.g. fireball)
      this.targets = validTargetTokens(game.user?.targets);
      this.hitTargets = validTargetTokens(game.user?.targets);
      this.hitTargetsEC = new Set();
      if (debugEnabled > 0) warn("damageRollStarted | for non auto target area effects spells", this)
    }
    const damageBonusMacros = this.getDamageBonusMacros();
    if (damageBonusMacros) { //  && this.workflowType === "Workflow") { // TODO check this
      await this.rollBonusDamage(damageBonusMacros);
    }
    return this.WorkflowState_DamageRollComplete;
  }
  async WorkflowState_DamageRollComplete(context: any = {}): Promise<WorkflowState> {
    // This is now called because of the state name
    /*    await asyncHooksCallAll("midi-qol.preDamageRollComplete", this)
        if (this.item) await asyncHooksCallAll(`midi-qol.preDamageRollComplete.${this.item.uuid}`, this);
        if (this.aborted) this.abort;
        */

    if (configSettings.allowUseMacro && this.options.noOnUseMacro !== true) { //
      await this.callMacros(this.item, this.onUseMacros?.getMacros("postDamageRoll"), "OnUse", "postDamageRoll");
      if (this.ammo) await this.callMacros(this.ammo, this.ammoOnUseMacros?.getMacros("postDamageRoll"), "OnUse", "postDamageRoll");
    }

    if (this.damageRolls)
      this.rawDamageDetail = createDamageDetailV4({ roll: this.damageRolls, activity: this.activity, defaultType: this.defaultDamageType });
    else this.rawDamageDetail = [];
    if (this.otherDamageRolls) {
      this.rawOtherDamageDetail = createDamageDetailV4({ roll: this.otherDamageRolls, activity: null, defaultType: this.defaultDamageType });
    } else this.rawOtherDamageDetail = [];
    if (this.bonusDamageRolls)
      this.rawBonusDamageDetail = createDamageDetailV4({ roll: this.bonusDamageRolls, activity: null, defaultType: this.defaultDamageType });
    else this.rawBonusDamageDetail = [];
    await asyncHooksCallAll("midi-qol.DamageRollComplete", this);
    if (this.item) await asyncHooksCallAll(`midi-qol.DamageRollComplete.${this.item.uuid}`, this);
    if (this.aborted) return this.WorkflowState_Abort;
    if (this.hitTargets?.size || this.hitTtargetsEC?.size) expireMyEffects.bind(this)(["1Hit"]);
    expireMyEffects.bind(this)(["1Action", "1Attack", "1Spell"]);
    await this.expireTargetEffects(["isAttacked"]);
    await this.displayDamageRolls();
    if (this.isFumble) {
      this.failedSaves = new Set();
      this.hitTargetss = new Set();
      this.hitTargetsEC = new Set();
      return this.WorkflowState_ApplyDynamicEffects;
    }

    return this.WorkflowState_WaitForSaves;
  }
  async WorkflowState_DamageRollCompleteCancelled(context: any = {}): Promise<WorkflowState> {
    if (configSettings.undoWorkflow) {

    }
    return this.WorkflowState_Suspend;
  }
  async WorkflowState_WaitForSaves(context: any = {}): Promise<WorkflowState> {
    this.initSaveResults();
    // TODO remove this afet CPR change
    if (this.damageRolls) this.rawDamageDetail = createDamageDetailV4({ roll: this.damageRolls, activity: this.activity, defaultType: this.defaultDamageType });
    if (configSettings.allowUseMacro) {
      if (this.options.noOnUseMacro !== true) await this.callMacros(this.item, this.onUseMacros?.getMacros("preSave"), "OnUse", "preSave");
      if (this.options.noTargetOnusemacro !== true) await this.triggerTargetMacros(["isAboutToSave"]); // ??
      if (this.ammo && this.options.noOnUseMacro !== true) await this.callMacros(this.ammo, this.ammoOnUseMacros?.getMacros("preSave"), "OnUse", "preSave");
    }
    if (this.workflowType === "BaseWorkflow" && !this.options.ignoreUserTargets && !this.activity?.attack && this.activity?.target?.affects.type !== "self") { // Allow editing of targets if there is no attack that has already been processed.
      this.targets = new Set(game.user?.targets);
      this.hitTargets = new Set(this.targets);
    }
    this.failedSaves = new Set(this.hitTargets);
    if (!this.hasSave) {
      return this.WorkflowState_SavesComplete;
    }
    if (configSettings.autoCheckSaves !== "none") {
      await asyncHooksCallAll("midi-qol.preCheckSaves", this);
      if (this.item) await asyncHooksCallAll(`midi-qol.preCheckSaves.${this.item?.uuid}`, this);
      if (this.aborted) return this.WorkflowState_Abort;
      //@ts-expect-error .events not defined
      if (debugEnabled > 1) debug("Check Saves: renderChat message hooks length ", Hooks.events["renderChatMessage"]?.length)
      // setup to process saving throws as generated
      let hookId = Hooks.on("renderChatMessage", this.processSaveRoll.bind(this));
      // let brHookId = Hooks.on("renderChatMessage", this.processBetterRollsChatCard.bind(this));
      let monksId = Hooks.on("updateChatMessage", this.monksSavingCheck.bind(this));
      try {
        await this.checkSaves(configSettings.autoCheckSaves !== "allShow");
      } catch (err) {
        const message = ("midi-qol | checkSaves error")
        TroubleShooter.recordError(err, message);
        error(message, err)
      } finally {
        Hooks.off("renderChatMessage", hookId);
        // Hooks.off("renderChatMessage", brHookId);
        Hooks.off("updateChatMessage", monksId);
      }
      if (debugEnabled > 1) debug("Check Saves: ", this.saveRequests, this.saveTimeouts, this.saves);
      //@ts-expect-error .events not defined
      if (debugEnabled > 1) debug("Check Saves: renderChat message hooks length ", Hooks.events["renderChatMessage"]?.length)
      await asyncHooksCallAll("midi-qol.postCheckSaves", this);
      if (this.item) await asyncHooksCallAll(`midi-qol.postCheckSaves.${this.item?.uuid}`, this);
      if (this.aborted) return this.WorkflowState_Abort;
      await this.displaySaves(configSettings.autoCheckSaves === "whisper");
    } else {// has saves but we are not checking so do nothing with the damage
      await this.expireTargetEffects(["isAttacked"])
      this.effectTargets = this.failedSaves;
      return this.WorkflowState_RollFinished;
    }
    return this.WorkflowState_SavesComplete;
  }
  async WorkflowState_SavesComplete(context: any = {}): Promise<WorkflowState> {
    expireMyEffects.bind(this)(["1Action", "1Spell"]);
    if (configSettings.allowUseMacro && this.options.noOnUseMacro !== true) {
      await this.callMacros(this.item, this.onUseMacros?.getMacros("postSave"), "OnUse", "postSave");
      await this.callMacros(this.ammo, this.onUseMacros?.getMacros("postSave"), "OnUse", "postSave");
    }

    return this.WorkflowState_AllRollsComplete;
  }
  async WorkflowState_AllRollsComplete(context: any = {}): Promise<WorkflowState> {
    // Stop gap to always roll utility formula - need to insert this into the workflow properly
    if (this.activity?.roll?.formula) {
      await this.activity.rollFormula({ midiOptions: {...this.rollOptions, fastForward: isAutoFastDamage(this) }}, {}, { create: true });
    }
    this.otherDamageMatches = new Set();
    let items: any[] = [];

    for (let token of this.targets) {
      const otherCondition = this.otherUseCondition;
      const ammoCondition = foundry.utils.getProperty(this.ammo, `flags.${MODULE_ID}.otherCondition`);
      if (otherCondition) {
        if (await evalActivationCondition(this, otherCondition, token, { async: true, errorReturn: false }))
          this.otherDamageMatches.add(token);
      }
      else if (ammoCondition) { // TODO work out what this means with activities
        if (await evalActivationCondition(this, ammoCondition, token, { async: true, errorReturn: false }))
          this.otherDamageMatches.add(token);
      }
      else {
        this.otherDamageMatches.add(token);
      }
    }

    if (this.rawDamageDetail?.length || this.rawOtherDamageDetail?.length) await processDamageRoll(this, this.rawDamageDetail[0]?.type ?? this.defaultDamageType)
    // If a damage card is going to be created don't call the isDamaged macro - wait for the damage card calculations to do a better job
    if (configSettings.allowUseMacro && this.options.noTargetOnusemacro !== true && !configSettings.autoApplyDamage.includes("Card"))
      await this.triggerTargetMacros(["isDamaged"], this.hitTargets);
    if (debugEnabled > 1) debug("all rolls complete ", foundry.utils.duplicate(this.rawDamageDetail));
    return this.WorkflowState_ApplyDynamicEffects;
  }

  async WorkflowState_ApplyDynamicEffects(context: any = {}): Promise<WorkflowState> {
    const applyDynamicEffectsStartTime = Date.now();

    this.activationMatches = new Set();
    this.otherActivationMatches = new Set();
    this.activationFails = new Set();
    this.otherActivationFails = new Set();

    for (let token of this.targets) {
      const effectCondition = this.effectActivationCondition;
      const otherEffectCondition = this.otherEffectActivationCondition
      if (effectCondition) {
        if (await evalActivationCondition(this, effectCondition, token, { async: true, errorReturn: true })) {
          this.activationMatches.add(token);
        } else
          this.activationFails.add(token);
      } else this.activationMatches.add(token)

      if (otherEffectCondition) {
        if (await evalActivationCondition(this, otherEffectCondition, token, { async: true, errorReturn: true })) {
          this.otherActivationMatches.add(token);
        } else
          this.otherActivationFails.add(token);
      } else this.otherActivationMatches.add(token)
    }
    expireMyEffects.bind(this)(["1Action", "1Spell"]);

    this.effectTargets = new Set();
    this.otherEffectTargets = new Set();
    if (this.forceApplyEffects) {
      // Assume this.effectTargets is already set
    } else if (this.activity.save && this.activity.attack) {
      this.effectTargets = new Set([...this.hitTargets, ...this.hitTargetsEC]);
      // check saves when selecting the effects to apply - deal with always apply effects
      // this.effectTargets = new Set([...this.effectTargets].filter(t => this.failedSaves.has(t)));
    } else if (this.activity.save) this.effectTargets = this.failedSaves;
    else if (this.activity.attack) {
      this.effectTargets = new Set([...this.hitTargets, ...this.hitTargetsEC]);
    } else
      this.effectTargets = this.targets;
    this.effectTargets = this.effectTargets.filter(t => this.activationMatches.has(t));

    if (this.forceApplyEffects) {
      // Assume this.otherEffectTargets is already set
    } else if ((this.otherActivity?.save || this.otherActivity?.check) && this.activity.attack) {
      this.otherEffectTargets = new Set([...this.hitTargets, ...this.hitTargetsEC]);
      // check saves when selecting the effects to apply - deal with always apply effects
      // this.otherEffectTargets = new Set([...this.otherEffectTargets].filter(t => this.failedSaves.has(t)));
    } else if (this.otherActivity?.save || this.otherActivity?.check) this.otherEffectTargets = this.failedSaves;
    else if (this.activity.attack) {
      this.otherEffectTargets = new Set([...this.hitTargets, ...this.hitTargetsEC]);
    } else
      this.otherEffectTargets = this.targets;
    this.otherEffectTargets = this.otherEffectTargets.filter(t => this.otherActivationMatches.has(t));
    let anyActivationTrue = this.effectTargets.size > 0 || this.otherEffectTargets.size > 0;
    // Do special expiries
    const specialExpiries = [
      "isAttacked",
      "isDamaged",
      "isHealed",
      "isSaveSuccess",
      "isSaveFailure",
      "isSave",
      "isHit"
    ];
    await this.expireTargetEffects(specialExpiries);

    if (configSettings.autoItemEffects === "off" && !this.forceApplyEffects) return this.WorkflowState_RollFinished; // TODO see if there is a better way to do this.

    // TODO look at macros being per activity rather than per item
    if (this.activity.item) {
      if (configSettings.allowUseMacro && this.options.noOnUseMacro !== true) {
        const results: any = await this.callMacros(this.activity.item, this.onUseMacros?.getMacros("preActiveEffects"), "OnUse", "preActiveEffects");
        // Special check for return of {haltEffectsApplication: true} from item macro
        if (results.some(r => r?.haltEffectsApplication))
          return this.WorkflowState_RollFinished;
      }
    }

    // no item, not auto effects or not module skip
    let useCE = configSettings.autoCEEffects;
    if (!this.activity.item) return this.WorkflowState_RollFinished;
    const midiFlags = this.item.flags[MODULE_ID];
    if (midiFlags?.forceCEOff && ["both", "cepri", "itempri"].includes(useCE)) useCE = "none";
    else if (midiFlags?.forceCEOn && ["none", "itempri"].includes(useCE)) useCE = "cepri";
    const hasCE = installedModules.get("dfreds-convenient-effects")
    let ceEffect = getCEEffectByName(this.activity.name);
    if (!ceEffect) ceEffect = getCEEffectByName(this.activity.item.name);

    const activityEffects = (this.activity.applicableEffects ?? []).filter(ef => !ef.transfer);
    const otherActivityEffects = (this.otherActivity?.applicableEffects ?? []).filter(ef => !ef.transfer);
    const ceTargetEffect = ceEffect && !(ceEffect?.flags?.dae?.selfTarget || ceEffect?.flags?.dae?.selfTargetAlways);
    const ceSelfEffect = ceEffect && (ceEffect?.flags?.dae?.selfTarget || ceEffect?.flags?.dae?.selfTargetAlways);
    const hasActivityEffects = hasDAE(this) && activityEffects.length > 0;
    const hasOtherActivityEffects = hasDAE(this) && otherActivityEffects.length > 0;
    const activitySelfEffects = activityEffects.filter(ef => ef.flags?.dae?.selfTarget && !ef.transfer) ?? [];
    const activitySelfAllEffect = activityEffects.filter(ef => ef.flags?.dae?.selfTarget || ef.flags?.dae?.selfTargetAlways) ?? [];
    const otherActivitySelfEffects = otherActivityEffects.filter(ef => ef.flags?.dae?.selfTarget) ?? [];
    const otherActivitySelfAllEffects = otherActivityEffects.filter(ef => ef.flags?.dae?.selfTarget || ef.flags?.dae?.selfTargetAlways) ?? [];

    let selfEffectsToApply = "none";
    const metaData = {
      "flags": {
        "dae": { transfer: false },
        "midi-qol": {
          castData: this.castData
        }
      }
    };
    const macroData = this.getMacroData();
    let origin = this.item.uuid;
    if (this.chatCard.getFlag("dnd5e", "use.concentrationId")) {
      origin = this.actor.effects.get(this.chatCard.getFlag("dnd5e", "use.concentrationId"))?.uuid ?? this.item.uuid;
    }
    let damageComponents = {};
    let damageListItem;
    let hpDamage;
    let totalDamage;
    for (let token of this.targets) {

      const tokenDamages = this.damageList?.find(di => di.targetUuid === getTokenDocument(token)?.uuid);
      if (tokenDamages) {
        totalDamage = tokenDamages.totalDamage;
        hpDamage = tokenDamages.hpDamage;
        damageComponents = [tokenDamages.damageDetails["combinedDamage"], configSettings.singleConcentrationRoll ? [] : (tokenDamages.damageDetails["otherDamage"] ?? [])]
          .reduce((summary, damages) => {
            let damagesSummary = damages.reduce((damageComponents, damageEntry) => {
              damageComponents[damageEntry.type] = damageEntry.value + (damageComponents[damageEntry.type] ?? 0);
              return damageComponents;
            }, {});
            Object.keys(damagesSummary).forEach(key => {
              summary[key] = damagesSummary[key] + (summary[key] ?? 0);
            });
            return summary;
          }, {});
      }

      // Check for activity effects or ce effects
      if (this.forceApplyEffects || this.effectTargets.has(token)) {
        if (hasActivityEffects && (!ceTargetEffect || ["none", "both", "itempri"].includes(useCE))) {
          let selectedEffects = activityEffects;
          if (!this.forceApplyEffects) {
            selectedEffects = activityEffects.filter(ef =>
              this.effectTargets.has(token) && (
                !(this.activity?.save || this.activity.check)
                || this.failedSaves.has(token)
                || this.activity?.effects.some(effectDetail => effectDetail.onSave == true && effectDetail._id === ef.id)
              )
            );
          }
          const effectsToApplyUuids = selectedEffects.map(ef => ef.uuid);
          await globalThis.DAE.doActivityEffects(this.activity, true, [token], effectsToApplyUuids, {
            damageTotal: totalDamage,
            critical: this.isCritical,
            fumble: this.isFumble,
            itemCardId: this.itemCardId,
            itemCardUuid: this.itemCardUuid,
            metaData,
            origin: origin.uuid,
            selfEffects: "none",
            spellLevel: this.spellLevel,
            toggleEffect: this.item?.flags.midiProperties?.toggleEffect,
            tokenId: this.tokenId,
            tokenUuid: this.tokenUuid,
            actorUuid: this.actor.uuid,
            whisper: false,
            workflowOptions: this.workflowOptions,
            context: {
              damageComponents,
              damageApplied: hpDamage,
              damage: totalDamage,  // this is curently ignored see damageTotal above
              otherDamage: this.otherDamageTotal ?? 0,
              bonusDamage: this.bonusDamageTotal ?? 0,
              itemData: this.item.toObject()

            }
          })
        }
        if (ceTargetEffect && this.activity.item && token.actor) {
          if (ceEffect && ["both", "cepri"].includes(useCE) || (useCE === "itempri" && !hasActivityEffects)) {
            const targetHasEffect = token.actor.effects.find(ef => ef.name === ceEffect.name);
            if (this.item?.flags.midiProperties?.toggleEffect && targetHasEffect) {
              await CEToggleEffect({ effectName: ceEffect.name, uuid: token.actor.uuid, origin });
            } else {
              // Check stacking status
              let removeExisting = (["none", "noneName"].includes(ceEffect.flags?.dae?.stackable ?? "none"));
              const hasExisting = await CEHasEffectApplied({ effectName: ceEffect.name, uuid: token.actor.uuid })
              if (removeExisting && hasExisting) {
                await CERemoveEffect({ effectName: ceEffect.name, uuid: token.actor.uuid, origin });
                //@ ts-expect-error game.dfreds
                // wait game.dfreds.effectInterface?.removeEffect({ effectName: theItem.name, uuid: token.actor.uuid, origin, metadata: macroData });
              }
              const effectData = foundry.utils.mergeObject(ceEffect.toObject(), metaData);
              if (isInCombat(token.actor) && effectData.duration.seconds <= 60) {
                effectData.duration.rounds = effectData.duration.rounds ?? Math.ceil(effectData.duration.seconds / CONFIG.time.roundTime);
                delete effectData.duration.seconds;
              }
              effectData.origin = origin;
              const effects = await CEAddEffectWith({ effectData, effectName: ceEffect.name, uuid: token.actor.uuid, origin, overlay: false });
              //@ ts-expect-error game.dfreds
              // const effects = await game.dfreds?.effectInterface?.addEffectWith({ effectData, uuid: token.actor.uuid, origin, metadata: macroData });
              if (this.chatCard.getFlag("dnd5e", "use.concentrationId")) {
                const originItem = this.actor.effects.get(this.chatCard.getFlag("dnd5e", "use.concentrationId"));
                if (!effects) {
                  //@ts-expect-error
                  for (let effect of token.actor.effects.filter(ef => ef.origin === originItem.uuid)) {
                    if (!(originItem.getFlag("dnd5e", "dependents") ?? []).some(d => d.uuid === effect.uuid))
                      originItem.addDependent(effect);
                  }
                } else for (let effect of effects) {
                  if (effect instanceof ActiveEffect && originItem instanceof ActiveEffect) {
                    //@ts-expect-error
                    await originItem.addDependent(effect);
                  }
                }
              }
            }
          }
        }
      }
      if (this.forceApplyEffects || this.otherEffectTargets.has(token)) {
        if (hasOtherActivityEffects) {
          let selectedEffects = otherActivityEffects;
          if (!this.forceApplyEffects) {
            selectedEffects = otherActivityEffects.filter(ef =>
              this.otherActivationMatches.has(token) && this.otherEffectTargets.has(token) && (
                !(this.otherActivity?.save || this.otherActivity?.check)
                || this.failedSaves.has(token)
                || this.otherActivity?.effects.some(effectDetail => effectDetail.onSave == true && effectDetail._id === ef.id)
              )
            );
          }
          const effectsToApplyUuids = selectedEffects.map(ef => ef.uuid);
          await globalThis.DAE.doActivityEffects(this.otherActivity, true, [token], effectsToApplyUuids, {
            damageTotal: totalDamage,
            critical: this.isCritical,
            fumble: this.isFumble,
            itemCardId: this.itemCardId,
            itemCardUuid: this.itemCardUuid,
            metaData,
            origin,
            spellLevel: this.spellLevel,
            toggleEffect: this.item?.flags.midiProperties?.toggleEffect,
            tokenId: this.tokenId,
            tokenUuid: this.tokenUuid,
            actorUuid: this.actor.uuid,
            whisper: false,
            workflowOptions: this.workflowOptions,
            context: {
              damageComponents,
              damageApplied: hpDamage,
              damage: totalDamage,  // this is curently ignored see damageTotal above
              otherDamage: this.otherDamageTotal ?? 0,
              bonusDamage: this.bonusDamageTotal ?? 0,
              itemData: this.otherActivity.item.toObject()
            }
          })
        }
      }
    }
    // Perhaps this should use this.effectTargets
    if (configSettings.allowUseMacro && this.options.noTargetOnusemacro !== true) await this.triggerTargetMacros(["postTargetEffectApplication"], this.targets);

    //Now do self effects
    let selfEffects: any[] = [];
    if (this.effectTargets.size > 0) selfEffects = activitySelfAllEffect;
    else selfEffects = activitySelfEffects;

    const selfToken = tokenForActor(this.actor);
    if (selfEffects.length > 0 && selfToken) {
      await globalThis.DAE.doActivityEffects(this.activity, true, [selfToken], selfEffects.map(ef => ef.uuid), {
        damageTotal: totalDamage,
        critical: this.isCritical,
        fumble: this.isFumble,
        itemCardId: this.itemCardId,
        itemCardUuid: this.itemCardUuid,
        metaData,
        origin,
        spellLevel: this.spellLevel,
        toggleEffect: this.item?.flags.midiProperties?.toggleEffect,
        tokenId: this.tokenId,
        tokenUuid: this.tokenUuid,
        actorUuid: this.actor.uuid,
        whisper: false,
        workflowOptions: this.workflowOptions,
        context: {
          damageComponents,
          damageApplied: hpDamage,
          damage: totalDamage,  // this is curently ignored see damageTotal above
          otherDamage: this.otherDamageTotal ?? 0,
          bonusDamage: this.bonusDamageTotal ?? 0,
          itemData: this.item.toObject()
        }
      })

    }

    let otherSelfEffects: any[] = [];
    if (this.otherEffectTargets.size > 0) otherSelfEffects = otherActivitySelfAllEffects;
    else otherSelfEffects = otherActivitySelfEffects;

    if (otherSelfEffects.length > 0 && selfToken) {
      await globalThis.DAE.doActivityEffects(this.activity, true, [selfToken], otherSelfEffects.map(ef => ef.uuid), {
        damageTotal: totalDamage,
        critical: this.isCritical,
        fumble: this.isFumble,
        itemCardId: this.itemCardId,
        itemCardUuid: this.itemCardUuid,
        metaData,
        origin,
        spellLevel: this.spellLevel,
        toggleEffect: this.item?.flags.midiProperties?.toggleEffect,
        tokenId: this.tokenId,
        tokenUuid: this.tokenUuid,
        actorUuid: this.actor.uuid,
        whisper: false,
        workflowOptions: this.workflowOptions,
        context: {
          damageComponents,
          damageApplied: hpDamage,
          damage: totalDamage,  // this is curently ignored see damageTotal above
          otherDamage: this.otherDamageTotal ?? 0,
          bonusDamage: this.bonusDamageTotal ?? 0,
          itemData: this.otherActivity.item.toObject()
        }
      })

    }

    if (ceSelfEffect && (this.effectTargets.size > 0 || ceSelfEffect.flags?.dae?.selfTargetAlways)) {
      if (["both", "cepri"].includes(useCE) || (useCE === "itempri" && !selfEffects.length)) {
        const actorHasEffect = this.actor.effects.find(ef => ef.name === this.activity.name);
        if (this.item?.flags.midiProperties?.toggleEffect && actorHasEffect) {
          CEToggleEffect({ effectName: this.activity.name, uuid: this.actor.uuid, origin });
          //@ ts-expect-error game.dfreds
          // await game.dfreds?.effectInterface?.toggleEffect(theItem.name, { uuid: this.actor.uuid, origin, metadata: macroData });
        } else {
          // Check stacking status
          //@ ts-expect-error
          // if ((ceSelfEffectToApply.flags?.dae?.stackable ?? "none") === "none" && game.dfreds.effectInterface?.hasEffectApplied(theItem.name, this.actor.uuid)) {
          if ((ceSelfEffect.flags?.dae?.stackable ?? "none") === "none" && await CEHasEffectApplied({ effectName: this.activity.name, uuid: this.actor.uuid })) {
            await CERemoveEffect({ effectName: this.activity.name, uuid: this.actor.uuid, origin });
            //@ ts-expect-error
            // await game.dfreds.effectInterface?.removeEffect({ effectName: theItem.name, uuid: this.actor.uuid, origin, metadata: macroData });
          }
          const effectData = foundry.utils.mergeObject(ceSelfEffect.toObject(), metaData);
          effectData.origin = origin;
          const effects = await CEAddEffectWith({ effectData, effectName: this.activity.name, uuid: this.actor.uuid, origin, overlay: false });
          //@ ts-expect-error game.dfreds
          // const effects = await game.dfreds?.effectInterface?.addEffectWith({ effectData, uuid: this.actor.uuid, origin, metadata: macroData });
          if (this.chatCard.getFlag("dnd5e", "use.concentrationId")) {
            origin = this.actor.effects.get(this.chatCard.getFlag("dnd5e", "use.concentrationId"));
            if (!effects) {
              for (let effect of this.actor.effects.filter(ef => ef.origin === origin.uuid)) {
                if (!(origin.getFlag("dnd5e", "dependents") ?? []).some(d => d.uuid === effect.uuid))
                  origin.addDependent(effect);
              }
            } else for (let effect of effects) {
              if (effect instanceof ActiveEffect && origin instanceof ActiveEffect) {
                //@ts-expect-error
                await origin.addDependent(effect);
              }
            }
          }
        }
      }
    }
    if (debugCallTiming) log(`applyActiveEffects elapsed ${Date.now() - applyDynamicEffectsStartTime}ms`)
    return this.WorkflowState_RollFinished;
  }
  async WorkflowState_Cleanup(context: any = {}): Promise<WorkflowState> {
    if (this.placeTemplateHookId) {
      Hooks.off("createMeasuredTemplate", this.placeTemplateHookId);
      Hooks.off("preCreateMeasuredTemplate", this.preCreateTemplateHookId);
    }
    if (configSettings.autoRemoveInstantaneousTemplate && this.templateUuid && this.activity.duration.units === "inst") {
      const templateToDelete = await fromUuid(this.templateUuid);
      if (templateToDelete) await templateToDelete.delete();
    }
    if (this.postSummonHookId) Hooks.off("dnd5e.postSummon", this.postSummonHookid);
    if (configSettings.autoItemEffects === "applyRemove") await this.removeEffectsButton();
    // TODO see if we can delete the workflow - I think that causes problems for Crymic
    //@ts-expect-error scrollBottom protected
    ui.chat?.scrollBottom();
    return this.WorkflowState_Completed;
  }

  async WorkflowState_Completed(context: any = {}): Promise<WorkflowState> {
    if (this.itemCardUuid && MQfromUuidSync(this.itemCardUuid)) {
      await Workflow.removeItemCardAttackDamageButtons(this.itemCardUuid, getRemoveAttackButtons(this.item), getRemoveDamageButtons(this.item));
    }
    if (context.attackRoll) return this.WorkflowState_AttackRollComplete;
    if (context.damageRoll) return this.WorkflowState_ConfirmRoll;
    return this.WorkflowState_Suspend;
  }

  async WorkflowState_Abort(context: any = {}): Promise<WorkflowState> {
    this.aborted = true;
    if (this.placeTemplateHookId) {
      Hooks.off("createMeasuredTemplate", this.placeTemplateHookId);
      Hooks.off("preCreateMeasuredTemplate", this.preCreateTemplateHookId);
    }
    if (this.postSummonHookId) Hooks.off("dnd5e.postSummon", this.postSummonHookid);
    if (this.itemCardUuid && MQfromUuidSync(this.itemCardUuid)) {
      await this.chatCard.delete();
    }
    clearUpdatesCache(this.itemCardUuid);

    if (this.templateUuid) {
      const templateToDelete = await fromUuid(this.templateUuid);
      if (templateToDelete) await templateToDelete.delete();
    }
    return this.WorkflowState_Cleanup;
  }

  async WorkflowState_Cancel(context: any = {}): Promise<WorkflowState> {
    // cancel will undo the workflow if it exists
    configSettings.undoWorkflow && !await untimedExecuteAsGM("undoTillWorkflow", this.uuid, true, true);
    return this.WorkflowState_Abort
  }
  async WorkflowState_RollFinished(context: any = {}): Promise<WorkflowState> {
    if (this.aborted) {
      const message = `${this.workflowName} Workflow ${this.id} RollFinished called when aborted`;
      error(message);
      TroubleShooter.recordError(new Error(message), message);
    }
    const specialExpiries = [
      "isDamaged",
      "isHealed",
      "1Reaction",
    ];
    await this.expireTargetEffects(specialExpiries)
    const rollFinishedStartTime = Date.now();
    const chatMessage = this.chatCard;
    if (!this.targetsDisplayed && this.targets.size > 0 && chatMessage && (this.activity.damage || this.effectTargets.size > 0)) {
      this.hitDisplayData = {};
      const theTargets = this.effectTargets.size > 0 ? this.effectTargets : this.targets;
      for (let targetToken of theTargets) {
        const targettokenUuid = targetToken.actor?.uuid;
        if (!targettokenUuid) continue;
        let img = targetToken.document?.texture.src ?? targetToken.actor?.img;
        if (configSettings.usePlayerPortrait && targetToken.actor?.type === "character") {
          img = targetToken.actor?.img ?? targetToken.document?.texture.src;
        }
        if (VideoHelper.hasVideoExtension(img ?? "")) {
          img = await game.video.createThumbnail(img ?? "", { width: 100, height: 100 });
        }
        this.hitDisplayData[targettokenUuid] = {
          isPC: targetToken.actor?.hasPlayerOwner,
          target: targetToken,
          hitClass: "success",
          acClass: "",
          img,
          gmName: getTokenName(targetToken),
          playerName: getTokenPlayerName(targetToken),
          uuid: targetToken.uuid,
          showAC: false,
          isHit: true
        };
      }
      await this.displayHits(chatMessage.whisper.length > 0, true);
    }
    let content = chatMessage?.content && foundry.utils.duplicate(chatMessage?.content);
    if (content && getRemoveAttackButtons(this.item) && chatMessage && configSettings.confirmAttackDamage === "none") {
      let searchRe = /<button data-action="attack">[^<]*<\/button>/;
      searchRe = /<div class="midi-attack-buttons".*<\/div>/
      content = content.replace(searchRe, "");
      const update: any = {
        "content": content,
        timestamp: Date.now(),
        "flags.midi-qol.type": MESSAGETYPES.ITEM,
      };
      //@ts-expect-error
      if (game.release.generation < 12) {
        update.type = CONST.CHAT_MESSAGE_TYPES.ROLL;
      } else { // v12 no longer need to set the sytle of the roll
        // update.style = CONST.CHAT_MESSAGE_STYLES.ROLL;
      }
      await debouncedUpdate(chatMessage, update);
    }
    // Add concentration data if required
    let hasConcentration = this.item.requiresConcentration;
    const template = this.template ? this.template : MQfromUuidSync(this.templateUuid);
    if (hasConcentration && template && this.chatCard.getFlag("dnd5e", "use.concentrationId")) {
      let origin = this.actor.effects.get(this.chatCard.getFlag("dnd5e", "use.concentrationId"));
      if (origin instanceof ActiveEffect) {
        //@ts-expect-error
        await origin.addDependent(this.template);
      }
    } else if (installedModules.get("dae") && activityHasAreaTarget(this.activity) && template && this.activity.duration?.units && configSettings.autoRemoveTemplate) { // create an effect to delete the template
      // If we are not applying concentration and want to auto remove the template create an effect to do so
      const activityDuration = this.activity.duration;
      let selfTarget = this.item.actor.token ? this.item.actor.token.object : getTokenForActor(this.item.actor);
      if (selfTarget) selfTarget = this.token; //TODO see why this is here
      let effectData;
      const templateString = " " + i18n("midi-qol.MeasuredTemplate");
      if (selfTarget) {
        let effect = this.item.actor.effects.find(ef => ef.name === this.item.name + templateString);
        if (effect) { // effect already applied
          if (template) { // we can add dependents so do that
            await effect.addDependent(this.template);
          }
        } else if (template) { // add an effect which will cause the template to be deleted
          effectData = {
            origin: this.item?.uuid, //flag the effect as associated to the spell being cast
            disabled: false,
            icon: this.item?.img,
            label: this.item?.name + templateString,
            duration: {},
            flags: {
              dae: {
                stackable: "noneName"
              },
              dnd5e: { dependents: [{ uuid: this.templateUuid }] }
            },
          }

          const inCombat = (game.combat?.turns.some(combatant => combatant.token?.id === selfTarget.id));
          const convertedDuration = globalThis.DAE.convertDuration(activityDuration, inCombat);
          if (convertedDuration?.type === "seconds") {
            effectData.duration = { seconds: convertedDuration.seconds, startTime: game.time.worldTime }
          } else if (convertedDuration?.type === "turns") {
            effectData.duration = {
              rounds: convertedDuration.rounds,
              turns: convertedDuration.turns,
              startRound: game.combat?.round,
              startTurn: game.combat?.turn,
            }
          }
          await this.actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
        }
      }
    }
    if (hasConcentration && this.summonedCreatures && configSettings.autoRemoveSummonedCreature) {
      let origin = this.actor.effects.get(this.chatCard.getFlag("dnd5e", "use.concentrationId"));
      if (origin instanceof ActiveEffect) {
        //@ts-expect-error
        await origin.addDependent(...this.summonedCreatures);
      }
    } else if (configSettings.autoRemoveSummonedCreature && this.summonedCreatures) {
      // need to create an effect to remove the summoned creatures
      const activityDuration = this.activity.duration;
      let selfTarget = this.item.actor.token ? this.item.actor.token.object : getTokenForActor(this.item.actor);
      if (selfTarget) selfTarget = this.token; //TODO see why this is here
      let effectData;
      const summonString = i18n("DND5E.ActionSumm") + ": ";
      let effect = this.item.actor.effects.find(ef => ef.name === summonString + this.item.name);
      if (effect) { // effect already applied
        await effect.addDependent(...this.summonedCreatures);
      } else { // add an effect which will cause the template to be deleted
        effectData = {
          origin: this.item?.uuid, //flag the effect as associated to the spell being cast
          disabled: false,
          icon: this.item?.img,
          label: summonString + this.item?.name,
          duration: {},
          flags: {
            dae: {
              stackable: "noneName"
            },
            dnd5e: { dependents: this.summonedCreatures.map(sc => { return { uuid: sc.uuid } }) }
          },
        }
        const inCombat = (game.combat?.turns.some(combatant => combatant.token?.id === selfTarget.id));
        const convertedDuration = globalThis.DAE.convertDuration(activityDuration, inCombat);
        if (convertedDuration?.type === "seconds") {
          effectData.duration = { seconds: convertedDuration.seconds, startTime: game.time.worldTime }
        } else if (convertedDuration?.type === "turns") {
          effectData.duration = {
            rounds: convertedDuration.rounds,
            turns: convertedDuration.turns,
            startRound: game.combat?.round,
            startTurn: game.combat?.turn,
          }
        }
        await this.actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
      }
    }
    await asyncHooksCallAll("midi-qol.postActiveEffects", this);
    if (this.item) await asyncHooksCallAll(`midi-qol.postActiveEffects.${this.item?.uuid}`, this);
    // Call onUseMacro if not already called
    if (configSettings.allowUseMacro && this.options.noOnUseMacro !== true) {
      await this.callMacros(this.item, this.onUseMacros?.getMacros("postActiveEffects"), "OnUse", "postActiveEffects");
      if (this.ammo) await this.callMacros(this.ammo, this.ammoOnUseMacros?.getMacros("postActiveEffects"), "OnUse", "postActiveEffects");
    }
    if (this.aborted) return this.WorkflowState_Abort;  // TODO This is wrong

    await asyncHooksCallAll("midi-qol.RollComplete", this);
    if (this.item) await asyncHooksCallAll(`midi-qol.RollComplete.${this.item?.uuid}`, this);
    if (this.aborted) return this.WorkflowState_Abort;  // TODO This is wrong
    if (autoRemoveTargets !== "none") setTimeout(untargetDeadTokens, 500); // delay to let the updates finish
    if (debugCallTiming) log(`RollFinished elapased ${Date.now() - rollFinishedStartTime}`);
    const inCombat = isInCombat(this.actor);
    let activeCombatants = game.combats?.combats.map(combat => combat.combatant?.token?.id)
    const isTurn = activeCombatants?.includes(this.token?.id);
    if (inCombat && isTurn && this.activity?.activation.type === "action" && !this.AoO) {
      await setActionUsed(this.actor);
    }
    return this.WorkflowState_Cleanup;
  }
  async WorkflowState_Default(context: any = {}): Promise<WorkflowState> { return this.WorkflowState_Suspend };

  initSaveResults() {
    this.saves = new Set();
    this.criticalSaves = new Set();
    this.fumbleSaves = new Set();
    this.failedSaves = this.activity?.attackasAttack ? new Set(this.hitTargets) : new Set(this.targets);
    this.advantageSaves = new Set();
    this.disadvantageSaves = new Set();
    this.saveDisplayData = [];
    this.saveResults = [];
  };

  public async checkAttackAdvantage() {
    await this.checkFlankingAdvantage();
    if (!this.needsAttackAdvantageCheck) return;
    this.needsAttackAdvantageCheck = false;

    const midiFlags = this.actor?.flags[MODULE_ID];
    const advantage = midiFlags?.advantage;
    const disadvantage = midiFlags?.disadvantage;
    const actType = this.activity?.actionType || "none"
    let conditionData;
    if (advantage || disadvantage) {
      const target: Token = this.targets.values().next().value;
      conditionData = createConditionData({ workflow: this, target, actor: this.actor });

      if (advantage) {
        if (advantage.all && await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.advantage.all`, conditionData)) {
          this.advantage = true;
          this.attackAdvAttribution.add(`ADV:all ${foundry.utils.getProperty(this.actor, "flags.midi.evaluated.advantage.all").effects.join(", ")}`);
          // foundry.utils.setProperty(this.actor, "flags.midi.evaluated.advantage.all", true);
        }
        if (await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.advantage.attack.all`, conditionData)) {
          this.attackAdvAttribution.add(`ADV:attack.all ${foundry.utils.getProperty(this.actor, "flags.midi.evaluated.advantage.attack.all").effects.join(", ")}`);
          this.advantage = true;
        }
        if (advantage.attack && advantage.attack[actType] && await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.advantage.attack.${actType}`, conditionData)) {
          this.attackAdvAttribution.add(`ADV:attack.${actType} ${foundry.utils.getProperty(this.actor, `flags.midi.evaluated.advantage.attack.${actType}`).effects.join(", ")}`);
          this.advantage = true;
        }
      }
      if (disadvantage) {
        const withDisadvantage = disadvantage.all || disadvantage.attack?.all || (disadvantage.attack && disadvantage.attack[actType]);
        if (disadvantage.all && await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.disadvantage.all`, conditionData)) {
          this.attackAdvAttribution.add(`DIS:all ${foundry.utils.getProperty(this.actor, "flags.midi.evaluated.disadvantage.all").effects.join(", ")}`);
          this.disadvantage = true;
        }
        if (disadvantage.attack?.all && await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.disadvantage.attack.all`, conditionData)) {
          this.attackAdvAttribution.add(`DIS:attack.all ${foundry.utils.getProperty(this.actor, "flags.midi.evaluated.disadvantage.attack.all").effects.join(", ")}`);
          this.disadvantage = true;
        }
        if (disadvantage.attack && disadvantage.attack[actType] && await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.disadvantage.attack.${actType}`, conditionData)) {
          this.attackAdvAttribution.add(`DIS:attack.${actType} ${foundry.utils.getProperty(this.actor, `flags.midi.evaluated.disadvantage.attack.${actType}`).effects.join(", ")}`);
          this.disadvantage = true;
        }
      }
      await this.checkAbilityAdvantage();
    }
    // TODO Hidden should check the target to see if they notice them?
    //@ts-expect-error .first()
    const target = this.targets?.first();
    const token: Token | undefined = this.attackingToken ?? canvas?.tokens?.get(this.tokenId);
    if (checkRule("invisAdvantage") && checkRule("invisAdvantage") !== "none" && target) {
      // if we are using a proxy token to attack use that for hidden invisible
      const invisibleToken = token ? hasCondition(token.actor, "invisible") : false;
      const invisibleTarget = hasCondition(target.actor, "invisible");
      const tokenCanSense = this.tokenCanSense?.has(target);
      const targetCanSense = this.targetsCanSense?.has(token);
      const invisAdvantage = (checkRule("invisAdvantage") === "RAW") ? invisibleToken || !targetCanSense : !targetCanSense;
      if (invisAdvantage) {
        if (invisibleToken) {
          this.attackAdvAttribution.add("ADV:invisible");
          this.advReminderAttackAdvAttribution.add("ADV:Invisible");
        } else if (!targetCanSense) {
          this.attackAdvAttribution.add("ADV:not detected");
          this.advReminderAttackAdvAttribution.add("ADV:Not Detected");
        }
        foundry.utils.setProperty(this.actor, "flags.midi.evaluated.advantage.attack.invisible", { value: true, effects: ["Invisible Attacker"] });

        this.advantage = true;
      }

      const invisDisadvantage = (checkRule("invisAdvantage") === "RAW") ? invisibleTarget || !tokenCanSense : !tokenCanSense;
      if (invisDisadvantage) {
        // Attacker can't see target so disadvantage
        log(`Disadvantage given to ${this.actor.name} due to invisible target`, invisibleTarget, tokenCanSense);
        if (invisibleTarget) {
          this.attackAdvAttribution.add("DIS:invisible foe");
          this.advReminderAttackAdvAttribution.add("DIS:Invisible Foe");
          foundry.utils.setProperty(this.actor, "flags.midi.evaluated.disadvantage.attack.invisible", { value: true, effects: ["Invisible Defender"] });
        }
        if (!tokenCanSense) {
          this.attackAdvAttribution.add("DIS:not detected");
          this.advReminderAttackAdvAttribution.add("DIS:Not Detected");
          foundry.utils.setProperty(this.actor, "flags.midi.evaluated.disadvantage.attack.invisible", { value: true, effects: ["Defender Not Detected"] });
        }
        this.disadvantage = true;
      }
    }

    // Check hidden
    if (checkRule("hiddenAdvantage") && checkRule("HiddenAdvantage") !== "none" && target) {
      if (checkRule("hiddenAdvantage") === "perceptive" && installedModules.get("perceptive")?.active) {
        //@ts-expect-error .api
        const perceptiveApi = game.modules.get("perceptive")?.api;
        const tokenSpotted = await perceptiveApi?.isSpottedby(token, target, { LOS: false, Range: true, Effects: true, Hidden: false, canbeSpotted: true }) ?? true;
        const targetSpotted = await perceptiveApi?.isSpottedby(target, token, { LOS: false, Range: true, Effects: true, Hidden: false, canbeSpotted: true }) ?? true;
        if (!tokenSpotted) {
          this.attackAdvAttribution.add("ADV:hidden");
          this.advReminderAttackAdvAttribution.add("ADV:Hidden");
          foundry.utils.setProperty(this.actor, "flags.midi.evaluated.advantage.attack.hidden", { value: true, effects: ["Hidden Attacker"] });
          this.advantage = true;
        }
        if (!targetSpotted) {
          this.attackAdvAttribution.add("DIS:hidden foe");
          this.advReminderAttackAdvAttribution.add("DIS:Hidden Foe");
          foundry.utils.setProperty(this.actor, "flags.midi.evaluated.disadvantage.attack.hidden", { vale: true, effects: ["Hidden Defender"] });
          this.disadvantage = true;
        }
      }

      if (checkRule("hiddenAdvantage") === "effect") {
        const hiddenToken = token ? hasCondition(token.actor, "hidden") : false;
        const hiddenTarget = hasCondition(target.actor, "hidden");
        if (hiddenToken) {
          this.attackAdvAttribution.add("ADV:hidden");
          this.advReminderAttackAdvAttribution.add("ADV:Hidden");
          foundry.utils.setProperty(this.actor, "flags.midi.evaluated.advantage.attack.hidden", { value: true, effects: ["Hidden Attacker"] });
          this.advantage = true;
        }
        if (hiddenTarget) {
          this.attackAdvAttribution.add("DIS:hidden");
          this.advReminderAttackAdvAttribution.add("DIS:Hidden Foe");
          foundry.utils.setProperty(this.actor, "flags.midi.evaluated.disadvantage.attack.hidden", { value: true, effects: ["Hidden Defender"] });
          this.disadvantage = true;
        }
      }
    }

    // Nearby foe gives disadvantage on ranged attacks
    if (checkRule("nearbyFoe")
      && !foundry.utils.getProperty(this.actor, `flags.${MODULE_ID}.ignoreNearbyFoes`)
      && (["rwak", "rsak", "rpak"].includes(actType) || (this.item.system.properties?.has("thr") && actType == "mwak"))) {
      let nearbyFoe;
      const me = this.attackingToken ?? canvas?.tokens?.get(this.tokenId);
      if (actType !== "mwak") { // one of rwak/rsak/rpak
        nearbyFoe = checkNearby(-1, canvas?.tokens?.get(this.tokenId), configSettings.optionalRules.nearbyFoe, { includeIncapacitated: false, canSee: true });
      } else if (this.item.system.properties?.has("thr")) {
        const meleeRange = 5 + (this.item.system?.properties?.has("rch") ? 5 : 0);
        //@ts-expect-error .first
        if (computeDistance(me, this.targets.first(), { wallsBlock: false }) <= meleeRange) nearbyFoe = false;
        else nearbyFoe = checkNearby(-1, canvas?.tokens?.get(this.tokenId), configSettings.optionalRules.nearbyFoe, { includeIncapacitated: false, canSee: true });
      }
      if (nearbyFoe) {
        if (debugEnabled > 0) warn(`checkAttackAdvantage | Ranged attack by ${this.actor.name} at disadvantage due to nearby foe`);
        this.attackAdvAttribution.add("DIS:nearbyFoe");
        this.advReminderAttackAdvAttribution.add("DIS:Nearby foe");
        foundry.utils.setProperty(this.actor, "flags.midi.evaluated.disadvantage.attack.nearbyFoe", { value: true, effects: ["Nearby Foe"] });
        this.disadvantage = true;
      }
      // this.disadvantage = this.disadvantage || nearbyFoe;
    }
    if (["tiny", "sm"].includes(this.actor.system.traits?.size) && this.item.system.properties?.has("hvy")) {
      const failDisadvantageHeavy = getProperty(this.actor, `flags.${MODULE_ID}.fail.disadvantage.heavy`);
      if (failDisadvantageHeavy && !conditionData)
        conditionData = createConditionData({ workflow: this, target, actor: this.actor });
      if (!failDisadvantageHeavy || !(await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.fail.disadvantage.heavy`, conditionData))) {
        this.disadvantage = true;
        this.attackAdvAttribution.add("DIS:small");
        this.advReminderAttackAdvAttribution.add("DIS:Small");
      }
    }
    await this.checkTargetAdvantage();
  }

  async processCriticalFlags() {
    if (!this.actor) return; // in case a damage only workflow caused this.
    /*
    * flags.midi-qol.critical.all
    * flags.midi-qol.critical.mwak/rwak/msak/rsak/other
    * flags.midi-qol.noCritical.all
    * flags.midi-qol.noCritical.mwak/rwak/msak/rsak/other
    */
    // check actor force critical/noCritical
    const criticalFlags = foundry.utils.getProperty(this.actor, `flags.${MODULE_ID}.critical`) ?? {};
    const noCriticalFlags = foundry.utils.getProperty(this.actor, `flags.${MODULE_ID}.noCritical`) ?? {};
    const attackType = this.activity?.actionType;
    this.critFlagSet = false;
    this.noCritFlagSet = false;

    if (criticalFlags || noCriticalFlags) {
      //@ts-expect-error .first()
      const target: Token = this.hitTargets.first();
      const conditionData = createConditionData({ workflow: this, target, actor: this.actor });
      if (await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.critical.all`, conditionData)
        || await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.critical.${attackType}`, conditionData)) {
        this.critFlagSet = true;
      }
      if (await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.noCritical.all`, conditionData)
        || await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.noCritical.${attackType}`, conditionData)) {
        this.noCritFlagSet = true;
      }
    }

    // check target critical/nocritical
    if (this.hitTargets.size === 1) {
      //@ts-expect-error .first()
      const firstTarget = this.hitTargets.first();
      const grants = firstTarget.actor?.flags[MODULE_ID]?.grants?.critical ?? {};
      const fails = firstTarget.actor?.flags[MODULE_ID]?.fail?.critical ?? {};
      if (grants || fails) {
        if (Number.isNumeric(grants.range) && computeDistance(firstTarget, this.token, { wallsBlock: false }) <= Number(grants.range)) {
          this.critFlagSet = true;
        }
        const conditionData = createConditionData({ workflow: this, target: firstTarget, actor: this.actor });
        if (await evalAllConditionsAsync(firstTarget.actor, `flags.${MODULE_ID}.grants.critical.all`, conditionData)
          || await evalAllConditionsAsync(firstTarget.actor, `flags.${MODULE_ID}.grants.critical.${attackType}`, conditionData)) {
          this.critFlagSet = true;
        }
        if (await evalAllConditionsAsync(firstTarget.actor, `flags.${MODULE_ID}.fail.critical.all`, conditionData)
          || await evalAllConditionsAsync(firstTarget.actor, `flags.${MODULE_ID}.fail.critical.${attackType}`, conditionData)) {
          console.warn(`midi-qol | processCriticalFlags | ${firstTarget.actor.name} flags.${MODULE_ID}.fail.critical is dprecated user flags.${MODULE_ID}.grants.noCritical.all/.attackType instead`);
          this.noCritFlagSet = true;
        }
        if (await evalAllConditionsAsync(firstTarget.actor, `flags.${MODULE_ID}.grants.noCritical.all`, conditionData)
          || await evalAllConditionsAsync(firstTarget.actor, `flags.${MODULE_ID}.grants.noCritical.${attackType}`, conditionData)) {
          this.noCritFlagSet = true;
        }
      }
    }
    this.isCritical = this.isCritical || this.critFlagSet;
    if (this.noCritFlagSet) this.isCritical = false;
  }

  async checkAbilityAdvantage() {
    if (!["mwak", "rwak"].includes(this.activity?.actionType)) return;
    let ability = this.item?.abilityMod;
    if ("" === ability) ability = this.activity?.item?.system.properties?.has("fin") ? "dex" : "str";
    if (foundry.utils.getProperty(this.actor, `flags.${MODULE_ID}.advantage.attack.${ability}`)) {
      if (await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.advantage.attack.${ability}`, this.conditionData)) {
        this.advantage = true;
        this.attackAdvAttribution.add(`ADV:attack.${ability} ${foundry.utils.getProperty(this.actor, `flags.midi.evaluated.advantage.attack.${ability}`).effects.join(", ")}`);
      }
    }
    if (foundry.utils.getProperty(this.actor, `flags.${MODULE_ID}.disadvantage.attack.${ability}`)) {
      if (await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.disadvantage.attack.${ability}`, this.conditionData)) {
        this.disadvantage = true;
        this.attackAdvAttribution.add(`DIS:attack.${ability} ${foundry.utils.getProperty(this.actor, `flags.midi.evaluated.disadvantage.attack.${ability}`).effects.join(", ")}`);
      }
    }
  }

  async checkFlankingAdvantage(): Promise<boolean> {
    if (!canvas) {
      console.warn("midi-qol | CheckFlankingAdvantage | abandoned - no canvas defined")
      return false;
    }
    this.flankingAdvantage = false;
    if (this.item && !(["mwak", "msak", "mpak"].includes(this.activity?.actionType))) return false;
    const token = MQfromUuidSync(this.tokenUuid ?? null)?.object;
    //@ts-expect-error first
    const target: Token = this.targets.first();

    const needsFlanking = await markFlanking(token, target,);
    if (needsFlanking) {
      this.attackAdvAttribution.add(`ADV:flanking`);
      foundry.utils.setProperty(this.actor, "flags.midi.evaluated.advantage.attack.flanking", { value: true, effects: ["Flanking"] });
      // this.advReminderAttackAdvAttribution.add("ADV:flanking");
    }
    if (["advonly", "ceadv"].includes(checkRule("checkFlanking"))) this.flankingAdvantage = needsFlanking;
    return needsFlanking;
  }

  async checkTargetAdvantage() {
    if (!this.item) return;
    if (!this.targets?.size) return;
    const actionType = this.activity?.actionType;
    //@ts-expect-error
    const firstTargetDocument = getTokenDocument(this.targets.first());
    const firstTarget = getToken(firstTargetDocument);
    if (!firstTargetDocument || !firstTarget) return;
    if (checkRule("nearbyAllyRanged") > 0 && ["rwak", "rsak", "rpak"].includes(actionType)) {
      //@ts-expect-error .width.height
      if (firstTargetDocument.width * firstTargetDocument.height < Number(checkRule("nearbyAllyRanged"))) {
        const nearbyAlly = checkNearby(-1, firstTarget, (canvas?.dimensions?.distance ?? 5)); // targets near a friend that is not too big
        // TODO include thrown weapons in check
        if (nearbyAlly) {
          if (debugEnabled > 0) warn("checkTargetAdvantage | ranged attack with disadvantage because target is near a friend");
        }
        this.disadvantage = this.disadvantage || nearbyAlly;
        if (nearbyAlly) {
          this.attackAdvAttribution.add(`DIS:nearbyAlly`);
          this.advReminderAttackAdvAttribution.add("DIS:Nearby Ally");
          foundry.utils.setProperty(this.actor, "flags.midi.evaluated.disadvantage.attack.nearbyAlly", { value: true, effects: ["Nearby Ally"] });
        }
      }
    }
    //@ts-expect-error .flags
    const grants = firstTargetDocument.actor?.flags[MODULE_ID]?.grants;
    if (!grants) return;
    if (!["rwak", "mwak", "rsak", "msak", "rpak", "mpak"].includes(actionType)) return;
    const attackAdvantage = grants.advantage?.attack || {};
    let grantsAdvantage;
    const conditionData = createConditionData({ workflow: this, target: this.token, actor: this.actor });
    if (grants.advantage?.all && await evalCondition(grants.advantage.all, conditionData, { errorReturn: false, async: true })) {
      grantsAdvantage = true;
      this.attackAdvAttribution.add(`ADV:grants.advantage.all ${firstTargetDocument.name}`);
    }
    if (attackAdvantage.all && await evalCondition(attackAdvantage.all, conditionData, { errorReturn: false, async: true })) {
      grantsAdvantage = true;
      this.attackAdvAttribution.add(`ADV:grants.advantage.attack.all ${firstTargetDocument.name}`);
    }
    if (attackAdvantage[actionType] && await evalCondition(attackAdvantage[actionType], conditionData, { errorReturn: false, async: true })) {
      grantsAdvantage = true;
      this.attackAdvAttribution.add(`ADV:grants.attack.${actionType} ${firstTargetDocument.name}`);
    }
    if (grants.fail?.advantage?.attack?.all && await evalCondition(grants.fail.advantage.attack.all, conditionData, { errorReturn: false, async: true })) {
      grantsAdvantage = false;
      this.advantage = false;
      this.noAdvantage = true;
      this.attackAdvAttribution.add(`ADV:grants.attack.noAdvantage ${firstTargetDocument.name}`);
    }
    if (grants.fail?.advantage?.attack && grants.fail.advantage.attack[actionType] && await evalCondition(grants.fail.advantage.attack[actionType], conditionData, { errorReturn: false, async: true })) {
      grantsAdvantage = false;
      this.advantage = false;
      this.noAdvantage = true;
      this.attackAdvAttribution.add(`ADV:grants.attack.noAdvantage${actionType} ${firstTargetDocument.name}`);
    }

    const attackDisadvantage = grants.disadvantage?.attack || {};
    let grantsDisadvantage;
    if (grants.disadvantage?.all && await evalCondition(grants.disadvantage.all, conditionData, { errorReturn: false, async: true })) {
      grantsDisadvantage = true;
      this.attackAdvAttribution.add(`DIS:grants.disadvantage.all ${firstTargetDocument.name}`);
    }
    if (attackDisadvantage.all && await evalCondition(attackDisadvantage.all, conditionData, { errorReturn: false, async: true })) {
      grantsDisadvantage = true;
      this.attackAdvAttribution.add(`DIS:grants.attack.all ${firstTargetDocument.name}`);
    }
    if (attackDisadvantage[actionType] && await evalCondition(attackDisadvantage[actionType], conditionData, { errorReturn: false, async: true })) {
      grantsDisadvantage = true;
      this.attackAdvAttribution.add(`DIS:grants.attack.${actionType} ${firstTargetDocument.name}`);
    }
    if (grants.fail?.disadvantage?.attack?.all && await evalCondition(grants.fail.disadvantage.attack.all, conditionData, { errorReturn: false, async: true })) {
      this.attackAdvAttribution.add(`DIS:None ${firstTargetDocument.name}`);
      grantsDisadvantage = false;
      this.disadvantage = false;
      this.noDisdvantage = true;
      this.attackAdvAttribution.add(`ADV:grants.attack.noDisdvantage ${firstTargetDocument.name}`);
    }
    if (grants.fail?.disadvantage?.attack && grants.fail.disadvantage.attack[actionType] && await evalCondition(grants.fail.disadvantage.attack[actionType], conditionData, { errorReturn: false, async: true })) {
      grantsDisadvantage = false;
      this.disadvantage = false;
      this.noDisdvantage = true;
      this.attackAdvAttribution.add(`ADV:grants.attack.noDisadvantage${actionType} ${firstTargetDocument.name}`);
    }
    this.advantage = this.advantage || grantsAdvantage;
    this.disadvantage = this.disadvantage || grantsDisadvantage;

  }

  async triggerTargetMacros(triggerList: string[], targets: Set<any> = this.targets, options: any = {}) {
    let results = {};
    for (let target of targets) {
      results[target.uuid ?? target.document.uuid] = [];
      let result = results[target.uuid ?? target.document.uuid];
      const actorOnUseMacros = foundry.utils.getProperty(target.actor ?? {}, `flags.${MODULE_ID}.onUseMacroParts`) ?? new OnUseMacros();
      const wasAttacked = this.activity?.attack;
      const wasHit = (this.activity ? wasAttacked : true) && (this.hitTargets?.has(target) || this.hitTargetsEC?.has(target));
      const wasMissed = (this.activity ? wasAttacked : true) && !this.hitTargets?.has(target) && !this.hitTargetsEC?.has(target);
      const wasDamaged = this.damageList
        && (this.hitTargets.has(target) || this.hitTargetsEC.has(target))
        && (this.damageList.find(dl => dl.tokenUuid === (target.uuid ?? target.document.uuid) && dl.hpDamage > 0));

      if (this.targets.has(target) && triggerList.includes("isTargeted")) {
        if (triggerList.includes("isTargeted")) {
          result.push(...await this.callMacros(this.item,
            actorOnUseMacros?.getMacros("isTargeted"),
            "TargetOnUse",
            "isTargeted",
            { actor: target.actor, token: target })
          );
        }
      }
      if (wasAttacked && triggerList.includes("isPreAttacked")) {
        result.push(...await this.callMacros(this.item,
          actorOnUseMacros?.getMacros("isPreAttacked"),
          "TargetOnUse",
          "isPreAttacked",
          { actor: target.actor, token: target })
        );
      }

      if (wasAttacked && triggerList.includes("isAttacked")) {
        result.push(...await this.callMacros(this.item,
          actorOnUseMacros?.getMacros("isAttacked"),
          "TargetOnUse",
          "isAttacked",
          { actor: target.actor, token: target })
        );
      }
      if (triggerList.includes("postTargetEffectApplication")) {
        result.push(...await this.callMacros(this.item,
          actorOnUseMacros?.getMacros("postTargetEffectApplication"),
          "TargetOnUse",
          "postTargetEffectApplication",
          { actor: target.actor, token: target })
        );
      }
      // If auto applying damage can do a better test when damage application has been calculdated
      if (wasDamaged && triggerList.includes("isDamaged") && !configSettings.autoApplyDamage.toLocaleLowerCase().includes("yes")) {
        result.push(...await this.callMacros(this.item,
          actorOnUseMacros?.getMacros("isDamaged"),
          "TargetOnUse",
          "isDamaged",
          { actor: target.actor, token: target })
        );
      }
      if (wasHit && triggerList.includes("isHit")) {
        result.push(...await this.callMacros(this.item,
          actorOnUseMacros?.getMacros("isHit"),
          "TargetOnUse",
          "isHit",
          { actor: target.actor, token: target })
        );
      }
      if (wasMissed && triggerList.includes("isMissed")) {
        result.push(...await this.callMacros(this.item,
          actorOnUseMacros?.getMacros("isMissed"),
          "TargetOnUse",
          "isMissed",
          { actor: target.actor, token: target })
        );
      }
      if (triggerList.includes("preTargetDamageApplication")) {
        result.push(...await this.callMacros(this.item,
          actorOnUseMacros?.getMacros("preTargetDamageApplication"),
          "TargetOnUse",
          "preTargetDamageApplication",
          { actor: target.actor, token: target })
        );
      }

      if (this.activityHasSave && triggerList.includes("preTargetSave")) {
        result.push(...await this.callMacros(this.item,
          actorOnUseMacros?.getMacros("preTargetSave"),
          "TargetOnUse",
          "preTargetSave",
          { actor: target.actor, token: target })
        );
      }

      if (this.activityHasSave && triggerList.includes("isAboutToSave")) {
        result.push(...await this.callMacros(this.item,
          actorOnUseMacros?.getMacros("isAboutToSave"),
          "TargetOnUse",
          "isAboutToSave",
          { actor: target.actor, token: target })
        );
      }

      if (target.actor?.uuid !== this.actor.uuid && triggerList.includes("1Reaction")) {
      }
      if (this.activityHas && triggerList.includes("isSaveSuccess") && (this.saves.has(target) || options.saved === true)) {
        result.push(...await this.callMacros(this.item,
          actorOnUseMacros?.getMacros("isSaveSuccess"),
          "TargetOnUse",
          "isSaveSuccess",
          { actor: target.actor, token: target })
        );
      }
      if (this.activityHasSave && triggerList.includes("isSaveFailure") && (!this.saves.has(target) || options.saved === false)) {
        result.push(...await this.callMacros(this.item,
          actorOnUseMacros?.getMacros("isSaveFailure"),
          "TargetOnUse",
          "isSaveFailure",
          { actor: target.actor, token: target })
        );
      }
      if (this.activityHasSave && triggerList.includes("isSave")) {
        result.push(...await this.callMacros(this.item,
          actorOnUseMacros?.getMacros("isSave"),
          "TargetOnUse",
          "isSave",
          { actor: target.actor, token: target })
        );
      }
    }
    return results;
  }

  async expireTargetEffects(expireList: string[]) {
    if (debugEnabled > 0) warn(`expireTargetEffects | ${expireList}`)
    for (let target of this.targets) {
      const expriryReason: string[] = [];
      const appliedEffects = getAppliedEffects(target?.actor, { includeEnchantments: true });
      if (!appliedEffects) continue; // nothing to expire
      const expiredEffects: (string | null)[] = appliedEffects.filter(ef => {
        let wasExpired = false;
        const specialDuration = foundry.utils.getProperty(ef.flags, "dae.specialDuration");
        if (!specialDuration) return false;
        const wasAttacked = this.activity?.attack;
        //TODO this test will fail for damage only workflows - need to check the damage rolled instead
        const wasHit = (this.item ? wasAttacked : true) && (this.hitTargets?.has(target) || this.hitTargetsEC?.has(target));
        const wasDamaged = this.damageList
          // consider removing this - by having it here hand editing hp wont expire effects
          // but any damage application by an item will get picked up in applyTokenDamageMany
          // so this is only relevant if you are not auto applying damage
          && (this.hitTargets.has(target) || this.hitTargetsEC.has(target))
          //@ts-expect-error token.document
          && (this.damageList.find(dl => dl.tokenUuid === (target.uuid ?? target.document.uuid) && dl.hpDamage > 0));
        //@ts-expect-error target.dcoument
        const wasHealed = this.damageList && (this.damageList.find(dl => dl.tokenUuid === (target.uuid ?? target.document.uuid) && dl.hpDamage < 0))
        //TODO this is going to grab all the special damage types as well which is no good.
        if (wasAttacked && expireList.includes("isAttacked") && specialDuration.includes("isAttacked")) {
          wasExpired = true;
          expriryReason.push("isAttacked")
        }
        // If auto applying damage can do a better test when damage application has been calculdated
        if (wasDamaged && expireList.includes("isDamaged") && !configSettings.autoApplyDamage.toLocaleLowerCase().includes("yes")
          && specialDuration.includes("isDamaged")) {
          wasExpired = true;
          expriryReason.push("isDamaged");
        }
        // If auto applying damage can do a better test when damage application has been calculdated
        if (wasHealed && expireList.includes("isHealed") && !configSettings.autoApplyDamage.toLocaleLowerCase().includes("yes")
          && specialDuration.includes("isHealed")) {
          wasExpired = true;
          expriryReason.push("isHealed");
        }
        if (wasHit && expireList.includes("isHit") && specialDuration.includes("isHit")) {
          wasExpired = true;
          expriryReason.push("isHit");

        }
        if ((target.actor?.uuid !== this.actor.uuid && expireList.includes("1Reaction") && specialDuration.includes("1Reaction"))) {
          wasExpired = true;
          expriryReason.push("1Reaction");
        }
        for (let dt of this.rawDamageDetail) {
          if (expireList.includes(`isDamaged`) && (wasDamaged || dt.type === "healing") && specialDuration.includes(`isDamaged.${dt.type}`)) {
            wasExpired = true;
            expriryReason.push(`isDamaged.${dt.type}`);
            break;
          }
        }
        if (!this.item) return wasExpired;
        if (this.activity.save && expireList.includes("isSaveSuccess") && specialDuration.includes(`isSaveSuccess`) && this.saves.has(target)) {
          wasExpired = true;
          expriryReason.push(`isSaveSuccess`);
        }
        if (this.activity.save && expireList.includes("isSaveFailure") && specialDuration.includes(`isSaveFailure`) && !this.saves.has(target)) {
          wasExpired = true;
          expriryReason.push(`isSaveFailure`);
        }
        if (this.activity.save && expireList.includes("isSave") && specialDuration.includes(`isSave`)) {
          wasExpired = true;
          expriryReason.push(`isSave`);
        }
        const abl = this.activity?.save?.ability;
        if (this.activity.save && expireList.includes(`isSaveSuccess`) && specialDuration.includes(`isSaveSuccess.${abl}`) && this.saves.has(target)) {
          wasExpired = true;
          expriryReason.push(`isSaveSuccess.${abl}`);
        };
        if (this.activity.save && expireList.includes(`isSaveFailure`) && specialDuration.includes(`isSaveFailure.${abl}`) && !this.saves.has(target)) {
          wasExpired = true;
          expriryReason.push(`isSaveFailure.${abl}`);
        };
        if (this.activity.save && expireList.includes(`isSave`) && specialDuration.includes(`isSave.${abl}`)) {
          wasExpired = true;
          expriryReason.push(`isSave.${abl}`);
        };
        return wasExpired;
      }).map(ef => ef.uuid);
      if (expiredEffects.length > 0) {
        await timedAwaitExecuteAsGM("removeEffectUuids", {
          actorUuid: target.actor?.uuid,
          effects: expiredEffects,
          options: { "expiry-reason": `midi-qol:${expriryReason}` }
        });
      }
    }
  }

  getDamageBonusMacros(): string | undefined {
    const actorMacros = foundry.utils.getProperty(this.actor.flags, `${game.system.id}.DamageBonusMacro`);
    const itemMacros = this.onUseMacros?.getMacros("damageBonus")
    if (!itemMacros?.length) return actorMacros;
    if (!actorMacros?.length) return itemMacros;
    return `${actorMacros},${itemMacros}`;
  }

  async rollBonusDamage(damageBonusMacro) {
    const extraDamages: (damageBonusMacroResult | undefined | boolean)[] = await this.callMacros(this.item, damageBonusMacro, "DamageBonus", "DamageBonus");
    if (!extraDamages) return;
    let rolls: Roll[] = [];
    try {
      for (let damageEntries of extraDamages) {
        if (!damageEntries || typeof damageEntries === "boolean") continue;
        if (!(damageEntries instanceof Array)) damageEntries = [damageEntries];
        for (let de of damageEntries) {
          if (!de) continue;
          let damageEntries: any = de;
          if (!(de instanceof Array)) damageEntries = [de];
          for (let damageEntry of damageEntries) {
            if (damageEntry instanceof Roll) {
              rolls.push(damageEntry)
            } else {
              let { damageRoll, damageType, flavor } = damageEntry;
              if (!damageRoll) continue;
              damageType = getDamageType(damageType);
              if (!damageType && flavor && getDamageType(flavor)) damageType = getDamageType(flavor);
              //@ts-expect-error
              if (!damageType && this.damageRolls) damageType = this.damageRolls[0].options?.type;
              if (!damageType) damageType = MQdefaultDamageType;

              const rollOptions = {
                type: damageType,
                flavor: flavor ?? damageType,
              }
              //@ts-expect-error
              rolls.push(await new CONFIG.Dice.DamageRoll(damageRoll, this.item?.getRollData() ?? this.actor.getRollData(), rollOptions).evaluate({ async: true }));
            }
          }
        }
      }
      await this.setBonusDamageRolls(rolls);
    } catch (err) {
      const message = `midi-qol | rollBonusDamage | error in evaluating${extraDamages} in bonus damage`
      TroubleShooter.recordError(err, message);
      console.warn(message, err);
      this.bonusDamageRolls = null;
      this.rawBonusDamageDetail = [];
    }
    if (this.bonusDamageRolls && this.workflowOptions?.damageRollDSN !== false) {
      await displayDSNForRoll(this.bonusDamageRolls, "damageRoll");
    }
    return;
  }

  macroDataToObject(macroData: any): any {
    const data = macroData
    for (let documentsName of ["targets", "failedSaves", "criticalSaves", "fumbleSaves", "saves", "superSavers", "semiSuperSavers"]) {
      data[documentsName] = data[documentsName].map(td => td.toObject());
    }
    data.actor = data.actor.toObject();
    delete data.workflow;
    return data;
  }

  getMacroData(options: any = {}): any {
    let targets: TokenDocument[] = [];
    let targetUuids: string[] = []
    let failedSaves: TokenDocument[] = [];
    let criticalSaves: TokenDocument[] = [];
    let criticalSaveUuids: string[] = [];
    let fumbleSaves: TokenDocument[] = [];
    let fumbleSaveUuids: string[] = [];
    let failedSaveUuids: string[] = [];
    let hitTargets: TokenDocument[] = [];
    let hitTargetsEC: TokenDocument[] = [];
    let hitTargetUuidsEC: string[] = [];
    let hitTargetUuids: string[] = [];
    let saves: TokenDocument[] = [];
    let saveUuids: string[] = [];
    let superSavers: TokenDocument[] = [];
    let superSaverUuids: string[] = [];
    let semiSuperSavers: TokenDocument[] = [];
    let semiSuperSaverUuids: string[] = [];
    for (let target of this.targets) {
      targets.push((target instanceof Token) ? target.document : target);
      targetUuids.push(target instanceof Token ? target.document?.uuid : target.uuid);
    }
    for (let save of this.saves) {
      saves.push((save instanceof Token) ? save.document : save);
      saveUuids.push((save instanceof Token) ? save.document?.uuid : save.uuid);
    }
    for (let hit of this.hitTargets) {
      const htd = getTokenDocument(hit);
      if (htd) {
        hitTargets.push(htd);
        hitTargetUuids.push(htd.uuid);
      }
    }
    for (let hit of this.hitTargetsEC) {
      const htd = getTokenDocument(hit);
      if (htd) {
        hitTargetsEC.push(htd);
        hitTargetUuidsEC.push(htd.uuid);
      }
    }

    for (let failed of this.failedSaves) {
      failedSaves.push(failed instanceof Token ? failed.document : failed);
      failedSaveUuids.push(failed instanceof Token ? failed.document?.uuid : failed.uuid);
    }
    for (let critical of this.criticalSaves) {
      criticalSaves.push(critical instanceof Token ? critical.document : critical);
      criticalSaveUuids.push(critical instanceof Token ? critical.document?.uuid : critical.uuid);
    }
    for (let fumble of this.fumbleSaves) {
      fumbleSaves.push(fumble instanceof Token ? fumble.document : fumble);
      fumbleSaveUuids.push(fumble instanceof Token ? fumble.document?.uuid : fumble.uuid);
    }
    for (let save of this.superSavers) {
      superSavers.push(save instanceof Token ? save.document : save);
      superSaverUuids.push(save instanceof Token ? save.document?.uuid : save.uuid);
    };
    for (let save of this.semiSuperSavers) {
      semiSuperSavers.push(save instanceof Token ? save.document : save);
      semiSuperSaverUuids.push(save instanceof Token ? save.document?.uuid : save.uuid);
    };
    const itemData = this.item?.toObject(false) ?? {};
    itemData.data = itemData.system; // Try and support the old.data
    itemData.uuid = this.item?.uuid; // provide the uuid so the actual item can be recovered
    return {
      actor: this.actor,
      actorData: this.actor.toObject(false),
      actorUuid: this.actor.uuid,
      advantage: this.advantage,
      attackD20: this.diceRoll,
      attackRoll: this.attackRoll,
      attackTotal: this.attackTotal,
      bonusDamageDetail: this.rawBonusDamageDetail,
      bonusDamageHTML: this.bonusDamageHTML,
      bonusDamageRolls: this.bonusDamageRolls,
      bonusDamageRoll: this.bonusDamageRoll,
      bonusDamageTotal: this.bonusDamageTotal,
      criticalSaves,
      criticalSaveUuids,
      damageDetail: this.rawDamageDetail,
      damageList: this.damageList,
      damageRoll: this.damageRoll,
      damageRolls: this.damageRolls,
      damageTotal: this.damageTotal,
      diceRoll: this.diceRoll,
      disadvantage: this.disadvantage,
      event: this.event,
      failedSaves,
      failedSaveUuids,
      fumbleSaves,
      fumbleSaveUuids,
      hitTargets,
      hitTargetsEC,
      hitTargetUuids,
      hitTargetUuidsEC,
      id: this.item?.id,
      isCritical: this.rollOptions.isCritical || this.isCritical || this.workflowOptions.isCritical,
      isFumble: this.isFumble,
      isVersatile: this.rollOptions.versatile || this.isVersatile || this.workflowOptions.isVersatile,
      item: itemData,
      itemCardId: this.itemCardId,
      itemCardUuid: this.itemCardUuid,
      itemData,
      itemUuid: this.item?.uuid,
      otherDamageDetail: this.rawOtherDamageDetail,
      otherDamageList: this.otherDamageList,
      otherDamageTotal: this.otherDamageTotal,
      powerLevel: game.system.id === "sw5e" ? this.spellLevel : undefined,
      rollData: (this.item ?? this.actor).getRollData(),
      rollOptions: this.rollOptions,
      saves,
      saveUuids,
      semiSuperSavers,
      semiSuperSaverUuids,
      castLevel: this.spellLevel,
      spellLevel: this.spellLevel,
      superSavers,
      superSaverUuids,
      targets,
      targetUuids,
      templateId: this.templateId, // deprecated
      templateUuid: this.templateUuid,
      tokenId: this.tokenId,
      tokenUuid: this.tokenUuid,
      uuid: this.uuid, // deprecated
      workflowOptions: this.workflowOptions,
      castData: this.castData,
      workflow: options.noWorkflowReference ? undefined : this
    }
  }

  async callMacros(item, macros, tag, macroPass, options: any = {}): Promise<(damageBonusMacroResult | boolean | undefined)[]> {
    if (!macros || macros?.length === 0) return [];
    const macroNames = macros.split(",").map(s => s.trim());
    let values: Promise<damageBonusMacroResult | any>[] = [];
    const macroData = this.getMacroData();
    macroData.options = options;
    macroData.tag = tag;
    macroData.macroPass = macroPass;
    this.macroPass = macroPass;
    this.tag = tag;
    if (debugEnabled > 1) {
      log("callMacros | calling", macros, "for", macroPass, "with", macroData);
    }
    for (let macro of macroNames) {
      if (macroNames.length > 0 && debugEnabled > 0) {
        warn(`callMacro | "${macro}" called for ${macroPass} ${item?.name} ${item?.uuid}`);
      }
      values.push(this.callMacro(item, macro, macroData, options).catch((err) => {
        const message = `midi-qol | called macro error in ${item?.name} ${item?.uuid} macro ${macro}`;
        console.warn(message, err);
        TroubleShooter.recordError(err, message);
        return undefined
      }));
    }
    let results: Array<damageBonusMacroResult | any> = await Promise.allSettled(values);
    if (debugEnabled === 1 && results.length) warn("callMacros | macro data ", macroData);
    results = results.map(p => p.value);
    return results;
  }

  async callMacro(item, macroName: string, macroData: any, options: any): Promise<damageBonusMacroResult | any> {
    let [name, uuid] = macroName?.trim().split("|");
    let macroItem;
    if (uuid?.length > 0) {
      macroItem = MQfromUuidSync(uuid);
      if (macroItem instanceof ActiveEffect && macroItem.parent instanceof Item) {
        macroItem = macroItem.parent;
      }
    }
    const rolledItem = item;
    if (!name) return undefined;
    let itemMacroData;
    let macro;
    const actorToUse = options.actor ?? this.actor;
    try {
      if (name.startsWith("function.")) {
        let [func, uuid] = name.split("|");
        itemMacroData = {
          name: "function call",
          type: "script",
          command: `return await ${func.replace("function.", "").trim()}({ speaker, actor, token, character, item, rolledItem, macroItem, args, scope, workflow })`
        };
      } else if (name.startsWith(MQItemMacroLabel) || name.startsWith("ItemMacro")) {
        // ItemMacro
        // ItemMacro.ItemName
        // ItemMacro.uuid
        if (name === MQItemMacroLabel || name === "ItemMacro") {
          if (!item) return {};
          macroItem = item;
          itemMacroData = foundry.utils.getProperty(item, "flags.dae.macro") ?? foundry.utils.getProperty(macroItem, "flags.itemacro.macro");
          macroData.sourceItemUuid = macroItem?.uuid;
        } else {
          const parts = name.split(".");
          const itemNameOrUuid = parts.slice(1).join(".");
          macroItem = await fromUuid(itemNameOrUuid);
          // ItemMacro.name
          if (!macroItem) macroItem = actorToUse.items.find(i => i.name === itemNameOrUuid && (foundry.utils.getProperty(i.flags, "dae.macro") ?? foundry.utils.getProperty(i.flags, "itemacro.macro")))
          if (!macroItem && actorToUse instanceof Actor) {
            const itemId = uuid.split(".").slice(-1)[0];
            //@ts-expect-error
            const itemData = actorToUse.effects.find(effect => effect.flags.dae?.itemData?._id === itemId)?.flags.dae.itemData;
            if (itemData) macroItem = itemData;
          } else if (!macroItem) {
            console.warn("midi-qol | callMacro | No item for", name);
            return {};
          }
          itemMacroData = foundry.utils.getProperty(macroItem.flags, "dae.macro") ?? foundry.utils.getProperty(macroItem.flags, "itemacro.macro");
          macroData.sourceItemUuid = macroItem.uuid;
        }
      } else { // get a world/compendium macro.
        if (name.startsWith("Macro.")) name = name.replace("Macro.", "");
        macro = game.macros?.getName(name)
        if (!macro) {
          const itemOrMacro = await fromUuid(name);
          if (itemOrMacro instanceof Item) {
            macroData.sourceItemUuid = itemOrMacro.uuid;
            itemMacroData = foundry.utils.getProperty(itemOrMacro, "flags.dae.macro") ?? foundry.utils.getProperty(itemOrMacro, "flags.itemacro.macro");
          } else if (itemOrMacro instanceof Macro) macro = itemOrMacro;
        }

        if (macro?.type === "chat") {
          macro.execute(); // use the core foundry processing for chat macros
          return {}
        }
      }
      if (!itemMacroData && !macro) {
        const message = `Could not find item/macro ${name}`;
        TroubleShooter.recordError(new Error(message), message);
        ui.notifications?.error(`midi-qol | Could not find macro ${name} does not exist`);
        return undefined;
      }
      if (itemMacroData) {
        if (!itemMacroData.command) itemMacroData = itemMacroData.data;
        if (!itemMacroData?.command) {
          if (debugEnabled > 0) warn(`callMacro | could not find item macro ${name}`);
          return {};
        }
      }

      macroData.speaker = this.speaker;
      macroData.actor = actorToUse;
      if (!macro) {
        itemMacroData = foundry.utils.mergeObject({ name: "midi generated macro", type: "script", command: "" }, itemMacroData);
        //@ts-expect-error DOCUMENT_PERMISSION_LEVELS
        const OWNER = foundry.utils.isNewerVersion(game.data.version, "12.0") ? CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER : CONST.DOCUMENT_PERMISSION_LEVELS.OWNER;
        itemMacroData.ownership = { default: OWNER };
        itemMacroData.author = game.user?.id;
        macro = new CONFIG.Macro.documentClass(itemMacroData);
      }
      const speaker = this.speaker;
      const actor = actorToUse;
      const token = tokenForActor(actorToUse)
      const args = [macroData];

      const scope: any = {};
      scope.workflow = this;
      scope.activity = this.activity;
      scope.item = rolledItem;
      scope.rolledItem = rolledItem;
      scope.macroItem = macroItem ?? rolledItem;
      scope.args = args;
      scope.options = options;
      scope.actor = actor;
      scope.token = token;
      scope.midiData = macroData;
      return macro.execute(scope);
    } catch (err) {
      TroubleShooter.recordError(err, "callMacro: Error evaluating macro");
      ui.notifications?.error(`There was an error running your macro. See the console(F12) for details`);
      error("Error evaluating macro ", err)
    }
    return {};
  }

  async removeEffectsButton() {
    if (!this.itemCardUuid) return;
    const chatMessage = this.chatCard;
    if (chatMessage?.content) {
      const buttonRe = /<button data-action="applyEffects">[^<]*<\/button>/;
      let content = foundry.utils.duplicate(chatMessage.content);
      content = content?.replace(buttonRe, "");
      await debouncedUpdate(chatMessage, { content });
    }
  }

  async displayAttackRoll(displayOptions: any = {}) {
    const chatMessage = this.chatCard;
    let content = chatMessage && foundry.utils.duplicate(chatMessage.content);
    const flags = chatMessage?.flags || {};
    let newFlags = {};

    if (game.user?.isGM && this.useActiveDefence) {
      const searchRe = /<div class="midi-qol-attack-roll">[\s\S]*?<div class="end-midi-qol-attack-roll">/;
      let DCString = "DC";
      if (game.system.id === "dnd5e") {
        DCString = i18n(`${this.systemString}.AbbreviationDC`);
      } else if (i18n("SW5E.AbbreviationDC") !== "SW5E.AbbreviationDC") {
        DCString = i18n("SW5E.AbbreviationDC");
      }
      const attackString = `<label class="midi-qol-saveDC">${DCString} ${this.activeDefenceDC}</label> ${i18n("midi-qol.ActiveDefenceString")}`;
      const replaceString = `<div class="midi-qol-attack-roll"> <div style="text-align:center"> ${attackString} </div><div class="end-midi-qol-attack-roll">`;
      content = content.replace(searchRe, replaceString);
      const targetUuids = Array.from(this.targets).map(t => getTokenDocument(t)?.uuid);
      newFlags = foundry.utils.mergeObject(flags, {
        "midi-qol":
        {
          displayId: this.displayId,
          isCritical: this.isCritical,
          isFumble: this.isFumble,
          isHit: this.hitTargets.size > 0,
          isHitEC: this.hitTargetsEC.size > 0,
          targetUuids: Array.from(this.targets).map(t => getTokenDocument(t)?.uuid),
          hitTargetUuids: Array.from(this.hitTargets).map(t => getTokenDocument(t)?.uuid),
          hitECTargetUuids: Array.from(this.hitTargetsEC).map(t => getTokenDocument(t)?.uuid)
        }
      }, { overwrite: true, inplace: false });
    }
    if (chatMessage) { // display the attack roll
      //let searchRe = /<div class="midi-qol-attack-roll">.*?<\/div>/;
      let searchRe = /<div class="midi-qol-attack-roll">[\s\S]*?<div class="end-midi-qol-attack-roll">/
      let options: any = this.attackRoll?.terms[0].options;
      //@ts-expect-error advantageMode - advantageMode is set when the roll is actually done, options.advantage/disadvantage are what are passed into the roll
      const advantageMode = this.attackRoll?.options?.advantageMode;
      if (advantageMode !== undefined) {
        this.advantage = advantageMode === 1;
        this.disadvantage = advantageMode === -1;
      } else {
        this.advantage = options.advantage;
        this.disadvantage = options.disadvantage;
      }
      // const attackString = this.advantage ? i18n(`${this.systemString}.Advantage`) : this.disadvantage ? i18n(`${this.systemString}.Disadvantage`) : i18n(`${this.systemString}.Attack`)

      let attackString = this.advantage ? i18n(`${this.systemString}.Advantage`) : this.disadvantage ? i18n(`${this.systemString}.Disadvantage`) : i18n(`${this.systemString}.Attack`)
      if (configSettings.addFakeDice) // addFakeDice => roll 2d20 always - don't show advantage/disadvantage or players will know the 2nd d20 is fake
        attackString = i18n(`${this.systemString}.Attack`);

      let replaceString = `<div class="midi-qol-attack-roll"><div style="text-align:center" >${attackString}</div>${this.attackRollHTML}<div class="end-midi-qol-attack-roll">`

      content = content.replace(searchRe, replaceString);
      if (this.attackRollCount > 1) {
        const attackButtonRe = /<button data-action="attack" style="flex:3 1 0">(\[\d*\] )*([^<]+)<\/button>/;
        const match = content.match(attackButtonRe);
        content = content.replace(attackButtonRe, `<button data-action="attack" style="flex:3 1 0">[${this.attackRollCount}] $2</button>`);
        const confirmButtonRe = /<button class="midi-qol-confirm-damage-roll-complete" data-action="confirm-damage-roll-complete">(\[[\d ]*\])*([^<]+)<\/button>/;
        content = content.replace(confirmButtonRe, `<button class="midi-qol-confirm-damage-roll-complete" data-action="confirm-damage-roll-complete">[${this.attackRollCount} ${this.damageRollCount + 1}] $2</button>`);
      }

      if (this.attackRoll?.dice.length) {
        const d: any = this.attackRoll.dice[0]; // should be a dice term but DiceTerm.options not defined
        const isD20 = (d.faces === 20);
        if (isD20) {
          if (this.isCritical) {
            content = content.replace('dice-total', 'dice-total critical');
          } else if (this.isFumble) {
            content = content.replace('dice-total', 'dice-total fumble');
          } else if (d.options.target) {
            if ((this.attackRoll?.total || 0) >= d.options.target) content = content.replace('dice-total', 'dice-total success');
            else content = content.replace('dice-total', 'dice-total failure');
          }
          this.d20AttackRoll = d.total;
        }
      }
      if (debugEnabled > 0) warn("displayAttackRoll |", this.attackCardData, this.attackRoll)
      newFlags = foundry.utils.mergeObject(flags, {
        "midi-qol":
        {
          type: MESSAGETYPES.ATTACK,
          roll: this.attackRoll?.roll,
          displayId: this.displayId,
          isCritical: this.isCritical,
          isFumble: this.isFumble,
          isHit: this.hitTargets.size > 0,
          isHitEC: this.hitTargetsEC.size > 0,
          d20AttackRoll: this.d20AttackRoll,
          GMOnlyAttackRoll: displayOptions.GMOnlyAttackRoll ?? false,
          targetUuids: Array.from(this.targets).map(t => getTokenDocument(t)?.uuid),
          hitTargetUuids: Array.from(this.hitTargets).map(t => getTokenDocument(t)?.uuid),
          hitECTargetUuids: Array.from(this.hitTargetsEC).map(t => getTokenDocument(t)?.uuid)
        }
      }, { overwrite: true, inplace: false }
      )
    }
    // for active defence, this.attackRoll is undefined, thus create the array like this to prevent errors further on
    const rolls = [...(this.attackRoll ? [this.attackRoll] : []), ...(this.extraRolls ?? [])];
    await debouncedUpdate(chatMessage, { content, flags: newFlags, rolls: rolls }, true);

  }

  async displayDamageRolls() {
    const chatMessage = this.chatCard;
    if (!chatMessage) debugger;
    let content = (chatMessage && foundry.utils.duplicate(chatMessage.content)) ?? "";
    if ((getRemoveDamageButtons(this.item) && configSettings.confirmAttackDamage === "none") || this.workflowType === "TrapWorkflow") {
      const versatileRe = /<button data-action="versatile">[^<]*<\/button>/
      const damageRe = /<button data-action="damage">[^<]*<\/button>/
      const formulaRe = /<button data-action="formula">[^<]*<\/button>/
      content = content?.replace(damageRe, "<div></div>")
      content = content?.replace(formulaRe, "")
      content = content?.replace(versatileRe, "")
    }
    var newFlags = chatMessage?.flags || {};
    if (chatMessage) {
      if (this.damageRollHTML) {
        if (!this.useOther) {
          const searchRe = /<div class="midi-qol-damage-roll">[\s\S]*?<div class="end-midi-qol-damage-roll">/;
          const replaceString = `<div class="midi-qol-damage-roll"><div style="text-align:center">${this.damageFlavor}</div>${this.damageRollHTML || ""}<div class="end-midi-qol-damage-roll">`
          content = content.replace(searchRe, replaceString);
        } else {
          const otherSearchRe = /<div class="midi-qol-other-damage-roll">[\s\S]*?<div class="end-midi-qol-other-damage-roll">/;
          const otherReplaceString = `<div class="midi-qol-other-damage-roll"><div style="text-align:center">${this.damageFlavor}</div>${this.damageRollHTML || ""}<div class="end-midi-qol-other-ddamage-roll">`
          content = content.replace(otherSearchRe, otherReplaceString);
        }
        if (this.otherDamageRollHTML) {
          const otherSearchRe = /<div class="midi-qol-other-damage-roll">[\s\S]*?<div class="end-midi-qol-other-damage-roll">/;
          const otherReplaceString = `<div class="midi-qol-other-damage-roll"><div style="text-align:center" >${this.otherDamageFlavor}${this.otherDamageRollHTML || ""}</div><div class="end-midi-qol-other-damage-roll">`
          content = content.replace(otherSearchRe, otherReplaceString);
        }
        if (this.bonusDamageRolls) {
          const bonusSearchRe = /<div class="midi-qol-bonus-damage-roll">[\s\S]*?<div class="end-midi-qol-bonus-damage-roll">/;
          const bonusReplaceString = `<div class="midi-qol-bonus-damage-roll"><div style="text-align:center" >${this.bonusDamageFlavor}${this.bonusDamageHTML || ""}</div><div class="end-midi-qol-bonus-damage-roll">`
          content = content.replace(bonusSearchRe, bonusReplaceString);
        }
      } else {
        if (this.otherDamageRollHTML) {
          const otherSearchRe = /<div class="midi-qol-damage-roll">[\s\S]*?<div class="end-midi-qol-damage-roll">/;
          const otherReplaceString = `<div class="midi-qol-damage-roll"><div style="text-align:center">${this.otherDamageFlavor}</div>${this.otherDamageRollHTML || ""}<div class="end-midi-qol-damage-roll">`
          content = content.replace(otherSearchRe, otherReplaceString);
        }
        if (this.bonusDamageRolls) {
          const bonusSearchRe = /<div class="midi-qol-bonus-damage-roll">[\s\S]*?<div class="end-midi-qol-bonus-damage-roll">/;
          const bonusReplaceString = `<div class="midi-qol-bonus-damage-roll"><div style="text-align:center" >${this.bonusDamageFlavor}</div>${this.bonusDamageHTML || ""}<div class="end-midi-qol-bonus-damage-roll">`
          content = content.replace(bonusSearchRe, bonusReplaceString);
        }
      }

      this.displayId = foundry.utils.randomID();
      const dnd5eAttackTargets = Array.from(this.targets).map(token => {
        const t = getTokenDocument(token);
        return {
          name: t?.actor?.name,
          img: t?.actor?.img,
          uuid: t?.actor?.uuid,
          //@ts-expect-error
          ac: t?.actor?.system?.attributes.ac.value,
        }
      })
      newFlags = foundry.utils.mergeObject(newFlags, {
        "midi-qol": {
          type: MESSAGETYPES.DAMAGE,
          // roll: this.damageCardData.roll,
          roll: this.chatRolls,
          damageDetail: this.useOther ? undefined : this.rawDamageDetail,
          damageTotal: this.useOther ? undefined : this.damageTotal,
          otherDamageDetail: this.useOther ? this.rawDamageDetail : this.rawOtherDamageDetail,
          otherDamageTotal: this.useOther ? this.damageTotal : this.otherDamageTotal,
          bonusDamageDetail: this.rawBonusDamageDetail,
          bonusDamageTotal: this.bonusDamageTotal,
          displayId: this.displayId
        },
        "dnd5e": {
          targets: dnd5eAttackTargets
        }
      }, { overwrite: true, inplace: false });
    }

    if (this.damageRollCount > 1) {
      const damageButtonRe = /<button data-action="damage" style="flex:3 1 0">(\[\d*\] )*([^<]+)<\/button>/;
      content = content.replace(damageButtonRe, `<button data-action="damage" style="flex:3 1 0">[${this.damageRollCount}] $2</button>`);
      const confirmButtonRe = /<button class="midi-qol-confirm-damage-roll-complete" data-action="confirm-damage-roll-complete">(\[[\d ]*\])*([^<]+)<\/button>/;
      content = content.replace(confirmButtonRe, `<button class="midi-qol-confirm-damage-roll-complete" data-action="confirm-damage-roll-complete">[${this.attackRollCount} ${Math.max(this.damageRollCount, 1)}] $2</button>`);
    } else {
      const damageButtonRe = /<button data-action="damage" style="flex:3 1 0">(\[\d*\] )*([^<]+)<\/button>/;
      content = content.replace(damageButtonRe, `<button data-action="damage" style="flex:3 1 0">$2</button>`);
    }

    const result = await debouncedUpdate(chatMessage, { "content": content, flags: newFlags, rolls: this.chatRolls }, false);
    // await chatMessage?.update({ "content": content, flags: newFlags, rolls: (messageRolls) });
    return result

  }

  async displayTargets(whisper = false) {
    this.hitDisplayData = {};
    this.targetsDisplayed = true;
    if (this.item.type === "feat" && ["ench", "class", undefined].includes(this.item.system.actionType)) return;
    for (let target of this.targets) {
      const targetToken = getToken(target);
      if (!targetToken) continue;
      //@ts-expect-error .texture
      let img = targetToken.document?.texture.src ?? targetToken.actor?.img;
      if (configSettings.usePlayerPortrait && targetToken.actor?.type === "character") {
        //@ts-expect-error .texture
        img = targetToken.actor?.img ?? targetToken.document?.texture.src;
      }
      if (VideoHelper.hasVideoExtension(img ?? "")) {
        img = await game.video.createThumbnail(img ?? "", { width: 100, height: 100 });
      }
      const tokenUuid = getTokenDocument(targetToken)?.uuid ?? "";
      this.hitDisplayData[tokenUuid] = {
        isPC: targetToken.actor?.hasPlayerOwner,
        target: targetToken,
        hitClass: "",
        acClass: targetToken.actor?.hasPlayerOwner ? "" : "midi-qol-npc-ac",
        img,
        gmName: getTokenName(targetToken),
        playerName: getTokenPlayerName(targetToken),
        uuid: targetToken.uuid,
        showAC: true,
        isHit: this.hitTargets.has(targetToken)
      };
    }
    await this.displayHits(whisper, false);
  }

  async displayHits(whisper = false, showHits = true) {
    this.targetsDisplayed = true;
    const templateData = {
      attackType: this.item?.name ?? "",
      attackTotal: this.attackTotal,
      oneCard: true,
      collapsibleTargets: configSettings.collapsibleTargets,
      showHits,
      hits: this.hitDisplayData,
      isGM: game.user?.isGM,
      displayHitResultNumeric: configSettings.displayHitResultNumeric && !this.isFumble && !this.isCritical
    };
    if (debugEnabled > 0) warn("displayHits |", templateData, whisper);
    const hitContent = await renderTemplate("modules/midi-qol/templates/hits.html", templateData) || "No Targets";
    const chatMessage = this.chatCard;

    if (chatMessage) {
      var content = chatMessage && foundry.utils.duplicate(chatMessage.content);
      var searchString;
      var replaceString;
      searchString = /<div class="midi-qol-hits-display">[\s\S]*?<div class="end-midi-qol-hits-display">/;
      replaceString = `<div class="midi-qol-hits-display">${hitContent}<div class="end-midi-qol-hits-display">`
      content = content.replace(searchString, replaceString);

      const update: any = {
        "content": content,
        timestamp: Date.now(),
        "flags.midi-qol.type": MESSAGETYPES.HITS,
        "flags.midi-qol.displayId": this.displayId,
      }
      //@ts-expect-error
      if (game.release.generation < 12) {
        update.type = CONST.CHAT_MESSAGE_TYPES.OTHER;
      } else {
        //@ts-expect-error
        update.style = CONST.CHAT_MESSAGE_STYLES.OTHER;
      }
      await debouncedUpdate(chatMessage, update);
    }
  }

  async displaySaves(whisper) {
    let chatData: any = {};
    let fullDamage: string[] = [];
    let noDamage: string[] = [];
    let halfDamage: string[] = [];
    let saveString = "";
    let fullDamageText = "";
    let noDamageText = "";
    let halfDamageText = "";
    // TODO display bonus damage if required
    this.targetsDisplayed = true;
    if ((this.activity.save || this.activity.check || this.otherActivity?.save || this.otherActivity?.check) && this.activity.damage.parts.length > 0) {
      switch (getsaveMultiplierForActivity(this.activity)) {
        case 0:
          noDamage.push(`${i18n("midi-qol.BaseDamageFlavor")} &#48;`)
          break;
        case 1:
          fullDamage.push(`${i18n("midi-qol.BaseDamageFlavor")} &#49;`)
          break;
        default:
          halfDamage.push(`${i18n("midi-qol.BaseDamageFlavor")} &frac12;`);
      }
    }
    if ((this.otherActivity?.save || this.otherActivity?.check) && this.otherActivity?.damage.parts.length > 0) {
      switch (getsaveMultiplierForActivity(this.otherActivity)) {
        case 0:
          noDamage.push(`${i18n("midi-qol.OtherDamageFlavor")} &#48;`)
          break;
        case 1:
          fullDamage.push(`${i18n("midi-qol.OtherDamageFlavor")} &#49;`)
          break;
        default:
          halfDamage.push(`${i18n("midi-qol.OtherDamageFlavor")} &frac12;`);
      }
    }

    if (fullDamage.length > 0) fullDamageText = i18nFormat("midi-qol.fullDamageText", { damageType: fullDamage.join(", ") });
    if (noDamage.length > 0) noDamageText = i18nFormat("midi-qol.noDamageText", { damageType: noDamage.join(", ") });
    if (halfDamage.length > 0) halfDamageText = i18nFormat("midi-qol.halfDamageText", { damageType: halfDamage.join(", ") });
    let templateData = {
      fullDamageText,
      halfDamageText,
      noDamageText,
      saveDisplayFlavor: this.saveDisplayFlavor,
      saves: this.saveDisplayData,
      // TODO force roll damage
    }
    let chatMessage = this.chatCard;
    if (chatMessage) {
      templateData.saveDisplayFlavor = this.saveDisplayFlavor;
      const saveContent = await renderTemplate("modules/midi-qol/templates/saves.html", templateData);
      chatMessage = this.chatCard;
      let content = foundry.utils.duplicate(chatMessage.content)
      var searchString;
      var replaceString;
      //@ts-expect-error
      let dnd5eTargets: TokenDocument[] = Array.from(this.targets.map(t => getTokenDocument(t))).filter(t => t);
      let dnd5eTargetDetails;
      if (dnd5eTargets.length) {
        //@ts-expect-error
        const saves = this.saves?.map(t => getTokenDocument(t)?.uuid);
        //@ts-expect-error
        const semiSuperSavers = this.semiSuperSavers?.map(t => getTokenDocument(t)?.uuid);
        //@ts-expect-error
        const superSavers = this.superSavers?.map(t => getTokenDocument(t)?.uuid);

        dnd5eTargetDetails = dnd5eTargets.map(t => {
          let uncannyDodge = foundry.utils.getProperty(t, `actor.flags.${MODULE_ID}.uncanny-dodge`) && this.activity?.attack;
          let saveMults: any = {};
          saveMults["otherDamage"] = this.otherActivity ? getsaveMultiplierForActivity(this.otherActivity) : 1;
          saveMults["defaultDamage"] = getsaveMultiplierForActivity(this.activity);
          saveMults["bonusDamage"] = getsaveMultiplierForActivity(this.activity);
          return {
            name: t?.actor?.name,
            img: t?.actor?.img,
            uuid: t?.actor?.uuid,
            //@ts-expect-error
            ac: t?.actor?.system.attributes.ac.value,
            saved: saves?.has(t.uuid),
            semiSuperSaver: semiSuperSavers?.has(t.uuid),
            superSaver: superSavers?.has(t.uuid),
            saveMults,
            itemType: this.item.type,
            uncannyDodge
          }
        })
      }
      if (this.workflowType !== "DamageOnlyWorkflow") {
        searchString = /<div class="midi-qol-saves-display">[\s\S]*?<div class="end-midi-qol-saves-display">/;
        replaceString = `<div class="midi-qol-saves-display"><div data-item-id="${this.item.id}">${saveContent}</div><div class="end-midi-qol-saves-display">`
        content = content.replace(searchString, replaceString);
        const update: any = {
          content,
          rolls: this.chatRolls,
          "flags.midi-qol.type": MESSAGETYPES.SAVES,
          "flags.midi-qol.saveUuids": Array.from(this.saves).map(t => getTokenDocument(t)?.uuid),
          "flags.midi-qol.failedSaveUuids": Array.from(this.failedSaves).map(t => getTokenDocument(t)?.uuid),
          "flags.dnd5e.targets": dnd5eTargetDetails
        };
        //@ts-expect-error
        if (game.release.generation < 12) {
          update.type = CONST.CHAT_MESSAGE_TYPES.OTHER;
        } else {
          //@ts-expect-error
          update.style = CONST.CHAT_MESSAGE_STYLES.OTHER;
        }
        await debouncedUpdate(chatMessage, update, true);
      }
    }
  }

  get chatRolls(): Roll[] {
    let messageRolls: Roll[] = [];
    if (this.attackRoll) messageRolls.push(this.attackRoll);
    if (this.damageRolls) messageRolls.push(...this.damageRolls);
    if (this.bonusDamageRolls) messageRolls.push(...this.bonusDamageRolls);
    if (this.otherDamageRolls) messageRolls.push(...this.otherDamageRolls);
    if (this.saveRolls) messageRolls.push(...this.saveRolls);
    return messageRolls;
  }

  /**
   * update this.saves to be a Set of successful saves from the set of tokens this.hitTargets and failed saves to be the complement
   */
  async checkSaves(whisper = false, simulate = false) {
    this.saveRolls = [];
    this.tokenSaves = {};
    if (debugEnabled > 1) debug(`checkSaves: whisper ${whisper}  hit targets ${this.hitTargets}`)
    if (this.hitTargets.size <= 0 && this.hitTargetsEC.size <= 0) {
      this.saveDisplayFlavor = `<span>${i18n("midi-qol.noSaveTargets")}</span>`
      return;
    }

    if (!this.saveActivity) return;
    //@ts-expect-error
    if (!evalActivationCondition(this, this.saveActivity.useCondition, this.targets.first())) return;
    const allHitTargets = new Set([...this.hitTargets, ...this.hitTargetsEC]);
    if (allHitTargets.size === 0) return;
    let rollDC = this.saveActivity?.save?.dc.value ?? this.saveActivity?.check?.dc.value;
    //@ts-expect-error 
    const D20Roll = CONFIG.Dice.D20Roll;
    this.saveDC = rollDC;
    let promises: Promise<any>[] = [];
    var rollAction;
    var rollType
    var flagRollType;
    let rollAbility;
    if (this.saveActivity.save) {
      rollType = "save";
      if (this.saveActivity.save.ability instanceof Set) {
        // TODO work out how to let the player choose the save for dnd5e 4.1
        rollAbility = this.saveActivity.save.ability.first();
      }
      else rollAbility = this.saveActivity.save.ability;
      //@ts-expect-error actor
      rollAction = CONFIG.Actor.documentClass.prototype.rollSavingThrow;
    } else if (this.saveActivity.check) {
      if (this.saveActivity.check.associated.size > 0) {
        if (this.saveActivity.check.ability === "") { //this is a tool check
          //@ts-expect-error
          rollAction = CONFIG.Actor.documentClass.prototype.rollToolCheck;
          rollType = "tool";
          rollAbility = this.saveActivity.check.associated.first();
        } else {
          rollType = "skill";
          rollAbility = this.saveActivity.check.ability;
          rollAbility = this.saveActivity.check.associated.first();
          //@ts-expect-error 
          rollAction = CONFIG.Actor.documentClass.prototype.rollSkill;
        }
      } else {
        rollType = "check";
        rollAbility = this.saveActivity.check.ability;
        //@ts-expect-error actor.rollAbilityTest
        rollAction = CONFIG.Actor.documentClass.prototype.rollAbilityCheck;
      }
    }
    /* the correct activity should be passed so no check needed else {
      const midiFlags = foundry.utils.getProperty(this.item, `flags.${MODULE_ID}`);
      if (midiFlags?.overTimeSkillRoll) {
        rollType = "skill"
        flagRollType = "skill";
        //@ts-expect-error actor.rollAbilityTest
        rollAction = CONFIG.Actor.documentClass.prototype.rollSkill;
        this.activity.save.ability = midiFlags.overTimeSkillRoll;
      }
    }
    */

    if (this.chatUseFlags?.babonus?.saveDC) {
      rollDC = this.chatUseFlags.babonus.saveDC;
    }
    const playerMonksTB = !simulate && installedModules.get("monks-tokenbar") && configSettings.playerRollSaves === "mtb";
    const playerEpicRolls = !simulate && installedModules.get("epic-rolls-5e") && configSettings.playerRollSaves === "rer"
    let monkRequestsPlayer: any[] = [];
    let rerRequestsPlayer: any[] = [];
    let monkRequestsGM: any[] = [];
    let rerRequestsGM: any[] = [];
    let showRoll = configSettings.autoCheckSaves === "allShow";
    if (simulate) showRoll = false;
    const isMagicSave = this.item?.type === "spell" || this.item?.flags.midiProperties?.magiceffect || this.item?.flags.midiProperties?.magiceffect;

    try {

      let actorDisposition;
      if (this.token && this.token.document?.disposition) actorDisposition = this.token.document.disposition;
      else { // no token to use so make a guess
        actorDisposition = this.actor?.type === "npc" ? -1 : 1;
      }

      for (let target of allHitTargets) {
        if (!foundry.utils.getProperty(this.item, `flags.${MODULE_ID}.noProvokeReaction`)) {
          //@ts-expect-error
          await doReactions(target, this.tokenUuid, this.attackRoll, "reactionsave", { workflow: this, activity: this.activity, item: this.item })
        }
        if (!target?.actor) continue;
        //@ts-expect-error token: target for some reason vscode can't work out target is not null
        const conditionData = createConditionData({ workflow: this, token: target, actor: target.actor });
        const saveDetails: {
          advantage: boolean | undefined,
          disadvantage: boolean | undefined,
          isFriendly: boolean | undefined,
          isMagicSave: boolean | undefined,
          isConcentrationCheck: boolean | undefined,
          rollDC: number,
          saveItemUuid: string,
          workflowOptions: object
        } = {
          advantage: undefined,
          disadvantage: undefined,
          isMagicSave: isMagicSave,
          isFriendly: undefined,
          isConcentrationCheck: undefined,
          rollDC: rollDC,
          saveItemUuid: "",
          workflowOptions: this.workflowOptions
        };
        const targetDocument = getTokenDocument(target);
        //@ts-expect-error
        saveDetails.isFriendly = targetDocument?.disposition === actorDisposition;
        if (!target.actor) continue;  // no actor means multi levels or bugged actor - but we won't roll a save
        saveDetails.advantage = undefined;
        saveDetails.disadvantage = undefined;
        saveDetails.isMagicSave = isMagicSave;
        saveDetails.rollDC = rollDC;
        saveDetails.saveItemUuid = this.item.uuid;
        let magicResistance: Boolean = false;
        let magicVulnerability: Boolean = false;
        // If spell, check for magic resistance
        if (isMagicSave) {
          // check magic resistance in custom damage reduction traits
          //@ts-expect-error .system
          saveDetails.advantage = (targetDocument?.actor?.system.traits?.dr?.custom || "").includes(i18n("midi-qol.MagicResistant").trim());
          // check magic resistance as a feature (based on the SRD name as provided by the DnD5e system)
          saveDetails.advantage = saveDetails.advantage || target?.actor?.items.find(a => a.type === "feat" && a.name === i18n("midi-qol.MagicResistanceFeat").trim()) !== undefined;
          if (!saveDetails.advantage) saveDetails.advantage = undefined;
          if (await evalAllConditionsAsync(target.actor, `flags.${MODULE_ID}.magicResistance.all`, conditionData)
            || await evalAllConditionsAsync(target.actor, `flags.${MODULE_ID}.magicResistance.${rollAbility}`, conditionData)) {
            saveDetails.advantage = true;
            magicResistance = true;
          }
          if (await evalAllConditionsAsync(target.actor, `flags.${MODULE_ID}.magicVulnerability.all`, conditionData)
            || await evalAllConditionsAsync(target.actor, `flags.${MODULE_ID}.magicVulnerability.${rollAbility}`, conditionData)) {
            saveDetails.disadvantage = true;
            magicVulnerability = true;
          }
          if (debugEnabled > 1) debug(`${target.actor.name} resistant to magic : ${saveDetails.advantage}`);
          if (debugEnabled > 1) debug(`${target.actor.name} vulnerable to magic : ${saveDetails.disadvantage}`);
        }
        const settingsOptions = await procAbilityAdvantage(target.actor, rollType, this.saveActivity.save?.ability ?? this.saveActivity.check?.ability, { workflow: this });
        if (settingsOptions.advantage) saveDetails.advantage = true;
        if (settingsOptions.disadvantage) saveDetails.disadvantage = true;
        saveDetails.isConcentrationCheck = this.item.flags?.[MODULE_ID]?.isConcentrationCheck;
        // The rollAbilitycheck function eventually calss actor.rollConcentration so all the falgs are set.

        // Check grants save fields
        if (await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.grants.advantage.all`, conditionData)
          || await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.grants.advantage.${flagRollType}.all`, conditionData)
          || await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.grants.advantage.${flagRollType}.${rollAbility}`, conditionData)) {
          saveDetails.advantage = true;
        }
        if (await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.grants.disadvantage.all`, conditionData)
          || await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.grants.disadvantage.${flagRollType}.all`, conditionData)
          || await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.grants.disadvantage.${flagRollType}.${rollAbility}`, conditionData)) {
          saveDetails.disadvantage = true;
        }

        if (saveDetails.advantage && !saveDetails.disadvantage) this.advantageSaves.add(target);
        else if (saveDetails.disadvantage && !saveDetails.advantage) this.disadvantageSaves.add(target);
        var player = playerFor(target);
        //@ts-expect-error
        if (!player || !player.active) player = game.users?.actveGM;
        let promptPlayer = !player?.isGM && !(["none", "noneDialog"].includes(configSettings.playerRollSaves));
        let showRollDialog = !player?.isGM && "noneDialog" === configSettings.playerRollSaves;
        if (simulate) promptPlayer = false;
        let GMprompt;
        let gmMonksTB;
        let gmRER;
        let playerRER = !player?.isGM && ["rer"].includes(configSettings.playerRollSaves);
        const playerChat = !player?.isGM && ["chat"].includes(configSettings.playerRollSaves);
        if (player?.isGM) {
          const targetDocument = getTokenDocument(target);
          const monksTBSetting = targetDocument?.isLinked ? configSettings.rollNPCLinkedSaves === "mtb" : configSettings.rollNPCSaves === "mtb"
          const epicRollsSetting = targetDocument?.isLinked ? configSettings.rollNPCLinkedSaves === "rer" : configSettings.rollNPCSaves === "rer"
          gmMonksTB = installedModules.get("monks-tokenbar") && monksTBSetting;
          gmRER = installedModules.get("epic-rolls-5e") && epicRollsSetting;
          GMprompt = (targetDocument?.isLinked ? configSettings.rollNPCLinkedSaves : configSettings.rollNPCSaves);

          promptPlayer = !["auto", "autoDialog"].includes(GMprompt);
          showRollDialog = GMprompt === "autoDialog";
          if (simulate) {
            gmMonksTB = false;
            GMprompt = false;
            gmRER = false;
            promptPlayer = false;
            showRollDialog = false;
          }
        }

        this.saveDetails = saveDetails;
        //@ts-expect-error [target]
        if (configSettings.allowUseMacro && this.options.noTargetOnusemacro !== true) await this.triggerTargetMacros(["preTargetSave"], [target]);

        if (saveDetails.isFriendly &&
          (this.item.system.description.value.toLowerCase().includes(i18n("midi-qol.autoFailFriendly").toLowerCase())
            || this.item.flags.midiProperties?.autoFailFriendly)) {
          promises.push(new D20Roll("-1").evaluate());
        } else if (saveDetails.isFriendly && this.item.flags.midiProperties?.autoSaveFriendly) {
          promises.push(new D20Roll("99").evaluate());
        } else if ((!player?.isGM && playerMonksTB) || (player?.isGM && gmMonksTB)) {
          promises.push(new Promise((resolve) => {
            let requestId = target.id ?? foundry.utils.randomID();
            this.saveRequests[requestId] = resolve;
          }));

          if (isMagicSave) {
            if (magicResistance) saveDetails.advantage = true;
            if (magicVulnerability) saveDetails.disadvantage = true;
          }
          const requests = player?.isGM ? monkRequestsGM : monkRequestsPlayer;
          requests.push({
            token: target.id,
            dc: saveDetails.rollDC,
            showdc: configSettings.displaySaveDC,
            advantage: saveDetails.advantage, // seems that monks ignores this again - set alt/ctrl key
            altKey: saveDetails.advantage === true,
            disadvantage: saveDetails.disadvantage, // seems that monks ignores this again - set alt/ctrl key
            ctrlKey: saveDetails.disadvantage === true,
            fastForward: false,
            isMagicSave,
            isConcentrationCheck: saveDetails.isConcentrationCheck,
            workflowOptions: saveDetails.workflowOptions
          })
        } else if ((!player?.isGM && playerEpicRolls) || (player?.isGM && gmRER)) {
          promises.push(new Promise((resolve) => {
            let requestId = target?.actor?.uuid ?? foundry.utils.randomID();
            this.saveRequests[requestId] = resolve;
          }));

          if (isMagicSave) {
            if (magicResistance) saveDetails.advantage = true;
            if (magicVulnerability) saveDetails.disadvantage = true;
          }
          const requests = player?.isGM ? rerRequestsGM : rerRequestsPlayer;
          requests.push({
            actorUuid: target.actor.uuid,
            token: target.id,
            advantage: saveDetails.advantage,
            disadvantage: saveDetails.disadvantage,
            dc: saveDetails.rollDC,
            showdc: configSettings.displaySaveDC,
            // altKey: advantage === true,
            // ctrlKey: disadvantage === true,
            fastForward: false,
            isMagicSave,
            isconcentrationCheck: saveDetails.isConcentrationCheck, // Not sure if epic rolls will pick this up
            workflowOptions: saveDetails.workflowOptions
          })
        } else {
          // Find a player owner for the roll if possible
          let owner: User | undefined = playerFor(target);
          if (!owner?.isGM && owner?.active) showRoll = true; // Always show player save rolls
          //@ts-expect-error ,.activeGM - If no player owns the token, find an active GM
          if (!owner?.active) owner = game.users?.activeGM;
          // Fall back to rolling as the current user
          if (!owner) owner = game.user ?? undefined;
          promises.push(socketlibSocket.executeAsUser("rollAbilityV2", owner?.id, {
            targetUuid: target.actor.uuid,
            request: rollType,
            ability: rollAbility,
            // showRoll: whisper && !simulate,
            options: {
              simulate,
              targetValue: saveDetails.rollDC,
              messageData: { user: owner?.id },
              chatMessage: showRoll,
              rollMode: whisper ? "gmroll" : "public",
              mapKeys: false,
              advantage: saveDetails.advantage,
              disadvantage: saveDetails.disadvantage,
              fastForward: simulate || !showRollDialog,
              isMagicSave,
              saveItemUuid: this.item.uuid,
              isConcentrationCheck: saveDetails.isConcentrationCheck,
              workflowOptions: saveDetails.workflowOptions
            },
          }));
        }
      }
    } catch (err) {
      TroubleShooter.recordError(err);
      console.warn(err)
    } finally {
    }
    const monkRequests = monkRequestsPlayer.concat(monkRequestsGM);

    if (!whisper && monkRequests.length > 0) {
      const requestData: any = {
        tokenData: monkRequests,
        request: `${rollType === "check" ? "ability" : rollType}:${rollAbility}`,
        silent: true,
        showdc: configSettings.displaySaveDC,
        rollMode: whisper ? "gmroll" : "roll" // should be "publicroll" but monks does not check it
      };
      // Display dc triggers the tick/cross on monks tb
      if (configSettings.displaySaveDC && "whisper" !== configSettings.autoCheckSaves) requestData.dc = rollDC
      timedExecuteAsGM("monksTokenBarSaves", requestData);
    } else if (monkRequestsPlayer.length > 0 || monkRequestsGM.length > 0) {
      const requestDataGM: any = {
        tokenData: monkRequestsGM,
        request: `${rollType === "check" ? "ability" : rollType}:${rollAbility}`,
        silent: true,
        rollMode: whisper ? "selfroll" : "roll", // should be "publicroll" but monks does not check it
        isMagicSave,
        saveItemUuid: this.item.uuid,
        isConcentrationCheck: this.item.flags[MODULE_ID]?.isConcentrationCheck,
        workflowOptions: this.workflowOptions
      }
      const requestDataPlayer: any = {
        tokenData: monkRequestsPlayer,
        request: `${rollType === "check" ? "ability" : rollType}:${rollAbility}`,
        silent: true,
        rollMode: "roll",// should be "publicroll" but monks does not check it
        isMagicSave,
        saveItemUuid: this.item.uuid
      }
      // Display dc triggers the tick/cross on monks tb
      if (configSettings.displaySaveDC && "whisper" !== configSettings.autoCheckSaves) {
        requestDataPlayer.dc = rollDC
        requestDataGM.dc = rollDC
      }
      if (monkRequestsPlayer.length > 0) {
        timedExecuteAsGM("monksTokenBarSaves", requestDataPlayer);
      };
      if (monkRequestsGM.length > 0) {
        timedExecuteAsGM("monksTokenBarSaves", requestDataGM);
      };
    }
    const rerRequests = rerRequestsPlayer.concat(rerRequestsGM);
    if (rerRequests.length > 0) {
      // rollType is save/abil/skill
      const rerType = rollType;
      const rerRequest: any = {
        actors: rerRequests.map(request => request.actorUuid),
        contestants: [],
        type: `${rerType}.${this.saveActivity.save.ability ?? this.saveActivity.check.ability}`,
        options: {
          DC: rollDC,
          showDC: configSettings.displaySaveDC,
          blindRoll: configSettings.autoCheckSaves === "whisper",
          showRollResults: false, // configSettings.autoCheckSaves === "allShow",
          hideNames: true,
          noMessage: true,
          rollSettings: rerRequests.map(request => ({
            advantage: request.advantage,
            disadvantage: request.disadvantage,
            uuid: request.actorUuid
          })),
          isConcentrationCheck: this.item.flags[MODULE_ID]?.isConcentrationCheck,
          workflowOptions: this.workflowOptions
        }
      };
      //@ts-expect-error
      ui?.EpicRolls5e.requestRoll(rerRequest).then((rerResult: any) => {
        if (rerResult.cancelled) {
          let roll = new Roll("-1");
          //@ts-expect-error
          roll = roll.evaluateSync({ strict: false })
          for (let uuid of rerRequest.actors) {
            const fn = this.saveRequests[uuid];
            delete this.saveRequests[uuid];
            fn(roll)
          }
        } else for (let rerRoll of rerResult.results) {
          const actorUuid = rerRoll.actor.uuid;
          const fn = this.saveRequests[actorUuid];
          delete this.saveRequests[actorUuid];
          const roll = Roll.fromJSON(JSON.stringify(rerRoll.roll));
          fn(roll);
        }
      })
    };

    if (debugEnabled > 1) debug("check saves: requests are ", this.saveRequests)
    var results = await Promise.all(promises);
    if (rerRequests?.length > 0) await busyWait(0.01);
    delete this.saveDetails;
    for (let i = 0; i < results.length; i++) {
      if (results[i] instanceof Roll) results[i] = [results[i]];
      if (results[i] instanceof Array)
        for (let j = 0; j < results[i].length; j++) {
          if (!(results[i][j] instanceof Roll)) {
            //@ts-expect-error
            results[i][j] = CONFIG.Dice.D20Roll.fromJSON(JSON.stringify(results[i][j]));
          }
        }
    }
    this.saveResults = results;
    let i = 0;
    if (activityHasAreaTarget(this.activity) && this.templateUuid) {
      const templateDocument = await fromUuid(this.templateUuid);
      //@ts-expect-error
      var template = templateDocument?.object;
    }
    for (let tokenOrDocument of allHitTargets) {
      let target = getToken(tokenOrDocument)
      const targetDocument = getTokenDocument(tokenOrDocument);
      if (!target?.actor || !target || !targetDocument) continue; // these were skipped when doing the rolls so they can be skipped now
      if (!results[i]?.[0] || results[i]?.[0]?.total === undefined) {
        const message = `Token ${target?.name} could not roll save/check assuming 1`;
        error(message, target);
        TroubleShooter.recordError(new Error(message), message);
        results[i] = [await new Roll("1").evaluate()];
      }

      let result = results[i];
      let saveRollTotal = result.reduce((acc, r) => acc + r.total, 0);
      let saveRolls = result;
      if (result[0]?.options?.advantage) this.advantageSaves.add(target);
      else this.advantageSaves.delete(target);
      if (result[0]?.options?.disadvantage) this.disadvantageSaves.add(target);
      else this.disadvantageSaves.delete(target);
      if (this.advantageSaves.has(target) && this.disadvantageSaves.has(target)) {
        this.advantageSaves.delete(target);
        this.disadvantageSaves.delete(target);
      }
      let isFumble = false;
      let isCritical = false;
      if (saveRolls[0]?.terms) { // normal d20 roll/monks roll
        const dterm: DiceTerm = saveRolls[0].terms[0];
        const diceRoll = dterm?.results?.find(result => result.active)?.result ?? saveRollTotal;
        //@ts-expect-error
        isFumble = diceRoll <= (dterm.options?.fumble ?? 1)
        //@ts-expect-error
        isCritical = diceRoll >= (dterm.options?.critical ?? 20);
      }
      let coverSaveBonus = 0;

      if (this.item && this.activityHasSave && rollAbility === "dex") {
        if (this.activity?.actionType === "rsak" && foundry.utils.getProperty(this.actor, "flags.dnd5e.spellSniper"))
          coverSaveBonus = 0;
        else if (this.activity?.actionType === "rwak" && foundry.utils.getProperty(this.actor, `flags.${MODULE_ID}.sharpShooter`))
          coverSaveBonus = 0;
        else if (activityHasAreaTarget(this.activity) && template) {
          const position = foundry.utils.duplicate(template.center);
          const dimensions = canvas?.dimensions;
          if (template.document.t === "rect") {
            position.x += template.document.width / (dimensions?.distance ?? 5) / 2 * (dimensions?.size ?? 100);
            position.y += template.document.width / (dimensions?.distance ?? 5) / 2 * (dimensions?.size ?? 100);
          }
          if (configSettings.optionalRules.coverCalculation === "levelsautocover"
            && installedModules.get("levelsautocover")) {
            coverSaveBonus = computeCoverBonus({
              center: position,
              document: {
                //@ts-expect-error
                elevation: template.document.elevation,
                //@ts-expect-error .disposition
                disposition: targetDocument?.disposition,
              }
            }, target, this.item);
          } else if (configSettings.optionalRules.coverCalculation === "simbuls-cover-calculator"
            && installedModules.get("simbuls-cover-calculator")) {
            // Special case for templaes
            coverSaveBonus = 0;
            const coverData = await globalThis.CoverCalculator.checkCoverViaCoordinates(
              position.x, position.y, false, 'AoE', false, target);
            if (coverData?.data.results.cover === 3) coverSaveBonus = FULL_COVER;
            else coverSaveBonus = -coverData.data.results.value;
          } if (configSettings.optionalRules.coverCalculation === "tokencover" && installedModules.get("tokencover")) {
            coverSaveBonus = computeCoverBonus(this.token.clone({ center: position }), target, this.item);
          }
        } else {
          coverSaveBonus = computeCoverBonus(this.token, target, this.item);
        }
      }
      saveRollTotal += coverSaveBonus;
      let saved = saveRollTotal >= rollDC;

      if (checkRule("criticalSaves")) { // normal d20 roll/monks roll
        saved = (isCritical || saveRollTotal >= rollDC) && !isFumble;
      }
      if (foundry.utils.getProperty(this.actor, `flags.${MODULE_ID}.sculptSpells`) && (this.rangeTargeting || this.temptargetConfirmation) && this.activity?.item?.system.school === "evo" && this.preSelectedTargets.has(target)) {
        saved = true;
        this.superSavers.add(target)
      }
      if (foundry.utils.getProperty(this.actor, `flags.${MODULE_ID}.carefulSpells`) && (this.rangeTargeting || this.temptargetConfirmation) && this.preSelectedTargets.has(target)) {
        saved = true;
      }
      if (saved) {
        this.saves.add(target);
        this.failedSaves.delete(target);
      } else {
        this.saves.delete(target);
        this.failedSaves.add(target);
      }
      if (!foundry.utils.getProperty(this.item, `flags.${MODULE_ID}.noProvokeReaction`)) {
        if (saved)
          //@ts-expect-error
          await doReactions(target, this.tokenUuid, this.attackRoll, "reactionsavesuccess", { workflow: this, activity: this.activity, item: this.item })
        else
          //@ts-expect-error
          await doReactions(target, this.tokenUuid, this.attackRoll, "reactionsavefail", { workflow: this, activity: this.activity, item: this.item })
      }
      if (isCritical) this.criticalSaves.add(target);

      let newRolls;
      if (configSettings.allowUseMacro && this.options.noTargetOnusemacro !== true) {
        const rollResults = await this.triggerTargetMacros(["isSave", "isSaveSuccess", "isSaveFailure"], new Set([target]), { saved });
        newRolls = rollResults[target.document.uuid];
        if (newRolls[0] instanceof Roll) {
          saveRolls = newRolls;
          saveRollTotal = newRolls.reduce((acc, r) => acc + r.total, 0);
          saved = saveRollTotal >= rollDC;
          const dterm: DiceTerm = saveRolls[0].terms[0];
          const diceRoll = dterm?.results?.find(result => result.active)?.result ?? saveRollTotal;
          //@ts-expect-error
          isFumble = diceRoll <= (dterm.options?.fumble ?? 1)
          //@ts-expect-error
          isCritical = diceRoll >= (dterm.options?.critical ?? 20);
        }
      }
      if (!saved) {
        if (!(result[0] instanceof D20Roll)) result[0] = D20Roll.fromRoll(result[0]);
        // const newRoll = await bonusCheck(target.actor, result, rollType, "fail")
        const failFlagsLength = collectBonusFlags(target.actor, rollType, "fail.all").length;
        const failAbilityFlagsLength = collectBonusFlags(target.actor, rollType, `fail.${rollAbility}`).length
        if (failFlagsLength || failAbilityFlagsLength) {
          // If the roll fails and there is an flags.midi-qol.save.fail then apply the bonus
          let owner: User | undefined = playerFor(target);
          if (!owner?.active) owner = game.users?.find((u: User) => u.isGM && u.active);
          if (owner) {
            let newRoll;
            if (owner?.isGM && game.user?.isGM) {
              newRoll = await bonusCheck(target.actor, result[0], rollType, failAbilityFlagsLength ? `fail.${rollAbility}` : "fail.all");
            } else {
              newRoll = await socketlibSocket.executeAsUser("bonusCheck", owner?.id, {
                actorUuid: target.actor.uuid,
                result: JSON.stringify(result.toJSON()),
                rollType,
                selector: failFlagsLength ? "fail.all" : `fail.${rollAbility}`
              });

            }
            saveRolls[0] = newRoll;
            saveRollTotal = saveRolls.reduce((acc, r) => acc + r.total, 0);
          }
        }
        saved = saveRollTotal >= rollDC;
        const dterm: DiceTerm = saveRolls[0].terms[0];
        const diceRoll = dterm?.results?.find(result => result.active)?.result ?? saveRollTotal;
        //@ts-expect-error
        isFumble = diceRoll <= (dterm.options?.fumble ?? 1)
        //@ts-expect-error
        isCritical = diceRoll >= (dterm.options?.critical ?? 20);
      }
      if (isFumble) this.fumbleSaves.add(target);
      if (isCritical) this.criticalSaves.add(target);
      if (this.checkSuperSaver(target, this.saveActivity?.save?.ability))
        this.superSavers.add(target);
      if (this.checkSemiSuperSaver(target, this.saveActivity?.save?.ability))
        this.semiSuperSavers.add(target);

      if (this.item.flags[MODULE_ID]?.isConcentrationCheck) {
        const checkBonus = foundry.utils.getProperty(target, `actor.flags.${MODULE_ID}.concentrationSaveBonus`);
        if (checkBonus) {
          const rollBonus = (await new Roll(`${checkBonus}`, target.actor?.getRollData()).evaluate());
          result = addRollTo(result[0], rollBonus);
          saveRolls[0] = result;
          saveRollTotal = result.reduce((acc, r) => acc + r.total, 0);
          //TODO 
          // rollDetail = (await new Roll(`${rollDetail.total} + ${rollBonus}`).evaluate());
          saved = saveRollTotal >= rollDC;
          if (checkRule("criticalSaves")) { // normal d20 roll/monks roll
            saved = (isCritical || saveRollTotal >= rollDC) && !isFumble;
          }
        }
      }

      if (saved) {
        this.saves.add(target);
        this.failedSaves.delete(target);
      } else {
        this.saves.delete(target);
        this.failedSaves.add(target);
      }

      if (game.user?.isGM) log(`Ability save/check: ${target.name} rolled ${saveRollTotal} vs ${rollAbility} DC ${rollDC}`);
      let saveString = i18n(saved ? "midi-qol.save-success" : "midi-qol.save-failure");
      let adv = "";
      if (configSettings.displaySaveAdvantage) {
        if (game.system.id === "dnd5e") {
          adv = this.advantageSaves.has(target) ? `(${i18n("DND5E.Advantage")})` : "";
          if (this.disadvantageSaves.has(target)) adv = `(${i18n("DND5E.Disadvantage")})`;
        } else if (game.system.id === "sw5e") {
          adv = this.advantageSaves.has(target) ? `(${i18n("SW5E.Advantage")})` : "";
          if (this.disadvantageSaves.has(target)) adv = `(${i18n("SW5E.Disadvantage")})`;
        }
      }
      if (coverSaveBonus) adv += `(+${coverSaveBonus} Cover)`
      //@ts-expect-error .texture
      let img: string = targetDocument?.texture?.src ?? target.actor.img ?? "";
      if (configSettings.usePlayerPortrait && target.actor.type === "character") {
        //@ts-expect-error .texture
        img = target.actor?.img ?? targetDocument?.texture?.src ?? "";
      }

      if (VideoHelper.hasVideoExtension(img)) {
        img = await game.video.createThumbnail(img, { width: 100, height: 100 });
      }

      let isPlayerOwned = target.actor.hasPlayerOwner;
      let saveStyle = "";
      if (configSettings.highlightSuccess) {
        if (saved) saveStyle = "color: green;";
        else saveStyle = "color: red;";
      }
      const rollHTML = await midiRenderRoll(saveRolls[0]);
      this.saveRolls.push(saveRolls[0]);
      this.tokenSaves[getTokenDocument(target)?.uuid ?? "none"] = saveRolls[0];
      this.saveDisplayData.push({
        gmName: getTokenName(target),
        playerName: getTokenPlayerName(target),
        img,
        isPC: isPlayerOwned,
        target,
        saveString,
        saveSymbol: saved ? "fa-check" : "fa-times",
        saveTotalClass: target.actor.hasPlayerOwner ? "" : "midi-qol-npc-save-total",
        rollTotal: saveRollTotal,
        rollDetail: saveRolls[0],
        rollHTML,
        id: target.id,
        adv,
        saveClass: saved ? "success" : "failure",
      });
      i++;
    }

    let DCString = "DC";
    if (game.system.id === "dnd5e") DCString = i18n(`${this.systemString}.AbbreviationDC`)
    else if (i18n("SW5E.AbbreviationDC") !== "SW5E.AbbreviationDC") {
      DCString = i18n("SW5E.AbbreviationDC");
    }

    if (rollType === "save")
      this.saveDisplayFlavor = `<label class="midi-qol-saveDC">${DCString} ${rollDC}</label> ${GameSystemConfig.abilities[rollAbility].label ?? GameSystemConfig.abilities[rollAbility].label} ${i18n(allHitTargets.size > 1 ? "midi-qol.saving-throws" : "midi-qol.saving-throw")}`;
    else if (rollType === "check")
      this.saveDisplayFlavor = `<label class="midi-qol-saveDC">${DCString} ${rollDC}</label> ${GameSystemConfig.abilities[rollAbility].label ?? GameSystemConfig.abilities[rollAbility].label} ${i18n(allHitTargets.size > 1 ? "midi-qol.ability-checks" : "midi-qol.ability-check")}:`;
    else if (rollType === "skill")
      this.saveDisplayFlavor = `<label class="midi-qol-saveDC">${DCString} ${rollDC}</label> ${GameSystemConfig.skills[rollAbility].label ?? GameSystemConfig.skills[rollAbility]}`;
  }

  monksSavingCheck(message, update, options, user) {
    if (!update.flags || !update.flags["monks-tokenbar"]) return true;
    const updateFlags = update.flags["monks-tokenbar"];
    const mflags = message.flags["monks-tokenbar"];
    for (let key of Object.keys(mflags)) {
      if (!key.startsWith("token")) continue;
      if (!mflags[key].roll) continue;
      const requestId = key.replace("token", "");
      if (!mflags[key].reveal) continue; // Must be showing the roll
      if (this.saveRequests[requestId]) {
        let roll;
        try {
          roll = Roll.fromJSON(JSON.stringify(mflags[key].roll));
        } catch (err) {
          roll = foundry.utils.deepClone(mflags[key].roll);
        }

        const func = this.saveRequests[requestId];
        delete this.saveRequests[requestId];
        func(roll)
      }
    }
    return true;
  }

  async displayChatCardWithoutDamageDetail() {
    let chatMessage = getCachedDocument(this.itemCardUuid);
    // let chatMessage = game.messages?.get(workflow.itemCardId ?? "");
    //@ts-ignore content v10
    let content = (chatMessage && chatMessage.content) ?? "";
    let data;
    if (content) {
      data = chatMessage?.toObject(); // TODO check this v10
      content = data.content || "";
      let searchRe = /<div class="midi-qol-damage-roll">[\s\S\n\r]*<div class="end-midi-qol-damage-roll">/;
      let replaceString = `<div class="midi-qol-damage-roll"><div class="end-midi-qol-damage-roll">`
      content = content.replace(searchRe, replaceString);
      searchRe = /<div class="midi-qol-other-roll">[\s\S\n\r]*<div class="end-midi-qol-other-roll">/;
      replaceString = `<div class="midi-qol-other-roll"><div class="end-midi-qol-other-roll">`
      content = content.replace(searchRe, replaceString);
      searchRe = /<div class="midi-qol-bonus-roll">[\s\S\n\r]*<div class="end-midi-qol-bonus-roll">/;
      replaceString = `<div class="midi-qol-bonus-roll"><div class="end-midi-qol-bonus-roll">`
      content = content.replace(searchRe, replaceString);
    }
    if (data && this.currentAction === this.WorkflowState_Completed) {
      if (this.itemCardUuid) {
        await Workflow.removeItemCardAttackDamageButtons(this.itemCardUuid);
        await Workflow.removeItemCardConfirmRollButton(this.itemCardUuid);
      }
      delete data._id;
      const itemCard = await CONFIG.ChatMessage.documentClass.create(data);
      this.itemCardId = itemCard?.id;
      this.itemCardUuid = itemCard?.uuid;
    }
  }

  async callv3DamageHooks(damages, token: Token) {
    this.damageItem = damages;
    if (configSettings.allowUseMacro && !this?.options?.noTargetOnuseMacro && this.item?.flags) {
      await this.triggerTargetMacros(["preTargetDamageApplication"], new Set([token]));
    }
    await asyncHooksCallAll(`midi-qol.preTargetDamageApplication`, token, { item: this.item, workflow: this, damageItem: damages, ditem: damages });

    if (damages.hpDamage !== 0 && (this.hitTargets.has(token) || this.hitTargetsEC.has(token) || this.otherActivity?.save || this.otherActivity?.check)) {
      let healedDamaged = damages.hpDamage < 0 ? "isHealed" : "isDamaged";
      await asyncHooksCallAll(`midi-qol.${healedDamaged}`, token, { item: this.item, workflow: this, damageItem: damages, ditem: damages });
      const actorOnUseMacros = foundry.utils.getProperty(token.actor ?? {}, `flags.${MODULE_ID}.onUseMacroParts`) ?? new OnUseMacros();
      // It seems applyTokenDamageMany without a this gets through to here - so a silly guard in place TODO come back and fix this properly
      if (this.callMacros) await this.callMacros(this.item,
        actorOnUseMacros?.getMacros(healedDamaged),
        "TargetOnUse",
        healedDamaged,
        { actor: token.actor, token: token });
      healedDamaged = damages.hpDamage < 0 ? "isHealed" : "isDamaged";  //recalculate what the total damage and trigger the correct special duration expiration.
      const expiredEffects = getAppliedEffects(token?.actor, { includeEnchantments: true }).filter(ef => {
        const specialDuration = foundry.utils.getProperty(ef, "flags.dae.specialDuration");
        if (!specialDuration) return false;
        return specialDuration.includes(healedDamaged);
      }).map(ef => ef.uuid)
      if (expiredEffects?.length ?? 0 > 0) {
        await timedAwaitExecuteAsGM("removeEffectUuids", {
          actorUuid: token.actor?.uuid,
          effects: expiredEffects,
          options: { "expiry-reason": `midi-qol:${healedDamaged}` }
        });
      }
    }
    // Call the preDamageApplication hook which can change the damage
    if (configSettings.allowUseMacro && this.item?.flags) {
      await this.callMacros(this.item, this.onUseMacros?.getMacros("preDamageApplication"), "OnUse", "preDamageApplication");
      if (this.ammo) await this.callMacros(this.ammo, this.ammoOnUseMacros?.getMacros("preDamageApplication"), "OnUse", "preDamageApplication", damages);
    }
    Object.assign(damages, this.damageItem);

  }

  processDefenceRoll(message, html, data) {
    if (!this.defenceRequests) return true;
    const requestId = message?.speaker?.actor;
    if (debugEnabled > 0) warn("processDefenceRoll |", requestId, this.saveRequests)

    if (!requestId) return true;
    if (!this.defenceRequests[requestId]) return true;

    clearTimeout(this.defenceTimeouts[requestId]);
    const handler = this.defenceRequests[requestId]
    delete this.defenceRequests[requestId];
    delete this.defenceTimeouts[requestId];
    handler(message.rolls[0])
    return true;
  }

  processSaveRoll(message, html, data) {
    if (!this.saveRequests) return {};
    const ddbglFlags = message.flags && message.flags["ddb-game-log"];
    const isDDBGL = ddbglFlags?.cls === "save" && !ddbglFlags?.pending;
    const midiFlags = message.flags && message.flags[MODULE_ID];

    let requestId = message?.speaker?.token;
    if (!requestId && isDDBGL) requestId = message?.speaker?.actor;
    if (debugEnabled > 0) warn("processSaveRoll |", requestId, this.saveRequests)
    if (!requestId) return true;

    if (!this.saveRequests[requestId]) return true;

    if (this.saveRequests[requestId]) {
      clearTimeout(this.saveTimeouts[requestId]);
      const handler = this.saveRequests[requestId]
      delete this.saveRequests[requestId];
      delete this.saveTimeouts[requestId];
      if (configSettings.undoWorkflow) {
        this.undoData.chatCardUuids = this.undoData.chatCardUuids.concat([message.uuid]);
        untimedExecuteAsGM("updateUndoChatCardUuids", this.undoData);
      }
      handler(message.rolls[0])
    }
    if (game.user?.id !== message.author.id && !["allShow"].includes(configSettings.autoCheckSaves)) {
      setTimeout(() => html.remove(), 100);
    }
    return true;
  }

  checkSuperSaver(token, ability: string | undefined) {
    if (!ability) return false;
    const actor = token.actor ?? {};
    const flags = foundry.utils.getProperty(actor, `flags.${MODULE_ID}.superSaver`);
    if (!flags) return false;
    if (flags?.all) {
      const flagVal = evalActivationCondition(this, flags.all, token, { errorReturn: false });
      if (flagVal) return true;
    }
    if (foundry.utils.getProperty(flags, `${ability}`)) {
      const flagVal = evalActivationCondition(this, foundry.utils.getProperty(flags, `${ability}`), token, { errorReturn: false });
      if (flagVal) return true;
    }
    if (foundry.utils.getProperty(this.actor, `flags.${MODULE_ID}.sculptSpells`) && this.item?.school === "evo" && this.preSelectedTargets.has(token)) {
      return true;
    }
    return false;
  }

  checkSemiSuperSaver(token, ability: string | undefined) {
    if (!ability) return false;
    const actor = token.actor ?? {};
    const flags = foundry.utils.getProperty(actor, `flags.${MODULE_ID}.semiSuperSaver`);
    if (!flags) return false;
    if (flags?.all) {
      const flagVal = evalActivationCondition(this, flags.all, token, { errorReturn: false });
      if (flagVal) return true;
    }
    if (foundry.utils.getProperty(flags, `${ability}`)) {
      const flagVal = evalActivationCondition(this, foundry.utils.getProperty(flags, `${ability}`), token, { errorReturn: false });
      if (flagVal) return true;
    }
    return false;
  }

  processCustomRoll(customRoll: any) {
    const formula = "1d20";
    const isSave = customRoll.fields.find(e => e[0] === "check");
    if (!isSave) return true;
    const rollEntry = customRoll.entries?.find((e) => e.type === "multiroll");
    let total = rollEntry?.entries?.find((e) => !e.ignored)?.total ?? -1;
    let advantage = rollEntry ? rollEntry.rollState === "highest" : undefined;
    let disadvantage = rollEntry ? rollEntry.rollState === "lowest" : undefined;
    return ({ total, formula, terms: [{ options: { advantage, disadvantage } }] });
  }

  async processAttackRoll() {
    if (!this.attackRoll) return;
    const terms = this.attackRoll.terms;

    if (terms[0] instanceof NumericTerm) {
      this.diceRoll = Number(terms[0].total);
    } else {
      this.diceRoll = Number(terms[0].total)
      //TODO find out why this is using results - seems it should just be the total
      // this.diceRoll = terms[0].results.find(d => d.active).result;
    }
    //@ts-expect-error .options.critical undefined
    let criticalThreshold = this.attackRoll.options.criticalSuccess;
    if (this.targets.size > 0) {
      //@ts-expect-error first
      const midiFlags = this.targets.first().actor?.flags[MODULE_ID];
      let targetCrit = 20;
      if (midiFlags?.grants?.criticalThreshold) {
        //@ts-expect-error .first()
        const conditionData = createConditionData({ workflow: this, target: this.targets.first(), actor: this.actor });
        targetCrit = await evalCondition(midiFlags.grants.criticalThreshold, conditionData, { errorReturn: 20, async: true });
      }
      if (isNaN(targetCrit) || !Number.isNumeric(targetCrit)) targetCrit = 20;
      criticalThreshold = Math.min(criticalThreshold, targetCrit);
    }
    this.isCritical = this.diceRoll >= criticalThreshold;
    const midiFumble = this.item && foundry.utils.getProperty(this.item, `flags.${MODULE_ID}.fumbleThreshold`);
    //@ts-expect-error .funble
    let fumbleTarget = this.attackRoll.terms[0].options.criticalFailure ?? 1;
    if (Number.isNumeric(midiFumble)) fumbleTarget = midiFumble;
    this.isFumble = this.diceRoll <= fumbleTarget;
    this.attackTotal = this.attackRoll.total ?? 0;
    if (debugEnabled > 1) debug("processAttackRoll: ", this.diceRoll, this.attackTotal, this.isCritical, this.isFumble);
  }

  async checkHits(options: { noProvokeReaction?: boolean, noOnuseMacro?: boolean, noTargetOnuseMacro?: boolean } = {}) {
    let isHit = true;
    let isHitEC = false;

    let item = this.item;

    // check for a hit/critical/fumble
    if (this.activity.target?.type === "self") {
      this.targets = getTokenForActorAsSet(this.actor);
    }
    if (!this.useActiveDefence) {
      this.hitTargets = new Set();
      this.hitTargetsEC = new Set(); //TO wonder if this can work with active defence?
    };
    this.hitDisplayData = {};
    const challengeModeArmorSet = !([undefined, false, "none"].includes(checkRule("challengeModeArmor")));
    for (let targetToken of this.targets) {
      let targetName = configSettings.useTokenNames && targetToken.name ? targetToken.name : targetToken.actor?.name;
      //@ts-expect-error dnd5e v10
      let targetActor: globalThis.dnd5e.documents.Actor5e = targetToken.actor;
      if (!targetActor) continue; // tokens without actors are an abomination and we refuse to deal with them.
      let targetAC = Number.parseInt(targetActor.system.attributes.ac.value ?? 10);
      const wjVehicle = installedModules.get("wjmais") ? foundry.utils.getProperty(targetActor, "flags.wjmais.crew.min") != null : false;
      if (targetActor.type === "vehicle" && !wjVehicle) {
        const inMotion = foundry.utils.getProperty(targetActor, `flags.${MODULE_ID}.inMotion`);
        if (inMotion) targetAC = Number.parseInt(targetActor.system.attributes.ac.flat ?? 10);
        else targetAC = Number.parseInt(targetActor.system.attributes.ac.motionless);
        if (isNaN(targetAC)) {
          console.warn("Error when getting vehicle armor class make sure motionless is set");
          targetAC = 10;
        }
      }
      let hitResultNumeric;
      let targetEC = targetActor.system.attributes.ac.EC ?? 0;
      let targetAR = targetActor.system.attributes.ac.AR ?? 0;

      let bonusAC = 0;

      isHit = false;
      isHitEC = false;
      let attackTotal = this.attackTotal;

      if (this.useActiveDefence) {
        isHit = this.hitTargets.has(targetToken);
        hitResultNumeric = "";
      } else {
        const noCoverFlag = foundry.utils.getProperty(this.actor, `flags.${MODULE_ID}.ignoreCover`);
        let ignoreCover = false;
        if (noCoverFlag) {
          const conditionData = createConditionData({ workflow: this, target: targetToken, actor: this.actor });
          ignoreCover = await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.ignoreCover`, conditionData);
        }
        if (!ignoreCover) bonusAC = computeCoverBonus(this.attackingToken ?? this.token, targetToken, item);
        targetAC += bonusAC;

        const midiFlagsAttackBonus = foundry.utils.getProperty(targetActor, `flags.${MODULE_ID}.grants.attack.bonus`);
        if (!this.isFumble) {
          if (midiFlagsAttackBonus) {
            // if (Number.isNumeric(midiFlagsAttackBonus.all)) attackTotal +=  Number.parseInt(midiFlagsAttackBonus.all);
            // if (Number.isNumeric(midiFlagsAttackBonus[item.system.actionType]) && midiFlagsAttackBonus[item.system.actionType]) attackTotal += Number.parseInt(midiFlagsAttackBonus[item.system.actionType]);
            if (midiFlagsAttackBonus?.all) {
              const attackBonus = await (new Roll(midiFlagsAttackBonus.all, targetActor.getRollData()))?.evaluate();
              attackTotal += attackBonus?.total ?? 0;
              foundry.utils.setProperty(this.actor, "flags.midi.evaluated.grants.attack.bonus.all", { value: attackBonus?.total ?? 0, effects: [`${targetActor.name}`] });
            }
            if (midiFlagsAttackBonus[item.system.actionType]) {
              const attackBonus = await (new Roll(midiFlagsAttackBonus[item.system.actionType], targetActor.getRollData())).evaluate();
              attackTotal += attackBonus?.total ?? 0;
              foundry.utils.setProperty(this.actor, `flags.midi.evaluated.grants.attack.bonus.${item.system.actionType}`, { value: attackBonus?.total ?? 0, effects: [`${targetActor.name}`] });
            }
          }
          if (challengeModeArmorSet) isHit = attackTotal > targetAC || this.isCritical;
          else {
            if (this.attackRoll && !foundry.utils.getProperty(this.item, `flags.${MODULE_ID}.noProvokeReaction`) && !options.noProvokeReaction) {
              const workflowOptions = foundry.utils.mergeObject(foundry.utils.duplicate(this.workflowOptions), { sourceActorUuid: this.actor.uuid, sourceItemUuid: this.item?.uuid }, { inplace: false, overwrite: true });
              const result = await doReactions(targetToken, this.tokenUuid, this.attackRoll, "reactionattacked", { activity: this.activity, item: this.item, workflow: this, workflowOptions });
              // TODO what else to do once rolled
            }
            isHit = attackTotal >= targetAC || this.isCritical;
          }
          if (bonusAC === FULL_COVER) isHit = false; // bonusAC will only be FULL_COVER if cover bonus checking is enabled.

          if (targetEC) isHitEC = challengeModeArmorSet && attackTotal <= targetAC && attackTotal >= targetEC && bonusAC !== FULL_COVER;
          // check to see if the roll hit the target
          if ((isHit || isHitEC) && this.activity?.attack && this.attackRoll && targetToken !== null && !foundry.utils.getProperty(this, `item.flags.${MODULE_ID}.noProvokeReaction`) && !options.noProvokeReaction) {
            const workflowOptions = foundry.utils.mergeObject(foundry.utils.duplicate(this.workflowOptions), { sourceActorUuid: this.actor.uuid, sourceItemUuid: this.item?.uuid }, { inplace: false, overwrite: true });
            // reaction is the same as reactionhit to accomodate the existing reaction workflow
            let result;
            if (!foundry.utils.getProperty(this.item, `flags.${MODULE_ID}.noProvokeReaction`) && !options.noProvokeReaction) {
              result = await doReactions(targetToken, this.tokenUuid, this.attackRoll, "reaction", { activity: this.activity, item: this.item, workflow: this, workflowOptions });
            }
            if (!Workflow.getWorkflow(this.id)) // workflow has been removed - bail out
              return;
            targetAC = Number.parseInt(targetActor.system.attributes.ac.value) + bonusAC;
            if (targetEC) targetEC = targetActor.system.attributes.ac.EC + bonusAC;
            if (result.ac) targetAC = result.ac + bonusAC; // deal with bonus ac if any.
            if (targetEC) targetEC = targetAC - targetAR;
            if (bonusAC === FULL_COVER) isHit = false; // bonusAC will only be FULL_COVER if cover bonus checking is enabled.
            isHit = (attackTotal >= targetAC || this.isCritical) && result.name !== "missed";
            if (challengeModeArmorSet) isHit = this.attackTotal >= targetAC || this.isCritical;
            if (targetEC) isHitEC = challengeModeArmorSet && this.attackTotal <= targetAC && this.attackTotal >= targetEC;
          } else if ((!isHit && !isHitEC) && this.activity?.attack && this.attackRoll && targetToken !== null && !foundry.utils.getProperty(this, `item.flags.${MODULE_ID}.noProvokeReaction`)) {
            const workflowOptions = foundry.utils.mergeObject(foundry.utils.duplicate(this.workflowOptions), { sourceActorUuid: this.actor.uuid, sourceItemUuid: this.item?.uuid }, { inplace: false, overwrite: true });
            if (!foundry.utils.getProperty(this.item, `flags.${MODULE_ID}.noProvokeReaction`) && !options.noProvokeReaction) {
              let result;
              if (isHit || isHitEC) {
                result = await doReactions(targetToken, this.tokenUuid, this.attackRoll, "reactionhit", { activity: this.activity, item: this.item, workflow: this, workflowOptions });
              }
              else
                result = await doReactions(targetToken, this.tokenUuid, this.attackRoll, "reactionmissed", { activity: this.activity, item: this.item, workflow: this, workflowOptions });

            }
            // TODO what else to do once rolled
          }
          const optionalCrits = checkRule("optionalCritRule");
          if (this.targets.size === 1 && optionalCrits !== false && optionalCrits > -1) {
            if (checkRule("criticalNat20") && this.isCritical) {

            } else {
              //@ts-expect-error .attributes
              this.isCritical = attackTotal >= (targetToken.actor?.system.attributes?.ac?.value ?? 10) + Number(checkRule("optionalCritRule"));
            }
          }
          hitResultNumeric = this.isCritical ? "++" : `${attackTotal}/${Math.abs(attackTotal - targetAC)}`;
        }

        // TODO come back and parameterise with flags and actor to use

        const midiFlagsActorFail = foundry.utils.getProperty(this.actor, `flags.${MODULE_ID}.fail`);
        if (midiFlagsActorFail) {
          const conditionData = createConditionData({ workflow: this, target: this.token, actor: this.actor });
          if (await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.fail.all`, conditionData)
            || await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.fail.attack`, conditionData)
            || await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.fail.attack.${item.system.actionType}`, conditionData)) {
            isHit = false;
            isHitEC = false;
            this.isCritical = false;
          }
        }
        const midiFlagsActorSuccess = foundry.utils.getProperty(this.actor, `flags.${MODULE_ID}.success`);
        if (midiFlagsActorSuccess) {
          const conditionData = createConditionData({ workflow: this, target: this.token, actor: this.actor });
          if (await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.success.all`, conditionData)
            || await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.success.attack.all`, conditionData)
            || await evalAllConditionsAsync(this.actor, `flags.${MODULE_ID}.success.attack.${item.system.actionType}`, conditionData)) {
            isHit = true;
            isHitEC = false;
            this.isFumble = false;
          }
        }

        const midiFlagsGrantsAttackSuccess = foundry.utils.getProperty(targetActor, `flags.${MODULE_ID}.grants.attack.success`);
        const midiFlagsGrantsAttackFail = foundry.utils.getProperty(targetActor, `flags.${MODULE_ID}.grants.attack.fail`);
        let conditionData;
        if (midiFlagsGrantsAttackSuccess || midiFlagsGrantsAttackFail) {
          conditionData = createConditionData({ workflow: this, target: this.token, actor: this.actor });

          if (await evalAllConditionsAsync(targetActor, `flags.${MODULE_ID}.grants.attack.success.all`, conditionData)
            || await evalAllConditionsAsync(targetActor, `flags.${MODULE_ID}.grants.attack.success.${item.system.actionType}`, conditionData)) {
            isHit = true;
            isHitEC = false;
            this.isFumble = false;
          }
          if (await evalAllConditionsAsync(targetActor, `flags.${MODULE_ID}.grants.attack.fail.all`, conditionData)
            || await evalAllConditionsAsync(targetActor, `flags.${MODULE_ID}.grants.attack.fail.${item.system.actionType}`, conditionData)) {
            isHit = false;
            isHitEC = false;
            this.isCritical = false;
          }
        }

        let hitScale = 1;
        if (["scale", "scaleNoAR"].includes(checkRule("challengeModeArmor")) && !this.isCritical) hitScale = Math.floor((this.attackTotal - targetEC + 1) / ((targetActor?.system.attributes.ac.AR ?? 0) + 1) * 10) / 10;
        if (!this.challengeModeScale) this.challengeModeScale = {};
        this.challengeModeScale[targetToken.actor?.uuid ?? "dummy"] = hitScale;
        if (this.isCritical) isHit = true;
        if (isHit || this.isCritical) this.hitTargets.add(targetToken);
        if (isHitEC) this.hitTargetsEC.add(targetToken);
        if (isHit || isHitEC) await this.processCriticalFlags();
        // This was set by computeCoverBonus so clear it after use.
        foundry.utils.setProperty(targetActor, `flags.${MODULE_ID}.acBonus`, 0);
      }
      if (game.user?.isGM) log(`${this.speaker.alias} Rolled a ${this.attackTotal} to hit ${targetName}'s AC of ${targetAC} ${(isHit || this.isCritical) ? "hitting" : "missing"}`);
      // Log the hit on the target
      let attackType = ""; //item?.name ? i18n(item.name) : "Attack";

      let hitSymbol = "fa-blank"
      // if (["scale", "scaleNoAR"].includes(checkRule("challengeModeArmor")) && !this.isCritical) hitScale = Math.floor(this.challengeModeScale[targetActor.uuid]);
      let isHitResult = "miss";
      if (game.user?.isGM && ["hitDamage", "all"].includes(configSettings.hideRollDetails) && (this.isCritical || this.isHit || this.isHitEC)) {
        isHitResult = "hit";
        hitSymbol = "fa-tick";
      } else if (this.isCritical) {
        isHitResult = "critical";
        hitSymbol = "fa-check-double"
      } else if (game.user?.isGM && this.isFumble && ["hitDamage", "all"].includes(configSettings.hideRollDetails)) {
        isHitResult = "miss";
        hitSymbol = "fa-times";
      } else if (this.isFumble) {
        isHitResult = "fumble";
        hitSymbol = "fa-times";
      } else if (isHit) {
        isHitResult = "hit";
        hitSymbol = "fa-check";
      } else if (isHitEC && ["scale", "scaleNoAR"].includes(checkRule("challengeModeArmor"))) {
        isHitResult = "hitEC";
        hitSymbol = "fa-check";
      } else if (isHitEC) {
        isHitResult = "hitEC";
        hitSymbol = "fa-check";
      } else {
        isHitResult = "miss";
        hitSymbol = "fa-times";
      }
      let hitStyle = "";
      /* success highlighting needs to be in chatmessage handling
      if (configSettings.highlightSuccess && safeGetGameSetting("dnd5e", "attackVisibility") !== "none") {
        if (isHit || isHitEC) hitStyle = "color: green;";
        else hitStyle = "color: red;";
      }
      */
      //TODO work out hot to do
      if (attackTotal !== this.attackTotal) {
        if (!configSettings.displayHitResultNumeric &&
          (!game.user?.isGM || ["none", "detailsDSN", "details"].includes(configSettings.hideRollDetails))) {
          // hitString = `(${attackTotal}) ${hitString}`; // prepend the modified hit roll
        } else {
          // hitString = `(${attackTotal - this.attackTotal}) ${hitString}`; // prepend the diff in the modified roll
        }
      }

      //@ts-expect-error .document v10
      let img = targetToken.document?.texture?.src || targetToken.actor?.img;
      if (configSettings.usePlayerPortrait && targetToken.actor?.type === "character") {
        //@ts-expect-error .document v10
        img = targetToken.actor?.img || targetToken.document?.texture?.src;
      }
      if (VideoHelper.hasVideoExtension(img ?? "")) {
        img = await game.video.createThumbnail(img ?? "", { width: 100, height: 100 });
      }
      // If using active defence hitTargets are up to date already.
      if (this.useActiveDefence) {
        if (this.activeDefenceRolls[getTokenDocument(targetToken)?.uuid ?? ""]) {
          const adRoll = this.activeDefenceRolls[getTokenDocument(targetToken)?.uuid ?? ""] ?? {};
          targetAC = adRoll.result ?? adRoll.total;
          // const adRoll = this.activeDefenceRolls[getTokenDocument(targetToken)?.uuid ?? ""] ?? {};
          // hitString = `(${adRoll.result ?? adRoll.total}): ${hitString}`
        }
      }
      if (this.isFumble) hitResultNumeric = "--";
      const targetUuid = getTokenDocument(targetToken)?.uuid ?? "";

      this.hitDisplayData[targetUuid] = {
        isPC: targetToken.actor?.hasPlayerOwner,
        target: targetToken,
        actorUuid: targetToken.actor?.uuid,
        tokenuuid: targetUuid,
        hitStyle,
        ac: targetAC,
        hitClass: ["hit", "critical", "isHitEC"].includes(isHitResult) ? "success" : "failure",
        acClass: targetToken.actor?.hasPlayerOwner ? "" : "midi-qol-npc-ac",
        hitSymbol,
        attackType,
        showAC: true,
        img,
        gmName: getIconFreeLink(targetToken),
        playerName: getTokenPlayerName(targetToken instanceof Token ? targetToken.document : targetToken),
        bonusAC,
        hitResultNumeric,
        attackTotal
      };
    }
    if (configSettings.allowUseMacro && !options.noTargetOnuseMacro) await this.triggerTargetMacros(["isHit"], new Set([...this.hitTargets, ...this.hitTargetsEC]));
    //@ts-expect-error
    if (configSettings.allowUseMacro && !options.noTargetOnuseMacro) await this.triggerTargetMacros(["isMissed"], this.targets.difference(this.hitTargets).difference(this.hitTargetsEC));
  }

  setRangedTargets(targetDetails) {
    if (!canvas || !canvas.scene) return true;
    const token = canvas?.tokens?.get(this.speaker.token);
    if (!token) {
      ui.notifications?.warn(`${game.i18n.localize("midi-qol.noSelection")}`)
      return true;
    }
    // We have placed an area effect template and we need to check if we over selected
    //@ts-expect-error .disposition v10
    let dispositions = targetDetails.affects.type === "creature" ? [-1, 0, 1] : targetDetails.affects.type === "ally" ? [token.document.disposition] : [-token.document.disposition];
    // release current targets
    game.user?.targets.forEach(t => {
      t.setTarget(false, { releaseOthers: false });
    });
    game.user?.targets.clear();
    // min dist is the number of grid squares away.
    let minDist = targetDetails.template.size;
    const targetIds: string[] = [];
    // ignoreToken set to null if special target include "self" - otherwise set to token
    let ignoreToken = targetDetails.affects.special.split(";").some(spec => spec === "self") ? null : canvas.tokens?.get(this.tokenId);
    if (canvas.tokens?.placeables && canvas.grid) {
      for (let target of canvas.tokens.placeables) {
        if (!isTargetable(target)) continue;
        const ray = new Ray(target.center, token.center);
        const wallsBlock = ["wallsBlock", "wallsBlockIgnoreDefeated", "wallsBlockIgnoreIncapacitated"].includes(configSettings.rangeTarget)
        let inRange = target.actor
          //@ts-expect-error .disposition v10
          && dispositions.includes(target.document.disposition);
        if (target.actor && ["wallsBlockIgnoreIncapacited", "alwaysIngoreIncapcitate"].includes(configSettings.rangeTarget))
          inRange = inRange && !checkIncapacitated(target.actor, debugEnabled > 0);
        if (["wallsBlockIgnoreDefeated", "alwaysIgnoreDefeated"].includes(configSettings.rangeTarget))
          inRange = inRange && !checkDefeated(target);
        inRange = inRange && (configSettings.rangeTarget === "none" || !hasWallBlockingCondition(target))
        if (inRange) {
          // if ignoreToken set don't target it.
          if (ignoreToken === target) {
            inRange = false;
          }
          const distance = computeDistance(target, token, { wallsBlock });
          inRange = inRange && distance >= 0 && distance <= minDist
        }
        if (inRange) {
          target.setTarget(true, { user: game.user, releaseOthers: false });
          if (target.document.id) targetIds.push(target.document.id);
        }
      }

      if (!this.ignoreUserTargets) this.targets = new Set(game.user?.targets ?? []);
      this.saves = new Set();
      this.failedSaves = new Set(this.targets)
      this.hitTargets = new Set(this.targets);
      this.hitTargetsEC = new Set();
      game.user?.broadcastActivity({ targets: targetIds });
    }
    return true;
  }

  async activeDefence(item, roll) {
    // Roll is d20 + AC - 10
    let hookId = Hooks.on("renderChatMessage", this.processDefenceRoll.bind(this));
    try {
      this.hitTargets = new Set();
      this.hitTargetsEC = new Set();
      this.defenceRequests = {};
      this.defenceTimeouts = {};
      this.activeDefenceRolls = {};
      this.isCritical = false;
      this.isFumble = false;
      // Get the attack bonus for the attack
      const attackBonus = roll.total - roll.dice[0].total; // TODO see if there is a better way to work out roll plusses
      await this.checkActiveAttacks(attackBonus, false, 20 - (roll.options.fumble ?? 1) + 1, 20 - (roll.options.critical ?? 20) + 1);
    } catch (err) {
      TroubleShooter.recordError(err, "activeDefence");
    } finally {
      Hooks.off("renderChatMessage", hookId);
    }
    return this.performState(this.WorkflowState_AttackRollComplete);
  }
  get useActiveDefence() {
    //@ts-expect-error
    return game.user.isGM && checkRule("activeDefence");
  }
  async checkActiveAttacks(attackBonus = 0, whisper = false, fumbleTarget, criticalTarget) {
    if (debugEnabled > 1) debug(`active defence : whisper ${whisper}  hit targets ${this.targets}`)
    if (this.targets.size <= 0) {
      return;
    }
    this.activeDefenceDC = 12 + attackBonus;

    let promises: Promise<any>[] = [];

    for (let target of this.targets) {
      if (!target.actor) continue;  // no actor means multi levels or bugged actor - but we won't roll a save
      let advantage: boolean | undefined = undefined;
      //@ts-expect-error
      let advantageMode = game.system.dice.D20Roll.ADV_MODE.NORMAL;
      //@ts-expect-error
      const targetActorSystem = target.actor.system;

      // TODO: Add in AC Bonus for cover
      const dcMod = targetActorSystem.attributes.ac.value - 10;
      let modString;
      if (dcMod < 0) modString = ` ${dcMod}`;
      else if (dcMod == 0) modString = "";
      else modString = `+ ${dcMod}`;
      let formula = `1d20${modString}`;
      // Advantage/Disadvantage is reversed for active defence rolls.
      const wfadvantage = this.advantage || this.rollOptions.advantage;
      const wfdisadvantage = this.disadvantage || this.rollOptions.disadvantage;
      if (wfadvantage && !wfdisadvantage) {
        advantage = false;
        formula = `2d20kl${modString}`;
        //@ts-expect-error
        advantageMode = game.system.dice.D20Roll.ADV_MODE.DISADVANTAGE;
      } else if (!wfadvantage && wfdisadvantage) {
        //@ts-expect-error
        advantageMode = game.system.dice.D20Roll.ADV_MODE.ADVANTAGE;
        advantage = true;
        formula = `2d20kh${modString}`;
      }
      //@ts-expect-error
      var player = playerFor(target instanceof Token ? target : target.object);
      // if (!player || !player.active) player = ChatMessage.getWhisperRecipients("GM").find(u => u.active);
      if (debugEnabled > 0) warn(`checkSaves | Player ${player?.name} controls actor ${target.actor.name} - requesting ${this.activity.save.ability} save`);
      if (player && player.active && !player.isGM) {
        promises.push(new Promise((resolve) => {
          const requestId = target.actor?.uuid ?? foundry.utils.randomID();
          const playerId = player?.id;
          this.defenceRequests[requestId] = resolve;
          requestPCActiveDefence(player, target.actor, advantage, this.item.name, this.activeDefenceDC, formula, requestId, { workflow: this })
          // set a timeout for taking over the roll
          if (configSettings.playerSaveTimeout > 0) {
            this.defenceTimeouts[requestId] = setTimeout(async () => {
              if (this.defenceRequests[requestId]) {
                delete this.defenceRequests[requestId];
                delete this.defenceTimeouts[requestId];
                //@ts-expect-error
                const result = await (new game.system.dice.D20Roll(formula, {}, { advantageMode })).evaluate();
                result.toMessage({ flavor: `${this.item.name} ${i18n("midi-qol.ActiveDefenceString")}` });

                resolve(result);
              }
            }, configSettings.playerSaveTimeout * 1000);
          }
        }));
      } else {  // must be a GM so can do the roll direct
        promises.push(
          new Promise(async (resolve) => {
            //@ts-expect-error
            const result = await (new game.system.dice.D20Roll(formula, {}, { advantageMode })).evaluate();
            displayDSNForRoll(result, "attackRoll")
            resolve(result);
          })
        );
      }
    }
    if (debugEnabled > 1) debug("check saves: requests are ", this.saveRequests)
    var results = await Promise.all(promises);

    this.rollResults = results;
    let i = 0;
    for (let target of this.targets) {
      if (!target.actor) continue; // these were skipped when doing the rolls so they can be skipped now
      if (!results[i]) {
        const message = `Token ${target?.name} ${getTokenDocument(target)?.uuid}, "could not roll active defence assuming 1`;
        error(message, target);
        TroubleShooter.recordError(new Error(message), message);
        results[i] = await new Roll("1").evaluate();
      }
      const result = results[i];
      let rollTotal = results[i]?.total || 0;
      this.isCritical = result.dice[0].total <= criticalTarget
      this.isFumble = result.dice[0].total >= fumbleTarget;
      this.activeDefenceRolls[getTokenDocument(target)?.uuid ?? ""] = results[i];
      let hit = this.isCritical || rollTotal < this.activeDefenceDC;
      if (hit) {
        this.hitTargets.add(target);
      } else this.hitTargets.delete(target);
      if (game.user?.isGM) log(`Ability active defence: ${target.name} rolled ${rollTotal} vs attack DC ${this.activeDefenceDC}`);
      i++;
    }
  }
  async setAttackRoll(roll: Roll) {
    this.attackRoll = roll;
    foundry.utils.setProperty(roll, "options.midi-qol.rollType", "attack");
    this.attackTotal = roll.total ?? 0;
    // foundry.utils.setProperty(roll, "options.flavor", `${this.otherDamageItem.name} - ${i18nSystem("Bonus")}`);
    this.attackRollHTML = await midiRenderAttackRoll(roll);
  }

  convertRollToDamageRoll(roll) {
    //@ts-expect-error
    const DamageRoll = CONFIG.Dice.DamageRoll;
    if (!(roll instanceof DamageRoll)) { // we got passed a normal roll which really should be a damage roll
      let damageType = MQdefaultDamageType;
      if (roll.terms[0].options.flavor && getDamageType(roll.terms[0].options.flavor)) {
        damageType = getDamageType(roll.terms[0].options.flavor);
      } else if (this.activity.hasDamage) damageType = this.activity.damage.parts[0]?.[1];
      else if (this.activity.hasHealing) damageType = this.activity.healing.types[0] ?? "healing";
      console.error("convertRollToDamageRoll: roll is not a damage roll", DamageRoll.fromRoll(roll, {}, { type: damageType }));
      return new DamageRoll.fromRoll(roll.formula, {}, { type: damageType })[0];
    }
    return roll;
  }
  async setDamageRoll(roll: Roll) {
    this.setDamageRolls([this.convertRollToDamageRoll(roll)]);
  }

  async addDamageRolls(rolls: Array<Roll> | Roll | undefined | null) {
    if (!rolls) return;
    if (rolls instanceof Roll) rolls = [rolls];
    if (!this.damageRolls) this.damageRolls = [];
    this.damageRolls = this.damageRolls.concat(rolls.map(roll => this.convertRollToDamageRoll(roll)));
    this.damageTotal = sumRolls(this.damageRolls, "positive")
    this.healingAdjustedDamageTotal = sumRolls(this.damageRolls, "negativeIgnoreTemp")
    this.damageRollHTML = "";
    for (let roll of this.damageRolls) {
      foundry.utils.setProperty(roll, `options.${MODULE_ID}.rollType`, "defaultDamage");
      foundry.utils.setProperty(roll, "options.flavor", "");
      this.damageRollHTML += await midiRenderDamageRoll(roll);
    }
    this.rawDamageDetail = createDamageDetailV4({ roll: this.damageRolls, activity: this.activity, defaultType: this.defaultDamageType });
    this.damageDetail = createDamageDetailV4({ roll: this.damageRolls, activity: this.activity, defaultType: this.defaultDamageType });
    return;
  }

  async setDamageRolls(rolls: Array<Roll> | Roll | undefined | null) {
    if (!rolls) {
      this.damageRolls = undefined;
      return;
    };

    if (rolls instanceof Roll) rolls = [rolls];
    //@ts-expect-error
    const baseRollProperties = rolls[0]?.options?.properties ?? [];
    rolls.forEach(roll => {
      setRollOperatorEvaluated(roll);
    });

    for (let i = 0; i < rolls.length; i++) {
      rolls[i] = await rolls[i]; // only here in case someone passes an unawaited roll
      //@ts-expect-error
      if (!rolls[i]._evaluated) rolls[i] = await rolls[i].evaluate();
      //@ts-expect-error
      rolls[i]._evaluated = true;
    }
    for (let i = 1; i < rolls.length; i++) {
      //@ts-expect-error
      foundry.utils.setProperty(rolls[i], "options.properties", (rolls[i].options?.properties ?? []).concat(baseRollProperties));
    }
    this.damageRolls = rolls;
    this.damageTotal = sumRolls(this.damageRolls, "positive")
    this.healingAdjustedDamageTotal = sumRolls(this.damageRolls, "negativeIgnoreTemp")
    this.damageRollHTML = "";
    for (let roll of this.damageRolls) {
      foundry.utils.setProperty(roll, `options.${MODULE_ID}.rollType`, "defaultDamage");
      foundry.utils.setProperty(roll, "options.flavor", "");

      this.damageRollHTML += await midiRenderDamageRoll(roll);
    }
    this.flavor = `${i18nSystem("Damage")}`;
    this.rawDamageDetail = createDamageDetailV4({ roll: this.damageRolls, activity: this.activity, defaultType: this.defaultDamageType });
    this.damageDetail = createDamageDetailV4({ roll: this.damageRolls, activity: this.activity, defaultType: this.defaultDamageType });
    return;
  }

  async setBonusDamageRolls(rolls: Array<Roll> | Roll | undefined | null) {
    if (!rolls) {
      this.bonusDamageRolls = undefined;
      this.rawBonusDamageDetail = [];
      return;
    };
    if (rolls instanceof Roll) rolls = [rolls];
    rolls.forEach(roll => {
      setRollOperatorEvaluated(roll);
    });

    for (let i = 0; i < rolls.length; i++) {
      rolls[i] = await rolls[i]; // only here in case someone passes an unawaited roll
      //@ts-expect-error
      if (!rolls[i]._evaluated) rolls[i] = await rolls[i].evaluate();
    }
    this.bonusDamageRolls = rolls;
    this.bonusDamageTotal = sumRolls(this.bonusDamageRolls, "positive");
    this.healingAdjustedBonusDamageTotal = sumRolls(this.bonusDamageRolls, "negativeIgnoreTemp");
    this.bonusDamageRollHTML = "";
    for (let roll of this.bonusDamageRolls) {
      foundry.utils.setProperty(roll, `options.${MODULE_ID}.rollType`, "bonusDamage");
      this.bonusDamageRollHTML += await midiRenderBonusDamageRoll(roll);
    }
    this.rawBonusDamageDetail = createDamageDetailV4({ roll: this.bonusDamageRolls, activity: this.activity, defaultType: this.defaultDamageType });
    this.bonusDamageDetail = createDamageDetailV4({ roll: this.bonusDamageRolls, activity: this.activity, defaultType: this.defaultDamageType });
    return;
  }

  async setBonusDamageRoll(roll: Roll) {
    this.setBonusDamageRolls([this.convertRollToDamageRoll(roll)]);
  }

  async setOtherDamageRolls(rolls: Array<Roll> | Roll | undefined | null) {
    if (!rolls) {
      this.otherDamageRolls = undefined;
      this.rawOtherDamageDetail = [];
      return;
    };
    if (rolls instanceof Roll) rolls = [rolls];
    rolls.forEach(roll => {
      setRollOperatorEvaluated(roll);
    });

    for (let i = 0; i < rolls.length; i++) {
      rolls[i] = await rolls[i]; // only here in case someone passes an unawaited roll
      //@ts-expect-error
      if (!rolls[i]._evaluated) rolls[i] = await rolls[i].evaluate();
    }
    this.otherDamageRolls = rolls;
    this.otherDamageTotal = sumRolls(this.otherDamageRolls, "positive");
    this.healingAdjustedOtherDamageTotal = sumRolls(this.otherDamageRolls, "negativeIgnoreTemp");
    this.otherDamageRollHTML = "";
    for (let roll of this.otherDamageRolls) {
      foundry.utils.setProperty(roll, `options.${MODULE_ID}.rollType`, "otherDamage");
      this.otherDamageRollHTML += await midiRenderOtherDamageRoll(roll);
    }
    this.rawOtherDamageDetail = createDamageDetailV4({ roll: this.otherDamageRolls, activity: this.activity, defaultType: this.defaultDamageType });
    this.otherDamageDetail = createDamageDetailV4({ roll: this.otherDamageRolls, activity: this.activity, defaultType: this.defaultDamageType });
    return;
  }

  async setOtherDamageRoll(roll: Roll) {
    this.setOtherDamageRolls([this.convertRollToDamageRoll(roll)]);
  }
}

export class UserWorkflow extends Workflow {
}

export class DamageOnlyWorkflow extends Workflow {
  //@ts-expect-error
  constructor(actor: globalThis.dnd5e.documents.Actor5e, token: Token, damageTotal: number, damageType: string, targets: [Token], roll: Roll,
    options: { flavor: string, itemCardId: string, itemCardUuid: string, damageList: [], useOther: boolean, itemData: any, isCritical: boolean, item?: Item }) {
    if (!actor) actor = token.actor ?? targets[0]?.actor;
    const theTargets = Array.from(targets).map(t => getToken(t)).filter(t => t);
    let damageRoll = roll;
    if (!damageRoll) {
      //@ts-expect-error
      damageRoll = new CONFIG.Dice.DamageRoll(`${damageTotal}`, {}, { type: damageType }).evaluateSync();
    }
    let theItem: any = null;
    const extraItemData = {
      name: options.flavor ?? "Damage Only Workflow",
      type: "feat", _id: foundry.utils.randomID(),
      system: {
        activities: {
          dnd5eactivity000: {
            type: "damage",
            _id: foundry.utils.randomID(),
            damage: {
              //@ts-expect-error
              parts: [{ custom: { enabled: true, formula: damageRoll.formula }, types: [damageRoll.options.type] }],
            },
            range: {
              override: true,
              units: ""
            },
            target: {
              affects: {
                type: "creature",
                special: ""
              }
            }
          }
        },
      }
    }
    // Create a synthetic item with a single damage activity - activity is needed for displaying the activity card if required
    if (options.item || options.itemData) { // use any item data passed in
      let itemData: any = options.item ? options.item.toObject() : options.itemData;
      if (itemData.system?.activities) delete itemData.system.activities;
      itemData = foundry.utils.mergeObject(itemData, extraItemData, { inplace: false });
      theItem = new CONFIG.Item.documentClass(itemData, { parent: actor });
      foundry.utils.setProperty(itemData, "_id", itemData._id ?? foundry.utils.randomID());
    } else {
      theItem = new CONFIG.Item.documentClass(extraItemData, { parent: actor });
    }
    if (!theItem) return;

    theItem.setFlag = async (scope: string, key: string, value: any) => { return theItem };
    theItem.prepareData();
    theItem.prepareFinalAttributes();
    super(actor, theItem.system.activities.contents[0], ChatMessage.getSpeaker({ token, actor }), new Set(theTargets), { event: shiftOnlyEvent, noOnUseMacro: true });
    // Do the supplied damageRoll
    this.flavor = options.flavor;
    this.defaultDamageType = GameSystemConfig.damageTypes[damageType]?.label ?? damageType;
    // Since this could to be the same item don't roll the on use macro, since this could loop forever
    foundry.utils.setProperty(this.item, `flags.${MODULE_ID}.onUseMacroName`, null);
    this.stateTransitionCount = 0;
    if (options.itemCardUuid) this.itemCardUuid = options.itemCardUuid;
    else {
      const message = game.messages?.get(options.itemCardId);
      if (message) this.itemCardUuid = message?.uuid;
    }
    this.setDamageRolls([damageRoll]).then(() => {
      this.damageTotal = damageTotal;
      this.isCritical = options.isCritical ?? false;
      this.kickStart = false;
      this.suspended = false;
      this.performState(this.WorkflowState_Start);
    })
    return this;
  }
  async WorkflowState_Start(context: any = {}): Promise<WorkflowState> {
    this.effectsAlreadyExpired = [];

    //@ts-expect-error
    if (this.itemCardUuid === "new" || !fromUuidSync(this.itemCardUuid)) {
      const message = {}
      const messageConfig = foundry.utils.mergeObject({
        create: true,
        data: {
          flags: {
            dnd5e: {
              ...this.activity.messageFlags,
              messageType: "usage",
              use: {
                effects: this.applicableEffects?.map(e => e.id)
              }
            }
          },
          rolls: this.damageRolls,
        },
        hasConsumption: false
      }, message);
      this.itemCard = await this.activity._createUsageMessage(messageConfig);
      this.itemCardId = this.itemCard.id;
      this.itemCardUuid = this.itemCard.uuid;
    }
    const whisperCard = configSettings.autoCheckHit === "whisper" || game.settings.get("core", "rollMode") === "blindroll";
    if (this.actor) { // Hacky process bonus flags
      // TODO come back and fix this for dnd3
      const newRolls = await processDamageRollBonusFlags.bind(this)(this.damageRolls);
      await this.setDamageRolls(newRolls);
    }

    if (this.itemCardId || this.itemCardUuid) {
      this.isFumble = false;
      this.attackTotal = 9999;
      await this.checkHits(this.options);
      this.hitTargets = new Set(this.targets);
      await this.displayHits(whisperCard, false);
      await this.displayDamageRolls();
    } else {
      await this.damageRoll?.toMessage({ flavor: this.flavor });
    }
    this.hitTargets = new Set(this.targets);
    this.hitTargetsEC = new Set();
    this.effectTargets = new Set(this.targets);
    // TODO change this to the new apply token damage call - sigh
    this.damageList = await applyTokenDamage(this.rawDamageDetail, this.damageTotal, this.targets, this.item, new Set(), { existingDamage: this.damageList, superSavers: new Set(), semiSuperSavers: new Set(), workflow: this, updateContext: undefined, forceApply: false })
    super.WorkflowState_RollFinished().then(() => { Workflow.removeWorkflow(this.id) });
    return this.WorkflowState_Suspend;
  }
}

export class TrapWorkflow extends Workflow {
  templateLocation: { x: number, y: number, direction?: number, removeDelay?: number } | undefined;
  saveTargets: any;

  //@ts-expect-error dnd5e v10
  constructor(actor: globalThis.dnd5e.documents.Actor5e, activity, targets: Array<Token> | undefined,
    templateLocation: { x: number, y: number, direction?: number, removeDelay?: number } | undefined = undefined,
    trapSound: { playlist: string, sound: string } | undefined = undefined, event: any = {}) {
    super(actor, activity, ChatMessage.getSpeaker({ actor }), new Set(targets), event);
    // this.targets = new Set(targets);
    if (!this.event) this.event = foundry.utils.duplicate(shiftOnlyEvent);
    if (templateLocation) this.templateLocation = templateLocation;
    // this.saveTargets = game.user.targets; 
    this.rollOptions.fastForward = true;
    this.kickStart = false;
    this.suspended = false;
    this.activity.use({ configure: false }, {}, {})
    // this.performState(this.WorkflowState_Start);
    return this;
  }

  get workflowType() { return "TrapWorkflow" };

  async WorkflowState_Start(context: any = {}): Promise<WorkflowState> {
    this.saveTargets = validTargetTokens(game.user?.targets);
    this.effectsAlreadyExpired = [];
    this.onUseMacroCalled = false;
    /*    const itemCard = await (this.item.displayCard({ systemCard: false, workflow: this, createMessage: true, defaultCard: true }));
        if (itemCard) {
          this.itemCardUuid = itemCard.uuid;
          this.itemCardId = itemCard.id
        }
        */
    // this.activity.use({ configure: false }, {}, {})
    // this.itemCardId = (await showItemCard.bind(this.item)(false, this, true))?.id;
    if (debugEnabled > 1) debug(" Trapworkflow | WorkflowState_Start ", this.item, getActivityAutoTarget(this.activity), activityHasAreaTarget(this.activity), this.targets);
    // don't support the placement of a template
    return this.WorkflowState_AwaitTemplate
  }
  async WorkflowState_AwaitTemplate(context: any = {}): Promise<WorkflowState> {
    if (activityHasEmanationNoTemplate(this.activity)) {
      this.setRangedTargets(this.activity.target);
      this.targets = validTargetTokens(this.targets);
      this.failedSaves = new Set(this.targets)
      this.hitTargets = new Set(this.targets);
      this.hitTargetsEC = new Set();
      return this.WorkflowState_TemplatePlaced;
    }
    if (!activityHasAreaTarget(this.activity) || !this.templateLocation)
      return this.WorkflowState_TemplatePlaced;
    //@ts-expect-error .canvas
    const TemplateClass = game.system.canvas.AbilityTemplate;
    const abilityTemplates = TemplateClass.fromActivity(this.activity);
    const templateData = abilityTemplates[0].document.toObject(false);
    // template.draw();
    // get the x and y position from the trapped token
    templateData.x = this.templateLocation?.x || 0;
    templateData.y = this.templateLocation?.y || 0;
    templateData.direction = this.templateLocation?.direction || 0;

    // Create the template
    let templates = await canvas?.scene?.createEmbeddedDocuments("MeasuredTemplate", [templateData]);
    if (templates) {
      const templateDocument: any = templates[0];
      const selfToken = getToken(this.tokenUuid);
      const ignoreSelf = foundry.utils.getProperty(this.item, `flags.${MODULE_ID}.trapWorkflow.ignoreSelf`) ?? false;
      const AoETargetType = getAoETargetType(this.activity);
      templateTokens(templateDocument.object, selfToken, ignoreSelf, AoETargetType);
      selectTargets.bind(this)(templateDocument, null, game.user?.id); // Target the tokens from the template
      if (this.templateLocation?.removeDelay) {
        //@ts-expect-error _ids
        let ids: string[] = templates.map(td => td._id)
        //TODO test this again
        setTimeout(() => canvas?.scene?.deleteEmbeddedDocuments("MeasuredTemplate", ids), this.templateLocation.removeDelay * 1000);
      }
    }
    return this.WorkflowState_TemplatePlaced
  }
  async WorkflowState_TemplatePlaced(context: any = {}): Promise<WorkflowState> {
    // perhaps auto place template?
    this.needTemplate = false;
    return this.WorkflowState_ValidateRoll;
  }
  async WorkflowState_ValidateRoll(context: any = {}): Promise<WorkflowState> {
    // do pre roll checks
    return this.WorkflowState_WaitForSaves
  }
  async WorkflowState_WaitForAttackRoll(context: any = {}): Promise<WorkflowState> {
    if (!this.activity.attack) {
      this.hitTargets = new Set(this.targets);
      this.hitTargetsEC = new Set();
      return this.WorkflowState_WaitForSaves;
    }
    if (debugEnabled > 0) warn("waitForAttackRoll | attack roll ", this.event)
    this.activity.rollAttack({ event: this.event, midiOptions: {} });
    return this.WorkflowState_Suspend;
  }
  async WorkflowState_AttackRollComplete(context: any = {}): Promise<WorkflowState> {
    const attackRollCompleteStartTime = Date.now();
    await this.processAttackRoll();
    await this.displayAttackRoll();
    await this.checkHits(this.options);
    const whisperCard = configSettings.autoCheckHit === "whisper" || game.settings.get("core", "rollMode") === "blindroll";
    await this.displayHits(whisperCard);
    if (debugCallTiming) log(`AttackRollComplete elapsed time ${Date.now() - attackRollCompleteStartTime}ms`)
    return this.WorkflowState_WaitForSaves;
  }
  async WorkflowState_WaitForSaves(context: any = {}): Promise<WorkflowState> {
    this.initSaveResults();
    if (!this.activity.save) {
      this.saves = new Set(); // no saving throw, so no-one saves
      const allHitTargets = new Set([...this.hitTargets, ...this.hitTargetsEC]);
      this.failedSaves = new Set(allHitTargets);
      return this.WorkflowState_WaitForDamageRoll;
    }
    let hookId = Hooks.on("createChatMessage", this.processSaveRoll.bind(this));
    //        let brHookId = Hooks.on("renderChatMessage", this.processBetterRollsChatCard.bind(this));
    let monksId = Hooks.on("updateChatMessage", this.monksSavingCheck.bind(this));
    try {
      await this.checkSaves(configSettings.autoCheckSaves !== "allShow");
    } catch (err) {
      TroubleShooter.recordError(err, "checkSaves");
    } finally {
      Hooks.off("renderChatMessage", hookId);
      //          Hooks.off("renderChatMessage", brHookId);
      Hooks.off("updateChatMessage", monksId)
    }
    //@ts-expect-error .events not defined
    if (debugEnabled > 1) debug("Check Saves: renderChat message hooks length ", Hooks.events["renderChatMessage"]?.length);
    await this.displaySaves(configSettings.autoCheckSaves === "whisper");
    return this.WorkflowState_SavesComplete;
  }
  async WorkflowState_SavesComplete(context: any = {}): Promise<WorkflowState> {
    return this.WorkflowState_WaitForDamageRoll
  }

  async WorkflowState_WaitForDamageRoll(context: any = {}): Promise<WorkflowState> {
    if (context.damageRoll) return this.WorkflowState_DamageRollComplete;
    if (!this.activity.hasDamage && !this.activity.hasHealing) return this.WorkflowState_AllRollsComplete;

    if (this.isFumble) {
      // fumble means no trap damage/effects
      return this.WorkflowState_RollFinished;
    }
    if (debugEnabled > 1) debug("TrapWorkflow: Rolling damage ", this.event, this.spellLevel, this.rollOptions.versatile, this.targets, this.hitTargets);
    this.rollOptions.fastForward = true;
    this.rollOptions.spellLevel = this.spellLevel;
    this.activity.rollDamage({ midiOptions: this.rollOptions }, {}, {});
    return this.WorkflowState_Suspend; // wait for a damage roll to advance the state.
  }
  async WorkflowState_DamageRollComplete(context: any = {}): Promise<WorkflowState> {
    if (!this.activity.attack) { // no attack roll so everyone is hit
      this.hitTargets = new Set(this.targets);
      this.hitTargetsEC = new Set();
      if (debugEnabled > 0) warn("damageRollComplete | for non auto target area effects spells", this)
    }

    // If the item does damage, use the same damage type as the item
    let defaultDamageType = getActivityDefaultDamageType(this.activity) ?? this.defaultDamageType
    this.rawDamageDetail = createDamageDetailV4({ roll: this.damageRolls, activity: this.activity, defaultType: defaultDamageType });
    if (this.bonusDamageRolls)
      this.rawBonusDamageDetail = createDamageDetailV4({ roll: this.bonusDamageRolls, activity: this.activity, defaultType: defaultDamageType });
    else
      this.rawBonusDamageDetail = [];
    if (this.otherDamageRolls)
      this.rawOtherDamageDetail = createDamageDetailV4({ roll: this.otherDamageRolls, activity: this.activity, defaultType: defaultDamageType });
    else
      this.rawOtherDamageDetail = [];
    // apply damage to targets plus saves plus immunities
    await this.displayDamageRolls();
    if (this.isFumble) {
      return this.WorkflowState_ApplyDynamicEffects
    }
    return this.WorkflowState_AllRollsComplete;
  }
  async WorkflowState_AllRollsComplete(context: any = {}): Promise<WorkflowState> {
    if (debugEnabled > 1) debug("all rolls complete ", foundry.utils.duplicate(this.rawDamageDetail))
    if (this.rawDamageDetail.length) await processDamageRoll(this, this.rawDamageDetail[0].type)
    return this.WorkflowState_ApplyDynamicEffects;
  }
  async WorkflowState_RollFinished(context: any = {}): Promise<WorkflowState> {
    // area effect trap, put back the targets the way they were
    if (this.saveTargets && activityHasAreaTarget(this.activity)) {
      game.user?.targets.forEach(t => {
        t.setTarget(false, { releaseOthers: false });
      });
      game.user?.targets.clear();
      this.saveTargets.forEach(t => {
        t.setTarget(true, { releaseOthers: false })
        game.user?.targets.add(t)
      })
    }
    return super.WorkflowState_RollFinished
  }
}

export class DDBGameLogWorkflow extends Workflow {
  DDBGameLogHookId: number;

  static get(id: string): DDBGameLogWorkflow {
    return Workflow._workflows[id];
  }

  //@ts-expect-error dnd5e v10
  constructor(actor: globalThis.dnd5e.documents.Actor5e, item: globalThis.dnd5e.documents.Item5e, speaker, targets: Token[], options: any) {
    super(actor, item, speaker, targets, options);
    this.needTemplate = activityHasAreaTarget(this.activity) ?? false;
    this.needItemCard = false;
    this.preItemUseComplete = true;
    this.needsDamage = this.item.hasDamage;
    this.attackRolled = !item.hasAttack;
    if (configSettings.undoWorkflow) this.undoData = { actor: actor.id, item: item.id, targets: Array.from(targets).map(t => t.id), options: options };
    /*
    if (this.item.system.formula) {
      shouldRollOtherDamage.bind(this.otherDamageItem)(this, configSettings.rollOtherDamage, configSettings.rollOtherSpellDamage)
        .then(result => this.needsOtherDamage = result);
    }
    */
    // this.needsOtherDamage = this.item.system.formula && shouldRollOtherDamage.bind(this.otherDamageItem)(this, configSettings.rollOtherDamage, configSettings.rollOtherSpellDamage);
    this.kickStart = true;
    this.flagTags = { "ddb-game-log": { "midi-generated": true } };
    if (configSettings.undoWorkflow) saveUndoData(this);
  }

  async complete() {
    if (this._roll) {
      await this._roll.update({
        "flags.midi-qol.type": MESSAGETYPES.HITS,
        "flags.midi-qol.displayId": this.displayId
      });
      this._roll = null;
    }
  }
  async WorkflowState_PreambleComplete(context: any = {}): Promise<WorkflowState> {
    return super.WorkflowState_PreambleComplete(context);
  }

  async WorkflowState_WaitForAttackRoll(context: any = {}): Promise<WorkflowState> {
    if (context.attackRoll) return this.WorkflowState_AttackRollComplete;
    if (!this.activity.attack) {
      return this.WorkflowState_AttackRollComplete;
    }
    if (!this.attackRolled) return this.WorkflowState_Suspend;
    return this.WorkflowState_AttackRollComplete;
  }
  async WorkflowState_AttackRollComplete(context: any = {}): Promise<WorkflowState> {
    this.effectsAlreadyExpired = [];
    if (checkRule("removeHiddenInvis")) await removeHidden.bind(this)();
    await asyncHooksCallAll("midi-qol.preCheckHits", this);
    if (this.item) await asyncHooksCallAll(`midi-qol.preCheckHits.${this.item.uuid}`, this);

    if (debugEnabled > 1) debug(this.attackRollHTML)
    if (configSettings.autoCheckHit !== "none" && this.activity.attack) {
      await this.checkHits(this.options);
      await this.displayHits(configSettings.autoCheckHit === "whisper");
    }
    await asyncHooksCallAll("midi-qol.AttackRollComplete", this);
    if (this.item) await asyncHooksCallAll(`midi-qol.AttackRollComplete.${this.item.uuid}`, this);
    if (this.aborted) return this.WorkflowState_Abort;
    return this.WorkflowState_WaitForDamageRoll;
  }

  async WorkflowState_AwaitTemplate(context: any = {}): Promise<WorkflowState> {
    if (!activityHasAreaTarget(this.activity)) return super.WorkflowState_AwaitTemplate;
    let system: any = game.system;
    // Create the template
    const template = system.canvas.AbilityTemplate.fromItem(this.item);
    if (template) template.drawPreview();
    return super.WorkflowState_AwaitTemplate;
  }
  async WorkflowState_WaitForDamageRoll(context: any = {}): Promise<WorkflowState> {
    if (this.needsDamage && this.item.hasDamage) return this.WorkflowState_Suspend;
    if (this.needsOtherDamage) return this.WorkflowState_Suspend;
    if (context.attackRoll) return this.WoorkflowState_AttackRollComplete;
    const allHitTargets = new Set([...this.hitTargets, ...this.hitTargetsEC]);
    this.failedSaves = new Set(allHitTargets);
    if (!this.activity.hasDamage && !this.activity.hasHealing) return this.WorkflowState_WaitForSaves;
    return this.WorkflowState_DamageRollComplete;
  }
  async WorkflowState_DamageRollComplete(context: any = {}): Promise<WorkflowState> {
    this.defaultDamageType = getActivityDefaultDamageType(this.activity) ?? this.defaultDamageType ?? MQdefaultDamageType;
    if (this.activity.actionType === "heal" && !Object.keys(GameSystemConfig.healingTypes).includes(this.defaultDamageType ?? "")) this.defaultDamageType = "healing";

    this.rawDamageDetail = createDamageDetailV4({ roll: this.damageRolls, activity: this.activity, defaultType: this.defaultDamageType });

    const damageBonusMacros = this.getDamageBonusMacros();
    if (damageBonusMacros) {
      await this.rollBonusDamage(damageBonusMacros);
    }
    this.rawOtherDamageDetail = [];
    if (this.bonusDamageRolls) {
      const messageData = {
        flavor: this.bonusDamageFlavor,
        speaker: this.speaker
      }
      foundry.utils.setProperty(messageData, `flags.${game.system.id}.roll.type`, "midi");
      this.bonusDamageRoll?.toMessage(messageData); // see if this can deal with an array of rolls
    }
    expireMyEffects.bind(this)(["1Attack", "1Action", "1Spell"]);

    if (getActivityAutoTarget(this.activity) === "none" && activityHasAreaTarget(this.activity) && !this.activity.attack) {
      // we are not auto targeting so for area effect attacks, without hits (e.g. fireball)
      this.targets = validTargetTokens(game.user?.targets);
      this.hitTargets = validTargetTokens(game.user?.targets);
      this.hitTargetsEC = new Set();
    }
    // apply damage to targets plus saves plus immunities
    if (this.isFumble) { //TODO: Is this right?
      return this.WorkflowState_RollFinished;
    }
    if (this.activity.save) return this.WorkflowState_WaitForSaves
    return this.WorkflowState_AllRollsComplete;
  }

  async WorkflowState_RollFinished(context: any = {}): Promise<WorkflowState> {
    if (this.placeTemplateHookId) {
      Hooks.off("createMeasuredTemplate", this.placeTemplateHookId);
      Hooks.off("preCreateMeasuredTemplate", this.preCreateTemplateHookId);
    }
    if (this.postSummonHookId) Hooks.off("dnd5e.postSummon", this.postSummonHookId);
    super.WorkflowState_RollFinished().then(() => Workflow.removeWorkflow(this.activity.uuid));
    return this.WorkflowState_Suspend;
  }
}

export class DummyWorkflow extends Workflow {
  //@ts-expect-error dnd5e v10
  constructor(actor: globalThis.dnd5e.documents.Actor5e, item: globalThis.dnd5e.documents.Item5e, speaker, targets, options: any) {
    options.noTemplateHook = true;
    super(actor, item, speaker, targets, options);
    this.advantage = options?.advantage;
    this.disadvantage = options?.disadvantage
    this.rollOptions.fastForward = options?.fastForward;
    this.rollOptions.fastForwardKey = options?.fastFowrd;
  }

  async performState(newState: (() => Promise<WorkflowState>) | undefined) {
    return super.performState(this.WorkflowState_Suspend);
  }
  async simulateSave(targets: Token[]) {
    this.targets = new Set(targets);
    this.hitTargets = new Set(targets)
    this.initSaveResults();
    await this.checkSaves(true, true);
    for (let result of this.saveResults) {
      result.saveAdvantage = result.options.advantageMode === 1;
      result.saveDisadvantage = result.options.advantageMode === -1;
      result.saveRoll = await new Roll(result.formula).evaluate();
      const maxroll = (await result.saveRoll?.reroll({ maximize: true }))?.total;
      const minroll = (await result.saveRoll?.reroll({ minimize: true }))?.total;
      result.expectedSaveRoll = ((maxroll || 0) + (minroll || 0)) / 2;
      if (result.saveAdvantage) result.expectedSaveRoll += 3.325;
      if (result.saveDisadvantage) result.expectedSaveRoll -= 3.325;
    }
    return this;
  }
  async simulateAttack(target: Token) {
    this.targets = new Set([target]);
    this.advantage = false;
    this.disadvantage = false;
    await this.checkAttackAdvantage();
    // Block updates to quantity
    const hookId = Hooks.on("dnd5e.rollAttack", (item, roll, ammoUpdate) => {
      if (item === this.item && ammoUpdate?.length) ammoUpdate.length = 0
    });
    try {
      this.attackRoll = await this.activity?.rollAttack({ midiOptions: { fastForward: true, chatMessage: false, isDummy: true } }, {}, {})
    } catch (err) {
      TroubleShooter.recordError(err, "simulate attack");
    } finally {
      Hooks.off("preUpdateItem", hookId)
    }
    const maxroll = (await this.attackRoll?.reroll({ maximize: true }))?.total;
    const minroll = (await this.attackRoll?.reroll({ minimize: true }))?.total;
    this.expectedAttackRoll = ((maxroll || 0) + (minroll || 0)) / 2;
    if (this.advantage) this.expectedAttackRoll += 3.325;
    if (this.disadvantage) this.expectedAttackRoll -= 3.325;
    return this;
  }
}

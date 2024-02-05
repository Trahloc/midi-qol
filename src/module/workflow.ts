import { warn, debug, log, i18n, MESSAGETYPES, error, MQdefaultDamageType, debugEnabled, MQItemMacroLabel, debugCallTiming, geti18nOptions, allAttackTypes, i18nFormat } from "../midi-qol.js";
import { postTemplateConfirmTargets, preTemplateTargets, selectTargets, shouldRollOtherDamage, templateTokens } from "./itemhandling.js";
import { socketlibSocket, timedAwaitExecuteAsGM, timedExecuteAsGM, untimedExecuteAsGM } from "./GMAction.js";
import { installedModules } from "./setupModules.js";
import { configSettings, autoRemoveTargets, checkRule, autoFastForwardAbilityRolls, checkMechanic, safeGetGameSetting } from "./settings.js";
import { createDamageDetail, processDamageRoll, untargetDeadTokens, getSaveMultiplierForItem, requestPCSave, applyTokenDamage, checkRange, checkIncapacitated, getAutoRollDamage, isAutoFastAttack, getAutoRollAttack, itemHasDamage, getRemoveDamageButtons, getRemoveAttackButtons, getTokenPlayerName, checkNearby, hasCondition, getDistance, expireMyEffects, validTargetTokens, getSelfTargetSet, doReactions, playerFor, addConcentration, getDistanceSimple, requestPCActiveDefence, evalActivationCondition, playerForActor, processDamageRollBonusFlags, asyncHooksCallAll, asyncHooksCall, MQfromUuid, midiRenderRoll, markFlanking, canSense, getSystemCONFIG, tokenForActor, getSelfTarget, createConditionData, evalCondition, removeHidden, ConcentrationData, hasDAE, computeCoverBonus, FULL_COVER, isInCombat, getSpeaker, displayDSNForRoll, setActionUsed, removeInvisible, isTargetable, hasWallBlockingCondition, getTokenDocument, getToken, itemRequiresConcentration, checkDefeated, getLinkText, getIconFreeLink, completeItemUse, getStatusName, hasUsedReaction, getConcentrationEffect, needsReactionCheck, hasUsedBonusAction, needsBonusActionCheck, getAutoTarget, hasAutoPlaceTemplate, effectActivationConditionToUse, itemOtherFormula, addRollTo } from "./utils.js"
import { OnUseMacros } from "./apps/Item.js";
import { bonusCheck, collectBonusFlags, defaultRollOptions, procAbilityAdvantage, procAutoFail, removeConcentration } from "./patching.js";
import { mapSpeedKeys } from "./MidiKeyManager.js";
import { saveTargetsUndoData } from "./undo.js";
import { TroubleShooter } from "./apps/TroubleShooter.js";
import { busyWait } from "./tests/setupTest.js";

export const shiftOnlyEvent = { shiftKey: true, altKey: false, ctrlKey: false, metaKey: false, type: "" };
export function noKeySet(event) { return !(event?.shiftKey || event?.ctrlKey || event?.altKey || event?.metaKey) }
export let allDamageTypes;

class damageBonusMacroResult {
  damageRoll: string | undefined;
  flavor: string | undefined;
}
export type WorkflowState = undefined | ((context: any) => Promise<WorkflowState>);

export class Workflow {
  [x: string]: any;
  static _workflows: {} = {};

  //@ts-ignore dnd5e v10
  actor: globalThis.dnd5e.documents.Actor5e;
  //@ts-ignore dnd5e v10
  item: globalThis.dnd5e.documents.Item5e;
  itemCardId: string | undefined | null;
  itemCardData: {};
  displayHookId: number | null;
  templateElevation: number;

  event: { shiftKey: boolean, altKey: boolean, ctrlKey: boolean, metaKey: boolean, type: string };
  capsLock: boolean;
  speaker: any;
  tokenUuid: string | undefined;  // TODO change tokenId to tokenUuid
  targets: Set<Token | TokenDocument>;
  placeTemplateHookId: number | null;
  inCombat: boolean; // Is the item wielder in combat.
  isTurn: boolean; // Is it the item wielder's turn.
  AoO: boolean; // Is the attack an attack of

  _id: string;
  saveDisplayFlavor: string;
  showCard: boolean;
  get id() { return this._id }
  get uuid() { return this._id }
  itemId: string;
  itemUuid: string;
  spellLevel: number;
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

  damageRoll: Roll | undefined;
  damageTotal: number;
  damageDetail: any[];
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
  //@ts-ignore dnd5e v10
  reactionUpdates: Set<globalThis.dnd5e.documents.Actor5e>;
  flagTags: {} | undefined;
  onUseMacros: OnUseMacros | undefined;
  ammoOnuseMacros: OnUseMacros | undefined;

  attackAdvAttribution: Set<string>;
  advReminderAttackAdvAttribution: Set<string>;
  undoData: any = undefined;

  static get workflows() { return Workflow._workflows }
  static getWorkflow(id: string): Workflow | undefined {
    if (debugEnabled > 1) debug("Get workflow ", id, Workflow._workflows, Workflow._workflows[id])
    return Workflow._workflows[id];
  }

  get workflowType() { return this.__proto__.constructor.name };

  get hasSave(): boolean {
    if (this.ammo?.hasSave) return true;
    if (this.item?.hasSave) return true;
    if (configSettings.rollOtherDamage && this.shouldRollOtherDamage) return this.otherDamageItem?.hasSave;
    return false;
  }

  get saveItem() {
    if (this.ammo?.hasSave) return this.ammo;
    if (this.item?.hasSave) return this.item;
    if (configSettings.rollOtherDamage && this.otherDamageItem?.hasSave) return this.otherDamageItem;
    return this.item;
  }

  get otherDamageItem() {
    if (this.ammo && (this.ammo?.system.formula ?? "") !== "") return this.ammo;
    return this.item;

  }

  get otherDamageFormula() {
    return itemOtherFormula(this.otherDamageItem);
  }

  public processAttackEventOptions() { }

  get shouldRollDamage(): boolean {
    // if ((this.itemRollToggle && getAutoRollDamage(this)) || !getAutoRollDamage(this))  return false;
    if (this.systemCard) return false;
    if (this.actor.type === "npc" && configSettings.averageNPCDamage) return true;
    const normalRoll = getAutoRollDamage(this) === "always"
      || (getAutoRollDamage(this) === "saveOnly" && this.item.hasSave && !this.item.hasAttack)
      || (getAutoRollDamage(this) !== "none" && !this.item.hasAttack)
      || (getAutoRollDamage(this) === "onHit" && (this.hitTargets.size > 0 || this.hitTargetsEC.size > 0 || this.targets.size === 0))
      || (getAutoRollDamage(this) === "onHit" && (this.hitTargetsEC.size > 0));
    return this.itemRollToggle ? !normalRoll : normalRoll;
  }

  constructor(actor: any /* Actor5e*/, item: any /* Item5e*/, speaker, targets, options: any = {}) {
    this.actor = actor;
    this.item = item;
    if (Workflow.getWorkflow(item?.uuid) && !(this instanceof DummyWorkflow)) {
      const existing = Workflow.getWorkflow(item.uuid);
      if (existing) {
        Workflow.removeWorkflow(item.uuid);
        //TODO check this
        if ([existing.WorkflowState_RollFinished, existing.WorkflowState_WaitForDamageRoll].includes(existing.currentAction) && existing.itemCardId) {
          game.messages?.get(existing.itemCardId)?.delete();
        }
      }
    }

    if (!this.item || this instanceof DummyWorkflow) {
      this.itemId = randomID();
      this._id = randomID();
      this.workflowName = `workflow ${this._id}`;
    } else {
      this.itemId = item.id;
      this.itemUuid = item.uuid;
      this._id = item.uuid;
      this.workflowName = options.workflowOptions?.workflowName ?? this.item?.name ?? "no item";
      this.workflowName = `${this.constructor.name} ${this.workflowName} ${randomID()}`;
      const consume = item.system.consume;
      if (consume?.type === "ammo") {
        this.ammo = item.actor.items.get(consume.target);
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
    this.targets = new Set(targets);
    if (this.item?.system.target?.type === "self") this.targets = new Set([this.token]);
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
    this.spellLevel = item?.level || 0;
    this.displayId = this.id;
    this.itemCardData = {};
    this.attackCardData = undefined;
    this.damageCardData = undefined;
    this.event = options?.event;
    this.capsLock = options?.event?.getModifierState && options?.event.getModifierState("CapsLock");
    this.pressedKeys = options?.pressedKeys;
    this.itemRollToggle = options?.pressedKeys?.rollToggle ?? false;
    this.noOptionalRules = options?.noOptionalRules ?? false;
    this.attackRollCount = 0;
    this.damageRollCount = 0;
    this.advantage = undefined;
    this.disadvantage = undefined;
    this.isVersatile = false;
    this.templateId = null;
    this.templateUuid = null;

    this.saveRequests = {};
    this.defenceRequests = {};
    this.saveTimeouts = {};
    this.defenceTimeouts = {}
    this.shouldRollOtherDamage = true;
    this.forceApplyEffects = false;

    this.placeTemplateHookId = null;
    this.damageDetail = [];
    this.otherDamageDetail = [];
    this.displayHookId = null;
    this.onUseCalled = false;
    this.effectsAlreadyExpired = [];
    this.reactionUpdates = new Set();
    if (!(this instanceof DummyWorkflow)) Workflow._workflows[this.id] = this;
    this.needTemplate = this.item?.hasAreaTarget;
    this.attackRolled = false;
    this.damageRolled = false;
    this.flagTags = undefined;
    this.workflowOptions = options?.workflowOptions ?? {};
    if (options.pressedKeys) this.rollOptions = mapSpeedKeys(options.pressedKeys, "attack");
    this.rollOptions = mergeObject(this.rollOptions ?? defaultRollOptions, { autoRollAttack: getAutoRollAttack(this) || options?.pressedKeys?.rollToggle, autoRollDamage: getAutoRollDamage() || options?.pressedKeys?.rollToggle }, { overwrite: true });
    this.attackAdvAttribution = new Set();
    this.advReminderAttackAdvAttribution = new Set();
    this.systemString = game.system.id.toUpperCase();
    this.options = options;
    this.initSaveResults();

    if (configSettings.allowUseMacro) {
      this.onUseMacros = new OnUseMacros();
      this.ammoOnUseMacros = new OnUseMacros();
      const itemOnUseMacros = getProperty(this.item ?? {}, "flags.midi-qol.onUseMacroParts") ?? new OnUseMacros();
      const ammoOnUseMacros = getProperty(this.ammo ?? {}, "flags.midi-qol.onUseMacroParts") ?? new OnUseMacros();
      const actorOnUseMacros = getProperty(this.actor ?? {}, "flags.midi-qol.onUseMacroParts") ?? new OnUseMacros();
      //@ts-ignore
      this.onUseMacros.items = [...itemOnUseMacros.items, ...actorOnUseMacros.items];
      this.ammoOnUseMacros.items = ammoOnUseMacros.items;
    }
    this.preSelectedTargets = canvas?.scene ? new Set(game.user?.targets) : new Set(); // record those targets targeted before cast.
    if (this.item && ["spell", "feat", "weapon"].includes(this.item.type)) {
      if (!this.item?.flags.midiProperties) {
        this.item.flags.midiProperties = {};
        this.item.flags.midiProperties.fulldam = this.item.system.properties?.fulldam;
        this.item.flags.midiProperties.halfdam = this.item.system.properties?.halfdam;
        this.item.flags.midiProperties.nodam = this.item.system.properties?.nodam;
        this.item.flags.midiProperties.critOther = this.item.system.properties?.critOther;
      }
    }
    this.needTemplate = (getAutoTarget(this.item) !== "none" && this.item?.hasAreaTarget && !hasAutoPlaceTemplate(this.item));
    if (this.needTemplate && options.noTemplateHook !== true) {
      this.preCreateTemplateHookId = Hooks.once("preCreateMeasuredTemplate", this.setTemplateFlags.bind(this));
      this.placeTemplateHookId = Hooks.once("createMeasuredTemplate", selectTargets.bind(this));
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

  setTemplateFlags(templateDoc, data, context, user): boolean {
    if (this.item) templateDoc.updateSource({ "flags.midi-qol.itemUuid": this.item.uuid });
    if (this.actor) templateDoc.updateSource({ "flags.midi-qol.actorUuid": this.actor.uuid });
    if (!getProperty(templateDoc, "flags.dnd5e.origin")) templateDoc.updateSource({ "flags.dnd5e.origin": this.item?.uuid });
    return true;
  }

  static async removeItemCardConfirmRollButton(itemCardId: string) {
    let chatMessage: ChatMessage | undefined = game.messages?.get(itemCardId ?? "");
    if (!chatMessage) return;
    //@ts-ignore .content v10
    let content = chatMessage && duplicate(chatMessage.content);
    const confirmMissRe = /<button class="midi-qol-confirm-damage-roll-complete-miss" data-action="confirm-damage-roll-complete-miss">[^<]*?<\/button>/;
    content = content?.replace(confirmMissRe, "");
    const confirmRe = /<button class="midi-qol-confirm-damage-roll-complete" data-action="confirm-damage-roll-complete">[^<]*?<\/button>/;
    content = content?.replace(confirmRe, "");
    const confirmHitRe = /<button class="midi-qol-confirm-damage-roll-complete-hit" data-action="confirm-damage-roll-complete-hit">[^<]*?<\/button>/;
    content = content?.replace(confirmHitRe, "");
    const cancelRe = /<button class="midi-qol-confirm-damage-roll-cancel" data-action="confirm-damage-roll-cancel">[^<]*?<\/button>/;
    content = content?.replace(cancelRe, "");
    return chatMessage.update({ content });
  }

  static async removeItemCardAttackDamageButtons(itemCardId: string, removeAttackButtons: boolean = true, removeDamageButtons: boolean = true) {
    try {
      let chatMessage: ChatMessage | undefined = game.messages?.get(itemCardId ?? "");
      if (!chatMessage) return;
      //@ts-ignore .content v10
      let content = chatMessage && duplicate(chatMessage.content);
      // TODO work out what to do if we are a damage only workflow and betters rolls is active - display update wont work.
      const attackRe = /<div class="midi-qol-attack-buttons[^"]*">[\s\S]*?<\/div>/
      // const otherAttackRe = /<button data-action="attack">[^<]*<\/button>/;
      const damageRe = /<div class="midi-qol-damage-buttons[^"]*">[\s\S]*?<\/div>/
      const versatileRe = /<button class="midi-qol-versatile-damage-button" data-action="versatile">[^<]*<\/button>/
      const otherDamageRe = /<button class="midi-qol-otherDamage-button" data-action="formula">[^<]*<\/button>/

      const formulaRe = /<button data-action="formula">[^<]*<\/button>/
      if (removeAttackButtons) {
        content = content?.replace(attackRe, "")
        // content = content.replace(otherAttackRe, "");
      }
      if (removeDamageButtons) {
        content = content?.replace(damageRe, "")
        content = content?.replace(otherDamageRe, "")
        content = content?.replace(formulaRe, "")
        content = content?.replace(versatileRe, "<div></div>")
      }
      return chatMessage.update({ content });
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
      Hooks.off("preCreateMeasuredTemplate", workflow.preCreateTemplateHookId)
    }
    delete Workflow._workflows[id];
    // Remove buttons
    if (workflow.itemCardId) {
      if (workflow.currentAction === workflow.WorkflowState_ConfirmRoll) {
        const itemCard = game.messages?.get(workflow.itemCardId);
        if (itemCard) await itemCard.delete();
      } else {
        await Workflow.removeItemCardAttackDamageButtons(workflow.itemCardId);
        await Workflow.removeItemCardConfirmRollButton(workflow.itemCardId);
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
    const allHooks = mergeObject(geti18nOptions("onUseMacroOptions"), this.stateHooks);
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
    const hookName = `midi-qol.${prePost}${this.nameForState(action)}`
    if (await asyncHooksCall(hookName, this) === false) return false;
    if (this.item) {
      return await asyncHooksCall(`${hookName}.${this.item.uuid}`, this);
    }
    return true;
  }
  async callOnUseMacrosForAction(prePost: ("pre" | "post"), action: WorkflowState): Promise<(damageBonusMacroResult | boolean | undefined)[]> {
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
      this.needTemplate = false;
    }
    if (context.itemCardId) {
      this.itemCardId = context.itemCardId;
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
    const MaxTransitionCount = 100;
    let isAborting = this.aborted;

    try {
      while (this.stateTransitionCount < (this.MaxTransitionCount ?? MaxTransitionCount)) {
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
        const currentName = this.nameForState(this.currentAction);

        if (this.currentAction !== newState) {
          if (await this.callHooksForAction("post", this.currentAction) === false && !isAborting) {
            console.warn(`${this.workflowName} ${currentName} -> ${name} aborted by post ${this.nameForState(this.currentAction)} Hook`)
            newState = this.aborted ? this.WorkflowState_Abort : this.WorkflowState_RollFinished;
            continue;
          }
          await this.callOnUseMacrosForAction("post", this.currentAction);
          if (debugEnabled > 0) warn(`${this.workflowName} finished ${currentName}`);
          if (debugEnabled > 0) warn(`${this.workflowName} transition ${this.nameForState(this.currentAction)} -> ${name}`);

          if (this.aborted && !isAborting) {
            console.warn(`${this.workflowName} ${currentName} -> ${name} aborted by pre ${this.nameForState(this.currentAction)} macro pass`)
            newState = this.WorkflowState_Abort;
            continue;
          }

          if (await this.callHooksForAction("pre", newState) === false && !isAborting) {
            console.warn(`${this.workflowName} ${currentName} -> ${name} aborted by pre ${this.nameForState(newState)} Hook`)
            newState = this.aborted ? this.WorkflowState_Abort : this.WorkflowState_RollFinished;
            continue;
          }
          await this.callOnUseMacrosForAction("pre", newState);
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
    if (context.itemUseComplete) return this.WorkflowState_Start;
    return this.WorkflowState_Suspend;
  }

  async WorkflowState_Start(context: any = {}): Promise<WorkflowState> {
    this.selfTargeted = false;
    if (this.item?.system.target?.type === "self") {
      this.targets = getSelfTargetSet(this.actor);
      this.hitTargets = new Set(this.targets);
      this.selfTargeted = true;
    }
    this.temptargetConfirmation = getAutoTarget(this.item) !== "none" && this.item?.hasAreaTarget;
    if (debugEnabled > 1) debug("WORKFLOW NONE", getAutoTarget(this.item), this.item?.hasAreaTarget);
    if (this.temptargetConfirmation) {
      return this.WorkflowState_AwaitTemplate;
    }
    const targetDetails = this.item.system.target;
    this.rangeTargeting = configSettings.rangeTarget !== "none" && ["ft", "m"].includes(targetDetails?.units) && ["creature", "ally", "enemy"].includes(targetDetails?.type);
    if (this.rangeTargeting) {
      this.setRangedTargets(targetDetails);
      this.targets = validTargetTokens(this.targets);
      this.failedSaves = new Set(this.targets)
      this.hitTargets = new Set(this.targets);
      this.hitTargetsEC = new Set();
      return this.WorkflowState_AoETargetConfirmation;
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
    if (configSettings.allowUseMacro) {
      await this.callMacros(this.item, this.onUseMacros?.getMacros("templatePlaced"), "OnUse", "templatePlaced");
      if (this.ammo) await this.callMacros(this.ammo, this.ammoOnUseMacros?.getMacros("templatePlaced"), "OnUse", "templatePlaced");
    }

    // Some modules stop being able to get the item card id.
    if (!this.itemCardId) return this.WorkflowState_AoETargetConfirmation;

    const chatMessage: ChatMessage | undefined = game.messages?.get(this.itemCardId);
    // remove the place template button from the chat card.
    this.targets = validTargetTokens(this.targets);
    this.hitTargets = new Set(this.targets)
    this.hitTargetsEC = new Set();
    //@ts-ignore .content v10
    let content = chatMessage && duplicate(chatMessage.content)
    let buttonRe = /<button data-action="placeTemplate">[^<]*<\/button>/
    content = content?.replace(buttonRe, "");
    await chatMessage?.update({
      "content": content,
      "flags.midi-qol.type": MESSAGETYPES.ITEM,
      type: CONST.CHAT_MESSAGE_TYPES.OTHER
    });
    return this.WorkflowState_AoETargetConfirmation;
  }
  async WorkflowState_AoETargetConfirmation(context: any = {}): Promise<WorkflowState> {
    if (this.item?.system.target?.type !== "" && this.workflowOptions.targetConfirmation !== "none") {
      if (!await postTemplateConfirmTargets(this.item, this.workflowOptions, {}, this)) {
        return this.WorkflowState_Abort;
      }
    }
    return this.WorkflowState_ValidateRoll;
  }
  async WorkflowState_ValidateRoll(context: any = {}): Promise<WorkflowState> {
    // do pre roll checks
    if (checkMechanic("checkRange") !== "none" && (!this.AoO || ["rwak", "rsak", "rpak"].includes(this.item.system.actionType)) && this.tokenId) {
      const { result, attackingToken, range, longRange } = checkRange(this.item, canvas?.tokens?.get(this.tokenId) ?? "invalid", this.targets);
      switch (result) {
        case "fail": return this.WorkflowState_RollFinished;
        case "dis": this.disadvantage = true;
          this.attackAdvAttribution.add("DIS:range");
          this.advReminderAttackAdvAttribution.add("DIS:Long Range");
      }
      this.attackingToken = attackingToken;
    }
    if (!this.workflowOptions.allowIncapacitated && checkMechanic("incapacitated") && checkIncapacitated(this.actor, debugEnabled > 0)) return this.WorkflowState_RollFinished
    return this.WorkflowState_PreambleComplete;
  }
  async WorkflowState_PreambleComplete(context: any = {}): Promise<WorkflowState> {
    if (configSettings.undoWorkflow) await saveTargetsUndoData(this);
    this.effectsAlreadyExpired = [];

    //@ts-expect-error .events
    if (Hooks.events["midi-qol.preambleComplete"]) {
      const msg = `${this.workflowName} hook preambleComplete deprecated use prePreambleComplete instead`;
      //@ts-expect-error
      logCompatibilityWarning(msg, { since: "11.2.5", until: 12 })
      if (await asyncHooksCall("midi-qol.preambleComplete", this) === false) return this.WorkflowState_Abort;
    }
    //@ts-expect-error .events
    if (this.item && Hooks.events[`midi-qol.preambleComplete.${this.item.uuid}`]) {
      const msg = `${this.workflowName} hook preambleComplete deprecated use prePreambleComplete instead`;
      //@ts-expect-error
      logCompatibilityWarning(msg, { since: "11.2.5", until: 12 })
      if (await asyncHooksCall(`midi-qol.preambleComplete.${this.item.uuid}`, this) === false) return this.WorkflowState_Abort;
    };

    if (configSettings.allowUseMacro) {
      if ((this.onUseMacros?.getMacros("preambleComplete")?.length ?? 0) > 0) {
        const msg = `${this.workflowName} macroPass preambleComplete deprecated use prePreambleComplete instead`;
        //@ts-expect-error
        logCompatibilityWarning(msg, { since: "11.2.5", until: 12 })
      }
      await this.callMacros(this.item, this.onUseMacros?.getMacros("preambleComplete"), "OnUse", "preambleComplete");
      if (this.ammo) await this.callMacros(this.ammo, this.ammoOnUseMacros?.getMacros("preambleComplete"), "OnUse", "preambleComplete");
    }

    for (let token of this.targets) {
      for (let theItem of [this.item, this.ammo]) {
        const activationCondition = getProperty(theItem, "flags.midi-qol.itemCondition");
        if (activationCondition) {
          if (!evalActivationCondition(this, activationCondition, token)) {
            ui.notifications?.warn(`midi-qol | Activation condition ${activationCondition} failed roll cancelled`)
            return this.WorkflowState_Cancel;
          }
        }
      }
    }
    if (!getAutoRollAttack(this) && this.item?.hasAttack) {
      // Not auto rolling so display targets
      const rollMode = game.settings.get("core", "rollMode");
      this.whisperAttackCard = configSettings.autoCheckHit === "whisper" || rollMode === "blindroll" || rollMode === "gmroll";
      await this.displayTargets(this.whisperAttackCard);
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
      let procOptions = procAbilityAdvantage(this.actor, "check", abilityId, this.rollOptions);
      this.advantage = procOptions.advantage;
      this.disadvantage = procOptions.disadvantage;

      if (autoFastForwardAbilityRolls) {
        // procOptions.fastForward = !this.rollOptions.rollToggle;
        //            this.item.rollToolCheck({ fastForward: this.rollOptions.fastForward, advantage: hasAdvantage, disadvantage: hasDisadvantage })
        const options: any = mergeObject(procOptions, { critical: this.item.criticalThreshold ?? 20, fumble: 1 });
        const result = await this.item.rollToolCheck(options);
        return this.WorkflowState_WaitForDamageRoll;
      }
    }
    if (!this.item.hasAttack) {
      this.hitTargets = new Set(this.targets);
      this.hitTargetsEC = new Set();
      return this.WorkflowState_WaitForDamageRoll;
    }

    if (this.noAutoAttack) return this.WorkflowState_Suspend;
    this.autoRollAttack = this.rollOptions.advantage || this.rollOptions.disadvantage || this.rollOptions.autoRollAttack;
    if (!this.autoRollAttack) {
      // Not auto rolling attack so setup the buttons to display advantage/disadvantage
      const chatMessage: ChatMessage | undefined = game.messages?.get(this.itemCardId ?? "");
      const isFastRoll = this.rollOptions.fastForwarAttack ?? isAutoFastAttack(this);
      if (chatMessage && (!this.autoRollAttack || !isFastRoll)) {
        // provide a hint as to the type of roll expected.
        //@ts-ignore .content v10
        let content = chatMessage && duplicate(chatMessage.content)
        let searchRe = /<button data-action="attack">[^<]+<\/button>/;
        searchRe = /<div class="midi-attack-buttons".*<\/div>/;

        const hasAdvantage = this.advantage && !this.disadvantage;
        const hasDisadvantage = this.disadvantage && !this.advantage;
        let attackString = hasAdvantage ? i18n(`${this.systemString}.Advantage`) : hasDisadvantage ? i18n(`${this.systemString}.Disadvantage`) : i18n(`${this.systemString}.Attack`)
        if (isFastRoll && configSettings.showFastForward) attackString += ` ${i18n("midi-qol.fastForward")}`;
        let replaceString = `<button data-action="attack">${attackString}</button>`
        content = content.replace(searchRe, replaceString);
        await chatMessage?.update({ "content": content });
      } else if (!chatMessage) {
        const message = `WaitForAttackRoll | no chat message`;
        error(message);
        TroubleShooter.recordError(new Error(message), message);
      }
    }

    if (configSettings.allowUseMacro) {
      await this.callMacros(this.item, this.onUseMacros?.getMacros("preAttackRoll"), "OnUse", "preAttackRoll");
      if (this.ammo) await this.callMacros(this.ammo, this.ammoOnUseMacros?.getMacros("preAttackRoll"), "OnUse", "preAttackRoll");
    }
    if (this.autoRollAttack) {
      // REFACTOR -await
      this.item.rollAttack({ event: {} });
    }
    return this.WorkflowState_Suspend;
  }

  async WorkflowState_AttackRollComplete(context: any = {}): Promise<WorkflowState> {
    const attackRollCompleteStartTime = Date.now();
    const attackBonusMacro = getProperty(this.actor.flags, `${game.system.id}.AttackBonusMacro`);
    if (configSettings.allowUseMacro && attackBonusMacro) {
      // await this.rollAttackBonus(attackBonusMacro);
    }
    if (configSettings.allowUseMacro) await this.triggerTargetMacros(["isAttacked"]);
    this.processAttackRoll();
    // REFACTOR look at splitting this into a couple of states
    await asyncHooksCallAll("midi-qol.preCheckHits", this);
    if (this.item) await asyncHooksCallAll(`midi-qol.preCheckHits.${this.item.uuid}`, this);
    if (this.aborted) return this.WorkflowState_Abort;

    if (configSettings.allowUseMacro) {
      await this.callMacros(this.item, this.onUseMacros?.getMacros("preCheckHits"), "OnUse", "preCheckHits");
      if (this.ammo) await this.callMacros(this.ammo, this.ammoOnUseMacros?.getMacros("preCheckHits"), "OnUse", "preCheckHits");
    }

    this.processAttackRoll();
    // if (this.workflowOptions.attackRollDSN && this.attackRoll) await displayDSNForRoll(this.attackRoll, "attackRoll");
    if (!configSettings.mergeCard) { // non merge card is not displayed yet - display it now that the attack roll is completed
      const message = await this.attackRoll?.toMessage({
        speaker: getSpeaker(this.actor)
      });
      if (configSettings.undoWorkflow) {
        // Assumes workflow.undoData.chatCardUuids has been initialised
        if (this.undoData && message) {
          this.undoData.chatCardUuids = this.undoData.chatCardUuids.concat([message.uuid]);
          untimedExecuteAsGM("updateUndoChatCardUuids", this.undoData);
        }
      }
    }
    if (configSettings.autoCheckHit !== "none") {
      await this.displayAttackRoll(configSettings.mergeCard, { GMOnlyAttackRoll: true });
      await this.checkHits();
      await this.displayAttackRoll(configSettings.mergeCard);

      const rollMode = game.settings.get("core", "rollMode");
      this.whisperAttackCard = configSettings.autoCheckHit === "whisper" || rollMode === "blindroll" || rollMode === "gmroll";
      await this.displayHits(this.whisperAttackCard, configSettings.mergeCard);
    } else {
      await this.displayAttackRoll(configSettings.mergeCard);
    }
    if (checkRule("removeHiddenInvis")) await removeHidden.bind(this)();
    if (checkRule("removeHiddenInvis")) await removeInvisible.bind(this)();
    const attackExpiries = [
      "isAttacked"
    ];
    await this.expireTargetEffects(attackExpiries);


    await asyncHooksCallAll("midi-qol.AttackRollComplete", this);
    if (this.item) await asyncHooksCallAll(`midi-qol.AttackRollComplete.${this.id}`, this);
    if (this.aborted) return this.WorkflowState_Abort;

    if (configSettings.allowUseMacro) {
      await this.callMacros(this.item, this.onUseMacros?.getMacros("postAttackRoll"), "OnUse", "postAttackRoll");
      if (this.ammo) await this.callMacros(this.ammo, this.ammoOnUseMacros?.getMacros("postAttackRoll"), "OnUse", "postAttackRoll");
      if (this.aborted) return this.WorkflowState_Abort;
    }

    const noHits = this.hitTargets.size === 0 && this.hitTargetsEC.size === 0;
    const allMissed = noHits && this.targets.size !== 0;
    if (allMissed) {
      if (["onHit", "none"].includes(getAutoRollDamage(this)))
      // This actually causes an issue when the attack missed but GM might want to turn it into a hit.
      // || (configSettings.autoCheckHit !== "none" && this.hitTargets.size === 0 && this.hitTargetsEC.size === 0 && this.targets.size !== 0)
      {
        expireMyEffects.bind(this)(["1Attack", "1Action", "1Spell"])
        // Do special expiries
        await this.expireTargetEffects(["isAttacked"]);
        if (configSettings.confirmAttackDamage !== "none") return this.WorkflowState_ConfirmRoll;
        else return this.WorkflowState_RollFinished;
      }
    }
    if (debugCallTiming) log(`AttackRollComplete elapsed ${Date.now() - attackRollCompleteStartTime}ms`)
    return this.WorkflowState_WaitForDamageRoll;
  }
  async WorkflowState_WaitForDamageRoll(context: any = {}): Promise<WorkflowState> {
    if (context.damageRoll) {
      // record the data - currently done in item handling
      return this.WorkflowState_ConfirmRoll;
    }
    if (context.attackRoll) return this.WorkflowState_AttackRollComplete;
    if (debugEnabled > 1) debug(`wait for damage roll has damage ${itemHasDamage(this.item)} isfumble ${this.isFumble} no auto damage ${this.noAutoDamage}`);
    if (checkMechanic("actionSpecialDurationImmediate"))
      expireMyEffects.bind(this)(["1Attack", "1Action", "1Spell"]);
    if (checkMechanic("actionSpecialDurationImmediate") && this.hitTargets.size)
      expireMyEffects.bind(this)(["1Hit"]);

    if (!itemHasDamage(this.item) && !itemHasDamage(this.ammo)) return this.WorkflowState_WaitForSaves;

    if (configSettings.allowUseMacro) {
      await this.callMacros(this.item, this.onUseMacros?.getMacros("preDamageRoll"), "OnUse", "preDamageRoll");
      if (this.ammo) await this.callMacros(this.ammo, this.ammoOnUseMacros?.getMacros("preDamageRoll"), "OnUse", "preDamageRoll");
    }

    // if (this.noAutoDamage) return; // we are emulating the standard card specially.

    if (this.shouldRollDamage) {
      if (debugEnabled > 0) warn("waitForDamageRoll | rolling damage ", this.event, configSettings.autoRollAttack, configSettings.autoFastForward)
      const storedData: any = game.messages?.get(this.itemCardId ?? "")?.getFlag(game.system.id, "itemData");
      if (storedData) { // If magic items is being used it fiddles the roll to include the item data
        this.item = new CONFIG.Item.documentClass(storedData, { parent: this.actor })
      }

      this.rollOptions.spellLevel = this.spellLevel;

      this.item.rollDamage(this.rollOptions);
      return this.WorkflowState_Suspend;
    } else {
      this.processDamageEventOptions();
      const chatMessage: ChatMessage | undefined = game.messages?.get(this.itemCardId || "");
      if (chatMessage) {
        // provide a hint as to the type of roll expected.
        //@ts-ignore .content v10
        let content = chatMessage && duplicate(chatMessage.content)
        let searchRe = /<button data-action="damage">[^<]+<\/button>/;
        const damageTypeString = (this.item?.system.actionType === "heal") ? i18n(`${this.systemString}.Healing`) : i18n(`${this.systemString}.Damage`);
        let damageString = (this.rollOptions.critical || this.isCritical) ? i18n(`${this.systemString}.Critical`) : damageTypeString;
        if (this.rollOptions.fastForwardDamage && configSettings.showFastForward) damageString += ` ${i18n("midi-qol.fastForward")}`;
        let replaceString = `<button data-action="damage">${damageString}</button>`
        content = content.replace(searchRe, replaceString);
        searchRe = /<button data-action="versatile">[^<]+<\/button>/;
        damageString = i18n(`${this.systemString}.Versatile`)
        if (this.rollOptions.fastForwardDamage && configSettings.showFastForward) damageString += ` ${i18n("midi-qol.fastForward")}`;
        replaceString = `<button data-action="versatile">${damageString}</button>`
        content = content.replace(searchRe, replaceString);
        await chatMessage?.update({ content });
      }
    }
    return this.WorkflowState_Suspend; // wait for a damage roll to advance the state.
  }
  async WorkflowState_ConfirmRoll(context: any = {}): Promise<WorkflowState> {
    if (context.attackRoll) return this.WorkflowState_AttackRollComplete;
    if (configSettings.confirmAttackDamage !== "none" && (this.item.hasAttack || this.item.hasDamage)) {
      await this.displayDamageRoll(configSettings.mergeCard);
      return this.WorkflowState_Suspend; // wait for the confirm button
    }
    return this.WorkflowState_DamageRollStarted;
  }
  async WorkflowState_RollConfirmed(context: any = {}): Promise<WorkflowState> {
    return this.WorkflowState_DamageRollStarted;
  }
  async WorkflowState_DamageRollStarted(context: any = {}): Promise<WorkflowState> {
    if (this.itemCardId) {
      await Workflow.removeItemCardAttackDamageButtons(this.itemCardId, getRemoveAttackButtons(this.item), getRemoveDamageButtons(this.item));
      await Workflow.removeItemCardConfirmRollButton(this.itemCardId);
    }
    if (getAutoTarget(this.item) === "none" && this.item?.hasAreaTarget && !this.item.hasAttack) {
      // we are not auto targeting so for area effect attacks, without hits (e.g. fireball)
      this.targets = validTargetTokens(game.user?.targets);
      this.hitTargets = validTargetTokens(game.user?.targets);
      this.hitTargetsEC = new Set();
      if (debugEnabled > 0) warn("damageRollStarted | for non auto target area effects spells", this)
    }

    // apply damage to targets plus saves plus immunities
    // done here cause not needed for betterrolls workflow
    //@ts-expect-error .version
    if (isNewerVersion(game.system.version, "2.4.99")) {
      this.defaultDamageType = this.item.system.damage?.parts[0].damageType || this.defaultDamageType || MQdefaultDamageType;
    } else {
      this.defaultDamageType = this.item.system.damage?.parts[0][1] || this.defaultDamageType || MQdefaultDamageType;
    }
    if (this.item?.system.actionType === "heal" && !Object.keys(getSystemCONFIG().healingTypes).includes(this.defaultDamageType ?? "")) this.defaultDamageType = "healing";
    // now done in itemhandling this.damageDetail = createDamageDetail({ roll: this.damageRoll, item: this.item, versatile: this.rollOptions.versatile, defaultType: this.defaultDamageType });
    const damageBonusMacros = this.getDamageBonusMacros();
    if (damageBonusMacros && this.workflowType === "Workflow") {
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

    if (configSettings.allowUseMacro) { //
      await this.callMacros(this.item, this.onUseMacros?.getMacros("postDamageRoll"), "OnUse", "postDamageRoll");
      if (this.ammo) await this.callMacros(this.ammo, this.ammoOnUseMacros?.getMacros("postDamageRoll"), "OnUse", "postDamageRoll");
    }

    if (this.damageRoll) 
      this.damageDetail = createDamageDetail({ roll: this.damageRoll, item: this.item, ammo: this.ammo, versatile: this.rollOptions.versatile, defaultType: this.defaultDamageType });
    else this.damageDetail = [];
    if (this.otherDamageRoll) {
      this.otherDamageDetail = createDamageDetail({ roll: this.otherDamageRoll, item: null, ammo: null, versatile: false, defaultType: this.defaultDamageType });
    } else this.otherDamageDetail = [];
    if (this.bonusDamageRoll)
      this.bonusDamageDetail = createDamageDetail({ roll: this.bonusDamageRoll, item: null, ammo: null, versatile: false, defaultType: this.defaultDamageType });
    else this.bonusDamageDetail = [];

    await asyncHooksCallAll("midi-qol.DamageRollComplete", this);
    if (this.item) await asyncHooksCallAll(`midi-qol.DamageRollComplete.${this.item.uuid}`, this);
    if (this.aborted) return this.WorkflowState_Abort;
    if (this.hitTargets?.size || this.hitTtargetsEC?.size) expireMyEffects.bind(this)(["1Hit"]);
    expireMyEffects.bind(this)(["1Action", "1Attack", "1Spell"]);
    await this.displayDamageRoll(configSettings.mergeCard);

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
    if (configSettings.allowUseMacro) {
      await this.callMacros(this.item, this.onUseMacros?.getMacros("preSave"), "OnUse", "preSave");
      await this.triggerTargetMacros(["isAboutToSave"]); // ??
      if (this.ammo) await this.callMacros(this.ammo, this.ammoOnUseMacros?.getMacros("preSave"), "OnUse", "preSave");
    }

    if (this.workflowType === "Workflow" && !this.item?.hasAttack && this.item?.system.target?.type !== "self") { // Allow editing of targets if there is no attack that has already been processed.
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
      //@ts-ignore .events not defined
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

      //@ts-ignore .events not defined
      if (debugEnabled > 1) debug("Check Saves: renderChat message hooks length ", Hooks.events["renderChatMessage"]?.length)
      await asyncHooksCallAll("midi-qol.postCheckSaves", this);
      if (this.item) await asyncHooksCallAll(`midi-qol.postCheckSaves.${this.item?.uuid}`, this);
      if (this.aborted) return this.WorkflowState_Abort;
      await this.displaySaves(configSettings.autoCheckSaves === "whisper", configSettings.mergeCard);
    } else {// has saves but we are not checking so do nothing with the damage
      await this.expireTargetEffects(["isAttacked"])
      this.applicationTargets = this.failedSaves;
      return this.WorkflowState_RollFinished;
    }
    return this.WorkflowState_SavesComplete;
  }
  async WorkflowState_SavesComplete(context: any = {}): Promise<WorkflowState> {
    expireMyEffects.bind(this)(["1Action", "1Spell"]);
    if (configSettings.allowUseMacro) {
      await this.callMacros(this.item, this.onUseMacros?.getMacros("postSave"), "OnUse", "postSave");
      await this.callMacros(this.ammo, this.onUseMacros?.getMacros("postSave"), "OnUse", "postSave");
    }

    return this.WorkflowState_AllRollsComplete;
  }
  async WorkflowState_AllRollsComplete(context: any = {}): Promise<WorkflowState> {
    this.otherDamageMatches = new Set();
    let items: any[] = [];
    if (this.item) items.push(this.item);
    if (this.ammo && !installedModules.get("betterrolls5e")) items.push(this.ammo);
    for (let theItem of items) {
      for (let token of this.targets) {
        const otherCondition = getProperty(this.otherDamageItem, "flags.midi-qol.otherCondition") ?? "";
        if (otherCondition !== "") {
          if (evalActivationCondition(this, otherCondition, token))
            this.otherDamageMatches.add(token);
        }
        else {
          this.otherDamageMatches.add(token);
        }
      }
    }

    if (this.damageDetail?.length || this.otherDamageDetail?.length) await processDamageRoll(this, this.damageDetail[0]?.type ?? this.defaultDamageType)
    // If a damage card is going to be created don't call the isDamaged macro - wait for the damage card calculations to do a better job
    if (configSettings.allowUseMacro && !configSettings.autoApplyDamage.includes("Card")) await this.triggerTargetMacros(["isDamaged"], this.hitTargets);
    if (debugEnabled > 1) debug("all rolls complete ", this.damageDetail)
    return this.WorkflowState_ApplyDynamicEffects;
  }

  async WorkflowState_ApplyDynamicEffects(context: any = {}): Promise<WorkflowState> {
    const applyDynamicEffectsStartTime = Date.now();

    this.activationMatches = new Set();
    this.activationFails = new Set();
    let items: any[] = [];
    if (this.item) items.push(this.item);
    if (this.ammo && !installedModules.get("betterrolls5e")) items.push(this.ammo);
    for (let theItem of items) {
      for (let token of this.targets) {
        const activationCondition = effectActivationConditionToUse.bind(theItem)(this)
        if (activationCondition) {
          if (evalActivationCondition(this, activationCondition, token)) {
            this.activationMatches.add(token);
          } else
            this.activationFails.add(token);
        } else this.activationMatches.add(token)
      }
    }
    expireMyEffects.bind(this)(["1Action", "1Spell"]);
    // Do special expiries
    const specialExpiries = [
      "isAttacked",
      "isDamaged",
      "isHealed",
      // XXX "1Reaction",
      "isSaveSuccess",
      "isSaveFailure",
      "isSave",
      "isHit"
    ];
    this.applicationTargets = new Set();
    if (this.forceApplyEffects)
      this.applicationTargets = this.targets;
    else if ((getProperty(this.item, "flags.midi-qol.effectCondition") ?? "") !== "")
      this.applicationTargets = this.activationMatches;
    else if (this.saveItem.hasSave && this.item.hasAttack) {
      this.applicationTargets = new Set([...this.hitTargets, ...this.hitTargetsEC]);
      this.applicationTargets = new Set([...this.applicationTargets].filter(t => this.failedSaves.has(t)));
    } else if (this.saveItem.hasSave) this.applicationTargets = this.failedSaves;
    else if (this.item.hasAttack) {
      this.applicationTargets = new Set([...this.hitTargets, ...this.hitTargetsEC]);
    } else
      this.applicationTargets = this.targets;
    let anyActivationTrue = this.applicationTargets.size > 0;

    await this.expireTargetEffects(specialExpiries);
    if (configSettings.autoItemEffects === "off" && !this.forceApplyEffects) return this.WorkflowState_RollFinished; // TODO see if there is a better way to do this.

    for (let theItem of items) {
      if (theItem) {
        if (configSettings.allowUseMacro) {
          const results: any = await this.callMacros(theItem, this.onUseMacros?.getMacros("preActiveEffects"), "OnUse", "preActiveEffects");
          // Special check for return of {haltEffectsApplication: true} from item macro
          if (results.some(r => r?.haltEffectsApplication))
            return this.WorkflowState_RollFinished;
        }
      }
      /* TODO removed these (will be auto called) need to check changes in behaviour
      if (await asyncHooksCall("midi-qol.preApplyDynamicEffects", this) === false) return this.rollFinished;
      if (theItem && await asyncHooksCall(`midi-qol.preApplyDynamicEffects.${theItem.uuid}`, this) === false) return this.rollFinished;
      */

      // no item, not auto effects or not module skip
      let useCE = configSettings.autoCEEffects;
      const midiFlags = theItem.flags["midi-qol"];
      if (!theItem) return this.WorkflowState_RollFinished;
      if (midiFlags?.forceCEOff && ["both", "cepri", "itempri"].includes(useCE)) useCE = "none";
      else if (midiFlags?.forceCEOn && ["none", "itempri"].includes(useCE)) useCE = "cepri";
      const hasCE = installedModules.get("dfreds-convenient-effects")
      //@ts-ignore
      const ceEffect = hasCE ? game.dfreds.effects.all.find(e => e.name === theItem?.name) : undefined;
      const ceTargetEffect = ceEffect && !(ceEffect?.flags?.dae?.selfTarget || ceEffect?.flags?.dae?.selfTargetAlways);
      const hasItemEffect = hasDAE(this) && theItem?.effects.some(ef => ef.transfer !== true);
      const itemSelfEffects = theItem?.effects.filter(ef => (ef.flags?.dae?.selfTarget || ef.flags?.dae?.selfTargetAlways) && !ef.transfer) ?? [];
      const itemTargetEffects = theItem?.effects?.filter(ef => !ef.flags?.dae?.selfTargetAlways && !ef.flags?.dae?.selfTarget && ef.transfer !== true) ?? [];
      const hasItemTargetEffects = hasItemEffect && itemTargetEffects.length > 0;
      const hasItemSelfEffects = hasItemEffect && itemSelfEffects.length > 0;
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

      if (hasItemTargetEffects || ceTargetEffect) {
        if (getConcentrationEffect(this.actor) && itemRequiresConcentration(theItem)) {
          // We are going to apply effects to the targets, if the item has concentration remove concetration from the actor since it will be reapplied
          await removeConcentration(this.actor, undefined, { noConcentrationCheck: true });
        }
        for (let token of this.applicationTargets) {
          if (this.activationFails.has(token) && !this.forceApplyEffects) continue;

          if (hasItemTargetEffects && (!ceTargetEffect || ["none", "both", "itempri"].includes(useCE))) {
            let damageComponents = {};
            let damageListItem = this.damageList?.find(entry => entry.tokenUuid === (token.uuid ?? token.document.uuid));
            if (damageListItem) {
              for (let dde of [...(damageListItem.damageDetail[0] ?? []), ...(damageListItem.damageDetail[1] ?? [])]) {
                if (!dde?.damage) continue;
                damageComponents[dde.type] = dde.damage + (damageComponents[dde.type] ?? 0);
              };
            }
            await globalThis.DAE.doEffects(theItem, true, [token], {
              damageTotal: damageListItem?.totalDamage,
              critical: this.isCritical,
              fumble: this.isFumble,
              itemCardId: this.itemCardId,
              metaData,
              selfEffects: "none",
              spellLevel: (this.spellLevel ?? 0),
              toggleEffect: this.item?.flags.midiProperties?.toggleEffect,
              tokenId: this.tokenId,
              tokenUuid: this.tokenUuid,
              actorUuid: this.actor.uuid,
              whisper: false,
              workflowOptions: this.workflowOptions,
              context: {
                damageComponents,
                damageApplied: damageListItem?.appliedDamage,
                damage: damageListItem?.totalDamage  // this is curently ignored see damageTotal above
              }
            })
          }

          if (ceTargetEffect && theItem && token.actor) {
            if (["both", "cepri"].includes(useCE) || (useCE === "itempri" && !hasItemTargetEffects)) {
              const targetHasEffect = token.actor.effects.find(ef => ef.name === theItem.name);
              if (this.item?.flags.midiProperties?.toggleEffect && targetHasEffect) {
                //@ts-ignore
                await game.dfreds.effectInterface?.toggleEffect(theItem.name, { uuid: token.actor.uuid, origin: theItem?.uuid, metadata: macroData });
              } else {
                // Check stacking status
                let removeExisting = (["none", "noneName"].includes(ceEffect.flags?.dae?.stackable ?? "none"));
                if (itemRequiresConcentration(this.item))
                  removeExisting = !configSettings.concentrationAutomation; // This will be removed via concentration check
                //@ts-expect-error game.dfreds
                if (removeExisting && game.dfreds.effectInterface?.hasEffectApplied(theItem.name, token.actor.uuid)) {
                  //@ts-expect-error game.dfreds
                  await game.dfreds.effectInterface?.removeEffect({ effectName: theItem.name, uuid: token.actor.uuid, origin: theItem?.uuid, metadata: macroData });
                }
                const effectData = mergeObject(ceEffect.toObject(), metaData);
                if (isInCombat(token.actor) && effectData.duration.seconds <= 60) {
                  effectData.duration.rounds = effectData.duration.rounds ?? Math.ceil(effectData.duration.seconds / CONFIG.time.roundTime);
                  delete effectData.duration.seconds;
                }
                effectData.origin = this.itemUuid;
                // await tempCEaddEffectWith({ effectData, uuid: token.actor.uuid, origin: theItem?.uuid, metadata: macroData });
                //@ts-ignore
                await game.dfreds.effectInterface?.addEffectWith({ effectData, uuid: token.actor.uuid, origin: theItem?.uuid, metadata: macroData });
              }
            }
          }
          if (!this.forceApplyEffects && configSettings.autoItemEffects !== "applyLeave") await this.removeEffectsButton();
        }
        // Perhaps this should use this.applicationTargets
        if (configSettings.allowUseMacro) await this.triggerTargetMacros(["postTargetEffectApplication"], this.targets);
      }
      let ceSelfEffectToApply = ceEffect?.flags?.dae?.selfTargetAlways ? ceEffect : undefined;
      selfEffectsToApply = "selfEffectsAlways"; // by default on do self effect always effects
      if (this.applicationTargets.size > 0 && anyActivationTrue) { // someone had an effect applied so we will do all self effects
        ceSelfEffectToApply = ceEffect && ceEffect?.flags?.dae?.selfTarget;
        selfEffectsToApply = "selfEffectsAll";
      }

      if (selfEffectsToApply !== "none" && hasItemSelfEffects && (!ceSelfEffectToApply || ["none", "both", "itempri"].includes(useCE))) {
        await globalThis.DAE.doEffects(theItem, true, [tokenForActor(this.actor)],
          {
            toggleEffect: this.item?.flags.midiProperties?.toggleEffect,
            whisper: false,
            spellLevel: this.spellLevel,
            critical: this.isCritical,
            fumble: this.isFumble,
            itemCardId: this.itemCardId,
            tokenId: this.tokenId,
            tokenUuid: this.tokenUuid,
            actorId: this.actor?.id,
            actorUuid: this.actor?.uuid,
            workflowOptions: this.workflowOptions,
            selfEffects: selfEffectsToApply,
            metaData,
            damageTotal: (this.damageTotal ?? 0) + (this.otherDamageTotal ?? 0) + (this.bonusDamageTotal ?? 0)
          })
      }
      if (selfEffectsToApply !== "none" && ceSelfEffectToApply && theItem && this.actor) {
        if (["both", "cepri"].includes(useCE) || (useCE === "itempri" && !hasItemSelfEffects)) {
          const actorHasEffect = this.actor.effects.find(ef => ef.name === theItem.name);
          if (this.item?.flags.midiProperties?.toggleEffect && actorHasEffect) {
            //@ts-ignore
            await game.dfreds.effectInterface?.toggleEffect(theItem.name, { uuid: this.actor.uuid, origin: theItem?.uuid, metadata: macroData });
          } else {
            // Check stacking status
            //@ts-expect-error
            if ((ceSelfEffectToApply.flags?.dae?.stackable ?? "none") === "none" && game.dfreds.effectInterface?.hasEffectApplied(theItem.name, this.actor.uuid)) {
              //@ts-expect-error
              await game.dfreds.effectInterface?.removeEffect({ effectName: theItem.name, uuid: this.actor.uuid, origin: theItem?.uuid, metadata: macroData });
            }
            const effectData = mergeObject(ceSelfEffectToApply.toObject(), metaData);
            effectData.origin = this.itemUuid;
            // await tempCEaddEffectWith({ effectData, uuid: this.actor.uuid, origin: theItem?.uuid, metadata: macroData });

            //@ts-ignore
            await game.dfreds.effectInterface?.addEffectWith({ effectData, uuid: this.actor.uuid, origin: theItem?.uuid, metadata: macroData });
          }
        }
      }
    }
    if (debugCallTiming) log(`applyActiveEffects elapsed ${Date.now() - applyDynamicEffectsStartTime}ms`)
    return this.WorkflowState_RollFinished;
  }
  async WorkflowState_Cleanup(context: any = {}): Promise<WorkflowState> {
    // globalThis.MidiKeyManager.resetKeyState();
    if (this.placeTemplateHookId) {
      Hooks.off("createMeasuredTemplate", this.placeTemplateHookId)
      Hooks.off("preCreateMeasuredTemplate", this.preCreateTemplateHookId)
    }
    // TODO see if we can delete the workflow - I think that causes problems for Crymic
    //@ts-ignore scrollBottom protected
    ui.chat?.scrollBottom();
    return this.WorkflowState_Completed;
  }

  async WorkflowState_Completed(context: any = {}): Promise<WorkflowState> {
    if (context.attackRoll) return this.WorkflowState_AttackRollComplete;
    if (context.damageRoll) return this.WorkflowState_ConfirmRoll;
    return this.WorkflowState_Suspend;
  }

  async WorkflowState_Abort(context: any = {}): Promise<WorkflowState> {
    if (this.placeTemplateHookId) {
      Hooks.off("createMeasuredTemplate", this.placeTemplateHookId)
      Hooks.off("preCreateMeasuredTemplate", this.preCreateTemplateHookId)
    }
    if (this.itemCardId) await game.messages?.get(this.itemCardId)?.delete();
    /*
        if (this.itemCardId) {
          await Workflow.removeItemCardAttackDamageButtons(this.itemCardId, getRemoveAttackButtons(), getRemoveDamageButtons());
          await Workflow.removeItemCardConfirmRollButton(this.itemCardId);
        }
        */
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
    const chatMessage: ChatMessage | undefined = game.messages?.get(this.itemCardId ?? "");
    //@ts-expect-error .content v10
    let content = chatMessage?.content;
    if (content && getRemoveAttackButtons(this.item) && chatMessage && configSettings.confirmAttackDamage === "none") {
      let searchRe = /<button data-action="attack">[^<]*<\/button>/;
      searchRe = /<div class="midi-attack-buttons".*<\/div>/
      content = content.replace(searchRe, "");
      await chatMessage.update({
        "content": content,
        timestamp: Date.now(),
        "flags.midi-qol.type": MESSAGETYPES.ITEM,
        type: CONST.CHAT_MESSAGE_TYPES.ROLL,
      });
    }
    // Add concentration data if required
    let hasConcentration = itemRequiresConcentration(this.item);
    if (hasConcentration && this.item?.hasAreaTarget && this.item?.system.duration?.units !== "inst") {
      hasConcentration = true; // non-instantaneous spells with templates will add concentration even if no one is targeted
    } else if (this.item &&
      (
        (this.item.hasAttack && (this.targets.size > 0 && this.hitTargets.size === 0 && this.hitTargetsEC.size === 0))  // did  not hit anyone
        || (this.saveItem.hasSave && (this.targets.size > 0 && this.failedSaves.size === 0)) // everyone saved
      )
    ) // no one was hit and non one failed the save - no need for concentration.
      hasConcentration = false;
    const checkConcentration = configSettings.concentrationAutomation;
    // If not applying effects always add concentration.
    let concentrationData: ConcentrationData;
    if (hasConcentration && checkConcentration) {
      const concentrationData: ConcentrationData = {
        item: this.item,
        targets: this.applicationTargets,
        templateUuid: this.templateUuid,
      };
      await addConcentration(this.actor, concentrationData);
    } else if (installedModules.get("dae") && this.item?.hasAreaTarget && this.templateUuid && this.item?.system.duration?.units && configSettings.autoRemoveTemplate) { // create an effect to delete the template
      // If we are not applying concentration and want to auto remove the template create an effect to do so
      const itemDuration = this.item.system.duration;
      let selfTarget = this.item.actor.token ? this.item.actor.token.object : getSelfTarget(this.item.actor);
      if (selfTarget) selfTarget = this.token; //TODO see why this is here
      let effectData;
      const templateString = " " + i18n("midi-qol.MeasuredTemplate");
      if (selfTarget) {
        let effect = this.item.actor.effects.find(ef => ef.name === this.item.name + templateString);
        if (effect) { // effect already applied - TODO decide if we update the effect or delete it via stackable.
          const newChanges = duplicate(effect.changes);
          newChanges.push({ key: "flags.dae.deleteUuid", mode: 5, value: this.templateUuid, priority: 20 });
          await effect.update({ changes: newChanges });
        } else {
          effectData = {
            origin: this.item?.uuid, //flag the effect as associated to the spell being cast
            disabled: false,
            icon: this.item?.img,
            label: this.item?.name + templateString,
            duration: {},
            flags: {dae: {stackable: "noneName"}},
            changes: [
              { key: "flags.dae.deleteUuid", mode: 5, value: this.templateUuid, priority: 20 }, // who is marked
            ]
          };

          const inCombat = (game.combat?.turns.some(combatant => combatant.token?.id === selfTarget.id));
          const convertedDuration = globalThis.DAE.convertDuration(itemDuration, inCombat);
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

    // Call onUseMacro if not already called
    if (configSettings.allowUseMacro) {
      await this.callMacros(this.item, this.onUseMacros?.getMacros("postActiveEffects"), "OnUse", "postActiveEffects");
      if (this.ammo) await this.callMacros(this.ammo, this.ammoOnUseMacros?.getMacros("postActiveEffects"), "OnUse", "postActiveEffects");
    }
    if (this.item)
      // delete Workflow._workflows[this.itemId];
      await asyncHooksCallAll("minor-qol.RollComplete", this); // just for the macro writers.
    await asyncHooksCallAll("midi-qol.RollComplete", this);
    if (this.item) await asyncHooksCallAll(`midi-qol.RollComplete.${this.item?.uuid}`, this);
    if (this.aborted) return this.WorkflowState_Abort;  // TODO This is wrong
    if (autoRemoveTargets !== "none") setTimeout(untargetDeadTokens, 500); // delay to let the updates finish
    if (debugCallTiming) log(`RollFinished elapased ${Date.now() - rollFinishedStartTime}`);
    const inCombat = isInCombat(this.actor);
    let activeCombatants = game.combats?.combats.map(combat => combat.combatant?.token?.id)
    const isTurn = activeCombatants?.includes(this.token?.id);
    if (inCombat && isTurn && this.item?.system.activation.type === "action" && !this.AoO) {
      await setActionUsed(this.actor);
    }
    return this.WorkflowState_Cleanup;
  }
  async WorkflowState_Default(context: any = {}): Promise<WorkflowState> { return this.WorkflowState_Suspend };

  initSaveResults() {
    this.saves = new Set();
    this.criticalSaves = new Set();
    this.fumbleSaves = new Set();
    this.failedSaves = this.item?.hasAttack ? new Set(this.hitTargets) : new Set(this.targets);
    this.advantageSaves = new Set();
    this.disadvantageSaves = new Set();
    this.saveDisplayData = [];
    this.saveResults = [];
  };

  public async checkAttackAdvantage() {
    await this.checkFlankingAdvantage();
    const midiFlags = this.actor?.flags["midi-qol"];
    const advantage = midiFlags?.advantage;
    const disadvantage = midiFlags?.disadvantage;
    const actType = this.item?.system?.actionType || "none"

    if (advantage || disadvantage) {
      const target: Token = this.targets.values().next().value;
      const conditionData = createConditionData({ workflow: this, target, actor: this.actor });

      if (advantage) {
        if (advantage.all && evalCondition(advantage.all, conditionData)) {
          this.advantage = true;
          this.attackAdvAttribution.add("ADV:all");
        }
        if (advantage.attack?.all && evalCondition(advantage.attack.all, conditionData)) {
          this.attackAdvAttribution.add("ADV:attack.all");
          this.advantage = true;
        }
        if (advantage.attack && advantage.attack[actType] && evalCondition(advantage.attack[actType], conditionData)) {
          this.attackAdvAttribution.add(`ADV.attack.${actType}`);
          this.advantage = true;
        }
      }
      if (disadvantage) {
        const withDisadvantage = disadvantage.all || disadvantage.attack?.all || (disadvantage.attack && disadvantage.attack[actType]);
        if (disadvantage.all && evalCondition(disadvantage.all, conditionData)) {
          this.attackAdvAttribution.add("DIS:all");
          this.disadvantage = true;
        }
        if (disadvantage.attack?.all && evalCondition(disadvantage.attack.all, conditionData)) {
          this.attackAdvAttribution.add("DIS:attack.all");
          this.disadvantage = true;
        }
        if (disadvantage.attack && disadvantage.attack[actType] && evalCondition(disadvantage.attack[actType], conditionData)) {
          this.attackAdvAttribution.add(`DIS:attack.${actType}`);
          this.disadvantage = true;
        }
      }
      this.checkAbilityAdvantage();
    }
    // TODO Hidden should check the target to see if they notice them?
    //@ts-expect-error .first()
    const target = this.targets?.first();
    const token: Token | undefined = this.attackingToken ?? canvas?.tokens?.get(this.tokenId);
    if (checkRule("invisAdvantage") && checkRule("invisAdvantage") !== "none" && target) {
      // if we are using a proxy token to attack use that for hidden invisible
      const invisibleToken = token ? hasCondition(token, "invisible") : false;
      const invisibleTarget = hasCondition(target, "invisible");
      const tokenCanDetect = token ? canSense(token, target, globalThis.MidiQOL.InvisibleDisadvantageVisionModes) : true;
      const targetCanDetect = token ? canSense(target, token, globalThis.MidiQOL.InvisibleDisadvantageVisionModes) : true;

      const invisAdvantage = (checkRule("invisAdvantage") === "RAW") ? invisibleToken || !targetCanDetect : !targetCanDetect;
      if (invisAdvantage) {
        this.attackAdvAttribution.add("ADV:invisible");
        this.advReminderAttackAdvAttribution.add("ADV:Invisible");
        this.advantage = true;
      }

      const invisDisadvantage = (checkRule("invisAdvantage") === "RAW") ? invisibleTarget || !tokenCanDetect : !tokenCanDetect;
      if (invisDisadvantage) {
        // Attacker can't see target so disadvantage
        log(`Disadvantage given to ${this.actor.name} due to invisible target`);
        this.attackAdvAttribution.add("DIS:invisible");
        this.advReminderAttackAdvAttribution.add("DIS:Invisible Foe");
        this.disadvantage = true;
      }
    }

    // Check hidden
    if (checkRule("hiddenAdvantage") && checkRule("HiddenAdvantage") !== "none" && target) {

      if (checkRule("hiddenAdvantage") === "perceptive") {
        //@ts-expect-error .api
        const perceptiveApi = game.modules.get("perceptive")?.api;
        const tokenHidden = await perceptiveApi?.PerceptiveFlags.canbeSpotted(token?.document) ?? false;
        const targetHidden = await perceptiveApi?.PerceptiveFlags.canbeSpotted(target?.document) ?? false;
        const tokenSpotted = await perceptiveApi?.isSpottedby(token, target, { LOS: false, Range: true, Effects: false, canbeSpotted: true }) ?? true;
        const targetSpotted = await perceptiveApi?.isSpottedby(target, token, { LOS: false, Range: true, Effects: false, canbeSpotted: true }) ?? true;
        if (tokenHidden) {
          if (!tokenSpotted) {
            this.attackAdvAttribution.add("ADV:hidden");
            this.advReminderAttackAdvAttribution.add("ADV:Hidden");
            this.advantage = true;
          }
        }

        if (targetHidden) {
          if (!targetSpotted) {
            this.attackAdvAttribution.add("DIS:hidden");
            this.advReminderAttackAdvAttribution.add("DIS:Hidden Foe");
            this.disadvantage = true;
          }
        }
      }

      if (checkRule("hiddenAdvantage") === "effect") {
        const hiddenToken = token ? hasCondition(token, "hidden") : false;
        const hiddenTarget = hasCondition(target, "hidden");
        if (hiddenToken) {
          this.attackAdvAttribution.add("ADV:hidden");
          this.advReminderAttackAdvAttribution.add("ADV:Hidden");
          this.advantage = true;
        }
        if (hiddenTarget) {
          this.attackAdvAttribution.add("DIS:hidden");
          this.advReminderAttackAdvAttribution.add("DIS:Hidden Foe");
          this.disadvantage = true;
        }
      }
    }

    // Nearby foe gives disadvantage on ranged attacks
    if (checkRule("nearbyFoe")
      && !getProperty(this.actor, "flags.midi-qol.ignoreNearbyFoes")
      && (["rwak", "rsak", "rpak"].includes(actType) || (this.item.system.properties?.thr && actType !== "mwak"))) {
      let nearbyFoe;
      // special case check for thrown weapons within 5 feet, treat as a melee attack - (players will forget to set the property)
      const me = this.attackingToken ?? canvas?.tokens?.get(this.tokenId);
      if (this.item.system.properties?.thr && actType === "rwak") {
        //@ts-expect-error
        const firstTarget: Token = this.targets.first();
        if (firstTarget && me && getDistance(me, firstTarget, false) <= configSettings.optionalRules.nearbyFoe) nearbyFoe = false;
        else nearbyFoe = checkNearby(-1, canvas?.tokens?.get(this.tokenId), configSettings.optionalRules.nearbyFoe, { includeIncapacitated: false, canSee: true });
      } else {
        //@ts-expect-error .first
        if (this.item.system.properties?.thr && getDistance(me, this.targets.first(), false) <= configSettings.optionalRules.nearbyFoe) nearbyFoe = false;
        else nearbyFoe = checkNearby(-1, canvas?.tokens?.get(this.tokenId), configSettings.optionalRules.nearbyFoe, { includeIncapacitated: false, canSee: true });
      }
      if (nearbyFoe) {
        if (debugEnabled > 0) warn(`checkAttackAdvantage | Ranged attack by ${this.actor.name} at disadvantage due to nearby foe`);
        this.attackAdvAttribution.add("DIS:nearbyFoe");
        this.advReminderAttackAdvAttribution.add("DIS:Nearby foe");
        this.disadvantage = true;
      }
      // this.disadvantage = this.disadvantage || nearbyFoe;
    }
    this.checkTargetAdvantage();
  }

  public processDamageEventOptions() {
    if (this.workflowType === "TrapWorkflow") {
      this.rollOptions.fastForward = true;
      this.rollOptions.autoRollAttack = true;
      this.rollOptions.fastForwardAttack = true;
      this.rollOptions.autoRollDamage = "always";
      this.rollOptions.fastForwardDamage = true;
    }
  }

  processCriticalFlags() {
    if (!this.actor) return; // in case a damage only workflow caused this.
    /*
    * flags.midi-qol.critical.all
    * flags.midi-qol.critical.mwak/rwak/msak/rsak/other
    * flags.midi-qol.noCritical.all
    * flags.midi-qol.noCritical.mwak/rwak/msak/rsak/other
    */
    // check actor force critical/noCritical
    const criticalFlags = getProperty(this.actor, `flags.midi-qol.critical`) ?? {};
    const noCriticalFlags = getProperty(this.actor, `flags.midi-qol.noCritical`) ?? {};
    const attackType = this.item?.system.actionType;
    this.critFlagSet = false;
    this.noCritFlagSet = false;

    const target: Token = this.hitTargets.values().next().value
    if (criticalFlags || noCriticalFlags) {
      const target: Token = this.hitTargets.values().next().value
      const conditionData = createConditionData({ workflow: this, target, actor: this.actor });
      if (criticalFlags) {
        if (criticalFlags?.all && evalCondition(criticalFlags.all, conditionData)) {
          this.critFlagSet = true;
        }
        if (criticalFlags[attackType] && evalCondition(criticalFlags[attackType], conditionData)) {
          this.critFlagSet = true;
        }
        if (noCriticalFlags) {
          if (noCriticalFlags?.all && evalCondition(noCriticalFlags.all, conditionData)) {
            this.noCritFlagSet = true;
          }
          if (noCriticalFlags[attackType] && evalCondition(noCriticalFlags[attackType], conditionData)) {
            this.noCritFlagSet = true;
          }
        }
      }
    }

    // check target critical/nocritical
    if (this.hitTargets.size === 1) {
      const firstTarget = this.hitTargets.values().next().value;
      const grants = firstTarget.actor?.flags["midi-qol"]?.grants?.critical ?? {};
      const fails = firstTarget.actor?.flags["midi-qol"]?.fail?.critical ?? {};
      if (grants || fails) {
        if (Number.isNumeric(grants.range) && getDistanceSimple(firstTarget, this.token, false) <= Number(grants.range)) {
          this.critFlagSet = true;
        }
        const conditionData = createConditionData({ workflow: this, target: firstTarget, actor: this.actor });
        if (grants.all && evalCondition(grants.all, conditionData)) {
          this.critFlagSet = true;
        }
        if (grants[attackType] && evalCondition(grants[attackType], conditionData)) {
          this.critFlagSet = true;

        }
        if (fails.all && evalCondition(fails.all, conditionData)) {
          this.noCritFlagSet = true;
        }
        if (fails[attackType] && evalCondition(fails[attackType], conditionData)) {
          this.noCritFlagSet = true;
        }
      }
    }
    this.isCritical = this.isCritical || this.critFlagSet;
    if (this.noCritFlagSet) this.isCritical = false;
  }

  checkAbilityAdvantage() {
    if (!["mwak", "rwak"].includes(this.item?.system.actionType)) return;
    let ability = this.item?.abilityMod;
    if ("" === ability) ability = this.item?.system.properties?.fin ? "dex" : "str";
    if (getProperty(this.actor, `flags.midi-qol.advantage.attack.${ability}`)) {
      if (evalCondition(getProperty(this.actor, `flags.midi-qol.advantage.attack.${ability}`), this.conditionData)) {
        this.advantage = true;
        this.attackAdvAttribution.add(`ADV:attack.${ability}`); true;
      }
    }
    if (getProperty(this.actor, `flags.midi-qol.disadvantage.attack.${ability}`)) {
      if (evalCondition(getProperty(this.actor, `flags.midi-qol.disadvantage.attack.${ability}`), this.conditionData)) {
        this.disadvantage = true;
        this.attackAdvAttribution.add(`DIS:attack.${ability}`);
      }
    }
  }

  async checkFlankingAdvantage(): Promise<boolean> {
    if (!canvas) {
      console.warn("midi-qol | CheckFlankingAdvantage | abandoned - no canvas defined")
      return false;
    }
    this.flankingAdvantage = false;
    if (this.item && !(["mwak", "msak", "mpak"].includes(this.item?.system.actionType))) return false;
    const token = MQfromUuid(this.tokenUuid ?? null)?.object;
    //@ts-expect-error first
    const target: Token = this.targets.first();

    const needsFlanking = await markFlanking(token, target,);
    if (needsFlanking) {
      this.attackAdvAttribution.add(`ADV:flanking`);
      this.advReminderAttackAdvAttribution.add("ADV:flanking");
    }
    if (["advonly", "ceadv"].includes(checkRule("checkFlanking"))) this.flankingAdvantage = needsFlanking;
    return needsFlanking;
  }

  checkTargetAdvantage() {
    if (!this.item) return;
    if (!this.targets?.size) return;
    const actionType = this.item?.system.actionType;
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
        }
      }
    }
    //@ts-expect-error .flags
    const grants = firstTargetDocument.actor?.flags["midi-qol"]?.grants;
    if (!grants) return;
    if (!["rwak", "mwak", "rsak", "msak", "rpak", "mpak"].includes(actionType)) return;
    const attackAdvantage = grants.advantage?.attack || {};
    let grantsAdvantage;
    const conditionData = createConditionData({ workflow: this, target: this.token, actor: this.actor });
    if (grants.advantage?.all && evalCondition(grants.advantage.all, conditionData)) {
      grantsAdvantage = true;
      this.attackAdvAttribution.add(`ADV:grants.advantage.all`);
    }
    if (attackAdvantage.all && evalCondition(attackAdvantage.all, conditionData)) {
      grantsAdvantage = true;
      this.attackAdvAttribution.add(`ADV:grants.attack.all`);
    }
    if (attackAdvantage[actionType] && evalCondition(attackAdvantage[actionType], conditionData)) {
      grantsAdvantage = true;
      this.attackAdvAttribution.add(`ADV:grants.attack.${actionType}`);
    }
    if (grants.fail?.advantage?.attack?.all && evalCondition(grants.fail.advantage.attack.all, conditionData)) {
      grantsAdvantage = false;
      this.advantage = false;
      this.noAdvantage = true;
      this.attackAdvAttribution.add(`ADV:grants.attack.noAdvantage`);

    }
    if (grants.fail?.advantage?.attack && grants.fail.advantage.attack[actionType] && evalCondition(grants.fail.advantage.attack[actionType], conditionData)) {
      grantsAdvantage = false;
      this.advantage = false;
      this.noAdvantage = true;
      this.attackAdvAttribution.add(`ADV:grants.attack.noAdvantage${actionType}`);

    }

    const attackDisadvantage = grants.disadvantage?.attack || {};
    let grantsDisadvantage;
    if (grants.disadvantage?.all && evalCondition(grants.disadvantage.all, conditionData)) {
      grantsDisadvantage = true;
      this.attackAdvAttribution.add(`DIS:grants.disadvantage.all`);
    }
    if (attackDisadvantage.all && evalCondition(attackDisadvantage.all, conditionData)) {
      grantsDisadvantage = true;
      this.attackAdvAttribution.add(`DIS:grants.attack.all`);
    }
    if (attackDisadvantage[actionType] && evalCondition(attackDisadvantage[actionType], conditionData)) {
      grantsDisadvantage = true;
      this.attackAdvAttribution.add(`DIS:grants.attack.${actionType}`);
    }
    if (grants.fail?.disadvantage?.attack?.all && evalCondition(grants.fail.disadvantage.attack.all, conditionData)) {
      this.attackAdvAttribution.add(`DIS:None`);
      grantsDisadvantage = false;
      this.disadvantage = false;
      this.noDisdvantage = true;
      this.attackAdvAttribution.add(`ADV:grants.attack.noDisdvantage`);
    }
    if (grants.fail?.disadvantage?.attack && grants.fail.disadvantage.attack[actionType] && evalCondition(grants.fail.disadvantage.attack[actionType], conditionData)) {
      grantsDisadvantage = false;
      this.disadvantage = false;
      this.noDisdvantage = true;
      this.attackAdvAttribution.add(`ADV:grants.attack.noDisadvantage${actionType}`);
    }
    this.advantage = this.advantage || grantsAdvantage;
    this.disadvantage = this.disadvantage || grantsDisadvantage;

  }

  async triggerTargetMacros(triggerList: string[], targets: Set<any> = this.targets) {
    for (let target of targets) {
      const actorOnUseMacros = getProperty(target.actor ?? {}, "flags.midi-qol.onUseMacroParts") ?? new OnUseMacros();

      const wasAttacked = this.item?.hasAttack;
      const wasHit = (this.item ? wasAttacked : true) && (this.hitTargets?.has(target) || this.hitTargetsEC?.has(target));
      const wasMissed = (this.item ? wasAttacked : true) && !this.hitTargets?.has(target) && !this.hitTargetsEC?.has(target);
      const wasDamaged = this.damageList
        && (this.hitTargets.has(target) || this.hitTargetsEC.has(target))
        && (this.damageList.find(dl => dl.tokenUuid === (target.uuid ?? target.document.uuid) && dl.appliedDamage > 0));

      if (wasAttacked && triggerList.includes("isAttacked")) {
        //@ts-ignore
        await this.callMacros(this.item,
          actorOnUseMacros?.getMacros("isAttacked"),
          "TargetOnUse",
          "isAttacked",
          { actor: target.actor, token: target });
      }
      if (triggerList.includes("postTargetEffectApplication")) {
        await this.callMacros(this.item,
          actorOnUseMacros?.getMacros("postTargetEffectApplication"),
          "TargetOnUse",
          "postTargetEffectApplication",
          { actor: target.actor, token: target });
      }
      // If auto applying damage can do a better test when damage application has been calculdated
      if (wasDamaged && triggerList.includes("isDamaged") && !configSettings.autoApplyDamage.toLocaleLowerCase().includes("yes")) {
        await this.callMacros(this.item,
          actorOnUseMacros?.getMacros("isDamaged"),
          "TargetOnUse",
          "isDamaged",
          { actor: target.actor, token: target });
      }
      if (wasHit && triggerList.includes("isHit")) {
        await this.callMacros(this.item,
          actorOnUseMacros?.getMacros("isHit"),
          "TargetOnUse",
          "isHit",
          { actor: target.actor, token: target });
      }
      if (wasMissed && triggerList.includes("isMissed")) {
        await this.callMacros(this.item,
          actorOnUseMacros?.getMacros("isMissed"),
          "TargetOnUse",
          "isMissed",
          { actor: target.actor, token: target });
      }
      if (triggerList.includes("preTargetDamageApplication")) {
        await this.callMacros(this.item,
          actorOnUseMacros?.getMacros("preTargetDamageApplication"),
          "TargetOnUse",
          "preTargetDamageApplication",
          { actor: target.actor, token: target });
      }

      if (this.saveItem?.hasSave && triggerList.includes("preTargetSave")) {
        await this.callMacros(this.item,
          actorOnUseMacros?.getMacros("preTargetSave"),
          "TargetOnUse",
          "preTargetSave",
          { actor: target.actor, token: target });
      }

      if (this.saveItem?.hasSave && triggerList.includes("isAboutToSave")) {
        await this.callMacros(this.item,
          actorOnUseMacros?.getMacros("isAboutToSave"),
          "TargetOnUse",
          "isAboutToSave",
          { actor: target.actor, token: target });
      }

      if (target.actor?.uuid !== this.actor.uuid && triggerList.includes("1Reaction")) {
      }
      if (this.saveItem?.hasSave && triggerList.includes("isSaveSuccess") && this.saves.has(target)) {
        await this.callMacros(this.item,
          actorOnUseMacros?.getMacros("isSaveSuccess"),
          "TargetOnUse",
          "isSaveSuccess",
          { actor: target.actor, token: target });
      }
      if (this.saveItem?.hasSave && triggerList.includes("isSaveFailure") && !this.saves.has(target)) {
        await this.callMacros(this.item,
          actorOnUseMacros?.getMacros("isSaveFailure"),
          "TargetOnUse",
          "isSaveFailure",
          { actor: target.actor, token: target });
      }
      if (this.saveItem?.hasSave && triggerList.includes("isSave")) {
        await this.callMacros(this.item,
          actorOnUseMacros?.getMacros("isSave"),
          "TargetOnUse",
          "isSave",
          { actor: target.actor, token: target });
      }
    }
  }

  async expireTargetEffects(expireList: string[]) {
    if (debugEnabled > 0) warn(`expireTargetEffects | ${expireList}`)
    for (let target of this.targets) {
      const expriryReason: string[] = [];
      if (!target.actor?.effects) continue; // nothing to expire
      const expiredEffects: (string | null)[] = target.actor?.effects.filter(ef => {
        let wasExpired = false;
        //@ts-ignore .flags v10
        const specialDuration = getProperty(ef.flags, "dae.specialDuration");
        if (!specialDuration) return false;
        const wasAttacked = this.item?.hasAttack;
        //TODO this test will fail for damage only workflows - need to check the damage rolled instead
        const wasHit = (this.item ? wasAttacked : true) && (this.hitTargets?.has(target) || this.hitTargetsEC?.has(target));
        const wasDamaged = this.damageList
          // consider removing this - by having it here hand editing hp wont expire effects
          // but any damage application by an item will get picked up in applyTokenDamageMany
          // so this is only relevant if you are not auto applying damage
          && (this.hitTargets.has(target) || this.hitTargetsEC.has(target))
          //@ts-expect-error token.document
          && (this.damageList.find(dl => dl.tokenUuid === (target.uuid ?? target.document.uuid) && dl.appliedDamage > 0));
        //@ts-expect-error target.dcoument
        const wasHealed = this.damageList && (this.damageList.find(dl => dl.tokenUuid === (target.uuid ?? target.document.uuid) && dl.appliedDamage < 0))
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
        for (let dt of this.damageDetail) {
          if (expireList.includes(`isDamaged`) && (wasDamaged || dt.type === "healing") && specialDuration.includes(`isDamaged.${dt.type}`)) {
            wasExpired = true;
            expriryReason.push(`isDamaged.${dt.type}`);
            break;
          }
        }
        if (!this.item) return wasExpired;
        if (this.saveItem.hasSave && expireList.includes("isSaveSuccess") && specialDuration.includes(`isSaveSuccess`) && this.saves.has(target)) {
          wasExpired = true;
          expriryReason.push(`isSaveSuccess`);
        }
        if (this.saveItem.hasSave && expireList.includes("isSaveFailure") && specialDuration.includes(`isSaveFailure`) && !this.saves.has(target)) {
          wasExpired = true;
          expriryReason.push(`isSaveFailure`);
        }
        if (this.saveItem.hasSave && expireList.includes("isSave") && specialDuration.includes(`isSave`)) {
          wasExpired = true;
          expriryReason.push(`isSave`);
        }
        const abl = this.item?.system.save?.ability;
        if (this.saveItem.hasSave && expireList.includes(`isSaveSuccess`) && specialDuration.includes(`isSaveSuccess.${abl}`) && this.saves.has(target)) {
          wasExpired = true;
          expriryReason.push(`isSaveSuccess.${abl}`);
        };
        if (this.saveItem.hasSave && expireList.includes(`isSaveFailure`) && specialDuration.includes(`isSaveFailure.${abl}`) && !this.saves.has(target)) {
          wasExpired = true;
          expriryReason.push(`isSaveFailure.${abl}`);
        };
        if (this.saveItem.hasSave && expireList.includes(`isSave`) && specialDuration.includes(`isSave.${abl}`)) {
          wasExpired = true;
          expriryReason.push(`isSave.${abl}`);
        };
        return wasExpired;
      }).map(ef => ef.id);
      if (expiredEffects.length > 0) {
        await timedAwaitExecuteAsGM("removeEffects", {
          actorUuid: target.actor?.uuid,
          effects: expiredEffects,
          options: { "expiry-reason": `midi-qol:${expriryReason}` }
        });
      }
    }
  }

  getDamageBonusMacros(): string | undefined {
    const actorMacros = getProperty(this.actor.flags, `${game.system.id}.DamageBonusMacro`);
    const itemMacros = this.onUseMacros?.getMacros("damageBonus")
    if (!itemMacros?.length) return actorMacros;
    if (!actorMacros?.length) return itemMacros;
    return `${actorMacros},${itemMacros}`;
  }

  async rollBonusDamage(damageBonusMacro) {
    let formula = "";
    var flavor = "";
    var extraDamages: (damageBonusMacroResult | boolean | undefined)[] = await this.callMacros(this.item, damageBonusMacro, "DamageBonus", "DamageBonus");
    if (!extraDamages) return;
    for (let extraDamage of extraDamages) {
      if (!extraDamage || typeof extraDamage === "boolean") continue;
      if (extraDamage?.damageRoll) {
        formula += (formula ? "+" : "") + extraDamage.damageRoll;
        if (extraDamage.flavor) {
          flavor = `${flavor}${flavor !== "" ? "<br>" : ""}${extraDamage.flavor}`
        }
      }
    }
    if (formula === "") return;
    try {
      const roll = await (new Roll(formula, (this.item ?? this.actor).getRollData()).evaluate({ async: true }));
      await this.setBonusDamageRoll(roll);
      this.bonusDamageFlavor = flavor ?? "";
      this.bonusDamageDetail = [];
    } catch (err) {
      const message = `midi-qol | rollBonusDamage | error in evaluating${formula} in bonus damage`
      TroubleShooter.recordError(err, message);
      console.warn(message, err);
      this.bonusDamageRoll = null;
      this.bonusDamageDetail = [];
    }
    if (this.bonusDamageRoll && this.workflowOptions?.damageRollDSN !== false) {
      await displayDSNForRoll(this.bonusDamageRoll, "damageRoll");
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

  getMacroData(): any {
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
      bonusDamageDetail: this.bonusDamageDetail,
      bonusDamageFlavor: this.bonusDamageFlavor,
      bonusDamageHTML: this.bonusDamageHTML,
      bonusDamageRoll: this.bonusDamageRoll,
      bonusDamageTotal: this.bonusDamageTotal,
      concentrationData: getProperty(this.actor.flags, "midi-qol.concentration-data"),
      criticalSaves,
      criticalSaveUuids,
      damageDetail: this.damageDetail,
      damageList: this.damageList,
      damageRoll: this.damageRoll,
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
      isCritical: this.rollOptions.critical || this.isCritical || this.workflowOptions.isCritical,
      isFumble: this.isFumble,
      isVersatile: this.rollOptions.versatile || this.isVersatile || this.workflowOptions.isVersatile,
      item: itemData,
      itemCardId: this.itemCardId,
      itemData,
      itemUuid: this.item?.uuid,
      otherDamageDetail: this.otherDamageDetail,
      otherDamageList: this.otherDamageList,
      otherDamageTotal: this.otherDamageTotal,
      powerLevel: game.system.id === "sw5e" ? this.spellLevel : undefined,
      rollData: (this.item ?? this.actor).getRollData(),
      rollOptions: this.rollOptions,
      saves,
      saveUuids,
      semiSuperSavers,
      semiSuperSaverUuids,
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
      workflow: this
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
    let name = macroName?.trim();
    let macroItem;
    const rolledItem = item;
    if (!name) return undefined;
    let itemMacroData;
    let macro;
    const actorToUse = options.actor ?? this.actor;
    try {
      if (name.startsWith("function.")) {
        itemMacroData = {
          name: "function call",
          type: "script",
          command: `return await ${name.replace("function.", "").trim()}({ speaker, actor, token, character, item, args, scope, workflow })`
        };
      } else if (name.startsWith(MQItemMacroLabel)) {
        // ItemMacro
        // ItemMacro.ItemName
        // ItemMacro.uuid
        if (name === MQItemMacroLabel) {
          if (!item) return {};
          macroItem = item;
          itemMacroData = getProperty(item, "flags.dae.macro") ?? getProperty(macroItem, "flags.itemacro.macro");
          macroData.sourceItemUuid = macroItem?.uuid;
        } else {
          const parts = name.split(".");
          const itemNameOrUuid = parts.slice(1).join(".");
          macroItem = await fromUuid(itemNameOrUuid);
          // ItemMacro.name
          if (!macroItem) macroItem = actorToUse.items.find(i => i.name === itemNameOrUuid && (getProperty(i.flags, "dae.macro") ?? getProperty(i.flags, "itemacro.macro")))
          if (!macroItem) {
            console.warn("midi-qol | callMacro | No item for", name);
            return {};
          }
          itemMacroData = getProperty(macroItem.flags, "dae.macro") ?? getProperty(macroItem.flags, "itemacro.macro");
          macroData.sourceItemUuid = macroItem.uuid;
        }
      } else { // get a world/compendium macro.
        if (name.startsWith("Macro.")) name = name.replace("Macro.", "");
        macro = game.macros?.getName(name)
        if (!macro) {
          const itemOrMacro = await fromUuid(name);
          if (itemOrMacro instanceof Item) {
            macroData.sourceItemUuid = itemOrMacro.uuid;
            itemMacroData = getProperty(itemOrMacro, "flags.dae.macro") ?? getProperty(itemOrMacro, "flags.itemacro.macro");
          } else if (itemOrMacro instanceof Macro) macro = itemOrMacro;
        }

        //@ts-ignore .type v10
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
        itemMacroData = mergeObject({ name: "midi generated macro", type: "script", command: "" }, itemMacroData);
        //@ts-expect-error
        itemMacroData.ownership = { default: CONST.DOCUMENT_PERMISSION_LEVELS.OWNER };
        itemMacroData.author = game.user?.id;
        macro = new CONFIG.Macro.documentClass(itemMacroData);
      }
      const speaker = this.speaker;
      const actor = actorToUse;
      const token = tokenForActor(actorToUse)
      const character = game.user?.character;
      const args = [macroData];

      const scope: any = {};
      scope.workflow = this;
      if (macroItem && macroItem !== rolledItem) {
        scope.item = new Proxy(macroItem, {
          get(obj, prop, reciever) {
            //@ts-expect-error
            logCompatibilityWarning("midi-qol | callMacro: references to item inside an ItemMacro is changing use macroItem instead", {
              since: "11.2.2", until: "11.4"
            });
            return Reflect.get(obj, prop, reciever)
          },
          set(obj, prop, receiver) {
            //@ts-expect-error
            logCompatibilityWarning("midi-qol | callMacro: references to item inside an ItemMacro is changing use macroItem instead", {
              since: "11.2.2", until: "11.4"
            });
            return Reflect.set(obj, prop, receiver);
          }
        })
      } else
        scope.item = rolledItem;
      scope.rolledItem = rolledItem;
      scope.macroItem = macroItem;
      scope.args = args;
      scope.options = options;
      scope.actor = actor;
      scope.token = token;
      scope.midiData = macroData;
      scope.character = character;
      return macro.execute(scope);
    } catch (err) {
      TroubleShooter.recordError(err, "callMacro: Error evaluating macro");
      ui.notifications?.error(`There was an error running your macro. See the console (F12) for details`);
      error("Error evaluating macro ", err)
    }
    return {};
  }

  async removeEffectsButton() {
    if (!this.itemCardId) return;
    const chatMessage: ChatMessage | undefined = game.messages?.get(this.itemCardId);
    if (chatMessage) {
      const buttonRe = /<button data-action="applyEffects">[^<]*<\/button>/;
      //@ts-ignore .content v10
      let content = duplicate(chatMessage.content);
      content = content?.replace(buttonRe, "");
      await chatMessage.update({ content })
    }
  }

  async displayAttackRoll(doMerge, displayOptions: any = {}) {
    const chatMessage: ChatMessage | undefined = game.messages?.get(this.itemCardId ?? "");
    //@ts-ignore .content v10
    let content = (chatMessage && duplicate(chatMessage.content)) || "";
    //@ts-ignore .flags v10
    const flags = chatMessage?.flags || {};
    let newFlags = {};

    if (doMerge) {
      if (game.user?.isGM && this.useActiveDefence) {
        const searchRe = /<div class="midi-qol-attack-roll">[\s\S]*?<div class="end-midi-qol-attack-roll">/
        const attackString = `${i18n("midi-qol.ActiveDefenceString")}${configSettings.displaySaveDC ? " " + this.activeDefenceDC : ""}`;
        const replaceString = `<div class="midi-qol-attack-roll"> <div style="text-align:center">${attackString}</div><div class="end-midi-qol-attack-roll">`
        content = content.replace(searchRe, replaceString);
        const targetUuids = Array.from(this.targets).map(t => getTokenDocument(t)?.uuid);
        newFlags = mergeObject(flags, {
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
      else if (doMerge && chatMessage) { // display the attack roll
        //let searchRe = /<div class="midi-qol-attack-roll">.*?<\/div>/;
        let searchRe = /<div class="midi-qol-attack-roll">[\s\S]*?<div class="end-midi-qol-attack-roll">/
        let options: any = this.attackRoll?.terms[0].options;
        //@ts-ignore advantageMode - advantageMode is set when the roll is actually done, options.advantage/disadvantage are what are passed into the roll
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
        //@ts-ignore game.dice3d
        if (debugEnabled > 0) warn("displayAttackRoll |", this.attackCardData, this.attackRoll)
        newFlags = mergeObject(flags, {
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
      //@ts-expect-error
      const rollMode = this.attackRoll?.options.rollMode;
      if (chatMessage && rollMode) await chatMessage.applyRollMode(rollMode);
      await chatMessage?.update({ content, flags: newFlags });
    }
  }

  get damageFlavor() {
    allDamageTypes = mergeObject(getSystemCONFIG().damageTypes, getSystemCONFIG().healingTypes, { inplace: false });
    if (this.damageDetail.filter(d => d.damage !== 0).length === 0) return `(${allDamageTypes[this.defaultDamageType ?? "none"]})`
    return `(${this.damageDetail.filter(d => d.damage !== 0).map(d => allDamageTypes[d.type] || d.type)})`;
  }

  async displayDamageRoll(doMerge) {
    let chatMessage: ChatMessage | undefined = game.messages?.get(this.itemCardId ?? "");
    //@ts-ignore .content v10
    let content = (chatMessage && duplicate(chatMessage.content)) ?? "";
    if ((getRemoveDamageButtons(this.item) && configSettings.confirmAttackDamage === "none") || this.workflowType !== "Workflow") {
      const versatileRe = /<button data-action="versatile">[^<]*<\/button>/
      const damageRe = /<button data-action="damage">[^<]*<\/button>/
      const formulaRe = /<button data-action="formula">[^<]*<\/button>/
      content = content?.replace(damageRe, "<div></div>")
      content = content?.replace(formulaRe, "")
      content = content?.replace(versatileRe, "")
    }
    //@ts-ignore .flags v10
    var newFlags = chatMessage?.flags || {};
    if (doMerge && chatMessage) {
      if (this.damageRollHTML) {
        const dmgHeader = configSettings.mergeCardCondensed ? this.damageFlavor : (this.flavor ?? this.damageFlavor);
        if (!this.useOther) {
          const searchRe = /<div class="midi-qol-damage-roll">[\s\S]*?<div class="end-midi-qol-damage-roll">/;
          const replaceString = `<div class="midi-qol-damage-roll"><div style="text-align:center">${dmgHeader}</div>${this.damageRollHTML || ""}<div class="end-midi-qol-damage-roll">`
          content = content.replace(searchRe, replaceString);
        } else {
          const otherSearchRe = /<div class="midi-qol-other-roll">[\s\S]*?<div class="end-midi-qol-other-roll">/;
          const otherReplaceString = `<div class="midi-qol-other-roll"><div style="text-align:center">${dmgHeader}</div>${this.damageRollHTML || ""}<div class="end-midi-qol-other-roll">`
          content = content.replace(otherSearchRe, otherReplaceString);
        }
        if (this.otherDamageHTML) {
          const otherSearchRe = /<div class="midi-qol-other-roll">[\s\S]*?<div class="end-midi-qol-other-roll">/;
          const otherReplaceString = `<div class="midi-qol-other-roll"><div style="text-align:center" >${this.otherDamageItem?.name ?? this.damageFlavor}${this.otherDamageHTML || ""}</div><div class="end-midi-qol-other-roll">`
          content = content.replace(otherSearchRe, otherReplaceString);
        }
        if (this.bonusDamageRoll) {
          const bonusSearchRe = /<div class="midi-qol-bonus-roll">[\s\S]*?<div class="end-midi-qol-bonus-roll">/;
          const bonusReplaceString = `<div class="midi-qol-bonus-roll"><div style="text-align:center" >${this.bonusDamageFlavor}${this.bonusDamageHTML || ""}</div><div class="end-midi-qol-bonus-roll">`
          content = content.replace(bonusSearchRe, bonusReplaceString);
        }
      } else {
        if (this.otherDamageHTML) {
          const otherSearchRe = /<div class="midi-qol-damage-roll">[\s\S]*?<div class="end-midi-qol-damage-roll">/;
          const otherReplaceString = `<div class="midi-qol-damage-roll"><div style="text-align:center"></div>${this.otherDamageHTML || ""}<div class="end-midi-qol-damage-roll">`
          content = content.replace(otherSearchRe, otherReplaceString);
        }
        if (this.bonusDamageRoll) {
          const bonusSearchRe = /<div class="midi-qol-bonus-roll">[\s\S]*?<div class="end-midi-qol-bonus-roll">/;
          const bonusReplaceString = `<div class="midi-qol-bonus-roll"><div style="text-align:center" >${this.bonusDamageeFlavor}${this.bonusDamageHTML || ""}</div><div class="end-midi-qol-bonus-roll">`
          content = content.replace(bonusSearchRe, bonusReplaceString);
        }
      }

      this.displayId = randomID();
      newFlags = mergeObject(newFlags, {
        "midi-qol": {
          type: MESSAGETYPES.DAMAGE,
          // roll: this.damageCardData.roll,
          roll: this.damageRoll?.roll,
          damageDetail: this.useOther ? undefined : this.damageDetail,
          damageTotal: this.useOther ? undefined : this.damageTotal,
          otherDamageDetail: this.useOther ? this.damageDetail : this.otherDamageDetail,
          otherDamageTotal: this.useOther ? this.damageTotal : this.otherDamageTotal,
          bonusDamageDetail: this.bonusDamageDetail,
          bonusDamageTotal: this.bonusDamageTotal,
          displayId: this.displayId
        }
      }, { overwrite: true, inplace: false });
    }
    if (!doMerge && this.bonusDamageRoll) {
      const messageData = {
        flavor: this.bonusDamageFlavor,
        speaker: this.speaker
      }
      setProperty(messageData, `flags.${game.system.id}.roll.type`, "damage");
      if (game.system.id === "sw5e") setProperty(messageData, "flags.sw5e.roll.type", "damage");
      this.bonusDamageRoll.toMessage(messageData);
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
    await chatMessage?.update({ "content": content, flags: newFlags });
    //@ts-expect-error
    const rollMode = this.damageRoll?.options.rollMode;
    //@ts-expect-error
    const attackRollMode = this.attackRoll?.options.rollMode;
    if (chatMessage && rollMode && rollMode !== attackRollMode) chatMessage?.applyRollMode(rollMode);
  }

  async displayTargets(whisper = false) {
    if (!configSettings.mergeCard) return;
    this.hitDisplayData = {};
    for (let targetToken of this.targets) {
      //@ts-ignore .document v10
      let img = targetToken.document?.texture.src ?? targetToken.actor?.img;
      if (configSettings.usePlayerPortrait && targetToken.actor?.type === "character") {
        //@ts-ignore .document v10
        img = targetToken.actor?.img ?? targetToken.document?.texture.src;
      }
      if (VideoHelper.hasVideoExtension(img ?? "")) {
        img = await game.video.createThumbnail(img ?? "", { width: 100, height: 100 });
      }
      const tokenUuid = getTokenDocument(targetToken)?.uuid ?? "";
      this.hitDisplayData[tokenUuid] = {
        isPC: targetToken.actor?.hasPlayerOwner,
        target: targetToken,
        hitString: "targets",
        attackType: "",
        img,
        gmName: getIconFreeLink(targetToken),
        playerName: getTokenPlayerName(targetToken),
        bonusAC: 0,
        isHit: this.hitTargets.has(targetToken)
      };
    }
    await this.displayHits(whisper, configSettings.mergeCard && this.itemCardId, false);
  }

  async displayHits(whisper = false, doMerge, showHits = true) {
    const templateData = {
      attackType: this.item?.name ?? "",
      attackTotal: this.attackTotal,
      oneCard: configSettings.mergeCard,
      showHits,
      hits: this.hitDisplayData,
      isCritical: this.isCritical,
      isGM: game.user?.isGM,
      displayHitResultNumeric: configSettings.displayHitResultNumeric && !this.isFumble && !this.isCritical
    };
    if (debugEnabled > 0) warn("displayHits |", templateData, whisper, doMerge);
    const hitContent = await renderTemplate("modules/midi-qol/templates/hits.html", templateData) || "No Targets";
    const chatMessage: ChatMessage | undefined = game.messages?.get(this.itemCardId ?? "");

    if (doMerge && chatMessage) {
      //@ts-ignore .content v10
      var content = (chatMessage && duplicate(chatMessage.content)) ?? "";
      var searchString;
      var replaceString;
      //@ts-ignore game.dice3d
      // TODO test if we are doing better rolls rolls for the new chat cards and damageonlyworkflow
      switch (this.workflowType) {
        case "Workflow":
        case "TrapWorkflow":
        case "DamageOnlyWorkflow":
        case "DDBGameLogWorkflow":
          /*
          if (content && getRemoveAttackButtons() && showHits) {
            const searchRe = /<button data-action="attack">[^<]*<\/button>/;
            content = content.replace(searchRe, "");
          }
          */
          searchString = /<div class="midi-qol-hits-display">[\s\S]*?<div class="end-midi-qol-hits-display">/;
          replaceString = `<div class="midi-qol-hits-display">${hitContent}<div class="end-midi-qol-hits-display">`
          content = content.replace(searchString, replaceString);
          await chatMessage.update({
            "content": content,
            timestamp: Date.now(),
            "flags.midi-qol.type": MESSAGETYPES.HITS,
            type: CONST.CHAT_MESSAGE_TYPES.OTHER,
            "flags.midi-qol.displayId": this.displayId,
          });
          break;
      }
    } else {
      let speaker = duplicate(this.speaker);
      let user: User | undefined | null = game.user;
      if (this.item) {
        speaker = ChatMessage.getSpeaker({ actor: this.item.actor });
        user = playerForActor(this.item.actor);
      }
      if (!user) return;
      speaker.alias = (configSettings.useTokenNames && speaker.token) ? canvas?.tokens?.get(speaker.token)?.name : speaker.alias;
      speaker.scene = canvas?.scene?.id
      if ((validTargetTokens(game.user?.targets ?? new Set())).size > 0) {
        let chatData: any = {
          speaker,
          // user: user.id,
          messageData: {
            speaker,
            user: user.id
          },
          content: hitContent || "No Targets",
          type: CONST.CHAT_MESSAGE_TYPES.OTHER,
        }
        const rollMode = game.settings.get("core", "rollMode");
        if (whisper || !(["roll", "publicroll"].includes(rollMode))) {
          chatData.whisper = ChatMessage.getWhisperRecipients("GM").filter(u => u.active).map(u => u.id);
          if (!game.user?.isGM && rollMode !== "blindroll" && !whisper) chatData.whisper.push(game.user?.id); // message is going to be created by GM add self
          chatData.messageData.user = ChatMessage.getWhisperRecipients("GM").find(u => u.active)?.id;
          if (rollMode === "blindroll") {
            chatData["blind"] = true;
          }

          if (debugEnabled > 1) debug("Trying to whisper message", chatData)
        }
        if (showHits) {
          if (!whisper) setProperty(chatData, "flags.midi-qol.hideTag", "midi-qol-hits-display")
        }
        if (this.flagTags) chatData.flags = mergeObject(chatData.flags ?? "", this.flagTags);
        let result;
        if (!game.user?.isGM)
          result = await timedAwaitExecuteAsGM("createChatMessage", { chatData });
        else
          result = await ChatMessage.create(chatData);
        if (configSettings.undoWorkflow) {
          // Assumes workflow.undoData.chatCardUuids has been initialised
          if (this.undoData && result) {
            this.undoData.chatCardUuids = this.undoData.chatCardUuids.concat([result.uuid]);
            untimedExecuteAsGM("updateUndoChatCardUuids", this.undoData);
          }
        }
      }
    }
  }

  async displaySaves(whisper, doMerge) {
    let chatData: any = {};
    let fullDamage: string[] = [];
    let noDamage: string[] = [];
    let halfDamage: string[] = [];
    let saveString = "";
    let fullDamageText = "";
    let noDamageText = "";
    let halfDamageText = "";
    // TODO display bonus damage if required
    if (this.item.hasDamage) {
      switch (getSaveMultiplierForItem(this.saveItem, "defaultDamage")) {
        case 0:
          noDamage.push(`Base &#48;`)
          break;
        case 1:
          fullDamage.push(`Base &#49;`)
          break
        default:
          halfDamage.push(`Base &frac12;`)
      }
    }
    if (this.bonusDamageDetail?.length > 0 && getSaveMultiplierForItem(this.saveItem, "defaultDamage") !== getSaveMultiplierForItem(this.saveItem, "bonusDamage")) {
      switch (getSaveMultiplierForItem(this.saveItem, "bonusDamage")) {
        case 0:
          noDamage.push(`Bonus &#48;`)
          break;
        case 1:
          fullDamage.push(`Bonus &#49;`)
          break
        default:
          halfDamage.push(`Bonus &frac12;`)
      }
    }

    if (itemOtherFormula(this.otherDamageItem) !== "") {
      switch (getSaveMultiplierForItem(this.otherDamageItem, "otherDamage")) {
        case 0:
          noDamage.push("Other &#48;")
          break;
        case 1:
          fullDamage.push("Other &#49;")
          break;
        default:
          halfDamage.push("Other &frac12;");
      }
    }

    if (fullDamage.length > 0) fullDamageText = i18nFormat("midi-qol.fullDamageText", { damageType: fullDamage.join(", ") });
    if (noDamage.length > 0) noDamageText = i18nFormat("midi-qol.noDamageText", { damageType: noDamage.join(", ") });
    if (halfDamage.length > 0) halfDamageText = i18nFormat("midi-qol.halfDamageText", { damageType: halfDamage.join(", ") });
    let templateData = {
      fullDamageText,
      halfDamageText,
      noDamageText,
      fullSaveDisplay: false && this.item?.flags["midi-qol"]?.isConcentrationCheck,
      saves: this.saveDisplayData,
      // TODO force roll damage
    }
    const chatMessage: ChatMessage | undefined = game.messages?.get(this.itemCardId ?? "");
    const saveContent = await renderTemplate("modules/midi-qol/templates/saves.html", templateData);
    if (doMerge && chatMessage) {
      //@ts-ignore .content v10
      let content = duplicate(chatMessage.content)
      var searchString;
      var replaceString;
      let saveType = "midi-qol.saving-throws";
      if (this.saveItem.system.type === "abil") saveType = "midi-qol.ability-checks"
      const saveHTML = `<div class="midi-qol-nobox midi-qol-bigger-text">${this.saveDisplayFlavor}</div>`;
      //@ts-ignore game.dice3d
      switch (this.workflowType) {
        case "Workflow":
        case "TrapWorkflow":
        case "DDBGameLogWorkflow":
          searchString = /<div class="midi-qol-saves-display">[\s\S]*?<div class="end-midi-qol-saves-display">/;
          replaceString = `<div class="midi-qol-saves-display"><div data-item-id="${this.item.id}">${saveHTML}${saveContent}</div><div class="end-midi-qol-saves-display">`
          content = content.replace(searchString, replaceString);
          await chatMessage.update({
            content,
            type: CONST.CHAT_MESSAGE_TYPES.OTHER,
            "flags.midi-qol.type": MESSAGETYPES.SAVES,
            "flags.midi-qol.saveUuids": Array.from(this.saves).map(t => getTokenDocument(t)?.uuid),
            "flags.midi-qol.failedSaveUuids": Array.from(this.failedSaves).map(t => getTokenDocument(t)?.uuid)
          });
          //@ts-ignore .content v10
          chatMessage.content = content;
      }
    } else {
      //@ts-expect-error .activeGM
      const gmUser = game.users?.activeGM;
      //@ts-ignore _getSpeakerFromuser
      let speaker = ChatMessage._getSpeakerFromUser({ user: gmUser });
      speaker.scene = canvas?.scene?.id ?? "";
      chatData = {
        messageData: {
          user: game.user?.id, //gmUser - save results will come from the user now, not the GM
          speaker
        },
        content: `<div data-item-id="${this.item.id}"></div> ${saveContent}`,
        flavor: `<h4>${this.saveDisplayFlavor}</h4>`,
        type: CONST.CHAT_MESSAGE_TYPES.OTHER,
        flags: { "midi-qol": { type: MESSAGETYPES.SAVES } }
      };

      const rollMode = game.settings.get("core", "rollMode");
      if (configSettings.autoCheckSaves === "whisper" || whisper || !(["roll", "publicroll"].includes(rollMode))) {
        chatData.whisper = ChatMessage.getWhisperRecipients("GM").filter(u => u.active).map(u => u.id);
        chatData.messageData.user = game.user?.id; // ChatMessage.getWhisperRecipients("GM").find(u => u.active);
        if (rollMode === "blindroll") {
          chatData["blind"] = true;
        }

        if (debugEnabled > 1) debug("Trying to whisper message", chatData)
      }
      if (this.flagTags) chatData.flags = mergeObject(chatData.flags ?? {}, this.flagTags);
      // await ChatMessage.create(chatData);
      // Non GMS don't have permission to create the message so hand it off to a gm client
      const result = await timedAwaitExecuteAsGM("createChatMessage", { chatData });
      if (configSettings.undoWorkflow) {
        // Assumes workflow.undoData.chatCardUuids has been initialised
        if (this.undoData && result) {
          this.undoData.chatCardUuids = this.undoData.chatCardUuids.concat([result.uuid]);
          untimedExecuteAsGM("updateUndoChatCardUuids", this.undoData);
        }
      }
    };
  }

  /**
   * update this.saves to be a Set of successful saves from the set of tokens this.hitTargets and failed saves to be the complement
   */
  async checkSaves(whisper = false, simulate = false) {

    if (debugEnabled > 1) debug(`checkSaves: whisper ${whisper}  hit targets ${this.hitTargets}`)
    if (this.hitTargets.size <= 0 && this.hitTargetsEC.size <= 0) {
      this.saveDisplayFlavor = `<span>${i18n("midi-qol.noSaveTargets")}</span>`
      return;
    }

    let rollDC = this.saveItem.system.save.dc;
    if (this.saveItem.getSaveDC) {
      rollDC = this.saveItem.getSaveDC();
    }

    let promises: Promise<any>[] = [];
    //@ts-ignore actor.rollAbilitySave
    var rollAction = CONFIG.Actor.documentClass.prototype.rollAbilitySave;
    var rollType = "save"
    var flagRollType = "save";
    if (this.saveItem.system.actionType === "abil") {
      rollType = "abil"
      flagRollType = "check";
      //@ts-ignore actor.rollAbilityTest
      rollAction = CONFIG.Actor.documentClass.prototype.rollAbilityTest;
    } else {
      const midiFlags = getProperty(this.saveItem, "flags.midi-qol");
      if (midiFlags?.overTimeSkillRoll) {
        rollType = "skill"
        flagRollType = "skill";
        //@ts-ignore actor.rollAbilityTest
        rollAction = CONFIG.Actor.documentClass.prototype.rollSkill;
        this.saveItem.system.save.ability = midiFlags.overTimeSkillRoll;
      }
    }
    let rollAbility = this.saveItem.system.save.ability;
    // make sure saving throws are reenabled.

    if (this.chatUseFlags?.babonus?.saveDC) {
      rollDC = this.babonus.saveDC;
    }
    const playerMonksTB = !simulate && installedModules.get("monks-tokenbar") && configSettings.playerRollSaves === "mtb";
    let monkRequestsPlayer: any[] = [];
    let monkRequestsGM: any[] = [];
    let showRoll = configSettings.autoCheckSaves === "allShow";
    if (simulate) showRoll = false;
    const isMagicSave = this.saveItem?.type === "spell" || this.saveItem?.flags.midiProperties?.magiceffect || this.item?.flags.midiProperties?.magiceffect;

    try {
      const allHitTargets = new Set([...this.hitTargets, ...this.hitTargetsEC]);

      let actorDisposition;
      if (this.token && this.token.document?.disposition) actorDisposition = this.token.document.disposition;
      else { // no token to use so make a guess
        actorDisposition = this.actor?.type === "npc" ? -1 : 1;
      }

      for (let target of allHitTargets) {
        if (!getProperty(this.item, "flags.midi-qol.noProvokeReaction")) {
          //@ts-expect-error
          await doReactions(target, this.tokenUuid, this.attackRoll, "reactionsave", { workflow: this, item: this.item })
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
          saveItemUuid: string
        } = {
          advantage: undefined,
          disadvantage: undefined,
          isMagicSave: isMagicSave,
          isFriendly: undefined,
          isConcentrationCheck: undefined,
          rollDC: rollDC,
          saveItemUuid: ""
        };
        const targetDocument = getTokenDocument(target);
        //@ts-expect-error
        saveDetails.isFriendly = targetDocument?.disposition === actorDisposition;
        if (!target.actor) continue;  // no actor means multi levels or bugged actor - but we won't roll a save
        saveDetails.advantage = undefined;
        saveDetails.disadvantage = undefined;
        saveDetails.isMagicSave = isMagicSave;
        saveDetails.rollDC = rollDC;
        saveDetails.saveItemUuid = this.saveItem.uuid;
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
          const magicResistanceFlags = getProperty(target.actor, "flags.midi-qol.magicResistance");
          if ((magicResistanceFlags?.all && evalCondition(magicResistanceFlags.all, conditionData))
            || (getProperty(magicResistanceFlags, rollAbility) && evalCondition(getProperty(magicResistanceFlags, rollAbility), conditionData))) {
            saveDetails.advantage = true;
            magicResistance = true;
          }
          const magicVulnerabilityFlags = getProperty(target.actor, "flags.midi-qol.magicVulnerability");
          if (magicVulnerabilityFlags && (magicVulnerabilityFlags?.all || getProperty(magicVulnerabilityFlags, rollAbility))) {
            saveDetails.disadvantage = true;
            magicVulnerability = true;
          }
          if (debugEnabled > 1) debug(`${target.actor.name} resistant to magic : ${saveDetails.advantage}`);
        }
        const settingsOptions = procAbilityAdvantage(target.actor, rollType, this.saveItem.system.save.ability, { workflow: this });
        if (settingsOptions.advantage) saveDetails.advantage = true;
        if (settingsOptions.disadvantage) saveDetails.disadvantage = true;
        saveDetails.isConcentrationCheck = this.saveItem.flags["midi-qol"]?.isConcentrationCheck
        if (saveDetails.isConcentrationCheck) {
          const concAdvFlag = getProperty(target.actor, "flags.midi-qol.advantage.concentration");
          const concDisadvFlag = getProperty(target.actor, "flags.midi-qol.disadvantage.concentration");
          let concAdv = saveDetails.advantage;
          let concDisadv = saveDetails.disadvantage;
          if (concAdvFlag || concDisadvFlag) {
            if (concAdvFlag && evalCondition(concAdvFlag, conditionData)) concAdv = true;
            if (concDisadvFlag && evalCondition(concDisadvFlag, conditionData)) concDisadv = true;
          }

          if (concAdv && !concDisadv) {
            saveDetails.advantage = true;
          } else if (!concAdv && concDisadv) {
            saveDetails.disadvantage = true;
          }
        }
        // Check grant's save fields
        const grantSaveAdvantageFlags = getProperty(this.actor, `flags.midi-qol.grants.advantage.${flagRollType}`);
        const grantSaveDisadvantageFlags = getProperty(this.actor, `flags.midi-qol.grants.disadvantage.${flagRollType}`);
        if ((grantSaveAdvantageFlags?.all && evalCondition(grantSaveAdvantageFlags.all, conditionData))
          || (getProperty(grantSaveAdvantageFlags, rollAbility) && evalCondition(getProperty(grantSaveAdvantageFlags, rollAbility), conditionData))) {
          saveDetails.advantage = true;
        }
        if ((grantSaveDisadvantageFlags?.all && evalCondition(grantSaveDisadvantageFlags.all, conditionData))
          || (getProperty(grantSaveDisadvantageFlags, rollAbility) && evalCondition(getProperty(grantSaveDisadvantageFlags, rollAbility), conditionData))) {
          saveDetails.disadvantage = true;
        }
        if (saveDetails.advantage && !saveDetails.disadvantage) this.advantageSaves.add(target);
        else if (saveDetails.disadvantage && !saveDetails.advantage) this.disadvantageSaves.add(target);
        var player = playerFor(target);
        if (!player || !player.active) player = ChatMessage.getWhisperRecipients("GM").find(u => u.active);
        let promptPlayer = !player?.isGM && !(["none", "noneDialog"].includes(configSettings.playerRollSaves));
        let showRollDialog = !player?.isGM && "noneDialog" === configSettings.playerRollSaves;
        if (simulate) promptPlayer = false;
        let GMprompt;
        let gmMonksTB;
        let playerLetme = !player?.isGM && ["letme", "letmeQuery"].includes(configSettings.playerRollSaves);
        let gmLetme = player?.isGM && ["letme", "letmeQuery"].includes(GMprompt);
        const playerChat = !player?.isGM && ["chat"].includes(configSettings.playerRollSaves);
        if (player?.isGM) {
          const targetDocument = getTokenDocument(target);
          const monksTBSetting = targetDocument?.isLinked ? configSettings.rollNPCLinkedSaves === "mtb" : configSettings.rollNPCSaves === "mtb"
          gmMonksTB = installedModules.get("monks-tokenbar") && monksTBSetting;
          GMprompt = (targetDocument?.isLinked ? configSettings.rollNPCLinkedSaves : configSettings.rollNPCSaves);

          promptPlayer = !["auto", "autoDialog"].includes(GMprompt);
          showRollDialog = GMprompt === "autoDialog";
          if (simulate) {
            gmMonksTB = false;
            GMprompt = false;
            promptPlayer = false;
            showRollDialog = false;
          }
        }
        if (!installedModules.get("lmrtfy") && (playerLetme || gmLetme)) {
          playerLetme = false;
          gmLetme = false;
          showRollDialog = true;
          promptPlayer = true;
        }
        this.saveDetails = saveDetails;
        //@ts-expect-error [target]
        if (configSettings.allowUseMacro) await this.triggerTargetMacros(["preTargetSave"], [target]);

        if (saveDetails.isFriendly &&
          (this.saveItem.system.description.value.toLowerCase().includes(i18n("midi-qol.autoFailFriendly").toLowerCase())
            || this.saveItem.flags.midiProperties?.autoFailFriendly)) {
          promises.push(new Roll("-1").roll({ async: true }));
        } else if (saveDetails.isFriendly && this.saveItem.flags.midiProperties?.autoSaveFriendly) {
          promises.push(new Roll("99").roll({ async: true }));
        } else if ((!player?.isGM && playerMonksTB) || (player?.isGM && gmMonksTB)) {
          promises.push(new Promise((resolve) => {
            let requestId = target.id ?? randomID();
            this.saveRequests[requestId] = resolve;
          }));

          if (isMagicSave) {
            if (magicResistance && saveDetails.disadvantage) saveDetails.advantage = true;
            if (magicVulnerability && saveDetails.advantage) saveDetails.disadvantage = true;
          }
          const requests = player?.isGM ? monkRequestsGM : monkRequestsPlayer;
          requests.push({
            token: target.id,
            advantage: saveDetails.advantage,
            disadvantage: saveDetails.disadvantage,
            // altKey: advantage === true,
            // ctrlKey: disadvantage === true,
            fastForward: false,
            isMagicSave
          })
        } else if (player?.active && (playerLetme || gmLetme || playerChat)) {
          if (debugEnabled > 0) warn(`checkSaves | Player ${player?.name} controls actor ${target.actor.name} - requesting ${this.saveItem.system.save.ability} save`);
          promises.push(new Promise((resolve) => {
            let requestId = target?.id ?? randomID();
            const playerId = player?.id;

            if (player && installedModules.get("lmrtfy") && (playerLetme || gmLetme)) requestId = randomID();
            this.saveRequests[requestId] = resolve;

            requestPCSave(this.saveItem.system.save.ability, rollType, player, target.actor, { advantage: saveDetails.advantage, disadvantage: saveDetails.disadvantage, flavor: this.saveItem.name, dc: saveDetails.rollDC, requestId, GMprompt, isMagicSave, magicResistance, magicVulnerability, saveItemUuid: this.saveItem.uuid })

            // set a timeout for taking over the roll
            if (configSettings.playerSaveTimeout > 0) {
              this.saveTimeouts[requestId] = setTimeout(async () => {
                if (this.saveRequests[requestId]) {
                  delete this.saveRequests[requestId];
                  delete this.saveTimeouts[requestId];
                  let result;
                  if (!game.user?.isGM && configSettings.autoCheckSaves === "allShow") {
                    // non-gm users don't have permission to create chat cards impersonating the GM so hand the role to a GM client
                    result = await timedAwaitExecuteAsGM("rollAbility", {
                      targetUuid: target.actor?.uuid ?? "",
                      request: rollType,
                      ability: this.saveItem.system.save.ability,
                      showRoll,
                      options: { messageData: { user: playerId }, target: saveDetails.rollDC, chatMessage: showRoll, mapKeys: false, advantage: saveDetails.advantage, disadvantage: saveDetails.disadvantage, fastForward: true, saveItemUuid: this.saveItem.uuid }
                    });
                  } else {
                    result = await rollAction.bind(target.actor)(this.saveItem.system.save.ability, { messageData: { user: playerId }, chatMessage: showRoll, mapKeys: false, advantage: saveDetails.advantage, disadvantage: saveDetails.disadvantage, fastForward: true, isMagicSave, saveItemUuid: this.saveItem?.uuid });
                  }
                  resolve(result);
                }
              }, (configSettings.playerSaveTimeout || 1) * 1000);
            }
          }))
        } else { // not using LMRTFY/other prompting - just roll a save
          // Find a player owner for the roll if possible
          let owner: User | undefined = playerFor(target);
          if (!owner?.isGM && owner?.active) showRoll = true; // Always show player save rolls
          //@ts-expect-error ,.activeGM - If no player owns the token, find an active GM
          if (!owner?.active) owner = game.users?.activeGM;
          // Fall back to rolling as the current user
          if (!owner) owner = game.user ?? undefined;
          if (!owner?.isGM && playerLetme && owner?.active) showRollDialog = true;
          promises.push(socketlibSocket.executeAsUser("rollAbility", owner?.id, {
            targetUuid: target.actor.uuid,
            request: rollType,
            ability: this.saveItem.system.save.ability,
            // showRoll: whisper && !simulate,
            options: {
              simulate,
              target: saveDetails.rollDC,
              messageData: { user: owner?.id },
              chatMessage: showRoll,
              rollMode: whisper ? "gmroll" : "public",
              mapKeys: false,
              advantage: saveDetails.advantage,
              disadvantage: saveDetails.disadvantage,
              fastForward: simulate || !showRollDialog,
              isMagicSave,
              saveItemUuid: this.saveItem.uuid
            },
          }));
        }
      }
    } catch (err) {
      TroubleShooter.recordError(err);
      console.warn(err)
    } finally {
    }

    if (!whisper) {
      const monkRequests = monkRequestsPlayer.concat(monkRequestsGM);
      const requestData: any = {
        tokenData: monkRequests,
        request: `${rollType === "abil" ? "ability" : rollType}:${this.saveItem.system.save.ability}`,
        silent: true,
        rollMode: whisper ? "gmroll" : "roll" // should be "publicroll" but monks does not check it
      };
      // Display dc triggers the tick/cross on monks tb
      if (configSettings.displaySaveDC && "whisper" !== configSettings.autoCheckSaves) requestData.dc = rollDC
      if (monkRequests.length > 0) {
        timedExecuteAsGM("monksTokenBarSaves", requestData);
      };
    } else {
      const requestDataGM: any = {
        tokenData: monkRequestsGM,
        request: `${rollType === "abil" ? "ability" : rollType}:${this.saveItem.system.save.ability}`,
        silent: true,
        rollMode: whisper ? "selfroll" : "roll", // should be "publicroll" but monks does not check it
        isMagicSave,
        saveItemUuid: this.saveItem.uuid
      }
      const requestDataPlayer: any = {
        tokenData: monkRequestsPlayer,
        request: `${rollType === "abil" ? "ability" : rollType}:${this.saveItem.system.save.ability}`,
        silent: true,
        rollMode: "roll",// should be "publicroll" but monks does not check it
        isMagicSave,
        saveItemUuid: this.saveItem.uuid
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
    if (debugEnabled > 1) debug("check saves: requests are ", this.saveRequests)
    var results = await Promise.all(promises);
    delete this.saveDetails;

    // replace betterrolls results (customRoll) with pseudo normal roll
    results = results.map(result => result.entries ? this.processCustomRoll(result) : result);
    this.saveResults = results;
    let i = 0;
    const allHitTargets = new Set([...this.hitTargets, ...this.hitTargetsEC]);
    if (this.item?.hasAreaTarget && this.templateUuid) {
      const templateDocument = await fromUuid(this.templateUuid);
      //@ts-expect-error
      var template = templateDocument?.object;
    }
    for (let tokenOrDocument of allHitTargets) {
      let target = getToken(tokenOrDocument)
      const targetDocument = getTokenDocument(tokenOrDocument);
      if (!target?.actor || !target || !targetDocument) continue; // these were skipped when doing the rolls so they can be skipped now
      if (!results[i] || results[i].total === undefined) {
        const message = `Token ${target?.name} could not roll save/check assuming 1`;
        error(message, target);
        TroubleShooter.recordError(new Error(message), message);
        results[i] = await new Roll("1").roll({ async: true });
      }
      let result = results[i];
      let rollTotal = results[i]?.total || 0;
      let rollDetail = result;
      if (result?.terms[0]?.options?.advantage) this.advantageSaves.add(target);
      else this.advantageSaves.delete(target);
      if (result?.terms[0]?.options?.disadvantage) this.disadvantageSaves.add(target);
      else this.disadvantageSaves.delete(target);
      if (this.advantageSaves.has(target) && this.disadvantageSaves.has(target)) {
        this.advantageSaves.delete(target);
        this.disadvantageSaves.delete(target);
      }
      let isFumble = false;
      let isCritical = false;
      if (rollDetail?.terms && !result?.isBR && rollDetail.terms[0]) { // normal d20 roll/lmrtfy/monks roll
        const dterm: DiceTerm = rollDetail.terms[0];
        const diceRoll = dterm?.results?.find(result => result.active)?.result ?? (rollDetail.total);
        //@ts-ignore
        isFumble = diceRoll <= (dterm.options?.fumble ?? 1)
        //@ts-ignore
        isCritical = diceRoll >= (dterm.options?.critical ?? 20);
      } else if (result?.isBR) {
        isCritical = result.isCritical;
        isFumble = result.isFumble;
      }
      let coverSaveBonus = 0;

      if (this.item && this.item.hasSave && this.item.system.save?.ability === "dex") {
        if (this.item?.system.actionType === "rsak" && getProperty(this.actor, "flags.dnd5e.spellSniper"))
          coverSaveBonus = 0;
        else if (this.item?.system.actionType === "rwak" && getProperty(this.actor, "flags.midi-qol.sharpShooter"))
          coverSaveBonus = 0;
        else if (this.item?.hasAreaTarget && template) {
          const position = duplicate(template.center);
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
            }, target, this.saveItem);
          } else if (configSettings.optionalRules.coverCalculation === "simbuls-cover-calculator"
            && installedModules.get("simbuls-cover-calculator")) {
            // Special case for templaes
            coverSaveBonus = 0;
            const coverData = await globalThis.CoverCalculator.checkCoverViaCoordinates(
              position.x, position.y, false, 'AoE', false, target);
            if (coverData?.data.results.cover === 3) coverSaveBonus = FULL_COVER;
            else coverSaveBonus = -coverData.data.results.value;
          } if (configSettings.optionalRules.coverCalculation === "tokencover" && installedModules.get("tokencover")) {
            coverSaveBonus = computeCoverBonus(this.token.clone({ center: position }), target, this.saveItem);
          }
        } else {
          coverSaveBonus = computeCoverBonus(this.token, target, this.saveItem);
        }
      }
      rollTotal += coverSaveBonus;
      let saved = rollTotal >= rollDC;

      if (checkRule("criticalSaves")) { // normal d20 roll/lmrtfy/monks roll
        saved = (isCritical || rollTotal >= rollDC) && !isFumble;
      }
      if (getProperty(this.actor, "flags.midi-qol.sculptSpells") && (this.rangeTargeting || this.temptargetConfirmation) && this.item?.system.school === "evo" && this.preSelectedTargets.has(target)) {
        saved = true;
        this.superSavers.add(target)
      }
      if (getProperty(this.actor, "flags.midi-qol.carefulSpells") && (this.rangeTargeting || this.temptargetConfirmation) && this.preSelectedTargets.has(target)) {
        saved = true;
      }
      if (!getProperty(this.saveItem, "flags.midi-qol.noProvokeReaction")) {
        if (saved)
          //@ts-expect-error
          await doReactions(target, this.tokenUuid, this.attackRoll, "reactionsavesuccess", { workflow: this, item: this.saveItem })
        else
          //@ts-expect-error
          await doReactions(target, this.tokenUuid, this.attackRoll, "reactionsavefail", { workflow: this, item: this.saveItem })
      }
      if (isCritical) this.criticalSaves.add(target);
      if (!result?.isBR && !saved) {
        //@ts-ignore
        if (!(result instanceof CONFIG.Dice.D20Roll)) result = CONFIG.Dice.D20Roll.fromJSON(JSON.stringify(result));
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
              newRoll = await bonusCheck(target.actor, result, rollType, failAbilityFlagsLength ? `fail.${rollAbility}` : "fail.all");
            } else {
              newRoll = await socketlibSocket.executeAsUser("bonusCheck", owner?.id, {
                actorUuid: target.actor.uuid,
                result: JSON.stringify(result.toJSON()),
                rollType,
                selector: failFlagsLength ? "fail.all" : `fail.${rollAbility}`
              });

            }
            rollTotal = newRoll.total;
            rollDetail = newRoll;
          }
        }
        saved = rollTotal >= rollDC;
        const dterm: DiceTerm = rollDetail.terms[0];
        const diceRoll = dterm?.results?.find(result => result.active)?.result ?? (rollDetail.total);
        //@ts-ignore
        isFumble = diceRoll <= (dterm.options?.fumble ?? 1)
        //@ts-ignore
        isCritical = diceRoll >= (dterm.options?.critical ?? 20);
      }
      if (isFumble && !saved) this.fumbleSaves.add(target);
      if (this.checkSuperSaver(target, this.saveItem.system.save.ability))
        this.superSavers.add(target);
      if (this.checkSemiSuperSaver(target, this.saveItem.system.save.ability))
        this.semiSuperSavers.add(target);

      if (this.item.flags["midi-qol"]?.isConcentrationCheck) {
        const checkBonus = getProperty(target, "actor.flags.midi-qol.concentrationSaveBonus");
        if (checkBonus) {
          const rollBonus = (await new Roll(`${checkBonus}`, target.actor?.getRollData()).evaluate({ async: true }));
          result = addRollTo(result, rollBonus);
          rollTotal = result.total;
          rollDetail = result;
          //TODO 
          // rollDetail = (await new Roll(`${rollDetail.total} + ${rollBonus}`).evaluate({ async: true }));
          saved = rollTotal >= rollDC;
          if (checkRule("criticalSaves")) { // normal d20 roll/lmrtfy/monks roll
            saved = (isCritical || rollTotal >= rollDC) && !isFumble;
          }
        }
      }

      if (saved) {
        this.saves.add(target);
        this.failedSaves.delete(target);
      }
      if (configSettings.allowUseMacro) await this.triggerTargetMacros(["isSave", "isSaveSuccess", "isSaveFailure"], new Set([target]));

      if (game.user?.isGM) log(`Ability save/check: ${target.name} rolled ${rollTotal} vs ${rollAbility} DC ${rollDC}`);
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
      this.saveDisplayData.push({
        gmName: getIconFreeLink(target),
        playerName: getTokenPlayerName(target),
        img,
        isPC: isPlayerOwned,
        target,
        saveString,
        rollTotal,
        rollDetail,
        id: target.id,
        adv,
        saveStyle,
        rollHtml: (false && this.item?.flags["midi-qol"]?.isConcentrationCheck ? await midiRenderRoll(rollDetail) : "")
      });
      i++;
    }

    let DCString = "DC";
    if (game.system.id === "dnd5e") DCString = i18n(`${this.systemString}.AbbreviationDC`)
    else if (i18n("SW5E.AbbreviationDC") !== "SW5E.AbbreviationDC") {
      DCString = i18n("SW5E.AbbreviationDC");
    }

    if (getSystemCONFIG().abilities[rollAbility]?.label) {
      if (rollType === "save")
        this.saveDisplayFlavor = `${this.saveItem.name} <label class="midi-qol-saveDC">${DCString} ${rollDC}</label> ${getSystemCONFIG().abilities[rollAbility].label ?? getSystemCONFIG().abilities[rollAbility].label} ${i18n(allHitTargets.size > 1 ? "midi-qol.saving-throws" : "midi-qol.saving-throw")}:`;
      else if (rollType === "abil")
        this.saveDisplayFlavor = `${this.saveItem.name} <label class="midi-qol-saveDC">${DCString} ${rollDC}</label> ${getSystemCONFIG().abilities[rollAbility].label ?? getSystemCONFIG().abilities[rollAbility].label} ${i18n(allHitTargets.size > 1 ? "midi-qol.ability-checks" : "midi-qol.ability-check")}:`;
      else if (rollType === "skill") {
        this.saveDisplayFlavor = `${this.saveItem.name} <label class="midi-qol-saveDC">${DCString} ${rollDC}</label> ${getSystemCONFIG().skills[rollAbility].label ?? getSystemCONFIG().skills[rollAbility]}`;
      }

    } else {
      if (rollType === "save")
        this.saveDisplayFlavor = `${this.saveItem.name} <label class="midi-qol-saveDC">${DCString} ${rollDC}</label> ${getSystemCONFIG().abilities[rollAbility].label ?? getSystemCONFIG().abilities[rollAbility]} ${i18n(allHitTargets.size > 1 ? "midi-qol.saving-throws" : "midi-qol.saving-throw")}:`;
      else if (rollType === "abil")
        this.saveDisplayFlavor = `${this.saveItem.name} <label class="midi-qol-saveDC">${DCString} ${rollDC}</label> ${getSystemCONFIG().abilities[rollAbility].label ?? getSystemCONFIG().abilities[rollAbility]} ${i18n(allHitTargets.size > 1 ? "midi-qol.ability-checks" : "midi-qol.ability-check")}:`;
      else if (rollType === "skill") {
        this.saveDisplayFlavor = `${this.saveItem.name} <label class="midi-qol-saveDC">${DCString} ${rollDC}</label> ${getSystemCONFIG().skills[rollAbility].label ?? getSystemCONFIG().skills[rollAbility]}`;
      }

    }
  }

  monksSavingCheck(message, update, options, user) {
    if (!update.flags || !update.flags["monks-tokenbar"]) return true;
    const updateFlags = update.flags["monks-tokenbar"];
    const mflags = message.flags["monks-tokenbar"];
    for (let key of Object.keys(mflags)) {
      if (!key.startsWith("token")) continue;
      const requestId = key.replace("token", "");
      if (!mflags[key].reveal) continue; // Must be showing the roll
      if (this.saveRequests[requestId]) {
        let roll;
        try {
          roll = Roll.fromJSON(JSON.stringify(mflags[key].roll));
        } catch (err) {
          roll = deepClone(mflags[key].roll);
        }

        const func = this.saveRequests[requestId];
        delete this.saveRequests[requestId];
        func(roll)
      }
    }
    return true;
  }


  processDefenceRoll(message, html, data) {
    if (!this.defenceRequests) return true;
    const isLMRTFY = (installedModules.get("lmrtfy") && message.flags?.lmrtfy?.data);
    if (!isLMRTFY || message.flags?.dnd5e?.roll?.type === "save") return true;
    const requestId = isLMRTFY ? message.flags.lmrtfy.data.requestId : message?.speaker?.actor;
    if (debugEnabled > 0) warn("processDefenceRoll |", isLMRTFY, requestId, this.saveRequests)

    if (!requestId) return true;
    if (!this.defenceRequests[requestId]) return true;

    clearTimeout(this.defenceTimeouts[requestId]);
    const handler = this.defenceRequests[requestId]
    delete this.defenceRequests[requestId];
    delete this.defenceTimeouts[requestId];
    const brFlags = message.flags?.betterrolls5e;
    if (brFlags) {
      const formula = "1d20";
      const rollEntry = brFlags.entries?.find((e) => e.type === "multiroll");
      if (!rollEntry) return true;
      let total = rollEntry?.entries?.find((e) => !e.ignored)?.total ?? -1;
      let advantage = rollEntry ? rollEntry.rollState === "highest" : undefined;
      let disadvantage = rollEntry ? rollEntry.rollState === "lowest" : undefined;
      handler({ total, formula, isBR: true, isCritical: brFlags.isCrit, terms: [{ options: { advantage, disadvantage } }] });
    } else {
      handler(message.rolls[0])
    }

    if (game.user?.isGM && message.flags?.lmrtfy?.data?.mode === "selfroll" && !checkRule("activeDefenceShowGM")) {
      html.hide();
    }
    /*
    if (!game.user?.isGM || !checkRule("activeDefenceShowGM")) {
      switch (message.flags?.lmrtfy?.data?.mode) {
        case "blindroll": if (!game.user?.isGM) html.hide(); break;
        case "gmroll": if (!game.user?.isGM && message.user !== game.user?.id) html.hide(); break;
        case "selfroll": if (game.user?.id !== message.user) html.hide(); break;
        default:
          if (game.user?.id !== message.user
            && !["allShow"].includes(configSettings.autoCheckSaves)) html.hide();
      }
    }
    */
    return true;
  }

  processSaveRoll(message, html, data) {
    if (!this.saveRequests) return {};
    const isLMRTFY = message.flags?.lmrtfy?.data && message.rolls;
    const ddbglFlags = message.flags && message.flags["ddb-game-log"];
    const isDDBGL = ddbglFlags?.cls === "save" && !ddbglFlags?.pending;
    const midiFlags = message.flags && message.flags["midi-qol"];

    if (!midiFlags?.lmrtfy?.requestId && !isLMRTFY && !isDDBGL && message.flags?.dnd5e?.roll?.type !== "save") return true;
    let requestId = isLMRTFY ? message.flags.lmrtfy.data.requestId : message?.speaker?.token;
    if (midiFlags?.lmrtfy.requestId) requestId = midiFlags.lmrtfy.requestId;
    if (!requestId && isDDBGL) requestId = message?.speaker?.actor;
    if (debugEnabled > 0) warn("processSaveRoll |", isLMRTFY, requestId, this.saveRequests)
    if (!requestId) return true;

    if (!this.saveRequests[requestId]) return true;

    if (this.saveRequests[requestId]) {
      clearTimeout(this.saveTimeouts[requestId]);
      const handler = this.saveRequests[requestId]
      delete this.saveRequests[requestId];
      delete this.saveTimeouts[requestId];
      const brFlags = message.flags?.betterrolls5e;
      if (configSettings.undoWorkflow) {
        this.undoData.chatCardUuids = this.undoData.chatCardUuids.concat([message.uuid]);
        untimedExecuteAsGM("updateUndoChatCardUuids", this.undoData);
      }

      if (brFlags) {
        const rollEntry = brFlags.entries?.find((e) => e.type === "multiroll");
        if (!rollEntry) return true;
        let total = rollEntry?.entries?.find((e) => !e.ignored)?.total ?? -1;
        let advantage = rollEntry ? rollEntry.rollState === "highest" : undefined;
        let disadvantage = rollEntry ? rollEntry.rollState === "lowest" : undefined;
        const formula = rollEntry.formula ?? "1d20";
        handler({ total, formula, isBR: true, isCritical: brFlags.isCrit, terms: [{ options: { advantage, disadvantage } }] });
      } else {
        handler(message.rolls[0])
      }
    }
    if (game.user?.id !== message.user.id && !isLMRTFY && !["allShow"].includes(configSettings.autoCheckSaves)) {
      setTimeout(() => html.remove(), 100);
    }
    return true;
  }

  checkSuperSaver(token, ability: string) {
    const actor = token.actor ?? {};
    
    const flags = getProperty(actor, "flags.midi-qol.superSaver");
    if (!flags) return false;
    if (flags?.all) {
      const flagVal = evalActivationCondition(this, flags.all, token, {errorReturn: false});
      if (flagVal) return true;
    }
    if (getProperty(flags, `${ability}`)) {
      const flagVal = evalActivationCondition(this, getProperty(flags, `${ability}`), token, {errorReturn: false});
      if (flagVal) return true;
    }
    if (getProperty(this.actor, "flags.midi-qol.sculptSpells") && this.item?.school === "evo" && this.preSelectedTargets.has(token)) {
      return true;
    }
    return false;
  }

  checkSemiSuperSaver(token, ability: string) {
    const actor = token.actor ?? {};
    const flags = getProperty(actor, "flags.midi-qol.semiSuperSaver");
    if (!flags) return false;
    if (flags?.all) {
      const flagVal = evalActivationCondition(this, flags.all, token, {errorReturn: false});
      if (flagVal) return true;
    }
    if (getProperty(flags, `${ability}`)) {
      const flagVal = evalActivationCondition(this, getProperty(flags, `${ability}`), token, {errorReturn: false});
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

  processAttackRoll() {
    if (!this.attackRoll) return;
    const terms = this.attackRoll.terms;
    if (terms[0] instanceof NumericTerm) {
      this.diceRoll = Number(terms[0].total);
    } else {
      this.diceRoll = Number(terms[0].total)
      //TODO find out why this is using results - seems it should just be the total
      // this.diceRoll = terms[0].results.find(d => d.active).result;
    }
    //@ts-ignore .options.critical undefined
    let criticalThreshold = this.attackRoll.options.critical;
    if (this.targets.size > 0) {
      //@ts-expect-error first
      const midiFlags = this.targets.first().actor?.flags["midi-qol"];
      let targetCrit = 20;
      if (midiFlags?.grants?.criticalThreshold) {
        //@ts-expect-error .first()
        const conditionData = createConditionData({ workflow: this, target: this.targets.first(), actor: this.actor });
        targetCrit = evalCondition(midiFlags.grants.criticalThreshold, conditionData, 20);
      }
      if (isNaN(targetCrit) || !Number.isNumeric(targetCrit)) targetCrit = 20;
      criticalThreshold = Math.min(criticalThreshold, targetCrit);
    }
    this.isCritical = this.diceRoll >= criticalThreshold;
    const midiFumble = this.item && getProperty(this.item, "flags.midi-qol.fumbleThreshold");
    //@ts-expect-error .funble
    let fumbleTarget = this.attackRoll.terms[0].options.fumble ?? 1;
    if (Number.isNumeric(midiFumble)) fumbleTarget = midiFumble;
    this.isFumble = this.diceRoll <= fumbleTarget;
    this.attackTotal = this.attackRoll.total ?? 0;
    if (debugEnabled > 1) debug("processAttackRoll: ", this.diceRoll, this.attackTotal, this.isCritical, this.isFumble);
  }

  async checkHits(options: {noProvokeReaction? : boolean, noOnuseMacro?: boolean} = {}) {
    let isHit = true;
    let isHitEC = false;

    let item = this.item;

    // check for a hit/critical/fumble
    if (item?.system.target?.type === "self") {
      this.targets = getSelfTargetSet(this.actor);
    }
    if (!this.useActiveDefence) {
      this.hitTargets = new Set();
      this.hitTargetsEC = new Set(); //TO wonder if this can work with active defence?
    };
    this.hitDisplayData = {};
    const challengeModeArmorSet = !([undefined, false, "none"].includes(checkRule("challengeModeArmor")));
    for (let targetToken of this.targets) {
      let targetName = configSettings.useTokenNames && targetToken.name ? targetToken.name : targetToken.actor?.name;
      //@ts-ignore dnd5e v10
      let targetActor: globalThis.dnd5e.documents.Actor5e = targetToken.actor;
      if (!targetActor) continue; // tokens without actors are an abomination and we refuse to deal with them.
      let targetAC = Number.parseInt(targetActor.system.attributes.ac.value ?? 10);
      const wjVehicle = installedModules.get("wjmais") ? getProperty(targetActor, "flags.wjmais.crew.min") != null : false;
      if (targetActor.type === "vehicle" && !wjVehicle) {
        const inMotion = getProperty(targetActor, "flags.midi-qol.inMotion");
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

        const noCoverFlag = getProperty(this.actor, "flags.midi-qol.ignoreCover");
        let ignoreCover = false;
        if (noCoverFlag) {
          const conditionData = createConditionData({ workflow: this, target: targetToken, actor: this.actor });
          ignoreCover = evalCondition(noCoverFlag, conditionData);
        }
        if (!ignoreCover) bonusAC = computeCoverBonus(this.attackingToken ?? this.token, targetToken, item);
        targetAC += bonusAC;

        const midiFlagsAttackBonus = getProperty(targetActor, "flags.midi-qol.grants.attack.bonus");
        if (!this.isFumble) {
          if (midiFlagsAttackBonus) {
            // if (Number.isNumeric(midiFlagsAttackBonus.all)) attackTotal +=  Number.parseInt(midiFlagsAttackBonus.all);
            // if (Number.isNumeric(midiFlagsAttackBonus[item.system.actionType]) && midiFlagsAttackBonus[item.system.actionType]) attackTotal += Number.parseInt(midiFlagsAttackBonus[item.system.actionType]);
            if (midiFlagsAttackBonus?.all) {
              const attackBonus = await (new Roll(midiFlagsAttackBonus.all, targetActor.getRollData()))?.roll({ async: true });
              attackTotal += attackBonus?.total ?? 0;
            }
            if (midiFlagsAttackBonus[item.system.actionType]) {
              const attackBonus = await (new Roll(midiFlagsAttackBonus[item.system.actionType], targetActor.getRollData())).roll({ async: true });
              attackTotal += attackBonus?.total ?? 0;
            }
          }
          if (challengeModeArmorSet) isHit = attackTotal > targetAC || this.isCritical;
          else {
            if (this.attackRoll && !getProperty(this.item, "flags.midi-qol.noProvokeReaction ") && !options.noProvokeReaction) {
              const workflowOptions = mergeObject(duplicate(this.workflowOptions), { sourceActorUuid: this.actor.uuid, sourceItemUuid: this.item?.uuid }, { inplace: false, overwrite: true });
              const result = await doReactions(targetToken, this.tokenUuid, this.attackRoll, "reactionattacked", { item: this.item, workflow: this, workflowOptions });
              // TODO what else to do once rolled
            }
            isHit = attackTotal >= targetAC || this.isCritical;
          }
          if (bonusAC === FULL_COVER) isHit = false; // bonusAC will only be FULL_COVER if cover bonus checking is enabled.

          if (targetEC) isHitEC = challengeModeArmorSet && attackTotal <= targetAC && attackTotal >= targetEC && bonusAC !== FULL_COVER;
          // check to see if the roll hit the target
          if ((isHit || isHitEC) && this.item?.hasAttack && this.attackRoll && targetToken !== null && !getProperty(this, "item.flags.midi-qol.noProvokeReaction") && !options.noProvokeReaction) {
            const workflowOptions = mergeObject(duplicate(this.workflowOptions), { sourceActorUuid: this.actor.uuid, sourceItemUuid: this.item?.uuid }, { inplace: false, overwrite: true });
            // reaction is the same as reactionhit to accomodate the existing reaction workflow
            let result;
            if (!getProperty(this.item, "flags.midi-qol.noProvokeReaction") && !options.noProvokeReaction) {
              result = await doReactions(targetToken, this.tokenUuid, this.attackRoll, "reaction", { item: this.item, workflow: this, workflowOptions });
            }
            // TODO work out how reactions can return something useful console.error("result is ", result)
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
          } else if ((!isHit && !isHitEC) && this.item?.hasAttack && this.attackRoll && targetToken !== null && !getProperty(this, "item.flags.midi-qol.noProvokeReaction")) {
            const workflowOptions = mergeObject(duplicate(this.workflowOptions), { sourceActorUuid: this.actor.uuid, sourceItemUuid: this.item?.uuid }, { inplace: false, overwrite: true });
            if (!getProperty(this.item, "flags.midi-qol.noProvokeReaction") && !options.noProvokeReaction) {
              let result;
              if (isHit || isHitEC) {
                result = await doReactions(targetToken, this.tokenUuid, this.attackRoll, "reactionhit", { item: this.item, workflow: this, workflowOptions });
              }
              else
                result = await doReactions(targetToken, this.tokenUuid, this.attackRoll, "reactionmissed", { item: this.item, workflow: this, workflowOptions });

            }
            // TODO what else to do once rolled
          }
          const optionalCrits = checkRule("optionalCritRule");
          if (this.targets.size === 1 && optionalCrits !== false && optionalCrits > -1) {
            if (checkRule("criticalNat20") && this.isCritical) {

            } else {
              //@ts-ignore .attributes
              this.isCritical = attackTotal >= (targetToken.actor?.system.attributes?.ac?.value ?? 10) + Number(checkRule("optionalCritRule"));
            }
          }
          hitResultNumeric = this.isCritical ? "++" : `${attackTotal}/${Math.abs(attackTotal - targetAC)}`;
        }

        // TODO come back and parameterise with flags and actor to use

        const midiFlagsActorFailAll = getProperty(this.actor, "flags.midi-qol.fail.all");
        if (midiFlagsActorFailAll) {
          const conditionData = createConditionData({ workflow: this, target: this.token, actor: this.actor });
          if (midiFlagsActorFailAll && evalCondition(midiFlagsActorFailAll, conditionData)) {
            isHit = false;
            isHitEC = false;
            this.isCritical = false;
          }
        }
        const midiFlagsActorAttackFail = getProperty(this.actor, "flags.midi-qol.fail.attack");
        if (midiFlagsActorAttackFail) {
          const conditionData = createConditionData({ workflow: this, target: this.token, actor: this.actor });
          if (midiFlagsActorAttackFail.all && evalCondition(midiFlagsActorAttackFail.all, conditionData)) {
            isHit = false;
            isHitEC = false;
            this.isCritical = false;
          }
          if (midiFlagsActorAttackFail[item.system.actionType] && evalCondition(midiFlagsActorAttackFail[item.system.actionType], conditionData)) {
            isHit = false;
            isHitEC = false;
            this.isCritical = false;
          }
        }
        const midiFlagsActorSuccessAll = getProperty(this.actor, "flags.midi-qol.success.all");
        if (midiFlagsActorSuccessAll) {
          const conditionData = createConditionData({ workflow: this, target: this.token, actor: this.actor });
          if (midiFlagsActorSuccessAll && evalCondition(midiFlagsActorSuccessAll, conditionData)) {
            isHit = true;
            isHitEC = false;
            this.isFumble = false;
          }
        }
        const midiFlagsActorAttackSuccess = getProperty(this.actor, "flags.midi-qol.success.attack");
        if (midiFlagsActorAttackSuccess) {
          const conditionData = createConditionData({ workflow: this, target: this.token, actor: this.actor });
          if (midiFlagsActorAttackSuccess.all && evalCondition(midiFlagsActorAttackSuccess.all, conditionData)) {
            isHit = true;
            isHitEC = false;
            this.isFumble = false;
          }
          if (midiFlagsActorAttackSuccess[item.system.actionType] && evalCondition(midiFlagsActorAttackSuccess[item.system.actionType], conditionData)) {
            isHit = true;
            isHitEC = false;
            this.isFumble = false;
          }
        }

        const midiFlagsAttackSuccess = getProperty(targetActor, "flags.midi-qol.grants.attack.success");
        if (midiFlagsAttackSuccess) {
          const conditionData = createConditionData({ workflow: this, target: this.token, actor: this.actor });
          if (midiFlagsAttackSuccess.all && evalCondition(midiFlagsAttackSuccess.all, conditionData)) {
            isHit = true;
            isHitEC = false;
            this.isFumble = false;
          }
          if (midiFlagsAttackSuccess[item.system.actionType] && evalCondition(midiFlagsAttackSuccess[item.system.actionType], conditionData)) {
            isHit = true;
            isHitEC = false;
            this.isFumble = false;
          }
        }
        const midiFlagsAttackFail = getProperty(targetActor, "flags.midi-qol.grants.attack.fail");
        if (midiFlagsAttackFail) {
          const conditionData = createConditionData({ workflow: this, target: this.token, actor: this.actor });
          if (midiFlagsAttackFail.all && evalCondition(midiFlagsAttackFail.all, conditionData)) {
            isHit = false;
            isHitEC = false;
            this.isCritical = false;
          }
          if (midiFlagsAttackFail[item.system.actionType] && evalCondition(midiFlagsAttackFail[item.system.actionType], conditionData)) {
            isHit = false;
            isHitEC = false;
            this.isCritical = false;
          }
        }

        let scale = 100;
        if (["scale", "scaleNoAR"].includes(checkRule("challengeModeArmor")) && !this.isCritical) scale = Math.floor((this.attackTotal - targetEC + 1) / ((targetActor?.system.attributes.ac.AR ?? 0) + 1) * 10) / 10;
        if (!this.challengeModeScale) this.challengeModeScale = {};
        this.challengeModeScale[targetToken.actor?.uuid ?? "dummy"] = scale;
        // setProperty(targetToken.actor ?? {}, "flags.midi-qol.challengeModeScale", scale);
        if (this.isCritical) isHit = true;
        if (isHit || this.isCritical) this.hitTargets.add(targetToken);
        if (isHitEC) this.hitTargetsEC.add(targetToken);
        if (isHit || isHitEC) this.processCriticalFlags();
        // This was set by computeCoverBonus so clear it after use.
        setProperty(targetActor, "flags.midi-qol.acBonus", 0);
      }
      if (game.user?.isGM) log(`${this.speaker.alias} Rolled a ${this.attackTotal} to hit ${targetName}'s AC of ${targetAC} ${(isHit || this.isCritical) ? "hitting" : "missing"}`);
      // Log the hit on the target
      let attackType = ""; //item?.name ? i18n(item.name) : "Attack";

      let hitScale = 100;
      if (["scale", "scaleNoAR"].includes(checkRule("challengeModeArmor")) && !this.isCritical) hitScale = Math.floor(this.challengeModeScale[targetActor.uuid] * 100);
      let hitString;
      if (game.user?.isGM && ["hitDamage", "all"].includes(configSettings.hideRollDetails) && (this.isCritical || this.isHit || this.isHitEC)) hitString = i18n("midi-qol.hits");
      else if (this.isCritical) hitString = i18n("midi-qol.criticals");
      else if (game.user?.isGM && this.isFumble && ["hitDamage", "all"].includes(configSettings.hideRollDetails)) hitString = i18n("midi-qol.misses");
      else if (this.isFumble) hitString = i18n("midi-qol.fumbles");
      else if (isHit) hitString = i18n("midi-qol.hits");
      else if (isHitEC && ["scale", "scaleNoAR"].includes(checkRule("challengeModeArmor"))) hitString = `${i18n("midi-qol.hitsEC")} (${hitScale}%)`;
      else if (isHitEC) hitString = `${i18n("midi-qol.hitsEC")}`;
      else hitString = i18n("midi-qol.misses");
      let hitStyle = "";
      if (configSettings.highlightSuccess) {
        if (isHit || isHitEC) hitStyle = "color: green;";
        else hitStyle = "color: red;";
      }
      if (attackTotal !== this.attackTotal) {
        if (!configSettings.displayHitResultNumeric &&
          (!game.user?.isGM || ["none", "detailsDSN", "details"].includes(configSettings.hideRollDetails))) {
          hitString = `(${attackTotal}) ${hitString}`; // prepend the modified hit roll
        } else {
          hitString = `(${attackTotal - this.attackTotal}) ${hitString}`; // prepend the diff in the modified roll
        }
      }

      //@ts-ignore .document v10
      let img = targetToken.document?.texture?.src || targetToken.actor?.img;
      if (configSettings.usePlayerPortrait && targetToken.actor?.type === "character") {
        //@ts-ignore .document v10
        img = targetToken.actor?.img || targetToken.document?.texture?.src;
      }
      if (VideoHelper.hasVideoExtension(img ?? "")) {
        img = await game.video.createThumbnail(img ?? "", { width: 100, height: 100 });
      }
      // If using active defence hitTargets are up to date already.
      if (this.useActiveDefence) {
        if (this.activeDefenceRolls[getTokenDocument(targetToken)?.uuid ?? ""]) {
          if (targetToken.actor?.type === "character") {
            const adRoll = this.activeDefenceRolls[getTokenDocument(targetToken)?.uuid ?? ""] ?? {};
            hitString = `(${adRoll.result ?? adRoll.total}): ${hitString}`
          } else {
            hitString = `(${this.activeDefenceRolls[getTokenDocument(targetToken)?.uuid ?? ""].total}): ${hitString}`
          }
        }
      }
      if (this.isFumble) hitResultNumeric = "--";
      const targetUuid = getTokenDocument(targetToken)?.uuid ?? "";
      this.hitDisplayData[targetUuid] = {
        isPC: targetToken.actor?.hasPlayerOwner,
        target: targetToken,
        hitString,
        hitStyle,
        attackType,
        img,
        gmName: getIconFreeLink(targetToken),
        playerName: getTokenPlayerName(targetToken instanceof Token ? targetToken.document : targetToken),
        bonusAC,
        hitResultNumeric
      };
    }
    if (configSettings.allowUseMacro && !options.noOnuseMacro) await this.triggerTargetMacros(["isHit"], new Set([...this.hitTargets, ...this.hitTargetsEC]));
    if (configSettings.allowUseMacro && !options.noOnuseMacro) await this.triggerTargetMacros(["isMissed"], this.targets);
  }

  setRangedTargets(targetDetails) {
    if (!canvas || !canvas.scene) return true;
    const token = canvas?.tokens?.get(this.speaker.token);
    if (!token) {
      ui.notifications?.warn(`${game.i18n.localize("midi-qol.noSelection")}`)
      return true;
    }
    // We have placed an area effect template and we need to check if we over selected
    //@ts-ignore .disposition v10
    let dispositions = targetDetails.type === "creature" ? [-1, 0, 1] : targetDetails.type === "ally" ? [token.document.disposition] : [-token.document.disposition];
    // release current targets
    game.user?.targets.forEach(t => {
      //@ts-ignore
      t.setTarget(false, { releaseOthers: false });
    });
    game.user?.targets.clear();
    // min dist is the number of grid squares away.
    let minDist = targetDetails.value;
    const targetIds: string[] = [];

    if (canvas.tokens?.placeables && canvas.grid) {
      if (!configSettings.useTemplateRangedTargeting) {
        for (let target of canvas.tokens.placeables) {
          if (!isTargetable(target)) continue;
          const ray = new Ray(target.center, token.center);
          const wallsBlocking = ["wallsBlock", "wallsBlockIgnoreDefeated", "wallsBlockIgnoreIncapacitated"].includes(configSettings.rangeTarget)
          //@ts-ignore .system
          let inRange = target.actor
            //@ts-ignore .disposition v10
            && dispositions.includes(target.document.disposition);
          if (target.actor && ["wallsBlockIgnoreIncapacited", "alwaysIngoreIncapcitate"].includes(configSettings.rangeTarget))
            inRange = inRange && !checkIncapacitated(target, debugEnabled > 0);
          if (["wallsBlockIgnoreDefeated", "alwaysIgnoreDefeated"].includes(configSettings.rangeTarget))
            inRange = inRange && !checkDefeated(target);
          inRange = inRange && (configSettings.rangeTarget === "none" || !hasWallBlockingCondition(target))
          if (inRange) {
            // if the item specifies a range of "special" don't target the caster.
            let selfTarget = (this.item?.system.range?.units === "spec") ? canvas.tokens?.get(this.tokenId) : null;
            if (selfTarget === target) {
              inRange = false;
            }
            const distance = getDistanceSimple(target, token, wallsBlocking);
            inRange = inRange && distance >= 0 && distance <= minDist
          }
          if (inRange) {
            target.setTarget(true, { user: game.user, releaseOthers: false });
            if (target.document.id) targetIds.push(target.document.id);
          }
        }
      } else {
        // create a template and select targets and the filter
      }
      this.targets = new Set(game.user?.targets ?? []);
      this.saves = new Set();
      this.failedSaves = new Set(this.targets)
      this.hitTargets = new Set(this.targets);
      this.hitTargetsEC = new Set();
      game.user?.broadcastActivity({ targets: targetIds });
    }
    return true;
  }

  async removeActiveEffects(effectIds: string | [string]) {
    if (!Array.isArray(effectIds)) effectIds = [effectIds];
    this.actor.deleteEmbeddedDocuments("ActiveEffect", effectIds);
  }

  async removeItemEffects(uuid: Item | string = this.item?.uuid) {
    if (!uuid) {
      const message = `removeItemEffects | Cannot remove effects when no item specified`;
      error(message);
      TroubleShooter.recordError(new Error(message), message);
      return;
    }
    if (uuid instanceof Item) uuid = uuid.uuid;
    const filtered = this.actor.effects.reduce((filtered, ef) => {
      if (ef.origin === uuid) filtered.push(ef.id);
      return filtered;
    }, []);
    if (filtered.length > 0) this.removeActiveEffects(filtered);
  }

  async activeDefence(item, roll) {

    // For each target do a LMRTFY custom roll DC 11 + attackers bonus - for gm tokens always auto roll
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
    //@ts-ignore
    return game.user.isGM && checkRule("activeDefence") && ["Workflow"].includes(this.workflowType);
  }
  async checkActiveAttacks(attackBonus = 0, whisper = false, fumbleTarget, criticalTarget) {
    if (debugEnabled > 1) debug(`active defence : whisper ${whisper}  hit targets ${this.targets}`)
    if (this.targets.size <= 0) {
      return;
    }
    this.activeDefenceDC = 11 + attackBonus;

    let promises: Promise<any>[] = [];

    for (let target of this.targets) {
      if (!target.actor) continue;  // no actor means multi levels or bugged actor - but we won't roll a save
      let advantage: boolean | undefined = undefined;
      let advantageMode = game[game.system.id].dice.D20Roll.ADV_MODE.NORMAL;
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
        advantageMode = game[game.system.id].dice.D20Roll.ADV_MODE.DISADVANTAGE;
      } else if (!wfadvantage && wfdisadvantage) {
        advantageMode = game[game.system.id].dice.D20Roll.ADV_MODE.ADVANTAGE;
        advantage = true;
        formula = `2d20kh${modString}`;
      }
      //@ts-ignore
      var player = playerFor(target instanceof Token ? target : target.object);
      // if (!player || !player.active) player = ChatMessage.getWhisperRecipients("GM").find(u => u.active);
      if (debugEnabled > 0) warn(`checkSaves | Player ${player?.name} controls actor ${target.actor.name} - requesting ${this.saveItem.system.save.ability} save`);
      if (player && player.active && !player.isGM) {
        promises.push(new Promise((resolve) => {
          const requestId = target.actor?.uuid ?? randomID();
          const playerId = player?.id;
          this.defenceRequests[requestId] = resolve;
          requestPCActiveDefence(player, target.actor, advantage, this.item.name, this.activeDefenceDC, formula, requestId, { workflow: this })
          // set a timeout for taking over the roll
          if (configSettings.playerSaveTimeout > 0) {
            this.defenceTimeouts[requestId] = setTimeout(async () => {
              if (this.defenceRequests[requestId]) {
                delete this.defenceRequests[requestId];
                delete this.defenceTimeouts[requestId];
                const result = await (new game[game.system.id].dice.D20Roll(formula, {}, { advantageMode })).roll({ async: true });
                result.toMessage({ flavor: `${this.item.name} ${i18n("midi-qol.ActiveDefenceString")}` });

                resolve(result);
              }
            }, configSettings.playerSaveTimeout * 1000);
          }
        }));
      } else {  // must be a GM so can do the roll direct
        promises.push(
          new Promise(async (resolve) => {
            const result = await (new game[game.system.id].dice.D20Roll(formula, {}, { advantageMode })).roll({ async: true })
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
        results[i] = await new Roll("1").roll({ async: true });
      }
      const result = results[i];
      let rollTotal = results[i]?.total || 0;
      if (this.isCritical === undefined) this.isCritical = result.dice[0].total <= criticalTarget
      if (this.isFumble === undefined) this.isFumble = result.dice[0].total >= fumbleTarget;
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
    this.attackTotal = roll.total ?? 0;
    this.attackRollHTML = await midiRenderRoll(roll);
  }
  async setDamageRoll(roll: Roll) {
    this.damageRoll = roll;
    this.damageTotal = roll.total ?? 0;
    this.damageRollHTML = await midiRenderRoll(roll);
  }
  async setBonusDamageRoll(roll: Roll) {
    this.bonusDamageRoll = roll;
    this.bonusDamageTotal = roll.total ?? 0;
    this.bonusDamageHTML = await midiRenderRoll(roll);
  }
  async setOtherDamageRoll(roll: Roll) {
    this.otherDamageRoll = roll;
    this.otherDamageTotal = roll.total ?? 0;
    this.otherDamageHTML = await midiRenderRoll(roll);

  }
}

export class DamageOnlyWorkflow extends Workflow {
  //@ts-ignore dnd5e v10
  constructor(actor: globalThis.dnd5e.documents.Actor5e, token: Token, damageTotal: number, damageType: string, targets: [Token], roll: Roll,
    options: { flavor: string, itemCardId: string, damageList: [], useOther: boolean, itemData: {}, isCritical: boolean }) {
    if (!actor) actor = token.actor ?? targets[0]?.actor;
    //@ts-ignore spurious error on t.object
    const theTargets = targets.map(t => t instanceof TokenDocument ? t.object : t);
    //@ts-ignore getSpeaker requires a token document
    super(actor, null, ChatMessage.getSpeaker({ token: getTokenDocument(token) }), new Set(theTargets), shiftOnlyEvent)
    this.itemData = options.itemData ? duplicate(options.itemData) : undefined;
    // Do the supplied damageRoll
    this.flavor = options.flavor;
    this.defaultDamageType = getSystemCONFIG().damageTypes[damageType] || damageType;
    this.damageList = options.damageList;
    this.itemCardId = options.itemCardId;
    this.useOther = options.useOther ?? true;
    this.damageRoll = roll ? roll : new Roll(`${damageTotal}[${damageType}]`).roll({ async: false });
    this.damageDetail = createDamageDetail({ roll: this.damageRoll, item: this.item, ammo: null, versatile: this.rollOptions.versatile, defaultType: damageType });
    this.damageTotal = damageTotal;
    this.isCritical = options.isCritical ?? false;
    this.kickStart = false;
    this.suspended = false;
    this.performState(this.WorkflowState_Start);
    return this;
  }

  get workflowType() { return this.__proto__.constructor.name };
  get damageFlavor() {
    if (this.useOther && this.flavor) return this.flavor;
    else return super.damageFlavor;
  }

  async WorkflowState_Start(context: any = {}): Promise<WorkflowState> {
    this.effectsAlreadyExpired = [];
    if (this.itemData) {
      this.itemData.effects = this.itemData.effects.map(e => duplicate(e))
      this.item = new CONFIG.Item.documentClass(this.itemData, { parent: this.actor });
      setProperty(this.item, "flags.midi-qol.onUseMacroName", null);
    } else this.item = null;
    if (this.itemCardId === "new" && this.item) { // create a new chat card for the item
      this.createCount += 1;
      // this.itemCard = await showItemCard.bind(this.item)(false, this, true);
      //@ts-ignore .displayCard
      this.itemCard = await this.item.displayCard({ systemCard: false, workflow: this, createMessage: true, defaultCard: true });

      this.itemCardId = this.itemCard.id;
      // Since this could to be the same item don't roll the on use macro, since this could loop forever
    }

    // Need to pretend there was an attack roll so that hits can be registered and the correct string created
    // TODO separate the checkHit()/create hit display Data and displayHits() into 3 separate functions so we don't have to pretend there was a hit to get the display
    this.isFumble = false;
    this.attackTotal = 9999;
    await this.checkHits();
    const whisperCard = configSettings.autoCheckHit === "whisper" || game.settings.get("core", "rollMode") === "blindroll";
    await this.displayHits(whisperCard, configSettings.mergeCard && this.itemCardId);

    if (this.actor) { // Hacky process bonus flags
      await this.setDamageRoll(await processDamageRollBonusFlags.bind(this)());
      this.damageDetail = createDamageDetail({ roll: this.damageRoll, item: this.item, ammo: this.ammo, versatile: this.rollOptions.versatile, defaultType: this.defaultDamageType });
    }

    if (configSettings.mergeCard && this.itemCardId) {
      this.damageRollHTML = await midiRenderRoll(this.damageRoll);
      this.damageCardData = {
        //@ts-ignore ? flavor TODO
        flavor: "damage flavor",
        roll: this.damageRoll ?? null,
        speaker: this.speaker
      }
      await this.displayDamageRoll(configSettings.mergeCard && this.itemCardId)
    } else await this.damageRoll?.toMessage({ flavor: this.flavor });
    this.hitTargets = new Set(this.targets);
    this.hitTargetsEC = new Set();
    this.applicationTargets = new Set(this.targets);
    // TODO change this to the new apply token damage call - sigh
    this.damageList = await applyTokenDamage(this.damageDetail, this.damageTotal, this.targets, this.item, new Set(), { existingDamage: this.damageList, superSavers: new Set(), semiSuperSavers: new Set(), workflow: this, updateContext: undefined, forceApply: false })
    super.WorkflowState_RollFinished().then(() => { Workflow.removeWorkflow(this.id) });
    return this.WorkflowState_Suspend;
  }

}

export class TrapWorkflow extends Workflow {

  templateLocation: { x: number, y: number, direction?: number, removeDelay?: number } | undefined;
  saveTargets: any;

  //@ts-ignore dnd5e v10
  constructor(actor: globalThis.dnd5e.documents.Actor5e, item: globalThis.dnd5e.documents.Item5e, targets: Array<Token> | undefined,
    templateLocation: { x: number, y: number, direction?: number, removeDelay?: number } | undefined = undefined,
    trapSound: { playlist: string, sound: string } | undefined = undefined, event: any = {}) {
    super(actor, item, ChatMessage.getSpeaker({ actor }), new Set(targets), event);
    // this.targets = new Set(targets);
    if (!this.event) this.event = duplicate(shiftOnlyEvent);
    if (templateLocation) this.templateLocation = templateLocation;
    // this.saveTargets = game.user.targets; 
    this.rollOptions.fastForward = true;
    this.kickStart = false;
    this.suspended = false;
    this.performState(this.WorkflowState_Start);
    return this;
  }

  async WorkflowState_Start(context: any = {}): Promise<WorkflowState> {
    this.saveTargets = validTargetTokens(game.user?.targets);
    this.effectsAlreadyExpired = [];
    this.onUseMacroCalled = false;
    this.itemCardID = await (this.item.displayCard({ systemCard: false, workflow: this, createMessage: true, defaultCard: true })).id;

    // this.itemCardId = (await showItemCard.bind(this.item)(false, this, true))?.id;
    //@ts-ignore TODO this is just wrong fix
    if (debugEnabled > 1) debug(" workflow.none ", state, this.item, getAutoTarget(this.item), this.item?.hasAreaTarget, this.targets);
    // don't support the placement of a template
    return this.WorkflowState_AwaitTemplate
  }
  async WorkflowState_AwaitTemplate(context: any = {}): Promise<WorkflowState> {
    const targetDetails = this.item.system.target;
    if (configSettings.rangeTarget !== "none" && ["m", "ft"].includes(targetDetails?.units) && ["creature", "ally", "enemy"].includes(targetDetails?.type)) {
      this.setRangedTargets(targetDetails);
      this.targets = validTargetTokens(this.targets);
      this.failedSaves = new Set(this.targets)
      this.hitTargets = new Set(this.targets);
      this.hitTargetsEC = new Set();
      return this.WorkflowState_TemplatePlaced;
    }
    if (!this.item?.hasAreaTarget || !this.templateLocation)
      return this.WorkflowState_TemplatePlaced;
    //@ts-expect-error .canvas
    const TemplateClass = game.system.canvas.AbilityTemplate;
    const templateData = TemplateClass.fromItem(this.item).document.toObject(false); // TODO check this v10
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
      const ignoreSelf = getProperty(this.item, "flags.midi-qol.trapWorkflow.ignoreSelf") ?? false;
      const AoETargetType = getProperty(this.item, "flags.midi-qol.trapWorkflow.AoETargetType") ?? "";
      templateTokens(templateDocument.object, selfToken, ignoreSelf, AoETargetType);
      selectTargets.bind(this)(templateDocument, null, game.user?.id); // Target the tokens from the template
      if (this.templateLocation?.removeDelay) {
        //@ts-ignore _ids
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
    if (!this.item.hasAttack) {
      this.hitTargets = new Set(this.targets);
      this.hitTargetsEC = new Set();
      return this.WorkflowState_WaitForSaves;
    }
    if (debugEnabled > 0) warn("waitForAttackRoll | attack roll ", this.event)
    this.item.rollAttack({ event: this.event });
    return this.WorkflowState_Suspend;
  }
  async WorkflowState_AttackRollComplete(context: any = {}): Promise<WorkflowState> {
    const attackRollCompleteStartTime = Date.now();
    this.processAttackRoll();
    await this.displayAttackRoll(configSettings.mergeCard);
    await this.checkHits();
    const whisperCard = configSettings.autoCheckHit === "whisper" || game.settings.get("core", "rollMode") === "blindroll";
    await this.displayHits(whisperCard, configSettings.mergeCard);
    if (debugCallTiming) log(`AttackRollComplete elapsed time ${Date.now() - attackRollCompleteStartTime}ms`)
    return this.WorkflowState_WaitForSaves;
  }
  async WorkflowState_WaitForSaves(context: any = {}): Promise<WorkflowState> {
    this.initSaveResults();
    if (!this.saveItem.hasSave) {
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
    //@ts-ignore .events not defined
    if (debugEnabled > 1) debug("Check Saves: renderChat message hooks length ", Hooks.events["renderChatMessage"]?.length)
    await this.displaySaves(configSettings.autoCheckSaves === "whisper", configSettings.mergeCard);
    return this.WorkflowState_SavesComplete;
  }
  async WorkflowState_SavesComplete(context: any = {}): Promise<WorkflowState> {
    return this.WorkflowState_WaitForDamageRoll
  }
  async WorkflowState_WaitForDamageRoll(context: any = {}): Promise<WorkflowState> {
    if (context.damageRoll) return this.WorkflowState_DamageRollComplete;
    if (!itemHasDamage(this.item)) return this.WorkflowState_AllRollsComplete;

    if (this.isFumble) {
      // fumble means no trap damage/effects
      return this.WorkflowState_RollFinished;
    }
    if (debugEnabled > 1) debug("TrapWorkflow: Rolling damage ", this.event, this.spellLevel, this.rollOptions.versatile, this.targets, this.hitTargets);
    this.rollOptions.fastForward = true;
    this.item.rollDamage(this.rollOptions);
    return this.WorkflowState_Suspend; // wait for a damage roll to advance the state.
  }
  async WorkflowState_DamageRollComplete(context: any = {}): Promise<WorkflowState> {
    if (!this.item.hasAttack) { // no attack roll so everyone is hit
      this.hitTargets = new Set(this.targets);
      this.hitTargetsEC = new Set();
      if (debugEnabled > 0) warn("damageRollComplete | for non auto target area effects spells", this)
    }

    // If the item does damage, use the same damage type as the item
    let defaultDamageType;
    //@ts-expect-error .version
    if (isNewerVersion(game.system.version, "2.4.99")) {
      defaultDamageType = this.item?.system.damage?.parts[0].damageType || this.defaultDamageType;
    } else {
      defaultDamageType = this.item?.system.damage?.parts[0][1] || this.defaultDamageType;
    }
    this.damageDetail = createDamageDetail({ roll: this.damageRoll, item: this.item, ammo: this.ammo, versatile: this.rollOptions.versatile, defaultType: defaultDamageType });
    // apply damage to targets plus saves plus immunities
    await this.displayDamageRoll(configSettings.mergeCard)
    if (this.isFumble) {
      return this.WorkflowState_ApplyDynamicEffects
    }
    return this.WorkflowState_AllRollsComplete;
  }
  async WorkflowState_AllRollsComplete(context: any = {}): Promise<WorkflowState> {
    if (debugEnabled > 1) debug("all rolls complete ", this.damageDetail)
    if (this.damageDetail.length) await processDamageRoll(this, this.damageDetail[0].type)
    return this.WorkflowState_ApplyDynamicEffects;
  }
  async WorkflowState_RollFinished(context: any = {}): Promise<WorkflowState> {
    // area effect trap, put back the targets the way they were
    if (this.saveTargets && this.item?.hasAreaTarget) {
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

  //@ts-ignore dnd5e v10
  constructor(actor: globalThis.dnd5e.documents.Actor5e, item: globalThis.dnd5e.documents.Item5e, speaker, targets, options: any) {
    super(actor, item, speaker, targets, options);
    this.needTemplate = this.item?.hasAreaTarget ?? false;
    this.needItemCard = false;
    this.preItemUseComplete = true;
    this.damageRolled = false;
    this.attackRolled = !item.hasAttack;
    // for dnd beyond only roll if other damage is defined.
    this.needsOtherDamage = this.item.system.formula && shouldRollOtherDamage.bind(this.otherDamageItem)(this, configSettings.rollOtherDamage, configSettings.rollOtherSpellDamage);
    this.kickStart = true;
    this.flagTags = { "ddb-game-log": { "midi-generated": true } }
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
  async WorkflowState_WaitForAttackRoll(context: any = {}): Promise<WorkflowState> {
    if (context.attackRoll) return this.WorkflowState_AttackRollComplete;
    if (!this.item.hasAttack) {
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
    if (configSettings.autoCheckHit !== "none") {
      await this.checkHits();
      await this.displayHits(configSettings.autoCheckHit === "whisper", configSettings.mergeCard);
    }
    await asyncHooksCallAll("midi-qol.AttackRollComplete", this);
    if (this.item) await asyncHooksCallAll(`midi-qol.AttackRollComplete.${this.item.uuid}`, this);
    if (this.aborted) return this.WorkflowState_Abort;
    return this.WorkflowState_WaitForDamageRoll;
  }
  async WorkflowState_AwaitTemplate(context: any = {}): Promise<WorkflowState> {
    if (!this.item?.hasAreaTarget) return super.WorkflowState_AwaitTemplate;
    //@ts-ignore
    let system: any = game[game.system.id]
    // Create the template
    const template = system.canvas.AbilityTemplate.fromItem(this.item);
    if (template) template.drawPreview();
    return super.WorkflowState_AwaitTemplate;
  }
  async WorkflowState_WaitForDamageRoll(context: any = {}): Promise<WorkflowState> {
    if (!this.damageRolled) return;
    if (this.needsOtherDamage) return;
    const allHitTargets = new Set([...this.hitTargets, ...this.hitTargetsEC]);
    this.failedSaves = new Set(allHitTargets);
    if (!itemHasDamage(this.item)) return this.WorkflowState_WaitForSaves;
    return this.WorkflowState_DamageRollComplete;
  }
  async WorkflowState_DamageRollComplete(context: any = {}): Promise<WorkflowState> {
    //@ts-expect-error .version
    if (isNewerVersion(game.system.version, "2.4.99")) {
      this.defaultDamageType = this.item.system.damage?.parts[0].damageType || this.defaultDamageType || MQdefaultDamageType;
    } else {
      this.defaultDamageType = this.item.system.damage?.parts[0][1] || this.defaultDamageType || MQdefaultDamageType;
    }
    if (this.item?.system.actionType === "heal" && !Object.keys(getSystemCONFIG().healingTypes).includes(this.defaultDamageType ?? "")) this.defaultDamageType = "healing";

    this.damageDetail = createDamageDetail({ roll: this.damageRoll, item: this.item, ammo: this.ammo, versatile: this.rollOptions.versatile, defaultType: this.defaultDamageType });

    const damageBonusMacros = this.getDamageBonusMacros();
    if (damageBonusMacros) {
      await this.rollBonusDamage(damageBonusMacros);
    }
    this.damageDetail = createDamageDetail({ roll: this.damageRoll, item: this.item, ammo: this.ammo, versatile: this.rollOptions.versatile, defaultType: this.defaultDamageType });
    this.otherDamageDetail = [];
    if (this.bonusDamageRoll) {
      const messageData = {
        flavor: this.bonusDamageFlavor,
        speaker: this.speaker
      }
      setProperty(messageData, `flags.${game.system.id}.roll.type`, "damage");
      this.bonusDamageRoll.toMessage(messageData);
    }
    expireMyEffects.bind(this)(["1Attack", "1Action", "1Spell"]);

    if (getAutoTarget(this.item) === "none" && this.item?.hasAreaTarget && !this.item.hasAttack) {
      // we are not auto targeting so for area effect attacks, without hits (e.g. fireball)
      this.targets = validTargetTokens(game.user?.targets);
      this.hitTargets = validTargetTokens(game.user?.targets);
      this.hitTargetsEC = new Set();
    }
    // apply damage to targets plus saves plus immunities
    if (this.isFumble) { //TODO: Is this right?
      return this.WorkflowState_RollFinished;
    }
    if (this.saveItem.hasSave) return this.WorkflowState_WaitForSaves
    return this.WorkflowState_AllRollsComplete;
  }

  async WorkflowState_RollFinished(context: any = {}): Promise<WorkflowState> {
    if (this.placeTemplateHookId) {
      Hooks.off("createMeasuredTemplate", this.placeTemplateHookId)
      Hooks.off("preCreateMeasuredTemplate", this.preCreateTemplateHookId)
    }
    super.WorkflowState_RollFinished().then(() => Workflow.removeWorkflow(this.item.uuid));
    return this.WorkflowState_Suspend;
  }
}

export class DummyWorkflow extends Workflow {
  //@ts-ignore dnd5e v10
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
      // const result = this.saveResults[0];
      result.saveAdvantage = result.options.advantageMode === 1;
      result.saveDisadvantage = result.options.advantageMode === -1;
      result.saveRoll = await new Roll(result.formula).roll({ async: true });
      const maxroll = (await result.saveRoll?.reroll({ maximize: true }))?.total;
      const minroll = (await result.saveRoll?.reroll({ minimize: true }))?.total;
      result.expectedSaveRoll = ((maxroll || 0) + (minroll || 0)) / 2;
      if (result.saveAdvantage) result.expectedSaveRoll += 3.325;
      if (result.saveDisadvantage) result.expectedSaveRoll -= 3.325;
      // this.simulatedSaveResults.push(result);
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
      this.attackRoll = await this.item?.rollAttack({ fastForward: true, chatMessage: false, isDummy: true })
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

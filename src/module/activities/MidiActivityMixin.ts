import { GameSystemConfig, MODULE_ID, SystemString, allAttackTypes, debugEnabled, i18n, i18nFormat, log, warn } from "../../midi-qol.js";
import { mapSpeedKeys } from "../MidiKeyManager.js";
import { Workflow } from "../Workflow.js";
import { TroubleShooter } from "../apps/TroubleShooter.js";
import { preTemplateTargets, selectTargets } from "../itemhandling.js";
import { checkMechanic, configSettings } from "../settings.js";
import { installedModules } from "../setupModules.js";
import { busyWait } from "../tests/setupTest.js";
import { saveUndoData } from "../undo.js";
import { activityHasAreaTarget, asyncHooksCall, canSee, canSense, checkActivityRange, checkIncapacitated, createConditionData, displayDSNForRoll, evalActivationCondition, evalCondition, getAutoRollAttack, getAutoRollDamage, getAutoTarget, getRemoveAttackButtons, getRemoveDamageButtons, getSpeaker, getStatusName, getToken, hasAutoPlaceTemplate, hasDAE, hasUsedBonusAction, hasUsedReaction, initializeVision, isAutoConsumeResource, isInCombat, itemIsVersatile, needsBonusActionCheck, needsReactionCheck, processDamageRollBonusFlags, setBonusActionUsed, setReactionUsed, sumRolls, tokenForActor, validTargetTokens } from "../utils.js";
import { confirmWorkflow, removeFlanking, setDamageRollMinTerms } from "./activityHelpers.js";

export var MidiActivityMixin = Base => {
  return class extends Base {
    _workflow: Workflow | undefined;
    get workflow() { return this._workflow; }
    set workflow(value) { this._workflow = value; }
    static LOCALIZATION_PREFIXES = [...super.LOCALIZATION_PREFIXES, "midi-qol.SHARED"];

    static defineSchema() {
      //@ts-expect-error
      const { StringField, BooleanField, ObjectField } = foundry.data.fields;
      const schema = {
        ...super.defineSchema(),
        // flags: new ObjectField(),
        useConditionText: new StringField({ name: "useCondition", initial: "" }),
        forceDialog: new BooleanField({ name: "forceDialog", initial: false }),
        effectConditionText: new StringField({ name: "effectCondition", initial: "" }),
      };
      return schema;
    }

    get isOtherActivityCompatible() { return false}
    
    get messageFlags() {
      const baseFlags = super.messageFlags;
      const targets = new Map();
      if (this.targets) {
        for (const token of this.targets) {
          const { name } = token;
          const { img, system, uuid } = token.actor ?? {};
          if (uuid) targets.set(uuid, { name, img, uuid, ac: system?.attributes?.ac?.value });
        }
        baseFlags.targets = Array.from(targets);
        // foundry.utils.setProperty(baseFlags, "roll.type", "usage");
      }
      return baseFlags;
    }

    async use(config: any = {}, dialog: any = {}, message: any = {}) {
      if (!this.item.isEmbedded) return;
      if (!this.item.isOwner) {
        ui.notifications?.error("DND5E.DocumentUseWarn", { localize: true });
      }
      if (debugEnabled > 0) warn("MidiQOL | AttackActivity | use | Called", config, dialog, message);

      if (config.systemCard) return super.use(config, dialog, message);
      let previousWorkflow = Workflow.getWorkflow(this.uuid);
      if (previousWorkflow) {
        if (!(await confirmWorkflow(previousWorkflow))) return;
      }
      await removeFlanking(this.item.parent);
      if (!config.midiOptions) config.midiOptions = {};
      if (!config.midiOptions.workflowOptions) config.midiOptions.workflowOptions = {};
      await this.setupTargets(config, dialog, message);
      await this.confirmTargets();
      // come back and see about re-rolling etc.
      if (true || !this.workflow) {
        this.workflow = new Workflow(this.actor, this, ChatMessage.getSpeaker({ actor: this.item.actor }), this.targets, config.midiOptions);
      }
      if (!await this.confirmCanProceed(config, dialog, message)) return;
      foundry.utils.setProperty(message, "data.flags.midi-qol.messageType", "attack");
      if (config.midiOptions?.configureDialog === false) dialog.configure = false;
      const results = await super.use(config, dialog, message);
      this.workflow.itemCardUuid = results.message.uuid;
      await this.workflow.performState(this.workflow.WorkflowState_Start, {});
      return results;
    }

    async rollDamage(config, dialog, message: any = {}) {
      if (!config.midiOptions) config.midiOptions = {};
      if (debugEnabled > 0) {
        warn("AttackActivity | rollDamage | Called", config, dialog, message);
      }
      let result: Roll[] | undefined;
      let otherResult: Roll[] | undefined;
      if (await asyncHooksCall("midi-qol.preDamageRoll", this.workflow) === false
        || await asyncHooksCall(`midi-qol.preDamageRoll.${this.item.uuid}`, this.workflow) === false
        || await asyncHooksCall(`midi-qol.preDamageRoll.${this.uuid}`, this.workflow) === false) {
        console.warn("midi-qol | Damage roll blocked via pre-hook");
        return;
      }
      if (this.hasDamage) {
        dialog.configure = !config.midiOptions.fastForwardDamage || this.forceDialog;
        Hooks.once("dnd5e.preRollDamageV2", (rollConfig, dialogConfig, messageConfig) => {
          delete rollConfig.event;
          return true;
        })

        message.create = false;
        result = await super.rollDamage(config, dialog, message);
        result = await this.postProcessDamageRoll(config, result);
        if (this.workflow && config.midiOptions.updateWorkflow !== false) await this.workflow.setDamageRolls(result);
      }
      if (this.otherActivity) {
        let shouldRollOther = true;
        if (this.otherCondition && this.workflow) {
          shouldRollOther = false;
          for (let token of this.workflow.hitTargets) {
            shouldRollOther ||= await evalActivationCondition(this.workflow, this.otherCondition, token, { async: true })
            if (shouldRollOther) break;
          }
        }
        if (shouldRollOther && this.otherActivity.hasDamage) {
          this.otherActivity.workflow = this.workflow;
          // Check conditions & flags
          const otherConfig = foundry.utils.deepClone(config);
          if (!foundry.utils.getProperty(this.item, "flags.midiProperties.critOther")) otherConfig.midiOptions.isCritical = false;
          otherConfig.midiOptions.updateWorkflow = false;
          foundry.utils.setProperty(otherConfig, "critical.allow", this.item.flags.midiProperties?.critOther);
          if (this.otherActivity?.hasDamage)
            otherResult = await this.otherActivity.rollDamage(otherConfig, dialog, { create: false });
          else if (this.otherActivity?.roll?.formula) {
            otherResult = await this.otherActivity.rollFormula(otherConfig, dialog, { create: false });
            if (otherResult) {
              if (!(otherResult instanceof Array)) otherResult = [otherResult];
              otherResult = otherResult.map(roll =>
                //@ts-expect-error
                new game.system.dice.DamageRoll(roll.formula, {}, {})
              );
            }
          }
          if (otherResult && config.midiOptions.updateWorkflow !== false && this.workflow) await this.workflow.setOtherDamageRolls(otherResult);
        }
      }
      if (config.midiOptions.updateWorkflow !== false && this.workflow?.suspended) this.workflow.unSuspend.bind(this.workflow)({ damageRoll: result, otherDamageRoll: otherResult });
      return result;
    }

    configureDamageRoll(config): void {
      const worklflow = this.workflow;
      //@ts-expect-error
      const DamageRoll = CONFIG.Dice.DamageRoll;
      try {
        const pressedKeys = globalThis.MidiKeyManager.pressedKeys; // record the key state if needed
        let workflow = this.workflow;
        if (!workflow) return config;

        if (workflow && config.midiOptions.systemCard) workflow.systemCard = true;
        if (workflow) {
          if (!workflow.shouldRollDamage) // if we did not auto roll then process any keys
            workflow.rollOptions = foundry.utils.mergeObject(workflow.rollOptions, mapSpeedKeys(pressedKeys, "damage", workflow.rollOptions?.rollToggle), { insertKeys: true, insertValues: true, overwrite: true });
          else
            workflow.rollOptions = foundry.utils.mergeObject(workflow.rollOptions, mapSpeedKeys({}, "damage", workflow.rollOptions?.rollToggle), { insertKeys: true, insertValues: true, overwrite: true });

        }
        //@ts-expect-error
        if (CONFIG.debug.keybindings) {
          log("itemhandling: workflow.rollOptions", workflow.rollOptions);
          log("item handling newOptions", mapSpeedKeys(globalThis.MidiKeyManager.pressedKeys, "attack", workflow.midiOptions?.rollToggle));
        }

        if (workflow.workflowType === "TrapWorkflow") workflow.rollOptions.fastForward = true;

        const midiFlags = workflow.actor.flags[MODULE_ID]
        if (workflow.currentAction !== workflow.WorkflowStaate_WaitForDamageRoll && workflow.noAutoAttack) {
          // TODO NW check this allow damage roll to go ahead if it's an ordinary roll
          workflow.currentAction = workflow.WorkflowState_WaitForDamageRoll;
        }

        if (workflow.currentAction !== workflow.WorkflowState_WaitForDamageRoll) {
          if (workflow.currentAction === workflow.WorkflowState_AwaitTemplate)
            return ui.notifications?.warn(i18n("midi-qol.noTemplateSeen"));
          else if (workflow.currentAction === workflow.WorkflowState_WaitForAttackRoll)
            return ui.notifications?.warn(i18n("midi-qol.noAttackRoll"));
        }

        if (workflow && (workflow.damageRollCount ?? 0) > 0) { // we are re-rolling the damage. redisplay the item card but remove the damage if the roll was finished
          workflow.displayChatCardWithoutDamageDetail();
        };

        workflow.processDamageEventOptions();

        // Allow overrides form the caller
        if (workflow && config.midiOptions.spellLevel) workflow.rollOptions.spellLevel = config.midiOptions.spellLevel;
        if (workflow && config.midiOptions.powerLevel) workflow.rollOptions.spellLevel = config.midiOptions.powerLevel;
        if (workflow && (workflow.isVersatile || config.midiOptions.versatile)) workflow.rollOptions.versatile = true;
        if (debugEnabled > 0) warn("rolling damage  ", this.name, this);

        if (workflow && config.midiOptions?.critical !== undefined) workflow.isCritical = config.midiOptions?.critical;
        config.midiOptions.fastForwardDamage = config.midiOptions.fastForwardDamage ?? workflow.workflowOptions?.fastForwardDamage ?? workflow.rollOptions.fastForwardDamage;

        if (workflow) workflow.damageRollCount += 1;
        let result: Array<Roll>;
        let result2: Array<Roll>;

      } catch (err) {
        const message = "Configure Damage Roll error";
        TroubleShooter.recordError(err, message);
        console.error(message, err);
      }
    }

    getDamageConfig(config: any = {}) {
      config.attackMode = this.workflow?.attackMode;
      config.ammunition = this.actor.items.get(this.workflow?.ammunition);
      const rollConfig = super.getDamageConfig(config);
      this.configureDamageRoll(rollConfig);
      for (let roll of rollConfig.rolls) {
        roll.options.isCritical ||= config.midiOptions.isCritical;
        roll.options.isFumble ||= config.midiOptions.isFumble;
      }
      return rollConfig;
    }

    async postProcessDamageRoll(config, result): Promise<Array<Roll>> {
      let result2: Array<Roll>;
      //@ts-expect-error
      const DamageRoll = CONFIG.Dice.DamageRoll;
      try {
        if (!this.workflow) return result;
        if (foundry.utils.getProperty(this.actor, `parent.flags.${MODULE_ID}.damage.advantage`)) {
          // TODO see if this is still possible
          // result2 = await wrapped(damageRollData)
        }
        let magicalDamage = this.item?.system.properties?.has("mgc") || this.item?.flags?.midiProperties?.magicdam;
        magicalDamage = magicalDamage || (configSettings.requireMagical === "off" && this.attackBonus > 0);
        magicalDamage = magicalDamage || (configSettings.requireMagical === "off" && (this.attack?.type.classification ?? "none") !== "weapon");
        magicalDamage = magicalDamage || (configSettings.requireMagical === "nonspell" && this.isSpell);

        if (result?.length > 0) {
          result.forEach(roll => {
            const droll: any = roll;
            if (!droll.options.properties) droll.options.properties = [];
            if (this.isSpell) droll.options.properties.push("spell");
            if (magicalDamage && !droll.options.properties.includes("mgc")) droll.options.properties.push("mgc");
            droll.options.properties.push(this.actionType)
          })
        }
        //@ts-expect-error .first
        const firstTarget = this.workflow.hitTargets.first() ?? this.workflow.targets?.first();
        const firstTargetActor = firstTarget?.actor;
        const targetMaxFlags = foundry.utils.getProperty(firstTargetActor, `flags.${MODULE_ID}.grants.max.damage`) ?? {};
        const maxFlags = foundry.utils.getProperty(this.workflow, `actor.flags.${MODULE_ID}.max`) ?? {};
        let needsMaxDamage = (maxFlags.damage?.all && await evalActivationCondition(this.workflow, maxFlags.damage.all, firstTarget, { async: true, errorReturn: false }))
          || (maxFlags.damage && maxFlags.damage[this.actionType] && await evalActivationCondition(this.workflow, maxFlags.damage[this.actionType], firstTarget, { async: true, errorReturn: false }));
        needsMaxDamage = needsMaxDamage || (
          (targetMaxFlags.all && await evalActivationCondition(this.workflow, targetMaxFlags.all, firstTarget, { async: true, errorReturn: false }))
          || (targetMaxFlags[this.actionType] && await evalActivationCondition(this.workflow, targetMaxFlags[this.actionType], firstTarget, { async: true, errorReturn: false })));
        const targetMinFlags = foundry.utils.getProperty(firstTargetActor, `flags.${MODULE_ID}.grants.min.damage`) ?? {};
        const minFlags = foundry.utils.getProperty(this.workflow, `actor.flags.${MODULE_ID}.min`) ?? {};
        let needsMinDamage = (minFlags.damage?.all && await evalActivationCondition(this.workflow, minFlags.damage.all, firstTarget, { async: true, errorReturn: false }))
          || (minFlags?.damage && minFlags.damage[this.actionType] && await evalActivationCondition(this.workflow, minFlags.damage[this.actionType], firstTarget, { async: true, errorReturn: false }));
        needsMinDamage = needsMinDamage || (
          (targetMinFlags.damage && await evalActivationCondition(this.workflow, targetMinFlags.all, firstTarget, { async: true, errorReturn: false }))
          || (targetMinFlags[this.actionType] && await evalActivationCondition(this.workflow, targetMinFlags[this.actionType], firstTarget, { async: true, errorReturn: false })));
        if (needsMaxDamage && needsMinDamage) {
          needsMaxDamage = false;
          needsMinDamage = false;
        }

        let actionFlavor;
        switch (game.system.id) {
          case "sw5e":
            actionFlavor = game.i18n.localize(this.actionType === "heal" ? "SW5E.Healing" : "SW5E.DamageRoll");
            break;
          case "n5e":
            actionFlavor = game.i18n.localize(this.actionType === "heal" ? "N5E.Healing" : "N5E.DamageRoll");
            break;
          case "dnd5e":
          default:
            actionFlavor = game.i18n.localize(this.actionType === "heal" ? "DND5E.Healing" : "DND5E.DamageRoll");
        }

        const title = `${this.name} - ${actionFlavor}`;
        const speaker = getSpeaker(this.actor);
        let flavor = title;
        if (this.item.labels.damages?.length > 0) {
          flavor = `${title} (${this.item.labels.damages.map(d => d.damageType)})`;
        }
        let messageData = foundry.utils.mergeObject({
          title,
          flavor,
          speaker,
        }, { "flags.dnd5e.roll": { type: "damage", itemId: this.item.id, itemUuid: this.item.uuid } });
        if (game.system.id === "sw5e") foundry.utils.setProperty(messageData, "flags.sw5e.roll", { type: "damage", itemId: this.item.id, itemUuid: this.item.uuid })
        if (needsMaxDamage) {
          for (let i = 0; i < result.length; i++) {
            result[i] = await result[i].reroll({ maximize: true });
          }
        } else if (needsMinDamage) {
          for (let i = 0; i < result.length; i++) {
            result[i] = await result[i].reroll({ minimize: true });
          }
        } else if (foundry.utils.getProperty(this, `parent.flags.${MODULE_ID}.damage.reroll-kh`) || foundry.utils.getProperty(this, `parent.flags.${MODULE_ID}.damage.reroll-kl`)) {
          let result2: Roll[] = [];
          for (let i = 0; i < result.length; i++) {
            result2.push(await result[i].reroll({ async: true }));
          }
          if ((foundry.utils.getProperty(this, `parent.flags.${MODULE_ID}.damage.reroll-kh`) && (sumRolls(result2) > sumRolls(result)))
            || (foundry.utils.getProperty(this, `parent.flags.${MODULE_ID}.damage.reroll-kl`) && (sumRolls(result2) < sumRolls(result)))) {
            [result, result2] = [result2, result];
          }
          // display roll not being used.
          if (this.workflow.workflowOptions?.damageRollDSN !== false) {
            let promises = result2.map(r => displayDSNForRoll(r, "damageRoll"));
            await Promise.all(promises);
          }
          DamageRoll.toMessage(result2, messageData, { rollMode: game.settings.get("core", "rollMode") });
          // await result2.toMessage(messageData, { rollMode: game.settings.get("core", "rollMode") });
        }
        setDamageRollMinTerms(result)

        if (this.actionType === "heal" && !Object.keys(GameSystemConfig.healingTypes).includes(this.workflow.defaultDamageType ?? "")) this.workflow.defaultDamageType = "healing";

        if (false && this.workflow?.workflowOptions?.damageRollDSN !== false) {
          let promises = result.map(r => displayDSNForRoll(r, "damageRoll"));
          await Promise.all(promises);
        }
        result = await processDamageRollBonusFlags.bind(this.workflow)(result);
        return result;
      } catch (err) {
        const message = `doDamageRoll error for item ${this?.name} ${this.uuid}`;
        TroubleShooter.recordError(err, message);
        throw err;
      }
    }

    async _prepareEffectContext(context) {
      context = await super._prepareEffectContext(context);

      let indexOffset = 0;
      if (context.activity.damage?.parts) {
        const scalingOptions = [
          { value: "", label: game.i18n.localize("DND5E.DAMAGE.Scaling.None") },
          //@ts-expect-error
          ...Object.entries(GameSystemConfig.damageScalingModes).map(([value, config]) => ({ value, label: config.label }))
        ];
        const types = Object.entries(GameSystemConfig.damageTypes).concat(Object.entries(GameSystemConfig.healingTypes));
        context.damageParts = context.activity.damage.parts.map((data, index) => {
          if (data.base) indexOffset--;
          const part = {
            data,
            fields: this.activity.schema.fields.damage.fields.parts.element.fields,
            prefix: `damage.parts.${index + indexOffset}.`,
            source: context.source.damage.parts[index + indexOffset] ?? data,
            canScale: this.activity.canScaleDamage,
            scalingOptions,
            typeOptions: types.map(([value, config]) => ({
              //@ts-expect-error
              value, label: config.label, selected: data.types.has(value)
            }))
          };
          return this._prepareDamagePartContext(context, part);
        })
      }
      if (debugEnabled > 0) {
        warn(("prepareEffectContext | context"), context);
      }
      return context;
    }

    async setupTargets(config, dialog, message): Promise<boolean> {
      if (((this.target?.affects.type ?? "") !== "") || configSettings.enforceSingleWeaponTarget) {
        //    if (!(await preTemplateTargets(this, {options}, pressedKeys)))
        if (!(await preTemplateTargets(this, { workflowOptions: config.midiOptions }, {})))
          return false;
        // TODO clean this up
        // if ((dialog.targets?.size ?? 0) === 0 && game.user?.targets) dialog.targets = game.user?.targets;
      }
      // Setup targets.
      let selfTarget = this.target?.affects.type === "self";
      if (!selfTarget) {
        if (dialog.targetsToUse) this.targets = dialog.targetsToUse;
        else this.targets = validTargetTokens(game.user?.targets);
      } else {
        foundry.utils.setProperty(dialog, "workflowOptions.targetConfirmation", "none");
        this.targets = new Set([tokenForActor(this.actor)]);
      }

      // remove selection of untargetable targets
      if (canvas?.scene) {
        //@ts-expect-error
        const tokensIdsToUse: Array<string> = Array.from(this.targets).map(t => t.id);
        game.user?.updateTokenTargets(tokensIdsToUse)
      }
      return true;
    }

    async confirmTargets(): Promise<void> {
      this.targets = game.user?.targets;
    }
    removeWorkflow() {
      if (this.workflow) Workflow.removeWorkflow(this.workflow.uuid);
      this.workflow = undefined;
      return false;
    }
    async confirmCanProceed(this: any, config, dialog, message): Promise<boolean> {
      if (debugEnabled > 0)
        warn("MidiQOL | confirmCanProceed | Called", this);
      const workflow = this.workflow;
      try {
        if (this.useCondition) {
          if (!(await evalActivationCondition(this.workflow, this.useCondition, this.targets.first(), { async: true }))) {
            ui.notifications?.warn("You are unable to use the item");
            return this.removeWorkflow();
          }
        }
        if (!config.midiOptions?.workflowOptions?.allowIncapacitated && checkMechanic("incapacitated")) {
          const condition = checkIncapacitated(this.actor, true);
          if (condition) {
            ui.notifications?.warn(`${this.actor.name} is ${getStatusName(condition)} and is incapacitated`)
            return this.removeWorkflow();
          }
        }
        let isEmanationTargeting = ["radius", "squaredRadius"].includes(this.target?.template?.type);
        let isAoETargeting = !isEmanationTargeting && activityHasAreaTarget(this);
        let selfTarget = this.target?.affects.type === "self";
        const inCombat = isInCombat(this.actor);
        const requiresTargets = configSettings.requiresTargets === "always" || (configSettings.requiresTargets === "combat" && inCombat);
        let speaker = getSpeaker(this.actor);

        // Call preTargeting hook/onUse macro. Create a dummy workflow if one does not already exist for the item
        let cancelWorkflow = await asyncHooksCall("midi-qol.preTargeting", workflow) === false
          || await asyncHooksCall(`midi-qol.preTargeting.${this.item.uuid}`, { item: this.item }) === false
          || await asyncHooksCall(`midi-qol.preTargeting.${this.uuid}`, { item: this.item }) === false;
        if (configSettings.allowUseMacro) {
          const results = await workflow.callMacros(this.item, workflow.onUseMacros?.getMacros("preTargeting"), "OnUse", "preTargeting");
          cancelWorkflow ||= results.some(i => i === false);
        }
        if (cancelWorkflow) return this.removeWorkflow();

        isEmanationTargeting = ["radius", "squaredRadius"].includes(this.target?.template?.type);

        let targetConfirmationHasRun = false; // Work out interaction with attack per target
        if ((!targetConfirmationHasRun && ((this.target?.affects.type ?? "") !== "") || configSettings.enforceSingleWeaponTarget)) {
          // TODO verify pressed keys below
          if (!(await preTemplateTargets(this, config.midiOptions, config.midiOptions.pressedKeys)))
            return this.removeWorkflow();
          if ((this.targets?.size ?? 0) === 0 && game.user?.targets) this.targets = game.user?.targets;
        }
        let shouldAllowRoll = !requiresTargets // we don't care about targets
          || (this.targets.size > 0) // there are some target selected
          || (this.target?.affects.type ?? "") === "" // no target required
          || selfTarget
          || isAoETargeting // area effect spell and we will auto target
          || isEmanationTargeting // range target and will autotarget
          || (!this.attack && !this.hasDamage && !this.hasSave); // does not do anything - need to chck dynamic effects

        // only allow attacks against at most the specified number of targets
        let allowedTargets;
        if (this.target?.affects.type === "creature" && this.target?.affects.count === "") //dnd5e 3.2
          allowedTargets = 9999;
        else
          allowedTargets = (this.target?.affects.type === "creature" ? this.target?.affects.count : 9999) ?? 9999;
        if (requiresTargets && configSettings.enforceSingleWeaponTarget && allAttackTypes.includes(this.actionType) && allowedTargets === 9999) {
          allowedTargets = 1;
          if (requiresTargets && this.targets.size !== 1) {
            ui.notifications?.warn(i18nFormat("midi-qol.wrongNumberTargets", { allowedTargets }));
            if (debugEnabled > 0) warn(`${game.user?.name} ${i18nFormat(`midi-qol.${MODULE_ID}.wrongNumberTargets`, { allowedTargets })}`)
            return this.removeWorkflow();
          }
        }

        if (requiresTargets && !isEmanationTargeting && !isAoETargeting && this.target?.affects.type === "creature" && this.targets.size === 0) {
          ui.notifications?.warn(i18n("midi-qol.noTargets"));
          if (debugEnabled > 0) warn(`${game.user?.name} attempted to roll with no targets selected`)
          return this.removeWorkflow();
        }

        let AoO = false;
        let activeCombatants = game.combats?.combats.map(combat => combat.combatant?.token?.id)
        const isTurn = activeCombatants?.includes(speaker.token);

        const checkReactionAOO = configSettings.recordAOO === "all" || (configSettings.recordAOO === this.actor.type)
        let thisUsesReaction = false;
        const hasReaction = hasUsedReaction(this.actor);
        if (!config.midiOptions.workflowOptions?.notReaction && ["reaction", "reactiondamage", "reactionmanual", "reactionpreattack"].includes(this.activation?.type) && (this.activation?.cost ?? 1) > 0) {
          thisUsesReaction = true;
        }
        if (!config.midiOptions.workflowOptions?.notReaction && checkReactionAOO && !thisUsesReaction && this.attack) {
          let activeCombatants = game.combats?.combats.map(combat => combat.combatant?.token?.id)
          const isTurn = activeCombatants?.includes(speaker.token)
          if (!isTurn && inCombat) {
            thisUsesReaction = true;
            AoO = true;
          }
        }

        // do pre roll checks
        if ((game.system.id === "dnd5e" || game.system.id === "n5e") && requiresTargets && this.targets.size > allowedTargets) {
          ui.notifications?.warn(i18nFormat("midi-qol.wrongNumberTargets", { allowedTargets }));
          if (debugEnabled > 0) warn(`${game.user?.name} ${i18nFormat(`midi-qol.${MODULE_ID}.wrongNumberTargets`, { allowedTargets })}`)
          return this.removeWorkflow();
        }
        let tokenToUse: Token | undefined;
        if (speaker.token) tokenToUse = canvas?.tokens?.get(speaker.token);
        const rangeDetails = checkActivityRange(this, tokenToUse, this.targets, checkMechanic("checkRange") !== "none")
        if (checkMechanic("checkRange") !== "none" && !isAoETargeting && !isEmanationTargeting && !AoO && speaker.token) {
          if (tokenToUse && this.targets.size > 0) {
            if (rangeDetails.result === "fail")
              return this.removeWorkflow();
            else {
              tokenToUse = rangeDetails.attackingToken;
            }
          }
        }
        if (this.item.type === "spell" && shouldAllowRoll) {
          const midiFlags = this.actor.flags[MODULE_ID];
          const needsVerbal = this.item.system.properties.has("vocal");
          const needsSomatic = this.item.system.properties.has("somatic");
          const needsMaterial = this.item.system.properties.has("material");
          //TODO Consider how to disable this check for DamageOnly workflows and trap workflows
          const conditionData = createConditionData({ actor: this.actor, activity: this });
          const notSpell = await evalCondition(midiFlags?.fail?.spell?.all, conditionData, { errorReturn: false, async: true });
          if (notSpell) {
            ui.notifications?.warn("You are unable to cast the spell");
            return this.removeWorkflow();
          }
          let notVerbal = await evalCondition(midiFlags?.fail?.spell?.verbal, conditionData, { errorReturn: false, async: true });
          if (notVerbal && needsVerbal) {
            ui.notifications?.warn("You make no sound and the spell fails");
            return this.removeWorkflow();
          }
          notVerbal = notVerbal || await evalCondition(midiFlags?.fail?.spell?.vocal, conditionData, { errorReturn: false, async: true });
          if (notVerbal && needsVerbal) {
            ui.notifications?.warn("You make no sound and the spell fails");
            return this.removeWorkflow();
          }
          const notSomatic = await evalCondition(midiFlags?.fail?.spell?.somatic, conditionData, { errorReturn: false, async: true });
          if (notSomatic && needsSomatic) {
            ui.notifications?.warn("You can't make the gestures and the spell fails");
            return this.removeWorkflow();
          }
          const notMaterial = await evalCondition(midiFlags?.fail?.spell?.material, conditionData, { errorReturn: false, async: true });
          if (notMaterial && needsMaterial) {
            ui.notifications?.warn("You can't use the material component and the spell fails");
            return this.removeWorkflow();
          }
        }
        if (!shouldAllowRoll) {
          return this.removeWorkflow();
        }
        /*
        let workflow: Workflow;
        let workflowClass = config?.midi?.workflowClass ?? globalthis.MidiQOL.workflowClass;
        if (!(workflowClass.prototype instanceof Workflow)) workflowClass = Workflow;
        workflow = new workflowClass(this.actor, this, speaker, targetsToUse, { event: config.event || options.event || event, pressedKeys, workflowOptions: options.workflowOptions });
        */
        workflow.inCombat = inCombat ?? false;
        workflow.isTurn = isTurn ?? false;
        workflow.AoO = AoO;
        workflow.config = config;
        workflow.attackingToken = tokenToUse;
        workflow.rangeDetails = rangeDetails;

        if (configSettings.undoWorkflow) await saveUndoData(workflow);

        // TODO see if this is needed still workflow.rollOptions.versatile = workflow.rollOptions.versatile || versatile || workflow.isVersatile;
        // if showing a full card we don't want to auto roll attacks or damage.
        workflow.noAutoDamage = config.midiOptions.systemCard;
        workflow.noAutoAttack = config.midiOptions.systemCard;
        const consume = this.consume;
        if (consume?.type === "ammo") {
          workflow.ammo = this.actor.items.get(consume.target);
        }

        workflow.reactionQueried = false;
        const blockReaction = thisUsesReaction && hasReaction && workflow.inCombat && needsReactionCheck(this.actor) && !config.midiOptions?.ammoSelector?.hasRun;
        if (blockReaction) {
          let shouldRoll = false;
          let d = await Dialog.confirm({
            title: i18n("midi-qol.EnforceReactions.Title"),
            content: i18n("midi-qol.EnforceReactions.Content"),
            yes: () => { shouldRoll = true },
          });
          if (!shouldRoll) {
            await workflow.performState(workflow.WorkflowState_Abort);
            return this.removeWorkflow(); // user aborted roll TODO should the workflow be deleted?
          }
        }

        const hasBonusAction = hasUsedBonusAction(this.actor);
        const itemUsesBonusAction = ["bonus"].includes(this.activation?.type);
        const blockBonus = workflow.inCombat && itemUsesBonusAction && hasBonusAction && needsBonusActionCheck(this.actor) && !config.midiOptions?.ammoSelector?.hasRun;
        if (blockBonus) {
          let shouldRoll = false;
          let d = await Dialog.confirm({
            title: i18n("midi-qol.EnforceBonusActions.Title"),
            content: i18n("midi-qol.EnforceBonusActions.Content"),
            yes: () => { shouldRoll = true },
          });
          if (!shouldRoll) {
            await workflow.performState(workflow.WorkflowState_Abort); // user aborted roll TODO should the workflow be deleted?
            return this.removeWorkflow();
          }
        }

        const hookAbort = await asyncHooksCall("midi-qol.preItemRoll", workflow) === false || await asyncHooksCall(`midi-qol.preItemRoll.${this.uuid}`, workflow) === false;
        if (hookAbort || workflow.aborted) {
          console.warn("midi-qol | attack roll blocked by preItemRoll hook");
          workflow.aborted = true;
          await workflow.performState(workflow.WorkflowState_Abort)
          return this.removeWorkflow();
        }
        if (configSettings.allowUseMacro) {
          const results = await workflow.callMacros(workflow.item, workflow.onUseMacros?.getMacros("preItemRoll"), "OnUse", "preItemRoll");
          if (workflow.aborted || results.some(i => i === false)) {
            console.warn("midi-qol | item roll blocked by preItemRoll macro");
            workflow.aborted = true;
            await workflow.performState(workflow.WorkflowState_Abort)
            return this.removeWorkflow();
          }
        }

        if (dialog.configure) { //TODO work out how to do auto consume now
          if (this.isSpell === "spell") {
            if (["both", "spell"].includes(isAutoConsumeResource(workflow))) { // && !workflow.rollOptions.fastForward) {
              dialog.configure = false;
              // Check that there is a spell slot of the right level
              const spells = this.actor.system.spells;
              // Come back and check for spell level in activities
              if (spells[`spell${this.system.level}`]?.value === 0 &&
                (spells.pact.value === 0 || spells.pact.level < this.system.level)) {
                dialog.configureDialog = true;
              }

              if (!dialog.configure && this.hasAreaTarget && this.actor?.sheet) {
                setTimeout(() => {
                  this.actor?.sheet.minimize();
                }, 100)
              }
            }
          } else dialog.configure = !(["both", "item"].includes(isAutoConsumeResource(workflow)));
        }

        let needPause = false;
        for (let tokenRef of this.targets) {
          const target = getToken(tokenRef);
          if (!target) continue;
          if (
            //@ts-expect-error - sight not enabled but we are treating it as if it is
            (!target.document.sight.enabled && configSettings.optionalRules.invisVision)
            || (target.document.actor?.type === "npc")
            //@ts-expect-error - sight enabled but not the owner of the token
            || (!target.isOwner && target.document.sight.enabled)
            || (!target.vision || !target.vision?.los)) {
            initializeVision(target);
            needPause = game.modules.get("levels-3d-preview")?.active ?? false;
          }
        }
        if (needPause) {
          await busyWait(0.1);
          for (let tokenRef of this.targets) {
            const target = getToken(tokenRef);
            if (!target || !target.vision?.los) continue;
            const sourceId = target.sourceId;
            //@ts-expect-error
            canvas?.effects?.visionSources.set(sourceId, target.vision);
          }
        }

        for (let tokenRef of this.targets) {
          const target = getToken(tokenRef);
          if (!target) continue;
          const tokenCanSense = tokenToUse ? canSense(tokenToUse, target, globalThis.MidiQOL.InvisibleDisadvantageVisionModes) : true;
          const targetCanSense = tokenToUse ? canSense(target, tokenToUse, globalThis.MidiQOL.InvisibleDisadvantageVisionModes) : true;
          if (targetCanSense) workflow.targetsCanSense.add(tokenToUse);
          else workflow.targetsCanSense.delete(tokenToUse);
          if (tokenCanSense) workflow.tokenCanSense.add(target);
          else workflow.tokenCanSense.delete(target);
          const tokenCanSee = tokenToUse ? canSee(tokenToUse, target) : true;
          const targetCanSee = tokenToUse ? canSee(target, tokenToUse) : true;
          if (targetCanSee) workflow.targetsCanSee.add(tokenToUse);
          else workflow.targetsCanSee.delete(tokenToUse);
          if (tokenCanSee) workflow.tokenCanSee.add(target);
          else workflow.tokenCanSee.delete(target);
        }
        workflow.processAttackEventOptions();
        await workflow.checkAttackAdvantage();
        workflow.showCard = true;
        const wrappedRollStart = Date.now();

        const autoCreatetemplate = tokenToUse && hasAutoPlaceTemplate(this);
        if (this.type === "spell" || this.type === "power") {
          workflow.castData = {
            baseLevel: this.system.level,
            castLevel: workflow.spellLevel,
            itemUuid: workflow.itemUuid
          };
        }

        if (autoCreatetemplate && tokenToUse) {
          const gs = canvas?.dimensions?.distance ?? 5;
          const templateOptions: any = {};
          // square templates don't respect the options distance field
          let item = this;
          let target = this.target ?? { value: 0 };
          const useSquare = false;
          const fudge = 0.1;
          //@ts-expect-error
          const { width, height } = tokenToUse.document;
          if (useSquare) {
            templateOptions.distance = target.value + fudge + Math.max(width, height, 0) * gs;
            item = item.clone({ "system.target.value": templateOptions.distance, "system.target.type": "square" })
          }
          else
            templateOptions.distance = Math.ceil(target.value + Math.max(width / 2, height / 2, 0) * (canvas?.dimensions?.distance ?? 0));

          if (useSquare) {
            const adjust = (templateOptions.distance ?? target.value) / 2;
            templateOptions.x = Math.floor((tokenToUse.center?.x ?? 0) - adjust / gs * (canvas?.dimensions?.size ?? 0));
            templateOptions.y = tokenToUse.center?.y ?? 0;
            if (game.settings.get("dnd5e", "gridAlignedSquareTemplates")) {
              templateOptions.y = Math.floor((tokenToUse.center?.y ?? 0) - adjust / gs * (canvas?.dimensions?.size ?? 0));
            }
          } else {
            templateOptions.x = tokenToUse.center?.x ?? 0;
            templateOptions.y = tokenToUse.center?.y ?? 0;
          }

          if (workflow?.actor) foundry.utils.setProperty(templateOptions, `flags.${MODULE_ID}.actorUuid`, workflow.actor.uuid);
          if (workflow?.tokenId) foundry.utils.setProperty(templateOptions, `flags.${MODULE_ID}.tokenId`, workflow.tokenId);
          if (workflow) foundry.utils.setProperty(templateOptions, `flags.${MODULE_ID}.workflowId`, workflow.id);
          foundry.utils.setProperty(templateOptions, `flags.${MODULE_ID}.itemUuid`, this.uuid);

          // @ts-expect-error .canvas
          let template = game.system.canvas.AbilityTemplate.fromItem(item, templateOptions);
          const templateData = template.document.toObject();
          if (this.item) foundry.utils.setProperty(templateData, `flags.${MODULE_ID}.itemUuid`, this.item.uuid);
          if (this.actor) foundry.utils.setProperty(templateData, `flags.${MODULE_ID}.actorUuid`, this.actor.uuid);
          if (!foundry.utils.getProperty(templateData, `flags.${game.system.id}.origin`)) foundry.utils.setProperty(templateData, `flags.${game.system.id}.origin`, this.item?.uuid);
          // @ts-expect-error
          const templateDocuments: MeasuredTemplateDocument[] | undefined = await canvas?.scene?.createEmbeddedDocuments("MeasuredTemplate", [templateData]);

          if (templateDocuments && templateDocuments.length > 0) {
            let td: MeasuredTemplateDocument = templateDocuments[0];
            await td.object?.refresh();
            await busyWait(0.01);
            workflow.templateUuid = td.uuid;
            workflow.template = td;
            workflow.templateId = td?.object?.id;
            if (tokenToUse && installedModules.get("walledtemplates") && this.flags?.walledtemplates?.attachToken === "caster") {
              // @ts-expect-error .object
              await tokenToUse.attachTemplate(td.object, { "flags.dae.stackable": "noneName" }, true);
              if (workflow && !foundry.utils.getProperty(workflow, "item.flags.walledtemplates.noAutotarget"))
                selectTargets.bind(workflow)(td);

            }
            else if (getAutoTarget(workflow?.item) !== "none") selectTargets.bind(workflow)(td);
          }
        }

        if (itemUsesBonusAction && !hasBonusAction && configSettings.enforceBonusActions !== "none" && workflow.inCombat) await setBonusActionUsed(this.actor);
        if (thisUsesReaction && !hasReaction && configSettings.enforceReactions !== "none" && workflow.inCombat) await setReactionUsed(this.actor);

        // Need concentration removal to complete before allowing workflow to continue so have workflow wait for item use to complete
      } catch (err) {
        const message = `doItemUse error for ${this.actor?.name} ${this.name} ${this.uuid}`;
        TroubleShooter.recordError(err, message);
        throw err;
      }
      return true;
    }

    async _usageChatContext(message) {
      const context = await super._usageChatContext(message);
      let systemCard = false;
      const minimalCard = false;
      const createMessage = true;

      if (systemCard === undefined) systemCard = false;
      if (debugEnabled > 0) warn("show item card ", this, this.actor, this.actor.token, systemCard, this.workflow);
      let token = tokenForActor(this.item.actor);
      let needAttackButton = !getRemoveAttackButtons(this.item) || configSettings.mergeCardMulti || configSettings.confirmAttackDamage !== "none" ||
        (!this.workflow?.someAutoRollEventKeySet() && !getAutoRollAttack(this.workflow) && !this.workflow?.midiOptions.autoRollAttack);
      const needDamagebutton = this.hasDamagae && (
        (["none", "saveOnly"].includes(getAutoRollDamage(this.workflow)) || this.workflow?.midiOptions?.rollToggle)
        || configSettings.confirmAttackDamage !== "none"
        || !getRemoveDamageButtons(this.item)
        || systemCard
        || configSettings.mergeCardMulti);
      const needVersatileButton = this.item.system.isVersatible && (systemCard || ["none", "saveOnly"].includes(getAutoRollDamage(this.workflow)) || !getRemoveDamageButtons(this.item));
      // not used const sceneId = token?.scene && token.scene.id || canvas?.scene?.id;
      const isPlayerOwned = this.item.actor?.hasPlayerOwner;
      const hideItemDetails = (["none", "cardOnly"].includes(configSettings.showItemDetails) || (configSettings.showItemDetails === "pc" && !isPlayerOwned))
        || !configSettings.itemTypeList?.includes(this.item.type);
      const hasEffects = !["applyNoButton", "applyRemove"].includes(configSettings.autoItemEffects) && this.workflow?.workflowType === "BaseWorkflow" && this.effects.find(ae => !ae.transfer && !foundry.utils.getProperty(ae, "flags.dae.dontApply"));
      let dmgBtnText = (this.actionType === "heal") ? i18n(`${SystemString}.Healing`) : i18n(`${SystemString}.Damage`);
      if (this.workflow?.midiOptions.fastForwardDamage && configSettings.showFastForward) dmgBtnText += ` ${i18n("midi-qol.fastForward")}`;
      let versaBtnText = i18n(`${SystemString}.Versatile`);
      if (this.workflow?.midiOptions.fastForwardDamage && configSettings.showFastForward) versaBtnText += ` ${i18n("midi-qol.fastForward")}`;

      let midiContextData = {
        // actor: this.item.actor,
        // token: this.item.actor?.token,
        // tokenId: token?.document?.uuid ?? token?.uuid ?? null, // v10 change tokenId is a token Uuid
        // tokenUuid: token?.document?.uuid ?? token?.uuid ?? null,
        hasButtons: true,
        // data: await this.item.system.getCardData(),
        labels: this.labels,
        //@ ts-expect-error TODO needed for abilities translation
        // config: game.system.config,
        condensed: configSettings.mergeCardCondensed,
        hasAttack: this.attack && !minimalCard && (systemCard || needAttackButton || configSettings.confirmAttackDamage !== "none"),
        isHealing: !minimalCard && this.item.isHealing && (systemCard || configSettings.autoRollDamage !== "always"),
        hasDamage: needDamagebutton,
        isVersatile: needVersatileButton,
        isSpell: this.isSpell,
        isPower: this.isPower,
        hasSave: !minimalCard && this.item.hasSave && (systemCard || configSettings.autoCheckSaves === "none"),
        hasAreaTarget: !minimalCard && activityHasAreaTarget(this),
        hasAttackRoll: !minimalCard && this.item.hasAttack,
        hasPlaceSummons: !minimalCard && this.summon?.prompt === false,
        configSettings,
        hideItemDetails,
        dmgBtnText,
        versaBtnText,
        showProperties: this.workflow?.workflowType === "BaseWorkflow",
        hasEffects,
        effects: this.item.effects,
        isMerge: true,
        mergeCardMulti: configSettings.mergeCardMulti && (this.item.hasAttack || this.item.hasDamage),
        confirmAttackDamage: configSettings.confirmAttackDamage !== "none" && (this.item.hasAttack || this.item.hasDamage),
        RequiredMaterials: i18n(`${SystemString}.RequiredMaterials`),
        Attack: i18n(`${SystemString}.Attack`),
        SavingThrow: i18n(`${SystemString}.SavingThrow`),
        OtherFormula: i18n(`${SystemString}.OtherFormula`),
        PlaceTemplate: i18n(`${SystemString}.TARGET.Action.PlaceTemplate`),
        PlaceSummons: i18n(`${SystemString}.SUMMON.Action.Place`),
        Use: i18n(`${SystemString}.Use`),
        canCancel: configSettings.undoWorkflow // TODO enable this when more testing done.
      };
      return foundry.utils.mergeObject(context, midiContextData)
    }

    get otherActivity(): any {
      return undefined;
    }

    get useCondition() {
      if (this.useConditionText && this.useConditionText !== "") return this.useConditionText;
      return foundry.utils.getProperty(this.item, "flags.midi-qol.itemCondition") ?? "";
    }

    get effectCondition() {
      if (this.effectConditionText && this.effectConditionText !== "") return this.effectConditionText;
      return foundry.utils.getProperty(this.item, "flags.midi-qol.effectCondition") ?? "";
    }

    get reactionCondition() {
      if (this.useCondition && this.useCondition !== "") return this.useCondition;
      return foundry.utils.getProperty(this.item, "flags.midi-qol.reactionCondition") ?? "";
    }

    get otherCondition() {
      if (this.otherActivity && this.otherActivity?.useCondition !== "") return this.otherActivity.useCondition;
      return foundry.utils.getProperty(this.item, "flags.midi-qol.otherCondition") ?? "";
    }

    get hasDamage() {
      return this.damage?.parts.length > 0;
    }

  }
}

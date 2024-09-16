export function defineMidiAttackActivityClass(baseClass: any) {
  return class MidiAttackActivity extends baseClass {
    async rollAttack(config, dialog, message) {
      console.error("MidiQOL | AttackActivity | rollAttack | Called", config, dialog, message);
      return super.rollAttack(config, dialog, message);
    }

    async rollDamage({ event, ammunition, attackMode }) {
      console.error("MidiQOL | AttackActivity | rollDamage | Called", event, ammunition, attackMode);
      return super.rollDamage({ event, ammunition, attackMode });
    }
    async use(usage, dialog, message) {
      console.error("MidiQOL | AttackActivity | use | Called", usage, dialog, message);
      return super.use(usage, dialog, message);
    }
  }
}
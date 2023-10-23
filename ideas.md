Fix maxDamaage flag to work again
* new sample item Antimagic Field
  - require Effect Macro and Active Auras
  - Will disable passive effects which originated from spells or items marked as magical effect in the midi properties.
  - Spells cast within the field will fail but consume the spell slot
  - Damage from spells/magical items will do no damage.
  - Effects applied by spells cast at the target will fail.
  - Effects applied to a target by an item marked as magical effect will fail.
  - Creatures with the custom type of Summoned will be marked hidden when inside the field.
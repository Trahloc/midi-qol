//@ts-expect-error
const ActivityChoiceDialog = dnd5e.applications?.activity?.ActivityChoiceDialog;
export class MidiActivityChoiceDialog extends ActivityChoiceDialog {
  static get defaultOptions() {
    return super.getDefaultOptions();
  }
  async _prepareContext(options) {
    let controlHint;
    if ( game.settings.get("dnd5e", "controlHints") ) {
      controlHint = game.i18n.localize("DND5E.Controls.Activity.FastForwardHint");
      controlHint = controlHint.replace(
        "<left-click>",
        `<img src="systems/dnd5e/icons/svg/mouse-left.svg" alt="${game.i18n.localize("DND5E.Controls.LeftClick")}">`
      );
    }
    const activities = this.item.system.activities
      .filter(a => !this.item.getFlag("dnd5e", "riders.activity")?.includes(a.id))
      .filter(a => !a.midiProperties?.automationOnly)
      .map(this._prepareActivityContext.bind(this))
      .sort((a, b) => a.sort - b.sort);
    return {
      ...await super._prepareContext(options),
      controlHint, 
      activities
    };
  }
}
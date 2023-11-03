
import * as Blockly from 'blockly';

/**
 * 
 */
export class CustomBlock {
  /**
   * 
   * @param {!String} name 
   * @param {!String} category 
   * @param {!Object} definition 
   * @param {String} kind 
   */
  _kind: string;
  _localisationPrefix: string;
  _category: string;
  _key: string;
  _definition: object;


  constructor(name, category, options = { kind: "block", localisationPrefix: "midi-qol.blocks" }) {
      this._kind = options.kind;
      this._localisationPrefix = options.localisationPrefix;
      this._category = category;
      this._key = `${this._category}.${name}`;
      this._definition = globalThis.libBlockly.getDefinition(this._key);
      if (!this._definition) throw Error(`Custom block defnition not found: ${this._key}`);
  }

  /**
   * 
   */
  get kind() { return this._kind; }

  /**
   * 
   */
  get category() { return this._category; }

  /**
   * 
   */
  get key() { return this._key; }

  /**
   * 
   * @returns 
   */
  init() {
      return mergeObject({
          "colour": game.i18n.localize(`${this._localisationPrefix}.${this._key}.Colour`),
          "tooltip": game.i18n.localize(`${this._localisationPrefix}.${this._key}.Tooltip`),
          "helpUrl": game.i18n.localize(`${this._localisationPrefix}.${this._key}.HelpUrl`),
          "message0": game.i18n.localize(`${this._localisationPrefix}.${this._key}.Title`),
          "inputsInline": false,
      }, this._definition);
  }

  /**
   * 
   * @param {!BlockSvg} block 
   * @returns 
   */
  generateCode(block): string | undefined {
      return undefined;
  }
}

const blocksDefinition = function () {
  return {
    "Foundry.Item.Use": {
      "args0": [
        {
          type: "input_value",
          name: "item",
          check: ["Item"]
        },
        {
          type: "input_value",
          name: "options",
          check: ["Object"]
        }
      ],
      output: ["void"],
    }
  }
}

export class ItemUseCustomBlock extends CustomBlock {
  constructor() {
      super("Use", "Foundry.Item");
  }

  generateCode(block) {
    const value_item = Blockly.JavaScript.valueToCode(block, 'item', Blockly.JavaScript.ORDER_ATOMIC);
    const value_options = Blockly.JavaScript.valueToCode(block, 'options', Blockly.JavaScript.ORDER_ATOMIC);
    const useItem = Blockly.JavaScript.provideFunction_(`${this.key}_use_item`, [
      `async function ${Blockly.JavaScript.FUNCTION_NAME_PLACEHOLDER_}(item, options) {`,
      `  if (!item) return;`,
      `  if (item instanceof Item) return await item.use({}, options);`,
      `}`
    ]);
    return `await ${useItem}(${value_item}, ${value_options});\n`;
  }
}


export function setupBlocklyHooks () {
  console.error("midi-qol | libBlockly", globalThis.libBlockly);
  return;
  globalThis.libBlockly = globalThis.libBlockly.registerDefinition(blocksDefinition());
  globalThis.libBlockly = globalThis.libBlockly.registerBlockTypes([
    new ItemUseCustomBlock()
  ]);
};
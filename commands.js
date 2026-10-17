'use strict';

const fs = require('node:fs');

/**
 * Chat command plumbing for the fisher.
 *
 * Two small pieces, both independent of the bot itself so they are easy to extend and test:
 *
 * - {@link SettingsRegistry}: the list of config keys that may be changed from chat. Each one has a
 *   type (parsing + validation), a description, and an optional `apply` hook that runs when the value
 *   changes. Adding a new chat-configurable setting is one `define()` call.
 * - {@link CommandRouter}: maps `<prefix>name args...` to handlers. Adding a command is one `register()` call.
 *
 * {@link registerBuiltinCommands} wires the generic commands (help, settings, get, set, save and a
 * shortcut command per setting such as `^mode`). Bot-specific commands (like `status`) are registered
 * from index.js with the same `register()` call.
 */

/** A mistake by the person typing the command. The message is sent back to chat as-is. */
class CommandError extends Error {}

/** Setting types. Each has `parse(raw)` (returns the value or throws {@link CommandError}) and `describe()`. */
const settingTypes = Object.freeze({
  /**
   * @param {string[]} values Allowed values (compared case-insensitively, stored lowercase).
   */
  enum(values) {
    return {
      describe: () => values.join('|'),
      parse(raw) {
        const value = String(raw).trim().toLowerCase();
        if (!values.includes(value)) {
          throw new CommandError(`Must be one of: ${values.join(', ')}.`);
        }
        return value;
      }
    };
  },

  boolean() {
    const yes = ['true', 'on', 'yes', 'y', '1'];
    const no = ['false', 'off', 'no', 'n', '0'];
    return {
      describe: () => 'on|off',
      parse(raw) {
        const value = String(raw).trim().toLowerCase();
        if (yes.includes(value)) return true;
        if (no.includes(value)) return false;
        throw new CommandError('Must be on or off.');
      }
    };
  },

  /**
   * @param {{min?: number, max?: number, integer?: boolean}} [options] Bounds and integer-only flag.
   */
  number({ min = -Infinity, max = Infinity, integer = false } = {}) {
    const range = [Number.isFinite(min) ? `>= ${min}` : null, Number.isFinite(max) ? `<= ${max}` : null].filter(Boolean).join(' and ');
    return {
      describe: () => `${integer ? 'integer' : 'number'}${range ? ` ${range}` : ''}`,
      parse(raw) {
        const text = String(raw).trim();
        const value = Number(text);
        if (text === '' || !Number.isFinite(value)) throw new CommandError('Must be a number.');
        if (integer && !Number.isInteger(value)) throw new CommandError('Must be a whole number.');
        if (value < min || value > max) throw new CommandError(`Must be ${range}.`);
        return value;
      }
    };
  }
});

/** Formats a setting value for chat. */
function formatValue(value) {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return String(value);
}

/**
 * The set of config keys that can be read and changed from chat.
 *
 * Values live on the same `config` object the bot reads, so a change takes effect immediately.
 * Changes are runtime-only until `save()` writes them back to config.json.
 */
class SettingsRegistry {
  /**
   * @param {object} config The live bot config object (mutated in place).
   */
  constructor(config) {
    this.config = config;
    this.defs = new Map();
    this.dirty = new Set();
  }

  /**
   * Registers a chat-configurable setting.
   *
   * @param {object} def
   * @param {string} def.key Key in config.json.
   * @param {{parse: Function, describe: Function}} def.type One of {@link settingTypes}.
   * @param {string} def.description One line shown by `settings`/`get`.
   * @param {(value: *, previous: *) => void} [def.apply] Runs after the value changes. Throw to reject the change.
   * @param {() => *} [def.read] For values that don't live at `config[key]`: returns the current value.
   * @param {(value: *) => void} [def.write] For such values: stores a new one (replaces the plain `config[key] = value`).
   * @param {(onDisk: object, value: *) => void} [def.persist] For such values: puts the value into the parsed config.json object on `save`.
   * @returns {SettingsRegistry} this, for chaining.
   */
  define({ key, type, description, apply, read, write, persist }) {
    if (this.defs.has(key)) {
      throw new Error(`Setting ${key} is already defined.`);
    }

    this.defs.set(key, { key, type, description, apply, read, write, persist });
    return this;
  }

  /** Current value of a setting. */
  read(def) {
    return def.read ? def.read() : this.config[def.key];
  }

  /** Stores a value for a setting. */
  write(def, value) {
    if (def.write) {
      def.write(value);
    } else {
      this.config[def.key] = value;
    }
  }

  keys() {
    return [...this.defs.keys()];
  }

  /** Finds a setting by key (case-insensitive) or throws a {@link CommandError}. */
  lookup(key) {
    const wanted = String(key ?? '').toLowerCase();
    const def = [...this.defs.values()].find((candidate) => candidate.key.toLowerCase() === wanted);
    if (!def) {
      throw new CommandError(`Unknown setting "${key}". Known: ${this.keys().join(', ')}`);
    }

    return def;
  }

  get(key) {
    const def = this.lookup(key);
    return { def, value: this.read(def) };
  }

  /**
   * Parses and applies a new value.
   *
   * @param {string} key Setting key.
   * @param {string} raw Raw text from chat.
   * @returns {{def: object, previous: *, value: *, changed: boolean}} Result.
   */
  set(key, raw) {
    const def = this.lookup(key);
    const value = def.type.parse(raw);
    const previous = this.read(def);

    if (Object.is(previous, value)) {
      return { def, previous, value, changed: false };
    }

    this.write(def, value);

    try {
      def.apply?.(value, previous);
    } catch (error) {
      this.write(def, previous);
      throw error instanceof CommandError ? error : new CommandError(`Could not apply ${def.key}: ${error.message}`);
    }

    this.dirty.add(def.key);
    return { def, previous, value, changed: true };
  }

  /**
   * Writes every setting changed from chat back into config.json, leaving all other keys untouched.
   *
   * @param {string} configPath Path to config.json.
   * @returns {string[]} The keys that were written.
   */
  save(configPath) {
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const keys = [...this.dirty];

    for (const key of keys) {
      const def = this.defs.get(key);
      if (def.persist) {
        def.persist(onDisk, this.read(def));
      } else {
        onDisk[key] = this.config[key];
      }
    }

    fs.writeFileSync(configPath, `${JSON.stringify(onDisk, null, 2)}\n`);
    this.dirty.clear();
    return keys;
  }
}

/** Text packet types that can carry a chat line (addons like Paradox re-send chat as raw/json). */
const CHAT_PACKET_TYPES = new Set(['chat', 'whisper', 'announcement', 'raw', 'system', 'json', 'json_whisper', 'json_announcement', 'translation']);

/** Flattens a Bedrock rawtext/tellraw JSON node (`{rawtext: [...]}`, `{text}`, `{translate, with}`) into plain text. */
function flattenRawText(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(flattenRawText).join('');
  if (typeof node !== 'object') return String(node);

  let out = '';
  if (typeof node.text === 'string') out += node.text;
  if (node.rawtext) out += flattenRawText(node.rawtext);
  if (node.translate) {
    const parts = Array.isArray(node.with) ? node.with : (node.with?.rawtext ?? []);
    out += [node.translate, ...parts.map(flattenRawText)].join(' ');
  }

  return out;
}

/**
 * Plain text of a chat-like `text` packet: JSON/rawtext flattened, `§` formatting codes removed.
 * Returns null for packets that can't be chat (popups, tips, ...).
 *
 * @param {object} packet Parsed `text` packet.
 * @returns {string|null} Plain text.
 */
function chatPacketText(packet) {
  if (!packet || !CHAT_PACKET_TYPES.has(packet.type) || typeof packet.message !== 'string') {
    return null;
  }

  let text = packet.message;
  const trimmed = text.trim();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      text = flattenRawText(JSON.parse(trimmed));
    } catch {
      // Not JSON after all; use the message as sent.
    }
  }

  if (packet.type === 'translation' && Array.isArray(packet.parameters)) {
    text = [text, ...packet.parameters].join(' ');
  }

  return text.replace(/§./g, '').trim();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Maps `<prefix>name args...` chat messages to handlers. */
class CommandRouter {
  /**
   * @param {string} prefix Command prefix, e.g. `^`.
   */
  constructor(prefix) {
    this.prefix = prefix;
    this.commands = new Map();
    this.names = new Map();
  }

  /**
   * Registers a command.
   *
   * `run(args, ctx)` receives the whitespace-split arguments and the context passed to `dispatch`
   * (the bot adds `{ sender }`). It may return a string or an array of lines to reply with, and may
   * throw {@link CommandError} to send a message back to the player.
   *
   * @param {object} command
   * @param {string} command.name Command name (case-insensitive).
   * @param {string[]} [command.aliases] Extra names.
   * @param {string} [command.usage] Argument synopsis, e.g. `<setting> <value>`.
   * @param {string} command.description One line for `help`.
   * @param {(args: string[], ctx: object) => (string|string[]|void|Promise<string|string[]|void>)} command.run Handler.
   * @returns {CommandRouter} this, for chaining.
   */
  register(command) {
    const entry = { aliases: [], usage: '', ...command };

    for (const name of [entry.name, ...entry.aliases].map((value) => value.toLowerCase())) {
      if (this.names.has(name)) {
        throw new Error(`Command ${name} is already registered.`);
      }

      this.names.set(name, entry);
    }

    this.commands.set(entry.name.toLowerCase(), entry);
    return this;
  }

  /** True when a chat message looks like a command for this router. */
  isCommand(text) {
    return typeof text === 'string' && text.startsWith(this.prefix) && text.trim().length > this.prefix.length;
  }

  /**
   * Finds a command anywhere in a line of chat, so rank/name prefixes added by chat addons
   * (`[Member] Moo » ^mode auto`) don't matter. Only registered command names match, and the prefix
   * must not be glued to a preceding letter or digit.
   *
   * @param {string} text Plain chat text.
   * @returns {string|null} The command (prefix included, through the end of the line), or null.
   */
  extract(text) {
    if (typeof text !== 'string') return null;

    const names = [...this.names.keys()].map(escapeRegExp).sort((a, b) => b.length - a.length);
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(this.prefix)}(?:${names.join('|')})(?![\\p{L}\\p{N}_])[^\\r\\n]*`, 'iu');
    const match = pattern.exec(text);
    if (!match) return null;

    // Chat addons sometimes wrap the player's text in quotes (`[Server] "^status"`): drop an unpaired closing quote.
    let command = match[0].trim();
    for (const quote of ['"', "'", '”', '’']) {
      if (command.endsWith(quote) && command.split(quote).length % 2 === 0) {
        command = command.slice(0, -1).trimEnd();
      }
    }

    return command;
  }

  /** `^name <usage>` for help and error messages. */
  usageOf(command) {
    return `${this.prefix}${command.name}${command.usage ? ` ${command.usage}` : ''}`;
  }

  /**
   * Runs a command message.
   *
   * @param {string} text Full chat message including the prefix.
   * @param {object} [ctx] Context handed to the handler.
   * @returns {Promise<string[]>} Lines to reply with (possibly empty).
   */
  async dispatch(text, ctx = {}) {
    const [rawName, ...args] = text.trim().slice(this.prefix.length).trim().split(/\s+/);
    const command = this.names.get(rawName.toLowerCase());

    if (!command) {
      return [`Unknown command "${rawName}". Try ${this.prefix}help`];
    }

    try {
      const output = await command.run(args, ctx);
      return output === undefined || output === null ? [] : [].concat(output);
    } catch (error) {
      if (error instanceof CommandError) {
        return [error.message];
      }

      throw error;
    }
  }
}

/**
 * Registers the generic commands: help, settings, get, set, save, plus one shortcut command per
 * entry in `shortcuts` (`^mode` -> show, `^mode auto` -> set).
 *
 * @param {CommandRouter} router Router to add to.
 * @param {SettingsRegistry} settings Settings the commands operate on.
 * @param {{configPath: string, shortcuts?: string[]}} options config.json path for `save`, and settings to give their own command.
 */
function registerBuiltinCommands(router, settings, { configPath, shortcuts = [] }) {
  const p = router.prefix;

  const show = (key) => {
    const { def, value } = settings.get(key);
    return `${def.key} = ${formatValue(value)} (${def.type.describe()}) - ${def.description}`;
  };

  const change = (key, raw) => {
    const { def, previous, value, changed } = settings.set(key, raw);
    return changed
      ? `${def.key}: ${formatValue(previous)} -> ${formatValue(value)}. ${p}save keeps it after a restart.`
      : `${def.key} is already ${formatValue(value)}.`;
  };

  router.register({
    name: 'help',
    aliases: ['?'],
    usage: '[command]',
    description: 'List commands, or show one command',
    run: ([name]) => {
      if (name) {
        const command = router.names.get(name.replace(p, '').toLowerCase());
        if (!command) throw new CommandError(`No command "${name}".`);
        return `${router.usageOf(command)} - ${command.description}`;
      }

      return [...router.commands.values()].map((command) => `${router.usageOf(command)} - ${command.description}`);
    }
  });

  router.register({
    name: 'settings',
    aliases: ['list'],
    description: 'List every setting you can change from chat',
    run: () => settings.keys().map((key) => `${key} = ${formatValue(settings.get(key).value)}`)
  });

  router.register({
    name: 'get',
    usage: '<setting>',
    description: 'Show a setting, what it accepts and what it does',
    run: ([key]) => {
      if (!key) throw new CommandError(`Usage: ${p}get <setting>`);
      return show(key);
    }
  });

  router.register({
    name: 'set',
    usage: '<setting> <value>',
    description: 'Change a setting (until restart unless you also save)',
    run: ([key, ...rest]) => {
      if (!key || rest.length === 0) throw new CommandError(`Usage: ${p}set <setting> <value>`);
      return change(key, rest.join(' '));
    }
  });

  router.register({
    name: 'save',
    description: 'Write the settings changed from chat into config.json',
    run: () => {
      const saved = settings.save(configPath);
      return saved.length ? `Saved to config.json: ${saved.join(', ')}` : 'Nothing to save.';
    }
  });

  for (const key of shortcuts) {
    const { def } = settings.get(key);
    router.register({
      name: def.key,
      usage: `[${def.type.describe()}]`,
      description: `Show or set ${def.key}: ${def.description}`,
      run: ([value]) => (value === undefined ? show(def.key) : change(def.key, value))
    });
  }
}

module.exports = { CommandError, CommandRouter, SettingsRegistry, settingTypes, registerBuiltinCommands, chatPacketText };

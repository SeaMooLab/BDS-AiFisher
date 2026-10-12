'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = Object.freeze({ error: 0, warn: 1, info: 2, verbose: 3, trace: 4 });

/**
 * Inbound packets that are pure world/entity noise. They are only logged at `trace` level.
 */
const NOISY_PACKETS = new Set([
  'level_chunk', 'subchunk', 'network_chunk_publisher_update', 'update_block', 'update_subchunk_blocks',
  'block_entity_data', 'biome_definition_list', 'available_entity_identifiers', 'creative_content',
  'crafting_data', 'item_registry', 'available_commands', 'player_list', 'move_entity', 'move_entity_delta',
  'set_entity_motion', 'update_attributes', 'level_sound_event', 'level_event', 'level_event_generic',
  'set_time', 'set_entity_data', 'mob_armor_equipment', 'add_player', 'remove_entity', 'animate',
  'mob_equipment', 'add_actor', 'entity_event', 'add_entity', 'add_item_entity', 'take_item_entity',
  'player_skin', 'set_entity_link', 'camera_presets', 'unlocked_recipes', 'trim_data', 'resource_packs_info',
  'resource_pack_stack', 'sync_entity_property', 'client_cache_miss_response', 'update_abilities',
  'update_adventure_settings', 'set_health', 'set_score', 'set_display_objective', 'boss_event',
  'spawn_particle_effect', 'play_sound', 'stop_sound', 'set_last_hurt_by', 'motion_prediction_hints',
  'current_structure_feature', 'jigsaw_structure_data', 'server_stats', 'set_movement_authority'
]);

/**
 * JSON.stringify replacer that prints bigints and abbreviates binary buffers.
 *
 * @param {string} key Property name.
 * @param {*} value Property value.
 * @returns {*} JSON-safe value.
 */
function jsonReplacer(key, value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
    return `<Buffer ${value.data.length} bytes>`;
  }

  if (value instanceof Uint8Array) {
    return `<Buffer ${value.length} bytes>`;
  }

  return value;
}

/**
 * Serializes any packet payload for logging.
 *
 * @param {*} value Payload to print.
 * @param {number} [maxLength=Infinity] Truncate output past this many characters.
 * @returns {string} Printable JSON.
 */
function stringify(value, maxLength = Infinity) {
  let text;
  try {
    text = JSON.stringify(value, jsonReplacer);
  } catch (error) {
    text = `<unserializable: ${error.message}>`;
  }

  if (text === undefined) {
    return String(value);
  }

  return text.length > maxLength ? `${text.slice(0, maxLength)}... (+${text.length - maxLength} chars)` : text;
}

/**
 * Leveled console + file logger with packet tracing helpers.
 *
 * Levels, quietest to loudest: `error`, `warn`, `info`, `verbose`, `trace`.
 * - `verbose` logs every sent packet (except idle heartbeats) and every received packet that is not world noise, truncated.
 * - `trace` logs everything, untruncated, including every heartbeat. Expect a huge log.
 */
class Logger {
  /**
   * Creates a logger.
   *
   * @param {{level?: string, file?: string|null, baseDir?: string}} [options] Level name and optional log file path.
   */
  constructor({ level = 'info', file = null, baseDir = process.cwd() } = {}) {
    if (!(level in LEVELS)) {
      throw new Error(`logLevel must be one of: ${Object.keys(LEVELS).join(', ')}`);
    }

    this.levelName = level;
    this.level = LEVELS[level];
    this.stream = null;
    this.filePath = null;

    if (file) {
      this.filePath = path.resolve(baseDir, file);
      this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
      this.stream.on('error', (error) => {
        console.error(`[LOG] Could not write ${this.filePath}: ${error.message}`);
        this.stream = null;
      });
    }
  }

  /**
   * Returns true when messages at the given level will be emitted.
   *
   * @param {string} level Level name.
   * @returns {boolean} Whether the level is enabled.
   */
  enabled(level) {
    return LEVELS[level] <= this.level;
  }

  /**
   * Writes a line to the console and the log file.
   *
   * @param {string} level Level name.
   * @param {string} tag Short subsystem tag such as `FISH` or `BOT`.
   * @param {string} message Message text.
   */
  write(level, tag, message) {
    if (!this.enabled(level)) {
      return;
    }

    const time = new Date().toISOString().slice(11, 23);
    const line = `${time} ${level.toUpperCase().padEnd(7)} [${tag}] ${message}`;

    if (level === 'error' || level === 'warn') {
      console.error(line);
    } else {
      console.log(line);
    }

    this.stream?.write(`${line}\n`);
  }

  /** @param {string} tag Subsystem tag. @param {string} message Message text. */
  error(tag, message) {
    this.write('error', tag, message);
  }

  /** @param {string} tag Subsystem tag. @param {string} message Message text. */
  warn(tag, message) {
    this.write('warn', tag, message);
  }

  /** @param {string} tag Subsystem tag. @param {string} message Message text. */
  info(tag, message) {
    this.write('info', tag, message);
  }

  /** @param {string} tag Subsystem tag. @param {string} message Message text. */
  verbose(tag, message) {
    this.write('verbose', tag, message);
  }

  /** @param {string} tag Subsystem tag. @param {string} message Message text. */
  trace(tag, message) {
    this.write('trace', tag, message);
  }

  /**
   * Logs a packet received from the server. Noise packets only appear at `trace`.
   *
   * @param {string} name Packet name.
   * @param {object} params Decoded packet fields.
   */
  packetIn(name, params) {
    if (this.enabled('trace')) {
      this.trace('S->C', `${name} ${stringify(params)}`);
      return;
    }

    if (this.enabled('verbose') && !NOISY_PACKETS.has(name)) {
      this.verbose('S->C', `${name} ${stringify(params, 800)}`);
    }
  }

  /**
   * Logs a packet sent to the server.
   *
   * @param {string} name Packet name.
   * @param {object} params Packet fields.
   * @param {boolean} [routine=false] True for high-frequency packets that only belong in `trace`.
   */
  packetOut(name, params, routine = false) {
    if (this.enabled('trace')) {
      this.trace('C->S', `${name} ${stringify(params)}`);
      return;
    }

    if (!routine && this.enabled('verbose')) {
      this.verbose('C->S', `${name} ${stringify(params, 1500)}`);
    }
  }

  /** Flushes and closes the log file. */
  close() {
    this.stream?.end();
    this.stream = null;
  }
}

module.exports = { Logger, LEVELS, stringify };

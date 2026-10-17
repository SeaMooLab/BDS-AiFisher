'use strict';

/**
 * Bedrock block network ids for servers that use hashed ids (`block_network_ids_are_hashes` in start_game,
 * the vanilla BDS default). A hashed id is the FNV-1a 32-bit hash of the block state written as little-endian
 * NBT: a nameless root compound holding `name` and `states`, with the state keys sorted. Clicking a block with
 * the wrong id makes vanilla servers ignore the click, so the chest opener needs the real one.
 */

const nbt = require('prismarine-nbt');

let mcData = null;
try {
  mcData = require('minecraft-data');
} catch {
  mcData = null;
}

/** Blocks the depositor can open, in the order their ids are tried. */
const CONTAINER_BLOCKS = Object.freeze(['chest', 'trapped_chest', 'barrel']);

/**
 * Computes FNV-1a 32-bit over a byte buffer.
 *
 * @param {Uint8Array} bytes Input bytes.
 * @returns {number} Hash as a signed 32-bit integer, the form Bedrock sends.
 */
function fnv1a32(bytes) {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash | 0;
}

/**
 * Computes a hashed block network id.
 *
 * @param {string} name Block name, with or without the `minecraft:` prefix.
 * @param {Object<string, {type: string, value: *}>} [states] Typed block states, as minecraft-data stores them.
 * @returns {number} Signed 32-bit block network id.
 */
function hashBlockState(name, states = {}) {
  const sorted = {};
  for (const key of Object.keys(states).sort()) {
    sorted[key] = states[key];
  }

  const fullName = name.includes(':') ? name : `minecraft:${name}`;
  const root = nbt.comp({ name: nbt.string(fullName), states: nbt.comp(sorted) }, '');
  return fnv1a32(nbt.writeUncompressed(root, 'little'));
}

/**
 * Lists the hashed ids of every closed state of the openable container blocks.
 *
 * @param {string} version Bedrock version, e.g. `1.26.51`.
 * @param {string[]} [blocks=CONTAINER_BLOCKS] Block names to include.
 * @returns {Array<{id: number, label: string}>} Candidate ids with a readable label, in `blocks` order.
 */
function containerBlockIds(version, blocks = CONTAINER_BLOCKS) {
  let states = [];
  try {
    states = mcData ? mcData(`bedrock_${version}`)?.blockStates ?? [] : [];
  } catch {
    states = [];
  }

  const result = [];
  for (const block of blocks) {
    for (const state of states) {
      if (state.name !== block || state.states?.open_bit?.value === 1) {
        continue;
      }

      const label = `${block}[${Object.entries(state.states || {}).map(([key, entry]) => `${key.replace(/^minecraft:/, '')}=${entry.value}`).join(',')}]`;
      result.push({ id: hashBlockState(block, state.states), label });
    }
  }

  return result;
}

module.exports = { hashBlockState, containerBlockIds, fnv1a32, CONTAINER_BLOCKS };

'use strict';

/**
 * Chest depositing for the AFK fisher.
 *
 * Between a reel and the next cast, the bot looks at a configured chest, right-clicks it, waits for the
 * server to open the container, moves every non-kept inventory stack into it with server-authoritative
 * `item_stack_request` packets, then closes the chest and goes back to fishing. The rod slot is never touched.
 */

const { containerBlockIds } = require('./blockids');

let mcData = null;
try {
  mcData = require('minecraft-data');
} catch {
  mcData = null;
}

const DEFAULT_CHEST_CONFIG = Object.freeze({
  enabled: false,
  position: null,
  everyCatches: 16,
  whenFreeSlots: 3,
  keepItems: ['minecraft:fishing_rod'],
  lookAtChest: true,
  openTimeoutMs: 3000,
  actionTimeoutMs: 2000,
  closeTimeoutMs: 1500,
  retryAfterFailureMs: 300000,
  maxReach: 5.5,
  probeTimeoutMs: 1200,
  clickSpacingMs: 100,
  blockRuntimeId: null
});

/** Player eye height above the feet; Bedrock player positions are eye level. */
const EYE_HEIGHT = 1.62;

/**
 * Offsets from the bot's feet block that `position: "auto"` tries, nearest and most likely first:
 * the four sides at foot level, the four sides one block down, the diagonals, then the four sides at head level.
 */
const AUTO_OFFSETS = Object.freeze([
  [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
  [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1],
  [1, 0, 1], [1, 0, -1], [-1, 0, 1], [-1, 0, -1],
  [1, -1, 1], [1, -1, -1], [-1, -1, 1], [-1, -1, -1],
  [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]
]);

/** Main inventory size (hotbar 0-8 + backpack 9-35). */
const PLAYER_INVENTORY_SLOTS = 36;

/** ContainerSlotType names the server may use when reporting player inventory slots. */
const PLAYER_CONTAINER_TYPES = new Set(['hotbar', 'inventory', 'hotbar_and_inventory']);

/** Wire values of the `take` / `place` stack request actions, repeated as `legacy_type_id` since 1.26.40. */
const TAKE_ACTION_ID = 0;
const PLACE_ACTION_ID = 1;

/** Container names that can be a block's storage window. Anything else the server reports is ignored. */
const STORAGE_CONTAINER_TYPES = Object.freeze(['container', 'barrel', 'shulker']);

/**
 * Builds every known way to address an inventory -> chest move, most common first. Servers differ in which they
 * accept (vanilla's chest screen, the player inventory screen, shift-click vs. pick-up-and-drop), so the bot
 * tries them in order and keeps the first one that works.
 *
 * @param {string|undefined} reported Container name the server reported for the open window.
 * @returns {Array<{dest: string, source: string, flow: string, label: string}>} Strategies.
 */
function moveStrategies(reported) {
  const dests = [...new Set([STORAGE_CONTAINER_TYPES.includes(reported) ? reported : 'container', 'container', 'barrel'])];
  const strategies = [];

  for (const dest of dests) {
    for (const flow of ['direct', 'cursor']) {
      for (const source of ['split', 'combined']) {
        strategies.push({ dest, source, flow, label: `${flow === 'direct' ? 'shift-click' : 'pick up + drop'} from ${source === 'split' ? 'hotbar/inventory' : 'hotbar_and_inventory'} into ${dest}` });
      }
    }
  }

  return strategies;
}

/** Block faces: 0 down, 1 up, 2 north (-z), 3 south (+z), 4 west (-x), 5 east (+x). */
const FACE = Object.freeze({ DOWN: 0, UP: 1, NORTH: 2, SOUTH: 3, WEST: 4, EAST: 5 });

/** Height of the chest model, used for the click point on its top face. */
const CHEST_HEIGHT = 0.875;

/** An empty slot, in the same shape bedrock-protocol decodes ItemV4 into. */
const AIR = Object.freeze({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: undefined });

/**
 * Merges chest settings with defaults and validates them.
 *
 * @param {object|undefined} raw The `chest` object from config.json.
 * @returns {object} Validated chest settings.
 * @throws {Error} If a setting is invalid.
 */
function loadChestConfig(raw) {
  const chest = { ...DEFAULT_CHEST_CONFIG, ...(raw || {}) };

  if (typeof chest.enabled !== 'boolean') {
    throw new Error('chest.enabled must be true or false.');
  }

  if (!chest.enabled) {
    return chest;
  }

  const pos = chest.position;
  if (pos !== 'auto' && (!pos || !['x', 'y', 'z'].every((axis) => Number.isInteger(pos[axis])))) {
    throw new Error('chest.position must be "auto" (search the blocks around the bot) or the chest block coordinates as whole numbers, e.g. {"x": 200, "y": 64, "z": 176}.');
  }

  for (const key of ['everyCatches', 'whenFreeSlots']) {
    if (!Number.isInteger(chest[key]) || chest[key] < 0) {
      throw new Error(`chest.${key} must be a whole number >= 0 (0 disables that trigger).`);
    }
  }

  if (chest.everyCatches === 0 && chest.whenFreeSlots === 0) {
    throw new Error('chest.everyCatches and chest.whenFreeSlots are both 0, so the bot would never deposit.');
  }

  for (const key of ['openTimeoutMs', 'actionTimeoutMs', 'closeTimeoutMs', 'retryAfterFailureMs', 'maxReach', 'probeTimeoutMs', 'clickSpacingMs']) {
    if (!Number.isFinite(chest[key]) || chest[key] < 0) {
      throw new Error(`chest.${key} must be a non-negative number.`);
    }
  }

  if (!Array.isArray(chest.keepItems) || chest.keepItems.some((name) => typeof name !== 'string')) {
    throw new Error('chest.keepItems must be a list of item names, e.g. ["minecraft:fishing_rod"].');
  }

  if (chest.blockRuntimeId !== null && !Number.isInteger(chest.blockRuntimeId)) {
    throw new Error('chest.blockRuntimeId must be a whole number or null.');
  }

  chest.keepItems = chest.keepItems.map(normalizeItemName);
  return chest;
}

/**
 * Adds the `minecraft:` namespace to bare item names.
 *
 * @param {string} name Item name such as `cod` or `minecraft:cod`.
 * @returns {string} Namespaced, lower-case name.
 */
function normalizeItemName(name) {
  const lower = String(name).trim().toLowerCase();
  return lower.includes(':') ? lower : `minecraft:${lower}`;
}

/**
 * Returns true for an empty slot.
 *
 * @param {object|undefined} item ItemV4 stack.
 * @returns {boolean} Whether the slot is empty.
 */
function isAir(item) {
  return !item || item.network_id === 0 || item.count === 0;
}

/**
 * Returns true when a stack carries NBT or placement/destroy rules, which makes merging it unsafe to predict.
 *
 * @param {object} item ItemV4 stack.
 * @returns {boolean} Whether the stack has extra data.
 */
function hasExtraData(item) {
  const extra = item?.extra;
  if (!extra) {
    return false;
  }

  return extra.has_nbt === 'true' || extra.has_nbt === true || Boolean(extra.nbt) || (extra.can_place_on?.length ?? 0) > 0 || (extra.can_destroy?.length ?? 0) > 0;
}

/**
 * Returns true when two stacks are the same plain item and may be merged.
 *
 * @param {object} a ItemV4 stack.
 * @param {object} b ItemV4 stack.
 * @returns {boolean} Whether they stack together.
 */
function canMerge(a, b) {
  return !isAir(a) && !isAir(b) && a.network_id === b.network_id && a.metadata === b.metadata && a.block_runtime_id === b.block_runtime_id && !hasExtraData(a) && !hasExtraData(b);
}

/**
 * Builds a max-stack-size lookup from minecraft-data, falling back to 64 when unknown.
 *
 * @param {string} version Bedrock version, e.g. `1.26.51`.
 * @returns {function(string): number} Maps a namespaced item name to its max stack size.
 */
function createStackSizeLookup(version) {
  let itemsByName = null;
  try {
    itemsByName = mcData ? mcData(`bedrock_${version}`)?.itemsByName ?? null : null;
  } catch {
    itemsByName = null;
  }

  return (name) => {
    const bare = String(name || '').replace(/^minecraft:/, '');
    return itemsByName?.[bare]?.stackSize ?? 64;
  };
}

/**
 * Chooses where in the chest a stack should go: a matching partial stack first, otherwise the first empty slot.
 *
 * @param {Array<object>} chestSlots Current chest contents.
 * @param {object} item Stack being deposited.
 * @param {number} maxStack Max stack size of that item.
 * @param {Set<number>} [avoid] Chest slots that must not be used.
 * @returns {{slot: number, space: number}|null} Destination slot and how many items fit, or null when the chest is full.
 */
function pickDestination(chestSlots, item, maxStack, avoid = new Set()) {
  if (maxStack > 1) {
    for (let slot = 0; slot < chestSlots.length; slot += 1) {
      const existing = chestSlots[slot];
      if (!avoid.has(slot) && canMerge(existing, item) && existing.count < maxStack) {
        return { slot, space: maxStack - existing.count };
      }
    }
  }

  for (let slot = 0; slot < chestSlots.length; slot += 1) {
    if (!avoid.has(slot) && isAir(chestSlots[slot])) {
      return { slot, space: maxStack };
    }
  }

  return null;
}

/**
 * Computes the Bedrock pitch/yaw that points from an eye position at the center of a block.
 * Inverse of `directionFromRotation` in index.js.
 *
 * @param {{x: number, y: number, z: number}} eye Player eye position (Bedrock player positions are eye level).
 * @param {{x: number, y: number, z: number}} block Block coordinates.
 * @returns {{pitch: number, yaw: number}} Angles in degrees.
 */
function lookAtBlock(eye, block) {
  const dx = block.x + 0.5 - eye.x;
  const dy = block.y + CHEST_HEIGHT / 2 - eye.y;
  const dz = block.z + 0.5 - eye.z;
  const horizontal = Math.hypot(dx, dz);

  return {
    pitch: -Math.atan2(dy, horizontal) * 180 / Math.PI,
    yaw: Math.atan2(-dx, dz) * 180 / Math.PI
  };
}

/**
 * Picks the chest face pointing toward the player and the click point on it (relative to the block origin).
 *
 * @param {{x: number, y: number, z: number}} eye Player eye position.
 * @param {{x: number, y: number, z: number}} block Block coordinates.
 * @returns {{face: number, clickPos: {x: number, y: number, z: number}}} Face id and click position.
 */
function faceTowards(eye, block) {
  const dx = eye.x - (block.x + 0.5);
  const dy = eye.y - (block.y + CHEST_HEIGHT / 2);
  const dz = eye.z - (block.z + 0.5);
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const az = Math.abs(dz);

  if (ay >= ax && ay >= az) {
    return dy > 0 ? { face: FACE.UP, clickPos: { x: 0.5, y: CHEST_HEIGHT, z: 0.5 } } : { face: FACE.DOWN, clickPos: { x: 0.5, y: 0, z: 0.5 } };
  }

  if (ax >= az) {
    return dx > 0 ? { face: FACE.EAST, clickPos: { x: 1, y: 0.5, z: 0.5 } } : { face: FACE.WEST, clickPos: { x: 0, y: 0.5, z: 0.5 } };
  }

  return dz > 0 ? { face: FACE.SOUTH, clickPos: { x: 0.5, y: 0.5, z: 1 } } : { face: FACE.NORTH, clickPos: { x: 0.5, y: 0.5, z: 0 } };
}

/**
 * Returns the block the bot's feet are in.
 *
 * @param {{x: number, y: number, z: number}} eye Bot eye position.
 * @returns {{x: number, y: number, z: number}} Feet block coordinates.
 */
function feetBlock(eye) {
  return { x: Math.floor(eye.x), y: Math.floor(eye.y - EYE_HEIGHT + 0.01), z: Math.floor(eye.z) };
}

/**
 * Lists the blocks around the bot that `position: "auto"` tries, in order.
 *
 * @param {{x: number, y: number, z: number}} eye Bot eye position.
 * @returns {Array<{x: number, y: number, z: number}>} Candidate chest positions.
 */
function autoCandidates(eye) {
  const feet = feetBlock(eye);
  return AUTO_OFFSETS.map(([dx, dy, dz]) => ({ x: feet.x + dx, y: feet.y + dy, z: feet.z + dz }));
}

/**
 * @param {{x: number, y: number, z: number}} a Block position.
 * @param {{x: number, y: number, z: number}} b Block position.
 * @returns {boolean} Whether both are the same block.
 */
function samePos(a, b) {
  return Boolean(a && b) && a.x === b.x && a.y === b.y && a.z === b.z;
}

/**
 * @param {{x: number, y: number, z: number}} pos Block position.
 * @returns {string} Map key.
 */
function posKey(pos) {
  return `${pos.x},${pos.y},${pos.z}`;
}

/**
 * Promise-based waits for specific server packets, with timeouts and bulk abort on disconnect.
 */
class PacketWaiter {
  constructor() {
    this.pending = new Set();
  }

  /**
   * Waits for a packet.
   *
   * @param {string} name Packet name.
   * @param {function(object): boolean} match Returns true for the awaited packet.
   * @param {number} timeoutMs Rejects after this long.
   * @returns {Promise<object>} The matching packet.
   */
  wait(name, match, timeoutMs) {
    return new Promise((resolve, reject) => {
      const entry = { name, match, resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        this.pending.delete(entry);
        reject(new Error(`timed out after ${timeoutMs} ms waiting for ${name}`));
      }, timeoutMs);
      this.pending.add(entry);
    });
  }

  /**
   * Offers a received packet to the waits.
   *
   * @param {string} name Packet name.
   * @param {object} packet Decoded packet.
   */
  feed(name, packet) {
    for (const entry of this.pending) {
      if (entry.name === name && entry.match(packet)) {
        clearTimeout(entry.timer);
        this.pending.delete(entry);
        entry.resolve(packet);
      }
    }
  }

  /**
   * Rejects every pending wait.
   *
   * @param {string} reason Error message.
   */
  abort(reason) {
    for (const entry of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

/**
 * @typedef {object} ChestHost
 * @property {function(string, object): void} send Sends a packet.
 * @property {function(object, string): void} useItem Sends use-item data via `transaction` or `auth_input`.
 * @property {function(): string} preferredMethod The use-item method that currently works for the rod.
 * @property {function(): Array<object>} inventory Live player inventory slot array (mutated in place).
 * @property {function(): object} heldItem Stack in the selected (rod) hotbar slot.
 * @property {number} rodSlot Hotbar slot holding the rod; never deposited.
 * @property {function(): {x: number, y: number, z: number}} position Bot eye position.
 * @property {function(): {pitch: number, yaw: number}} getLook Current look angles.
 * @property {function(number, number): void} setLook Sets look angles sent by the heartbeat.
 * @property {function(object): string|undefined} itemName Namespaced item name for a stack.
 * @property {function(object): string} describeItem Human-readable stack description.
 * @property {function(): (boolean|undefined)} blockIdsAreHashes start_game `block_network_ids_are_hashes`.
 */

/**
 * Opens a nearby chest and moves loot into it, keeping the fishing rod (and any `keepItems`).
 */
class ChestDepositor {
  /**
   * @param {object} settings Validated chest settings from {@link loadChestConfig}.
   * @param {ChestHost} host Bot callbacks.
   * @param {import('./logger').Logger} log Logger.
   * @param {string} version Bedrock version, used for stack sizes.
   */
  constructor(settings, host, log, version) {
    this.settings = settings;
    this.host = host;
    this.log = log;
    this.stackSize = createStackSizeLookup(version);
    this.waiter = new PacketWaiter();
    this.keep = new Set(settings.keepItems);
    this.target = settings.position === 'auto' ? null : { ...settings.position };
    this.blockRuntimeIds = new Map();
    this.workingIds = new Map();
    this.version = version;
    this.hashedIds = null;
    this.workingMethod = null;
    this.strategy = null;
    this.strategies = [];
    this.lastRefusal = '';
    this.catchesSinceDeposit = 0;
    this.retryAt = 0;
    this.nextRequestId = -1;
    this.deposits = 0;
    this.itemsStored = 0;
    this.resetSession();
  }

  /** Clears per-connection state. */
  resetSession() {
    this.busy = false;
    this.window = null;
    this.windowContents = new Map();
    this.windowContainers = new Map();
    this.retryAt = 0;
    this.waiter.abort('session reset');
  }

  /** Aborts an in-progress deposit, e.g. on disconnect. */
  abort(reason) {
    this.waiter.abort(reason);
    this.window = null;
  }

  /** Counts a catch toward the `everyCatches` trigger. */
  noteCatch() {
    this.catchesSinceDeposit += 1;
  }

  /**
   * Logs a warning when the bot is probably too far from the chest to open it.
   *
   * @param {{x: number, y: number, z: number}} eye Bot eye position.
   */
  checkReach(eye) {
    const pos = this.target;
    if (!pos) {
      const feet = feetBlock(eye);
      this.log.info('CHEST', `Chest position is "auto": on the first deposit the bot tries the blocks around ${feet.x}, ${feet.y}, ${feet.z} until one opens. Depositing every ${this.settings.everyCatches || 'n/a'} catches or when <= ${this.settings.whenFreeSlots} free slots.`);
      return;
    }

    const distance = Math.hypot(pos.x + 0.5 - eye.x, pos.y + 0.5 - eye.y, pos.z + 0.5 - eye.z);
    const message = `Chest at ${pos.x}, ${pos.y}, ${pos.z} is ${distance.toFixed(1)} blocks away.`;

    if (distance > this.settings.maxReach) {
      this.log.warn('CHEST', `${message} That is probably out of reach (max ~${this.settings.maxReach}); the server will refuse to open it. Move the chest closer.`);
    } else {
      this.log.info('CHEST', `${message} Depositing every ${this.settings.everyCatches || 'n/a'} catches or when <= ${this.settings.whenFreeSlots} free slots. Keeping: rod slot ${this.host.rodSlot}, ${[...this.keep].join(', ') || 'nothing else'}.`);
    }
  }

  /**
   * Lists player inventory slots whose stacks should go into the chest.
   *
   * @returns {number[]} Slot indexes (0-35), rod slot and kept items excluded.
   */
  depositableSlots() {
    const inventory = this.host.inventory();
    const slots = [];

    for (let slot = 0; slot < Math.min(inventory.length, PLAYER_INVENTORY_SLOTS); slot += 1) {
      const item = inventory[slot];
      if (slot === this.host.rodSlot || isAir(item) || this.keep.has(this.host.itemName(item))) {
        continue;
      }
      slots.push(slot);
    }

    return slots;
  }

  /**
   * Counts empty main-inventory slots.
   *
   * @returns {number} Free slots.
   */
  freeSlots() {
    const inventory = this.host.inventory();
    if (inventory.length === 0) {
      return PLAYER_INVENTORY_SLOTS;
    }

    let free = 0;
    for (let slot = 0; slot < Math.min(inventory.length, PLAYER_INVENTORY_SLOTS); slot += 1) {
      free += isAir(inventory[slot]) ? 1 : 0;
    }
    return free;
  }

  /**
   * Decides whether a deposit should run before the next cast.
   *
   * @returns {string|null} Reason to deposit, or null.
   */
  dueReason() {
    if (this.busy || Date.now() < this.retryAt || this.depositableSlots().length === 0) {
      return null;
    }

    if (this.settings.everyCatches === 1) {
      return 'new items in inventory';
    }

    const free = this.freeSlots();
    if (this.settings.whenFreeSlots > 0 && free <= this.settings.whenFreeSlots) {
      return `inventory almost full (${free} free slots)`;
    }

    if (this.settings.everyCatches > 0 && this.catchesSinceDeposit >= this.settings.everyCatches) {
      return `${this.catchesSinceDeposit} catches since last deposit`;
    }

    return null;
  }

  /**
   * Handles container_open. Also resolves a pending open.
   *
   * @param {object} packet container_open packet.
   */
  handleContainerOpen(packet) {
    if (!this.busy) {
      return;
    }

    this.window = packet;
    const coords = packet.coordinates;
    if (this.target && coords && !samePos(coords, this.target)) {
      this.log.verbose('CHEST', `Opened container at ${coords.x}, ${coords.y}, ${coords.z} (other half of a double chest?).`);
    }
    this.waiter.feed('container_open', packet);
  }

  /**
   * Handles container_close from the server.
   *
   * @param {object} packet container_close packet.
   */
  handleContainerClose(packet) {
    if (this.window && packet.window_id === this.window.window_id) {
      this.window = null;
    }
    this.waiter.feed('container_close', packet);
  }

  /**
   * Stores the contents of a non-player window (the chest).
   *
   * @param {object} packet inventory_content packet.
   */
  handleWindowContent(packet) {
    if (!this.busy || !Array.isArray(packet.input)) {
      return;
    }

    this.windowContents.set(packet.window_id, packet.input.slice());
    if (packet.container?.container_id) {
      this.windowContainers.set(packet.window_id, packet.container);
    }
    this.waiter.feed('inventory_content', packet);
  }

  /**
   * Applies a single-slot update to a non-player window.
   *
   * @param {object} packet inventory_slot packet.
   */
  handleWindowSlot(packet) {
    const contents = this.windowContents.get(packet.window_id);
    if (contents) {
      contents[packet.slot] = packet.item;
    }
  }

  /**
   * Learns the chest's block runtime id when the server resyncs that block.
   *
   * @param {object} packet update_block packet.
   */
  handleUpdateBlock(packet) {
    if (!packet.position || packet.layer !== 0) {
      return;
    }

    const key = posKey(packet.position);
    if (this.busy || this.blockRuntimeIds.has(key) || samePos(packet.position, this.target)) {
      if (this.busy && this.blockRuntimeIds.get(key) !== packet.block_runtime_id) {
        const known = this.containerIds().find((entry) => entry.id === packet.block_runtime_id);
        this.log.info('CHEST', `Server resynced block ${formatPos(packet.position)}: runtime id ${packet.block_runtime_id}${known ? ` (${known.label})` : ''}.`);
      }
      this.blockRuntimeIds.set(key, packet.block_runtime_id);
    }
  }

  /**
   * Hashed ids of every closed chest / trapped chest / barrel state, when the server uses hashed block ids.
   *
   * @returns {Array<{id: number, label: string}>} Candidates, or an empty list on servers without hashed ids.
   */
  containerIds() {
    if (this.host.blockIdsAreHashes() === false) {
      return [];
    }

    this.hashedIds ??= containerBlockIds(this.version);
    return this.hashedIds;
  }

  /**
   * Orders the block runtime ids to try when clicking a block: configured, previously working, learned from
   * the server, then (when `full`) every container state's hashed id, then 0.
   *
   * @param {{x: number, y: number, z: number}} pos Block position.
   * @param {boolean} full Include every container id rather than only plain chests.
   * @returns {number[]} Distinct ids, most likely first.
   */
  runtimeIdCandidates(pos, full) {
    const key = posKey(pos);
    const ids = [];
    const add = (id) => {
      if (Number.isInteger(id) && !ids.includes(id)) {
        ids.push(id);
      }
    };

    if (this.settings.blockRuntimeId !== null && samePos(pos, this.target)) {
      add(this.settings.blockRuntimeId);
    }
    for (const id of this.workingIds.get(key) || []) {
      add(id);
    }
    add(this.blockRuntimeIds.get(key));

    const containers = this.containerIds();
    for (const entry of full ? containers : containers.filter((c) => c.label.startsWith('chest['))) {
      add(entry.id);
    }
    add(0);
    return ids;
  }

  /**
   * Handles item_stack_response.
   *
   * @param {object} packet item_stack_response packet.
   */
  handleStackResponse(packet) {
    for (const response of packet.responses || []) {
      this.waiter.feed('item_stack_response', response);
    }
  }

  /**
   * Runs one full deposit: look, open, move stacks, close, look back.
   *
   * @param {string} reason Why the deposit runs, for the log.
   * @returns {Promise<void>} Resolves when done (never rejects).
   */
  async run(reason) {
    if (this.busy) {
      return;
    }

    this.busy = true;
    this.window = null;
    this.windowContents.clear();
    this.windowContainers.clear();
    const savedLook = this.host.getLook();
    let moved = 0;

    this.log.info('CHEST', `Depositing loot: ${reason}.`);

    try {
      const window = this.target ? await this.open() : await this.findChest();
      const chestSlots = await this.awaitContents(window);
      this.log.verbose('CHEST', `Chest opened (window ${window.window_id}, ${chestSlots.length} slots, ${chestSlots.filter(isAir).length} empty).`);

      const result = await this.moveAll(chestSlots);
      moved = result.moved;

      if (result.chestFull) {
        this.retryAt = Date.now() + this.settings.retryAfterFailureMs;
        this.log.warn('CHEST', `Chest is FULL. Stored ${moved} items; the rest stays in the bot's inventory. Retrying in ${Math.round(this.settings.retryAfterFailureMs / 1000)}s. Empty the chest or add another.`);
      } else {
        this.retryAt = 0;
      }

      this.catchesSinceDeposit = 0;
      this.deposits += 1;
      this.itemsStored += moved;
      this.log.info('CHEST', `Deposit done: ${moved} items moved. Total stored this run: ${this.itemsStored}.`);
    } catch (error) {
      this.retryAt = Date.now() + this.settings.retryAfterFailureMs;
      this.log.error('CHEST', `Deposit failed: ${error.message}. Back to fishing; next try in ${Math.round(this.settings.retryAfterFailureMs / 1000)}s.`);
    } finally {
      await this.close();
      this.host.setLook(savedLook.pitch, savedLook.yaw);
      await delay(150);
      this.busy = false;
    }
  }

  /**
   * Builds the click-block use-item payload for a block.
   *
   * @param {{x: number, y: number, z: number}} pos Block to click.
   * @param {number} runtimeId Block runtime id to report for that block.
   * @returns {object} TransactionUseItem fields.
   */
  buildClickData(pos, runtimeId) {
    const eye = this.host.position();
    const { face, clickPos } = faceTowards(eye, pos);

    return {
      action_type: 'click_block',
      trigger_type: 'player_input',
      block_position: { ...pos },
      face,
      hotbar_slot: this.host.rodSlot,
      hand: 'main_hand',
      held_item: this.host.heldItem(),
      player_pos: eye,
      click_pos: clickPos,
      block_runtime_id: runtimeId,
      client_prediction: 'success',
      client_cooldown_state: 'off'
    };
  }

  /**
   * Right-clicks the chest until the server opens it, alternating use-item methods.
   *
   * @returns {Promise<object>} The container_open packet.
   * @throws {Error} When the chest never opens.
   */
  async open() {
    const first = this.workingMethod || this.host.preferredMethod();
    const second = first === 'transaction' ? 'auth_input' : 'transaction';

    for (const method of [first, second]) {
      try {
        return await this.tryOpen(this.target, method, this.settings.openTimeoutMs, this.runtimeIdCandidates(this.target, true));
      } catch (error) {
        this.log.warn('CHEST', `Chest did not open via ${method} (${error.message}).`);
      }
    }

    throw new Error(`the chest at ${formatPos(this.target)} never opened. Check the coordinates, that nothing solid sits on top of it, that it is within reach, and that the bot may open containers here (claims/plot protection)`);
  }

  /**
   * Faces a block and right-clicks it once per candidate block runtime id (a vanilla server ignores clicks whose
   * id doesn't match the block), stopping as soon as a container opens.
   *
   * @param {{x: number, y: number, z: number}} pos Block to click.
   * @param {string} method `transaction` or `auth_input`.
   * @param {number} timeoutMs How long to wait for container_open after the last click.
   * @param {number[]} runtimeIds Block runtime ids to try, in order.
   * @returns {Promise<object>} The container_open packet.
   * @throws {Error} On timeout.
   */
  async tryOpen(pos, method, timeoutMs, runtimeIds) {
    if (this.settings.lookAtChest) {
      const look = lookAtBlock(this.host.position(), pos);
      this.host.setLook(look.pitch, look.yaw);
      await delay(150);
    }

    const key = posKey(pos);
    const { face } = faceTowards(this.host.position(), pos);
    const queue = runtimeIds.slice();
    const sent = [];
    let opened = null;
    this.window = null;
    this.log.verbose('CHEST', `Clicking ${formatPos(pos)} face ${face} via ${method}, trying ${queue.length} block id(s): ${queue.join(', ')}`);

    while (queue.length > 0 && !this.window) {
      const learned = this.blockRuntimeIds.get(key);
      const runtimeId = learned !== undefined && !sent.includes(learned) ? learned : queue.shift();
      if (sent.includes(runtimeId)) {
        continue;
      }

      sent.push(runtimeId);
      this.host.useItem(this.buildClickData(pos, runtimeId), method);
      await delay(this.settings.clickSpacingMs);
    }

    if (!this.window) {
      opened = this.waiter.wait('container_open', () => true, timeoutMs);
      const learned = this.blockRuntimeIds.get(key);
      if (learned !== undefined && !sent.includes(learned)) {
        sent.push(learned);
        this.host.useItem(this.buildClickData(pos, learned), method);
      }
    }

    const packet = this.window || await opened;
    this.workingIds.set(key, sent.slice().reverse());

    if (this.workingMethod !== method) {
      this.log.info('CHEST', `Containers open with the "${method}" method.`);
    }
    this.workingMethod = method;
    return packet;
  }

  /**
   * For `position: "auto"`: clicks the blocks around the bot until one opens as a container, then remembers it.
   *
   * @returns {Promise<object>} The container_open packet.
   * @throws {Error} When nothing nearby opens.
   */
  async findChest() {
    const candidates = autoCandidates(this.host.position());
    const first = this.workingMethod || this.host.preferredMethod();
    const other = first === 'transaction' ? 'auth_input' : 'transaction';
    const passes = [
      { method: first, ids: (pos) => [this.blockRuntimeIds.get(posKey(pos)) ?? 0] },
      { method: first, ids: (pos) => this.runtimeIdCandidates(pos, false) },
      { method: other, ids: (pos) => this.runtimeIdCandidates(pos, false) }
    ];

    for (const pass of passes) {
      this.log.info('CHEST', `Searching ${candidates.length} blocks around the bot for a chest (via ${pass.method})...`);

      for (const pos of candidates) {
        try {
          const packet = await this.tryOpen(pos, pass.method, this.settings.probeTimeoutMs, pass.ids(pos));
          this.target = pos;
          this.log.info('CHEST', `FOUND the chest at ${formatPos(pos)}. To skip the search next time, set "position": {"x": ${pos.x}, "y": ${pos.y}, "z": ${pos.z}} in config.json.`);
          return packet;
        } catch (error) {
          this.log.verbose('CHEST', `Nothing opened at ${formatPos(pos)} (${error.message}).`);
        }
      }
    }

    throw new Error('no chest opened in any block around the bot. Put it right next to him (touching his block, same level or one lower), make sure nothing solid sits on top of it, and that the bot is allowed to open containers there');
  }

  /**
   * Returns the chest contents, waiting for them if the server hasn't sent them yet.
   *
   * @param {object} window container_open packet.
   * @returns {Promise<Array<object>>} Chest slots (mutated in place as items move).
   */
  async awaitContents(window) {
    if (!this.windowContents.has(window.window_id)) {
      await this.waiter.wait('inventory_content', (packet) => packet.window_id === window.window_id, this.settings.actionTimeoutMs);
    }
    return this.windowContents.get(window.window_id);
  }

  /**
   * Moves every depositable stack into the chest.
   *
   * @param {Array<object>} chestSlots Chest contents.
   * @returns {Promise<{moved: number, chestFull: boolean}>} Items moved and whether the chest ran out of room.
   */
  async moveAll(chestSlots) {
    let moved = 0;
    let failures = 0;
    const reported = this.windowContainers.get(this.window?.window_id)?.container_id;
    this.strategies = moveStrategies(reported);
    this.log.verbose('CHEST', `Server calls this window "${reported ?? 'n/a'}". Move method: ${this.strategy ? this.strategy.label : 'not known yet, will try each'}.`);

    for (const slot of this.depositableSlots()) {
      if (!this.window) {
        throw new Error('the server closed the chest mid-deposit');
      }

      const result = await this.depositSlot(slot, chestSlots);
      moved += result.moved;
      failures += result.failed ? 1 : 0;

      if (result.chestFull) {
        return { moved, chestFull: true };
      }

      if (failures >= 3) {
        throw new Error(`the server rejected ${failures} moves in a row`);
      }
    }

    return { moved, chestFull: false };
  }

  /**
   * Moves one inventory stack into the chest, splitting it across partial stacks when needed.
   *
   * @param {number} slot Player inventory slot.
   * @param {Array<object>} chestSlots Chest contents.
   * @returns {Promise<{moved: number, chestFull: boolean, failed: boolean}>} Outcome.
   */
  async depositSlot(slot, chestSlots) {
    const inventory = this.host.inventory();
    const avoid = new Set();
    let moved = 0;

    while (!isAir(inventory[slot])) {
      const item = inventory[slot];
      const maxStack = Math.max(1, this.stackSize(this.host.itemName(item)));
      const destination = pickDestination(chestSlots, item, maxStack, avoid);

      if (!destination) {
        return { moved, chestFull: true, failed: false };
      }

      const count = Math.min(item.count, destination.space);
      const ok = await this.moveWithStrategy(slot, destination.slot, count, chestSlots);

      if (ok) {
        moved += count;
        this.log.verbose('CHEST', `Stored ${this.host.describeItem({ ...item, count })} from slot ${slot} into chest slot ${destination.slot}.`);
        continue;
      }

      if (!isAir(chestSlots[destination.slot]) && avoid.size < 3) {
        avoid.add(destination.slot);
        continue;
      }

      this.log.warn('CHEST', `Server refused to store ${this.host.describeItem(item)} from slot ${slot}. Skipping it.`);
      return { moved, chestFull: false, failed: true };
    }

    return { moved, chestFull: false, failed: false };
  }

  /**
   * Moves items with the known-good strategy, or, until one is known, tries each strategy until the server
   * accepts one and remembers it.
   *
   * @param {number} fromSlot Player inventory slot.
   * @param {number} toSlot Chest slot.
   * @param {number} count Items to move.
   * @param {Array<object>} chestSlots Chest contents.
   * @returns {Promise<boolean>} True when the server accepted the move.
   * @throws {Error} When no strategy works at all.
   */
  async moveWithStrategy(fromSlot, toSlot, count, chestSlots) {
    if (this.strategy) {
      return this.place(fromSlot, toSlot, count, chestSlots, this.strategy);
    }

    const refusals = [];
    for (const strategy of this.strategies) {
      const result = await this.place(fromSlot, toSlot, count, chestSlots, strategy);
      if (result) {
        this.strategy = strategy;
        this.log.info('CHEST', `Item moves work via ${strategy.label}.`);
        return true;
      }
      refusals.push(`${strategy.label}: ${this.lastRefusal}`);
      this.log.info('CHEST', `Server refused ${strategy.label} (${this.lastRefusal}).`);
    }

    throw new Error(`the server refused every way of moving items into the chest:\n  ${refusals.join('\n  ')}`);
  }

  /**
   * Sends one item stack request moving items from the player inventory into the chest, and applies the answer.
   *
   * @param {number} fromSlot Player inventory slot.
   * @param {number} toSlot Chest slot.
   * @param {number} count Items to move.
   * @param {Array<object>} chestSlots Chest contents.
   * @param {{dest: string, source: string, flow: string}} strategy How to address the move.
   * @returns {Promise<boolean>} True when the server accepted the move.
   */
  async place(fromSlot, toSlot, count, chestSlots, strategy) {
    const inventory = this.host.inventory();
    const source = inventory[fromSlot];
    const destination = chestSlots[toSlot];
    const requestId = this.nextRequestId;
    this.nextRequestId -= 2;

    const sourceContainer = strategy.source === 'combined' ? 'hotbar_and_inventory' : fromSlot < 9 ? 'hotbar' : 'inventory';
    const sourceInfo = { slot_type: { container_id: sourceContainer, dynamic_container_id: undefined }, slot: fromSlot, stack_id: stackIdOf(source) };
    const destInfo = { slot_type: { container_id: strategy.dest, dynamic_container_id: undefined }, slot: toSlot, stack_id: stackIdOf(destination) };
    const cursor = (stackId) => ({ slot_type: { container_id: 'cursor', dynamic_container_id: undefined }, slot: 0, stack_id: stackId });

    const actions = strategy.flow === 'cursor'
      ? [
        { type_id: 'take', legacy_type_id: TAKE_ACTION_ID, count, source: sourceInfo, destination: cursor(0) },
        { type_id: 'place', legacy_type_id: PLACE_ACTION_ID, count, source: cursor(requestId), destination: destInfo }
      ]
      : [{ type_id: 'place', legacy_type_id: PLACE_ACTION_ID, count, source: sourceInfo, destination: destInfo }];

    const response = this.waiter.wait('item_stack_response', (r) => r.request_id === requestId, this.settings.actionTimeoutMs);
    this.host.send('item_stack_request', { requests: [{ request_id: requestId, actions, custom_names: [], cause: 'chat_public' }] });

    let answer;
    try {
      answer = await response;
    } catch (error) {
      throw new Error(`no answer to item move (${error.message})`);
    }

    if (answer.status !== 'ok') {
      this.lastRefusal = `status ${answer.status}`;
      this.log.verbose('CHEST', `Move ${fromSlot} -> chest ${toSlot} x${count} via ${strategy.label} rejected (status ${answer.status}).`);
      return false;
    }

    this.applyMove(fromSlot, toSlot, count, source, chestSlots, answer.containers);
    return true;
  }

  /**
   * Updates local inventory and chest state after an accepted move, preferring the server's reported slots.
   *
   * @param {number} fromSlot Player inventory slot.
   * @param {number} toSlot Chest slot.
   * @param {number} count Items moved.
   * @param {object} sourceBefore Source stack before the move.
   * @param {Array<object>} chestSlots Chest contents.
   * @param {Array<object>|undefined} containers Response container info.
   */
  applyMove(fromSlot, toSlot, count, sourceBefore, chestSlots, containers) {
    const inventory = this.host.inventory();
    const template = { ...sourceBefore };
    const destBefore = chestSlots[toSlot];

    inventory[fromSlot] = sourceBefore.count - count > 0 ? { ...sourceBefore, count: sourceBefore.count - count } : AIR;
    chestSlots[toSlot] = isAir(destBefore) ? { ...template, count, has_stack_id: false, stack_id: undefined } : { ...destBefore, count: destBefore.count + count };

    for (const container of containers || []) {
      const type = container.slot_type?.container_id;
      if (type === 'cursor') {
        continue;
      }
      const target = PLAYER_CONTAINER_TYPES.has(type) ? inventory : chestSlots;

      for (const info of container.slots || []) {
        applySlotInfo(target, info, template);
      }
    }
  }

  /** Closes the chest if it is open and waits briefly for the server to confirm. */
  async close() {
    if (!this.window) {
      return;
    }

    const window = this.window;
    const closed = this.waiter.wait('container_close', (packet) => packet.window_id === window.window_id, this.settings.closeTimeoutMs);

    try {
      this.host.send('container_close', { window_id: window.window_id, window_type: window.window_type, server: false });
      await closed;
    } catch (error) {
      this.log.verbose('CHEST', `No close confirmation (${error.message}). Continuing.`);
    }

    this.window = null;
  }
}

/**
 * Applies one ItemStackResponse slot entry to a slot array.
 *
 * @param {Array<object>} slots Target slot array.
 * @param {object} info Response slot info.
 * @param {object} template Stack to copy item data from when the slot was empty.
 */
function applySlotInfo(slots, info, template) {
  if (info.count === 0) {
    slots[info.slot] = AIR;
    return;
  }

  const base = isAir(slots[info.slot]) ? template : slots[info.slot];
  const stackId = info.item_stack_id ?? base.stack_id;
  slots[info.slot] = { ...base, count: info.count, has_stack_id: stackId !== undefined, stack_id: stackId };
}

/**
 * Returns a stack's network stack id, or 0 for empty slots / unknown ids.
 *
 * @param {object} item ItemV4 stack.
 * @returns {number} Stack id.
 */
function stackIdOf(item) {
  return isAir(item) || !item.has_stack_id ? 0 : Number(item.stack_id);
}

/**
 * @param {{x: number, y: number, z: number}} pos Block position.
 * @returns {string} `x, y, z`.
 */
function formatPos(pos) {
  return `${pos.x}, ${pos.y}, ${pos.z}`;
}

/**
 * @param {number} ms Milliseconds.
 * @returns {Promise<void>} Resolves after the delay.
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  ChestDepositor,
  PacketWaiter,
  DEFAULT_CHEST_CONFIG,
  AIR,
  loadChestConfig,
  normalizeItemName,
  pickDestination,
  moveStrategies,
  lookAtBlock,
  faceTowards,
  feetBlock,
  autoCandidates,
  canMerge,
  isAir,
  createStackSizeLookup
};
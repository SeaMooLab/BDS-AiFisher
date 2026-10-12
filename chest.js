'use strict';

/**
 * Chest depositing for the AFK fisher.
 *
 * Between a reel and the next cast, the bot looks at a configured chest, right-clicks it, waits for the
 * server to open the container, moves every non-kept inventory stack into it with server-authoritative
 * `item_stack_request` packets, then closes the chest and goes back to fishing. The rod slot is never touched.
 */

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
  blockRuntimeId: null
});

/** Main inventory size (hotbar 0-8 + backpack 9-35). */
const PLAYER_INVENTORY_SLOTS = 36;

/** ContainerSlotType names the server may use when reporting player inventory slots. */
const PLAYER_CONTAINER_TYPES = new Set(['hotbar', 'inventory', 'hotbar_and_inventory']);

/** Wire value of the `place` stack request action, repeated as `legacy_type_id` since 1.26.40. */
const PLACE_ACTION_ID = 1;

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
  if (!pos || !['x', 'y', 'z'].every((axis) => Number.isInteger(pos[axis]))) {
    throw new Error('chest.position must be the chest block coordinates as whole numbers, e.g. {"x": 200, "y": 64, "z": 176}. Turn on "Show Coordinates" in-game and stand on/next to the chest to read them.');
  }

  for (const key of ['everyCatches', 'whenFreeSlots']) {
    if (!Number.isInteger(chest[key]) || chest[key] < 0) {
      throw new Error(`chest.${key} must be a whole number >= 0 (0 disables that trigger).`);
    }
  }

  if (chest.everyCatches === 0 && chest.whenFreeSlots === 0) {
    throw new Error('chest.everyCatches and chest.whenFreeSlots are both 0, so the bot would never deposit.');
  }

  for (const key of ['openTimeoutMs', 'actionTimeoutMs', 'closeTimeoutMs', 'retryAfterFailureMs', 'maxReach']) {
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
    this.blockRuntimeId = settings.blockRuntimeId ?? 0;
    this.workingMethod = null;
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
    const pos = this.settings.position;
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
    const pos = this.settings.position;
    const coords = packet.coordinates;
    if (coords && (coords.x !== pos.x || coords.y !== pos.y || coords.z !== pos.z)) {
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
    const pos = this.settings.position;
    const p = packet.position;
    if (p && p.x === pos.x && p.y === pos.y && p.z === pos.z && packet.layer === 0 && this.settings.blockRuntimeId === null) {
      if (this.blockRuntimeId !== packet.block_runtime_id) {
        this.log.verbose('CHEST', `Learned chest block runtime id ${packet.block_runtime_id}.`);
      }
      this.blockRuntimeId = packet.block_runtime_id;
    }
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
    const savedLook = this.host.getLook();
    let moved = 0;

    this.log.info('CHEST', `Depositing loot: ${reason}.`);

    try {
      if (this.settings.lookAtChest) {
        const look = lookAtBlock(this.host.position(), this.settings.position);
        this.host.setLook(look.pitch, look.yaw);
        await delay(150);
      }

      const window = await this.open();
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
   * Builds the click-block use-item payload for the chest.
   *
   * @returns {object} TransactionUseItem fields.
   */
  buildClickData() {
    const eye = this.host.position();
    const { face, clickPos } = faceTowards(eye, this.settings.position);

    return {
      action_type: 'click_block',
      trigger_type: 'player_input',
      block_position: { ...this.settings.position },
      face,
      hotbar_slot: this.host.rodSlot,
      hand: 'main_hand',
      held_item: this.host.heldItem(),
      player_pos: eye,
      click_pos: clickPos,
      block_runtime_id: this.blockRuntimeId,
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
    const attempts = [first, second, first];

    for (const method of attempts) {
      const opened = this.waiter.wait('container_open', () => true, this.settings.openTimeoutMs);
      this.host.useItem(this.buildClickData(), method);

      try {
        const packet = await opened;
        if (this.workingMethod !== method) {
          this.log.info('CHEST', `Chest opens with the "${method}" method.`);
        }
        this.workingMethod = method;
        return packet;
      } catch (error) {
        this.log.warn('CHEST', `Chest did not open via ${method} (${error.message}).`);
      }
    }

    throw new Error(`the chest at ${formatPos(this.settings.position)} never opened. Check the coordinates, that nothing solid sits on top of it, that it is within reach, and that the bot may open containers here (claims/plot protection)`);
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
      const ok = await this.place(slot, destination.slot, count, chestSlots);

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
   * Sends one `place` item stack request and applies the server's answer.
   *
   * @param {number} fromSlot Player inventory slot.
   * @param {number} toSlot Chest slot.
   * @param {number} count Items to move.
   * @param {Array<object>} chestSlots Chest contents.
   * @returns {Promise<boolean>} True when the server accepted the move.
   */
  async place(fromSlot, toSlot, count, chestSlots) {
    const inventory = this.host.inventory();
    const source = inventory[fromSlot];
    const destination = chestSlots[toSlot];
    const requestId = this.nextRequestId;
    this.nextRequestId -= 2;

    const response = this.waiter.wait('item_stack_response', (r) => r.request_id === requestId, this.settings.actionTimeoutMs);

    this.host.send('item_stack_request', {
      requests: [{
        request_id: requestId,
        actions: [{
          type_id: 'place',
          legacy_type_id: PLACE_ACTION_ID,
          count,
          source: {
            slot_type: { container_id: fromSlot < 9 ? 'hotbar' : 'inventory', dynamic_container_id: undefined },
            slot: fromSlot,
            stack_id: stackIdOf(source)
          },
          destination: {
            slot_type: { container_id: 'container', dynamic_container_id: undefined },
            slot: toSlot,
            stack_id: stackIdOf(destination)
          }
        }],
        custom_names: [],
        cause: 'chat_public'
      }]
    });

    let answer;
    try {
      answer = await response;
    } catch (error) {
      throw new Error(`no answer to item move (${error.message})`);
    }

    if (answer.status !== 'ok') {
      this.log.verbose('CHEST', `Move ${fromSlot} -> chest ${toSlot} x${count} rejected (status ${answer.status}).`);
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
  lookAtBlock,
  faceTowards,
  canMerge,
  isAir,
  createStackSizeLookup
};

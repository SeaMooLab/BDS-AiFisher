'use strict';

const SILENT_MODE = false;

const fs = require('node:fs');
const path = require('node:path');
const bedrock = require('bedrock-protocol');
const { Logger, LEVELS, stringify } = require('./logger');
const { CommandRouter, SettingsRegistry, settingTypes, registerBuiltinCommands } = require('./commands');
const { ChestDepositor, loadChestConfig, AIR, lookAtBlock } = require('./chest');

const CONFIG_PATH = path.join(__dirname, 'config.json');

const CAST_METHODS = Object.freeze(['auto', 'transaction', 'auth_input']);

const RAKNET_BACKENDS = Object.freeze(['auto', 'raknet-native', 'jsp-raknet']);

// manual: the bot reels in on every bite. auto: an automatic fisher reels; the bot only recasts when its hook is gone.
const MODES = Object.freeze(['manual', 'auto']);

const ROD_ITEM_NAME = 'minecraft:fishing_rod';

const HOTBAR_SIZE = 9;

const PLAYER_INVENTORY_SIZE = 36;

const DEFAULT_CONFIG = Object.freeze({
  offline: false,
  version: '1.26.51',
  mode: 'manual',
  commandPrefix: '^',
  commandUsers: [],
  hotbarSlot: 0,
  autoFindRod: true,
  castMethod: 'auto',
  recastDelayMs: 900,
  maxCastMs: 90000,
  castConfirmMs: 3000,
  hookClaimWindowMs: 5000,
  catchAttributionMs: 3000,
  noRodRetryMs: 10000,
  spawnSettleMs: 3000,
  reconnectBaseMs: 5000,
  reconnectMaxMs: 60000,
  statusIntervalMs: 15000,
  raknetBackend: 'auto',
  joinMessage: 'sup losers',
  joinMessageDelayMs: 1000,
  swingArm: false,
  profilesFolder: './auth',
  logLevel: 'verbose',
  logFile: './fishbot.log',
  debug: false,
  aim: null,
  chest: undefined
});


if (SILENT_MODE){
    console.log("Silent mode activated.");
    global.console.log = () => {};
}


/**
 * Loads, merges and validates the bot configuration.
 *
 * Defaults are applied before validation so optional keys may be omitted. The legacy
 * `debug: true` flag is treated as `logLevel: "trace"`.
 *
 * @param {string} [configPath=CONFIG_PATH] Path of the JSON config file.
 * @returns {object} Validated configuration.
 * @throws {Error} If the file is missing or a setting is invalid.
 */
function loadConfig(configPath = CONFIG_PATH) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing ${configPath}. Copy config.example.json to config.json and edit it first.`);
  }

  const config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };

  if (config.debug === true) {
    config.logLevel = 'trace';
  }

  for (const key of ['host', 'port', 'username']) {
    if (config[key] === undefined || config[key] === null || config[key] === '') {
      throw new Error(`config.json is missing required setting: ${key}`);
    }
  }

  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('port must be an integer from 1 through 65535.');
  }

  if (!Number.isInteger(config.hotbarSlot) || config.hotbarSlot < 0 || config.hotbarSlot > 8) {
    throw new Error('hotbarSlot must be an integer from 0 through 8. Slot 0 is the left-most hotbar slot.');
  }

  if (typeof config.autoFindRod !== 'boolean') {
    throw new Error('autoFindRod must be true (search the hotbar for a rod) or false (only use hotbarSlot).');
  }

  if (typeof config.joinMessage !== 'string') {
    throw new Error('joinMessage must be a string. Use "" to stay quiet.');
  }

  if (!RAKNET_BACKENDS.includes(config.raknetBackend)) {
    throw new Error(`raknetBackend must be one of: ${RAKNET_BACKENDS.join(', ')}`);
  }

  if (!MODES.includes(config.mode)) {
    throw new Error(`mode must be one of: ${MODES.join(', ')}`);
  }

  if (typeof config.commandPrefix !== 'string' || config.commandPrefix === '' || /\s/.test(config.commandPrefix)) {
    throw new Error('commandPrefix must be a non-empty string without spaces, e.g. "^".');
  }

  if (!Array.isArray(config.commandUsers) || !config.commandUsers.every((name) => typeof name === 'string')) {
    throw new Error('commandUsers must be a list of player names allowed to use chat commands, e.g. ["MyGamertag"]. An empty list disables chat commands.');
  }

  if (!CAST_METHODS.includes(config.castMethod)) {
    throw new Error(`castMethod must be one of: ${CAST_METHODS.join(', ')}`);
  }

  const durations = ['recastDelayMs', 'maxCastMs', 'castConfirmMs', 'hookClaimWindowMs', 'catchAttributionMs', 'noRodRetryMs', 'spawnSettleMs', 'reconnectBaseMs', 'reconnectMaxMs', 'statusIntervalMs', 'joinMessageDelayMs'];
  for (const key of durations) {
    if (!Number.isFinite(config[key]) || config[key] < 0) {
      throw new Error(`${key} must be a non-negative number of milliseconds.`);
    }
  }

  validateAim(config.aim);
  config.chest = loadChestConfig(config.chest);

  return config;
}

/**
 * Validates the optional `aim` setting: null (use the account's saved look), a block to cast at
 * `{x, y, z}`, or explicit angles `{yaw, pitch}`.
 *
 * @param {*} aim The `aim` value from config.json.
 * @throws {Error} If it is malformed.
 */
function validateAim(aim) {
  if (aim === null || aim === undefined) {
    return;
  }

  const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
  const isBlock = ['x', 'y', 'z'].every((axis) => isNum(aim[axis]));
  const isAngles = isNum(aim.yaw) && isNum(aim.pitch) && aim.pitch >= -90 && aim.pitch <= 90;

  if (!isBlock && !isAngles) {
    throw new Error('aim must be null, a spot in the water to cast at like {"x": 190, "y": 62, "z": 112}, or angles like {"yaw": 90, "pitch": 30} (yaw: 0 south, 90 west, 180 north, -90 east; pitch: positive looks down).');
  }
}

/**
 * Picks the RakNet transport for bedrock-protocol.
 *
 * `auto` uses the native `raknet-native` addon when its prebuilt binary loads, otherwise the pure-JS
 * `jsp-raknet`. raknet-native locates prebuilds by kernel major version (e.g. `linux-5-x64`), so on
 * hosts with a newer kernel (most current Linux / Docker / Pterodactyl hosts) it cannot load.
 *
 * @param {string} preference `auto`, `raknet-native`, or `jsp-raknet`.
 * @returns {{backend: string, reason: string}} Chosen backend and why.
 */
function resolveRaknetBackend(preference) {
  if (preference !== 'auto') {
    return { backend: preference, reason: 'set in config' };
  }

  try {
    require('raknet-native');
    return { backend: 'raknet-native', reason: 'native prebuild loaded' };
  } catch (error) {
    return { backend: 'jsp-raknet', reason: `native addon unavailable on this platform (${String(error.message).split('\n')[0]})` };
  }
}

/**
 * Converts Bedrock pitch/yaw angles into a forward direction vector.
 *
 * @param {number} pitch Vertical look angle in degrees.
 * @param {number} yaw Horizontal look angle in degrees.
 * @returns {{x: number, y: number, z: number}} Unit direction vector.
 */
function directionFromRotation(pitch, yaw) {
  const pitchRadians = pitch * Math.PI / 180;
  const yawRadians = yaw * Math.PI / 180;

  return {
    x: -Math.sin(yawRadians) * Math.cos(pitchRadians),
    y: -Math.sin(pitchRadians),
    z: Math.cos(yawRadians) * Math.cos(pitchRadians)
  };
}

/**
 * Normalizes Bedrock integer-like values for comparison.
 *
 * @param {*} value Value that may be a number, bigint, string, or wrapped value.
 * @returns {string|null} Comparable representation, or null when absent.
 */
function entityKey(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === 'object') {
    if ('value' in value) {
      return entityKey(value.value);
    }

    if ('low' in value && 'high' in value) {
      return `${value.high}:${value.low}`;
    }
  }

  return String(value);
}

/**
 * Reads one entry from a Bedrock MetadataDictionary array.
 *
 * @param {Array<{key: string, value: *}>|undefined} metadata Entity metadata entries.
 * @param {string} key Metadata key name, e.g. `owner_eid`.
 * @returns {*} The entry value, or undefined when not present.
 */
function getMetadataValue(metadata, key) {
  if (!Array.isArray(metadata)) {
    return undefined;
  }

  return metadata.find((entry) => entry?.key === key)?.value;
}

/**
 * Formats a vec3 for log output.
 *
 * @param {{x: number, y: number, z: number}} vec Vector.
 * @returns {string} `x, y, z` with one decimal.
 */
function formatVec(vec) {
  return `${Number(vec?.x).toFixed(1)}, ${Number(vec?.y).toFixed(1)}, ${Number(vec?.z).toFixed(1)}`;
}

/**
 * Headless Bedrock AFK fishing client built on bedrock-protocol.
 *
 * Lifecycle: connect -> start_game -> spawn -> cast -> (bite | watchdog | hook lost) -> reel -> cast ...
 *
 * Casting can be sent two ways, selected by `castMethod`:
 * - `transaction`: an `inventory_transaction` item_use/click_air packet (classic method).
 * - `auth_input`: the same use-item data embedded in the next `player_auth_input` with the `item_interact` flag.
 * - `auto`: starts with `transaction`; if the server spawns no hook within `castConfirmMs`, alternates methods until one works.
 */
class FishingBot {
  /**
   * Creates a fishing bot instance.
   *
   * @param {object} config Validated bot configuration from {@link loadConfig}.
   * @param {{createClient: Function}} [protocol=bedrock] bedrock-protocol compatible module (injectable for tests).
   * @param {Logger} [logger] Logger instance; one is created from config when omitted.
   */
  constructor(config, protocol = bedrock, logger = new Logger({ level: config.logLevel, file: config.logFile, baseDir: __dirname })) {
    this.config = config;
    this.protocol = protocol;
    this.log = logger;
    this.client = null;
    this.catchCount = 0;
    this.castCount = 0;
    this.biteCount = 0;
    this.rejectedCasts = 0;
    this.reconnectAttempts = 0;
    this.raknet = resolveRaknetBackend(config.raknetBackend);
    this.castMethod = config.castMethod === 'auto' ? 'transaction' : config.castMethod;
    this.castMethodConfirmed = config.castMethod !== 'auto';
    this.itemNames = new Map();
    this.heartbeatTimer = null;
    this.statusTimer = null;
    this.castWatchdogTimer = null;
    this.castConfirmTimer = null;
    this.recastTimer = null;
    this.reconnectTimer = null;
    this.greetTimer = null;
    this.shuttingDown = false;
    this.chest = config.chest?.enabled ? new ChestDepositor(config.chest, this.createChestHost(), this.log, config.version) : null;
    this.settings = this.createSettings();
    this.commands = this.createCommands();
    this.resetSessionState();
  }

  /**
   * Builds the callbacks the chest depositor uses to act through this bot.
   *
   * `rodSlot` is a live getter, so the depositor always protects whichever hotbar slot the bot
   * is currently fishing with, even after it switches to a spare rod.
   *
   * @returns {import('./chest').ChestHost} Host adapter.
   */
  createChestHost() {
    const bot = this;

    return {
      send: (name, params) => this.send(name, params),
      useItem: (data, method) => this.sendItemUse(data, method),
      preferredMethod: () => this.castMethod,
      inventory: () => this.inventorySlots,
      heldItem: () => this.inventorySlots[this.rodSlot] ?? AIR,
      get rodSlot() {
        return bot.rodSlot;
      },
      position: () => this.position,
      getLook: () => ({ pitch: this.pitch, yaw: this.yaw }),
      setLook: (pitch, yaw) => {
        this.pitch = pitch;
        this.yaw = yaw;
      },
      itemName: (item) => this.itemNames.get(Number(item?.network_id)),
      describeItem: (item) => this.describeItem(item),
      blockIdsAreHashes: () => this.blockIdsAreHashes
    };
  }

  /** Connects the bot and installs packet handlers. */
  connect() {
    this.clearTimers();
    this.resetSessionState();

    const clientOptions = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      offline: this.config.offline,
      version: this.config.version,
      profilesFolder: path.resolve(__dirname, this.config.profilesFolder),
      autoInitPlayer: false,
      raknetBackend: this.raknet.backend,
      onMsaCode: (data) => {
        const message = data?.message || data?.user_code || JSON.stringify(data);
        this.log.info('AUTH', message);
      }
    };

    this.log.info('BOT', `Connecting to ${this.config.host}:${this.config.port} as ${this.config.username} (version ${this.config.version}, offline=${this.config.offline}, raknet=${this.raknet.backend}: ${this.raknet.reason})...`);
    const client = this.protocol.createClient(clientOptions);
    this.client = client;

    const on = (event, handler) => client.on(event, (packet) => {
      if (this.client === client) {
        handler(packet);
      }
    });

    on('packet', (des) => this.log.packetIn(des?.data?.name, des?.data?.params));
    on('join', () => this.log.info('BOT', 'Joined (encryption handshake done). Waiting for start_game...'));
    on('start_game', (packet) => this.handleStartGame(packet));
    on('item_registry', (packet) => this.handleItemRegistry(packet));
    on('play_status', (packet) => this.handlePlayStatus(packet));
    on('text', (packet) => {
      this.log.info('CHAT', `${packet?.source_name ? `<${packet.source_name}> ` : ''}${packet?.message}${packet?.parameters?.length ? ` ${stringify(packet.parameters)}` : ''}`);
      this.handleChat(packet);
    });
    on('move_player', (packet) => this.handleMovePlayer(packet));
    on('correct_player_move_prediction', (packet) => this.handleMoveCorrection(packet));
    on('inventory_content', (packet) => this.handleInventoryContent(packet));
    on('inventory_slot', (packet) => this.handleInventorySlot(packet));
    on('player_hotbar', (packet) => this.handlePlayerHotbar(packet));
    on('add_entity', (packet) => this.handleAddEntity(packet));
    on('remove_entity', (packet) => this.handleRemoveEntity(packet));
    on('move_entity', (packet) => this.trackHook(packet.runtime_entity_id, packet.position));
    on('move_entity_delta', (packet) => this.trackHook(packet.runtime_entity_id, packet));
    on('entity_event', (packet) => this.handleEntityEvent(packet));
    on('add_item_entity', (packet) => this.handleAddItemEntity(packet));
    on('container_open', (packet) => this.chest?.handleContainerOpen(packet));
    on('container_close', (packet) => this.chest?.handleContainerClose(packet));
    on('item_stack_response', (packet) => this.chest?.handleStackResponse(packet));
    on('update_block', (packet) => this.chest?.handleUpdateBlock(packet));
    on('completed_using_item', (packet) => this.log.verbose('FISH', `Server completed item use: item ${this.itemNames.get(Number(packet.used_item_id)) ?? packet.used_item_id}, method ${packet.use_method}`));
    on('update_abilities', (packet) => this.handleUpdateAbilities(packet));
    on('update_attributes', (packet) => this.handleUpdateAttributes(packet));
    on('set_health', (packet) => this.log.info('SELF', `set_health: ${packet.health}`));
    on('set_player_game_type', (packet) => this.log.info('SELF', `Game mode set to ${packet.gamemode}`));
    on('update_player_game_type', (packet) => this.isSelfUnique(packet.player_unique_id) && this.log.info('SELF', `Game mode updated to ${packet.gamemode}`));
    on('respawn', (packet) => this.log.verbose('SELF', `respawn state ${packet.state} at ${formatVec(packet.position)}`));
    on('kick', (packet) => this.log.warn('KICK', packet?.message || stringify(packet)));
    on('close', () => this.handleClose());
    client.on('error', (error) => this.log.error('ERROR', error?.stack || error?.message || String(error)));
  }

  /** Resets state that belongs to one network session. */
  resetSessionState() {
    this.runtimeEntityId = null;
    this.uniqueEntityId = null;
    this.position = { x: 0, y: 0, z: 0 };
    this.pitch = 0;
    this.yaw = 0;
    this.tick = 0n;
    this.inventorySlots = [];
    this.rodSlot = this.config.hotbarSlot;
    this.hookRuntimeId = null;
    this.hookUniqueId = null;
    this.hookPosition = null;
    this.lastCastAt = 0;
    this.lastReelAt = 0;
    this.pendingTeleportAck = false;
    this.pendingItemUses = [];
    this.serverSelectedSlot = null;
    this.blockIdsAreHashes = undefined;
    this.loadingScreenStarted = false;
    this.spawnPending = false;
    this.authInputsSent = 0;
    this.spawned = false;
    this.reeling = false;
    this.chest?.resetSession();
  }

  /** Clears active timers before reconnecting or shutting down. */
  clearTimers() {
    clearInterval(this.heartbeatTimer);
    clearInterval(this.statusTimer);
    clearTimeout(this.castWatchdogTimer);
    clearTimeout(this.castConfirmTimer);
    clearTimeout(this.recastTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.greetTimer);
    clearTimeout(this.bobberReportTimer);
    this.heartbeatTimer = null;
    this.statusTimer = null;
    this.castWatchdogTimer = null;
    this.castConfirmTimer = null;
    this.recastTimer = null;
    this.reconnectTimer = null;
    this.greetTimer = null;
  }

  /**
   * Sends a packet through the client queue and logs it.
   *
   * @param {string} name Packet name.
   * @param {object} params Packet fields.
   * @param {boolean} [routine=false] True for high-frequency packets that only belong in trace logs.
   */
  send(name, params, routine = false) {
    this.log.packetOut(name, params, routine);
    this.client.queue(name, params);
  }

  /**
   * Captures player identity, location and orientation, and resets the input tick.
   *
   * The PlayerAuthInput tick is the client's own simulation counter, which vanilla starts at 0 on
   * join. StartGame's `current_tick` is world age, a different clock; seeding from it makes every
   * input look ~days in the future to server-authoritative movement.
   *
   * @param {object} packet start_game packet.
   */
  handleStartGame(packet) {
    this.uniqueEntityId = packet.entity_id;
    this.runtimeEntityId = packet.runtime_entity_id;
    this.position = packet.player_position || this.position;
    this.pitch = Number(packet.rotation?.x || 0);
    this.yaw = Number(packet.rotation?.z || 0);
    this.applyAim();

    this.tick = 0n;
    this.blockIdsAreHashes = packet.block_network_ids_are_hashes;

    if (Array.isArray(packet.itemstates)) {
      this.handleItemRegistry({ itemstates: packet.itemstates });
    }

    this.log.info('BOT', `start_game: pos ${formatVec(this.position)}, pitch ${this.pitch.toFixed(1)}, yaw ${this.yaw.toFixed(1)}, gamemode ${packet.player_gamemode}, unique id ${entityKey(this.uniqueEntityId)}, runtime id ${entityKey(this.runtimeEntityId)}, world tick ${packet.current_tick} (input ticks start at 0 like vanilla), permission ${packet.permission_level}`);
    this.log.verbose('BOT', `server-auth inventory: ${packet.server_authoritative_inventory}, server-auth block breaking: ${packet.server_authoritative_block_breaking}, engine: ${packet.engine ?? 'n/a'}`);

    if (this.chest) {
      this.log.info('CHEST', `Server block ids are ${packet.block_network_ids_are_hashes ? 'hashed (bot computes chest ids itself)' : 'NOT hashed (bot relies on the server telling it the chest id)'}.`);
    }

    if (this.chest && packet.server_authoritative_inventory === false) {
      this.log.warn('CHEST', 'Server does not report server-authoritative inventory. Chest deposits use item stack requests and may be refused here.');
    }

    this.startLoadingScreen();

    if (this.spawnPending) {
      this.completeSpawn();
    }

    if (packet.player_gamemode === 'spectator' || packet.player_gamemode === 'adventure') {
      this.log.warn('BOT', `Bot is in ${packet.player_gamemode} mode. Fishing rods may not work in this mode.`);
    }
  }

  /**
   * Builds a network-id to item-name map so logs can show real item names.
   *
   * @param {object} packet item_registry packet (or start_game itemstates).
   */
  handleItemRegistry(packet) {
    if (!Array.isArray(packet?.itemstates)) {
      return;
    }

    for (const state of packet.itemstates) {
      this.itemNames.set(Number(state.runtime_id), state.name);
    }

    this.log.verbose('BOT', `Item registry loaded: ${this.itemNames.size} items. fishing_rod id = ${[...this.itemNames].find(([, name]) => name === 'minecraft:fishing_rod')?.[0] ?? 'unknown'}`);
  }

  /**
   * Describes an ItemV4 stack for logs.
   *
   * @param {object} item ItemV4 stack.
   * @returns {string} Human-readable summary.
   */
  describeItem(item) {
    if (!item || item.network_id === 0) {
      return 'air';
    }

    const name = this.itemNames.get(Number(item.network_id)) ?? `id:${item.network_id}`;
    const damage = item.extra?.nbt?.nbt?.value?.Damage?.value;
    return `${name} x${item.count}${item.has_stack_id ? ` stack#${item.stack_id}` : ''}${damage !== undefined ? ` damage=${entityKey(damage)}` : ''}`;
  }

  /**
   * Returns true when a unique entity id refers to this bot.
   *
   * @param {*} id Unique entity id.
   * @returns {boolean} Whether it is the bot.
   */
  isSelfUnique(id) {
    return this.uniqueEntityId !== null && entityKey(id) === entityKey(this.uniqueEntityId);
  }

  /**
   * Logs the bot's permission level and ability layers. A `visitor` level or an active
   * `loading_screen` layer explains servers refusing item use.
   *
   * @param {object} packet update_abilities packet.
   */
  handleUpdateAbilities(packet) {
    if (!this.isSelfUnique(packet.entity_unique_id)) {
      return;
    }

    const layers = (packet.abilities || []).map((layer) => `${layer.type}{enabled:${stringify(layer.enabled)}}`).join(' ');
    this.log.info('SELF', `Abilities: permission=${packet.permission_level}, commands=${packet.command_permission}, layers: ${layers}`);

    if (packet.permission_level === 'visitor') {
      this.log.warn('SELF', 'Bot has VISITOR permission on this server. Visitors cannot use items. Make the account a member (permissions.json or /op) and retry.');
    }

    if ((packet.abilities || []).some((layer) => layer.type === 'loading_screen')) {
      this.log.warn('SELF', 'Server has a loading_screen ability layer on the bot (it thinks the bot is still loading).');
    }
  }

  /**
   * Logs the bot's own health from attribute updates.
   *
   * @param {object} packet update_attributes packet.
   */
  handleUpdateAttributes(packet) {
    if (entityKey(packet.runtime_entity_id) !== entityKey(this.runtimeEntityId)) {
      return;
    }

    const health = (packet.attributes || []).find((attribute) => attribute.name === 'minecraft:health');
    if (health) {
      this.log.verbose('SELF', `Health ${health.current}/${health.max}`);
      if (Number(health.current) <= 0) {
        this.log.warn('SELF', 'Bot health is 0: the server thinks the bot is DEAD. Dead players cannot use items.');
      }
    }
  }

  /** Tells the server the client's loading screen is up, as vanilla does right after start_game. */
  startLoadingScreen() {
    if (this.loadingScreenStarted) {
      return;
    }

    this.loadingScreenStarted = true;
    this.send('serverbound_loading_screen', { type: 1, loading_screen_id: undefined });
  }

  /**
   * Handles play_status. On `player_spawn`, finishes the vanilla join handshake.
   *
   * @param {object} packet play_status packet.
   */
  handlePlayStatus(packet) {
    this.log.verbose('BOT', `play_status: ${packet?.status}`);

    if (packet?.status !== 'player_spawn' || this.spawned) {
      return;
    }

    if (this.runtimeEntityId === null) {
      this.spawnPending = true;
      return;
    }

    this.completeSpawn();
  }

  /**
   * Completes the join exactly like the vanilla client: loading screen END, then
   * set_local_player_as_initialized. Until BDS gets these, it can treat the player as still loading
   * and roll back item use. bedrock-protocol's auto-init skips the loading-screen packets, so it is disabled.
   */
  completeSpawn() {
    this.spawnPending = false;
    this.startLoadingScreen();
    this.send('serverbound_loading_screen', { type: 2, loading_screen_id: undefined });
    this.send('set_local_player_as_initialized', { runtime_entity_id: this.runtimeEntityId });
    this.log.info('BOT', 'Sent loading-screen end + player initialized (vanilla join handshake).');
    this.handleSpawn();
  }

  /** Starts heartbeat traffic and begins fishing once the world has settled. */
  handleSpawn() {
    if (this.spawned) {
      return;
    }

    this.spawned = true;
    this.reconnectAttempts = 0;
    this.log.info('BOT', `Spawned. Fishing starts in ${this.config.spawnSettleMs} ms. Cast method: ${this.config.castMethod}${this.config.castMethod === 'auto' ? ` (trying ${this.castMethod} first)` : ''}.`);
    this.startHeartbeat();
    this.startStatusReports();
    this.chest?.checkReach(this.position);
    this.scheduleCast(this.config.spawnSettleMs);

    this.log.info('BOT', `Mode: ${this.config.mode}.${this.config.commandUsers.length ? ` Chat commands (${this.config.commandPrefix}help) enabled for: ${this.config.commandUsers.join(', ')}.` : ' Chat commands are off: add player names to commandUsers in config.json to enable them.'}`);

    if (this.config.joinMessage) {
      this.greetTimer = setTimeout(() => this.sendChat(this.config.joinMessage), this.config.joinMessageDelayMs);
    }
  }

  /**
   * Sends a public chat message as the bot.
   *
   * @param {string} message Chat text.
   */
  sendChat(message) {
    if (!this.client || !this.spawned) {
      return;
    }

    try {
      this.send('text', {
        needs_translation: false,
        category: 'authored',
        type: 'chat',
        source_name: this.client.profile?.name || this.config.username,
        message,
        xuid: this.client.profile?.xuid ? String(this.client.profile.xuid) : '',
        platform_chat_id: '',
        has_filtered_message: false
      });
      this.log.info('CHAT', `Sent: ${message}`);
    } catch (error) {
      this.log.error('CHAT', `Could not send chat: ${error.message}`);
    }
  }

  /**
   * Tracks authoritative position changes for the bot itself and flags teleports for acknowledgement.
   *
   * @param {object} packet move_player packet.
   */
  handleMovePlayer(packet) {
    if (entityKey(packet.runtime_id) !== entityKey(this.runtimeEntityId)) {
      return;
    }

    if (packet.position) {
      this.position = packet.position;
    }

    const teleported = packet.mode === 'teleport' || packet.mode === 'reset';

    if (teleported && packet.pitch !== undefined) {
      this.pitch = Number(packet.pitch);
    }

    if (teleported && packet.yaw !== undefined) {
      this.yaw = Number(packet.yaw);
    }

    if (teleported) {
      this.pendingTeleportAck = true;
      this.applyAim();
    }

    this.log.verbose('MOVE', `Server moved bot (${packet.mode}) to ${formatVec(this.position)}, pitch ${this.pitch.toFixed(1)}, yaw ${this.yaw.toFixed(1)}`);
  }

  /**
   * Points the bot where `aim` says (a water block or explicit angles). Without `aim` the account's saved look is kept.
   */
  applyAim() {
    const aim = this.config.aim;
    if (!aim) {
      return;
    }

    const look = Number.isFinite(aim.yaw) ? { yaw: aim.yaw, pitch: aim.pitch } : lookAtBlock(this.position, aim);
    this.yaw = look.yaw;
    this.pitch = look.pitch;
    this.log.info('BOT', `Aiming ${Number.isFinite(aim.yaw) ? 'at the configured angles' : `at block ${aim.x}, ${aim.y}, ${aim.z}`}: yaw ${look.yaw.toFixed(1)}, pitch ${look.pitch.toFixed(1)}.`);
  }

  /**
   * Adopts server-side position corrections so the heartbeat stops fighting server-authoritative movement.
   *
   * @param {object} packet correct_player_move_prediction packet.
   */
  handleMoveCorrection(packet) {
    if (packet.prediction_type !== 'player' || !packet.position) {
      return;
    }

    this.position = packet.position;
    this.log.verbose('MOVE', `Server corrected position to ${formatVec(packet.position)} (tick ${packet.tick})`);
  }

  /**
   * Saves inventory contents so the exact ItemV4 object can be sent back when using the rod.
   *
   * @param {object} packet inventory_content packet.
   */
  handleInventoryContent(packet) {
    if (!this.isPlayerInventoryWindow(packet.window_id)) {
      this.log.trace('INV', `inventory_content for window ${packet.window_id} (${packet.input?.length ?? 0} slots)`);
      this.chest?.handleWindowContent(packet);
      return;
    }

    if (Array.isArray(packet.input)) {
      this.inventorySlots = packet.input.slice();

      if (this.lastCastAt && this.hookRuntimeId === null && Date.now() - this.lastCastAt < 500) {
        this.log.warn('FISH', `Server REJECTED cast #${this.castCount} (${this.castMethod}): it rolled back the inventory ${Date.now() - this.lastCastAt} ms after the cast.`);
      }

      const hotbar = this.inventorySlots.slice(0, 9).map((item, index) => `${index}:${this.describeItem(item)}`).join(' | ');
      this.log.verbose('INV', `Inventory received (${this.inventorySlots.length} slots). Hotbar: ${hotbar}`);
      this.checkRodSlot();
    }
  }

  /**
   * Tracks which hotbar slot the server thinks is selected so slot switches are only sent when needed.
   *
   * @param {object} packet player_hotbar packet.
   */
  handlePlayerHotbar(packet) {
    if (!this.isPlayerInventoryWindow(packet.window_id)) {
      return;
    }

    this.serverSelectedSlot = packet.selected_slot;
    this.log.verbose('INV', `Server says selected hotbar slot is ${packet.selected_slot}.`);
  }

  /**
   * Applies individual inventory slot updates.
   *
   * @param {object} packet inventory_slot packet.
   */
  handleInventorySlot(packet) {
    if (!this.isPlayerInventoryWindow(packet.window_id)) {
      this.chest?.handleWindowSlot(packet);
      return;
    }

    this.inventorySlots[packet.slot] = packet.item;

    if (packet.slot === this.rodSlot) {
      this.log.verbose('INV', `Rod slot ${packet.slot} updated by server: ${this.describeItem(packet.item)}`);
      if (this.config.autoFindRod && !this.isRod(packet.item)) {
        this.log.warn('INV', `Rod in hotbar slot ${packet.slot} is gone (broke or was moved). Will look for another rod on the next cast.`);
      }
    } else {
      this.log.trace('INV', `Slot ${packet.slot} updated: ${this.describeItem(packet.item)}`);
    }
  }

  /** Logs which hotbar slot will be fished with, or why none can be. Runs whenever the full inventory arrives. */
  checkRodSlot() {
    try {
      const slot = this.locateRod();
      const item = this.inventorySlots[slot];
      const name = this.itemNames.get(Number(item?.network_id));

      if (name && name !== ROD_ITEM_NAME) {
        this.log.warn('INV', `Hotbar slot ${slot} holds ${name}, not ${ROD_ITEM_NAME}. Fix hotbarSlot in config.json or set autoFindRod to true.`);
      } else {
        this.log.info('INV', `Rod slot ${slot}: ${this.describeItem(item)}`);
      }
    } catch (error) {
      this.log.warn('INV', error.message);
    }
  }

  /**
   * Returns true when a stack is a fishing rod, matched by registry name (numeric ids vary by version/server).
   *
   * @param {object|undefined} item ItemV4 stack.
   * @returns {boolean} Whether the stack is a usable fishing rod.
   */
  isRod(item) {
    if (!item || item.network_id === 0 || item.count === 0) {
      return false;
    }

    return this.itemNames.get(Number(item.network_id)) === ROD_ITEM_NAME;
  }

  /**
   * Scans the hotbar for a fishing rod.
   *
   * Search order keeps the bot from flip-flopping between rods: the slot it is already using first,
   * then the configured `hotbarSlot`, then slots 0-8 left to right.
   *
   * @returns {number} Hotbar slot (0-8) holding a rod, or -1 when the hotbar has none.
   */
  findRodSlot() {
    const order = [this.rodSlot, this.config.hotbarSlot];
    for (let slot = 0; slot < HOTBAR_SIZE; slot += 1) {
      order.push(slot);
    }

    return order.find((slot) => this.isRod(this.inventorySlots[slot])) ?? -1;
  }

  /**
   * Points {@link FishingBot#rodSlot} at a hotbar slot that holds a rod.
   *
   * With `autoFindRod` off, the configured `hotbarSlot` is used as-is (old behavior: whatever item is
   * there gets used). With it on, the hotbar is searched and the switch is logged.
   *
   * @returns {number} The hotbar slot to fish with.
   * @throws {Error} If no usable rod is available.
   */
  locateRod() {
    if (!this.inventorySlots.length) {
      throw new Error('Inventory NOT received from the server yet.');
    }

    if (!this.config.autoFindRod) {
      const item = this.inventorySlots[this.config.hotbarSlot];
      if (!item || item.network_id === 0 || item.count === 0) {
        throw new Error(`Hotbar slot ${this.config.hotbarSlot} (slot ${this.config.hotbarSlot + 1} counting from 1) is EMPTY. Put the fishing rod there.`);
      }

      this.rodSlot = this.config.hotbarSlot;
      return this.rodSlot;
    }

    const slot = this.findRodSlot();
    if (slot === -1) {
      throw new Error(this.describeMissingRod());
    }

    if (slot !== this.rodSlot) {
      this.log.info('INV', `Found a fishing rod in hotbar slot ${slot} (slot ${slot + 1} counting from 1); switching to it from slot ${this.rodSlot}.`);
      this.rodSlot = slot;
    }

    return this.rodSlot;
  }

  /**
   * Explains why no rod was found, pointing out rods stuck in the main inventory where the bot can't select them.
   *
   * @returns {string} Human-readable reason.
   */
  describeMissingRod() {
    const backpackRods = [];
    for (let slot = HOTBAR_SIZE; slot < Math.min(this.inventorySlots.length, PLAYER_INVENTORY_SIZE); slot += 1) {
      if (this.isRod(this.inventorySlots[slot])) {
        backpackRods.push(slot);
      }
    }

    if (backpackRods.length) {
      return `No fishing rod in the hotbar, but inventory slot(s) ${backpackRods.join(', ')} have one. Drag a rod into the hotbar (slots 1-9).`;
    }

    return 'No fishing rod anywhere in the hotbar (or inventory). Give the bot a rod.';
  }

  /**
   * Determines whether a packet targets the player's main inventory window.
   *
   * @param {*} windowId Window identifier.
   * @returns {boolean} True for the main inventory.
   */
  isPlayerInventoryWindow(windowId) {
    return windowId === 'inventory' || windowId === 0 || windowId === 0n;
  }

  /**
   * Determines whether a newly spawned fishing hook belongs to this bot.
   *
   * Uses the hook's `owner_eid` metadata when the server provides it, falling back to the
   * time window right after this bot's cast.
   *
   * @param {object} packet add_entity packet for a fishing hook.
   * @returns {boolean} True if the hook should be treated as ours.
   */
  isOwnHook(packet) {
    if (this.hookRuntimeId !== null) {
      return false;
    }

    const owner = getMetadataValue(packet.metadata, 'owner_eid');
    if (owner !== undefined && this.uniqueEntityId !== null) {
      return entityKey(owner) === entityKey(this.uniqueEntityId);
    }

    return this.lastCastAt > 0 && Date.now() - this.lastCastAt <= this.config.hookClaimWindowMs;
  }

  /**
   * Records the fishing hook spawned by this bot's cast and confirms the cast method works.
   *
   * @param {object} packet add_entity packet.
   */
  handleAddEntity(packet) {
    if (packet.entity_type !== 'minecraft:fishing_hook') {
      return;
    }

    const owner = getMetadataValue(packet.metadata, 'owner_eid');
    this.log.verbose('FISH', `fishing_hook spawned: runtime ${entityKey(packet.runtime_id)}, unique ${entityKey(packet.unique_id)}, owner ${entityKey(owner) ?? 'n/a'} (we are ${entityKey(this.uniqueEntityId)}), at ${formatVec(packet.position)}, ${this.lastCastAt ? `${Date.now() - this.lastCastAt} ms after our cast` : 'no cast pending'}`);
    this.log.trace('FISH', `fishing_hook add_entity: ${stringify(packet)}`);

    if (this.reeling || !this.isOwnHook(packet)) {
      this.log.verbose('FISH', 'Not our hook (or already have one). Ignoring.');
      return;
    }

    this.hookRuntimeId = packet.runtime_id;
    this.hookUniqueId = packet.unique_id;
    this.hookPosition = { ...packet.position };
    clearTimeout(this.castConfirmTimer);
    clearTimeout(this.bobberReportTimer);
    this.bobberReportTimer = setTimeout(() => this.reportBobber(), 2500);

    if (!this.castMethodConfirmed) {
      this.castMethodConfirmed = true;
      this.log.info('FISH', `Cast method "${this.castMethod}" works on this server. Locking it in.`);
    }

    this.log.info('FISH', `Hook is in the water (runtime ${entityKey(this.hookRuntimeId)}). Waiting for a bite...`);
  }

  /**
   * Records the latest position of this bot's hook from move_entity / move_entity_delta.
   *
   * @param {*} runtimeId Entity runtime id from the packet.
   * @param {{x?: number, y?: number, z?: number}|undefined} position New absolute coordinates (delta packets may omit axes).
   */
  trackHook(runtimeId, position) {
    if (this.hookRuntimeId === null || !position || entityKey(runtimeId) !== entityKey(this.hookRuntimeId)) {
      return;
    }

    for (const axis of ['x', 'y', 'z']) {
      if (Number.isFinite(position[axis])) {
        this.hookPosition[axis] = position[axis];
      }
    }
  }

  /** Logs where the bobber ended up after a cast, so a hook stuck on a block can be found. */
  reportBobber() {
    if (this.hookRuntimeId === null || !this.hookPosition) {
      return;
    }

    const p = this.hookPosition;
    const block = `${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}`;
    const distance = Math.hypot(p.x - this.position.x, p.z - this.position.z);
    this.log.info('FISH', `Bobber landed at ${formatVec(p)} (block ${block}), ${distance.toFixed(1)} blocks out.${distance < 2 ? ' That is right in front of him: it is probably stuck on a block, not in the water.' : ''}`);
  }

  /**
   * Recasts when this bot's hook disappears without a reel (snagged, out of range, killed, etc.).
   *
   * @param {object} packet remove_entity packet.
   */
  handleRemoveEntity(packet) {
    if (this.hookUniqueId === null || entityKey(packet.entity_id_self) !== entityKey(this.hookUniqueId)) {
      return;
    }

    this.hookRuntimeId = null;
    this.hookUniqueId = null;

    if (this.reeling) {
      this.log.verbose('FISH', 'Hook removed after reel (expected).');
      return;
    }

    if (this.config.mode === 'auto') {
      // The autofisher reeled it in. Stamp the reel time so the loot that follows still counts as our catch.
      this.lastReelAt = Date.now();
      this.log.info('FISH', 'Hook is gone (the autofisher reeled it in). Recasting.');
      clearTimeout(this.castWatchdogTimer);
      this.scheduleCast(this.config.recastDelayMs);
      return;
    }

    this.log.warn('FISH', 'Hook vanished without a bite. Recasting.');
    clearTimeout(this.castWatchdogTimer);
    this.scheduleCast(this.config.recastDelayMs);
  }

  /**
   * Reels in when Bedrock reports the hook event that indicates a bite.
   *
   * @param {object} packet entity_event packet.
   */
  handleEntityEvent(packet) {
    const isOurHook = this.hookRuntimeId !== null && entityKey(packet.runtime_entity_id) === entityKey(this.hookRuntimeId);

    if (String(packet.event_id).startsWith('fish_hook')) {
      this.log.verbose('FISH', `entity_event ${packet.event_id} on ${entityKey(packet.runtime_entity_id)}${isOurHook ? ' (OUR hook)' : ''}`);
    }

    if (!isOurHook || packet.event_id !== 'fish_hook_hook') {
      return;
    }

    this.biteCount += 1;

    if (this.config.mode === 'auto') {
      this.log.info('FISH', 'BITE! Autofisher mode: leaving the reel-in to the autofisher.');
      return;
    }

    this.log.info('FISH', 'BITE! Reeling in.');
    this.reel();
  }

  /**
   * Counts fishing loot that appears shortly after this bot reels in.
   *
   * @param {object} packet add_item_entity packet.
   */
  handleAddItemEntity(packet) {
    if (!packet.is_from_fishing) {
      return;
    }

    if (this.lastReelAt === 0 || Date.now() - this.lastReelAt > this.config.catchAttributionMs) {
      this.log.verbose('FISH', `Someone else's fishing loot: ${this.describeItem(packet.item)}`);
      return;
    }

    this.catchCount += 1;
    this.chest?.noteCatch();
    this.log.info('FISH', `Caught ${this.describeItem(packet.item)}. Total catches: ${this.catchCount}`);
  }

  /** Sends one player_auth_input packet every game tick (50 ms) to keep the headless client alive. */
  startHeartbeat() {
    clearInterval(this.heartbeatTimer);

    this.heartbeatTimer = setInterval(() => {
      if (!this.client || !this.spawned) {
        return;
      }

      this.tick += 1n;
      const inputData = [];
      const params = {
        pitch: this.pitch,
        yaw: this.yaw,
        position: this.position,
        move_vector: { x: 0, z: 0 },
        head_yaw: this.yaw,
        input_data: inputData,
        input_mode: 'mouse',
        play_mode: 'normal',
        interaction_model: 'crosshair',
        interact_rotation: { x: this.pitch, z: this.yaw },
        tick: this.tick,
        delta: { x: 0, y: 0, z: 0 },
        analogue_move_vector: { x: 0, z: 0 },
        camera_orientation: directionFromRotation(this.pitch, this.yaw),
        raw_move_vector: { x: 0, z: 0 }
      };

      if (this.pendingTeleportAck) {
        inputData.push('handled_teleport');
        this.pendingTeleportAck = false;
      }

      const itemUse = this.pendingItemUses.shift();
      if (itemUse) {
        inputData.push('item_interact');
        params.transaction = {
          legacy: { legacy_request_id: 0, legacy_transactions: undefined },
          actions: [],
          data: itemUse
        };
      }

      try {
        this.send('player_auth_input', params, inputData.length === 0 && this.authInputsSent > 0);
        this.authInputsSent += 1;
      } catch (error) {
        this.log.error('NET', `player_auth_input failed: ${error.message}`);
      }
    }, 50);
  }

  /** Logs a one-line status summary periodically so a stuck bot is obvious. */
  startStatusReports() {
    clearInterval(this.statusTimer);

    if (this.config.statusIntervalMs === 0) {
      return;
    }

    this.statusTimer = setInterval(() => {
      const state = this.chest?.busy ? 'depositing' : this.reeling ? 'reeling' : this.hookRuntimeId !== null ? 'waiting for bite' : this.lastCastAt ? 'cast sent, no hook yet' : 'idle';
      this.log.info('STATUS', `mode=${this.config.mode} state=${state} method=${this.castMethod}${this.castMethodConfirmed ? '(confirmed)' : '(unconfirmed)'} casts=${this.castCount} rejected=${this.rejectedCasts} bites=${this.biteCount} catches=${this.catchCount}${this.chest ? ` stored=${this.chest.itemsStored} free=${this.chest.freeSlots()}` : ''} heartbeats=${this.authInputsSent} pos=${formatVec(this.position)}`);
    }, this.config.statusIntervalMs);
  }

  /**
   * Returns the exact inventory stack of the rod, searching the hotbar first when `autoFindRod` is on.
   *
   * @returns {object} ItemV4 rod stack as last sent by the server.
   * @throws {Error} If no usable rod is available.
   */
  getRodItem() {
    return this.inventorySlots[this.locateRod()];
  }

  /**
   * Selects the rod's hotbar slot using the exact server-supplied item stack.
   *
   * Like vanilla, the slot switch is only sent when the server's selected slot differs.
   */
  selectRod() {
    const item = this.getRodItem();

    if (this.serverSelectedSlot === this.rodSlot) {
      return;
    }

    this.log.verbose('INV', `Selecting hotbar slot ${this.rodSlot} (server had ${this.serverSelectedSlot ?? 'unknown'}).`);
    this.serverSelectedSlot = this.rodSlot;
    this.send('mob_equipment', {
      runtime_entity_id: this.runtimeEntityId,
      item,
      slot: this.rodSlot,
      selected_slot: this.rodSlot,
      window_id: 'inventory'
    });
  }

  /**
   * Builds the use-item (click air) payload shared by both cast methods.
   *
   * Field values mirror what the vanilla 1.26.51 client sends for an air use of an item with no
   * hold/throw behavior (fishing rod): trigger `unknown`, prediction `failure`, face 255, zero block
   * and click positions, no legacy slots and no inventory actions. BDS validates against vanilla.
   *
   * @param {object} item ItemV4 rod stack.
   * @returns {object} TransactionUseItem fields.
   */
  buildUseItemData(item) {
    return {
      action_type: 'click_air',
      trigger_type: 'unknown',
      block_position: { x: 0, y: 0, z: 0 },
      face: 255,
      hotbar_slot: this.rodSlot,
      hand: 'main_hand',
      held_item: item,
      player_pos: this.position,
      click_pos: { x: 0, y: 0, z: 0 },
      block_runtime_id: 0,
      client_prediction: 'failure',
      client_cooldown_state: 'off'
    };
  }

  /**
   * Sends use-item data either as an `inventory_transaction` or queued into the next `player_auth_input`.
   *
   * @param {object} data TransactionUseItem fields.
   * @param {string} method `transaction` or `auth_input`.
   */
  sendItemUse(data, method) {
    if (method === 'auth_input') {
      this.pendingItemUses.push(data);
      this.log.verbose('NET', `Use-item (${data.action_type}) queued into next player_auth_input (item_interact).`);
      return;
    }

    this.send('inventory_transaction', {
      transaction: {
        legacy: { legacy_request_id: 0, legacy_transactions: undefined },
        transaction_type: 'item_use',
        actions: [],
        transaction_data: data
      }
    });
  }

  /** Uses the selected rod with the active cast method. Sends an arm swing only when `swingArm` is on (vanilla doesn't for rods). */
  useRod() {
    this.sendItemUse(this.buildUseItemData(this.getRodItem()), this.castMethod);

    if (this.config.swingArm) {
      this.send('animate', {
        action_id: 'swing_arm',
        runtime_entity_id: this.runtimeEntityId,
        data: 0,
        has_swing_source: false
      });
    }
  }

  /**
   * Schedules the next cast, replacing any pending one.
   *
   * @param {number} delayMs Delay before casting.
   */
  scheduleCast(delayMs) {
    clearTimeout(this.recastTimer);
    this.recastTimer = setTimeout(() => {
      this.recastTimer = null;
      this.reeling = false;
      this.startCastCycle();
    }, delayMs);
  }

  /** Empties loot into the chest first when a deposit is due, then casts. Auto mode skips deposits: the autofisher collects the loot. */
  startCastCycle() {
    const reason = this.spawned && this.config.mode !== 'auto' ? this.chest?.dueReason() : null;

    if (!reason) {
      this.cast();
      return;
    }

    const client = this.client;
    try {
      this.selectRod();
    } catch (error) {
      this.log.verbose('CHEST', `Could not select rod slot before depositing: ${error.message}`);
    }

    this.chest.run(reason).then(() => {
      if (this.client === client && this.spawned && !this.shuttingDown) {
        this.cast();
      }
    });
  }

  /** Casts the rod, arms the hook-confirmation check and the bite watchdog. Retries later if the rod is missing. */
  cast() {
    if (!this.spawned || this.reeling || this.chest?.busy) {
      return;
    }

    if (this.config.mode === 'auto' && this.hookRuntimeId !== null) {
      this.log.verbose('FISH', 'Autofisher mode: our hook is still out, not casting (using the rod would reel it in).');
      return;
    }

    clearTimeout(this.castWatchdogTimer);
    clearTimeout(this.castConfirmTimer);
    this.hookRuntimeId = null;
    this.hookUniqueId = null;

    try {
      this.selectRod();
      this.lastCastAt = Date.now();
      this.useRod();
    } catch (error) {
      this.lastCastAt = 0;
      this.log.error('FISH', `Cast failed: ${error.message} Retrying in ${Math.round(this.config.noRodRetryMs / 1000)}s.`);
      this.scheduleCast(this.config.noRodRetryMs);
      return;
    }

    this.castCount += 1;
    this.log.info('FISH', `Cast #${this.castCount} via ${this.castMethod} at ${formatVec(this.position)}, pitch ${this.pitch.toFixed(1)}, yaw ${this.yaw.toFixed(1)}.`);

    this.castConfirmTimer = setTimeout(() => this.handleCastNotConfirmed(), this.config.castConfirmMs);
    this.armCastWatchdog();
  }

  /**
   * Arms the "no bite for maxCastMs" recovery reel. Does nothing in auto mode: an autofisher can
   * legitimately leave the hook out for a long time, and reeling it in ourselves would fight it.
   */
  armCastWatchdog() {
    clearTimeout(this.castWatchdogTimer);

    if (this.config.mode === 'auto') {
      return;
    }

    this.castWatchdogTimer = setTimeout(() => {
      this.log.warn('FISH', `No bite in ${Math.round(this.config.maxCastMs / 1000)}s. Reeling/recasting in case the hook got stuck.`);
      this.reel(true);
    }, this.config.maxCastMs);
  }

  /**
   * Applies a mode change at runtime. Casting and bite handling read `config.mode` live, so only the
   * watchdog needs to follow: off in auto mode, re-armed in manual mode if a hook is already out.
   *
   * @param {string} mode `manual` or `auto`.
   */
  applyMode(mode) {
    this.log.info('BOT', `Mode set to ${mode}${mode === 'auto' ? ': the bot will not reel in, only recast when its hook is gone' : ': the bot will reel in on bites'}.`);

    if (mode === 'auto') {
      clearTimeout(this.castWatchdogTimer);
    } else if (this.spawned && this.hookRuntimeId !== null && !this.reeling) {
      this.armCastWatchdog();
    }
  }

  /**
   * Declares which settings can be changed from chat. To make another config key chat-configurable,
   * add one `define()` here (and optionally list it in `shortcuts` in {@link FishingBot#createCommands}
   * to give it its own command like `^mode`).
   *
   * @returns {SettingsRegistry} Registry bound to the live config.
   */
  createSettings() {
    const ms = settingTypes.number({ min: 0, integer: true });

    return new SettingsRegistry(this.config)
      .define({ key: 'mode', type: settingTypes.enum(MODES), description: 'manual = reel in on bites; auto = autofisher reels, bot only recasts', apply: (value) => this.applyMode(value) })
      .define({ key: 'yaw', type: settingTypes.number({ min: -360, max: 360 }), description: 'Cast direction in degrees (0 south, 90 west, 180 north, -90 east). Applies from the next cast', ...this.aimSetting('yaw') })
      .define({ key: 'pitch', type: settingTypes.number({ min: -90, max: 90 }), description: 'Cast angle in degrees (positive looks down). Applies from the next cast', ...this.aimSetting('pitch') })
      .define({ key: 'recastDelayMs', type: ms, description: 'Pause between a reel/hook loss and the next cast' })
      .define({ key: 'maxCastMs', type: ms, description: 'Manual mode: no-bite time before a recovery reel', apply: () => this.spawned && this.hookRuntimeId !== null && !this.reeling && this.armCastWatchdog() })
      .define({ key: 'castConfirmMs', type: ms, description: 'How long to wait for the hook before calling a cast ignored' })
      .define({ key: 'noRodRetryMs', type: ms, description: 'Retry interval when there is no rod' })
      .define({ key: 'hotbarSlot', type: settingTypes.number({ min: 0, max: 8, integer: true }), description: 'Rod slot, 0 = left-most', apply: (value) => { this.rodSlot = value; } })
      .define({ key: 'autoFindRod', type: settingTypes.boolean(), description: 'Search the hotbar for a rod instead of only using hotbarSlot' })
      .define({ key: 'swingArm', type: settingTypes.boolean(), description: 'Send an arm swing with each cast' })
      .define({ key: 'castMethod', type: settingTypes.enum(CAST_METHODS), description: 'auto, transaction or auth_input', apply: (value) => { this.castMethod = value === 'auto' ? 'transaction' : value; this.castMethodConfirmed = value !== 'auto'; } })
      .define({ key: 'statusIntervalMs', type: ms, description: 'Status line interval, 0 = off', apply: () => this.spawned && this.startStatusReports() })
      .define({ key: 'logLevel', type: settingTypes.enum(Object.keys(LEVELS).filter((name) => name !== 'fatal')), description: 'error, warn, info, verbose or trace', apply: (value) => this.log.setLevel(value) });
  }

  /**
   * Accessors that let `yaw` / `pitch` act as settings even though config.json stores them as `aim`.
   *
   * Reading gives the bot's current look. Writing turns `aim` into explicit angles (replacing a block
   * target, if there was one) and points the bot there; the heartbeat and the next cast pick it up.
   * Saving writes `aim: {yaw, pitch}` to config.json.
   *
   * @param {'yaw'|'pitch'} axis Which angle.
   * @returns {{read: Function, write: Function, persist: Function}} Accessors for {@link SettingsRegistry#define}.
   */
  aimSetting(axis) {
    const round = (value) => Number(Number(value).toFixed(3));

    return {
      read: () => round(this[axis]),
      write: (value) => {
        this[axis] = value;
        this.config.aim = { yaw: this.yaw, pitch: this.pitch };
      },
      persist: (onDisk) => {
        onDisk.aim = { yaw: round(this.yaw), pitch: round(this.pitch) };
      }
    };
  }

  /**
   * Builds the chat command router. To add a command, `register()` it here; to add a setting, see
   * {@link FishingBot#createSettings}.
   *
   * @returns {CommandRouter} Router for the configured prefix.
   */
  createCommands() {
    const router = new CommandRouter(this.config.commandPrefix);

    registerBuiltinCommands(router, this.settings, { configPath: CONFIG_PATH, shortcuts: ['mode', 'yaw', 'pitch'] });

    router.register({
      name: 'status',
      description: 'Mode, state and catch counters',
      run: () => {
        const state = this.chest?.busy ? 'depositing' : this.reeling ? 'reeling' : this.hookRuntimeId !== null ? 'waiting for bite' : this.lastCastAt ? 'cast sent, no hook yet' : 'idle';
        return `mode=${this.config.mode} state=${state} casts=${this.castCount} bites=${this.biteCount} catches=${this.catchCount}${this.chest ? ` stored=${this.chest.itemsStored}` : ''}`;
      }
    });

    return router;
  }

  /** True when a player is listed in `commandUsers` (case-insensitive). */
  isCommandUser(name) {
    return this.config.commandUsers.some((allowed) => allowed.toLowerCase() === String(name).toLowerCase());
  }

  /**
   * Runs a chat command from an allowed player. Everyone else's `^...` messages are ignored, because
   * anyone on the server can type in chat.
   *
   * @param {object} packet text packet.
   */
  handleChat(packet) {
    const sender = packet?.source_name;
    const message = packet?.message;

    if (!sender || (packet.type !== 'chat' && packet.type !== 'whisper') || !this.commands.isCommand(message)) {
      return;
    }

    if (sender === (this.client?.profile?.name || this.config.username)) {
      return;
    }

    if (!this.isCommandUser(sender)) {
      this.log.warn('CMD', `Ignored command from ${sender} (not in commandUsers): ${message}`);
      return;
    }

    this.log.info('CMD', `${sender}: ${message}`);
    this.commands.dispatch(message, { sender })
      .then((lines) => this.replyLines(lines))
      .catch((error) => {
        this.log.error('CMD', `Command failed: ${error.stack || error.message}`);
        this.replyLines([`Command failed: ${error.message}`]);
      });
  }

  /**
   * Sends reply lines to chat, spaced out so the server's chat rate limiting doesn't swallow them.
   *
   * @param {string[]} lines Reply lines.
   */
  replyLines(lines) {
    lines.forEach((line, index) => setTimeout(() => this.sendChat(line), index * 400));
  }

  /** Handles a cast that produced no hook: logs diagnostics and, in auto mode, switches cast method. */
  handleCastNotConfirmed() {
    if (this.hookRuntimeId !== null || this.reeling || !this.spawned) {
      return;
    }

    this.rejectedCasts += 1;
    clearTimeout(this.castWatchdogTimer);
    this.log.warn('FISH', `No hook appeared ${this.config.castConfirmMs} ms after cast #${this.castCount} via ${this.castMethod}. The server rejected or ignored the use-item.`);

    if (this.config.castMethod === 'auto' && !this.castMethodConfirmed) {
      this.castMethod = this.castMethod === 'transaction' ? 'auth_input' : 'transaction';
      this.log.warn('FISH', `Auto mode: switching cast method to "${this.castMethod}".`);
    }

    if (this.rejectedCasts === 4) {
      this.log.error('FISH', 'Both cast methods have been ignored. Check: bot is in survival/creative (not adventure/spectator), not in a protected/spawn area, the rod slot is right, and nothing (e.g. a block) is directly in front of it. Send fishbot.log for analysis.');
    }

    this.lastCastAt = 0;
    this.scheduleCast(this.config.recastDelayMs);
  }

  /**
   * Reels in and schedules the next cast.
   *
   * @param {boolean} [watchdog=false] True when invoked as timeout recovery.
   */
  reel(watchdog = false) {
    if (!this.spawned || this.reeling) {
      return;
    }

    this.reeling = true;
    clearTimeout(this.castWatchdogTimer);
    clearTimeout(this.castConfirmTimer);

    try {
      this.useRod();
      this.lastReelAt = Date.now();
      this.log.verbose('FISH', watchdog ? 'Recovery reel sent.' : 'Reel sent.');
    } catch (error) {
      this.log.error('FISH', `Reel failed: ${error.message}`);
    }

    this.hookRuntimeId = null;
    this.hookUniqueId = null;
    this.scheduleCast(this.config.recastDelayMs);
  }

  /** Reconnects with exponential backoff after an unexpected network close. */
  handleClose() {
    this.log.warn('BOT', 'Connection closed.');
    this.clearTimers();
    this.chest?.abort('connection closed');
    this.spawned = false;

    if (this.shuttingDown) {
      return;
    }

    const delay = Math.min(this.config.reconnectBaseMs * 2 ** this.reconnectAttempts, this.config.reconnectMaxMs);
    this.reconnectAttempts += 1;
    this.log.info('BOT', `Reconnecting in ${Math.round(delay / 1000)} seconds...`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** Shuts down timers, closes the protocol client, and exits even if a native handle lingers. */
  shutdown() {
    if (this.shuttingDown) {
      process.exit(0);
    }

    this.shuttingDown = true;
    this.clearTimers();
    this.log.info('BOT', `Shutting down. Casts=${this.castCount} bites=${this.biteCount} catches=${this.catchCount}${this.chest ? ` stored=${this.chest.itemsStored}` : ''}.`);
    this.chest?.abort('shutting down');

    try {
      this.client?.disconnect('AFK fisher shutting down');
    } catch (error) {
      this.log.error('BOT', `Disconnect failed: ${error.message}`);
    }

    this.log.close();
    setTimeout(() => process.exit(0), 1000).unref();
  }
}

/** Entry point: loads config, starts the bot, and wires shutdown signals. */
function main() {
  const config = loadConfig();
  const bot = new FishingBot(config);
  const protocolVersion = require('bedrock-protocol/package.json').version;

  bot.log.info('BOT', `bedrock-afk-fisher starting. Node ${process.version}, bedrock-protocol ${protocolVersion}, logLevel=${config.logLevel}${bot.log.filePath ? `, logging to ${bot.log.filePath}` : ''}`);
  bot.log.verbose('BOT', `Config: ${stringify({ ...config, profilesFolder: config.profilesFolder })}`);

  process.on('SIGINT', () => bot.shutdown());
  process.on('SIGTERM', () => bot.shutdown());

  bot.connect();
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[FATAL] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { FishingBot, loadConfig, directionFromRotation, entityKey, getMetadataValue };
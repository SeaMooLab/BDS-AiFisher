# Bedrock AFK Fisher

Headless Minecraft Bedrock fishing bot using `bedrock-protocol`.

## Requirements

- Node.js 24 or newer
- Minecraft Bedrock server compatible with 1.26.51
- A fishing rod in the configured hotbar slot

## Setup

```bash
npm install
cp config.example.json config.json
npm start
```

On Windows PowerShell:

```powershell
npm install
Copy-Item config.example.json config.json
notepad config.json
npm start
```

For Microsoft/Xbox authentication, leave `offline` as `false`. On the first run, follow the device-code login printed in the terminal. Authentication cache is stored in the configured `profilesFolder`.

For a server intentionally running offline authentication, set `offline` to `true`.

## Pterodactyl / Docker hosting

- Use a Node.js 24+ image. The startup command can stay as is.
- Upload the whole zip (including the hidden `.npmrc`) to `/home/container` and unarchive it there.
- `.npmrc` sets `ignore-scripts=true`. That stops `raknet-native` from trying to compile itself, which fails without CMake on hosts with Linux kernel 6+, where it has no prebuild. The bot then uses the pure-JS `jsp-raknet` transport automatically.
- Give it 2048 MiB of memory for the first `npm install`, then 512 MiB is plenty.
- On first start, sign in with the Microsoft code printed in the console (needs `logLevel` of `info` or higher).

## Modes

- `manual` (default): the bot reels in on every bite, then recasts.
- `auto`: for automatic fishers (e.g. a lava autofisher) that reel the hook in themselves. The bot never reels. It casts once, ignores bites, and recasts after `recastDelayMs` whenever its hook disappears. The no-bite watchdog is disabled, since an autofisher can leave the hook out for a long time.

Set `mode` in `config.json`, or switch live with `^mode auto` / `^mode manual`.

## Chat commands

Send these in normal chat. There is no authorization: anyone who can chat on the server can control the bot, so only use this on a server you trust.

Commands are found anywhere in a chat line and in raw/json (tellraw) messages with `§` codes stripped, so chat rank addons such as Paradox don't break them. The bot ignores its own replies when they are echoed back.

| Command | What it does |
| --- | --- |
| `^help [command]` | List commands, or describe one |
| `^mode [manual\|auto]` | Show or switch the mode |
| `^status` | Mode, state and counters |
| `^yaw [degrees]` / `^pitch [degrees]` | Show or set the cast direction. Applies from the next cast. `^save` stores it as `aim` in `config.json` (replacing a block target) |
| `^settings` | List every setting that can be changed from chat |
| `^get <setting>` | Show a setting, what it accepts and what it does |
| `^set <setting> <value>` | Change a setting now (lost on restart unless saved) |
| `^save` | Write settings changed from chat into `config.json` |

### Adding your own

- **A chat-configurable setting:** add one `.define({ key, type, description, apply })` in `createSettings()` in `index.js`. It then works with `^get`, `^set`, `^settings` and `^save`. Types are `settingTypes.enum(...)`, `.boolean()` and `.number({ min, max, integer })`. `apply(value, previous)` runs after a change and may throw to reject it. Add the key to `shortcuts` in `createCommands()` for a dedicated command like `^mode`.
- **A command:** add a `router.register({ name, aliases, usage, description, run })` in `createCommands()`. `run(args, ctx)` returns a string or an array of lines to reply with, and can throw `CommandError` to send a message back to the player. The generic plumbing lives in `commands.js`.

## Fishing setup

1. Log the bot account into the server normally once.
2. Stand in front of the water/fishing farm and aim where the rod should be cast.
3. Put the fishing rod in the configured hotbar slot. `0` means the left-most slot.
4. Disconnect that account and start this bot.
5. The bot reuses the account's saved location/orientation, casts, waits for the fishing hook event, reels, and recasts.

The bot identifies its own hook through the hook's `owner_eid` metadata, so other players fishing nearby won't confuse it. Only if a server omits that metadata does it fall back to "the first hook that spawns within 5 seconds of my cast."

## Casting methods

Bedrock servers accept a "use item" in one of two ways, and which one works depends on the server:

- `transaction`: a classic `inventory_transaction` click-air packet.
- `auth_input`: the same data embedded in the per-tick `player_auth_input` packet with the `item_interact` flag.
- `auto` (default): tries `transaction`. If no hook appears within `castConfirmMs`, it switches to the other method, and it keeps whichever one makes a hook appear. The log tells you which method won.

## Recovery behavior

- **Bite:** reels on the `fish_hook_hook` event for its own hook, then recasts after `recastDelayMs`.
- **Cast ignored:** if no hook shows up within `castConfirmMs`, it logs a warning and recasts (switching methods in `auto` mode).
- **No bite:** after `maxCastMs`, it reels and recasts in case the hook is stuck.
- **Hook vanished** (snagged, out of range): recasts immediately.
- **Rod broke or slot empty:** retries every `noRodRetryMs` and resumes once a rod is back in the slot.
- **Disconnect or kick:** reconnects with exponential backoff, from `reconnectBaseMs` up to `reconnectMaxMs`.

## Logging

Logs go to the console and to `fishbot.log` (`logFile`; set to `null` to disable the file).

| `logLevel` | What you get |
| --- | --- |
| `info` | Casts, bites, catches, warnings, status line every `statusIntervalMs` |
| `verbose` (default) | Plus every packet the bot sends, non-noise packets from the server, inventory/hotbar contents with item names, every fishing hook and hook event nearby, position corrections |
| `trace` | Everything, untruncated, including every 50 ms heartbeat. Huge. |

`"debug": true` is still accepted and means `trace`. If it isn't fishing, run at `verbose` for about 30 seconds and send `fishbot.log`.

## Config reference

| Key | Default | Meaning |
| --- | --- | --- |
| `host`, `port`, `username` | required | Server address and account name |
| `offline` | `false` | `true` only for servers running offline auth |
| `version` | `1.26.51` | Bedrock protocol version |
| `mode` | `manual` | `manual` reels in on bites; `auto` is for automatic fishers: never reels, only recasts when its hook is gone |
| `commandPrefix` | `^` | Prefix for chat commands |
| `hotbarSlot` | `0` | Rod slot, 0 to 8 (0 = left-most) |
| `castMethod` | `auto` | `auto`, `transaction`, or `auth_input` |
| `joinMessage` | `sup losers` | Chat message sent after spawning; `""` to stay quiet |
| `joinMessageDelayMs` | `1000` | Delay before the join message |
| `swingArm` | `false` | Send an arm-swing packet with each cast (vanilla does not for rods) |
| `recastDelayMs` | `900` | Pause between reel and next cast |
| `maxCastMs` | `90000` | Watchdog before force-reeling |
| `castConfirmMs` | `3000` | How long to wait for the hook to appear before calling a cast ignored |
| `noRodRetryMs` | `10000` | Retry interval when there's no rod |
| `spawnSettleMs` | `3000` | Wait after spawning before the first cast |
| `reconnectBaseMs` / `reconnectMaxMs` | `5000` / `60000` | Reconnect backoff range |
| `statusIntervalMs` | `15000` | Status line interval; `0` disables it |
| `raknetBackend` | `auto` | `auto`, `raknet-native`, or `jsp-raknet` (pure JS; used automatically when the native addon has no prebuild for the host) |
| `profilesFolder` | `./auth` | Microsoft auth cache |
| `logLevel` | `verbose` | `error`, `warn`, `info`, `verbose`, `trace` |
| `logFile` | `./fishbot.log` | Log file path, or `null` |

Press Ctrl+C to disconnect cleanly.

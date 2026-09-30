# Overdrive

A 75-second neon arena survival run where your selected Rare Friend **is** the fighter.

**Category:** Character Spotlight · Token Activity · Economy Potential
**Builder:** Rt ([@nothing010101](https://github.com/nothing010101))
**Stack:** FriendSDK **v0.1.4** (`@rarefriends/friendsdk`), React 19, TypeScript, HTML canvas 2D
**Playable preview:** https://nothing010101.github.io/overdrive/

## Rare Friend and $RAREFRIENDS

- The freshly verified Generations NFT is the on-screen fighter. Its canonical
  walking frames are read through the SDK sprite reader and drawn with a neon
  glow; facing follows your movement, and the walk cycle plays while you move.
- A **Run Ticket costs 1 RF** (simulated). The ticket is consumed when the
  post-run cache is opened, so every completed run is an RF spend.
- Caches hold fixed RF values and can be kept in the Vault or redeemed.
- The **Armory** spends that same simulated RF balance on weapons and systems,
  so the game has an RF sink as well as an RF source.
- **Economy Potential (future work):** durable upgrade tokens or cosmetics paired
  with $RAREFRIENDS. This needs persistent-save and additional-currency APIs that
  the SDK does not supply in v0.1.4, so it is not claimed as implemented.

## Controls and rules

- **Move:** WASD, arrow keys, or press-and-drag on touch and mouse. The Friend
  fires automatically at the nearest foe, so the whole game is playable with one
  thumb.
- **Shards** dropped by defeated foes drift toward you from anywhere and snap in
  when close, so a fight at range still pays out.
- Each level offers three upgrades — pick with keys **1–3** or by tapping:
  Overclock, Split shot, Slipstream, Magnet, Piercing, Pulse nova, Patch.
- Foes **telegraph** for half a second before they hatch, then fade in as drawn
  creatures: a six-legged crawler, a darting darter, and an armoured brute.
- **Enemy spawns are seeded from the UTC date**, so every player faces the same
  arena on the same day (first run of the day, per session).
- Survive **75 seconds** to clear the arena. Being downed early still ends the
  run and still opens a cache.
- Score combines kills, survival time, level and a clear bonus, and is ranked
  **S / A / B / C**. Score and rank are cosmetic: they only tint the reveal and
  **never** change odds or rewards.
- **Sound** starts on, with a mute toggle on the arena HUD and in Settings.

## Weapons and systems

Pick a weapon and buy systems in the **Armory** before a run. Everything is a
simulated RF spend from the preview balance the runtime already shows; the game
tracks its own spend and subtracts it from that balance. It is a game-local sink,
not an SDK ledger action, and it resets on reload.

| Weapon | Cost | Behaviour |
| --- | --- | --- |
| Blaster | free | Balanced single shot |
| Scatter | 4 RF | Three pellets in a wide arc |
| Lance | 5 RF | Fast beam that pierces two foes |
| Orbiter | 7 RF | Twin drones circle you and burn on contact |

| System | Cost | Effect per level | Max |
| --- | --- | --- | --- |
| Hull plating | 2 RF | +25 max HP | 4 |
| Thruster | 2 RF | +8% move speed | 4 |
| Magnet coil | 2 RF | +35 pickup range | 4 |
| Power core | 3 RF | +12% fire rate | 4 |

The **Pilot profile** screen shows the session record: runs flown, best score and
rank, total kills, caches cracked, RF redeemed and RF spent. It is session-only.

| Cache | Chance | Value |
| --- | --- | --- |
| Scrap cache | 55% | 0.5 RF |
| Copper cache | 30% | 1 RF |
| Silicon cache | 13% | 2 RF |
| Quantum cache | 2% | 3 RF |

Ticket price **1 RF**. Expected reward **0.895 RF** per ticket; maximum prize
**3 RF**. Every purchased ticket reserves the maximum prize before it can be
bought, and kept caches retain their fixed RF backing with no redemption expiry.

All purchases, balances and rewards are **simulated in preview mode** and labeled
in the UI (`Preview · … RF`). No live contract, no real funds.

## Run it

```sh
git clone https://github.com/spokesz/friendsdk.git
cd friendsdk
git clone https://github.com/nothing010101/overdrive.git games/overdrive
npm ci
npm run dev:game -- games/overdrive
```

Open the printed URL (normally `http://localhost:4173`).

Requires **Node.js 22+** and a browser wallet on **Robinhood mainnet (chain 4663)**
holding a **hardwired Generations NFT, generation 1 or higher**. The ownership
gate applies to previews too — the SDK enforces it and this game does not bypass it.

## Verify it

Run from the FriendSDK checkout, with this game cloned to `games/overdrive`:

```sh
npm run build
npx friendsdk check games/overdrive
npx friendsdk test games/overdrive --screenshot ./artifacts/game.png
npx friendsdk test games/overdrive --width 360 --screenshot ./artifacts/game-360.png
```

The browser harness uses a mock wallet, mock Robinhood RPC reads and canonical
sample sprites; it never signs a transaction. A passing mock test does not
replace a real-wallet playtest.

## Checks and known issues

Verified in the SDK v0.1.4 checkout:

- `npx friendsdk check games/overdrive` — **valid**, expected reward
  `895000000000000000`, maximum `3000000000000000000` base units.
- `tsc` type-check of `index.tsx` — clean.
- `npx friendsdk test` at 960px and 360px — **PASS**, no browser console errors.
- Full economy loop driven end to end in the browser harness: buy ticket →
  start run → run ends → open cache → reveal → keep → Vault → redeem.
- Armory, Pilot profile, level-up overlay, Odds, Vault and Settings all
  exercised; a weapon purchase was confirmed to move the balance from 19 RF to
  15 RF.
- Audio verified in the harness: the kit starts unmuted and an `AudioContext`
  reaches `running` on the first gesture.

Known issues and limits:

- **Real-wallet playtest is partial.** An earlier revision of this game was
  played end to end on Robinhood mainnet with a hardwired Generations NFT and
  reported no errors. This revision changed the renderer, the audio path and
  added the Armory, so it has **not** had its own real-wallet pass yet.
- **Session-only progress.** The sandbox has no `localStorage`/IndexedDB and the
  bridge has no save API, so the Pilot profile and Armory upgrades reset on
  reload.
- **The Armory is a game-local RF sink.** It is not an SDK ledger action, so the
  runtime's own balance readout does not reflect the spend; the game subtracts
  its own tally for display.
- **Narrow viewports are tight.** The arena is a fixed 960 × 640 world. On a
  phone the frame is made taller (`host.css`, 3 / 4) so the menus are comfortable,
  and the canvas letterboxes to 3:2 inside it, but the arena itself stays small.
  The HUD keeps clear of the runtime toolbar at every tested size.
- **Economy scope.** One consumable and one weighted outcome table only;
  persistent upgrades and extra currencies are not implemented.
- **`game.json` odds are fixed at build time** and cannot be tuned per player.

## Credits

- FriendSDK v0.1.4 source is Apache-2.0; canonical Friend artwork is used under
  the permissions described in the SDK's `NOTICE.md`.
- No third-party art, fonts or audio were added. All sprites, foes, particles
  and sound cues are drawn or synthesized from the SDK.

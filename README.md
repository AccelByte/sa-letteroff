# LetterOff

LetterOff is a small browser word game and an AccelByte Gaming Services (AGS)
sample. Each round shows a letter, and you type as many English words starting
with it as you can before the clock runs out. Play against a bot, a friend, or
a random opponent.

Online play is built on AGS with no game server: players sign in as guests,
share a Session V2 game session and keep the match state in session storage.
Matchmaking pairs strangers, Cloud Save keeps each player's match history, and
Statistics and Leaderboards rank them. The sample shows how far a casual game
can go with AGS alone, and where that approach stops (see
[Known limitations](#known-limitations)).

Built with Vite, React and TypeScript.

Contents:

1. [The game](#1-the-game)
2. [Run it locally in mock mode](#2-run-it-locally-in-mock-mode)
3. [Set up AGS](#3-set-up-ags)
4. [Run it against AGS](#4-run-it-against-ags)
5. [How each feature maps to AGS](#5-how-each-feature-maps-to-ags)
6. [How online play works](#6-how-online-play-works)
7. [Known limitations](#known-limitations)
8. [Project layout and scripts](#8-project-layout-and-scripts)

## 1. The game

1. Pick the number of rounds (1, 3 or 5) and the time per round (30 s, 1 min or
   3 min). Against the bot, also pick its level.
2. Each round starts with a 3-second countdown, then shows a random letter. No
   letter repeats within a match.
3. Type English words that start with that letter and press Enter. Each valid
   word scores 1 point.
4. Your opponent plays at the same time, and each word can only be played once
   per round: whoever plays it first keeps it.
5. Done early? **Finish answering** locks your words.
6. After the last round you see the winner and a score table for every round.

Words are rejected if they aren't in the bundled word list, don't start with
the round's letter, or have already been played this round.

The home screen also has **Match history** (your last 100 matches plus
lifetime totals) and a **Leaderboard** with three tabs:

- **Total wins**: online matches won.
- **A–Z best**: for each letter, your best score in a 60-second online round,
  added up across A–Z.
- **Best by letter**: your own best score for each letter.

Only player-vs-player matches count towards rankings; bot matches only go to
history.

Harder bots start sooner, play faster and know rarer words:

| Bot    | Knows words from | Typical gap between words |
| ------ | ---------------- | ------------------------- |
| Easy   | tier 1           | 4–7 s                     |
| Medium | tiers 1–2        | 2.5–4.5 s                 |
| Hard   | tiers 1–3        | 1.4–2.8 s                 |

## 2. Run it locally in mock mode

You need Node.js 22.12 or later. No AGS account is needed for this part.

```sh
git clone <this repository>
cd letteroff
npm ci
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

The default backend is **mock**: it runs entirely in the browser, using
`localStorage`, `BroadcastChannel` and Web Locks in place of AGS. Each tab is a
separate guest, so to try online play:

1. Open the game in two tabs or windows of the same browser.
2. In the first, choose **Play online > Create room** and copy the code.
3. In the second, choose **Play online > Join with a code** and paste it.
4. Start the match from the first tab.

**Quick match** works the same way: start it in both tabs. History and
leaderboards are kept in `localStorage`, so both tabs show up on the same
boards.

Add `?seed=123` to the URL to replay the same letters and bot moves every time,
which is handy for testing and bug reports.

## 3. Set up AGS

You need an AGS namespace (AGS Public Cloud or Private Cloud) and an Admin
Portal account that can manage IAM, Session, Matchmaking, Statistics and
Leaderboard in it. Everything below can be done in the Admin Portal or with
the matching admin APIs. [docs/ags-setup.md](docs/ags-setup.md) has the full
settings, the exact requests the game makes, and AGS behaviour verified while
building the sample.

The names below are the ones the code and `.env.example` use. Statistic and
leaderboard codes are fixed in `src/net/ags/agsProfile.ts`; the session
template and match pool names come from your `.env.local`.

### 3.1 Public IAM client

Create an IAM client for the browser:

| Setting | Value |
|---|---|
| Type | **Public** (no secret) |
| Redirect URI | `http://127.0.0.1` |
| Client permissions | none |

The game never uses a token of its own. Every call carries the signed-in
player's user token, so the client needs no permissions. Never create a
confidential client for a browser game: anything in the build is visible to
players.

### 3.2 Device login (guest accounts)

Under **3rd Party Integrations > Auth & Account Linking**, add the **Device**
platform with redirect URI `http://127.0.0.1` and set it to **Active**.

The browser makes up a random device ID, keeps it in `localStorage` and
exchanges it for a player token with
`POST /iam/v3/oauth/platforms/device/token`. One browser profile is one guest.

### 3.3 Session template `letteroff-room`

Create a Session V2 configuration template:

| Setting | Value | Why |
|---|---|---|
| Server type | `NONE` | No dedicated server, no peer-to-peer |
| Min / max players | 1 / 2 | The host waits alone until the friend joins |
| Joinability | `INVITE_ONLY` | Rooms aren't listed; join codes still work |
| Auto join | on | Matchmade players join without an invite |
| Auto leave | on | A player is in at most one LetterOff session |
| Inactive timeout | 30 s | A dropped player is removed after 30 s |
| TTL | 2 hours | Abandoned sessions clean themselves up |

AGS gives each session a 6-character join code, which the game shows as the
room code.

### 3.4 Matchmaking for Quick match

Create a ruleset `letteroff-1v1`:

```json
{
  "alliance": { "min_number": 2, "max_number": 2, "player_min_number": 1, "player_max_number": 1 },
  "match_options": { "options": [{ "name": "protocol", "type": "all" }] },
  "rebalance_enable": false
}
```

Then a match pool `letteroff-quick` that uses ruleset `letteroff-1v1`, session
template `letteroff-room`, the `default` match function and 60-second tickets.

The game sends a `protocol` attribute on every ticket, so only clients that
speak the same online data format are matched together.

### 3.5 Statistics

Create 28 statistics. All of them use minimum 0, default 0, **Set by:
client** (`setBy: CLIENT`), public, and no cycles.

| Stat code | Maximum | Notes | Updated by the game with |
|---|---|---|---|
| `letteroff-wins` | none | increment only | `INCREMENT` 1 per online win |
| `letteroff-best-a` … `letteroff-best-z` (26 stats) | 500 | tag `letteroff_letter` | `MAX` with that letter's score in a 60-second online round |
| `letteroff-az-best` | 13000 | | `OVERRIDE` with the sum of the 26 letter bests |

Stat tags may only contain letters, digits and underscores.

With the admin API, one statistic looks like this:

```http
POST /social/v1/admin/namespaces/{namespace}/stats
{
  "statCode": "letteroff-best-a",
  "name": "LetterOff best score: A",
  "minimum": 0,
  "maximum": 500,
  "defaultValue": 0,
  "incrementOnly": false,
  "setAsGlobal": false,
  "setBy": "CLIENT",
  "isPublic": true,
  "tags": ["letteroff", "letteroff_letter"]
}
```

### 3.6 Leaderboards

Create two Leaderboard V3 boards, both **all time**, **descending**, with no
cycles:

| Leaderboard code | Stat code |
|---|---|
| `letteroff-total-wins` | `letteroff-wins` |
| `letteroff-az-best` | `letteroff-az-best` |

```http
POST /leaderboard/v3/admin/namespaces/{namespace}/leaderboards
{ "leaderboardCode": "letteroff-az-best", "name": "LetterOff A-Z best",
  "statCode": "letteroff-az-best", "allTime": true, "descending": true, "cycleIds": [] }
```

Cloud Save and Lobby need no setup.

### 3.7 Allowed origin (CORS)

AGS only accepts browser requests from origins it allows, so a page served
from your own domain can't call AGS directly until its origin is on the list.

- **Local development:** nothing to set up. In AGS mode the Vite dev server
  forwards the AGS paths (`/iam`, `/session`, `/match2`, `/basic`, `/cloudsave`,
  `/social`, `/leaderboard` and the `/lobby` WebSocket) to your AGS environment
  and rewrites the `Origin` header, so the browser only talks to `localhost`.
  See `vite.config.ts`.
- **Deploying the game:** on AGS Private Cloud, ask AccelByte to add your web
  domain to the allow list. AccelByte's
  [developer FAQ](https://docs.accelbyte.io/gaming-services/knowledge-base/developer-faq/)
  says this isn't available on Public Cloud yet. There, serve the game behind
  a reverse proxy that forwards the same paths to AGS, as the dev server does.

## 4. Run it against AGS

```sh
cp .env.example .env.local
```

Edit `.env.local`:

```sh
VITE_BACKEND_MODE=ags
VITE_AGS_BASE_URL=https://<your-environment>.gamingservices.accelbyte.io
VITE_AGS_NAMESPACE=<your game namespace>
VITE_AGS_CLIENT_ID=<the public client ID from 3.1>
VITE_AGS_SESSION_TEMPLATE=letteroff-room
VITE_AGS_MATCH_POOL=letteroff-quick
```

Every `VITE_` value is bundled into the page, so only public values go here.
`.env.local` is git-ignored.

```sh
npm run dev
```

In AGS mode each browser profile is one guest, kept across visits. To play
yourself, use two browsers, or a normal and a private window:

1. Enter a different name in each and choose **Play online**.
2. Create a room in one and join with its code in the other, or start
   **Quick match** in both.
3. Play a 60-second round to the end. Both players' **Match history** shows
   the match, and after a few seconds the **Leaderboard** shows the winner
   under **Total wins** and both players under **A–Z best**.

## 5. How each feature maps to AGS

| Feature | AGS service | What the game uses |
|---|---|---|
| Sign in without a form | IAM | Device login with a public client; token refresh |
| Rooms and join codes | Session V2 | A `NONE` game session per match; its join code; join by code; leave |
| Shared match state | Session V2 session storage | Leader storage (host: letter, timing, scores, word ownership); member storage (each player's words) |
| Live updates | Lobby | `OnSessionStorageChanged` notifications carry the written storage; polling every 1.5 s as a fallback |
| Opponent dropped | Lobby + Session V2 | Member status changes when a player's Lobby connection drops; the 30 s inactive timeout removes them |
| Quick match | Matchmaking V2 | A ticket in `letteroff-quick`; AGS creates the session with both players in it |
| Same clock for both players | Basic | `GET /basic/v1/public/misc/time` to measure each player's clock offset |
| Match history and lifetime totals | Cloud Save | Private player record `letteroff-history` (last 100 matches) |
| Names on the leaderboards | Cloud Save | Public player record `letteroff-profile`, read in bulk for each board |
| Wins and letter bests | Statistics | Client-set stat items updated with `INCREMENT`, `MAX` and `OVERRIDE` |
| Total wins and A–Z best boards | Leaderboard V3 | All-time boards on `letteroff-wins` and `letteroff-az-best` |

The AGS calls live in `src/net/ags/`. The rest of the game only sees the
`OnlineBackend` interface in `src/net/backend.ts` and the `ProfileRemote`
interface in `src/net/profile/profileStore.ts`, which the mock backend also
implements.

## 6. How online play works

The player who created the room (or the session leader AGS picks for a quick
match) is the **host**. There is no server-side game logic, so the host runs
the match:

1. **Starting a round.** The host writes the letter, the reveal time and the
   end time to leader storage at the start of the 3-second countdown. Times
   are on AGS's clock: each player measures their own clock's offset from AGS
   at sign-in, so both screens reveal the letter and end the round together.
2. **Playing words.** Each player writes their own words to their member
   storage. The host's own words are decided as it types them. The guest's
   words are claims, shown as pending (…) until the host has checked them
   against the dictionary and written who owns each word to leader storage.
   If both players enter the same word at almost the same moment, whichever
   claim the host handles first wins, and both players see the same owner.
3. **Ending a round.** When a player's clock runs out, their game marks them
   finished. The host scores the round as soon as both are finished and
   writes the results.
4. **Updates.** Every storage write triggers an `OnSessionStorageChanged`
   Lobby notification to both players, carrying the data that was written.
   The game applies it directly, and polls the session every 1.5 s in case a
   notification is missed. A guest's word is confirmed in about 0.8 s against
   live AGS.

The rules (letters, scoring, the bot, the host's round flow and the storage
formats) are plain TypeScript in `src/game/`, with no React or browser APIs,
so the same code runs the bot game and the online match and is unit tested.

## Known limitations

LetterOff trades some fairness and robustness for having no game server. A
real game would close these gaps with server-side logic, for example an
[AGS Extend](https://docs.accelbyte.io/gaming-services/modules/foundations/extend/)
app.

- **Scoring happens on the clients.** The host's browser checks words and
  scores rounds, and each player's browser updates their own statistics
  (`setBy: CLIENT`). A modified client could report any score or post fake
  numbers to the leaderboards. Making rankings cheat-proof needs a
  server-side step, such as an Extend event handler that recomputes the
  stats from the session.
- **No host migration.** If the host leaves or loses their connection, the
  match ends for the guest. It does not move to the other player. The same
  happens if the guest leaves.
- **The host wins true ties.** A guest's word has to reach the host through
  AGS (a storage write, then a notification) before it counts, so when both
  players enter the same word at almost the same moment, the host usually
  gets it.
- **The letter arrives early.** The guest receives the next letter at the
  start of the 3-second countdown. Someone digging through the browser's
  developer tools could see it before it's shown.
- **Guest accounts only.** One browser profile is one player. Clearing site
  data, or switching browser, profile or address (`localhost` and
  `127.0.0.1` have separate storage), starts a new player with no history.
  A shipped game should offer a proper login and account linking.
- **Missed notifications cost time.** If a Lobby notification is lost, the
  other player sees the change at the next poll, up to 1.5 s later.
- **Rankings are limited.** Only 60-second online rounds count towards letter
  bests. **Best by letter** shows only your own scores; ranking every letter
  would need one more leaderboard per letter.
- **Deploying needs an allowed origin** or a proxy; see
  [3.7](#37-allowed-origin-cors).
- **English only.** Words with accents (such as "piñata") aren't in the word
  list.

## 8. Project layout and scripts

```
src/game/      Game rules in plain TypeScript. No React, no browser APIs.
  rng.ts         Seeded random numbers
  letters.ts     Picks distinct letters for a match
  dictionary.ts  Tiered word lookup and word validation
  scoring.ts     Round scoring and match totals
  bot.ts         Bot difficulty profiles; plans the bot's words for a round
  match.ts       Bot match state machine
  history.ts     Match history records
  progress.ts    Lifetime totals, letter bests and which matches are ranked
  player.ts      Player name rules
  online/        Online storage formats, validation and the host's round flow
src/online/    OnlineMatchController: one player's side of an online match
src/net/       The backend interfaces, the in-browser mock and the AGS backend
  ags/           AGS calls: login, sessions, matchmaking, Lobby, Cloud Save, Statistics, Leaderboard
  mock/          In-browser stand-in for AGS
  profile/       Saving history and reading rankings, with an offline outbox
src/ui/        React screens
src/data/      Generated word list (committed)
scripts/       Word list generator
docs/          AGS setup reference
```

| Script              | What it does                                     |
| ------------------- | ------------------------------------------------ |
| `npm run dev`       | Start the dev server                             |
| `npm run build`     | Typecheck and build to `dist/`                   |
| `npm run preview`   | Serve the production build                       |
| `npm run lint`      | ESLint                                           |
| `npm run typecheck` | TypeScript, no output                            |
| `npm test`          | Unit tests (Vitest)                              |
| `npm run wordlist`  | Regenerate `src/data/words-tier*.txt` from SCOWL |

The online controller is tested by having two controllers play full matches
against an in-memory mock backend, including one with the delays measured
against live AGS (`src/online/latency.sim.test.ts`). GitHub Actions runs lint,
typecheck, tests and build on Node 22 and 24 (`.github/workflows/ci.yml`).

## Word list

The dictionary comes from [SCOWL](http://wordlist.aspell.net/) (Spell Checker
Oriented Word Lists) by Kevin Atkinson: the English, American and British
lists at size levels 10 to 60, limited to plain a–z words of two or more
letters. That gives about 79,000 words in four tiers:

| Tier | SCOWL levels | Words  | Used by                 |
| ---- | ------------ | ------ | ----------------------- |
| 1    | 10, 20       | 11,107 | player, all bots        |
| 2    | 35           | 29,085 | player, Medium and Hard |
| 3    | 40, 50       | 23,149 | player, Hard            |
| 4    | 55, 60       | 15,933 | player only             |

## Licence

LetterOff is released under the MIT licence; see [LICENSE](LICENSE). The word
list is covered by the SCOWL licence, and the build bundles React (MIT). See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). `npm run build` copies these
notices into `dist/`.

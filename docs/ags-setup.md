# AGS namespace setup for online play

LetterOff's online mode uses AccelByte Gaming Services (AGS) with no dedicated
server: a guest login, a Session V2 game session per match, and session
storage for shared state. This page is the detailed reference for what the
namespace needs and what the game sends; the [README](../README.md#3-set-up-ags)
walks through the setup step by step. The names shown are the ones the code
and `.env.example` use.

## 1. Public IAM client

| Setting | Value |
|---|---|
| Name | LetterOff Web |
| Type | Public (no secret) |
| Redirect URI | `http://127.0.0.1` |
| Client permissions | None |

The game never uses a token of its own: every call carries the signed-in
player's user token. AGS's built-in "game client" template for Public clients
also lists no required permissions.

## 2. Device login (guest)

Admin Portal: **Foundations > 3rd Party Integrations > Auth & Account
Linking > Add New > Device**, redirect URI `http://127.0.0.1`, status
**Active**.

The browser generates a random device ID, keeps it in `localStorage`, and
exchanges it for a player token:

```http
POST /iam/v3/oauth/platforms/device/token
Authorization: Basic base64(<clientId>:)
Content-Type: application/x-www-form-urlencoded

device_id=<random id>
```

Clearing site data creates a new guest account. AccelByte recommends
stronger login methods for shipped games, so treat guest login as the
sample's entry point, not a production account system.

## 3. Session V2 template `letteroff-room`

| Setting | Value | Why |
|---|---|---|
| Server type | `NONE` | No DS, no P2P: clients only share session state |
| Min / max players | 1 / 2 | Host waits alone until the friend joins |
| Joinability | `INVITE_ONLY` | Rooms are not discoverable; join codes still work |
| Auto join | on | Members of a created session (e.g. from matchmaking) join without an invite |
| Auto leave | on | A player is in at most one LetterOff session |
| Inactive timeout | 30 s | A dropped player is removed after 30 s, ending the match for the other |
| Invite timeout | 60 s | |
| Persistent | off | |
| TTL | 2 hours | Abandoned sessions clean themselves up |
| Text chat | off | |

A 6-character join code (`0-9`, `A-Z` without I, L, O, U) is generated
automatically when the session is created and returned in the session's
`code` field.

## 4. Matchmaking for Quick match

**Ruleset `letteroff-1v1`** (default match function):

```json
{
  "alliance": { "min_number": 2, "max_number": 2, "player_min_number": 1, "player_max_number": 1 },
  "match_options": { "options": [{ "name": "protocol", "type": "all" }] },
  "rebalance_enable": false
}
```

- Two teams of one player: a 1v1.
- No skill rules: Quick match pairs whoever is waiting.
- `protocol` is a match option, so tickets only match tickets with the same
  `protocol` attribute. Bump it when the online data format changes, so old
  and new clients never end up in the same match. The app currently sends `4`
  (2 added per-round word ownership, 3 the shared round clock, 4 the guest's
  "seen results" acknowledgement). The option type is `all`, so a new version
  needs no ruleset change.
- Rebalance is off: there is nothing to rebalance with one player per team.

**Match pool `letteroff-quick`**

| Setting | Value |
|---|---|
| Ruleset | `letteroff-1v1` |
| Session template | `letteroff-room` |
| Match function | `default` |
| Ticket expiration | 60 s |
| Backfill | not used (auto-accept off, 60 s expirations) |
| Cross-play | allowed (browser only, so it has no effect) |

A player joins the queue with:

```http
POST /match2/v1/namespaces/{ns}/match-tickets
{ "matchPool": "letteroff-quick", "attributes": { "protocol": 4 }, "latencies": {} }
```

When a match is made, AGS creates a `letteroff-room` game session with both
players already `JOINED` (the template has auto join on), one per team. The
session's `leaderID` decides who hosts (in testing it was the player whose
ticket came first, but the game should read `leaderID`, not assume). The
ticket status endpoint (`GET .../match-tickets/{ticketId}`) returns
`matchFound` and `sessionID`, which is the polling fallback for the
match-found notification.

## 5. Running the game against AGS

```sh
cp .env.example .env.local   # then set VITE_BACKEND_MODE=ags and your values
npm run dev
```

Open the game in two browser windows (or two browsers) and choose **Play
online** in each. The Vite dev server forwards `/iam`, `/session`, `/match2`, `/basic`, `/cloudsave`, `/social`, `/leaderboard`
and the `/lobby` WebSocket to `VITE_AGS_BASE_URL` and rewrites the `Origin`
header.

## 6. Lobby

No changes. The namespace uses AGS defaults. `cancelTicketOnDisconnect` is
off, so the game cancels its own ticket (`DELETE .../match-tickets/{ticketId}`)
when the player cancels or closes the page; unclaimed tickets expire after
60 s anyway.

## 7. Persistence and rankings

Created with the Statistics and Leaderboard V3 admin APIs. All stats have
minimum 0, default 0, `setBy: CLIENT` (the browser writes them with the
player's token; there is no game server) and `isPublic: true`.

| Stat code | Update from the game | Notes |
|---|---|---|
| `letteroff-wins` | INCREMENT 1 per online win | `incrementOnly` |
| `letteroff-best-a` … `letteroff-best-z` | MAX with that letter's score in a 60-second online round | maximum 500 (the per-round word cap) |
| `letteroff-az-best` | OVERRIDE with the sum of the 26 letter bests, read back after the MAX update | maximum 13000 |

| Leaderboard (V3, all time, descending, no cycles) | Stat |
|---|---|
| `letteroff-total-wins` | `letteroff-wins` |
| `letteroff-az-best` | `letteroff-az-best` |

Per-letter boards were left out on purpose; the "Best by letter" tab shows the
player's own `letteroff-best-*` values. A board per letter would be one more
leaderboard per stat, with no code change beyond the screen.

Cloud Save needs no setup. The game uses two player records:

- `letteroff-history` (private, the default): `{ v, matches[≤100], totals, counted }`.
  If it grows past 200 KB (AGS recommends staying under 250 KB), the oldest
  matches drop their word lists and keep their scores.
- `letteroff-profile` (public, `__META.is_public: true`): `{ name }`, read for
  the boards with `POST /cloudsave/v1/namespaces/{ns}/users/bulk/records/letteroff-profile/public`.

Calls made with the player's token, verified live with two guests finishing a
1 × 60 s match:

```
GET/PUT /cloudsave/v1/namespaces/{ns}/users/{userId}/records/letteroff-history   (404 = no history yet)
PUT     /cloudsave/v1/namespaces/{ns}/users/{userId}/records/letteroff-profile
PUT     /social/v2/public/namespaces/{ns}/users/{userId}/statitems/value/bulk   [{statCode, updateStrategy, value}]
GET     /social/v1/public/namespaces/{ns}/users/me/statitems/value/bulk?statCodes=…   (≤ 13 codes per call)
GET     /leaderboard/v3/public/namespaces/{ns}/leaderboards/{code}/alltime?offset=0&limit=20
GET     /leaderboard/v3/public/namespaces/{ns}/leaderboards/{code}/users/{userId}
```

Things seen live: the all-time list has no `rank` field (rank is the
position); both leaderboard reads answer 404 (errors 71235 and 71233) for an
empty board or a player not on it; a new score showed up on the board about
3 seconds after the stat update. Stat-item tags must match `^[0-9a-zA-Z_]+$`
(no hyphens).

## Server clock

Both players read `GET /basic/v1/public/misc/time` (AGS Basic, returns
`{ "currentTime": "2026-11-16T03:05:27.265Z" }` with millisecond precision) a few
times at sign-in to work out their clock offset, so round times written by the
host mean the same moment for both. It is called with the player's token and
needs no extra permission. The Vite dev proxy forwards `/basic` along with the
other AGS paths.

## Session storage behaviour (verified live)

- Leader storage: `PATCH /session/v1/public/namespaces/{ns}/sessions/{id}/storage/leader`.
  Only the session leader can write it; anyone else gets `403` (error 30054).
- Member storage: `PATCH .../sessions/{id}/storage/users/{userId}`. A player can
  only write their own; writing another player's gets `403` (error 30053).
- Each write **replaces** that storage object. Always send the whole object.
- Players read both from `GET /session/v1/public/namespaces/{ns}/gamesessions/{id}`
  under `storage.leader` and `storage.member[userId]`.
- Storage writes do not change the session's `version` or `updatedAt`.
- The Web SDK (`@accelbyte/sdk-session` 5.3.7) sends an empty body for both
  storage writes, so LetterOff calls these two endpoints directly with the
  player's token.
- Every storage write sends `OnSessionStorageChanged` (a `messageSessionNotif`)
  to every member, the writer included, about 60–120 ms after the write is
  acknowledged. The payload is base64 JSON with `SessionID`, `ActorUserID`,
  `IsLeader` (leader storage only) and `StorageChanges`, which is the whole
  object that was written. LetterOff applies that object directly instead of
  re-reading the session (a session read takes about 270 ms, or about 530 ms
  once storage holds a round's words) and ignores its own writes. It still
  polls every 1.5 s as a fallback, and an older read never replaces newer
  storage it already has.

## Browser access (CORS)

For local development the Vite dev server proxies AGS calls, so the browser
only talks to `localhost`. AccelByte's
[developer FAQ](https://docs.accelbyte.io/gaming-services/knowledge-base/developer-faq/)
says adding your own web domains to the allow list is available on Private
Cloud and not yet on Public Cloud. On Public Cloud, serve the game behind a
reverse proxy that forwards the same paths to AGS, as the dev server does.

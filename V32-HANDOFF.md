# Island Clash v32 handoff

The v32 server adds online accounts and shared administration to the original solo game. The default start command still runs v31. The opt-in command is `npm run start:v32`.

## What the branch adds

- Case-insensitive online usernames, async scrypt password hashing, expiring and revocable sessions, and BRITBOX-only owner setup.
- An online admin panel for bulletin notices, account search, owner-controlled role changes and account-bound invitations, gifts, inventory adjustments, Battle Pass XP and levels, and island unlocks.
- Cross-device bug reports, contact messages, and admin applications with an admin inbox and resolution controls.
- Redeem codes with expiration, a per-account limit, a total limit, and permanent disabling. One shared vault prize can be open at a time. The owner receives a single-use code to distribute.
- Global events and shutdown controls polled every 10 seconds. An enabled event starts once per solo round and runs for its original duration. Shutdown pauses standard players' solo rounds.
- Optional v31 backup import at v32 signup. It imports the active pirate’s solo progress, shop inventory, and personal chest codes.
- A cloud save for solo progression and shop inventory, separate from centrally granted items and code claims. Saves sync every 45 seconds, on logout, and when the page is hidden. Use Save online now to verify a manual sync before switching devices. A conflicting write prompts the player to log in again and load the newer cloud save.

## Database

The migration creates 11 tables in the private `island_clash` schema, enables row-level security, and removes access for Supabase API roles in that schema. The v32 server uses the configured PostgreSQL connection. The migration was exercised against an isolated PostgreSQL instance. Supabase recorded the applied migration as version `20261118151617`. All 11 hosted tables have RLS enabled and deny direct access to the three Supabase API roles. The security advisor returned only informational notices for the intentionally policy-free tables.

## Verification

The local API checks covered case-insensitive owner reservation, password login, logout invalidation, owner-only role changes, admin revocation, account-bound single-use invitations, signed-in inventory access, negative grants, report permissions, bulletin publication and removal, code expiry, concurrent redemption, one vault winner, and persistence across a server restart. PostgreSQL rejected direct access for `anon`, `authenticated`, and `service_role`.

Chromium exercised online login, literal rendering of bulletin text, owner inbox and code creation, a solo round, a separate browser context loading a saved account, and a local v31 signup and solo round. Conflicting cloud saves returned one success and one conflict.

## Before enabling on Render

1. Run a v32 preview against a test database. Verify the Render connection accesses the private schema over TLS and `/health` succeeds. Set `TRUST_PROXY_HOPS=1` only if the service is reachable through exactly one trusted proxy. Verify the login limiter with the deployed network topology.
2. Provision BRITBOX using `POST /api/signup` over HTTPS from a trusted operator environment, with `username`, `password`, and `ownerSetupSecret` supplied privately. The setup secret must be at least 16 characters. Confirm owner access, then remove the setup secret from the service configuration.
3. Review shared vault discovery and the cutover with the project owner. Switch the Render start command to `npm run start:v32` only after approval and preview verification.

V31 local accounts and progress keep their own save storage. Players can export a v31 backup and select it when creating a v32 account. The import takes the active pirate from a v9 or v12 backup. It excludes credentials, admin-only assets, and shared rewards, and leaves existing v32 saves intact. The shared vault currently uses owner-distributed codes. Personal chest codes still work in solo play. Cross-device discovery of legendary keys or codes from chests and automatic shared vault rollover remain open.

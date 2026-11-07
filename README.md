# DayleeStatCardz (Android app)

Football stats app: **home team's last 10 HOME matches vs away team's last 10 AWAY matches** — goals, corners and cards for 1st half, 2nd half and full match. Tap any % to see every match behind it.

## Getting the APK
Every change pushed to `main` is built automatically by GitHub Actions (`.github/workflows/build-apk.yml`).
The newest APK is always at **Releases → latest → DayleeStatCardz.apk**.

## Player bets
**Players** tab (bottom bar) ranks the strongest player lines across a league's next 7 days of fixtures; each match also has a **Players** tab. Built from PitchAPI's per-match player stat lines (`/v1/matches/{id}/players`) and card events. Only 45+ minute appearances count; a line shows at 70%+ (5+ games, or 3–4 flagged "Small sample"). Default sample follows the home/away rule; "All games" uses the last 10 at any venue. No odds are shown.

## Connecting data servers
Open the app → **Servers** tab → paste your key → **Connect**. Keys are stored only on the phone.

| Server | Needed | Gives |
|---|---|---|
| PitchAPI (pitchapi.dev) | Yes (free) | Fixtures, results back to 2021, corners by half, card + goal timelines |
| football-data.org | Optional (free) | Official half-time scores, second check on results |

If a league doesn't match automatically, pick it under **Servers → Leagues**.

## Project layout
- `www/` — the app's screens (`index.html`, `styles.css`, `app.js`) and data engine (`engine.js`). Bundled into the APK.
- `app/` — the Android wrapper (`MainActivity.java`): full-screen view plus a native connection that only talks to the two data-server hosts.
- `app/dsc.keystore` — signing key so each new build installs as an update.

## Accuracy rules
Never mixes home and away; only matches before kick-off; real sample size shown when under 10; missing data shown as "n/a" and excluded, never counted as zero. Goals and cards use regular time only.

Football data provided by PitchAPI and the Football-Data.org API. Historical statistics — not betting advice. 18+ · BeGambleAware.org

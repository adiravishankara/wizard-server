# Deploying Wizard (Render + Firebase Firestore)

Two pieces:

- **Render** runs the server (FastAPI + WebSockets). Live games are kept in the server's memory.
- **Firebase Firestore** stores leagues: players, teams, rosters, and every recorded result with its full per-player summary. A Render restart or redeploy does not lose league data.

Live games themselves are still in memory. A restart ends any game in progress; anything already recorded to a league is safe.

## 1. Create the Firebase project and Firestore database

1. Go to <https://console.firebase.google.com> and sign in with the Google account that should own the data.
2. **Create a project** (for example `wizard-league`). Google Analytics is not needed; you can turn it off.
3. In the left menu open **Build → Firestore Database → Create database**.
   - Edition: **Standard**.
   - Location: pick one close to your Render region, e.g. `nam5 (United States)` for Render's Oregon/Ohio regions. It cannot be changed later.
   - Rules: choose **Start in production mode**. The server uses the Admin SDK, which bypasses security rules, so the default "deny everything" rules are what you want: browsers can never read or write the database directly.
4. The free **Spark** plan is enough. Each server start reads every league document once; each league change or recorded result is one or two writes.

## 2. Create a service-account key

1. In the Firebase console click the gear icon → **Project settings → Service accounts**.
2. Under **Firebase Admin SDK**, click **Generate new private key → Generate key**. A JSON file downloads.
3. Treat that file like a password. Do not commit it; `.gitignore` does not know its name.

## 3. Turn the key into one line for Render

Render environment variables are single strings, so the server reads the key as base64.

Windows PowerShell (copies the result to the clipboard):

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\wizard-league-firebase-adminsdk.json")) | Set-Clipboard
```

macOS / Linux:

```bash
base64 < wizard-league-firebase-adminsdk.json | tr -d '\n'
```

## 4. Configure Render

`render.yaml` already declares the variables:

| Variable | Value |
| --- | --- |
| `LEAGUE_STORE` | `firestore` (set by the blueprint) |
| `FIREBASE_CREDENTIALS_B64` | the base64 string from step 3 (you paste it) |
| `FIREBASE_PROJECT_ID` | optional; defaults to `project_id` inside the key |
| `FIRESTORE_COLLECTION_PREFIX` | optional; e.g. `staging_` to keep a second deployment's data apart |

New service: Render dashboard → **New + → Blueprint** → pick this repo → Render shows the `wizard` service and asks for `FIREBASE_CREDENTIALS_B64` → paste → **Apply**.

Existing service: open the service → **Environment** → add `LEAGUE_STORE=firestore` and `FIREBASE_CREDENTIALS_B64=<paste>` → **Save, rebuild, and deploy**.

## 5. Check it

Open `https://<your-service>.onrender.com/health`. It should say:

```json
{"status": "ok", "league_store": "firestore"}
```

If the deploy fails instead, the Render logs name the problem (missing or malformed `FIREBASE_CREDENTIALS_B64`, wrong project, Firestore not created yet). With `LEAGUE_STORE=firestore` the server will not start without working credentials. To boot temporarily without Firebase, set `LEAGUE_STORE=json`; league data then lives on the container disk and is lost on the next deploy.

Create a league in the app, then look in the Firebase console under **Firestore Database → Data**: you should see a `leagues` collection, and each league document gets a `games` subcollection once a result is recorded.

## 6. Move existing league data (optional)

If a server has been writing `data/wizard_league.json`, copy it into Firestore once from your machine:

```powershell
pip install -e ".[firebase]"
$env:FIREBASE_CREDENTIALS = "C:\path\to\wizard-league-firebase-adminsdk.json"
python -m app.services.migrate_leagues data\wizard_league.json
```

Re-running is safe: documents are written by id.

## Local development

Nothing to set up: without Firebase variables the server stores leagues in `data/wizard_league.json` (`LEAGUE_DATA_FILE` overrides the path). Tests always use a temporary JSON file and never contact Firebase.

To point a local server at Firestore:

```powershell
pip install -e ".[dev,firebase]"
$env:FIREBASE_CREDENTIALS = "C:\path\to\wizard-league-firebase-adminsdk.json"
$env:FIRESTORE_COLLECTION_PREFIX = "dev_"
uvicorn app.main:app --port 8000
```

`FIREBASE_CREDENTIALS` accepts either a path to the key file or the JSON text itself. `GOOGLE_APPLICATION_CREDENTIALS` (a path) also works.

## Storage selection rules

1. `LEAGUE_STORE=json` → JSON file, always.
2. `LEAGUE_STORE=firestore` → Firestore; startup fails if credentials do not work.
3. `LEAGUE_STORE` unset → Firestore if any of `FIREBASE_CREDENTIALS_B64`, `FIREBASE_CREDENTIALS`, `GOOGLE_APPLICATION_CREDENTIALS` is set, otherwise JSON.

## Firestore layout

```
leagues/{leagueId}                    name, created_at, players{id: {name, joined_at}}, teams{id: {name, color, player_ids[]}}
leagues/{leagueId}/games/{recordId}   played_at, edited_at, source (live|manual), bidding_mode, rounds_played, final_only,
                                      players[{name, league_player_id, seat, score, place, team_id, bids_made, rounds_bid}],
                                      rounds[{round, cards_dealt, dealer_seat, dealer, trump (H|D|C|S|null),
                                              trump_source (flip|wizard|jester|none), trump_chosen_by,
                                              players[{seat, name, bid, tricks, points, total}]}],
                                      team_scores{}, team_names{}, team_colors{}, winner_team_ids[], winner_team_id, notes
```

Live games always store every hand. A result added by hand stores hands only if they were entered, otherwise `rounds` is empty and `final_only` is true. Records saved in the older `rounds[{bids, tricks, deltas}]` format are upgraded when read.

The server keeps one in-memory copy and writes through on every change, which assumes a single Render instance (the default). Do not scale the service to several instances.

# Public schedule data collector

This repository keeps a small, read-only snapshot of publicly visible squid and cuttlefish schedules. GitHub Actions runs every 30 minutes and commits a new `fishing_data.json` only when the snapshot changes. A failed or blocked fetch leaves the last good file untouched.

## Currently collected

- Sunsang24: three explicitly verified public fleet entries, refreshed for the current and next calendar month. The configured entries and exact boat identities are in `source_registry.json`.
- The collector filters for public schedule rows explicitly labeled for 쭈꾸미/주꾸미 or 갑오징어. It records only a seat count that the source explicitly exposes.
- ClubSea and TheFishing are not active collectors yet. Their endpoint/request shapes are documented in `API_SOURCES.md`; additional integration requires a verified public boat list and a permitted request scope.

## Read the saved data

The Android app reads the latest JSON snapshot and refreshes it while open. The repository is private, so the app cannot anonymously read its raw GitHub file. To enable the app feed, publish only `fishing_data.json` using a public static endpoint (for example, GitHub Pages); this makes schedule/seat data public but does not expose the repository source. Do not put a GitHub token in the APK.

## Run collection manually

1. Open the repository's **Actions** tab.
2. Select **Update fishing data**.
3. Choose **Run workflow**.

The scheduled run starts at minute 00 and 30 of each hour (GitHub may start a scheduled run a few minutes later).

## Files

- `scraper.py`: public Sunsang24 collector; stops on HTTP denial/rate limits or unexpected response shapes.
- `source_registry.json`: explicit provider, fleet, and boat allowlist.
- `fishing_data.json`: last successful snapshot.
- `.github/workflows/cron.yml`: 30-minute collection schedule and commit.
- `API_SOURCES.md`: inspected endpoint notes and safety constraints.

The collector does not log in, submit bookings, bypass access controls, enumerate guessed IDs, or retry aggressively.

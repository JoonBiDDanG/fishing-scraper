# fishing-scraper

This private repository keeps a read-only snapshot of publicly visible squid and cuttlefish schedules. GitHub Actions collects the configured Sunsang24 schedules every 30 minutes and commits `fishing_data.json` after each successful refresh.

## Android app connection

The repository remains private. The app reads the snapshot through GitHub's authenticated Contents API. In the app, choose **연결** and enter a fine-grained token restricted to this repository with **Contents: Read-only** permission. The token is encrypted with Android Keystore on the device; do not paste it into chat, source code, or GitHub files. The app checks for a newer snapshot every two minutes while open and refreshes immediately when opened.

## Currently collected

- Sunsang24: three explicitly verified public fleet entries refreshed for the current and next calendar month. The exact boat IDs and names are in `source_registry.json`.
- Only public rows labeled 쭈꾸미/주꾸미 or 갑오징어 are kept.
- Seat counts are stored only if the provider explicitly exposes them.
- TheFishing and ClubSea are not active collectors; their request-shape notes are in `API_SOURCES.md`.

## Run collection manually

1. Open the repository's **Actions** tab.
2. Select **Update fishing data**.
3. Choose **Run workflow**.

Scheduled runs are configured for minute 00 and 30 of each hour. GitHub may start them a few minutes later.

## Files

- `scraper.py`: limited public Sunsang24 collector; stops on access denial, rate limits, or unexpected response shapes.
- `source_registry.json`: explicit provider, fleet, and boat allowlist.
- `fishing_data.json`: latest successful snapshot.
- `.github/workflows/cron.yml`: 30-minute collection schedule.
- `API_SOURCES.md`: inspected endpoint notes and constraints.

The collector does not log in, submit bookings, bypass access controls, or guess IDs. A failed collection leaves the last good snapshot untouched.

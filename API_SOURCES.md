# Provider API inventory

This file records first-party schedule request shapes found in the user-supplied Android v3 APK. It does not claim unlimited polling rights. Collect only public schedule data within the observed source flow; do not add login-only, booking-submit, captcha, or access-control-bypass behavior.

## Confirmed request shapes

| Provider | Request | Method | Scope |
|---|---|---:|---|
| Sunsang24 | `https://api.sunsang24.com/ship/schedule_fleet_list/{entry_id}/{YYYYMM}?simple=&possible=&eyyyymm=` | GET | Public monthly schedule JSON for a verified fleet/boat entry. |
| TheFishing | `https://thefishing.kr/reservation/list.php?uid={product_uid}` | GET | Public calendar bootstrap; boat name and the page's own calendar UID must be read from the page. |
| TheFishing | `https://thefishing.kr/reservation/list.view.view.1.ajax.new.php` | POST | Same-origin monthly calendar request observed in the page script: `date6=YYYYMM&st_uid={page_calendar_uid}&pa_uid={product_uid}`. |

## Collection currently enabled

The GitHub Actions collector calls the eighteen registered Sunsang24 schedule entries in `source_registry.json` (nine fleet pages and nine direct boat IDs). The first nine direct IDs visible in the rendered IPZIL search page were matched to the official public monthly schedule API and confirmed by official ship name and October/November schedule rows: 1503 갈매기호 (전남·신기항), 1801 가디언호 (충남·대천항), 1861 가디언호 (충남·무창포항), 2002 골드비너스호 (전남·마량항), 2207 강태공호 (전남·목포북항), 2307 고고(1호) (전남·안포항), 2483 그레이스호 (충남·대야도항), 727 강프로호 (전북·비응항), and 917 글램핑1호 (충남·천리포항). Direct entries use the public `ship_no` booking page; fleet responses may include other vessels, which are skipped unless explicitly registered. A registered ID whose name changes fails the run. It then keeps rows whose public species label identifies 쭈꾸미/주꾸미 or 갑오징어. A seat count is recorded only when the source explicitly exposes it.

The workflow runs every 30 minutes, with at least two seconds between requests. The current and next month are refreshed with thirty-six monthly requests per run (eighteen entries × two months). It stops on access denial, rate limit, non-JSON response, identity mismatch, or unexpected response structure; failed runs do not replace the previous snapshot.

## Limits and safety

- Use HTTPS, exact first-party hosts and routes, and IDs in the explicit registry. Do not guess or enumerate IDs.
- The TheFishing calendar UID must be read from its public bootstrap page. No TheFishing or ClubSea collector is enabled yet.
- Missing or ambiguous status/count remains unknown; it must never be inferred as available or sold out.
- Stop on HTTP 401/403/429/503, challenges, or access-denied responses. Do not rotate identities, spoof browser headers to work around a block, or retry aggressively.
- The submitted APK contains no ClubSea adapter. Its presence in the app's catalog is not evidence of an API.
- The repository stays private. The Android app must read the JSON through GitHub's authenticated Contents API using a fine-grained, repository-scoped Contents: Read-only token stored encrypted with Android Keystore. Never embed the token in source code or commit it.

No credentials or reservation-person data are included.

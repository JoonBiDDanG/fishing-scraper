# Provider API inventory

This file records first-party schedule request shapes found in the user-supplied Android v3 APK. It does not claim unlimited polling rights. Collect only public schedule data within the observed source flow; do not add login-only, booking-submit, captcha, or access-control-bypass behavior.

## Confirmed request shapes

| Provider | Request | Method | Scope |
|---|---|---:|---|
| Sunsang24 | `https://api.sunsang24.com/ship/schedule_fleet_list/{entry_id}/{YYYYMM}?simple=&possible=&eyyyymm=` | GET | Public monthly schedule JSON for a verified fleet/boat entry. |
| TheFishing | `https://thefishing.kr/reservation/list.php?uid={product_uid}` | GET | Public calendar bootstrap; boat name and the page's own calendar UID must be read from the page. |
| TheFishing | `https://thefishing.kr/reservation/list.view.view.1.ajax.new.php` | POST | Same-origin monthly calendar request observed in the page script: `date6=YYYYMM&st_uid={page_calendar_uid}&pa_uid={product_uid}`. |

## Collection currently enabled

The GitHub Actions collector currently calls only the nine configured Sunsang24 fleet entries in `source_registry.json` (2455, 698, 1634, 885, 1647, 1964, 2082, 1987, and 2086), for the current and next calendar months. The added entries were matched against official fleet pages and their public monthly JSON responses: 바다생각호 (885); 군산 프로선단's 어종 대상 선박 아리랑호, 샤크호, 슈퍼마린호, 킹마린호, 프로호, 신성호 (fleet entry 1647); 한사리피싱 (1964); 다래호 (2082); 임금호 (1987); 해양호 (2086). It keeps only boats explicitly registered: unknown boat IDs included in a fleet response are skipped, while a registered ID whose name changes fails the run. It then keeps rows whose public species label identifies 쭈꾸미/주꾸미 or 갑오징어. A seat count is recorded only when the source explicitly exposes it.

The workflow runs every 30 minutes, with at least two seconds between requests. The current and next month are refreshed with eighteen small monthly requests per run. It stops on access denial, rate limit, non-JSON response, identity mismatch, or unexpected response structure; failed runs do not replace the previous snapshot.

## Limits and safety

- Use HTTPS, exact first-party hosts and routes, and IDs in the explicit registry. Do not guess or enumerate IDs.
- The TheFishing calendar UID must be read from its public bootstrap page. No TheFishing or ClubSea collector is enabled yet.
- Missing or ambiguous status/count remains unknown; it must never be inferred as available or sold out.
- Stop on HTTP 401/403/429/503, challenges, or access-denied responses. Do not rotate identities, spoof browser headers to work around a block, or retry aggressively.
- The submitted APK contains no ClubSea adapter. Its presence in the app's catalog is not evidence of an API.
- The repository stays private. The Android app must read the JSON through GitHub's authenticated Contents API using a fine-grained, repository-scoped Contents: Read-only token stored encrypted with Android Keystore. Never embed the token in source code or commit it.

No credentials or reservation-person data are included.

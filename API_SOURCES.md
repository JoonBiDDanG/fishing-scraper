# Provider API inventory (from the supplied Android v3.0 APK)

This file records only first-party schedule requests present in the APK's bundled Python modules. It is an integration note, not a claim that every provider permits unlimited polling. Do not add login-only, booking-submit, captcha, or access-control-bypass behavior.

## Confirmed in this APK

| Provider | First-party request | Method | Scope |
|---|---|---:|---|
| Sunsang24 | `https://api.sunsang24.com/ship/schedule_fleet_list/{entry_id}/{YYYYMM}?simple=&possible=&eyyyymm=` | GET | Public monthly schedule JSON for a verified fleet/boat ID. Response rows identify boat and date; published seat counts/status must be explicitly present. |
| TheFishing | `https://thefishing.kr/reservation/list.php?uid={product_uid}` | GET | Public calendar bootstrap. The app checks the page's boat name, product UID and the site's own calendar UID. |
| TheFishing | `https://thefishing.kr/reservation/list.view.view.1.ajax.new.php` | POST | The same-origin monthly calendar request observed in the page script. Form: `date6=YYYYMM&st_uid={page_calendar_uid}&pa_uid={product_uid}`. |

### Constraints

- Keep requests on HTTPS and the exact first-party hosts/routes above. Use only boat IDs supplied by an authorized/public catalogue or explicit configuration; do not enumerate guessed IDs.
- The TheFishing `st_uid` is read from the public bootstrap page; it must not be guessed.
- The APK's parser ignores private reservation-person subtrees and treats ambiguous/missing status or seat counts as unknown.
- Stop polling a provider on HTTP 429, challenge/verification pages, or access-denied responses. Do not rotate identities, spoof browser headers to get around a block, or retry aggressively.
- The APK's own scheduler uses a 100-request execution budget, a per-platform daily cap of 1,200 requests, and 1–2 second minimum request spacing depending on its configured profile. These are app-side safeguards, not published provider quotas. A GitHub Actions run every 10 minutes must therefore process a small rotating subset; it cannot safely refresh all 1,006 catalogue entries every run.
- The submitted APK contains adapters for Sunsang24 and TheFishing only. It contains no ClubSea adapter, so this APK does not provide evidence for a ClubSea API.

## Repository status

The existing `scraper.py` was a placeholder with guessed selectors. This inventory captures the verified request shapes so a later crawler can be built against the source-page flow and a deliberately limited, authorized provider/boat list. No credentials or reservation data are included here.

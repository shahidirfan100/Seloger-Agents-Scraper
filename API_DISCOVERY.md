## Selected API
- Endpoint: `https://www.seloger.com/slr_idb/api/v4/intermediaries`
- Method: `GET`
- Auth: No account authentication; a same-origin browser session is currently required to pass DataDome
- Pagination: `page` and `countPerPage` query params
- Core filters: `geoApiPlaceId`, `geoApiPlaceType`, repeated unbracketed `intermediaryTypes` keys, and `projectType`
- Verified request format: `intermediaryTypes=1&intermediaryTypes=2&intermediaryTypes=3&intermediaryTypes=5`
- Compatibility fallback: bracketed `intermediaryTypes[]` is retained as a one-attempt fallback, but returned `500` during current testing
- Runtime pagination strategy: pages are auto-calculated from `results_wanted` using configurable `countPerPage` with a default of `100`
- Location modes: callers can provide `location.geoApiPlaceId` and `location.geoApiPlaceType`; URL-only runs resolve these from annuaire `__NEXT_DATA__`
- Filter precedence: `filters.projectType` and `filters.intermediaryTypes` override equivalent URL hash values

## Why This API Was Selected
- Returns structured intermediary records for annuaire pages
- Supports pagination and location/type filters
- Includes richer fields than basic HTML cards (`intermediaryId`, `idRcu`, rating, listing counts, profile URL)
- Stable response shape observed across requests; on 2026-09-09 the repeated unbracketed filter format returned valid JSON while the bracketed format returned SeLoger's `500` error page
- Verified page sizes of `8`, `10`, `20`, `50`, `100`, and `200`; each returned the requested number of intermediary records
- Rejected weaker candidates: listing-derived agency data (not a complete directory), the spotlight endpoint (one promoted agency only), DOM parsing (fewer fields), and unconfirmed mobile routes

## Scoring (≥50 required)
| Factor | Points |
|---|---|
| Returns JSON directly | +30 |
| Has >15 unique fields | +25 |
| No auth required | +20 |
| Has pagination support | +15 |
| Matches or extends current fields | +10 |
| **Total** | **100** |

## Available Fields (List API)
- Identity: `intermediary_id`, `seloger_id`, `id_rcu`, `name`, `origin`
- Classification: `intermediary_type`, `intermediary_type_label`
- Profile: `profile_url`, `description`, `logo_src`, `logo_alt`
- Quality signals: `rating_value`, `rating_reviews_count`
- Activity counts: `sell_count`, `rent_count`, `sold_count`, `pro_selection_count`
- List metadata: `locality_*`, `breadcrumb_count`, `first_breadcrumb_label`, `seo_blocks_count`, `redirect_url`
- Ranking metadata: `rank_on_page`, `rank_global`, `page_result_count`
- Context: `project_type`, `intermediary_types`, `geo_api_place_id`, `geo_api_place_type`, `page`, `total_results`, `scraped_at`

## Output Hygiene
- Null and empty values are removed recursively before pushing records to the dataset
- Empty arrays and empty objects are omitted to keep output clean and export-friendly
- Duplicate `intermediary_id` values are skipped across paginated pages
- Optional fields such as `description` and `logo_src` are omitted when the source returns null

## Candidate Matrix
| Candidate | Client/profile | Status and marker | Fields | Pagination | Decision |
|---|---|---|---:|---|---|
| `/slr_idb/api/v4/intermediaries` with repeated keys | Same-origin Chrome session | `200` JSON, `intermediaries` present | More than 15 | `page`, `countPerPage` | Selected |
| `/slr_idb/api/v4/intermediaries` with bracketed keys | Same-origin Chrome session | `500` HTML, `Oups - Seloger` | 0 | Unusable | One-attempt compatibility fallback |
| Direct annuaire endpoint request | Desktop, iOS Safari, Android API profiles | `403` DataDome challenge | 0 | Unknown | Rejected without browser session |
| Annuaire `__NEXT_DATA__` | Same-origin Chrome session | `200`, eight embedded records plus location metadata | More than 15 | Initial page only | Bootstrap source |
| Agency spotlight BFF | Direct JSON request | `200`, one agency | 29 nested fields | No verified pagination | Rejected as incomplete |
| Property search plus classified details | Same-origin session | `200`, agency data attached to listings | Rich but listing-dependent | Listing pages | Rejected as incomplete directory |
| URLScan historical results | Public scan search | No current alternate directory endpoint | 0 | Unknown | Rejected |

## Runtime Resilience (QA Hardening)
- Actor treats transient proxy/network failures, including `407`, `594`, and `ERR_TUNNEL_CONNECTION_FAILED`, as recoverable.
- HTTP bootstrap tries rotating proxy sessions and then a direct connection before browser fallback.
- Explicit API locations avoid the protected annuaire bootstrap entirely.
- Browser fallback uses Patchright with real Chrome, persistent context, non-headless mode, and no fixed viewport; a headless Patchright fallback is used only when Chrome cannot start.
- Challenge-page detection and bounded retries remain active before extraction begins.
- Only `403` or a detected challenge triggers a page reload. Ordinary `5xx` responses retry without reloading, avoiding unnecessary DataDome exposure.
- The verified repeated-key parameter format is attempted first, eliminating four deterministic `500` retries from the previous flow.

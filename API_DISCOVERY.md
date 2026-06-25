## Selected API
- Endpoint: `https://www.seloger.com/slr_idb/api/v4/intermediaries`
- Method: `GET`
- Auth: None — works with plain `gotScraping` and browser-like headers (no cookies required)
- Pagination: `page` and `countPerPage` query params
- Core filters: `geoApiPlaceId`, `geoApiPlaceType`, `intermediaryTypes[]`, `projectType`
- Runtime pagination strategy: pages are auto-calculated from `results_wanted` using `countPerPage=8`
- Bootstrap: annuaire page `__NEXT_DATA__` provides `geoApiPlaceId` and `geoApiPlaceType` from `startUrl`

## Why This API Was Selected
- Returns structured intermediary records for annuaire pages
- Supports pagination and location/type filters
- Includes richer fields than basic HTML cards (`intermediaryId`, `idRcu`, rating, listing counts, profile URL)
- Stable response shape observed across requests
- Rejected weaker candidates: HTML card parsing (fewer fields, fragile selectors), Playwright-only flow (slower, unnecessary when API responds to direct HTTP)

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

## Runtime Resilience (QA Hardening)
- Actor now treats transient proxy/network failures (including `ERR_TUNNEL_CONNECTION_FAILED`) as recoverable and rotates strategy automatically
- When proxy input is provided, multiple proxy sessions are attempted before fallback
- A direct connection fallback is included as last-resort auto-healing path
- Challenge-page detection and retry logic remain active before API extraction begins

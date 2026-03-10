## Selected API
- Endpoint: `https://www.seloger.com/slr_idb/api/v4/intermediaries`
- Method: `GET`
- Auth: No explicit API key required, but session cookies from SeLoger web session are required
- Pagination: `page` and `countPerPage` query params
- Core filters: `geoApiPlaceId`, `geoApiPlaceType`, `intermediaryTypes[]`, `projectType`
- Runtime pagination strategy: pages are auto-calculated from `results_wanted` using `countPerPage=8`

## Why This API Was Selected
- Returns structured intermediary records for annuaire pages
- Supports pagination and location/type filters
- Includes richer fields than basic HTML cards (`intermediaryId`, `idRcu`, rating, listing counts, profile URL)
- Stable response shape observed across requests

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
- Empty arrays and empty objects are omitted to keep output clean and API-friendly

## What does SeLoger Agents Scraper do?

Extract real estate agency, independent consultant, developer, and property administrator profiles from SeLoger annuaire pages. Enter a city or district annuaire URL and collect structured business identity, rating, activity volume, location metadata, and ranking data from the SeLoger directory. The output works for lead generation, CRM enrichment, market analysis, and competitive intelligence in the French property market.

## Why use SeLoger Agents Scraper?

- **Structured agent directory** - Collect intermediary profiles with names, types, ratings, listing counts, and location data from SeLoger annuaire search results. No manual copying from directory pages.
- **Automation-ready dataset** - Export results to JSON, CSV, Excel, or XML. Connect datasets to BI tools, CRM systems, or data pipelines.
- **Search-filter control** - Target specific intermediary types (agencies, independent consultants, developers, property administrators) and project types (buying, renting) through URL hash filters available on SeLoger.
- **Production reliability** - Pagination across multiple result pages is automatic. Higher page sizes reduce request count. Residential proxy support is available for consistent large-scale runs.

## What data can you extract from SeLoger?

| Field | Description |
|-------|-------------|
| `name` | Agency, consultant, developer, or administrator display name |
| `intermediary_type_label` | Intermediary category: Real estate agency, Independent consultant, Developer, or Property administrator |
| `profile_url` | Direct SeLoger profile URL for each intermediary |
| `rating_value` | Rating score from the annuaire list data |
| `rating_reviews_count` | Number of reviews from the annuaire list data |
| `sell_count` | Number of sale listings associated with the intermediary |
| `rent_count` | Number of rent listings associated with the intermediary |
| `sold_count` | Number of sold listings associated with the intermediary |
| `locality_name` | City or locality name from the search response |
| `locality_postal_code` | Postal code from the search response |
| `rank_global` | Global position in the search results across all pages |
| `description` | Public profile description when available |

## How to scrape SeLoger agent data

1. Go to SeLoger and navigate to the annuaire page for your target city or district (e.g., `https://www.seloger.com/annuaire/paris-75000/`).
2. Apply any filters you need (intermediary types, project type) - these become hash parameters in the URL.
3. Copy the full URL from your browser address bar.
4. Open the SeLoger Agents Scraper on Apify Store.
5. Paste the URL into the `startUrl` field.
6. Set the number of profiles you want to collect.
7. Run the Actor.
8. Download the dataset or connect it to your workflow.

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `startUrl` | String | No | Paris annuaire URL | SeLoger annuaire URL with location and filters. The hash fragment carries `intermediaryTypes` and `projectType` parameters. |
| `results_wanted` | Integer | No | `20` | Maximum number of intermediary profiles to collect. Minimum 1. |
| `count_per_page` | Integer | No | `100` | Records requested per API call. Higher values reduce pagination requests and may reduce blocking risk. |
| `proxyConfiguration` | Object | No | Apify residential proxy | Proxy settings for production runs. Residential proxy is recommended for consistent results at scale. |

## Output Data

| Field | Type | Description |
|-------|------|-------------|
| `intermediary_id` | Integer | SeLoger intermediary numeric ID |
| `seloger_id` | String | Secondary SeLoger ID |
| `id_rcu` | String | RCU identifier (French real estate register) when available |
| `origin` | String | Intermediary source system |
| `name` | String | Agency or consultant display name |
| `intermediary_type` | Integer | Numeric intermediary type code (1, 2, 3, or 5) |
| `intermediary_type_label` | String | Human-readable label: Real estate agency, Independent consultant, Developer, or Property administrator |
| `description` | String | Public profile description when available |
| `intermediary_url_path` | String | Relative intermediary profile path |
| `profile_url` | String | Absolute SeLoger intermediary profile URL |
| `logo_src` | String | Logo image source URL when available |
| `logo_alt` | String | Logo image alt text when available |
| `rating_value` | Number | Rating value from annuaire list data |
| `rating_reviews_count` | Integer | Number of reviews from annuaire list data |
| `sell_count` | Integer | Number of sale listings linked to the intermediary |
| `rent_count` | Integer | Number of rent listings linked to the intermediary |
| `sold_count` | Integer | Number of sold listings linked to the intermediary |
| `pro_selection_count` | Integer | Number of professional selection listings linked to the intermediary |
| `rank_on_page` | Integer | Position within the current page results (1-indexed) |
| `rank_global` | Integer | Global rank across all pages |
| `page_result_count` | Integer | Number of intermediaries on this API page |
| `page` | Integer | Annuaire API page number |
| `count_per_page` | Integer | Count per page value used in API calls |
| `total_results` | Integer | Total intermediaries matching the query |
| `locality_url_path` | String | Locality URL path from API response |
| `locality_place_id` | Integer | Locality place ID from API response |
| `locality_place_type` | String | Locality place type (city, district) |
| `locality_name` | String | Locality name (e.g., Paris) |
| `locality_postal_code` | String | Locality postal code (e.g., 75000) |
| `breadcrumb_count` | Integer | Number of breadcrumb items in the API response |
| `first_breadcrumb_label` | String | First breadcrumb label (e.g., Immobilier) |
| `seo_blocks_count` | Integer | Number of SEO blocks in the API response |
| `redirect_url` | String | Redirect URL if the API response includes one |
| `geo_api_place_id` | String | Geographic place ID used in the API call |
| `geo_api_place_type` | String | Geographic place type used in the API call |
| `project_type` | String | Project type used in the annuaire query (e.g., "1" for buying) |
| `intermediary_types` | Array | Intermediary type filters used in the annuaire query |
| `search_url` | String | Original annuaire search URL |
| `scraped_at` | String | ISO 8601 timestamp of extraction |

## Usage Examples

### Basic City Run

Start with a Paris annuaire URL using all intermediary types and a small result count for testing:

```json
{
  "startUrl": "https://www.seloger.com/annuaire/paris-75000/#intermediaryTypes=1&intermediaryTypes=2&intermediaryTypes=3&intermediaryTypes=5&projectType=1",
  "results_wanted": 20,
  "count_per_page": 100
}
```

### Larger Collection

Collect more profiles from the same search. Pagination is handled automatically:

```json
{
  "startUrl": "https://www.seloger.com/annuaire/paris-75000/#intermediaryTypes=1&intermediaryTypes=2&intermediaryTypes=3&intermediaryTypes=5&projectType=1",
  "results_wanted": 200,
  "count_per_page": 100
}
```

### Residential Proxy for Production

Use residential proxy routing for consistent results during high-volume or frequent runs:

```json
{
  "startUrl": "https://www.seloger.com/annuaire/lyon-69000/#intermediaryTypes=1&intermediaryTypes=2&projectType=1",
  "results_wanted": 100,
  "count_per_page": 100,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

## Sample Output

```json
{
  "intermediary_id": 648913,
  "seloger_id": "568495",
  "id_rcu": "RC-1934346",
  "name": "Antoine BANIEL consultant megAgence",
  "intermediary_type": 2,
  "intermediary_type_label": "Independent consultant",
  "intermediary_url_path": "/professionnels/agents-commerciaux/paris-13eme-arrondissement-75013/agence-648913/",
  "profile_url": "https://www.seloger.com/professionnels/agents-commerciaux/paris-13eme-arrondissement-75013/agence-648913/",
  "description": "megAgence est l'agence immobiliere nationale de toute derniere generation...",
  "rating_value": 0,
  "rating_reviews_count": 0,
  "sell_count": 5,
  "rent_count": 12,
  "sold_count": 3,
  "rank_on_page": 1,
  "rank_global": 1,
  "page_result_count": 100,
  "locality_name": "Paris",
  "locality_postal_code": "75000",
  "locality_place_type": "city",
  "locality_place_id": 138724240,
  "locality_url_path": "/annuaire/paris-75000/",
  "breadcrumb_count": 4,
  "first_breadcrumb_label": "Immobilier",
  "seo_blocks_count": 4,
  "total_results": 3267,
  "page": 1,
  "count_per_page": 100,
  "project_type": "1",
  "intermediary_types": [1, 2, 3, 5],
  "search_url": "https://www.seloger.com/annuaire/paris-75000/#intermediaryTypes=1&intermediaryTypes=2&intermediaryTypes=3&intermediaryTypes=5&projectType=1",
  "scraped_at": "2026-03-10T12:20:30.000Z"
}
```

## Tips for Best Results

- Use a fully filtered annuaire URL from SeLoger to keep runs repeatable and aligned with your target market. The hash fragment in the URL controls intermediary types and project type.
- Start with a small `results_wanted` value (20) for validation, then scale up once you confirm data quality.
- Pagination is automatic. The Actor calculates the required number of pages from `results_wanted` and `count_per_page`.
- A higher `count_per_page` value (100 or more) reduces the total number of requests and can help avoid rate limits.
- Use residential proxies for production runs, especially at high frequency or large volume.

## Integrations

- **Google Sheets** - Export agent profiles to spreadsheets for team collaboration.
- **Webhooks** - Trigger downstream workflows after each run completes.
- **Make or Zapier** - Connect intermediary data to no-code automations.
- **API** - Access datasets programmatically from your own systems.
- **Export formats** - Download results in JSON, CSV, Excel, XML, and other supported formats.

## Frequently Asked Questions

### Can I scrape agents from a different city?

Yes. Replace `startUrl` with the SeLoger annuaire URL of any target city, district, or postal code. The Actor works with any valid annuaire location page.

### Why are some fields missing on certain records?

Profile completeness varies by intermediary. Empty values are omitted by design so your dataset stays clean. Fields like `id_rcu`, `description`, and `logo_src` are only present when the intermediary publishes them.

### Can I collect data without opening individual detail pages?

Yes. The Actor collects list-level profile data from annuaire search results and does not open individual intermediary detail pages. This makes collection faster and reduces load on the source.

### How do I control which intermediary types are included?

Use hash parameters in the SeLoger annuaire URL. The `intermediaryTypes` parameter accepts values 1 (agencies), 2 (independent consultants), 3 (developers), and 5 (property administrators). The `projectType` parameter accepts 1 (buying) or 2 (renting). Combine these in the URL fragment.

### Can I schedule recurring runs?

Yes. Schedule the Actor in Apify Console to run hourly, daily, or weekly. Recurring runs let you track intermediary presence and activity changes over time.

### Can I export the data to CSV or Excel?

Yes. Apify datasets can be downloaded in CSV, Excel, JSON, XML, and other supported formats from the Apify Console storage view.

## Related Actors

- [Realtor.com Scraper](https://apify.com/shahidirfan/realtor-com-scraper) - Extract property listings and agent details from Realtor.com for US market research and lead generation.
- [Redfin Property Scraper](https://apify.com/shahidirfan/redfin-property-scraper) - Collect real estate listings and property details from Redfin for pricing analysis and investment research.
- [PropertyGuru Scraper](https://apify.com/shahidirfan/propertyguru-scraper) - Extract property listings from PropertyGuru Malaysia and Singapore for Southeast Asian market intelligence.
- [Funda.nl Scraper](https://apify.com/shahidirfan/funda-nl-scraper) - Collect Dutch property listings from Funda.nl for Netherlands real estate market analysis.

## Support

For issues, feature requests, or custom scraping needs, use the Issues tab on the Actor page or contact the developer through Apify.

## Legal Notice

This Actor extracts publicly available data from SeLoger annuaire pages. Users are responsible for complying with applicable laws, platform terms of service, and data protection regulations including the French Data Protection Act and GDPR. Collected data should be used responsibly and in accordance with privacy obligations.

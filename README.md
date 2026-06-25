# SeLoger Agents Scraper

Extract real estate agencies, consultants, and intermediary profiles from SeLoger annuaire pages. Collect structured business identity, contact, rating, and activity data at scale from a city or district search URL. This actor is ideal for market intelligence, lead sourcing, and CRM enrichment workflows.

---

## Features

- **Annuaire URL based extraction** - Start from any SeLoger annuaire location URL.
- **Pagination support** - Collect intermediary records across multiple result pages.
- **Fast structured extraction** - Collect intermediary records directly from SeLoger annuaire list data.
- **Null-free output** - Empty values are removed recursively before dataset export.
- **Production-ready schema** - Structured records designed for BI tools and automations.

---

## Use Cases

### Agency Prospecting
Build a clean database of agencies and consultants by city, then prioritize prospects based on activity volume and profile completeness.

### Market Coverage Analysis
Measure intermediary density and activity per market to compare local competition and identify expansion opportunities.

### CRM Enrichment
Append profile URLs, contact details, and location metadata to existing lead lists for better outreach workflows.

### Competitive Intelligence
Track intermediary presence and profile-level attributes over time to monitor who is active in each local market.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `startUrl` | String | No | Paris annuaire URL | SeLoger annuaire URL with location and filters. |
| `results_wanted` | Integer | No | `20` | Maximum number of intermediary profiles to collect. |
| `proxyConfiguration` | Object | No | `{"useApifyProxy":true,"apifyProxyGroups":["RESIDENTIAL"]}` | Proxy settings for reliability in blocked environments. |

---

## Output Data

Each item in the dataset can contain:

| Field | Type | Description |
|---|---|---|
| `intermediary_id` | Integer | SeLoger intermediary ID. |
| `seloger_id` | String | Secondary SeLoger ID value. |
| `id_rcu` | String | RCU identifier when available. |
| `name` | String | Agency or consultant name. |
| `intermediary_type` | Integer | Numeric intermediary type code. |
| `intermediary_type_label` | String | Human-readable intermediary type label. |
| `intermediary_url_path` | String | Relative intermediary profile path. |
| `profile_url` | String | Absolute profile URL. |
| `description` | String | Public profile description. |
| `rating_value` | Number | Rating value from list data. |
| `rating_reviews_count` | Integer | Review count from list data. |
| `sell_count` | Integer | Number of sale listings linked to profile. |
| `rent_count` | Integer | Number of rent listings linked to profile. |
| `sold_count` | Integer | Number of sold listings linked to profile. |
| `pro_selection_count` | Integer | Number of selection listings linked to profile. |
| `rank_on_page` | Integer | Position of intermediary within the page results. |
| `rank_global` | Integer | Global position derived from page and index. |
| `page_result_count` | Integer | Number of intermediaries returned on this page. |
| `locality_name` | String | Locality name from search response metadata. |
| `locality_postal_code` | String | Locality postal code from search metadata. |
| `locality_place_type` | String | Locality place type (city, district, etc.). |
| `locality_place_id` | Integer | Locality place ID used by annuaire search. |
| `locality_url_path` | String | Locality URL path from search response. |
| `breadcrumb_count` | Integer | Number of breadcrumb entries in response. |
| `first_breadcrumb_label` | String | First breadcrumb label in response metadata. |
| `seo_blocks_count` | Integer | Number of SEO blocks returned in search response. |
| `redirect_url` | String | Redirect URL if the search response includes one. |
| `total_results` | Integer | Total intermediaries matching the query. |
| `page` | Integer | Source page number in annuaire pagination. |
| `scraped_at` | String | ISO extraction timestamp. |

---

## Usage Examples

### Basic City Run

```json
{
    "startUrl": "https://www.seloger.com/annuaire/paris-75000/#intermediaryTypes=1&intermediaryTypes=2&intermediaryTypes=3&intermediaryTypes=5&projectType=1",
    "results_wanted": 20
}
```

### Larger Collection

```json
{
    "startUrl": "https://www.seloger.com/annuaire/paris-75000/#intermediaryTypes=1&intermediaryTypes=2&intermediaryTypes=3&intermediaryTypes=5&projectType=1",
    "results_wanted": 120
}
```

### Proxy Enabled Run

```json
{
    "startUrl": "https://www.seloger.com/annuaire/paris-75000/#intermediaryTypes=1&intermediaryTypes=2&intermediaryTypes=3&intermediaryTypes=5&projectType=1",
    "results_wanted": 50,
    "proxyConfiguration": {
        "useApifyProxy": true,
        "apifyProxyGroups": ["RESIDENTIAL"]
    }
}
```

---

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
    "sell_count": 0,
    "rent_count": 0,
    "rank_on_page": 1,
    "rank_global": 1,
    "page_result_count": 8,
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
    "scraped_at": "2026-03-10T12:20:30.000Z"
}
```

---

## Tips for Best Results

### Start From a Final Search URL
Use a fully filtered annuaire URL generated on SeLoger to keep runs repeatable and aligned with your target market.

### Keep QA and Validation Runs Small
Use `results_wanted: 20` for quick checks, then scale up once you validate data quality.

### Pagination Is Automatic
The actor automatically calculates the number of pages from `results_wanted`, so no pagination input is required.

### Use Residential Proxies in Production
If you run at high frequency or collect large volumes, residential proxy routing improves consistency.

---

## Integrations

Connect output data with:

- **Google Sheets** - Share intermediary datasets with non-technical teams.
- **Airtable** - Create searchable directories and enrichment pipelines.
- **Make** - Trigger automations when new profiles appear.
- **Zapier** - Route records into CRM and sales stacks.
- **Webhooks** - Send fresh intermediary data to your own services.

### Export Formats

- **JSON** for apps and APIs
- **CSV** for spreadsheets
- **Excel** for reporting
- **XML** for integration workflows

---

## Frequently Asked Questions

### Why are some fields missing on certain records?
Profile completeness varies by intermediary. Empty values are omitted by design so your dataset stays clean.

### Can I scrape a different city?
Yes. Replace `startUrl` with the annuaire URL of any target city or district.

### Can I collect without opening profile details?
Yes. The actor collects list-level profile data and does not open individual intermediary detail pages.

### How do I control intermediary categories?
Use hash filters directly in `startUrl` (`intermediaryTypes` and `projectType`).

### Can I schedule recurring runs?
Yes. Schedule actor runs to build historical snapshots for monitoring and analytics.

---

## Support

For issues or enhancement requests, use the actor issue tracker or your support channel in Apify Console.

---

## Legal Notice

Use this actor in compliance with platform terms, local laws, and data protection obligations. You are responsible for how collected data is stored, processed, and used.

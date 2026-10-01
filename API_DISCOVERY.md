# SeLoger Agent Directory Source Review

Research date: 2026-09-23
Updated: 2026-09-30 (verified working flow)

## Verified working flow (2026-09-30)

A fresh Apify cloud run now collects directory records end to end:

- Paris, all types, 20 requested -> 20 saved, run `SUCCEEDED`.
- Paris, all types, 120 requested at 50/page -> 120 unique saved across 3 pages, continuous ranks.
- Lyon, types 1 and 2, 15 requested -> 15 saved, `total_results` 541, run `SUCCEEDED`.

Cloud runs execute under `xvfb-run` (the base image entrypoint wraps the command), so Google Chrome runs in headed mode inside the container. Headless Chromium/Chrome is detected by DataDome and returns a challenge; headed Chrome from the image is not detected in these runs.

## Why the previous version failed

The old `src/main.js` never reached extraction, even when the browser itself could load the site:

1. It waited for `__NEXT_DATA__` in the annuaire HTML. The current SeLoger annuaire is a client-rendered Next.js app served from `/slr_idw/`; the delivered HTML does not contain `__NEXT_DATA__`, so the success condition never matched.
2. It treated any DataDome challenge HTML as a permanent stop and returned before calling the API. In practice the `datadome` cookie is issued within about a second and the JSON API then answers `200` even while the visible page still shows the interstitial.
3. It resolved `geoApiPlaceId` / `geoApiPlaceType` from the page. The page does not expose them, so extraction could not be located.
4. It capped `countPerPage` to the remaining `results_wanted`. The API computes its offset as `(page - 1) * countPerPage`, so changing the page size on the last page shifted the offset and returned already-seen rows.

## Selected source

- Endpoint: `GET https://www.seloger.com/slr_idb/api/v4/intermediaries`
- Required context: the request must run inside a real headed browser page context on `www.seloger.com` (`fetch(..., { credentials: 'include' })`). The `datadome` cookie set by the live page is required.
- Query parameters:
  - `urlPath` - annuaire path, for example `/annuaire/paris-75000/`. This alone is sufficient to locate the directory. `geoApiPlaceId` and `geoApiPlaceType` are optional.
  - `intermediaryTypes` - repeated key, values 1, 2, 3, 5.
  - `projectType` - `1` (buy) or `2` (rent).
  - `countPerPage` - kept constant across pages.
  - `page` - 1-based page number.
- Header: `x-business-unit: 1` (sent by the site; not strictly required, kept for parity).
- Pagination: `page` with a fixed `countPerPage`; stop when a page returns fewer rows than requested.
- Response fields used: `intermediaries[]` (`intermediaryId`, `id`, `idRcu`, `origin`, `logo`, `intermediaryType`, `name`, `rating`, `properties`, `url`, `description`), `intermediariesCount`, `locality.place`, `locality.urlPath`, `breadCrumb`, `seoBlocks`, `redirectUrl`.

The actor preserves its existing output contract. No dataset field names or meanings changed.

## Evidence matrix

| Candidate | Result | Decision |
|---|---|---|
| Direct HTTP (`fetch`) to the annuaire page or the API | HTTP 403, DataDome challenge, no data | Rejected |
| Impit with browser emulation (`chrome`, `chrome131`, `chrome136`, `firefox`, `ios18`, `okhttp4`) to the page or API | HTTP 403, DataDome challenge | Rejected for direct use |
| Patchright headless (bundled Chromium and `channel: chrome`) | `datadome` cookie issued, but the API returns HTTP 403 with a captcha URL | Rejected |
| Patchright headed `channel: chrome` (local display; Xvfb on Apify) | `datadome` cookie issued; API in page context returns `200` JSON immediately | Selected |
| Reusing the browser cookie from Node `fetch` or Impit | Not reliable in testing | Not used; requests stay in the browser context |
| Static Next.js chunks under `/slr_idw/_next/static/...` | Publicly fetchable, not needed at runtime | Used only to confirm the API contract |

Notes:

- Impit-based and plain-HTTP requests connect from outside the browser and are rejected because the server requires the browser-issued `datadome` cookie bound to the browser session.
- Keeping the API call inside the same page context keeps the cookie, TLS fingerprint, and proxy IP aligned, which is required for the request to be accepted.
- Browser requests go through the configured proxy because the whole context uses it. The actor defaults to Apify residential proxy on the platform.

## Supported/legal access

SeLoger's terms prohibit automated extraction, and its robots file disallows `/slr_idb/api/*`. The technical flow above is documented for maintainers and for runs the operator is permitted to perform. SeLoger may still deny a session at any time. The supported, durable route for guaranteed production access remains the AVIV/SeLoger partner path:

- AVIV France onboarding: https://www.developers.aviv-group.com/guides/how-to-onboard-on-aviv-apis/onboarding-path-french-apis-seloger-services
- AVIV support: https://www.developers.aviv-group.com/support
- SeLoger terms: https://www.seloger.com/Conditions_Generales_d_Utilisation.html

## Existing actor contract

- Search input: a SeLoger annuaire `startUrl` (legacy `start_url` alias still read).
- Optional input: location and professional/project filters.
- Result controls: `results_wanted` and `count_per_page`.
- Output: the existing intermediary mapping in `src/main.js`.
- Default filter requests types `1`, `2`, `3`, and `5`.

## Reliability changes in `src/main.js`

- The browser always runs headed (`channel: chrome`); on Apify the base image runs it under Xvfb.
- Bootstrap navigates to the annuaire URL and waits for the `datadome` cookie, not for `__NEXT_DATA__`. A DataDome interstitial is no longer treated as a hard stop.
- The API is called from the page context using `urlPath`, removing the dependency on page-embedded place IDs.
- A DataDome challenge, HTTP 403/407/429/5xx, or network error is retried with bounded backoff and a session refresh; the delay honors `Retry-After`.
- `countPerPage` stays constant across pages so pagination offsets remain aligned.
- Bootstrap and API failures are reported as actor failures when no records were saved; successful partial datasets remain available if a later page fails.

## Evidence limits

- Verification used Apify residential proxy defaults on Linux/Xvfb and a local headed Chrome on Windows. Other proxy types, concurrent data-center access, or heavy scheduling may still be denied.
- This endpoint is undocumented and disallowed in SeLoger's robots file. Stable, supported production access requires SeLoger/AVIV partner access.

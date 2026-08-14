import { readFile } from 'node:fs/promises';

import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';
import { Dataset } from 'crawlee';
import { Impit } from 'impit';
import { chromium } from 'playwright';

const DEFAULT_COUNT_PER_PAGE = 100;
const API_BASE = 'https://www.seloger.com/slr_idb/api/v4/intermediaries';
const DEFAULT_PROXY_CONFIGURATION = {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
};
const MAX_IMPIT_ATTEMPTS = 3;
const MAX_BROWSER_SESSIONS = 2;
const IMPIT_TIMEOUT_MS = 12_000;
const BROWSER_NAVIGATION_TIMEOUT_MS = 15_000;
const BOOTSTRAP_WAIT_MS = 10_000;
const PROXY_URL_TIMEOUT_MS = 5_000;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

const INTERMEDIARY_TYPE_LABELS = {
    1: 'Real estate agency',
    2: 'Independent consultant',
    3: 'Developer',
    5: 'Property administrator',
};

const sleep = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

function toPositiveInteger(value, fallback) {
    const normalizedValue = typeof value === 'string' ? value.trim() : value;
    const parsed = Number(normalizedValue);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function toAbsoluteSelogerUrl(url) {
    if (!url || typeof url !== 'string') return undefined;
    try {
        return new URL(url, 'https://www.seloger.com').href;
    } catch {
        return undefined;
    }
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getCaseInsensitiveField(record, ...names) {
    if (!isRecord(record)) return undefined;

    for (const name of names) {
        if (Object.hasOwn(record, name)) return record[name];
    }

    const normalizedNames = new Set(names.map((name) => String(name).toLowerCase()));
    const matchingKey = Object.keys(record).find((key) => normalizedNames.has(key.toLowerCase()));
    return matchingKey === undefined ? undefined : record[matchingKey];
}

function getNestedCaseInsensitiveField(record, ...path) {
    return path.reduce((current, key) => getCaseInsensitiveField(current, key), record);
}

function getHashParameterValues(params, name) {
    const normalizedName = name.toLowerCase();
    return [...params.entries()].filter(([key]) => key.toLowerCase() === normalizedName).map(([, value]) => value);
}

function normalizeIntermediaryTypes(value, fallback) {
    let source = fallback;
    if (Array.isArray(value)) {
        source = value;
    } else if (value) {
        source = [value];
    }

    const parsed = source
        .flatMap((item) => String(item).split(','))
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => Number(item))
        .filter((item) => Number.isSafeInteger(item) && item > 0);

    if (parsed.length === 0) return fallback;
    return Array.from(new Set(parsed));
}

function cleanData(value) {
    if (value === null || value === undefined || value === '') return undefined;

    if (Array.isArray(value)) {
        const cleaned = value.map((entry) => cleanData(entry)).filter((entry) => entry !== undefined);
        return cleaned.length > 0 ? cleaned : undefined;
    }

    if (typeof value === 'object') {
        const entries = Object.entries(value)
            .map(([key, entry]) => [key, cleanData(entry)])
            .filter(([, entry]) => entry !== undefined);
        return entries.length > 0 ? Object.fromEntries(entries) : undefined;
    }

    return value;
}

function parseStartUrl(url) {
    const normalizedUrl = toAbsoluteSelogerUrl(String(url || '').trim());
    if (!normalizedUrl) throw new Error('startUrl must be a valid SeLoger annuaire URL.');

    const parsed = new URL(normalizedUrl);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname !== 'seloger.com' && !hostname.endsWith('.seloger.com')) {
        throw new Error('startUrl must point to a SeLoger annuaire page.');
    }
    const hashParams = new URLSearchParams(parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash);

    return {
        normalizedUrl: parsed.href,
        projectType: getHashParameterValues(hashParams, 'projectType')[0] || '1',
        intermediaryTypes: normalizeIntermediaryTypes(
            getHashParameterValues(hashParams, 'intermediaryTypes'),
            [1, 2, 3, 5],
        ),
    };
}

function extractAnnuaireContext(html, parsedUrl) {
    const $ = cheerio.load(html);
    const nextDataText = $('#__NEXT_DATA__').text() || '{}';

    let nextData = {};
    try {
        nextData = JSON.parse(nextDataText);
    } catch {
        nextData = {};
    }

    const search = getNestedCaseInsensitiveField(nextData, 'props', 'pageProps', 'initialState', 'search') || {};
    const locality = getCaseInsensitiveField(search, 'locality', 'maPlace') || {};
    const results = getCaseInsensitiveField(search, 'results') || {};

    const geoApiPlaceId = getCaseInsensitiveField(locality, 'geoApiPlaceId', 'id', 'placeId');
    const geoApiPlaceType = getCaseInsensitiveField(locality, 'geoApiPlaceType', 'type', 'placeType');

    return {
        geoApiPlaceId: geoApiPlaceId ? String(geoApiPlaceId) : undefined,
        geoApiPlaceType: geoApiPlaceType || undefined,
        projectType: parsedUrl.projectType || String(getCaseInsensitiveField(search, 'projectType') || '1'),
        intermediaryTypes: parsedUrl.intermediaryTypes,
        totalResults: getCaseInsensitiveField(results, 'intermediariesCount'),
    };
}

function buildApiUrl(params) {
    const query = new URLSearchParams();
    query.set('geoApiPlaceId', params.geoApiPlaceId);
    query.set('geoApiPlaceType', params.geoApiPlaceType);
    query.set('countPerPage', String(params.countPerPage));
    query.set('page', String(params.pageNumber));
    query.set('projectType', String(params.projectType));
    for (const type of params.intermediaryTypes) {
        query.append('intermediaryTypes[]', String(type));
    }
    return `${API_BASE}?${query.toString()}`;
}

function withoutUrlFragment(url) {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
}

function getBrowserLikeHeaders({ document = false, referer } = {}) {
    if (document) {
        return {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Upgrade-Insecure-Requests': '1',
        };
    }

    return {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        ...(referer && { Referer: withoutUrlFragment(referer) }),
    };
}

function isChallengePage(html) {
    const normalizedHtml = String(html || '').toLowerCase();
    return (
        normalizedHtml.includes('captcha-delivery.com') ||
        normalizedHtml.includes('please enable js and disable any ad blocker') ||
        normalizedHtml.includes('x-datadome') ||
        normalizedHtml.includes('datadome')
    );
}

function isRetryableStatus(status) {
    return RETRYABLE_STATUSES.has(status) || status === 403;
}

function retryDelay(waitMs, attempt) {
    return Math.min(waitMs * 2 ** (attempt - 1), 8_000);
}

function getErrorMessage(error) {
    return String(error?.message || error || 'unknown error')
        .split(/\r?\n/, 1)[0]
        .slice(0, 240);
}

async function waitForAnnuaireHtml(page) {
    const startedAt = Date.now();
    let html = '';

    while (Date.now() - startedAt < BOOTSTRAP_WAIT_MS) {
        html = await page.content().catch(() => '');
        if (html.includes('__NEXT_DATA__')) return html;

        const delay = isChallengePage(html) ? 1000 : 500;
        await page.waitForTimeout(delay);
    }

    return html;
}

async function getProxyUrl(proxyConfiguration) {
    if (!proxyConfiguration) return undefined;

    let timeoutId;
    try {
        const timeout = new Promise((resolve) => {
            timeoutId = setTimeout(() => resolve(undefined), PROXY_URL_TIMEOUT_MS);
        });
        const proxyUrl = await Promise.race([proxyConfiguration.newUrl(), timeout]);
        if (!proxyUrl) log.warning('Proxy URL was not available within 5 seconds; using direct connection.');
        return proxyUrl;
    } catch (error) {
        log.warning(`Proxy session unavailable; trying direct connection: ${getErrorMessage(error)}.`);
        return undefined;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

async function openImpitSession(startUrl, proxyConfiguration) {
    let lastStatus;
    let lastReason = 'unknown error';

    for (let attempt = 1; attempt <= MAX_IMPIT_ATTEMPTS; attempt += 1) {
        try {
            const proxyUrl = await getProxyUrl(proxyConfiguration);
            const client = new Impit({
                browser: 'chrome',
                ignoreTlsErrors: true,
                ...(proxyUrl && { proxyUrl }),
            });
            const response = await client.fetch(startUrl, {
                headers: getBrowserLikeHeaders({ document: true }),
                signal: AbortSignal.timeout(IMPIT_TIMEOUT_MS),
            });
            const html = await response.text();

            if (response.ok && html.includes('__NEXT_DATA__')) {
                log.info('Annuaire bootstrap completed with Impit HTTP flow.');
                return { kind: 'impit', client, html, referer: startUrl };
            }

            lastStatus = response.status;
            lastReason = isChallengePage(html) ? 'DataDome challenge' : 'missing __NEXT_DATA__';
            log.warning(
                `Impit bootstrap unavailable (attempt ${attempt}/${MAX_IMPIT_ATTEMPTS}), ` +
                    `status ${lastStatus || 'unknown'}, reason ${lastReason}; trying browser fallback.`,
            );
        } catch (error) {
            lastReason = getErrorMessage(error);
            log.warning(`Impit bootstrap error (attempt ${attempt}/${MAX_IMPIT_ATTEMPTS}): ${lastReason}.`);
        }

        if (attempt < MAX_IMPIT_ATTEMPTS) await sleep(retryDelay(500, attempt));
    }

    return { lastStatus, lastReason };
}

async function createBrowserSession(proxyUrl) {
    const browser = await chromium.launch({
        headless: true,
        ...(proxyUrl && { proxy: { server: proxyUrl } }),
        args: ['--disable-blink-features=AutomationControlled'],
    });

    const browserVersion = browser.version().replace(/^HeadlessChrome\//, 'Chrome/');
    const context = await browser.newContext({
        userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ${browserVersion} Safari/537.36`,
        locale: 'fr-FR',
        timezoneId: 'Europe/Paris',
        viewport: { width: 1365, height: 900 },
        extraHTTPHeaders: {
            'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        },
    });

    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();
    return { browser, context, page };
}

async function openBrowserSession(startUrl, proxyConfiguration) {
    let lastStatus;
    let lastReason = 'unknown error';

    for (let attempt = 1; attempt <= MAX_BROWSER_SESSIONS; attempt += 1) {
        let session;
        try {
            const proxyUrl = await getProxyUrl(proxyConfiguration);
            session = await createBrowserSession(proxyUrl);

            let response;
            try {
                response = await session.page.goto(startUrl, {
                    waitUntil: 'commit',
                    timeout: BROWSER_NAVIGATION_TIMEOUT_MS,
                });
            } catch (error) {
                lastReason = getErrorMessage(error);
                log.warning(`Browser navigation did not finish immediately: ${lastReason}.`);
            }
            const html = await waitForAnnuaireHtml(session.page);

            if (html.includes('__NEXT_DATA__')) {
                return { ...session, html };
            }

            lastStatus = response?.status();
            lastReason = isChallengePage(html) ? 'DataDome challenge' : 'missing __NEXT_DATA__';
            log.warning(
                `Annuaire browser bootstrap failed (attempt ${attempt}/${MAX_BROWSER_SESSIONS}), ` +
                    `status ${lastStatus || 'unknown'}, reason ${lastReason}.`,
            );
        } catch (error) {
            lastReason = getErrorMessage(error);
            log.warning(
                `Annuaire browser bootstrap error (attempt ${attempt}/${MAX_BROWSER_SESSIONS}): ${lastReason}.`,
            );
        }

        if (session) await session.browser.close().catch(() => {});
        if (attempt < MAX_BROWSER_SESSIONS) await sleep(1500 * attempt);
    }

    log.warning(`Could not load annuaire page (status ${lastStatus || 'unknown'}; ${lastReason}).`);
    return { kind: 'unavailable', lastStatus, lastReason };
}

async function openAnnuaireSession(startUrl, proxyConfiguration) {
    const impitSession = await openImpitSession(startUrl, proxyConfiguration);
    if (impitSession.kind === 'impit') return impitSession;

    return openBrowserSession(startUrl, proxyConfiguration);
}

async function fetchApiJsonWithImpit(client, url, { retries = 4, waitMs = 500, label, referer }) {
    let lastResult;

    for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
            const response = await client.fetch(url, {
                headers: getBrowserLikeHeaders({ referer }),
                signal: AbortSignal.timeout(IMPIT_TIMEOUT_MS),
            });
            lastResult = { ok: response.ok, status: response.status, body: await response.text() };
        } catch (error) {
            lastResult = { ok: false, status: 0, error: getErrorMessage(error) };
        }

        let data;
        try {
            data = JSON.parse(lastResult?.body || '');
        } catch {
            data = null;
        }

        if (lastResult?.ok && isRecord(data) && Array.isArray(getCaseInsensitiveField(data, 'intermediaries'))) {
            return { ...lastResult, data };
        }

        const reason = lastResult?.status ? `status ${lastResult.status}` : lastResult?.error || 'invalid JSON';
        log.warning(`${label} failed (attempt ${attempt}/${retries}), ${reason}.`);
        if (
            lastResult?.status === 403 ||
            isChallengePage(lastResult?.body) ||
            (lastResult?.status > 0 && !isRetryableStatus(lastResult.status))
        ) {
            return { ...lastResult, data: null };
        }
        if (attempt < retries) await sleep(retryDelay(waitMs, attempt));
    }

    return { ...lastResult, data: null };
}

async function fetchApiJsonInBrowser(page, url, { retries = 4, waitMs = 1500, label }) {
    let lastResult;

    for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
            lastResult = await page.evaluate(async (targetUrl) => {
                try {
                    const response = await fetch(targetUrl, {
                        method: 'GET',
                        credentials: 'include',
                        headers: { Accept: 'application/json, text/plain, */*' },
                    });
                    return {
                        ok: response.ok,
                        status: response.status,
                        body: await response.text(),
                    };
                } catch (error) {
                    return { ok: false, status: 0, error: error.message };
                }
            }, url);
        } catch (error) {
            lastResult = { ok: false, status: 0, error: getErrorMessage(error) };
        }

        let data;
        try {
            data = JSON.parse(lastResult?.body || '');
        } catch {
            data = null;
        }

        if (lastResult?.ok && isRecord(data) && Array.isArray(getCaseInsensitiveField(data, 'intermediaries'))) {
            return { ...lastResult, data };
        }

        const reason = lastResult?.status ? `status ${lastResult.status}` : lastResult?.error || 'invalid JSON';
        log.warning(`${label} failed (attempt ${attempt}/${retries}), ${reason}.`);

        if (attempt < retries) {
            if (isRetryableStatus(lastResult?.status)) {
                await page.reload({ waitUntil: 'commit', timeout: BROWSER_NAVIGATION_TIMEOUT_MS }).catch(() => {});
                await waitForAnnuaireHtml(page);
            }
            await sleep(retryDelay(waitMs, attempt));
        }
    }

    return { ...lastResult, data: null };
}

function mapIntermediary(intermediary, context) {
    const intermediaryType = getCaseInsensitiveField(intermediary, 'intermediaryType');
    const properties = getCaseInsensitiveField(intermediary, 'properties') || {};
    const logo = getCaseInsensitiveField(intermediary, 'logo') || {};
    const rating = getCaseInsensitiveField(intermediary, 'rating') || {};

    return {
        intermediary_id: getCaseInsensitiveField(intermediary, 'intermediaryId'),
        seloger_id: getCaseInsensitiveField(intermediary, 'id'),
        id_rcu: getCaseInsensitiveField(intermediary, 'idRcu'),
        origin: getCaseInsensitiveField(intermediary, 'origin'),
        intermediary_type: intermediaryType,
        intermediary_type_label: INTERMEDIARY_TYPE_LABELS[intermediaryType],
        name: getCaseInsensitiveField(intermediary, 'name'),
        description: getCaseInsensitiveField(intermediary, 'description'),
        intermediary_url_path: getCaseInsensitiveField(intermediary, 'url'),
        profile_url: toAbsoluteSelogerUrl(getCaseInsensitiveField(intermediary, 'url')),
        logo_src: getCaseInsensitiveField(logo, 'src'),
        logo_alt: getCaseInsensitiveField(logo, 'alt'),
        rating_value: getCaseInsensitiveField(rating, 'value'),
        rating_reviews_count: getCaseInsensitiveField(rating, 'reviewsCount'),
        sell_count: getCaseInsensitiveField(properties, 'sellCount'),
        rent_count: getCaseInsensitiveField(properties, 'rentCount'),
        sold_count: getCaseInsensitiveField(properties, 'soldCount'),
        pro_selection_count: getCaseInsensitiveField(properties, 'proSelectionCount'),
        rank_on_page: context.rankOnPage,
        rank_global: context.rankGlobal,
        page_result_count: context.pageResultCount,
        page: context.pageNumber,
        count_per_page: context.countPerPage,
        total_results: context.totalResults,
        locality_url_path: context.localityUrlPath,
        locality_place_id: context.localityPlaceId,
        locality_place_type: context.localityPlaceType,
        locality_name: context.localityName,
        locality_postal_code: context.localityPostalCode,
        breadcrumb_count: context.breadcrumbCount,
        first_breadcrumb_label: context.firstBreadcrumbLabel,
        seo_blocks_count: context.seoBlocksCount,
        redirect_url: context.redirectUrl,
        geo_api_place_id: context.geoApiPlaceId,
        geo_api_place_type: context.geoApiPlaceType,
        project_type: context.projectType,
        intermediary_types: context.intermediaryTypes,
        search_url: context.searchUrl,
        scraped_at: new Date().toISOString(),
    };
}

await Actor.init();

const isCloudRun = ['1', 'true'].includes(String(process.env.APIFY_IS_AT_HOME).toLowerCase());
let input = (await Actor.getInput()) || {};
if (Object.keys(input).length === 0 && !isCloudRun) {
    try {
        input = JSON.parse(await readFile('INPUT.json', 'utf8'));
        log.info('Loaded local INPUT.json.');
    } catch {
        input = {};
    }
}

const {
    startUrl,
    start_url,
    results_wanted: resultsWantedRaw = 20,
    count_per_page: countPerPageRaw,
    proxyConfiguration: proxyConfig,
} = input;

const startUrlFromInput = startUrl || start_url;

const resultsWanted = toPositiveInteger(resultsWantedRaw, 20);
const countPerPage = toPositiveInteger(countPerPageRaw, DEFAULT_COUNT_PER_PAGE);
const targetPages = Math.max(1, Math.ceil(resultsWanted / countPerPage));

let totalSaved = 0;
let runError;
let browserSession;
let proxyConfiguration;
const seenIntermediaryIds = new Set();

try {
    if (!startUrlFromInput) throw new Error('startUrl is required.');

    const parsedUrl = parseStartUrl(startUrlFromInput);
    log.info(`Run limits: resultsWanted=${resultsWanted}, autoPages=${targetPages}, countPerPage=${countPerPage}.`);

    const proxyOptions = proxyConfig || (isCloudRun ? DEFAULT_PROXY_CONFIGURATION : undefined);
    proxyConfiguration = proxyOptions ? await Actor.createProxyConfiguration(proxyOptions) : undefined;
    browserSession = await openAnnuaireSession(parsedUrl.normalizedUrl, proxyConfiguration);
    if (!browserSession?.html) {
        log.warning('Annuaire bootstrap remained unavailable after bounded retries; no records were collected.');
    } else {
        let annuaireContext = extractAnnuaireContext(browserSession.html, parsedUrl);
        if (!annuaireContext.geoApiPlaceId || !annuaireContext.geoApiPlaceType) {
            log.warning(
                'Could not resolve geoApiPlaceId or geoApiPlaceType from annuaire page; no records were collected.',
            );
        } else {
            log.info(`Annuaire context: ${JSON.stringify(annuaireContext)}`);

            for (let pageNumber = 1; pageNumber <= targetPages && totalSaved < resultsWanted; pageNumber += 1) {
                const apiUrl = buildApiUrl({
                    geoApiPlaceId: annuaireContext.geoApiPlaceId,
                    geoApiPlaceType: annuaireContext.geoApiPlaceType,
                    pageNumber,
                    countPerPage,
                    projectType: annuaireContext.projectType,
                    intermediaryTypes: annuaireContext.intermediaryTypes,
                });

                log.info(`Fetching page ${pageNumber}`);

                let searchResult =
                    browserSession.kind === 'impit'
                        ? await fetchApiJsonWithImpit(browserSession.client, apiUrl, {
                              retries: 4,
                              waitMs: 500,
                              label: `Intermediaries page ${pageNumber}`,
                              referer: browserSession.referer,
                          })
                        : await fetchApiJsonInBrowser(browserSession.page, apiUrl, {
                              retries: 4,
                              waitMs: 1000,
                              label: `Intermediaries page ${pageNumber}`,
                          });

                if (!searchResult?.ok && browserSession.kind === 'impit') {
                    log.warning('Impit API flow was blocked; switching to the browser session for this run.');
                    browserSession = await openBrowserSession(parsedUrl.normalizedUrl, proxyConfiguration);
                    if (!browserSession?.html) {
                        log.warning(
                            `Browser API fallback was unavailable on page ${pageNumber}; stopping after saved results.`,
                        );
                        break;
                    }
                    annuaireContext = extractAnnuaireContext(browserSession.html, parsedUrl);
                    searchResult = await fetchApiJsonInBrowser(browserSession.page, apiUrl, {
                        retries: 4,
                        waitMs: 1000,
                        label: `Intermediaries page ${pageNumber}`,
                    });
                }

                if (!searchResult?.ok) {
                    log.warning(`Intermediaries API unavailable on page ${pageNumber}; stopping after saved results.`);
                    break;
                }

                const apiData = searchResult.data;
                const intermediaries = getCaseInsensitiveField(apiData, 'intermediaries');
                if (!Array.isArray(intermediaries)) {
                    log.warning(
                        `Intermediaries API response on page ${pageNumber} has no valid intermediaries array; skipping page.`,
                    );
                    continue;
                }

                const totalResults =
                    getCaseInsensitiveField(apiData, 'intermediariesCount') || annuaireContext.totalResults;
                const locality = getCaseInsensitiveField(apiData, 'locality') || {};
                const localityPlace = getCaseInsensitiveField(locality, 'place') || {};
                const breadcrumbRaw = getCaseInsensitiveField(apiData, 'breadCrumb');
                const seoBlocksRaw = getCaseInsensitiveField(apiData, 'seoBlocks');
                const breadcrumb = Array.isArray(breadcrumbRaw) ? breadcrumbRaw : [];
                const seoBlocks = Array.isArray(seoBlocksRaw) ? seoBlocksRaw : [];
                const redirectUrl = getCaseInsensitiveField(apiData, 'redirectUrl');

                if (intermediaries.length === 0) {
                    log.info(`No intermediary rows returned for page ${pageNumber}.`);
                    break;
                }

                const records = [];
                for (const [index, intermediary] of intermediaries.entries()) {
                    if (totalSaved + records.length >= resultsWanted) break;

                    const intermediaryId = getCaseInsensitiveField(intermediary, 'intermediaryId');
                    if (!intermediaryId || seenIntermediaryIds.has(intermediaryId)) continue;

                    let record;
                    try {
                        record = cleanData(
                            mapIntermediary(intermediary, {
                                pageNumber,
                                pageResultCount: intermediaries.length,
                                countPerPage,
                                rankOnPage: index + 1,
                                rankGlobal: (pageNumber - 1) * countPerPage + (index + 1),
                                totalResults,
                                localityUrlPath: getCaseInsensitiveField(locality, 'urlPath'),
                                localityPlaceId: getCaseInsensitiveField(localityPlace, 'id'),
                                localityPlaceType: getCaseInsensitiveField(localityPlace, 'type'),
                                localityName: getCaseInsensitiveField(localityPlace, 'name'),
                                localityPostalCode: getCaseInsensitiveField(localityPlace, 'postalCode'),
                                breadcrumbCount: breadcrumb.length,
                                firstBreadcrumbLabel: getCaseInsensitiveField(breadcrumb[0], 'label'),
                                seoBlocksCount: seoBlocks.length,
                                redirectUrl,
                                geoApiPlaceId: annuaireContext.geoApiPlaceId,
                                geoApiPlaceType: annuaireContext.geoApiPlaceType,
                                projectType: annuaireContext.projectType,
                                intermediaryTypes: annuaireContext.intermediaryTypes,
                                searchUrl: parsedUrl.normalizedUrl,
                            }),
                        );
                    } catch (error) {
                        log.warning(
                            `Skipping malformed intermediary on page ${pageNumber}: ${getErrorMessage(error)}.`,
                        );
                        continue;
                    }

                    if (!record || Object.keys(record).length === 0) continue;

                    seenIntermediaryIds.add(intermediaryId);
                    records.push(record);
                }

                if (records.length > 0) {
                    await Dataset.pushData(records);
                    totalSaved += records.length;
                    log.info(
                        `Saved ${records.length} intermediaries from page ${pageNumber} (${totalSaved}/${resultsWanted}).`,
                    );
                } else {
                    log.info(`No new intermediary records to save on page ${pageNumber}.`);
                }

                if (intermediaries.length < countPerPage) break;
            }
        }
    }

    if (totalSaved === 0)
        log.warning('No intermediary records were extracted. Check startUrl filters or retry with proxy.');
} catch (error) {
    runError = error;
    log.error(`Run failed: ${error.stack || error.message}`);
} finally {
    if (browserSession?.browser) await browserSession.browser.close().catch(() => {});
    log.info(`Finished. Saved ${totalSaved} intermediaries.`);
    if (runError) {
        await Actor.fail(runError.message);
    } else {
        await Actor.exit();
    }
}

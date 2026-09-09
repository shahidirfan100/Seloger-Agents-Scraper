import { readFile } from 'node:fs/promises';

import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';
import { Dataset } from 'crawlee';
import { chromium } from 'patchright';

const DEFAULT_COUNT_PER_PAGE = 100;
const API_BASE = 'https://www.seloger.com/slr_idb/api/v4/intermediaries';
const DEFAULT_PROXY_CONFIGURATION = {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
};

const MAX_BROWSER_SESSIONS = 3;

const BROWSER_NAVIGATION_TIMEOUT_MS = 15_000;
const BOOTSTRAP_WAIT_MS = 10_000;
const PROXY_URL_TIMEOUT_MS = 5_000;


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
    const getUrlValues = (name) => [
        ...getHashParameterValues(parsed.searchParams, name),
        ...getHashParameterValues(hashParams, name),
    ];

    return {
        normalizedUrl: parsed.href,
        geoApiPlaceId: getUrlValues('geoApiPlaceId')[0],
        geoApiPlaceType: getUrlValues('geoApiPlaceType')[0],
        projectType: getUrlValues('projectType')[0] || '1',
        intermediaryTypes: normalizeIntermediaryTypes(getUrlValues('intermediaryTypes'), [1, 2, 3, 5]),
    };
}

function normalizeProjectType(value, fallback) {
    const normalizedValue = String(value ?? '').trim();
    return ['1', '2'].includes(normalizedValue) ? normalizedValue : fallback;
}

function normalizeFilters(filters, parsedUrl) {
    const source = isRecord(filters) ? filters : {};
    const intermediaryTypes = normalizeIntermediaryTypes(
        source.intermediaryTypes ?? source.intermediary_types,
        parsedUrl.intermediaryTypes,
    );

    return {
        projectType: normalizeProjectType(source.projectType ?? source.project_type, parsedUrl.projectType),
        intermediaryTypes,
    };
}

function normalizeLocation(location) {
    if (typeof location === 'string') {
        const value = location.trim();
        if (!value) return {};

        if (/^https?:\/\//i.test(value)) {
            const url = toAbsoluteSelogerUrl(value);
            const parsedUrl = new URL(url);
            return { localityUrlPath: parsedUrl.pathname };
        }

        const slug = value.replace(/^\/?(?:annuaire\/)?/, '').replace(/\/$/, '');
        return { localityUrlPath: `/annuaire/${slug}/` };
    }

    if (!isRecord(location)) return {};

    const geoApiPlaceId = getCaseInsensitiveField(location, 'geoApiPlaceId', 'geo_api_place_id', 'placeId', 'id');
    const geoApiPlaceType = getCaseInsensitiveField(
        location,
        'geoApiPlaceType',
        'geo_api_place_type',
        'placeType',
        'type',
    );

    return {
        geoApiPlaceId: geoApiPlaceId ? String(geoApiPlaceId) : undefined,
        geoApiPlaceType: geoApiPlaceType ? String(geoApiPlaceType) : undefined,
        localityUrlPath: getCaseInsensitiveField(location, 'urlPath', 'url_path'),
        localityPlaceId: getCaseInsensitiveField(location, 'placeId', 'place_id'),
        localityPlaceType: getCaseInsensitiveField(location, 'placeType', 'place_type'),
        localityName: getCaseInsensitiveField(location, 'name', 'localityName', 'locality_name'),
        localityPostalCode: getCaseInsensitiveField(location, 'postalCode', 'postal_code'),
    };
}

function createExplicitAnnuaireContext(parsedUrl, location, filters) {
    const normalizedLocation = normalizeLocation(location);
    const geoApiPlaceId = normalizedLocation.geoApiPlaceId || parsedUrl.geoApiPlaceId;
    const geoApiPlaceType = normalizedLocation.geoApiPlaceType || parsedUrl.geoApiPlaceType;

    if (!geoApiPlaceId || !geoApiPlaceType) return undefined;

    return {
        ...normalizedLocation,
        geoApiPlaceId,
        geoApiPlaceType,
        projectType: filters.projectType,
        intermediaryTypes: filters.intermediaryTypes,
        totalResults: undefined,
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

function buildApiUrl(params, { bracketArrayKeys = false } = {}) {
    const query = new URLSearchParams();
    query.set('geoApiPlaceId', params.geoApiPlaceId);
    query.set('geoApiPlaceType', params.geoApiPlaceType);
    query.set('countPerPage', String(params.countPerPage));
    query.set('page', String(params.pageNumber));
    query.set('projectType', String(params.projectType));
    for (const type of params.intermediaryTypes) {
        query.append(bracketArrayKeys ? 'intermediaryTypes[]' : 'intermediaryTypes', String(type));
    }
    return `${API_BASE}?${query.toString()}`;
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


function retryDelay(waitMs, attempt) {
    return Math.min(waitMs * 2 ** (attempt - 1), 8_000);
}

function getErrorMessage(error) {
    return String(error?.message || error || 'unknown error')
        .split(/\r?\n/, 1)[0]
        .slice(0, 240);
}


function toBrowserProxy(proxyUrl) {
    const parsed = new URL(proxyUrl);
    const proxy = {
        server: `${parsed.protocol}//${parsed.host}`,
    };

    if (parsed.username || parsed.password) {
        proxy.username = decodeURIComponent(parsed.username);
        proxy.password = decodeURIComponent(parsed.password);
    }

    return proxy;
}

async function closeBrowserSession(session) {
    if (session?.page) await session.page.close().catch(() => {});
    if (session?.context) await session.context.close().catch(() => {});
    if (session?.browser) await session.browser.close().catch(() => {});
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


async function createBrowserSession(proxyUrl) {
    const browserOptions = {
        channel: 'chrome',
        headless: false,
        noViewport: true,
        ...(proxyUrl && { proxy: toBrowserProxy(proxyUrl) }),
    };

    try {
        const context = await chromium.launchPersistentContext('./storage/seloger-browser-profile', browserOptions);
        const page = await context.newPage();
        return { context, page };
    } catch (error) {
        log.warning(`Persistent Chrome launch failed; using Patchright headless fallback: ${getErrorMessage(error)}.`);
        const browser = await chromium.launch({
            headless: true,
            ...(proxyUrl && { proxy: toBrowserProxy(proxyUrl) }),
        });
        const context = await browser.newContext();
        const page = await context.newPage();
        return { browser, context, page };
    }
}

async function openBrowserSession(startUrl, proxyConfiguration) {
    let lastStatus;
    let lastReason = 'unknown error';

    for (let attempt = 1; attempt <= MAX_BROWSER_SESSIONS; attempt += 1) {
        let session;
        try {
            const useDirectConnection = Boolean(proxyConfiguration) && attempt === MAX_BROWSER_SESSIONS;
            const proxyUrl = useDirectConnection ? undefined : await getProxyUrl(proxyConfiguration);
            if (useDirectConnection) log.info('Trying direct browser connection after proxy attempts failed.');
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
                return { ...session, kind: 'browser', html };
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

        if (session) await closeBrowserSession(session);
        if (attempt < MAX_BROWSER_SESSIONS) await sleep(1500 * attempt);
    }

    log.warning(`Could not load annuaire page (status ${lastStatus || 'unknown'}; ${lastReason}).`);
    return { kind: 'unavailable', lastStatus, lastReason };
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
            if (lastResult?.status === 403 || isChallengePage(lastResult?.body)) {
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
    location: locationInput,
    filters: filtersInput,
    proxyConfiguration: proxyConfig,
} = input;

const inputLocation = normalizeLocation(locationInput);
const locationUrl = inputLocation.localityUrlPath
    ? toAbsoluteSelogerUrl(inputLocation.localityUrlPath)
    : undefined;
const startUrlFromInput =
    startUrl ||
    start_url ||
    (inputLocation.localityUrlPath || (inputLocation.geoApiPlaceId && inputLocation.geoApiPlaceType)
        ? locationUrl || 'https://www.seloger.com/annuaire/'
        : undefined);

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
    const filters = normalizeFilters(filtersInput, parsedUrl);
    const parsedSearchUrl = { ...parsedUrl, ...filters };
    const explicitAnnuaireContext = createExplicitAnnuaireContext(parsedUrl, locationInput, filters);
    log.info(`Run limits: resultsWanted=${resultsWanted}, autoPages=${targetPages}, countPerPage=${countPerPage}.`);
    log.info(`Search filters: ${JSON.stringify(filters)}.`);

    const proxyOptions = proxyConfig || (isCloudRun ? DEFAULT_PROXY_CONFIGURATION : undefined);
    proxyConfiguration = proxyOptions ? await Actor.createProxyConfiguration(proxyOptions) : undefined;
    browserSession = await openBrowserSession(parsedUrl.normalizedUrl, proxyConfiguration);
    if (!browserSession?.html) {
        log.warning('Annuaire bootstrap remained unavailable after bounded retries; no records were collected.');
    } else {
        const annuaireContext = explicitAnnuaireContext || extractAnnuaireContext(browserSession.html, parsedSearchUrl);
        if (!annuaireContext.geoApiPlaceId || !annuaireContext.geoApiPlaceType) {
            log.warning(
                'Could not resolve geoApiPlaceId or geoApiPlaceType from annuaire page; no records were collected.',
            );
        } else {
            log.info(`Annuaire context: ${JSON.stringify(annuaireContext)}`);

            for (let pageNumber = 1; pageNumber <= targetPages && totalSaved < resultsWanted; pageNumber += 1) {
                const apiParams = {
                    geoApiPlaceId: annuaireContext.geoApiPlaceId,
                    geoApiPlaceType: annuaireContext.geoApiPlaceType,
                    pageNumber,
                    countPerPage,
                    projectType: annuaireContext.projectType,
                    intermediaryTypes: annuaireContext.intermediaryTypes,
                };
                let apiUrl = buildApiUrl(apiParams);
                const bracketedApiUrl = buildApiUrl(apiParams, { bracketArrayKeys: true });

                log.info(`Fetching page ${pageNumber}`);

                let searchResult = await fetchApiJsonInBrowser(browserSession.page, apiUrl, {
                    retries: 4,
                    waitMs: 1000,
                    label: `Intermediaries page ${pageNumber}`,
                });

                if (!searchResult?.data && bracketedApiUrl !== apiUrl) {
                    log.warning('Retrying the intermediary API with bracketed filter parameters.');
                    apiUrl = bracketedApiUrl;
                    searchResult = await fetchApiJsonInBrowser(browserSession.page, apiUrl, {
                        retries: 1,
                        waitMs: 1000,
                        label: `Intermediaries bracketed page ${pageNumber}`,
                    });
                }

                if (!searchResult?.data) {
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
    await closeBrowserSession(browserSession);
    log.info(`Finished. Saved ${totalSaved} intermediaries.`);
    if (runError) {
        await Actor.fail(runError.message);
    } else {
        await Actor.exit();
    }
}

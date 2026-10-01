import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { chromium } from 'patchright';

const DEFAULT_COUNT_PER_PAGE = 100;
const API_BASE = 'https://www.seloger.com/slr_idb/api/v4/intermediaries';
const DEFAULT_PROXY_CONFIGURATION = {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
};

const MAX_BROWSER_SESSIONS = 3;
const BROWSER_NAVIGATION_TIMEOUT_MS = 45_000;
const SESSION_READY_TIMEOUT_MS = 45_000;
const API_REQUEST_TIMEOUT_MS = 30_000;
const MAX_API_ATTEMPTS = 5;
const MAX_RETRY_DELAY_MS = 30_000;

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

function normalizeUrlPath(urlPath, fallback) {
    if (!urlPath || typeof urlPath !== 'string') return fallback;
    const trimmed = urlPath.trim();
    if (!trimmed) return fallback;

    let path = trimmed;
    if (/^https?:\/\//i.test(path)) {
        try {
            path = new URL(path).pathname;
        } catch {
            return fallback;
        }
    }

    if (!path.startsWith('/')) path = `/${path}`;
    return path.endsWith('/') ? path : `${path}/`;
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
        urlPath: normalizeUrlPath(parsed.pathname, '/annuaire/'),
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
            try {
                const url = new URL(toAbsoluteSelogerUrl(value));
                return { localityUrlPath: normalizeUrlPath(url.pathname, undefined) };
            } catch {
                return {};
            }
        }

        const slug = value.replace(/^\/?(?:annuaire\/)?/, '').replace(/\/$/, '');
        return { localityUrlPath: normalizeUrlPath(`/annuaire/${slug}/`, undefined) };
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
        localityUrlPath: normalizeUrlPath(
            getCaseInsensitiveField(location, 'urlPath', 'url_path', 'localityUrlPath'),
            undefined,
        ),
    };
}

function buildApiUrl(params) {
    const query = new URLSearchParams();
    query.set('urlPath', params.urlPath);
    if (params.geoApiPlaceId) query.set('geoApiPlaceId', String(params.geoApiPlaceId));
    if (params.geoApiPlaceType) query.set('geoApiPlaceType', String(params.geoApiPlaceType));
    query.set('countPerPage', String(params.countPerPage));
    query.set('page', String(params.pageNumber));
    if (params.projectType) query.set('projectType', String(params.projectType));
    for (const type of params.intermediaryTypes) {
        query.append('intermediaryTypes', String(type));
    }
    return `${API_BASE}?${query.toString()}`;
}

function isChallengeText(value) {
    return /captcha-delivery\.com|please enable js and disable any ad blocker|x-datadome|datadome/i.test(
        String(value || ''),
    );
}

function classifyApiResult(result) {
    if (!result || result.status === 0 || result.error) {
        return { ok: false, retryable: true, reason: result?.error || 'network error' };
    }

    if (isChallengeText(result.snippet)) {
        return { ok: false, retryable: true, challenge: true, reason: 'DataDome challenge' };
    }

    if (result.status === 403 || result.status === 429 || result.status === 407 || result.status === 594) {
        return { ok: false, retryable: true, reason: `HTTP ${result.status}` };
    }

    if (result.status >= 500) {
        return { ok: false, retryable: true, reason: `HTTP ${result.status}` };
    }

    if (result.status !== 200) {
        return { ok: false, retryable: false, reason: `HTTP ${result.status}` };
    }

    const { data } = result;
    if (!isRecord(data)) {
        return { ok: false, retryable: false, reason: 'unexpected response shape' };
    }

    const intermediaries = getCaseInsensitiveField(data, 'intermediaries');
    if (!Array.isArray(intermediaries)) {
        return { ok: false, retryable: false, reason: 'missing intermediaries array' };
    }

    return { ok: true, reason: 'ok' };
}

function retryDelay(waitMs, attempt, retryAfter) {
    const retryAfterValue = String(retryAfter || '').trim();
    const retryAfterSeconds = Number(retryAfterValue);
    if (retryAfterValue && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
        return Math.min(retryAfterSeconds * 1000, MAX_RETRY_DELAY_MS);
    }

    const retryAt = retryAfterValue ? Date.parse(retryAfterValue) : Number.NaN;
    if (Number.isFinite(retryAt)) {
        return Math.min(Math.max(0, retryAt - Date.now()), MAX_RETRY_DELAY_MS);
    }

    const exponentialDelay = Math.min(waitMs * 2 ** (attempt - 1), 8_000);
    const jitter = Math.floor(Math.random() * Math.min(500, exponentialDelay * 0.2 + 1));
    return exponentialDelay + jitter;
}

function getErrorMessage(error) {
    return String(error?.message || error || 'unknown error')
        .split(/\r?\n/, 1)[0]
        .slice(0, 240)
        .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
        .replace(/\b((?:proxy-)?authorization|cookie|(?:x-)?api[-_]?key|token)\s*[:=]\s*[^,\s;]+/gi, '$1=[redacted]');
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
    if (session?.userDataDir) await rm(session.userDataDir, { recursive: true, force: true }).catch(() => {});
}

async function getProxyUrl(proxyConfiguration, sessionId) {
    if (!proxyConfiguration) return undefined;

    try {
        const proxyUrl = await proxyConfiguration.newUrl(sessionId);
        if (!proxyUrl) throw new Error('Proxy configuration returned an empty URL');
        return proxyUrl;
    } catch (error) {
        throw new Error(`Could not create the configured proxy session: ${getErrorMessage(error)}`);
    }
}

async function hasSelogerSessionCookie(context) {
    const cookies = await context.cookies().catch(() => []);
    return cookies.some((cookie) => cookie.name.toLowerCase() === 'datadome' && cookie.value);
}

async function waitForSelogerSession(context, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (await hasSelogerSessionCookie(context)) return true;
        await sleep(500);
    }
    return hasSelogerSessionCookie(context);
}

async function navigateToAnnuaire(page, startUrl) {
    try {
        const response = await page.goto(startUrl, {
            waitUntil: 'domcontentloaded',
            timeout: BROWSER_NAVIGATION_TIMEOUT_MS,
        });
        return response?.status();
    } catch (error) {
        log.warning(`Annuaire navigation did not finish immediately: ${getErrorMessage(error)}.`);
        return undefined;
    }
}

async function createBrowserSession(proxyUrl) {
    const userDataDir = await mkdtemp(join(tmpdir(), 'seloger-profile-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
        channel: 'chrome',
        headless: false,
        viewport: null,
        locale: 'fr-FR',
        timezoneId: 'Europe/Paris',
        ...(proxyUrl && { proxy: toBrowserProxy(proxyUrl) }),
    });
    const page = await context.newPage();
    return { context, page, userDataDir };
}

async function openBrowserSession(startUrl, proxyConfiguration) {
    let lastReason = 'unknown error';

    for (let attempt = 1; attempt <= MAX_BROWSER_SESSIONS; attempt += 1) {
        let session;
        try {
            const proxyUrl = await getProxyUrl(proxyConfiguration, `seloger_bootstrap_${attempt}`);
            session = await createBrowserSession(proxyUrl);

            const status = await navigateToAnnuaire(session.page, startUrl);
            const sessionReady = await waitForSelogerSession(session.context, SESSION_READY_TIMEOUT_MS);

            if (sessionReady) {
                log.info(`Annuaire session established (attempt ${attempt}/${MAX_BROWSER_SESSIONS}).`);
                return { ...session, kind: 'browser' };
            }

            lastReason = `session cookie not issued (HTTP ${status || 'unknown'})`;
            log.warning(`Annuaire bootstrap failed (attempt ${attempt}/${MAX_BROWSER_SESSIONS}): ${lastReason}.`);
        } catch (error) {
            lastReason = getErrorMessage(error);
            log.warning(
                `Annuaire browser bootstrap error (attempt ${attempt}/${MAX_BROWSER_SESSIONS}): ${lastReason}.`,
            );
        }

        if (session) await closeBrowserSession(session);
        if (attempt < MAX_BROWSER_SESSIONS) await sleep(retryDelay(1000, attempt));
    }

    log.warning(`Could not establish a SeLoger session (${lastReason}).`);
    return { kind: 'unavailable', lastReason };
}

async function evaluateApiFetch(page, url, timeoutMs) {
    return page.evaluate(
        async ({ targetUrl, requestTimeoutMs }) => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);

            try {
                const response = await fetch(targetUrl, {
                    method: 'GET',
                    credentials: 'include',
                    headers: { Accept: 'application/json', 'x-business-unit': '1' },
                    signal: controller.signal,
                });

                const text = await response.text();
                let data = null;
                try {
                    data = JSON.parse(text);
                } catch {
                    data = null;
                }

                return {
                    status: response.status,
                    contentType: response.headers.get('content-type') || '',
                    retryAfter: response.headers.get('retry-after'),
                    data,
                    snippet: text.slice(0, 240),
                };
            } catch (error) {
                return { status: 0, error: String(error?.message || error).split(/\r?\n/, 1)[0] };
            } finally {
                clearTimeout(timeoutId);
            }
        },
        { targetUrl: url, requestTimeoutMs: timeoutMs },
    );
}

async function fetchApiPage(page, apiUrl, { attempts, waitMs, label, refreshSession }) {
    let last = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            last = await evaluateApiFetch(page, apiUrl, API_REQUEST_TIMEOUT_MS);
        } catch (error) {
            last = { status: 0, error: getErrorMessage(error) };
        }

        const classification = classifyApiResult(last);
        if (classification.ok) return { ok: true, status: last.status, data: last.data };

        if (!classification.retryable || attempt === attempts) {
            log.warning(`${label} stopped after attempt ${attempt}/${attempts}: ${classification.reason}.`);
            return { ok: false, status: last?.status, failureReason: classification.reason };
        }

        log.warning(`${label} temporary failure (attempt ${attempt}/${attempts}): ${classification.reason}; retrying.`);
        if (classification.challenge && refreshSession) await refreshSession();
        await sleep(retryDelay(waitMs, attempt, last?.retryAfter));
    }

    return { ok: false, status: last?.status, failureReason: last?.error || 'network error' };
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
const startUrlFromInput =
    startUrl ||
    start_url ||
    (inputLocation.localityUrlPath ? toAbsoluteSelogerUrl(inputLocation.localityUrlPath) : undefined);

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
    const urlPath = inputLocation.localityUrlPath || parsedUrl.urlPath;
    log.info(`Run limits: resultsWanted=${resultsWanted}, autoPages=${targetPages}, countPerPage=${countPerPage}.`);
    log.info(`Search filters: ${JSON.stringify(filters)} (urlPath=${urlPath}).`);

    const proxyOptions = proxyConfig || (isCloudRun ? DEFAULT_PROXY_CONFIGURATION : undefined);
    proxyConfiguration = proxyOptions ? await Actor.createProxyConfiguration(proxyOptions) : undefined;

    browserSession = await openBrowserSession(parsedUrl.normalizedUrl, proxyConfiguration);
    if (browserSession.kind !== 'browser') {
        throw new Error(
            `SeLoger session could not be established (${browserSession.lastReason || 'access denied'}). ` +
                'DataDome denied the automated session; retry later or use an authorized SeLoger/AVIV integration.',
        );
    }

    const refreshSession = async () => {
        log.warning('Refreshing SeLoger session after a DataDome challenge.');
        await navigateToAnnuaire(browserSession.page, parsedUrl.normalizedUrl);
        await waitForSelogerSession(browserSession.context, SESSION_READY_TIMEOUT_MS);
    };

    const annuaireContext = {
        geoApiPlaceId: inputLocation.geoApiPlaceId || parsedUrl.geoApiPlaceId,
        geoApiPlaceType: inputLocation.geoApiPlaceType || parsedUrl.geoApiPlaceType,
        projectType: filters.projectType,
        intermediaryTypes: filters.intermediaryTypes,
        totalResults: undefined,
    };

    for (let pageNumber = 1; pageNumber <= targetPages && totalSaved < resultsWanted; pageNumber += 1) {
        const apiParams = {
            urlPath,
            geoApiPlaceId: annuaireContext.geoApiPlaceId,
            geoApiPlaceType: annuaireContext.geoApiPlaceType,
            pageNumber,
            countPerPage,
            projectType: annuaireContext.projectType,
            intermediaryTypes: annuaireContext.intermediaryTypes,
        };
        const apiUrl = buildApiUrl(apiParams);

        log.info(`Fetching page ${pageNumber}`);

        const searchResult = await fetchApiPage(browserSession.page, apiUrl, {
            attempts: MAX_API_ATTEMPTS,
            waitMs: 2000,
            label: `Intermediaries page ${pageNumber}`,
            refreshSession,
        });

        if (!searchResult.ok) {
            if (totalSaved === 0) {
                throw new Error(
                    `SeLoger intermediary search failed on page ${pageNumber}: ${searchResult.failureReason || 'no valid response'}.`,
                );
            }
            log.warning(
                `SeLoger intermediary search stopped on page ${pageNumber}: ${searchResult.failureReason || 'no valid response'}; keeping ${totalSaved} saved records.`,
            );
            break;
        }

        const apiData = searchResult.data;
        const intermediaries = getCaseInsensitiveField(apiData, 'intermediaries');
        if (!Array.isArray(intermediaries)) {
            throw new Error(`SeLoger page ${pageNumber} response has no valid intermediaries array.`);
        }

        const totalResults = getCaseInsensitiveField(apiData, 'intermediariesCount') || annuaireContext.totalResults;
        const locality = getCaseInsensitiveField(apiData, 'locality') || {};
        const localityPlace = getCaseInsensitiveField(locality, 'place') || {};
        const breadcrumbRaw = getCaseInsensitiveField(apiData, 'breadCrumb');
        const seoBlocksRaw = getCaseInsensitiveField(apiData, 'seoBlocks');
        const breadcrumb = Array.isArray(breadcrumbRaw) ? breadcrumbRaw : [];
        const seoBlocks = Array.isArray(seoBlocksRaw) ? seoBlocksRaw : [];
        const redirectUrl = getCaseInsensitiveField(apiData, 'redirectUrl');

        const resolvedPlaceId = getCaseInsensitiveField(localityPlace, 'id');
        const resolvedPlaceType = getCaseInsensitiveField(localityPlace, 'type');
        if (resolvedPlaceId) annuaireContext.geoApiPlaceId = String(resolvedPlaceId);
        if (resolvedPlaceType) annuaireContext.geoApiPlaceType = String(resolvedPlaceType);

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
                        countPerPage: apiParams.countPerPage,
                        rankOnPage: index + 1,
                        rankGlobal: (pageNumber - 1) * countPerPage + (index + 1),
                        totalResults,
                        localityUrlPath: getCaseInsensitiveField(locality, 'urlPath'),
                        localityPlaceId: resolvedPlaceId,
                        localityPlaceType: resolvedPlaceType,
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
                log.warning(`Skipping malformed intermediary on page ${pageNumber}: ${getErrorMessage(error)}.`);
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

        if (intermediaries.length < apiParams.countPerPage) break;
    }

    if (totalSaved === 0) log.info('No intermediaries matched the requested filters.');
} catch (error) {
    runError = error;
    log.error(`Run failed: ${getErrorMessage(error)}.`);
} finally {
    await closeBrowserSession(browserSession);
    if (!runError) {
        log.info(`Finished. Saved ${totalSaved} intermediaries.`);
    } else if (totalSaved > 0) {
        log.info(`Stopped after failure. Saved ${totalSaved} intermediaries before the error.`);
    }
    if (runError) {
        await Actor.fail(getErrorMessage(runError));
    } else {
        await Actor.exit();
    }
}

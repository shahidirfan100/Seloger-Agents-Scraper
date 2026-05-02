import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { chromium } from 'playwright';

const DEFAULT_START_URL =
    'https://www.seloger.com/annuaire/paris-75000/#intermediaryTypes=1&intermediaryTypes=2&intermediaryTypes=3&intermediaryTypes=5&projectType=1';
const DEFAULT_COUNT_PER_PAGE = 8;

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
];

const INTERMEDIARY_TYPE_LABELS = {
    1: 'Real estate agency',
    2: 'Independent consultant',
    3: 'Developer',
    5: 'Property administrator',
};

const RECOVERABLE_NETWORK_ERROR_PATTERNS = [
    'ERR_TUNNEL_CONNECTION_FAILED',
    'ERR_PROXY_CONNECTION_FAILED',
    'ERR_PROXY_CERTIFICATE_INVALID',
    'ERR_CONNECTION_CLOSED',
    'ERR_CONNECTION_RESET',
    'ERR_CONNECTION_TIMED_OUT',
    'ERR_TIMED_OUT',
    'ERR_NETWORK_CHANGED',
    'ERR_NAME_NOT_RESOLVED',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'EHOSTUNREACH',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toPositiveInteger(value, fallback) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toAbsoluteSelogerUrl(url) {
    if (!url || typeof url !== 'string') return undefined;
    try {
        return new URL(url, 'https://www.seloger.com').href;
    } catch {
        return undefined;
    }
}

function normalizeIntermediaryTypes(value, fallback) {
    const source = Array.isArray(value) ? value : value ? [value] : [];
    const parsed = source
        .flatMap((item) => String(item).split(','))
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => Number.parseInt(item, 10))
        .filter((item) => Number.isInteger(item) && item > 0);

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

function isChallengePreview(text) {
    if (!text) return false;
    return /Please enable JS and disable any ad blocker|captcha-delivery|var dd=\{/i.test(text);
}

function isRecoverableNetworkError(error) {
    if (!error) return false;
    const message = String(error?.message || error);
    return RECOVERABLE_NETWORK_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

function parseProxyForPlaywright(proxyUrl) {
    if (!proxyUrl) return undefined;
    try {
        const parsed = new URL(proxyUrl);
        return {
            server: `${parsed.protocol}//${parsed.host}`,
            username: decodeURIComponent(parsed.username || ''),
            password: decodeURIComponent(parsed.password || ''),
        };
    } catch {
        return undefined;
    }
}

function parseStartUrl(url) {
    const parsed = new URL(url);
    const hashParams = new URLSearchParams(parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash);

    return {
        normalizedUrl: parsed.href,
        projectType: hashParams.get('projectType') || '1',
        intermediaryTypes: normalizeIntermediaryTypes(hashParams.getAll('intermediaryTypes'), [1, 2, 3, 5]),
    };
}

function mapIntermediary(intermediary, context) {
    const intermediaryType = intermediary?.intermediaryType;
    const properties = intermediary?.properties || {};

    return {
        intermediary_id: intermediary?.intermediaryId,
        seloger_id: intermediary?.id,
        id_rcu: intermediary?.idRcu,
        origin: intermediary?.origin,
        intermediary_type: intermediaryType,
        intermediary_type_label: INTERMEDIARY_TYPE_LABELS[intermediaryType],
        name: intermediary?.name,
        description: intermediary?.description,
        intermediary_url_path: intermediary?.url,
        profile_url: toAbsoluteSelogerUrl(intermediary?.url),
        logo_src: intermediary?.logo?.src,
        logo_alt: intermediary?.logo?.alt,
        rating_value: intermediary?.rating?.value,
        rating_reviews_count: intermediary?.rating?.reviewsCount,
        sell_count: properties?.sellCount,
        rent_count: properties?.rentCount,
        sold_count: properties?.soldCount,
        pro_selection_count: properties?.proSelectionCount,
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

async function dismissCookieBanner(page) {
    try {
        await page.evaluate(() => {
            const actions = Array.from(document.querySelectorAll('a,button'));
            const reject = actions.find((node) => /Continuer sans accepter/i.test(node.textContent || ''));
            if (reject) {
                reject.click();
                return;
            }
            const ok = actions.find((node) => /^OK$/i.test((node.textContent || '').trim()));
            if (ok) ok.click();
        });
    } catch {
        // Optional banner.
    }
}

async function isChallengePage(page) {
    return page.evaluate(() => {
        const bodyText = document.body?.innerText || '';
        const htmlStart = document.documentElement?.outerHTML?.slice(0, 6000) || '';
        return /Please enable JS and disable any ad blocker/i.test(bodyText) || /captcha-delivery|var dd=\{/i.test(htmlStart);
    });
}

async function warmUpSession(page, targetUrl) {
    try {
        await page.goto('https://www.seloger.com/', { waitUntil: 'domcontentloaded', timeout: 90_000 });
        await sleep(1_000);
    } catch {
        // Continue with target URL.
    }

    let lastRecoverableError;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
        try {
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
        } catch (error) {
            if (isRecoverableNetworkError(error)) {
                lastRecoverableError = error;
                log.warning(`Warmup navigation network issue (attempt ${attempt}/4): ${error.message}`);
                await sleep(1_500 * attempt);
                continue;
            }
            throw error;
        }

        await sleep(1_000);
        await dismissCookieBanner(page);
        await sleep(500);

        if (!(await isChallengePage(page))) return { ready: true };

        log.warning(`Challenge page detected during warmup (attempt ${attempt}/4).`);
        await sleep(1_500 * attempt);
    }

    if (lastRecoverableError) {
        return { ready: false, recoverableError: true, lastError: lastRecoverableError };
    }

    return { ready: false, blockedByChallenge: true };
}

async function readAnnuaireContext(page, fallback) {
    return page.evaluate((defaults) => {
        const nextDataText = document.querySelector('#__NEXT_DATA__')?.textContent || '{}';
        let nextData = {};
        try {
            nextData = JSON.parse(nextDataText);
        } catch {
            nextData = {};
        }

        const initialState = nextData?.props?.pageProps?.initialState || {};
        const search = initialState?.search || {};
        const locality = search?.locality || search?.maPlace || {};

        const hashParams = new URLSearchParams(window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash);
        const intermediaryTypesFromHash = hashParams
            .getAll('intermediaryTypes')
            .map((value) => Number.parseInt(value, 10))
            .filter((value) => Number.isInteger(value) && value > 0);

        const projectTypeFromHash = hashParams.get('projectType');

        const searchText = JSON.stringify(nextData);
        const placeIdMatch = searchText.match(/\"geoApiPlaceId\"\s*:\s*(\d+)/i);
        const placeTypeMatch = searchText.match(/\"geoApiPlaceType\"\s*:\s*\"([^\"]+)\"/i);

        const geoApiPlaceId =
            placeIdMatch?.[1] ||
            locality?.geoApiPlaceId ||
            locality?.placeId ||
            locality?.id ||
            defaults.geoApiPlaceId;

        const geoApiPlaceType =
            placeTypeMatch?.[1] || locality?.geoApiPlaceType || locality?.placeType || defaults.geoApiPlaceType;

        const intermediaryTypes = intermediaryTypesFromHash.length > 0 ? intermediaryTypesFromHash : defaults.intermediaryTypes;

        return {
            geoApiPlaceId: geoApiPlaceId ? String(geoApiPlaceId) : undefined,
            geoApiPlaceType: geoApiPlaceType || defaults.geoApiPlaceType,
            projectType: projectTypeFromHash || String(search?.projectType || defaults.projectType),
            intermediaryTypes,
            totalResults: search?.results?.intermediariesCount,
        };
    }, fallback);
}

async function fetchIntermediariesPage(page, params) {
    return page.evaluate(async (requestParams) => {
        const query = new URLSearchParams();
        query.set('geoApiPlaceId', requestParams.geoApiPlaceId);
        query.set('geoApiPlaceType', requestParams.geoApiPlaceType);
        query.set('countPerPage', String(requestParams.countPerPage));
        query.set('page', String(requestParams.pageNumber));
        query.set('projectType', String(requestParams.projectType));
        for (const type of requestParams.intermediaryTypes) {
            query.append('intermediaryTypes', String(type));
        }

        const response = await fetch(`/slr_idb/api/v4/intermediaries?${query.toString()}`, {
            method: 'GET',
            credentials: 'include',
        });

        const text = await response.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch {
            data = null;
        }

        return {
            status: response.status,
            data,
            bodyPreview: text.slice(0, 400),
        };
    }, params);
}

async function fetchWithRetries(fn, { retries = 3, waitMs = 2000, label, onRetry }) {
    let lastResult;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
        lastResult = await fn();
        if (lastResult?.status === 200 && lastResult?.data) return lastResult;

        log.warning(`${label} failed (attempt ${attempt}/${retries}), status ${lastResult?.status}.`);
        if (attempt < retries) {
            if (onRetry) await onRetry(lastResult, attempt);
            await sleep(waitMs);
        }
    }

    return lastResult;
}

async function buildProxyCandidates(proxyConfig) {
    const candidates = [];

    if (proxyConfig) {
        try {
            const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig);
            if (proxyConfiguration && typeof proxyConfiguration.newUrl === 'function') {
                const candidateLimit = Actor.isAtHome() ? 4 : 1;
                for (let i = 0; i < candidateLimit; i += 1) {
                    const proxyUrl = await proxyConfiguration.newUrl();
                    const proxy = parseProxyForPlaywright(proxyUrl);
                    candidates.push({ label: proxy ? `input-proxy-${i + 1}` : 'input-no-proxy', proxy });
                }
            } else {
                candidates.push({ label: 'input-no-proxy', proxy: undefined });
            }
        } catch (error) {
            log.warning(`Could not initialize input proxy configuration: ${error.message}`);
            candidates.push({ label: 'input-no-proxy', proxy: undefined });
        }

        candidates.push({ label: 'direct-no-proxy-fallback', proxy: undefined });

        if (Actor.isAtHome()) {
            try {
                const fallbackProxyConfiguration = await Actor.createProxyConfiguration({
                    useApifyProxy: true,
                    apifyProxyGroups: ['RESIDENTIAL'],
                    countryCode: 'FR',
                });
                const fallbackProxyUrl = await fallbackProxyConfiguration.newUrl();
                const fallbackProxy = parseProxyForPlaywright(fallbackProxyUrl);
                if (fallbackProxy) {
                    candidates.push({ label: 'apify-proxy-fr-fallback', proxy: fallbackProxy });
                }
            } catch (error) {
                log.warning(`Could not initialize FR proxy fallback: ${error.message}`);
            }
        }
    } else {
        candidates.push({ label: 'direct-no-proxy', proxy: undefined });
        if (Actor.isAtHome()) {
            try {
                const fallbackProxyConfiguration = await Actor.createProxyConfiguration({
                    useApifyProxy: true,
                    apifyProxyGroups: ['RESIDENTIAL'],
                });
                const fallbackProxyUrl = await fallbackProxyConfiguration.newUrl();
                const fallbackProxy = parseProxyForPlaywright(fallbackProxyUrl);
                if (fallbackProxy) {
                    candidates.push({ label: 'apify-proxy-fallback', proxy: fallbackProxy });
                }
            } catch (error) {
                log.warning(`Could not initialize Apify proxy fallback: ${error.message}`);
            }
        }
    }

    const seen = new Set();
    return candidates.filter((candidate) => {
        const key = JSON.stringify(candidate.proxy || {});
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    startUrl,
    start_url,
    results_wanted: resultsWantedRaw = 20,
    proxyConfiguration: proxyConfig,
} = input;

const startUrlFromInput = startUrl || start_url || DEFAULT_START_URL;
const parsedUrl = parseStartUrl(startUrlFromInput);

const resultsWanted = toPositiveInteger(resultsWantedRaw, 20);
const countPerPage = DEFAULT_COUNT_PER_PAGE;
const targetPages = Math.max(1, Math.ceil(resultsWanted / countPerPage));

let totalSaved = 0;
let runError;
const seenIntermediaryIds = new Set();

async function runWithCandidate(candidate) {
    log.info(`Using browser strategy: ${candidate.label}`);

    let browser;
    try {
        browser = await chromium.launch({
            headless: true,
            channel: 'chrome',
            proxy: candidate.proxy,
            args: ['--disable-blink-features=AutomationControlled'],
        });
    } catch (error) {
        if (isRecoverableNetworkError(error)) {
            log.warning(`Browser launch failed with recoverable network issue: ${error.message}`);
            return { recoverableNetworkError: true, blockedByChallenge: false };
        }
        throw error;
    }

    let blockedByChallenge = false;
    let recoverableNetworkError = false;

    try {
        const context = await browser.newContext({
            userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
            locale: 'fr-FR',
            timezoneId: 'Europe/Paris',
            viewport: { width: 1366, height: 768 },
            extraHTTPHeaders: {
                'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
            },
        });

        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });

        const page = await context.newPage();

        const warmupResult = await warmUpSession(page, parsedUrl.normalizedUrl);
        if (!warmupResult.ready) {
            blockedByChallenge = Boolean(warmupResult.blockedByChallenge);
            recoverableNetworkError = Boolean(warmupResult.recoverableError);
            return { blockedByChallenge, recoverableNetworkError };
        }

        const annuaireContext = await readAnnuaireContext(page, {
            geoApiPlaceId: '138724240',
            geoApiPlaceType: 'city',
            intermediaryTypes: parsedUrl.intermediaryTypes,
            projectType: parsedUrl.projectType,
        });

        if (!annuaireContext.geoApiPlaceId) {
            throw new Error('Could not resolve geoApiPlaceId from annuaire page.');
        }

        log.info(`Annuaire context: ${JSON.stringify(annuaireContext)}`);

        for (let pageNumber = 1; pageNumber <= targetPages && totalSaved < resultsWanted; pageNumber += 1) {
            const searchResult = await fetchWithRetries(
                () =>
                    fetchIntermediariesPage(page, {
                        geoApiPlaceId: annuaireContext.geoApiPlaceId,
                        geoApiPlaceType: annuaireContext.geoApiPlaceType,
                        pageNumber,
                        countPerPage,
                        projectType: annuaireContext.projectType,
                        intermediaryTypes: annuaireContext.intermediaryTypes,
                    }),
                {
                    retries: 4,
                    waitMs: 2_000,
                    label: `Intermediaries page ${pageNumber}`,
                    onRetry: async (result, attempt) => {
                        if (result?.status === 403 && isChallengePreview(result?.bodyPreview)) {
                            blockedByChallenge = true;
                            await sleep(1_000 * attempt);
                            try {
                                await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
                                await dismissCookieBanner(page);
                            } catch {
                                // Continue retries.
                            }
                        }
                    },
                },
            );

            if (searchResult?.status !== 200 || !searchResult?.data) {
                if (searchResult?.status === 403 && isChallengePreview(searchResult?.bodyPreview)) {
                    blockedByChallenge = true;
                }
                log.warning(`Intermediaries API unavailable on page ${pageNumber}. Preview: ${searchResult?.bodyPreview || ''}`);
                break;
            }

            const intermediaries = Array.isArray(searchResult.data.intermediaries) ? searchResult.data.intermediaries : [];
            const totalResults = searchResult.data.intermediariesCount || annuaireContext.totalResults;
            const locality = searchResult.data.locality || {};
            const localityPlace = locality.place || {};
            const breadcrumb = Array.isArray(searchResult.data.breadCrumb) ? searchResult.data.breadCrumb : [];
            const seoBlocks = Array.isArray(searchResult.data.seoBlocks) ? searchResult.data.seoBlocks : [];

            if (intermediaries.length === 0) {
                log.info(`No intermediary rows returned for page ${pageNumber}.`);
                break;
            }

            const records = [];
            for (const [index, intermediary] of intermediaries.entries()) {
                if (totalSaved + records.length >= resultsWanted) break;

                const intermediaryId = intermediary?.intermediaryId;
                if (!intermediaryId || seenIntermediaryIds.has(intermediaryId)) continue;

                const record = cleanData(
                    mapIntermediary(intermediary, {
                        pageNumber,
                        pageResultCount: intermediaries.length,
                        countPerPage,
                        rankOnPage: index + 1,
                        rankGlobal: (pageNumber - 1) * countPerPage + (index + 1),
                        totalResults,
                        localityUrlPath: locality.urlPath,
                        localityPlaceId: localityPlace.id,
                        localityPlaceType: localityPlace.type,
                        localityName: localityPlace.name,
                        localityPostalCode: localityPlace.postalCode,
                        breadcrumbCount: breadcrumb.length,
                        firstBreadcrumbLabel: breadcrumb[0]?.label,
                        seoBlocksCount: seoBlocks.length,
                        redirectUrl: searchResult.data.redirectUrl,
                        geoApiPlaceId: annuaireContext.geoApiPlaceId,
                        geoApiPlaceType: annuaireContext.geoApiPlaceType,
                        projectType: annuaireContext.projectType,
                        intermediaryTypes: annuaireContext.intermediaryTypes,
                        searchUrl: parsedUrl.normalizedUrl,
                    }),
                );

                if (!record || Object.keys(record).length === 0) continue;

                seenIntermediaryIds.add(intermediaryId);
                records.push(record);
            }

            if (records.length > 0) {
                await Dataset.pushData(records);
                totalSaved += records.length;
                log.info(`Saved ${records.length} intermediaries from page ${pageNumber} (${totalSaved}/${resultsWanted}).`);
            } else {
                log.info(`No new intermediary records to save on page ${pageNumber}.`);
            }

            if (intermediaries.length < countPerPage) break;
        }
    } catch (error) {
        if (isRecoverableNetworkError(error)) {
            recoverableNetworkError = true;
            log.warning(`Recoverable network issue for ${candidate.label}: ${error.message}`);
        } else {
            throw error;
        }
    } finally {
        await browser.close().catch(() => {});
    }

    return { blockedByChallenge, recoverableNetworkError };
}

try {
    log.info(`Run limits: resultsWanted=${resultsWanted}, autoPages=${targetPages}, countPerPage=${countPerPage}.`);

    const candidates = await buildProxyCandidates(proxyConfig);
    log.info(`Proxy candidates: ${candidates.map((item) => item.label).join(', ')}`);

    let blockedEverywhere = false;
    let recoverableNetworkIssueEverywhere = false;
    let triedAny = false;

    for (const candidate of candidates) {
        triedAny = true;
        const before = totalSaved;
        const result = await runWithCandidate(candidate);

        if (result.blockedByChallenge) {
            blockedEverywhere = true;
        }
        if (result.recoverableNetworkError) {
            recoverableNetworkIssueEverywhere = true;
        }

        if (totalSaved >= resultsWanted) break;
        if (totalSaved > before) {
            break;
        }
        if (result.blockedByChallenge || result.recoverableNetworkError) {
            log.info(`Switching browser strategy after ${candidate.label}.`);
            continue;
        }
        break;
    }

    if (triedAny && totalSaved === 0 && blockedEverywhere) {
        throw new Error('Blocked by SeLoger anti-bot protection. Enable Apify residential proxy and retry.');
    }

    if (triedAny && totalSaved === 0 && recoverableNetworkIssueEverywhere) {
        throw new Error('Temporary proxy/network failures across strategies. Actor auto-healed attempts exhausted; retry run.');
    }
} catch (error) {
    runError = error;
    log.error(`Run failed: ${error.stack || error.message}`);
} finally {
    log.info(`Finished. Saved ${totalSaved} intermediaries.`);
    if (runError) {
        await Actor.fail(runError.message);
    } else {
        await Actor.exit();
    }
}

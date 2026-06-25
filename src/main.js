import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';
import { Dataset } from 'crawlee';
import { gotScraping } from 'got-scraping';

const DEFAULT_START_URL =
    'https://www.seloger.com/annuaire/paris-75000/#intermediaryTypes=1&intermediaryTypes=2&intermediaryTypes=3&intermediaryTypes=5&projectType=1';
const DEFAULT_COUNT_PER_PAGE = 100;
const API_BASE = 'https://www.seloger.com/slr_idb/api/v4/intermediaries';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0';

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

function parseStartUrl(url) {
    const parsed = new URL(url);
    const hashParams = new URLSearchParams(parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash);

    return {
        normalizedUrl: parsed.href,
        projectType: hashParams.get('projectType') || '1',
        intermediaryTypes: normalizeIntermediaryTypes(hashParams.getAll('intermediaryTypes'), [1, 2, 3, 5]),
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

    const search = nextData?.props?.pageProps?.initialState?.search || {};
    const locality = search?.locality || search?.maPlace || {};

    const geoApiPlaceId = locality?.geoApiPlaceId ?? locality?.id ?? locality?.placeId;
    const geoApiPlaceType = locality?.geoApiPlaceType ?? locality?.type ?? locality?.placeType;

    return {
        geoApiPlaceId: geoApiPlaceId ? String(geoApiPlaceId) : undefined,
        geoApiPlaceType: geoApiPlaceType || undefined,
        projectType: parsedUrl.projectType || String(search?.projectType || '1'),
        intermediaryTypes: parsedUrl.intermediaryTypes,
        totalResults: search?.results?.intermediariesCount,
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
        query.append('intermediaryTypes', String(type));
    }
    return `${API_BASE}?${query.toString()}`;
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

async function fetchWithGotScraping(url, { proxyUrl, referer, accept = 'application/json' } = {}) {
    return gotScraping.get(url, {
        proxyUrl,
        headers: {
            'User-Agent': USER_AGENT,
            Accept: accept,
            'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
            ...(referer ? { Referer: referer } : {}),
        },
        timeout: { request: 30_000 },
    });
}

async function fetchWithRetries(fetchFn, { retries = 3, waitMs = 2000, label }) {
    let lastResult;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
        lastResult = await fetchFn();
        if (lastResult?.ok) return lastResult;

        log.warning(`${label} failed (attempt ${attempt}/${retries}), status ${lastResult?.status}.`);
        if (attempt < retries) await sleep(waitMs);
    }

    return lastResult;
}

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    startUrl,
    start_url,
    results_wanted: resultsWantedRaw = 20,
    count_per_page: countPerPageRaw,
    proxyConfiguration: proxyConfig,
} = input;

const startUrlFromInput = startUrl || start_url || DEFAULT_START_URL;
const parsedUrl = parseStartUrl(startUrlFromInput);

const resultsWanted = toPositiveInteger(resultsWantedRaw, 20);
const countPerPage = toPositiveInteger(countPerPageRaw, DEFAULT_COUNT_PER_PAGE);
const targetPages = Math.max(1, Math.ceil(resultsWanted / countPerPage));

const proxyConfiguration = proxyConfig ? await Actor.createProxyConfiguration(proxyConfig) : undefined;

let totalSaved = 0;
let runError;
const seenIntermediaryIds = new Set();

try {
    log.info(`Run limits: resultsWanted=${resultsWanted}, autoPages=${targetPages}, countPerPage=${countPerPage}.`);

    const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;

    const pageResponse = await fetchWithRetries(
        async () => {
            const response = await fetchWithGotScraping(parsedUrl.normalizedUrl, {
                proxyUrl,
                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            });
            return {
                ok: response.statusCode === 200 && response.body.includes('__NEXT_DATA__'),
                status: response.statusCode,
                body: response.body,
            };
        },
        { retries: 3, waitMs: 2000, label: 'Annuaire page bootstrap' },
    );

    if (!pageResponse?.ok) {
        throw new Error(`Could not load annuaire page (status ${pageResponse?.status || 'unknown'}).`);
    }

    const annuaireContext = extractAnnuaireContext(pageResponse.body, parsedUrl);
    if (!annuaireContext.geoApiPlaceId || !annuaireContext.geoApiPlaceType) {
        throw new Error('Could not resolve geoApiPlaceId or geoApiPlaceType from annuaire page.');
    }

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

        log.info(`Fetching page ${pageNumber}: ${apiUrl}`);

        const searchResult = await fetchWithRetries(
            async () => {
                const response = await fetchWithGotScraping(apiUrl, {
                    proxyUrl,
                    referer: parsedUrl.normalizedUrl,
                });

                let data;
                try {
                    data = JSON.parse(response.body);
                } catch {
                    data = null;
                }

                return {
                    ok: response.statusCode === 200 && data && Array.isArray(data.intermediaries),
                    status: response.statusCode,
                    data,
                    bodyPreview: response.body.slice(0, 400),
                };
            },
            { retries: 4, waitMs: 2000, label: `Intermediaries page ${pageNumber}` },
        );

        if (!searchResult?.ok) {
            log.warning(
                `Intermediaries API unavailable on page ${pageNumber}. Preview: ${searchResult?.bodyPreview || ''}`,
            );
            break;
        }

        const { intermediaries, intermediariesCount, locality: localityRaw = {}, breadCrumb, seoBlocks: seoBlocksRaw, redirectUrl } =
            searchResult.data;
        const totalResults = intermediariesCount || annuaireContext.totalResults;
        const locality = localityRaw || {};
        const localityPlace = locality.place || {};
        const breadcrumb = Array.isArray(breadCrumb) ? breadCrumb : [];
        const seoBlocks = Array.isArray(seoBlocksRaw) ? seoBlocksRaw : [];

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
                    redirectUrl,
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

    if (totalSaved === 0) {
        throw new Error('No intermediary records were extracted. Check startUrl filters or retry with proxy.');
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

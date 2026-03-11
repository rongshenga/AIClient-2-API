import logger from '../utils/logger.js';
import { getRuntimeStorage } from '../storage/runtime-storage-registry.js';

const DEFAULT_PROVIDER_USAGE_PAGE_LIMIT = 30;
let usageCacheWriteQueue = Promise.resolve();

function createUsageCacheReadTimeoutError(message, timeoutMs, details = {}) {
    const error = new Error(message);
    error.code = 'usage_cache_read_timeout';
    error.timeoutMs = timeoutMs;
    error.details = details;
    return error;
}

async function withUsageCacheReadTimeout(promiseFactory, timeoutMs, message, details = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return await promiseFactory();
    }

    let timeoutId = null;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(createUsageCacheReadTimeoutError(message, timeoutMs, details));
        }, timeoutMs);
    });

    try {
        return await Promise.race([
            Promise.resolve().then(() => promiseFactory()),
            timeoutPromise
        ]);
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
}

function logUsageCacheLifecycle(enabled, message, payload = null) {
    if (!enabled) {
        return;
    }

    if (payload !== null && payload !== undefined) {
        logger.info(`[Usage Cache] ${message}`, payload);
        return;
    }

    logger.info(`[Usage Cache] ${message}`);
}

function createEmptyUsageCache() {
    return {
        timestamp: new Date().toISOString(),
        providers: {}
    };
}

function normalizeTimestamp(value, fallback = null) {
    if (typeof value === 'string' && value.trim()) {
        const parsedDate = new Date(value);
        if (!Number.isNaN(parsedDate.getTime())) {
            return parsedDate.toISOString();
        }
    }
    return fallback;
}

function normalizeUsageInstance(instance, fallbackTimestamp = null) {
    if (!instance || typeof instance !== 'object') {
        return null;
    }

    return {
        ...instance,
        lastRefreshedAt: normalizeTimestamp(
            instance.lastRefreshedAt || instance.timestamp || instance.cachedAt,
            fallbackTimestamp
        )
    }; 
}

function normalizeProviderUsage(providerType, usageData = {}, fallbackTimestamp = null) {
    const providerTimestamp = normalizeTimestamp(
        usageData.timestamp || usageData.refreshedAt || usageData.cachedAt,
        fallbackTimestamp || new Date().toISOString()
    );
    const instances = Array.isArray(usageData.instances)
        ? usageData.instances
            .map((instance) => normalizeUsageInstance(instance, providerTimestamp))
            .filter(Boolean)
        : [];
    const successCount = Number.isFinite(usageData.successCount)
        ? usageData.successCount
        : instances.filter((instance) => instance.success === true).length;
    const errorCount = Number.isFinite(usageData.errorCount)
        ? usageData.errorCount
        : instances.filter((instance) => instance.success !== true).length;
    const totalCount = Number.isFinite(usageData.totalCount)
        ? usageData.totalCount
        : instances.length;
    const processedCount = Number.isFinite(usageData.processedCount)
        ? usageData.processedCount
        : instances.length;

    return {
        ...usageData,
        providerType: usageData.providerType || providerType,
        timestamp: providerTimestamp,
        instances,
        totalCount,
        successCount,
        errorCount,
        processedCount
    };
}

function normalizeProviderUsagePageOptions(options = {}) {
    const rawPage = Number.parseInt(options?.page, 10);
    const rawLimit = Number.parseInt(options?.limit, 10);
    if (!Number.isFinite(rawPage) && !Number.isFinite(rawLimit)) {
        return null;
    }

    return {
        page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
        limit: Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_PROVIDER_USAGE_PAGE_LIMIT
    };
}

function paginateProviderUsage(usageData = {}, pageQuery = null) {
    if (!pageQuery) {
        return usageData;
    }

    const existingLimit = Number(usageData?.limit || 0);
    const existingPage = Number(usageData?.page || 0);
    const existingAvailableCount = Number(usageData?.availableCount);
    if (existingLimit > 0 && existingPage > 0 && Number.isFinite(existingAvailableCount)) {
        return usageData;
    }

    const instances = Array.isArray(usageData?.instances) ? usageData.instances : [];
    const availableCount = Number.isFinite(usageData?.availableCount)
        ? Number(usageData.availableCount)
        : (Number.isFinite(usageData?.processedCount) ? Number(usageData.processedCount) : instances.length);
    const totalPages = Math.max(1, Math.ceil(Math.max(availableCount, 1) / pageQuery.limit));
    const page = Math.min(Math.max(1, Number(pageQuery.page || 1)), totalPages);
    const offset = (page - 1) * pageQuery.limit;

    return {
        ...usageData,
        instances: instances.slice(offset, offset + pageQuery.limit),
        availableCount,
        page,
        limit: pageQuery.limit,
        totalPages,
        hasPrevPage: page > 1,
        hasNextPage: page < totalPages
    };
}

function normalizeUsageCache(cache) {
    if (!cache || typeof cache !== 'object') {
        return createEmptyUsageCache();
    }

    const cacheTimestamp = normalizeTimestamp(cache.timestamp, new Date().toISOString());
    const normalizedCache = {
        ...cache,
        timestamp: cacheTimestamp,
        providers: {}
    };

    for (const [providerType, providerUsage] of Object.entries(cache.providers || {})) {
        normalizedCache.providers[providerType] = normalizeProviderUsage(providerType, providerUsage, cacheTimestamp);
    }

    return normalizedCache;
}

function summarizeUsageCache(cache) {
    const normalizedCache = normalizeUsageCache(cache);
    const providers = {};

    for (const [providerType, providerUsage] of Object.entries(normalizedCache.providers || {})) {
        providers[providerType] = {
            providerType,
            timestamp: providerUsage.timestamp || normalizedCache.timestamp,
            totalCount: Number(providerUsage.totalCount ?? 0),
            successCount: Number(providerUsage.successCount ?? 0),
            errorCount: Number(providerUsage.errorCount ?? 0),
            processedCount: Number.isFinite(providerUsage.processedCount)
                ? providerUsage.processedCount
                : (Array.isArray(providerUsage.instances) ? providerUsage.instances.length : Number(providerUsage.totalCount ?? 0)),
            instances: [],
            detailsLoaded: false
        };
    }

    return {
        timestamp: normalizedCache.timestamp,
        providers
    };
}

function enqueueUsageCacheWrite(writer) {
    const run = usageCacheWriteQueue.then(writer, writer);
    usageCacheWriteQueue = run.catch((error) => {
        logger.error('[Usage Cache] Queued usage cache write failed:', error.message);
    });
    return run;
}

function getUsageStorage() {
    const runtimeStorage = getRuntimeStorage();
    if (!runtimeStorage || typeof runtimeStorage.loadUsageCacheSnapshot !== 'function') {
        return null;
    }
    return runtimeStorage;
}

function getUsageInstanceMergeKey(instance = {}, index = 0) {
    if (instance?.uuid) {
        return `uuid:${instance.uuid}`;
    }
    if (instance?.name) {
        return `name:${instance.name}`;
    }
    if (instance?.customName) {
        return `name:${instance.customName}`;
    }
    return `index:${index}`;
}

function mergeProviderUsageSnapshots(providerType, existingSnapshot = {}, incomingSnapshot = {}) {
    const normalizedExisting = normalizeProviderUsage(providerType, existingSnapshot, incomingSnapshot?.timestamp || null);
    const normalizedIncoming = normalizeProviderUsage(providerType, incomingSnapshot, normalizedExisting.timestamp);
    const mergedInstances = [...(normalizedExisting.instances || [])];
    const mergeKeyIndex = new Map();

    mergedInstances.forEach((instance, index) => {
        mergeKeyIndex.set(getUsageInstanceMergeKey(instance, index), index);
    });

    for (const incomingInstance of normalizedIncoming.instances || []) {
        const mergeKey = getUsageInstanceMergeKey(incomingInstance);
        const existingIndex = mergeKeyIndex.get(mergeKey);
        if (Number.isFinite(existingIndex)) {
            mergedInstances[existingIndex] = incomingInstance;
            continue;
        }

        mergeKeyIndex.set(mergeKey, mergedInstances.length);
        mergedInstances.push(incomingInstance);
    }

    const existingTotalCount = Number(normalizedExisting.totalCount ?? mergedInstances.length);
    const incomingTotalCount = Number(normalizedIncoming.totalCount ?? normalizedIncoming.instances.length);
    const mergedTotalCount = Math.max(existingTotalCount, incomingTotalCount, mergedInstances.length);
    const mergedSuccessCount = mergedInstances.filter((instance) => instance?.success === true).length;
    const mergedErrorCount = Math.max(0, mergedInstances.length - mergedSuccessCount);

    return {
        ...normalizedExisting,
        ...normalizedIncoming,
        providerType,
        timestamp: normalizedIncoming.timestamp || new Date().toISOString(),
        instances: mergedInstances,
        totalCount: mergedTotalCount,
        processedCount: mergedInstances.length,
        successCount: mergedSuccessCount,
        errorCount: mergedErrorCount
    };
}

export async function readUsageCache(options = {}) {
    const runtimeReadTimeoutMs = Number.isFinite(Number(options.runtimeReadTimeoutMs)) && Number(options.runtimeReadTimeoutMs) > 0
        ? Number(options.runtimeReadTimeoutMs)
        : null;
    const lifecycleLoggingEnabled = options.logLifecycle === true;
    const debugLabel = typeof options.debugLabel === 'string' && options.debugLabel.trim()
        ? options.debugLabel.trim()
        : 'readUsageCache';
    const runtimeStorage = getUsageStorage();
    if (!runtimeStorage) {
        return null;
    }

    try {
        const runtimeReadStartedAt = Date.now();
        logUsageCacheLifecycle(lifecycleLoggingEnabled, 'Runtime storage usage cache read started', {
            debugLabel,
            timeoutMs: runtimeReadTimeoutMs
        });

        const snapshot = await withUsageCacheReadTimeout(
            async () => await runtimeStorage.loadUsageCacheSnapshot(),
            runtimeReadTimeoutMs,
            `Runtime storage usage cache read timed out after ${runtimeReadTimeoutMs}ms`,
            {
                debugLabel,
                stage: 'runtimeStorage.loadUsageCacheSnapshot'
            }
        );
        logUsageCacheLifecycle(lifecycleLoggingEnabled, 'Runtime storage usage cache read completed', {
            debugLabel,
            durationMs: Date.now() - runtimeReadStartedAt,
            hit: Boolean(snapshot)
        });
        return snapshot ? normalizeUsageCache(snapshot) : null;
    } catch (error) {
        logger.warn('[Usage Cache] Failed to read usage cache from runtime storage:', {
            debugLabel,
            message: error.message,
            code: error.code || null,
            timeoutMs: error.timeoutMs || runtimeReadTimeoutMs
        });
        return null;
    }
}

export async function readUsageCacheSummary(options = {}) {
    const runtimeStorage = getUsageStorage();
    if (runtimeStorage && typeof runtimeStorage.loadUsageCacheSummary === 'function') {
        try {
            const summary = await withUsageCacheReadTimeout(
                async () => await runtimeStorage.loadUsageCacheSummary(),
                Number.isFinite(Number(options.runtimeReadTimeoutMs)) && Number(options.runtimeReadTimeoutMs) > 0
                    ? Number(options.runtimeReadTimeoutMs)
                    : null,
                `Runtime storage usage cache summary read timed out after ${Number(options.runtimeReadTimeoutMs || 0)}ms`,
                {
                    debugLabel: options.debugLabel || 'readUsageCacheSummary',
                    stage: 'runtimeStorage.loadUsageCacheSummary'
                }
            );
            return summary ? summarizeUsageCache(summary) : null;
        } catch (error) {
            logger.warn('[Usage Cache] Failed to read usage cache summary from runtime storage:', error.message);
        }
    }

    const cache = await readUsageCache(options);
    return cache ? summarizeUsageCache(cache) : null;
}

export async function writeUsageCache(usageData) {
    const normalizedUsageData = normalizeUsageCache(usageData);
    try {
        await enqueueUsageCacheWrite(async () => {
            const runtimeStorage = getUsageStorage();
            if (!runtimeStorage || typeof runtimeStorage.replaceUsageCacheSnapshot !== 'function') {
                logger.warn('[Usage Cache] Runtime storage is unavailable, skip writing usage cache snapshot');
                return;
            }
            await runtimeStorage.replaceUsageCacheSnapshot(normalizedUsageData);
        });
    } catch (error) {
        logger.error('[Usage Cache] Failed to write usage cache:', error.message);
    }
}

export async function readProviderUsageCache(providerType, options = {}) {
    const pageQuery = normalizeProviderUsagePageOptions(options);
    const runtimeStorage = getUsageStorage();
    if (!runtimeStorage || typeof runtimeStorage.loadProviderUsageSnapshot !== 'function') {
        return null;
    }

    try {
        const snapshot = await runtimeStorage.loadProviderUsageSnapshot(providerType, pageQuery || undefined);
        if (snapshot) {
            const providerUsage = paginateProviderUsage(
                normalizeProviderUsage(providerType, snapshot, snapshot.timestamp || null),
                pageQuery
            );
            return {
                ...providerUsage,
                cachedAt: providerUsage.timestamp,
                fromCache: true,
                __pageApplied: pageQuery !== null
            };
        }
        return null;
    } catch (error) {
        logger.warn(`[Usage Cache] Failed to read provider usage cache from runtime storage for ${providerType}:`, error.message);
        return null;
    }
}

export async function updateProviderUsageCache(providerType, usageData, options = {}) {
    try {
        await enqueueUsageCacheWrite(async () => {
            const runtimeStorage = getUsageStorage();
            if (!runtimeStorage || typeof runtimeStorage.upsertProviderUsageSnapshot !== 'function') {
                logger.warn(`[Usage Cache] Runtime storage is unavailable, skip updating provider usage cache: ${providerType}`);
                return;
            }

            const normalizedProviderUsage = normalizeProviderUsage(providerType, usageData, new Date().toISOString());
            let snapshotToPersist = normalizedProviderUsage;
            if (options.mergeWithExisting === true && typeof runtimeStorage.loadProviderUsageSnapshot === 'function') {
                const existingSnapshot = await runtimeStorage.loadProviderUsageSnapshot(providerType);
                if (existingSnapshot) {
                    snapshotToPersist = mergeProviderUsageSnapshots(providerType, existingSnapshot, normalizedProviderUsage);
                }
            }

            await runtimeStorage.upsertProviderUsageSnapshot(providerType, snapshotToPersist);
        });
    } catch (error) {
        logger.error('[Usage Cache] Failed to update provider usage cache:', error.message);
    }
}

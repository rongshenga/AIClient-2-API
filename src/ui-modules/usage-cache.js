import { existsSync } from 'fs';
import logger from '../utils/logger.js';
import { promises as fs } from 'fs';
import path from 'path';
import { getRuntimeStorage } from '../storage/runtime-storage-registry.js';

const USAGE_CACHE_FILE = path.join(process.cwd(), 'configs', 'usage-cache.json');
const USAGE_CACHE_TMP_FILE = `${USAGE_CACHE_FILE}.tmp`;
let usageCacheWriteQueue = Promise.resolve();

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

function enqueueUsageCacheWrite(writer) {
    const run = usageCacheWriteQueue.then(writer, writer);
    usageCacheWriteQueue = run.catch((error) => {
        logger.error('[Usage Cache] Queued usage cache write failed:', error.message);
    });
    return run;
}

async function writeUsageCacheFile(usageData) {
    await fs.mkdir(path.dirname(USAGE_CACHE_FILE), { recursive: true });
    await fs.writeFile(USAGE_CACHE_TMP_FILE, JSON.stringify(usageData, null, 2), 'utf8');
    await fs.rename(USAGE_CACHE_TMP_FILE, USAGE_CACHE_FILE);
    logger.info('[Usage Cache] Usage data cached to', USAGE_CACHE_FILE);
}

function getUsageStorage() {
    const runtimeStorage = getRuntimeStorage();
    if (!runtimeStorage || typeof runtimeStorage.loadUsageCacheSnapshot !== 'function') {
        return null;
    }
    return runtimeStorage;
}

export async function readUsageCache() {
    const runtimeStorage = getUsageStorage();
    if (runtimeStorage) {
        try {
            const snapshot = await runtimeStorage.loadUsageCacheSnapshot();
            return snapshot ? normalizeUsageCache(snapshot) : null;
        } catch (error) {
            logger.warn('[Usage Cache] Failed to read usage cache from runtime storage:', error.message);
        }
    }

    try {
        if (existsSync(USAGE_CACHE_FILE)) {
            const content = await fs.readFile(USAGE_CACHE_FILE, 'utf8');
            return normalizeUsageCache(JSON.parse(content));
        }
        return null;
    } catch (error) {
        logger.warn('[Usage Cache] Failed to read usage cache:', error.message);
        return null;
    }
}

export async function writeUsageCache(usageData) {
    const normalizedUsageData = normalizeUsageCache(usageData);
    try {
        await enqueueUsageCacheWrite(async () => {
            const runtimeStorage = getUsageStorage();
            if (runtimeStorage && typeof runtimeStorage.replaceUsageCacheSnapshot === 'function') {
                await runtimeStorage.replaceUsageCacheSnapshot(normalizedUsageData);
                return;
            }
            await writeUsageCacheFile(normalizedUsageData);
        });
    } catch (error) {
        logger.error('[Usage Cache] Failed to write usage cache:', error.message);
    }
}

export async function readProviderUsageCache(providerType) {
    const runtimeStorage = getUsageStorage();
    if (runtimeStorage && typeof runtimeStorage.loadProviderUsageSnapshot === 'function') {
        try {
            const snapshot = await runtimeStorage.loadProviderUsageSnapshot(providerType);
            if (snapshot) {
                const providerUsage = normalizeProviderUsage(providerType, snapshot, snapshot.timestamp || null);
                return {
                    ...providerUsage,
                    cachedAt: providerUsage.timestamp,
                    fromCache: true
                };
            }
        } catch (error) {
            logger.warn(`[Usage Cache] Failed to read provider usage cache from runtime storage for ${providerType}:`, error.message);
        }
    }

    const cache = await readUsageCache();
    if (cache && cache.providers && cache.providers[providerType]) {
        const providerUsage = normalizeProviderUsage(providerType, cache.providers[providerType], cache.timestamp);
        return {
            ...providerUsage,
            cachedAt: providerUsage.timestamp,
            fromCache: true
        };
    }
    return null;
}

export async function updateProviderUsageCache(providerType, usageData) {
    try {
        await enqueueUsageCacheWrite(async () => {
            const runtimeStorage = getUsageStorage();
            const normalizedProviderUsage = normalizeProviderUsage(providerType, usageData, new Date().toISOString());
            if (runtimeStorage && typeof runtimeStorage.upsertProviderUsageSnapshot === 'function') {
                await runtimeStorage.upsertProviderUsageSnapshot(providerType, normalizedProviderUsage);
                return;
            }

            const cache = (await readUsageCache()) || createEmptyUsageCache();
            cache.providers[providerType] = normalizedProviderUsage;
            cache.timestamp = new Date().toISOString();
            await writeUsageCacheFile(cache);
        });
    } catch (error) {
        logger.error('[Usage Cache] Failed to update provider usage cache:', error.message);
    }
}

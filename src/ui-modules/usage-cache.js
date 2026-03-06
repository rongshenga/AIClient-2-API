import { existsSync } from 'fs';
import logger from '../utils/logger.js';
import { promises as fs } from 'fs';
import path from 'path';

// 用量缓存文件路径
const USAGE_CACHE_FILE = path.join(process.cwd(), 'configs', 'usage-cache.json');
const USAGE_CACHE_TMP_FILE = `${USAGE_CACHE_FILE}.tmp`;
let usageCacheWriteQueue = Promise.resolve();

/**
 * 创建空缓存对象
 * @returns {Object} 空缓存对象
 */
function createEmptyUsageCache() {
    return {
        timestamp: new Date().toISOString(),
        providers: {}
    };
}

/**
 * 解析有效时间戳
 * @param {string|null|undefined} value - 时间字符串
 * @param {string|null} fallback - 回退时间
 * @returns {string|null} 有效时间戳
 */
function normalizeTimestamp(value, fallback = null) {
    if (typeof value === 'string' && value.trim()) {
        const parsedDate = new Date(value);
        if (!Number.isNaN(parsedDate.getTime())) {
            return parsedDate.toISOString();
        }
    }
    return fallback;
}

/**
 * 规范化实例缓存数据
 * @param {Object} instance - 实例缓存
 * @param {string|null} fallbackTimestamp - 回退时间戳
 * @returns {Object|null} 规范化后的实例缓存
 */
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

/**
 * 规范化提供商缓存数据
 * @param {string} providerType - 提供商类型
 * @param {Object} usageData - 提供商缓存数据
 * @param {string|null} fallbackTimestamp - 回退时间戳
 * @returns {Object} 规范化后的提供商缓存
 */
function normalizeProviderUsage(providerType, usageData = {}, fallbackTimestamp = null) {
    const providerTimestamp = normalizeTimestamp(
        usageData.timestamp || usageData.refreshedAt || usageData.cachedAt,
        fallbackTimestamp || new Date().toISOString()
    );
    const instances = Array.isArray(usageData.instances)
        ? usageData.instances
            .map(instance => normalizeUsageInstance(instance, providerTimestamp))
            .filter(Boolean)
        : [];
    const successCount = Number.isFinite(usageData.successCount)
        ? usageData.successCount
        : instances.filter(instance => instance.success === true).length;
    const errorCount = Number.isFinite(usageData.errorCount)
        ? usageData.errorCount
        : instances.filter(instance => instance.success !== true).length;
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

/**
 * 规范化整体缓存结构
 * @param {Object|null} cache - 原始缓存
 * @returns {Object} 规范化后的缓存
 */
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

/**
 * 将写入任务加入串行队列
 * @param {() => Promise<any>} writer - 写入函数
 * @returns {Promise<any>} 写入结果
 */
function enqueueUsageCacheWrite(writer) {
    const run = usageCacheWriteQueue.then(writer, writer);
    usageCacheWriteQueue = run.catch((error) => {
        logger.error('[Usage Cache] Queued usage cache write failed:', error.message);
    });
    return run;
}

/**
 * 将缓存原子写入磁盘
 * @param {Object} usageData - 用量缓存
 */
async function writeUsageCacheFile(usageData) {
    await fs.mkdir(path.dirname(USAGE_CACHE_FILE), { recursive: true });
    await fs.writeFile(USAGE_CACHE_TMP_FILE, JSON.stringify(usageData, null, 2), 'utf8');
    await fs.rename(USAGE_CACHE_TMP_FILE, USAGE_CACHE_FILE);
    logger.info('[Usage Cache] Usage data cached to', USAGE_CACHE_FILE);
}

/**
 * 读取用量缓存文件
 * @returns {Promise<Object|null>} 缓存的用量数据，如果不存在或读取失败则返回 null
 */
export async function readUsageCache() {
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

/**
 * 写入用量缓存文件
 * @param {Object} usageData - 用量数据
 */
export async function writeUsageCache(usageData) {
    const normalizedUsageData = normalizeUsageCache(usageData);
    try {
        await enqueueUsageCacheWrite(async () => {
            await writeUsageCacheFile(normalizedUsageData);
        });
    } catch (error) {
        logger.error('[Usage Cache] Failed to write usage cache:', error.message);
    }
}

/**
 * 读取特定提供商类型的用量缓存
 * @param {string} providerType - 提供商类型
 * @returns {Promise<Object|null>} 缓存的用量数据
 */
export async function readProviderUsageCache(providerType) {
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

/**
 * 更新特定提供商类型的用量缓存
 * @param {string} providerType - 提供商类型
 * @param {Object} usageData - 用量数据
 */
export async function updateProviderUsageCache(providerType, usageData) {
    try {
        await enqueueUsageCacheWrite(async () => {
            const cache = (await readUsageCache()) || createEmptyUsageCache();
            const normalizedProviderUsage = normalizeProviderUsage(providerType, usageData, cache.timestamp);
            cache.providers[providerType] = normalizedProviderUsage;
            cache.timestamp = new Date().toISOString();
            await writeUsageCacheFile(cache);
        });
    } catch (error) {
        logger.error('[Usage Cache] Failed to update provider usage cache:', error.message);
    }
}

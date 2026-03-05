import { CONFIG } from '../core/config-manager.js';
import logger from '../utils/logger.js';
import { serviceInstances, getServiceAdapter } from '../providers/adapter.js';
import { formatKiroUsage, formatGeminiUsage, formatAntigravityUsage, formatCodexUsage, formatGrokUsage } from '../services/usage-service.js';
import { readUsageCache, writeUsageCache, readProviderUsageCache, updateProviderUsageCache } from './usage-cache.js';
import path from 'path';

const supportedProviders = ['claude-kiro-oauth', 'gemini-cli-oauth', 'gemini-antigravity', 'openai-codex-oauth', 'grok-custom'];
const DEFAULT_USAGE_QUERY_CONCURRENCY_PER_PROVIDER = 8;
const MAX_USAGE_QUERY_CONCURRENCY_PER_PROVIDER = 64;

/**
 * 将输入解析为正整数
 * @param {any} value - 输入值
 * @returns {number|null} 正整数或 null
 */
function parsePositiveInt(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }
    return parsed;
}

/**
 * 解析并发配置
 * 优先级：接口参数 > USAGE_QUERY_CONCURRENCY_PER_PROVIDER > REFRESH_CONCURRENCY_PER_PROVIDER(>1) > 默认值
 * @param {Object} currentConfig - 当前配置
 * @param {number|null} concurrencyOverride - 接口传入并发覆盖值
 * @returns {number} 并发值
 */
function resolveUsageQueryConcurrency(currentConfig, concurrencyOverride = null) {
    const overrideValue = parsePositiveInt(concurrencyOverride);
    const usageConfigValue = parsePositiveInt(currentConfig?.USAGE_QUERY_CONCURRENCY_PER_PROVIDER);
    const legacyRefreshValue = parsePositiveInt(currentConfig?.REFRESH_CONCURRENCY_PER_PROVIDER);
    const preferredLegacyValue = legacyRefreshValue && legacyRefreshValue > 1 ? legacyRefreshValue : null;

    const resolved = overrideValue
        || usageConfigValue
        || preferredLegacyValue
        || DEFAULT_USAGE_QUERY_CONCURRENCY_PER_PROVIDER;

    return Math.min(resolved, MAX_USAGE_QUERY_CONCURRENCY_PER_PROVIDER);
}

/**
 * 并发映射工具（保序）
 * @param {Array<any>} items - 输入数组
 * @param {number} concurrency - 并发数
 * @param {(item:any, index:number)=>Promise<any>} mapper - 映射函数
 * @returns {Promise<Array<any>>} 映射结果
 */
async function mapWithConcurrency(items, concurrency, mapper) {
    if (!Array.isArray(items) || items.length === 0) {
        return [];
    }

    const workerCount = Math.min(Math.max(1, concurrency), items.length);
    const results = new Array(items.length);
    let nextIndex = 0;

    const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
            const currentIndex = nextIndex++;
            if (currentIndex >= items.length) {
                return;
            }
            results[currentIndex] = await mapper(items[currentIndex], currentIndex);
        }
    });

    await Promise.all(workers);
    return results;
}


/**
 * 获取所有支持用量查询的提供商的用量信息
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @param {Object} [options] - 可选参数
 * @returns {Promise<Object>} 所有提供商的用量信息
 */
async function getAllProvidersUsage(currentConfig, providerPoolManager, options = {}) {
    const results = {
        timestamp: new Date().toISOString(),
        providers: {}
    };

    // 并发获取所有提供商的用量数据
    const usagePromises = supportedProviders.map(async (providerType) => {
        try {
            const providerUsage = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager, options);
            return { providerType, data: providerUsage, success: true };
        } catch (error) {
            return {
                providerType,
                data: {
                    error: error.message,
                    instances: []
                },
                success: false
            };
        }
    });

    // 等待所有并发请求完成
    const usageResults = await Promise.all(usagePromises);

    // 将结果整合到 results.providers 中
    for (const result of usageResults) {
        results.providers[result.providerType] = result.data;
    }

    return results;
}

/**
 * 获取指定提供商类型的用量信息
 * @param {string} providerType - 提供商类型
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @param {Object} [options] - 可选参数
 * @returns {Promise<Object>} 提供商用量信息
 */
async function getProviderTypeUsage(providerType, currentConfig, providerPoolManager, options = {}) {
    const result = {
        providerType,
        instances: [],
        totalCount: 0,
        successCount: 0,
        errorCount: 0
    };

    // 获取提供商池中的所有实例
    let providers = [];
    if (providerPoolManager && providerPoolManager.providerPools && providerPoolManager.providerPools[providerType]) {
        providers = providerPoolManager.providerPools[providerType];
    } else if (currentConfig.providerPools && currentConfig.providerPools[providerType]) {
        providers = currentConfig.providerPools[providerType];
    }

    result.totalCount = providers.length;

    const queryConcurrency = resolveUsageQueryConcurrency(currentConfig, options.usageConcurrency);
    logger.info(`[Usage API] Querying usage for ${providerType} with ${providers.length} instances (concurrency=${queryConcurrency})`);

    result.instances = await mapWithConcurrency(providers, queryConcurrency, async (provider) => {
        const instanceResult = {
            uuid: provider?.uuid || 'unknown',
            name: getProviderDisplayName(provider, providerType),
            isHealthy: provider?.isHealthy !== false,
            isDisabled: provider?.isDisabled === true,
            success: false,
            usage: null,
            error: null
        };

        try {
            const providerKey = providerType + (provider.uuid || '');
            let adapter = serviceInstances[providerKey];

            // First check if disabled, skip initialization for disabled providers
            if (provider.isDisabled) {
                instanceResult.error = 'Provider is disabled';
                return instanceResult;
            }

            if (!adapter) {
                // Service instance not initialized, try auto-initialization
                try {
                    logger.info(`[Usage API] Auto-initializing service adapter for ${providerType}: ${provider.uuid}`);
                    // Build configuration object
                    const serviceConfig = {
                        ...CONFIG,
                        ...provider,
                        MODEL_PROVIDER: providerType
                    };
                    adapter = getServiceAdapter(serviceConfig);
                } catch (initError) {
                    logger.error(`[Usage API] Failed to initialize adapter for ${providerType}: ${provider.uuid}:`, initError.message);
                    instanceResult.error = `Service instance initialization failed: ${initError.message}`;
                    return instanceResult;
                }
            }

            // If adapter exists (including just initialized), and no error, try to get usage
            if (adapter) {
                const usage = await getAdapterUsage(adapter, providerType);
                instanceResult.success = true;
                instanceResult.usage = usage;
            }
            return instanceResult;
        } catch (error) {
            logger.error(`[Usage API] Unexpected error while querying ${providerType}:${instanceResult.uuid}:`, error.message);
            instanceResult.error = error.message;
            return instanceResult;
        }
    });

    for (const instance of result.instances) {
        if (instance.success) {
            result.successCount++;
        } else {
            result.errorCount++;
        }
    }

    return result;
}

/**
 * 从适配器获取用量信息
 * @param {Object} adapter - 服务适配器
 * @param {string} providerType - 提供商类型
 * @returns {Promise<Object>} 用量信息
 */
async function getAdapterUsage(adapter, providerType) {
    if (providerType === 'claude-kiro-oauth') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits();
            return formatKiroUsage(rawUsage);
        } else if (adapter.kiroApiService && typeof adapter.kiroApiService.getUsageLimits === 'function') {
            const rawUsage = await adapter.kiroApiService.getUsageLimits();
            return formatKiroUsage(rawUsage);
        }
        throw new Error('This adapter does not support usage query');
    }
    
    if (providerType === 'gemini-cli-oauth') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits();
            return formatGeminiUsage(rawUsage);
        } else if (adapter.geminiApiService && typeof adapter.geminiApiService.getUsageLimits === 'function') {
            const rawUsage = await adapter.geminiApiService.getUsageLimits();
            return formatGeminiUsage(rawUsage);
        }
        throw new Error('This adapter does not support usage query');
    }
    
    if (providerType === 'gemini-antigravity') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits();
            return formatAntigravityUsage(rawUsage);
        } else if (adapter.antigravityApiService && typeof adapter.antigravityApiService.getUsageLimits === 'function') {
            const rawUsage = await adapter.antigravityApiService.getUsageLimits();
            return formatAntigravityUsage(rawUsage);
        }
        throw new Error('This adapter does not support usage query');
    }

    if (providerType === 'openai-codex-oauth') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits();
            return formatCodexUsage(rawUsage);
        } else if (adapter.codexApiService && typeof adapter.codexApiService.getUsageLimits === 'function') {
            const rawUsage = await adapter.codexApiService.getUsageLimits();
            return formatCodexUsage(rawUsage);
        }
        throw new Error('This adapter does not support usage query');
    }

    if (providerType === 'grok-custom') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits();
            return formatGrokUsage(rawUsage);
        }
        throw new Error('This adapter does not support usage query');
    }
    
    throw new Error(`Unsupported provider type: ${providerType}`);
}

/**
 * 获取提供商显示名称
 * @param {Object} provider - 提供商配置
 * @param {string} providerType - 提供商类型
 * @returns {string} 显示名称
 */
function getProviderDisplayName(provider, providerType) {
    if (!provider || typeof provider !== 'object') {
        return 'Unnamed';
    }

    // 优先使用自定义名称
    if (provider.customName) {
        return provider.customName;
    }

    if (provider.uuid) {
        return provider.uuid;
    }

    // 尝试从凭据文件路径提取名称
    const credPathKey = {
        'claude-kiro-oauth': 'KIRO_OAUTH_CREDS_FILE_PATH',
        'gemini-cli-oauth': 'GEMINI_OAUTH_CREDS_FILE_PATH',
        'gemini-antigravity': 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH',
        'openai-codex-oauth': 'CODEX_OAUTH_CREDS_FILE_PATH',
        'openai-qwen-oauth': 'QWEN_OAUTH_CREDS_FILE_PATH',
        'openai-iflow': 'IFLOW_TOKEN_FILE_PATH'
    }[providerType];

    if (credPathKey && provider[credPathKey]) {
        const filePath = provider[credPathKey];
        const fileName = path.basename(filePath);
        const dirName = path.basename(path.dirname(filePath));
        return `${dirName}/${fileName}`;
    }

    return 'Unnamed';
}

/**
 * 获取支持用量查询的提供商列表
 */
export async function handleGetSupportedProviders(req, res) {
    try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(supportedProviders));
        return true;
    } catch (error) {
        logger.error('[Usage API] Failed to get supported providers:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to get supported providers: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 获取所有提供商的用量限制
 */
export async function handleGetUsage(req, res, currentConfig, providerPoolManager) {
    try {
        // 解析查询参数，检查是否需要强制刷新
        const url = new URL(req.url, `http://${req.headers.host}`);
        const refresh = url.searchParams.get('refresh') === 'true';
        const usageConcurrency = parsePositiveInt(url.searchParams.get('concurrency'));
        
        let usageResults;
        
        if (!refresh) {
            // 优先读取缓存
            const cachedData = await readUsageCache();
            if (cachedData) {
                logger.debug('[Usage API] Returning cached usage data');
                usageResults = { ...cachedData, fromCache: true };
            }
        }
        
        if (!usageResults) {
            // 缓存不存在或需要刷新，重新查询
            logger.info('[Usage API] Fetching fresh usage data');
            usageResults = await getAllProvidersUsage(currentConfig, providerPoolManager, { usageConcurrency });
            // 写入缓存
            await writeUsageCache(usageResults);
        }
        
        // Always include current server time
        const finalResults = {
            ...usageResults,
            serverTime: new Date().toISOString()
        };
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(finalResults));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to get usage:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to get usage info: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 获取特定提供商类型的用量限制
 */
export async function handleGetProviderUsage(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        // 解析查询参数，检查是否需要强制刷新
        const url = new URL(req.url, `http://${req.headers.host}`);
        const refresh = url.searchParams.get('refresh') === 'true';
        const usageConcurrency = parsePositiveInt(url.searchParams.get('concurrency'));
        
        let usageResults;
        
        if (!refresh) {
            // Prefer reading from cache
            const cachedData = await readProviderUsageCache(providerType);
            if (cachedData) {
                logger.debug(`[Usage API] Returning cached usage data for ${providerType}`);
                usageResults = { ...cachedData, fromCache: true };
            }
        }
        
        if (!usageResults) {
            // Cache does not exist or refresh required, re-query
            logger.info(`[Usage API] Fetching fresh usage data for ${providerType}`);
            usageResults = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager, { usageConcurrency });
            // 更新缓存
            await updateProviderUsageCache(providerType, usageResults);
        }
        
        // Always include current server time
        const finalResults = {
            ...usageResults,
            serverTime: new Date().toISOString()
        };
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(finalResults));
        return true;
    } catch (error) {
        logger.error(`[UI API] Failed to get usage for ${providerType}:`, error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: `Failed to get usage info for ${providerType}: ` + error.message
            }
        }));
        return true;
    }
}

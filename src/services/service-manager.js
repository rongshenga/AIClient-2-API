import { getServiceAdapter, serviceInstances } from '../providers/adapter.js';
import logger from '../utils/logger.js';
import { ProviderPoolManager } from '../providers/provider-pool-manager.js';
import * as fs from 'fs';
import { promises as pfs } from 'fs';
import * as path from 'path';
import { PROVIDER_MAPPINGS } from '../utils/provider-utils.js';
import { MODEL_PROVIDER } from '../utils/common.js';
import {
    getRuntimeStorage,
    linkCredentialFilesWithRuntimeStorage,
    loadProviderPoolsCompatSnapshot
} from '../storage/runtime-storage-registry.js';

// 存储 ProviderPoolManager 实例
let providerPoolManager = null;

/**
 * 扫描 configs 目录并自动关联未关联的配置文件到对应的提供商
 * @param {Object} config - 服务器配置对象
 * @param {Object} options - 可选参数
 * @param {boolean} options.onlyCurrentCred - 为 true 时，只自动关联当前凭证
 * @param {string} options.credPath - 当前凭证的路径（当 onlyCurrentCred 为 true 时必需）
 * @returns {Promise<Object>} 更新后的 providerPools 对象
 */
function getProviderPoolsBaseDir(config = {}) {
    const providerPoolsFilePath = config?.PROVIDER_POOLS_FILE_PATH || path.join(process.cwd(), 'configs', 'provider_pools.json');
    return path.dirname(providerPoolsFilePath);
}

function dedupeCredentialPaths(paths = []) {
    const seenPaths = new Set();
    const normalizedPaths = [];

    for (const rawPath of Array.isArray(paths) ? paths : []) {
        if (typeof rawPath !== 'string' || !rawPath.trim()) {
            continue;
        }

        const normalizedPath = rawPath.trim();
        const dedupeKey = path.isAbsolute(normalizedPath)
            ? path.normalize(normalizedPath)
            : normalizedPath.replace(/\\/g, '/');
        if (seenPaths.has(dedupeKey)) {
            continue;
        }

        seenPaths.add(dedupeKey);
        normalizedPaths.push(normalizedPath);
    }

    return normalizedPaths;
}

async function collectCredentialCandidatePaths(dirPath, result = [], depth = 0) {
    try {
        const entries = await pfs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isFile()) {
                if (path.extname(entry.name).toLowerCase() !== '.json') {
                    continue;
                }

                result.push(path.relative(process.cwd(), fullPath).replace(/\\/g, '/'));
                continue;
            }

            if (!entry.isDirectory() || depth >= 2) {
                continue;
            }

            await collectCredentialCandidatePaths(fullPath, result, depth + 1);
        }
    } catch (error) {
        logger.warn(`[Auto-Link] Failed to scan directory ${dirPath}: ${error.message}`);
    }

    return result;
}

async function buildAutoLinkCredentialPaths(config, options = {}) {
    if (options.onlyCurrentCred && options.credPath) {
        return dedupeCredentialPaths([options.credPath]);
    }

    if (Array.isArray(options.credPaths) && options.credPaths.length > 0) {
        return dedupeCredentialPaths(options.credPaths);
    }

    const providerPoolsBaseDir = getProviderPoolsBaseDir(config);
    const discoveredPaths = [];

    for (const mapping of PROVIDER_MAPPINGS) {
        const configsPath = path.join(providerPoolsBaseDir, mapping.dirName);
        if (!fs.existsSync(configsPath)) {
            continue;
        }

        await collectCredentialCandidatePaths(configsPath, discoveredPaths);
    }

    return dedupeCredentialPaths(discoveredPaths);
}

function syncProviderPoolsSnapshot(config, providerPools = {}) {
    const normalizedProviderPools = providerPools && typeof providerPools === 'object'
        ? providerPools
        : {};

    if (config) {
        config.providerPools = normalizedProviderPools;
    }

    if (providerPoolManager) {
        providerPoolManager.providerPools = normalizedProviderPools;
        providerPoolManager.initializeProviderStatus();
    }

    return normalizedProviderPools;
}

function logAutoLinkSummary(totalNewProviders, allNewProviders = {}) {
    if (totalNewProviders <= 0) {
        logger.info('[Auto-Link] No new configs to link');
        return;
    }

    logger.info(`[Auto-Link] Added ${totalNewProviders} new config(s) through runtime storage:`);
    for (const [displayName, providers] of Object.entries(allNewProviders)) {
        logger.info(`  ${displayName}: ${providers.length} config(s)`);
        for (const provider of providers) {
            const credentialPath = Object.entries(provider || {}).find(([key]) => {
                return key.endsWith('_CREDS_FILE_PATH') || key.endsWith('_TOKEN_FILE_PATH') || key.endsWith('_FILE_PATH');
            })?.[1];

            if (credentialPath) {
                logger.info(`    - ${credentialPath}`);
            }
        }
    }
}

export async function autoLinkProviderConfigs(config, options = {}) {
    const candidatePaths = await buildAutoLinkCredentialPaths(config, options);

    let providerPools = config?.providerPools || {};
    let totalNewProviders = 0;
    let allNewProviders = {};

    if (candidatePaths.length > 0) {
        const linkResult = await linkCredentialFilesWithRuntimeStorage(config, candidatePaths, {
            sourceKind: options.sourceKind || 'service_manager_auto_link',
            providerPools: config?.providerPools || {}
        });

        providerPools = linkResult?.providerPools || await loadProviderPoolsCompatSnapshot(config);
        totalNewProviders = Number(linkResult?.totalNewProviders || 0);
        allNewProviders = linkResult?.allNewProviders || {};
    } else if (config?.RUNTIME_STORAGE_INFO?.backend === 'db') {
        providerPools = await loadProviderPoolsCompatSnapshot(config);
    }

    const normalizedProviderPools = syncProviderPoolsSnapshot(config, providerPools);
    logAutoLinkSummary(totalNewProviders, allNewProviders);
    return normalizedProviderPools;
}
// 注意：isValidOAuthCredentials 已移至 provider-utils.js 公共模块

/**
 * Initialize API services and provider pool manager
 * @param {Object} config - The server configuration
 * @returns {Promise<Object>} The initialized services
 */
export async function initApiService(config, isReady = false) {

    if (config.providerPools && Object.keys(config.providerPools).length > 0) {
        // 避免后续 deep copy 超大 providerPools 对象导致内存爆炸
        const { providerPools: _ignoredProviderPools, ...baseNodeConfig } = config;
        providerPoolManager = new ProviderPoolManager(config.providerPools, {
            globalConfig: config,
            runtimeStorage: config?.runtimeStorage || getRuntimeStorage() || null,
            maxErrorCount: config.MAX_ERROR_COUNT ?? 3,
            providerFallbackChain: config.providerFallbackChain || {},
        });
        logger.info('[Initialization] ProviderPoolManager initialized with configured pools.');

        if(isReady){
            // --- V2: 触发系统预热 ---
            // 预热逻辑是异步的，不会阻塞服务器启动
            providerPoolManager.warmupNodes().catch(err => {
                logger.error(`[Initialization] Warmup failed: ${err.message}`);
            });

            // 检查并刷新即将过期的节点（异步调用，不阻塞启动）
            providerPoolManager.checkAndRefreshExpiringNodes().catch(err => {
                logger.error(`[Initialization] Check and refresh expiring nodes failed: ${err.message}`);
            });
        }

        // 健康检查将在服务器完全启动后执行
    } else {
        logger.info('[Initialization] No provider pools configured. Using single provider mode.');
    }

    // Initialize all provider pool nodes at startup
    // 初始化号池节点（启动期限流预加载），避免超大号池阻塞服务监听
    if (config.providerPools && Object.keys(config.providerPools).length > 0) {
        const parsedPerProviderLimit = Number.parseInt(config.STARTUP_PRELOAD_MAX_PER_PROVIDER, 10);
        const parsedTotalLimit = Number.parseInt(config.STARTUP_PRELOAD_MAX_TOTAL, 10);
        const startupPreloadMaxPerProvider = Number.isFinite(parsedPerProviderLimit)
            ? Math.max(0, parsedPerProviderLimit)
            : 20;
        const startupPreloadMaxTotal = Number.isFinite(parsedTotalLimit)
            ? Math.max(0, parsedTotalLimit)
            : 200;

        logger.info(
            `[Initialization] Startup preload limits: perProvider=${startupPreloadMaxPerProvider}, total=${startupPreloadMaxTotal}`
        );

        let totalInitialized = 0;
        let totalFailed = 0;
        let totalSkippedByLimit = 0;
        let remainingTotalBudget = startupPreloadMaxTotal;
        
        for (const [providerType, providerConfigs] of Object.entries(config.providerPools)) {
            // 验证提供商类型是否在 DEFAULT_MODEL_PROVIDERS 中
            if (config.DEFAULT_MODEL_PROVIDERS && Array.isArray(config.DEFAULT_MODEL_PROVIDERS)) {
                if (!config.DEFAULT_MODEL_PROVIDERS.includes(providerType)) {
                    logger.info(`[Initialization] Skipping provider type '${providerType}' (not in DEFAULT_MODEL_PROVIDERS).`);
                    continue;
                }
            }
            
            if (!Array.isArray(providerConfigs) || providerConfigs.length === 0) {
                continue;
            }

            const enabledProviderConfigs = providerConfigs.filter(cfg => !cfg.isDisabled);
            const providerBudget = Math.max(0, Math.min(startupPreloadMaxPerProvider, remainingTotalBudget));
            const preloadConfigs = providerPoolManager
                ? providerPoolManager.getStartupPreloadCandidates(providerType, enabledProviderConfigs, providerBudget)
                : enabledProviderConfigs.slice(0, providerBudget);
            const providerSkippedByLimit = Math.max(0, enabledProviderConfigs.length - preloadConfigs.length);

            logger.info(
                `[Initialization] Initializing ${preloadConfigs.length}/${enabledProviderConfigs.length} node(s) for provider '${providerType}'...`
            );
            let providerSucceeded = 0;
            let providerFailed = 0;
            let providerSkippedDisabled = 0;
            const failedNodeSamples = [];
            
            // 初始化该提供商类型的所有节点
            for (const providerConfig of preloadConfigs) {
                try {
                    // 合并全局配置和节点配置
                    const nodeConfig = {
                        ...baseNodeConfig,
                        ...providerConfig,
                        MODEL_PROVIDER: providerType
                    };
                    
                    // 初始化服务适配器
                    getServiceAdapter(nodeConfig);
                    totalInitialized++;
                    providerSucceeded++;
                    
                    const identifier = providerConfig.customName || providerConfig.uuid || 'unknown';
                    logger.debug(`[Initialization] ✓ Initialized node: ${identifier} (${providerType})`);
                } catch (error) {
                    totalFailed++;
                    providerFailed++;
                    const identifier = providerConfig.customName || providerConfig.uuid || 'unknown';
                    if (failedNodeSamples.length < 5) {
                        failedNodeSamples.push(identifier);
                    }
                    logger.debug(`[Initialization] ✗ Failed to initialize node ${identifier} (${providerType}): ${error.message}`);
                }
            }

            providerSkippedDisabled = providerConfigs.length - enabledProviderConfigs.length;
            totalSkippedByLimit += providerSkippedByLimit;
            remainingTotalBudget = Math.max(0, remainingTotalBudget - preloadConfigs.length);

            logger.info(
                `[Initialization] Provider '${providerType}' initialization summary: total=${providerConfigs.length}, ` +
                `disabledSkipped=${providerSkippedDisabled}, preloadSkipped=${providerSkippedByLimit}, ` +
                `succeeded=${providerSucceeded}, failed=${providerFailed}`
            );
            if (providerFailed > 0) {
                const sampleText = failedNodeSamples.join(', ');
                logger.warn(
                    `[Initialization] Provider '${providerType}' has ${providerFailed} failed node(s). ` +
                    `Sample: ${sampleText || 'none'}`
                );
            }

            if (providerPoolManager) {
                providerPoolManager.preloadStartupAuthGroups(providerType, enabledProviderConfigs.length);
            }

            if (remainingTotalBudget <= 0) {
                logger.warn(
                    '[Initialization] Startup preload total budget exhausted; remaining nodes will initialize lazily on first use.'
                );
                break;
            }
        }
        
        logger.info(`[Initialization] Provider pool initialization complete: ${totalInitialized} succeeded, ${totalFailed} failed.`);
        if (totalSkippedByLimit > 0) {
            logger.warn(
                `[Initialization] Startup skipped ${totalSkippedByLimit} node(s) due to preload limits; those nodes will initialize lazily.`
            );
        }
    } else {
        logger.info('[Initialization] No provider pools configured. Skipping node initialization.');
    }
    return serviceInstances; // Return the collection of initialized service instances
}

/**
 * [路由解析层] 负责前置处理前缀和 AUTO 模式转换
 * @private
 * @returns {Promise<Object>} { effectiveProvider, actualModelName }
 */
async function _resolveEffectiveRouting(config, requestedModel) {
    let effectiveProvider = config.MODEL_PROVIDER;
    let actualModelName = requestedModel;

    // 1. 处理显式前缀 (无论是否是 AUTO 模式都支持)
    if (requestedModel && requestedModel.includes(':')) {
        const [prefix, ...modelParts] = requestedModel.split(':');
        const modelSuffix = modelParts.join(':');
        // 检查前缀是否是有效的提供商标识
        if (providerPoolManager && (providerPoolManager.providerStatus[prefix] || config.providerPools?.[prefix])) {
            effectiveProvider = prefix;
            actualModelName = modelSuffix;
            logger.info(`[Routing] Prefix resolved: ${prefix}:${modelSuffix}`);
        }
    }

    // 2. 严格性检查：在 AUTO 模式下，如果到这里还没解析出具体提供商，则报错 (除非是列出模型场景)
    if (effectiveProvider === MODEL_PROVIDER.AUTO && requestedModel) {
        throw new Error(`[API Service] Auto-routing failed: Model name must include a provider prefix (e.g., 'provider:model'). Received: '${requestedModel}'`);
    }

    return { effectiveProvider, actualModelName };
}

/**
 * Get API service adapter, considering provider pools
 * @param {Object} config - The current request configuration
 * @param {string} [requestedModel] - Optional. The model name to filter providers by.
 * @param {Object} [options] - Optional. Additional options.
 * @param {boolean} [options.skipUsageCount] - Optional. If true, skip incrementing usage count.
 * @returns {Promise<Object>} The API service adapter
 */
export async function getApiService(config, requestedModel = null, options = {}) {
    // 1. 前置路由解析
    const { effectiveProvider, actualModelName } = await _resolveEffectiveRouting(config, requestedModel);
    config.MODEL_PROVIDER = effectiveProvider;

    // 模型列表特殊场景：AUTO 且无模型名
    if (effectiveProvider === MODEL_PROVIDER.AUTO && !actualModelName) return null;

    let serviceConfig = config;
    if (providerPoolManager && config.providerPools && config.providerPools[config.MODEL_PROVIDER]) {
        // 如果有号池管理器，并且当前模型提供者类型有对应的号池，则从号池中选择一个提供者配置
        // selectProvider 现在是异步的，使用链式锁确保并发安全
        const selectedProviderConfig = await providerPoolManager.selectProvider(config.MODEL_PROVIDER, actualModelName, { ...options, skipUsageCount: true });
        if (selectedProviderConfig) {
            // 合并选中的提供者配置到当前请求的 config 中
            const { providerPools: _ignoredProviderPools, ...baseConfig } = config;
            serviceConfig = { ...baseConfig, ...selectedProviderConfig };
            config.uuid = serviceConfig.uuid;
            config.customName = serviceConfig.customName;
            const customNameDisplay = serviceConfig.customName ? ` (${serviceConfig.customName})` : '';
            logger.info(`[API Service] Using pooled configuration for ${config.MODEL_PROVIDER}: ${serviceConfig.uuid}${customNameDisplay}${actualModelName ? ` (model: ${actualModelName})` : ''}`);
        } else {
            const errorMsg = `[API Service] No healthy provider found in pool for ${config.MODEL_PROVIDER}${actualModelName ? ` supporting model: ${actualModelName}` : ''}`;
            logger.error(errorMsg);
            throw new Error(errorMsg);
        }
    } else if (effectiveProvider === MODEL_PROVIDER.AUTO && actualModelName) {
        // 如果在 AUTO 模式下依然没能解析出具体提供商，则报错
        throw new Error(`[API Service] Auto-routing failed: Model name must include a provider prefix (e.g., 'provider:model'). Received: '${actualModelName}'`);
    }
    return getServiceAdapter(serviceConfig);
}

/**
 * Get API service adapter with fallback support and return detailed result
 * @param {Object} config - The current request configuration
 * @param {string} [requestedModel] - Optional. The model name to filter providers by.
 * @param {Object} [options] - Optional. Additional options.
 * @returns {Promise<Object>} Object containing service adapter and metadata
 */
export async function getApiServiceWithFallback(config, requestedModel = null, options = {}) {
    // 1. 前置路由解析
    const { effectiveProvider, actualModelName } = await _resolveEffectiveRouting(config, requestedModel);
    config.MODEL_PROVIDER = effectiveProvider;

    // 模型列表特殊场景：AUTO 且无模型名
    if (effectiveProvider === MODEL_PROVIDER.AUTO && !actualModelName) {
        return { service: null, serviceConfig: config, actualProviderType: effectiveProvider, isFallback: false, uuid: null, actualModel: null };
    }

    let serviceConfig = config;
    let actualProviderType = config.MODEL_PROVIDER;
    let isFallback = false;
    let selectedUuid = null;
    let actualModel = actualModelName;
    
    if (providerPoolManager && config.providerPools && config.providerPools[config.MODEL_PROVIDER]) {
        // selectProviderWithFallback 现在是异步的，使用链式锁确保并发安全
        // 如果开启了并发限制，则使用 acquireSlot 进行选择和占位
        const useAcquire = options.acquireSlot === true;
        let selectedResult;
        
        if (useAcquire) {
             // 我们需要一个支持 Fallback 的 acquireSlot
             selectedResult = await providerPoolManager.acquireSlotWithFallback(
                config.MODEL_PROVIDER,
                actualModelName,
                options
            );
        } else {
            selectedResult = await providerPoolManager.selectProviderWithFallback(
                config.MODEL_PROVIDER,
                actualModelName,
                { ...options, skipUsageCount: true }
            );
        }
        
        if (selectedResult) {
            const { config: selectedProviderConfig, actualProviderType: selectedType, isFallback: fallbackUsed, actualModel: fallbackModel } = selectedResult;
            
            // 合并选中的提供者配置到当前请求的 config 中
            const { providerPools: _ignoredProviderPools, ...baseConfig } = config;
            serviceConfig = { ...baseConfig, ...selectedProviderConfig };
            
            actualProviderType = selectedType;
            isFallback = fallbackUsed;
            selectedUuid = selectedProviderConfig.uuid;
            actualModel = fallbackModel || actualModelName;
            
            // 如果发生了 fallback，需要更新 MODEL_PROVIDER
            if (isFallback) {
                serviceConfig.MODEL_PROVIDER = actualProviderType;
            }
        } else {
            const errorMsg = `[API Service] No healthy provider found in pool (including fallback) for ${config.MODEL_PROVIDER}${actualModelName ? ` supporting model: ${actualModelName}` : ''}`;
            logger.error(errorMsg);
            throw new Error(errorMsg);
        }
    } else if (effectiveProvider === MODEL_PROVIDER.AUTO && actualModelName) {
        // 如果在 AUTO 模式下依然没能解析出具体提供商，则报错
        throw new Error(`[API Service] Auto-routing failed: Model name must include a provider prefix (e.g., 'provider:model'). Received: '${actualModelName}'`);
    }
    
    const service = getServiceAdapter(serviceConfig);
    
    return {
        service,
        serviceConfig,
        actualProviderType,
        isFallback,
        uuid: selectedUuid,
        actualModel
    };
}

/**
 * Get the provider pool manager instance
 * @returns {Object} The provider pool manager
 */
export function getProviderPoolManager() {
    return providerPoolManager;
}

/**
 * Mark provider as unhealthy
 * @param {string} provider - The model provider
 * @param {Object} providerInfo - Provider information including uuid
 */
export function markProviderUnhealthy(provider, providerInfo) {
    if (providerPoolManager) {
        providerPoolManager.markProviderUnhealthy(provider, providerInfo);
    }
}

/**
 * Get providers status
 * @param {Object} config - The current request configuration
 * @param {Object} [options] - Optional. Additional options.
 * @param {boolean} [options.provider] - Optional.provider filter by provider type
 * @param {boolean} [options.customName] - Optional.customName filter by customName
 * @returns {Promise<Object>} The API service adapter
 */
export async function getProviderStatus(config, options = {}) {
    let providerPools = {};

    try {
        if (config?.RUNTIME_STORAGE_INFO?.backend !== 'db' && providerPoolManager && providerPoolManager.providerPools) {
            providerPools = providerPoolManager.providerPools;
        } else {
            providerPools = await loadProviderPoolsCompatSnapshot(config);
            if (Object.keys(providerPools).length === 0 && providerPoolManager?.providerPools) {
                providerPools = providerPoolManager.providerPools;
            } else if (Object.keys(providerPools).length === 0 && config?.providerPools) {
                providerPools = config.providerPools;
            }
        }
    } catch (error) {
        logger.warn('[API Service] Failed to load provider pools:', error.message);
    }

    // providerPoolsSlim 只保留顶级 key 及部分字段，过滤 isDisabled 为 true 的元素
    const slimFields = [
        'customName',
        'isHealthy',
        'lastErrorTime',
        'lastErrorMessage'
    ];
    // identify 字段映射表
    const identifyFieldMap = {
        'openai-custom': 'OPENAI_BASE_URL',
        'openaiResponses-custom': 'OPENAI_BASE_URL',
        'gemini-cli-oauth': 'GEMINI_OAUTH_CREDS_FILE_PATH',
        'claude-custom': 'CLAUDE_BASE_URL',
        'claude-kiro-oauth': 'KIRO_OAUTH_CREDS_FILE_PATH',
        'openai-qwen-oauth': 'QWEN_OAUTH_CREDS_FILE_PATH',
        'gemini-antigravity': 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH',
        'openai-iflow': 'IFLOW_TOKEN_FILE_PATH',
        'forward-api': 'FORWARD_BASE_URL',
        'grok-custom': 'GROK_COOKIE_TOKEN'
    };
    let providerPoolsSlim = [];
    let unhealthyProvideIdentifyList = [];
    let count = 0;
    let unhealthyCount = 0;
    let unhealthyRatio = 0;
    const filterProvider = options && options.provider;
    const filterCustomName = options && options.customName;
    for (const key of Object.keys(providerPools)) {
        if (!Array.isArray(providerPools[key])) continue;
        if (filterProvider && key !== filterProvider) continue;
        const identifyField = identifyFieldMap[key] || null;
        const slimArr = providerPools[key]
            .filter(item => {
                if (item.isDisabled) return false;
                if (filterCustomName && item.customName !== filterCustomName) return false;
                return true;
            })
            .map(item => {
                const slim = {};
                for (const f of slimFields) {
                    slim[f] = item.hasOwnProperty(f) ? item[f] : null;
                }
                // identify 字段
                if (identifyField && item.hasOwnProperty(identifyField)) {
                    let tmpCustomName = item.customName ? `${item.customName}` : 'NoCustomName';
                    let identifyStr = `${tmpCustomName}::${key}::${item[identifyField]}`;
                    slim.identify = identifyStr;
                } else {
                    slim.identify = null;
                }
                slim.provider = key;
                // 统计
                count++;
                if (slim.isHealthy === false) {
                    unhealthyCount++;
                    if (slim.identify) unhealthyProvideIdentifyList.push(slim.identify);
                }
                return slim;
            });
        providerPoolsSlim.push(...slimArr);
    }
    if (count > 0) {
        unhealthyRatio = Number((unhealthyCount / count).toFixed(2));
    }
        let unhealthySummeryMessage = unhealthyProvideIdentifyList.join('\n');
        if (unhealthySummeryMessage === '') unhealthySummeryMessage = null;
    return {
        providerPoolsSlim,
        unhealthySummeryMessage,
        count,
        unhealthyCount,
        unhealthyRatio
    };
}

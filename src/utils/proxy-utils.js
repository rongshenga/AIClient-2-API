/**
 * 代理工具模块
 * 支持 HTTP、HTTPS 和 SOCKS5 代理
 */

import { HttpsProxyAgent } from 'https-proxy-agent';
import logger from './logger.js';
import { HttpProxyAgent } from 'http-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

// 记录每个 provider 最近一次打印过的代理签名，避免高频重复日志
const proxyLogSignatureByProvider = new Map();
// 按代理 URL 缓存解析结果，避免重复创建 agent
const proxyConfigCacheByUrl = new Map();

/**
 * 解析代理URL并返回相应的代理配置
 * @param {string} proxyUrl - 代理URL，如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080
 * @returns {Object|null} 代理配置对象，包含 httpAgent 和 httpsAgent
 */
export function parseProxyUrl(proxyUrl) {
    if (!proxyUrl || typeof proxyUrl !== 'string') {
        return null;
    }

    const trimmedUrl = proxyUrl.trim();
    if (!trimmedUrl) {
        return null;
    }

    const cachedProxyConfig = proxyConfigCacheByUrl.get(trimmedUrl);
    if (cachedProxyConfig) {
        return cachedProxyConfig;
    }

    try {
        const url = new URL(trimmedUrl);
        const protocol = url.protocol.toLowerCase();

        if (protocol === 'socks5:' || protocol === 'socks4:' || protocol === 'socks:') {
            // SOCKS 代理
            const socksAgent = new SocksProxyAgent(trimmedUrl);
            const proxyConfig = {
                httpAgent: socksAgent,
                httpsAgent: socksAgent,
                proxyType: 'socks'
            };
            proxyConfigCacheByUrl.set(trimmedUrl, proxyConfig);
            return proxyConfig;
        } else if (protocol === 'http:' || protocol === 'https:') {
            // HTTP/HTTPS 代理
            const proxyConfig = {
                httpAgent: new HttpProxyAgent(trimmedUrl),
                httpsAgent: new HttpsProxyAgent(trimmedUrl),
                proxyType: 'http'
            };
            proxyConfigCacheByUrl.set(trimmedUrl, proxyConfig);
            return proxyConfig;
        } else {
            logger.warn(`[Proxy] Unsupported proxy protocol: ${protocol}`);
            return null;
        }
    } catch (error) {
        logger.error(`[Proxy] Failed to parse proxy URL: ${error.message}`);
        return null;
    }
}

/**
 * 检查指定的提供商是否启用了代理
 * @param {Object} config - 配置对象
 * @param {string} providerType - 提供商类型
 * @returns {boolean} 是否启用代理
 */
export function isProxyEnabledForProvider(config, providerType) {
    if (!config || !config.PROXY_URL || !config.PROXY_ENABLED_PROVIDERS) {
        return false;
    }

    const enabledProviders = config.PROXY_ENABLED_PROVIDERS;
    if (!Array.isArray(enabledProviders)) {
        return false;
    }

    return enabledProviders.includes(providerType);
}

/**
 * 获取指定提供商的代理配置
 * @param {Object} config - 配置对象
 * @param {string} providerType - 提供商类型
 * @returns {Object|null} 代理配置对象或 null
 */
export function getProxyConfigForProvider(config, providerType) {
    if (!isProxyEnabledForProvider(config, providerType)) {
        proxyLogSignatureByProvider.delete(providerType);
        return null;
    }

    const normalizedProxyUrl = typeof config.PROXY_URL === 'string' ? config.PROXY_URL.trim() : config.PROXY_URL;
    const proxyConfig = parseProxyUrl(normalizedProxyUrl);
    if (proxyConfig) {
        const nextSignature = `${proxyConfig.proxyType}|${normalizedProxyUrl}`;
        const prevSignature = proxyLogSignatureByProvider.get(providerType);
        if (prevSignature !== nextSignature) {
            logger.info(`[Proxy] Using ${proxyConfig.proxyType} proxy for ${providerType}: ${normalizedProxyUrl}`);
            proxyLogSignatureByProvider.set(providerType, nextSignature);
        }
    }
    return proxyConfig;
}

/**
 * 为 axios 配置代理
 * @param {Object} axiosConfig - axios 配置对象
 * @param {Object} config - 应用配置对象
 * @param {string} providerType - 提供商类型
 * @returns {Object} 更新后的 axios 配置
 */
export function configureAxiosProxy(axiosConfig, config, providerType) {
    const proxyConfig = getProxyConfigForProvider(config, providerType);

    if (proxyConfig) {
        // 使用代理 agent
        axiosConfig.httpAgent = proxyConfig.httpAgent;
        axiosConfig.httpsAgent = proxyConfig.httpsAgent;
        // 禁用 axios 内置的代理配置，使用我们的 agent
        axiosConfig.proxy = false;
    }

    return axiosConfig;
}

/**
 * 为 google-auth-library 配置代理
 * @param {Object} config - 应用配置对象
 * @param {string} providerType - 提供商类型
 * @returns {Object|null} transporter 配置对象或 null
 */
export function getGoogleAuthProxyConfig(config, providerType) {
    const proxyConfig = getProxyConfigForProvider(config, providerType);

    if (proxyConfig) {
        return {
            agent: proxyConfig.httpsAgent
        };
    }

    return null;
}

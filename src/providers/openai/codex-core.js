import axios from 'axios';
import logger from '../../utils/logger.js';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { refreshCodexTokensWithRetry } from '../../auth/oauth-handlers.js';
import { getProviderPoolManager } from '../../services/service-manager.js';
import { MODEL_PROVIDER, formatExpiryLog } from '../../utils/common.js';
import { getProxyConfigForProvider } from '../../utils/proxy-utils.js';

/**
 * Codex API 服务类
 */
export class CodexApiService {
    constructor(config) {
        this.config = config;
        this.baseUrl = config.CODEX_BASE_URL || 'https://chatgpt.com/backend-api/codex';
        this.accessToken = null;
        this.refreshToken = null;
        this.accountId = null;
        this.email = null;
        this.expiresAt = null;
        this.idToken = null;
        this.credsPath = null; // 记录本次加载/使用的凭据文件路径，确保刷新后写回同一文件
        this.uuid = config.uuid; // 保存 uuid 用于号池管理
        this.isInitialized = false;

        // 会话缓存管理
        this.conversationCache = new Map(); // key: model-userId, value: {id, expire}
        this.startCacheCleanup();
    }

    /**
     * 初始化服务（加载凭据）
     */
    async initialize() {
        if (this.isInitialized) return;
        logger.debug('[Codex] Initializing Codex API Service...');
        // 注意：V2 读写分离架构下，初始化不再执行同步认证/刷新逻辑
        // 仅执行基础的凭证加载
        await this.loadCredentials();

        this.isInitialized = true;
        logger.debug(`[Codex] Initialization complete. Account: ${this.email || 'unknown'}`);
    }

    /**
     * 加载凭证信息（不执行刷新）
     */
    async loadCredentials() {
        const email = this.config.CODEX_EMAIL || 'default';

        try {
            let creds;
            let credsPath;

            // 如果指定了具体路径，直接读取
            if (this.config.CODEX_OAUTH_CREDS_FILE_PATH) {
                credsPath = this.config.CODEX_OAUTH_CREDS_FILE_PATH;
                const exists = await this.fileExists(credsPath);
                if (!exists) {
                    throw new Error('Codex credentials not found. Please authenticate first using OAuth.');
                }
                creds = JSON.parse(await fs.readFile(credsPath, 'utf8'));
            } else {
                // 从 configs/codex 目录扫描加载
                const projectDir = process.cwd();
                const targetDir = path.join(projectDir, 'configs', 'codex');
                const files = await fs.readdir(targetDir);
                const matchingFile = files
                    .filter(f => f.includes(`codex-${email}`) && f.endsWith('.json'))
                    .sort()
                    .pop(); // 获取最新的文件

                if (!matchingFile) {
                    throw new Error('Codex credentials not found. Please authenticate first using OAuth.');
                }

                credsPath = path.join(targetDir, matchingFile);
                creds = JSON.parse(await fs.readFile(credsPath, 'utf8'));
            }

            // 记录凭据路径，确保 refresh 时写回同一文件。
            this.credsPath = credsPath;

            this.idToken = creds.id_token || this.idToken;
            this.accessToken = creds.access_token;
            this.refreshToken = creds.refresh_token;
            this.accountId = creds.account_id;
            this.email = creds.email;
            this.expiresAt = new Date(creds.expired); // 注意：字段名是 expired

            // 检查 token 是否需要刷新
            if (this.isExpiryDateNear()) {
                logger.debug('[Codex] Token expiring soon, refreshing...');
                await this.refreshAccessToken();
            }

            this.isInitialized = true;
            logger.debug(`[Codex] Initialized with account: ${this.email}`);
        } catch (error) {
            logger.warn(`[Codex Auth] Failed to load credentials: ${error.message}`);
        }
    }

    /**
     * 初始化认证并执行必要刷新
     */
    async initializeAuth(forceRefresh = false) {
        // 首先执行基础凭证加载
        await this.loadCredentials();

        // 检查 token 是否需要刷新
        const needsRefresh = forceRefresh;

        if (this.accessToken && !needsRefresh) {
            return;
        }

        // 只有在明确要求刷新，或者 AccessToken 缺失时，才执行刷新
        if (needsRefresh || !this.accessToken) {
            if (!this.refreshToken) {
                throw new Error('Codex credentials not found. Please authenticate first using OAuth.');
            }
            logger.debug('[Codex] Token expiring soon or refresh requested, refreshing...');
            await this.refreshAccessToken();
        }
    }

    /**
     * 生成内容（非流式）
     */
    async generateContent(model, requestBody) {
        if (!this.isInitialized) {
            await this.initialize();
        }

        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        // 检查 token 是否即将过期，如果是则推送到刷新队列
        if (this.isExpiryDateNear()) {
            const poolManager = getProviderPoolManager();
            if (poolManager && this.uuid) {
                logger.info(`[Codex] Token is near expiry, marking credential ${this.uuid} for refresh`);
                poolManager.markProviderNeedRefresh(MODEL_PROVIDER.CODEX_API, {
                    uuid: this.uuid
                });
            }
        }

        const url = `${this.baseUrl}/responses`;
        const body = this.prepareRequestBody(model, requestBody, true);
        const headers = this.buildHeaders(body.prompt_cache_key, true);

        try {
            const config = {
                headers,
                responseType: 'text', // 确保以文本形式接收 SSE 流
                timeout: 120000 // 2 分钟超时
            };

            // 配置代理
            const proxyConfig = getProxyConfigForProvider(this.config, 'openai-codex-oauth');
            if (proxyConfig) {
                config.httpAgent = proxyConfig.httpAgent;
                config.httpsAgent = proxyConfig.httpsAgent;
            }

            const response = await axios.post(url, body, config);

            return this.parseNonStreamResponse(response.data);
        } catch (error) {
            if (error.response?.status === 429) {
                await this._handle429Cooldown(error, 'non-stream');
            }
            if (error.response?.status === 401) {
                logger.info('[Codex] Received 401. Triggering background refresh via PoolManager...');

                // 标记当前凭证为不健康（会自动进入刷新队列）
                const poolManager = getProviderPoolManager();
                if (poolManager && this.uuid) {
                    logger.info(`[Codex] Marking credential ${this.uuid} as needs refresh. Reason: 401 Unauthorized`);
                    poolManager.markProviderNeedRefresh(MODEL_PROVIDER.CODEX_API, {
                        uuid: this.uuid
                    });
                    error.credentialMarkedUnhealthy = true;
                }

                // Mark error for credential switch without recording error count
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            } else {
                await this.logUpstreamRequestError('non-stream', error, { url, model, body, headers });
                throw error;
            }
        }
    }

    /**
     * 流式生成内容
     */
    async *generateContentStream(model, requestBody) {
        if (!this.isInitialized) {
            await this.initialize();
        }

        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        // 检查 token 是否即将过期，如果是则推送到刷新队列
        if (this.isExpiryDateNear()) {
            const poolManager = getProviderPoolManager();
            if (poolManager && this.uuid) {
                logger.info(`[Codex] Token is near expiry, marking credential ${this.uuid} for refresh`);
                poolManager.markProviderNeedRefresh(MODEL_PROVIDER.CODEX_API, {
                    uuid: this.uuid
                });
            }
        }

        const url = `${this.baseUrl}/responses`;
        const body = this.prepareRequestBody(model, requestBody, true);
        const headers = this.buildHeaders(body.prompt_cache_key, true);

        try {
            const config = {
                headers,
                responseType: 'stream',
                timeout: 120000
            };

            // 配置代理
            const proxyConfig = getProxyConfigForProvider(this.config, 'openai-codex-oauth');
            if (proxyConfig) {
                config.httpAgent = proxyConfig.httpAgent;
                config.httpsAgent = proxyConfig.httpsAgent;
            }

            const response = await axios.post(url, body, config);

            yield* this.parseSSEStream(response.data);
        } catch (error) {
            if (error.response?.status === 429) {
                await this._handle429Cooldown(error, 'stream');
            }
            if (error.response?.status === 401) {
                logger.info('[Codex] Received 401 during stream. Triggering background refresh via PoolManager...');

                // 标记当前凭证为不健康
                const poolManager = getProviderPoolManager();
                if (poolManager && this.uuid) {
                    logger.info(`[Codex] Marking credential ${this.uuid} as needs refresh. Reason: 401 Unauthorized in stream`);
                    poolManager.markProviderNeedRefresh(MODEL_PROVIDER.CODEX_API, {
                        uuid: this.uuid
                    });
                    error.credentialMarkedUnhealthy = true;
                }

                // Mark error for credential switch without recording error count
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            } else {
                await this.logUpstreamRequestError('streaming', error, { url, model, body, headers });
                throw error;
            }
        }
    }

    _getProvider429QuotaCooldownMs() {
        const rawCooldownMs = this.config?.PROVIDER_429_QUOTA_COOLDOWN_MS;
        const parsedCooldownMs = Number.parseInt(rawCooldownMs, 10);
        if (Number.isFinite(parsedCooldownMs)) {
            // 允许配置 1 分钟 ~ 30 天，避免误配导致无限冷却或疯狂重试
            return Math.max(60_000, Math.min(parsedCooldownMs, 30 * 24 * 60 * 60 * 1000));
        }
        // 默认：6 小时；适合“额度用光/充值后恢复”的冷却探测
        return 6 * 60 * 60 * 1000;
    }

    _getProvider429RateLimitCooldownMs() {
        const rawCooldownMs = this.config?.PROVIDER_429_RATE_LIMIT_COOLDOWN_MS;
        const parsedCooldownMs = Number.parseInt(rawCooldownMs, 10);
        if (Number.isFinite(parsedCooldownMs)) {
            // 允许配置 1 秒 ~ 10 分钟
            return Math.max(1_000, Math.min(parsedCooldownMs, 10 * 60 * 1000));
        }
        // 默认：30 秒（避免短期 429 直接把节点打成长期不可用）
        return 30_000;
    }

    _classify429Type(bodyText = '', fallbackMessage = '') {
        const merged = `${String(bodyText || '')}\n${String(fallbackMessage || '')}`.toLowerCase();
        if (!merged.trim()) {
            return { isQuotaExhausted: false, isRateLimited: false };
        }

        let isQuotaExhausted = false;
        let isRateLimited = false;

        // OpenAI 常见字段/码：insufficient_quota
        if (merged.includes('insufficient_quota')) {
            isQuotaExhausted = true;
        }

        // 兼容一些变体：quota_exceeded / quota exceeded
        if (merged.includes('quota_exceeded') || merged.includes('quota exceeded')) {
            isQuotaExhausted = true;
        }

        // 更宽松的语义匹配：出现 quota 且伴随 credits/billing/plan/exceeded 等关键字
        if (!isQuotaExhausted && merged.includes('quota')) {
            const keywords = ['credit', 'billing', 'plan', 'exceed', 'exceeded', 'limit', 'payment'];
            if (keywords.some((keyword) => merged.includes(keyword))) {
                isQuotaExhausted = true;
            }
        }

        isRateLimited = (
            merged.includes('rate limit')
            || merged.includes('ratelimit')
            || merged.includes('too many requests')
            || merged.includes('slow_down')
            || merged.includes('slow down')
        );

        return { isQuotaExhausted, isRateLimited };
    }

    _looksLikeQuotaExhausted429(bodyText = '', fallbackMessage = '') {
        return this._classify429Type(bodyText, fallbackMessage).isQuotaExhausted;
    }

    _looksLikeRateLimit429(bodyText = '', fallbackMessage = '') {
        return this._classify429Type(bodyText, fallbackMessage).isRateLimited;
    }

    _parseRetryAfterMs(headers = {}) {
        if (!headers || typeof headers !== 'object') {
            return null;
        }

        const raw = headers['retry-after'] || headers['Retry-After'] || null;
        if (!raw) {
            return null;
        }

        const asNumber = Number.parseFloat(String(raw));
        if (Number.isFinite(asNumber)) {
            // retry-after 以秒为单位
            return Math.max(0, Math.floor(asNumber * 1000));
        }

        // 也可能是 HTTP-date
        const asDate = new Date(String(raw));
        if (!Number.isNaN(asDate.getTime())) {
            return Math.max(0, asDate.getTime() - Date.now());
        }

        return null;
    }

    _parseTimeValue(value, { numericMode = 'epoch_or_seconds', preferDateFirst = false } = {}) {
        const parseNumber = (numeric) => {
            if (!Number.isFinite(numeric)) {
                return null;
            }

            if (numericMode === 'milliseconds') {
                return Math.max(0, Math.floor(numeric));
            }

            if (numericMode === 'seconds') {
                return Math.max(0, Math.floor(numeric * 1000));
            }

            // epoch_or_seconds：尝试识别 epoch（秒/毫秒），否则按“秒”处理
            if (numeric > 1e12) {
                return Math.max(0, Math.floor(numeric - Date.now()));
            }
            if (numeric > 1e9) {
                return Math.max(0, Math.floor(numeric * 1000 - Date.now()));
            }
            return Math.max(0, Math.floor(numeric * 1000));
        };

        if (value === undefined || value === null) {
            return null;
        }

        if (typeof value === 'number') {
            return parseNumber(value);
        }

        const text = String(value).trim();
        if (!text) {
            return null;
        }

        // 纯数字
        if (/^-?\d+(?:\.\d+)?$/.test(text)) {
            const numeric = Number.parseFloat(text);
            return parseNumber(numeric);
        }

        // 特定上下文（例如 *_at / until / expires）优先尝试日期解析
        if (preferDateFirst) {
            const asDate = new Date(text);
            if (!Number.isNaN(asDate.getTime())) {
                return Math.max(0, asDate.getTime() - Date.now());
            }
        }

        // Go duration / OpenAI rate limit reset 常见格式：1s / 6m0s / 200ms / 1h2m3s
        const durationRegex = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
        let match;
        let totalMs = 0;
        let matched = false;
        while ((match = durationRegex.exec(text)) !== null) {
            matched = true;
            const amount = Number.parseFloat(match[1]);
            if (!Number.isFinite(amount)) {
                continue;
            }
            const unit = match[2];
            const factor = unit === 'ms'
                ? 1
                : unit === 's'
                    ? 1000
                    : unit === 'm'
                        ? 60_000
                        : unit === 'h'
                            ? 3_600_000
                            : 86_400_000;
            totalMs += amount * factor;
        }
        if (matched) {
            return Math.max(0, Math.floor(totalMs));
        }

        // HTTP-date / ISO timestamp
        if (!preferDateFirst) {
            const asDate = new Date(text);
            if (!Number.isNaN(asDate.getTime())) {
                return Math.max(0, asDate.getTime() - Date.now());
            }
        }

        return null;
    }

    _parseDurationOrDateMs(value) {
        return this._parseTimeValue(value, { numericMode: 'epoch_or_seconds' });
    }

    _pushCooldownCandidate(candidates, ms, source) {
        if (!Array.isArray(candidates)) {
            return;
        }
        if (!Number.isFinite(ms) || ms === null || ms === undefined) {
            return;
        }
        const normalized = Math.max(0, Math.floor(ms));
        candidates.push({ ms: normalized, source });
    }

    _pickMaxCooldownCandidate(candidates) {
        if (!Array.isArray(candidates) || candidates.length === 0) {
            return null;
        }
        return candidates.reduce((best, current) => current.ms > best.ms ? current : best, candidates[0]);
    }

    _extract429CooldownFromHeaders(headers = {}) {
        if (!headers || typeof headers !== 'object') {
            return null;
        }

        const candidates = [];

        const retryAfterMs = this._parseRetryAfterMs(headers);
        if (retryAfterMs !== null) {
            this._pushCooldownCandidate(candidates, retryAfterMs, 'header.retry-after');
        }

        const headerEntries = Object.entries(headers);
        for (const [rawKey, rawValue] of headerEntries) {
            const key = String(rawKey || '').toLowerCase();
            if (!key) {
                continue;
            }

            // IETF RateLimit headers / OpenAI 私有头：ratelimit-reset / x-ratelimit-reset-*
            const isResetHeader = key === 'ratelimit-reset'
                || key === 'x-ratelimit-reset'
                || key.startsWith('x-ratelimit-reset-');
            if (!isResetHeader) {
                continue;
            }

            const parsedMs = this._parseDurationOrDateMs(rawValue);
            if (parsedMs !== null) {
                this._pushCooldownCandidate(candidates, parsedMs, `header.${key}`);
            }
        }

        return this._pickMaxCooldownCandidate(candidates);
    }

    _pick429DiagnosticsHeaders(headers = {}) {
        if (!headers || typeof headers !== 'object') {
            return {};
        }

        const picked = {};
        const entries = Object.entries(headers);
        for (const [rawKey, rawValue] of entries) {
            const key = String(rawKey || '');
            const keyLower = key.toLowerCase();

            const shouldInclude = keyLower === 'retry-after'
                || keyLower === 'ratelimit-reset'
                || keyLower === 'x-ratelimit-reset'
                || keyLower.startsWith('x-ratelimit-')
                || keyLower.startsWith('ratelimit-')
                || keyLower === 'x-request-id'
                || keyLower === 'request-id'
                || keyLower === 'content-type';

            if (!shouldInclude) {
                continue;
            }

            picked[keyLower] = rawValue;
        }

        return picked;
    }

    _parseCooldownMsFromText(text = '') {
        const raw = String(text || '');
        if (!raw.trim()) {
            return null;
        }

        const patterns = [
            /(?:try again in|please try again in)\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hours?|d|days?)\b/i,
            /(?:retry(?:\s*after)?|retry-after)\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hours?|d|days?)\b/i,
            /(?:please wait|wait)\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hours?|d|days?)\b/i
        ];

        for (const pattern of patterns) {
            const match = raw.match(pattern);
            if (!match) continue;

            const amount = Number.parseFloat(match[1]);
            if (!Number.isFinite(amount)) continue;

            const unit = match[2].toLowerCase();
            const factor = unit.startsWith('ms')
                ? 1
                : unit.startsWith('s')
                    ? 1000
                    : unit.startsWith('m')
                        ? 60_000
                        : unit.startsWith('h')
                            ? 3_600_000
                            : 86_400_000;
            return Math.max(0, Math.floor(amount * factor));
        }

        // 兼容 "try again in 6m0s" 这种 Go duration 的写法
        const durationMatch = raw.match(/(?:try again in|please try again in|retry(?:\s*after)?)\s*(\d+(?:\.\d+)?(?:ms|s|m|h|d)(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))*)/i);
        if (durationMatch?.[1]) {
            const parsed = this._parseDurationOrDateMs(durationMatch[1]);
            if (parsed !== null) {
                return parsed;
            }
        }

        return null;
    }

    _parseCooldownMsFromKeyValue(key = '', value) {
        const normalizedKey = String(key || '').toLowerCase();
        if (!normalizedKey) {
            return null;
        }

        if (value === undefined || value === null) {
            return null;
        }

        const treatAsMilliseconds = normalizedKey.includes('ms');
        const looksLikeAbsoluteTime = normalizedKey.includes('reset_at')
            || normalizedKey.includes('retry_at')
            || normalizedKey.includes('available_at')
            || normalizedKey.includes('next_allowed')
            || normalizedKey.endsWith('_at')
            || normalizedKey.includes('until')
            || normalizedKey.includes('expires');

        const numericMode = treatAsMilliseconds
            ? 'milliseconds'
            : (looksLikeAbsoluteTime ? 'epoch_or_seconds' : 'seconds');

        return this._parseTimeValue(value, { numericMode, preferDateFirst: looksLikeAbsoluteTime });
    }

    _extract429CooldownFromBody(responseData, bodyText = '', fallbackMessage = '') {
        const candidates = [];

        const parseJsonStringIfPossible = (text) => {
            const trimmed = String(text || '').trim();
            if (!trimmed) return null;
            if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
            try {
                return JSON.parse(trimmed);
            } catch {
                return null;
            }
        };

        const root = (() => {
            if (responseData && typeof responseData === 'object' && !Buffer.isBuffer(responseData)) {
                return responseData;
            }
            if (typeof responseData === 'string') {
                return parseJsonStringIfPossible(responseData);
            }
            return parseJsonStringIfPossible(bodyText);
        })();

        const visited = new WeakSet();
        const walk = (node, depth = 0) => {
            if (!node || depth > 6) return;
            if (typeof node !== 'object') return;

            if (visited.has(node)) return;
            visited.add(node);

            if (Array.isArray(node)) {
                // 限制遍历长度，避免极端响应导致过度开销
                const slice = node.slice(0, 50);
                for (const item of slice) {
                    walk(item, depth + 1);
                }
                return;
            }

            for (const [rawKey, rawValue] of Object.entries(node)) {
                const key = String(rawKey || '');
                const keyLower = key.toLowerCase();

                const keyHints = ['retry', 'reset', 'cooldown', 'wait', 'available', 'next', 'until', 'expires'];
                if (keyHints.some((hint) => keyLower.includes(hint))) {
                    const parsed = this._parseCooldownMsFromKeyValue(keyLower, rawValue);
                    if (parsed !== null) {
                        this._pushCooldownCandidate(candidates, parsed, `body.${keyLower}`);
                    }
                }

                if (typeof rawValue === 'string' && keyLower.includes('message')) {
                    const parsedFromMessage = this._parseCooldownMsFromText(rawValue);
                    if (parsedFromMessage !== null) {
                        this._pushCooldownCandidate(candidates, parsedFromMessage, 'body.message');
                    }
                }

                walk(rawValue, depth + 1);
            }
        };

        if (root) {
            walk(root, 0);
        }

        const combinedText = `${String(bodyText || '')}\n${String(fallbackMessage || '')}`;
        const fromText = this._parseCooldownMsFromText(combinedText);
        if (fromText !== null) {
            this._pushCooldownCandidate(candidates, fromText, 'body.text');
        }

        return this._pickMaxCooldownCandidate(candidates);
    }

    async _handle429Cooldown(error, context = 'unknown') {
        try {
            const bodyText = await this.readUpstreamErrorBody(error.response?.data, 8000);
            const headerCooldown = this._extract429CooldownFromHeaders(error.response?.headers);
            const bodyCooldown = this._extract429CooldownFromBody(error.response?.data, bodyText, error.message);
            const upstreamCooldown = (() => {
                if (headerCooldown && bodyCooldown) {
                    return headerCooldown.ms >= bodyCooldown.ms ? headerCooldown : bodyCooldown;
                }
                return headerCooldown || bodyCooldown || null;
            })();

            const classified = this._classify429Type(bodyText, error.message);
            const isQuotaExhausted = classified.isQuotaExhausted;
            const isRateLimited = classified.isRateLimited || (upstreamCooldown?.ms !== null && upstreamCooldown?.ms > 0);

            // 429 默认进入冷却：
            // - 能识别 quota 时走长冷却（额度用光/充值后恢复）
            // - 能识别 rate limit 时走短冷却（含 Retry-After）
            // - 都识别不了时，保守按 quota 处理（避免“额度用光”账号被无限快速重试刷屏）
            const cooldownReason = isQuotaExhausted ? 'quota' : (isRateLimited ? 'rate_limit' : 'quota_unknown');
            const maxUpstreamCooldownMs = 30 * 24 * 60 * 60 * 1000; // 30 天上限，防止异常头导致永久冷却
            const hasUpstreamCooldown = Number.isFinite(upstreamCooldown?.ms) && upstreamCooldown.ms > 0;
            const cooldownSource = hasUpstreamCooldown ? upstreamCooldown.source : null;
            const cooldownMs = hasUpstreamCooldown
                ? Math.max(1_000, Math.min(upstreamCooldown.ms, maxUpstreamCooldownMs))
                : (isQuotaExhausted
                    ? this._getProvider429QuotaCooldownMs()
                    : (isRateLimited
                        ? this._getProvider429RateLimitCooldownMs()
                        : this._getProvider429QuotaCooldownMs()));
            const recoveryTime = new Date(Date.now() + cooldownMs);

            // 429 冷却“识别失败”时，仅打印上游 body 以便补齐解析（按你的要求：不做限流，刷屏提醒需要更新）
            if (!hasUpstreamCooldown) {
                try {
                    logger.warn(
                        `[Codex] 429 cooldown parse failed (${context}). Please update 429 parser. Fallback cooldownMs=${cooldownMs}, reason=${cooldownReason}. Upstream body: ${this.truncateForLog(bodyText, 8000)}`
                    );
                } catch {
                    // ignore diagnostics failure
                }
            }

            logger.warn(
                `[Codex] Received 429 in ${context}. Cooling down credential ${this.uuid || 'unknown'} until ${recoveryTime.toISOString()} (reason=${cooldownReason}, cooldownMs=${cooldownMs}${cooldownSource ? `, source=${cooldownSource}` : ''})`
            );

            const poolManager = getProviderPoolManager();
            if (poolManager && this.uuid) {
                poolManager.markProviderUnhealthyWithRecoveryTime(
                    MODEL_PROVIDER.CODEX_API,
                    { uuid: this.uuid },
                    `429 Cooldown (${cooldownReason}, ${context}${cooldownSource ? `, ${cooldownSource}` : ''})`,
                    recoveryTime
                );
                error.credentialMarkedUnhealthy = true;
            }

            // 触发上层切换凭证，并避免重复累计错误次数
            error.shouldSwitchCredential = true;
            error.skipErrorCount = true;
            return true;
        } catch (handlerError) {
            logger.warn(`[Codex] Failed to apply 429 quota cooldown in ${context}: ${handlerError.message}`);
            return false;
        }
    }

    /**
     * 记录上游请求错误详情（重点增强 400 排查信息）
     */
    async logUpstreamRequestError(apiType, error, context = {}) {
        const status = error.response?.status;
        const errorCode = error.code || 'N/A';
        logger.error(`[Codex] Error calling ${apiType} API (Status: ${status}, Code: ${errorCode}):`, error.message);

        // 仅针对 400 输出详细排查信息，避免日志噪声过大
        if (status !== 400) {
            return;
        }

        const responseBody = await this.readUpstreamErrorBody(error.response?.data);
        const responseHeaders = error.response?.headers || {};
        const snapshot = {
            apiType,
            url: context.url,
            model: context.model,
            status,
            statusText: error.response?.statusText || null,
            requestKeys: Object.keys(context.body || {}),
            promptCacheKey: context.body?.prompt_cache_key || null,
            stream: context.body?.stream,
            hasInstructions: Boolean(context.body?.instructions),
            instructionsLength: typeof context.body?.instructions === 'string' ? context.body.instructions.length : null,
            inputType: Array.isArray(context.body?.input) ? 'array' : typeof context.body?.input,
            inputCount: Array.isArray(context.body?.input) ? context.body.input.length : null,
            toolsCount: Array.isArray(context.body?.tools) ? context.body.tools.length : 0,
            responseRequestId: responseHeaders['x-request-id'] || responseHeaders['request-id'] || null,
            responseContentType: responseHeaders['content-type'] || null,
            headersPreview: this.stringifyForLog(this.maskSensitiveHeaders(context.headers), 2000),
            requestBodyPreview: this.stringifyForLog(context.body, 8000)
        };

        logger.error(`[Codex] Upstream 400 response body: ${this.stringifyForLog(responseBody, 8000)}`);
        logger.error(`[Codex] Upstream 400 request snapshot: ${this.stringifyForLog(snapshot, 10000)}`);
    }

    /**
     * 读取上游错误响应体（支持 stream/string/object）
     */
    async readUpstreamErrorBody(data, maxChars = 8000) {
        if (data === undefined || data === null) {
            return '';
        }

        if (typeof data === 'string') {
            return this.truncateForLog(data, maxChars);
        }

        if (Buffer.isBuffer(data)) {
            return this.truncateForLog(data.toString('utf8'), maxChars);
        }

        const isReadableStream = typeof data?.on === 'function' && typeof data?.[Symbol.asyncIterator] === 'function';
        if (isReadableStream) {
            let result = '';
            try {
                for await (const chunk of data) {
                    result += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
                    if (result.length >= maxChars) {
                        if (typeof data.destroy === 'function') {
                            data.destroy();
                        }
                        break;
                    }
                }
            } catch (streamError) {
                return `[read_upstream_error_stream_failed] ${streamError.message}`;
            }
            return this.truncateForLog(result, maxChars);
        }

        return this.stringifyForLog(data, maxChars);
    }

    /**
     * 对敏感请求头进行脱敏
     */
    maskSensitiveHeaders(headers = {}) {
        const masked = { ...headers };
        if (typeof masked.authorization === 'string' && masked.authorization.length > 0) {
            masked.authorization = this.maskToken(masked.authorization);
        }
        return masked;
    }

    maskSensitiveResponseHeaders(headers = {}) {
        if (!headers || typeof headers !== 'object') {
            return {};
        }

        const masked = { ...headers };
        for (const key of Object.keys(masked)) {
            const normalizedKey = String(key || '').toLowerCase();
            if (!normalizedKey) continue;

            if (normalizedKey === 'set-cookie' || normalizedKey === 'cookie') {
                masked[key] = '[REDACTED]';
            }
        }

        return masked;
    }

    /**
     * 脱敏 token 字符串
     */
    maskToken(token) {
        if (!token || typeof token !== 'string') {
            return token;
        }
        if (token.length <= 14) {
            return `${token.slice(0, 4)}***`;
        }
        return `${token.slice(0, 10)}...${token.slice(-4)}`;
    }

    /**
     * 序列化日志对象，避免循环引用导致异常
     */
    stringifyForLog(value, maxChars = 4000) {
        const seen = new WeakSet();
        let raw;
        try {
            raw = typeof value === 'string'
                ? value
                : JSON.stringify(value, (key, currentValue) => {
                    if (typeof currentValue === 'object' && currentValue !== null) {
                        if (seen.has(currentValue)) {
                            return '[Circular]';
                        }
                        seen.add(currentValue);
                    }
                    return currentValue;
                });
        } catch (error) {
            raw = `[stringify_failed] ${error.message}`;
        }

        return this.truncateForLog(raw, maxChars);
    }

    /**
     * 截断日志内容，避免超长输出
     */
    truncateForLog(text, maxChars = 4000) {
        const raw = text == null ? '' : String(text);
        if (raw.length <= maxChars) {
            return raw;
        }
        return `${raw.slice(0, maxChars)}... [truncated ${raw.length - maxChars} chars]`;
    }

    /**
     * 构建请求头
     */
    buildHeaders(cacheId, stream = true) {
        const headers = {
            'version': '0.101.0',
            'x-codex-beta-features': 'powershell_utf8',
            'x-oai-web-search-eligible': 'true',
            'authorization': `Bearer ${this.accessToken}`,
            'chatgpt-account-id': this.accountId,
            'content-type': 'application/json',
            'user-agent': 'codex_cli_rs/0.101.0 (Windows 10.0.26100; x86_64) WindowsTerminal',
            'originator': 'codex_cli_rs',
            'host': 'chatgpt.com',
            'Connection': 'Keep-Alive'
        };

        // 设置 Conversation_id 和 Session_id
        if (cacheId) {
            headers['Conversation_id'] = cacheId;
            headers['Session_id'] = cacheId;
        }

        // 根据是否流式设置 Accept 头
        if (stream) {
            headers['accept'] = 'text/event-stream';
        } else {
            headers['accept'] = 'application/json';
        }

        return headers;
    }

    /**
     * 准备请求体
     */
    prepareRequestBody(model, requestBody, stream) {
        // 提取 metadata 并从请求体中移除，避免透传到上游
        const metadata = requestBody.metadata || {};
        
        // 明确会话维度：优先使用 session_id 或 conversation_id，其次 user_id
        const sessionId = metadata.session_id || metadata.conversation_id || metadata.user_id || 'default';
        
        const cleanedBody = { ...requestBody };
        delete cleanedBody.metadata;

        // 生成会话缓存键
        // 弱化 model 依赖，以提升同会话跨模型的缓存命中率
        // 仅当 sessionId 为 'default' 时加上 model 前缀，提供基础隔离
        let cacheKey = sessionId;
        if (sessionId === 'default') {
            cacheKey = `${model}-default`;
        }
        
        let cache = this.conversationCache.get(cacheKey);

        if (!cache || cache.expire < Date.now()) {
            cache = {
                id: crypto.randomUUID(),
                expire: Date.now() + 3600000 // 1 小时
            };
            this.conversationCache.set(cacheKey, cache);
        }

        // 注意：requestBody 已经去除了 metadata
        return {
            ...cleanedBody,
            stream,
            prompt_cache_key: cache.id
        };
    }

    /**
     * 刷新访问令牌
     */
    async refreshAccessToken() {
        try {
            const newTokens = await refreshCodexTokensWithRetry(this.refreshToken, this.config);

            this.idToken = newTokens.id_token || this.idToken;
            this.accessToken = newTokens.access_token;
            this.refreshToken = newTokens.refresh_token;
            this.accountId = newTokens.account_id;
            this.email = newTokens.email;

            // 关键修复：refreshCodexTokensWithRetry 返回字段名是 `expired`（ISO string），不是 `expire`
            const expiredValue = newTokens.expired || newTokens.expire || newTokens.expires_at || newTokens.expiresAt;
            const parsedExpiry = expiredValue ? new Date(expiredValue) : null;
            if (!parsedExpiry || Number.isNaN(parsedExpiry.getTime())) {
                // 如果上游没返回可解析的过期时间，保守处理：按 1h 有效期估算（避免 expiresAt 变成 NaN 导致永不刷新）
                this.expiresAt = new Date(Date.now() + 3600 * 1000);
                logger.warn('[Codex] Token refresh did not include a valid expiry time; falling back to 1h from now');
            } else {
                this.expiresAt = parsedExpiry;
            }

            // 保存更新的凭据
            await this.saveCredentials();

            // 刷新成功，重置 PoolManager 中的刷新状态并标记为健康
            const poolManager = getProviderPoolManager();
            if (poolManager && this.uuid) {
                poolManager.resetProviderRefreshStatus(MODEL_PROVIDER.CODEX_API, this.uuid);
            }
            logger.debug('[Codex] Token refreshed successfully');
        } catch (error) {
            logger.error('[Codex] Failed to refresh token:', error.message);
            throw new Error('Failed to refresh Codex token. Please re-authenticate.');
        }
    }

    /**
     * 检查 token 是否即将过期
     */
    isExpiryDateNear() {
        if (!this.expiresAt) return true;
        const expiry = this.expiresAt.getTime();
        // 如果 expiresAt 是 Invalid Date（NaN），必须视为“接近过期/已过期”，否则刷新永远不会触发
        if (Number.isNaN(expiry)) {
            logger.warn('[Codex] expiresAt is invalid (NaN). Treating as near expiry to force refresh');
            return true;
        }
        const nearMinutes = 20;
        const { message, isNearExpiry } = formatExpiryLog('Codex', expiry, nearMinutes);
        logger.debug(message);
        return isNearExpiry;
    }

    /**
     * 获取凭据文件路径
     */
    getCredentialsPath() {
        const email = this.config.CODEX_EMAIL || this.email || 'default';

        // 1) 优先使用配置中指定的路径（号池模式/显式配置）
        if (this.config.CODEX_OAUTH_CREDS_FILE_PATH) {
            return this.config.CODEX_OAUTH_CREDS_FILE_PATH;
        }

        // 2) 如果本次是从 configs/codex 扫描加载的，务必写回同一文件
        if (this.credsPath) {
            return this.credsPath;
        }

        // 3) 兜底：写入 configs/codex（与 OAuth 保存默认目录保持一致，避免“读取 configs/codex、写入 .codex”导致永远读到旧 token）
        const projectDir = process.cwd();
        return path.join(projectDir, 'configs', 'codex', `${Date.now()}_codex-${email}.json`);
    }

    /**
     * 保存凭据
     */
    async saveCredentials() {
        const credsPath = this.getCredentialsPath();
        const credsDir = path.dirname(credsPath);

        if (!this.expiresAt || Number.isNaN(this.expiresAt.getTime())) {
            throw new Error('Invalid expiresAt when saving Codex credentials');
        }

        await fs.mkdir(credsDir, { recursive: true });
        await fs.writeFile(
            credsPath,
            JSON.stringify(
                {
                    id_token: this.idToken || '',
                    access_token: this.accessToken,
                    refresh_token: this.refreshToken,
                    account_id: this.accountId,
                    last_refresh: new Date().toISOString(),
                    email: this.email,
                    type: 'codex',
                    expired: this.expiresAt.toISOString()
                },
                null,
                2
            ),
            { mode: 0o600 }
        );

        // 更新缓存路径（例如首次无 credsPath 兜底生成了新文件）
        this.credsPath = credsPath;
    }

    /**
     * 检查文件是否存在
     */
    async fileExists(filePath) {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 解析 SSE 流
     */
    async *parseSSEStream(stream) {
        let buffer = '';

        for await (const chunk of stream) {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop(); // 保留不完整的行

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim();
                    if (data && data !== '[DONE]') {
                        try {
                            const parsed = JSON.parse(data);
                            yield parsed;
                        } catch (e) {
                            logger.error('[Codex] Failed to parse SSE data:', e.message);
                        }
                    }
                }
            }
        }

        // 处理剩余的 buffer
        if (buffer.trim()) {
            if (buffer.startsWith('data: ')) {
                const data = buffer.slice(6).trim();
                if (data && data !== '[DONE]') {
                    try {
                        const parsed = JSON.parse(data);
                        yield parsed;
                    } catch (e) {
                        logger.error('[Codex] Failed to parse final SSE data:', e.message);
                    }
                }
            }
        }
    }

    /**
     * 解析非流式响应
     */
    parseNonStreamResponse(data) {
        // 确保 data 是字符串
        const responseText = typeof data === 'string' ? data : String(data);
        
        // 从 SSE 流中提取 response.completed 事件
        const lines = responseText.split('\n');
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const jsonData = line.slice(6).trim();
                if (!jsonData || jsonData === '[DONE]') {
                    continue;
                }
                try {
                    const parsed = JSON.parse(jsonData);
                    if (parsed.type === 'response.completed') {
                        return parsed;
                    }
                } catch (e) {
                    // 继续解析下一行
                    logger.debug('[Codex] Failed to parse SSE line:', e.message);
                }
            }
        }
        
        // 如果没有找到 response.completed，抛出错误
        logger.error('[Codex] No completed response found in Codex response');
        throw new Error('stream error: stream disconnected before completion: stream closed before response.completed');
    }

    /**
     * 列出可用模型
     */
    async listModels() {
        return {
            object: 'list',
            data: [
                { id: 'gpt-5', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'openai' },
                { id: 'gpt-5-codex', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'openai' },
                { id: 'gpt-5-codex-mini', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'openai' },
                { id: 'gpt-5.1', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'openai' },
                { id: 'gpt-5.1-codex', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'openai' },
                { id: 'gpt-5.1-codex-mini', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'openai' },
                { id: 'gpt-5.1-codex-max', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'openai' },
                { id: 'gpt-5.2', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'openai' },
                { id: 'gpt-5.2-codex', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'openai' },
                { id: 'gpt-5.3-codex', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'openai' },
                { id: 'gpt-5.3-codex-spark', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'openai' },
                { id: 'gpt-5.4', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'openai' }
            ]
        };
    }

    /**
     * 启动缓存清理
     */
    startCacheCleanup() {
        // 每 15 分钟清理过期缓存
        this.cleanupInterval = setInterval(() => {
            const now = Date.now();
            for (const [key, cache] of this.conversationCache.entries()) {
                if (cache.expire < now) {
                    this.conversationCache.delete(key);
                }
            }
        }, 15 * 60 * 1000);
    }

    /**
     * 停止缓存清理
     */
    stopCacheCleanup() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    /**
     * 获取使用限制信息
     * @returns {Promise<Object>} 使用限制信息（通用格式）
     */
    async getUsageLimits() {
        if (!this.isInitialized) {
            await this.initialize();
        }

        try {
            const url = 'https://chatgpt.com/backend-api/wham/usage';
            const headers = {
                'user-agent': 'codex_cli_rs/0.89.0 (Windows 10.0.26100; x86_64) WindowsTerminal',
                'authorization': `Bearer ${this.accessToken}`,
                'chatgpt-account-id': this.accountId,
                'accept': '*/*',
                'host': 'chatgpt.com',
                'Connection': 'close'
            };

            const config = {
                headers,
                timeout: 30000 // 30 秒超时
            };

            // 配置代理
            const proxyConfig = getProxyConfigForProvider(this.config, 'openai-codex-oauth');
            if (proxyConfig) {
                config.httpAgent = proxyConfig.httpAgent;
                config.httpsAgent = proxyConfig.httpsAgent;
            }

            const response = await axios.get(url, config);
            
            // 解析响应数据并转换为通用格式
            const data = response.data;
            
            // 通用格式：{ lastUpdated, models: { "model-id": { remaining, resetTime, resetTimeRaw } } }
            const result = {
                lastUpdated: Date.now(),
                models: {}
            };

            // 从 rate_limit 提取配额信息
            // Codex 使用百分比表示使用量，我们需要转换为剩余量
            if (data.rate_limit) {
                const primaryWindow = data.rate_limit.primary_window;
                const secondaryWindow = data.rate_limit.secondary_window;
                
                // 使用主窗口的数据作为主要配额信息
                if (primaryWindow) {
                    // remaining = 1 - (used_percent / 100)
                    const remaining = 1 - (primaryWindow.used_percent || 0) / 100;
                    const resetTime = primaryWindow.reset_at ? new Date(primaryWindow.reset_at * 1000).toISOString() : null;
                    
                    // 为所有 Codex 模型设置相同的配额信息
                    const codexModels = ['default'];
                    for (const modelId of codexModels) {
                        result.models[modelId] = {
                            remaining: Math.max(0, Math.min(1, remaining)), // 确保在 0-1 之间
                            resetTime: resetTime,
                            resetTimeRaw: primaryWindow.reset_at
                        };
                    }
                }
            }

            // 保存原始响应数据供需要时使用
            result.raw = {
                planType: data.plan_type || 'unknown',
                rateLimit: data.rate_limit,
                codeReviewRateLimit: data.code_review_rate_limit,
                credits: data.credits
            };

            logger.info(`[Codex] Successfully fetched usage limits for plan: ${result.raw.planType}`);
            return result;
        } catch (error) {
            if (error.response?.status === 401) {
                logger.info('[Codex] Received 401 during getUsageLimits. Triggering background refresh via PoolManager...');

                // 标记当前凭证为不健康
                const poolManager = getProviderPoolManager();
                if (poolManager && this.uuid) {
                    logger.info(`[Codex] Marking credential ${this.uuid} as needs refresh. Reason: 401 Unauthorized in getUsageLimits`);
                    poolManager.markProviderNeedRefresh(MODEL_PROVIDER.CODEX_API, {
                        uuid: this.uuid
                    });
                    error.credentialMarkedUnhealthy = true;
                }

                // Mark error for credential switch without recording error count
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
            }
            
            logger.error('[Codex] Failed to get usage limits:', error.message);
            throw error;
        }
    }
}

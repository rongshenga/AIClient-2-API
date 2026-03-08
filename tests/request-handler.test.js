import { jest } from '@jest/globals';

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        setRequestContext: jest.fn(),
        clearRequestContext: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    }
}));

jest.mock('../src/utils/common.js', () => ({
    __esModule: true,
    handleError: jest.fn(),
    getClientIp: jest.fn(() => '127.0.0.1'),
    MODEL_PROVIDER: { AUTO: 'auto' }
}));

jest.mock('../src/services/ui-manager.js', () => ({
    __esModule: true,
    handleUIApiRequests: jest.fn(),
    serveStaticFiles: jest.fn()
}));

jest.mock('../src/services/api-manager.js', () => ({
    __esModule: true,
    handleAPIRequests: jest.fn()
}));

jest.mock('../src/services/service-manager.js', () => ({
    __esModule: true,
    getApiService: jest.fn(),
    getProviderStatus: jest.fn(),
    getProviderPoolManager: jest.fn()
}));

jest.mock('../src/providers/adapter.js', () => ({
    __esModule: true,
    getRegisteredProviders: jest.fn(() => [])
}));

jest.mock('../src/utils/token-utils.js', () => ({
    __esModule: true,
    countTokensAnthropic: jest.fn()
}));

jest.mock('../src/core/config-manager.js', () => ({
    __esModule: true,
    PROMPT_LOG_FILENAME: ''
}));

jest.mock('../src/core/plugin-manager.js', () => ({
    __esModule: true,
    getPluginManager: jest.fn(() => ({
        isPluginStaticPath: jest.fn(() => false),
        executeRoutes: jest.fn(async () => false),
        executeAuth: jest.fn(async () => ({ handled: false, authorized: true })),
        executeMiddleware: jest.fn(async () => ({ handled: false }))
    }))
}));

jest.mock('../src/utils/grok-assets-proxy.js', () => ({
    __esModule: true,
    handleGrokAssetsProxy: jest.fn()
}));

describe('request handler config cloning', () => {
    test('should enable request debug logging in test mode and when ui debug markers are present', async () => {
        const { shouldEnableRequestDebugLogging } = await import('../src/handlers/request-handler.js');

        expect(shouldEnableRequestDebugLogging({
            headers: { 'x-ui-debug': '1' },
            url: '/api/providers/summary'
        }, {})).toBe(true);

        expect(shouldEnableRequestDebugLogging({
            headers: {},
            url: '/api/providers/summary?ui_debug=1'
        }, {})).toBe(true);

        const previousNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try {
            expect(shouldEnableRequestDebugLogging({
                headers: {},
                url: '/api/providers/summary'
            }, {})).toBe(false);
        } finally {
            process.env.NODE_ENV = previousNodeEnv;
        }
    });

    test('should avoid deep cloning providerPools while cloning mutable small configs', async () => {
        const { createRequestScopedConfig } = await import('../src/handlers/request-handler.js');

        const providerPools = {
            'openai-codex-oauth': Array.from({ length: 2 }, (_, index) => ({
                uuid: `provider-${index}`,
                customName: `Provider ${index}`
            }))
        };
        const providerFallbackChain = {
            'openai-codex-oauth': ['grok-custom']
        };
        const modelFallbackMapping = {
            demo: {
                targetProviderType: 'grok-custom',
                targetModel: 'grok-3'
            }
        };
        const runtimeStorageInfo = {
            backend: 'dual-write',
            featureFlagRollback: {
                RUNTIME_STORAGE_BACKEND: 'file'
            }
        };

        const scopedConfig = createRequestScopedConfig({
            MODEL_PROVIDER: 'openai-codex-oauth',
            DEFAULT_MODEL_PROVIDERS: ['openai-codex-oauth'],
            PROXY_ENABLED_PROVIDERS: ['openai-codex-oauth'],
            providerPools,
            providerFallbackChain,
            modelFallbackMapping,
            RUNTIME_STORAGE_INFO: runtimeStorageInfo
        });

        expect(scopedConfig).not.toBeUndefined();
        expect(scopedConfig.providerPools).toBe(providerPools);
        expect(scopedConfig.DEFAULT_MODEL_PROVIDERS).not.toBe(providerPools);
        expect(scopedConfig.DEFAULT_MODEL_PROVIDERS).toEqual(['openai-codex-oauth']);
        expect(scopedConfig.PROXY_ENABLED_PROVIDERS).toEqual(['openai-codex-oauth']);
        expect(scopedConfig.providerFallbackChain).toEqual(providerFallbackChain);
        expect(scopedConfig.providerFallbackChain).not.toBe(providerFallbackChain);
        expect(scopedConfig.modelFallbackMapping).toEqual(modelFallbackMapping);
        expect(scopedConfig.modelFallbackMapping).not.toBe(modelFallbackMapping);
        expect(scopedConfig.RUNTIME_STORAGE_INFO).toEqual(runtimeStorageInfo);
        expect(scopedConfig.RUNTIME_STORAGE_INFO).not.toBe(runtimeStorageInfo);

        scopedConfig.DEFAULT_MODEL_PROVIDERS.push('grok-custom');
        scopedConfig.PROXY_ENABLED_PROVIDERS.push('grok-custom');
        scopedConfig.providerFallbackChain['openai-codex-oauth'].push('gemini-cli-oauth');
        scopedConfig.modelFallbackMapping.demo.targetModel = 'changed';
        scopedConfig.RUNTIME_STORAGE_INFO.featureFlagRollback.RUNTIME_STORAGE_BACKEND = 'db';

        expect(providerPools['openai-codex-oauth']).toHaveLength(2);
        expect(providerFallbackChain['openai-codex-oauth']).toEqual(['grok-custom']);
        expect(modelFallbackMapping.demo.targetModel).toBe('grok-3');
        expect(runtimeStorageInfo.featureFlagRollback.RUNTIME_STORAGE_BACKEND).toBe('file');
    });
});

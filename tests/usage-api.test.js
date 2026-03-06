import { jest } from '@jest/globals';

jest.setTimeout(120000);

const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

const serviceInstances = {};
const sharedAdapter = {
    async getUsageLimits() {
        return {
            usageBreakdown: []
        };
    }
};

const mockGetServiceAdapter = jest.fn((config) => {
    const providerKey = config.uuid ? `${config.MODEL_PROVIDER}${config.uuid}` : config.MODEL_PROVIDER;
    if (!serviceInstances[providerKey]) {
        serviceInstances[providerKey] = sharedAdapter;
    }
    return serviceInstances[providerKey];
});

const mockReadUsageCache = jest.fn();
const mockWriteUsageCache = jest.fn();
const mockReadProviderUsageCache = jest.fn();
const mockUpdateProviderUsageCache = jest.fn();

const passthrough = (value) => value;

let handleGetProviderUsage;
let handleGetUsageRefreshTask;

function createMockRes() {
    return {
        statusCode: null,
        headers: null,
        body: '',
        writeHead(code, headers) {
            this.statusCode = code;
            this.headers = headers;
        },
        end(payload = '') {
            this.body = payload;
        }
    };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildLargeProviderPool(count) {
    return Array.from({ length: count }, (_, index) => ({
        uuid: `gemini-${index}`,
        customName: `Gemini-${index}`
    }));
}

describe('Usage API Large Pool Async Task', () => {
    beforeAll(async () => {
        jest.resetModules();

        jest.doMock('../src/core/config-manager.js', () => ({
            CONFIG: {}
        }));

        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));

        jest.doMock('../src/providers/adapter.js', () => ({
            serviceInstances,
            getServiceAdapter: mockGetServiceAdapter
        }));

        jest.doMock('../src/services/usage-service.js', () => ({
            formatKiroUsage: passthrough,
            formatGeminiUsage: passthrough,
            formatAntigravityUsage: passthrough,
            formatCodexUsage: passthrough,
            formatGrokUsage: passthrough
        }));

        jest.doMock('../src/ui-modules/usage-cache.js', () => ({
            readUsageCache: mockReadUsageCache,
            writeUsageCache: mockWriteUsageCache,
            readProviderUsageCache: mockReadProviderUsageCache,
            updateProviderUsageCache: mockUpdateProviderUsageCache
        }));

        const usageApiModule = await import('../src/ui-modules/usage-api.js');
        handleGetProviderUsage = usageApiModule.handleGetProviderUsage;
        handleGetUsageRefreshTask = usageApiModule.handleGetUsageRefreshTask;
    });

    beforeEach(() => {
        mockReadUsageCache.mockReset();
        mockWriteUsageCache.mockReset();
        mockReadProviderUsageCache.mockReset();
        mockUpdateProviderUsageCache.mockReset();
        mockGetServiceAdapter.mockClear();
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();

        for (const key of Object.keys(serviceInstances)) {
            delete serviceInstances[key];
        }
    });

    test('should refresh 80000 providers with async task and grouped progress', async () => {
        const providerType = 'gemini-cli-oauth';
        const totalProviders = 80000;
        const providers = buildLargeProviderPool(totalProviders);

        mockReadProviderUsageCache.mockResolvedValue(null);
        mockUpdateProviderUsageCache.mockResolvedValue(undefined);

        const req = {
            url: `/api/usage/${encodeURIComponent(providerType)}?refresh=true&async=true&concurrency=64&groupSize=100&groupMinPoolSize=2000`,
            headers: {
                host: 'localhost:3000'
            }
        };
        const res = createMockRes();

        const currentConfig = {
            providerPools: {
                [providerType]: providers
            },
            USAGE_QUERY_CONCURRENCY_PER_PROVIDER: 64,
            POOL_GROUP_SIZE: 100,
            POOL_GROUP_MIN_POOL_SIZE: 2000
        };
        const providerPoolManager = {
            providerPools: {
                [providerType]: providers
            }
        };

        const handled = await handleGetProviderUsage(req, res, currentConfig, providerPoolManager, providerType);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(202);

        const startPayload = JSON.parse(res.body);
        expect(startPayload.taskId).toBeTruthy();
        expect(startPayload.status).toBe('running');
        expect(startPayload.type).toBe('provider');

        const deadline = Date.now() + 110000;
        let latestTaskStatus = null;

        while (Date.now() < deadline) {
            const taskRes = createMockRes();
            const ok = await handleGetUsageRefreshTask({}, taskRes, startPayload.taskId);
            expect(ok).toBe(true);
            expect(taskRes.statusCode).toBe(200);

            latestTaskStatus = JSON.parse(taskRes.body);
            if (latestTaskStatus.status !== 'running') {
                break;
            }

            await sleep(5);
        }

        expect(latestTaskStatus).toBeTruthy();
        expect(latestTaskStatus.status).toBe('completed');
        expect(latestTaskStatus.progress.totalInstances).toBe(totalProviders);
        expect(latestTaskStatus.progress.processedInstances).toBe(totalProviders);
        expect(latestTaskStatus.progress.successCount).toBe(totalProviders);
        expect(latestTaskStatus.progress.errorCount).toBe(0);
        expect(latestTaskStatus.progress.percent).toBe(100);
        expect(latestTaskStatus.result.totalCount).toBe(totalProviders);
        expect(latestTaskStatus.result.successCount).toBe(totalProviders);
        expect(latestTaskStatus.result.errorCount).toBe(0);

        expect(mockUpdateProviderUsageCache).toHaveBeenCalledTimes(1);
        expect(mockUpdateProviderUsageCache).toHaveBeenCalledWith(
            providerType,
            expect.objectContaining({
                totalCount: totalProviders,
                successCount: totalProviders,
                errorCount: 0
            })
        );
    });
});

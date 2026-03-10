import { jest } from '@jest/globals';

const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

describe('System API auth storage metrics', () => {
    let handleGetSystem;

    beforeEach(async () => {
        jest.resetModules();

        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));
        jest.doMock('../src/core/config-manager.js', () => ({
            __esModule: true,
            CONFIG: {
                AUTH_STORAGE_MODE: 'db_only',
                AUTH_GROUP_PRELOAD_SIZE: 128,
                AUTH_GROUP_PRELOAD_AHEAD: 2,
                AUTH_SECRET_CACHE_TTL_MS: 450000,
                providerPools: {}
            }
        }));
        jest.doMock('../src/storage/runtime-storage-registry.js', () => ({
            __esModule: true,
            getRuntimeStorage: jest.fn(() => null),
            getRuntimeStorageInfo: jest.fn(() => ({ backend: 'db', authoritativeSource: 'database' }))
        }));
        jest.doMock('../src/services/service-manager.js', () => ({
            __esModule: true,
            getProviderPoolManager: jest.fn(() => ({
                getAuthRuntimeMetrics: jest.fn(() => ({
                    groupPreload: { queueLength: 3 },
                    credentialCache: { hits: 7, misses: 3 },
                    coldLoadDurationMs: 91
                }))
            }))
        }));
        jest.doMock('../src/ui-modules/system-monitor.js', () => ({
            __esModule: true,
            getCpuUsagePercent: jest.fn(() => '1.2%')
        }));

        ({ handleGetSystem } = await import('../src/ui-modules/system-api.js'));
    });

    test('should expose auth storage mode and preload/cache metrics', async () => {
        const req = { method: 'GET', headers: {} };
        const res = {
            statusCode: 0,
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

        await handleGetSystem(req, res);
        expect(res.statusCode).toBe(200);
        const payload = JSON.parse(res.body);
        expect(payload.authStorage).toMatchObject({
            authStorageMode: 'db_only',
            groupPreload: {
                size: 128,
                ahead: 2,
                queueLength: 3
            },
            credentialCache: {
                ttlMs: 450000,
                hits: 7,
                misses: 3,
                hitRate: 0.7
            },
            coldLoadDurationMs: 91
        });
    });
});


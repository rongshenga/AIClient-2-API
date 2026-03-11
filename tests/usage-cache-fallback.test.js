import { jest } from '@jest/globals';

const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

describe('Usage cache db-only runtime policy', () => {
    let readUsageCache;
    let readProviderUsageCache;
    let mockGetRuntimeStorage;
    let mockRuntimeStorage;

    beforeEach(async () => {
        jest.resetModules();

        mockRuntimeStorage = {
            loadUsageCacheSnapshot: jest.fn(),
            loadProviderUsageSnapshot: jest.fn(),
            getInfo: jest.fn(() => ({ backend: 'db' }))
        };
        mockGetRuntimeStorage = jest.fn(() => mockRuntimeStorage);

        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));
        jest.doMock('../src/storage/runtime-storage-registry.js', () => ({
            __esModule: true,
            getRuntimeStorage: mockGetRuntimeStorage
        }));

        ({ readUsageCache, readProviderUsageCache } = await import('../src/ui-modules/usage-cache.js'));
    });

    afterEach(() => {
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
    });

    test('should return null when runtime usage snapshot read fails', async () => {
        mockRuntimeStorage.loadUsageCacheSnapshot.mockRejectedValue(new Error('sqlite locked'));

        await expect(readUsageCache()).resolves.toBeNull();
    });

    test('should return null when runtime provider usage snapshot read fails', async () => {
        mockRuntimeStorage.loadProviderUsageSnapshot.mockRejectedValue(new Error('sqlite busy'));

        await expect(readProviderUsageCache('grok-custom')).resolves.toBeNull();
    });

    test('should return null when runtime storage is unavailable', async () => {
        mockGetRuntimeStorage.mockReturnValue(null);

        await expect(readUsageCache()).resolves.toBeNull();
        await expect(readProviderUsageCache('grok-custom')).resolves.toBeNull();
    });
});

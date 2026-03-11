import { jest } from '@jest/globals';

const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

describe('Runtime storage registry db-only', () => {
    let closeRuntimeStorage;
    let getRuntimeStorage;
    let initializeRuntimeStorage;
    let loadProviderPoolsCompatSnapshot;
    let mockCreateRuntimeStorage;
    let preferredStorage;

    beforeEach(async () => {
        jest.resetModules();

        preferredStorage = {
            initialize: jest.fn(async () => preferredStorage),
            close: jest.fn(),
            getInfo: jest.fn(() => ({ backend: 'db' })),
            loadProviderPoolsSnapshot: jest.fn(async () => ({})),
            replaceProviderPoolsSnapshot: jest.fn(async (providerPools = {}) => providerPools),
            getCredentialSecretBlob: jest.fn(async () => null),
            upsertCredentialSecretBlob: jest.fn(async (_id, payload = null) => payload),
            listCredentialExpiryCandidates: jest.fn(async () => []),
            getAdminPasswordHash: jest.fn(async () => null),
            saveAdminPasswordHash: jest.fn(async (record = {}) => record)
        };
        mockCreateRuntimeStorage = jest.fn(() => preferredStorage);

        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));
        jest.doMock('../src/storage/runtime-storage-factory.js', () => ({
            __esModule: true,
            createRuntimeStorage: mockCreateRuntimeStorage
        }));

        ({
            closeRuntimeStorage,
            getRuntimeStorage,
            initializeRuntimeStorage,
            loadProviderPoolsCompatSnapshot
        } = await import('../src/storage/runtime-storage-registry'));
    });

    afterEach(async () => {
        if (closeRuntimeStorage) {
            await closeRuntimeStorage();
        }
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
    });

    test('should initialize runtime storage in db-only mode', async () => {
        const config = {
            RUNTIME_STORAGE_BACKEND: 'file'
        };

        const storage = await initializeRuntimeStorage(config);
        expect(storage).toBeTruthy();
        expect(getRuntimeStorage()).toBeTruthy();
        expect(mockCreateRuntimeStorage).toHaveBeenCalledTimes(1);

        const info = storage.getInfo();
        expect(info).toMatchObject({
            backend: 'db',
            requestedBackend: 'db',
            authoritativeSource: 'database',
            dualWriteEnabled: false,
            fallbackEnabled: false,
            featureFlagRollback: null
        });
        expect(config.RUNTIME_STORAGE_INFO).toMatchObject({
            backend: 'db',
            requestedBackend: 'db'
        });
    });

    test('should rethrow initialization error without fallback', async () => {
        preferredStorage.initialize.mockRejectedValue(new Error('db init failed'));

        await expect(initializeRuntimeStorage({ RUNTIME_STORAGE_BACKEND: 'db' })).rejects.toThrow('db init failed');
        expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('should surface provider write failure from db backend', async () => {
        const dbWriteError = new Error('database is locked');
        dbWriteError.code = 'SQLITE_BUSY';
        preferredStorage.replaceProviderPoolsSnapshot.mockRejectedValue(dbWriteError);

        const config = {
            RUNTIME_STORAGE_BACKEND: 'db'
        };
        const storage = await initializeRuntimeStorage(config);

        await expect(storage.replaceProviderPoolsSnapshot({ 'grok-custom': [] })).rejects.toMatchObject({
            code: 'SQLITE_BUSY',
            phase: 'write',
            domain: 'provider',
            backend: 'db'
        });

        const info = storage.getInfo();
        expect(info).toMatchObject({
            backend: 'db',
            requestedBackend: 'db',
            authoritativeSource: 'database',
            lastFallback: null
        });
        expect(info.lastError).toMatchObject({
            status: 'failed',
            operation: 'replaceProviderPoolsSnapshot',
            phase: 'write',
            backend: 'db'
        });
    });

    test('should return empty snapshot when compat snapshot is requested without config', async () => {
        await expect(loadProviderPoolsCompatSnapshot({})).resolves.toEqual({});
        expect(mockCreateRuntimeStorage).not.toHaveBeenCalled();
    });

    test('should proxy auth password hash operations to active runtime storage', async () => {
        const storage = await initializeRuntimeStorage({ RUNTIME_STORAGE_BACKEND: 'db' });
        preferredStorage.getAdminPasswordHash.mockResolvedValueOnce({
            version: 1,
            algorithm: 'sha256-salt'
        });

        await expect(storage.getAdminPasswordHash()).resolves.toMatchObject({
            version: 1,
            algorithm: 'sha256-salt'
        });
        await expect(storage.saveAdminPasswordHash({ version: 1 })).resolves.toMatchObject({ version: 1 });
        expect(preferredStorage.getAdminPasswordHash).toHaveBeenCalledTimes(1);
        expect(preferredStorage.saveAdminPasswordHash).toHaveBeenCalledWith({ version: 1 });
    });

    test('should proxy credential secret and expiry candidate operations to active runtime storage', async () => {
        const storage = await initializeRuntimeStorage({ RUNTIME_STORAGE_BACKEND: 'db' });
        preferredStorage.getCredentialSecretBlob.mockResolvedValueOnce({
            credential_asset_id: 'asset-1'
        });
        preferredStorage.listCredentialExpiryCandidates.mockResolvedValueOnce([
            { provider_id: 'prov-1' }
        ]);

        await expect(storage.getCredentialSecretBlob('asset-1')).resolves.toMatchObject({
            credential_asset_id: 'asset-1'
        });
        await expect(storage.upsertCredentialSecretBlob('asset-1', { foo: 'bar' })).resolves.toMatchObject({ foo: 'bar' });
        await expect(storage.listCredentialExpiryCandidates('gemini-cli-oauth')).resolves.toEqual([
            { provider_id: 'prov-1' }
        ]);

        expect(preferredStorage.getCredentialSecretBlob).toHaveBeenCalledWith('asset-1');
        expect(preferredStorage.upsertCredentialSecretBlob).toHaveBeenCalledWith('asset-1', { foo: 'bar' });
        expect(preferredStorage.listCredentialExpiryCandidates).toHaveBeenCalledWith('gemini-cli-oauth');
    });
});

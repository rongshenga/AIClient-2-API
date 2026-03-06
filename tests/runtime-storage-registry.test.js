import { jest } from '@jest/globals';

const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

describe('Runtime storage registry fallback', () => {
    let closeRuntimeStorage;
    let getRuntimeStorage;
    let initializeRuntimeStorage;
    let loadProviderPoolsCompatSnapshot;
    let MockFileRuntimeStorage;
    let fallbackStorage;
    let mockCreateRuntimeStorage;
    let preferredStorage;

    beforeEach(async () => {
        jest.resetModules();

        preferredStorage = {
            initialize: jest.fn(),
            close: jest.fn(),
            getInfo: jest.fn(() => ({ backend: 'db' })),
            replaceProviderPoolsSnapshot: jest.fn(async (providerPools = {}) => providerPools)
        };
        fallbackStorage = {
            initialize: jest.fn(async () => fallbackStorage),
            close: jest.fn(),
            getInfo: jest.fn(() => ({ backend: 'file' })),
            loadProviderPoolsSnapshot: jest.fn(async () => ({})),
            replaceProviderPoolsSnapshot: jest.fn(async (providerPools = {}) => providerPools)
        };
        mockCreateRuntimeStorage = jest.fn(() => preferredStorage);
        MockFileRuntimeStorage = jest.fn(() => fallbackStorage);

        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));
        jest.doMock('../src/storage/runtime-storage-factory.js', () => ({
            __esModule: true,
            createRuntimeStorage: mockCreateRuntimeStorage
        }));
        jest.doMock('../src/storage/backends/file-runtime-storage.js', () => ({
            __esModule: true,
            FileRuntimeStorage: MockFileRuntimeStorage
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

    test('should fallback to file backend when db initialization fails and fallback is enabled', async () => {
        preferredStorage.initialize.mockRejectedValue(new Error('db init failed'));

        const storage = await initializeRuntimeStorage({
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_FALLBACK_TO_FILE: true
        });

        expect(storage.getInfo().backend).toBe('file');
        expect(getRuntimeStorage().getInfo().backend).toBe('file');
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Activated file fallback'));
    });

    test('should rethrow initialization error when file fallback is disabled', async () => {
        preferredStorage.initialize.mockRejectedValue(new Error('db init failed'));

        await expect(initializeRuntimeStorage({
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_FALLBACK_TO_FILE: false
        })).rejects.toThrow('db init failed');

        expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('should retry provider mutation on file backend after db write failure', async () => {
        const config = {
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_FALLBACK_TO_FILE: true
        };
        const dbWriteError = new Error('database is locked');
        dbWriteError.code = 'SQLITE_BUSY';
        preferredStorage.replaceProviderPoolsSnapshot.mockRejectedValue(dbWriteError);

        const storage = await initializeRuntimeStorage(config);
        const providerPools = {
            'grok-custom': [
                {
                    uuid: 'grok-fallback-1'
                }
            ]
        };

        await expect(storage.replaceProviderPoolsSnapshot(providerPools)).resolves.toEqual(providerPools);
        expect(config.RUNTIME_STORAGE_BACKEND).toBe('file');
        expect(config.RUNTIME_STORAGE_DUAL_WRITE).toBe(false);
        expect(storage.getInfo()).toMatchObject({
            backend: 'file',
            requestedBackend: 'db',
            authoritativeSource: 'file'
        });
        expect(storage.getInfo().lastFallback).toMatchObject({
            status: 'applied',
            triggeredBy: 'replaceProviderPoolsSnapshot',
            toBackend: 'file'
        });
        expect(storage.getInfo().lastMutation).toMatchObject({
            status: 'success',
            backend: 'file',
            recoveredViaFallback: true
        });
        expect(fallbackStorage.replaceProviderPoolsSnapshot).toHaveBeenCalledWith(providerPools);
    });

    test('should not fallback when dual-write secondary sync fails', async () => {
        preferredStorage.getInfo.mockReturnValue({ backend: 'dual-write' });
        const secondaryWriteError = new Error('secondary write failed');
        secondaryWriteError.code = 'runtime_storage_secondary_write_failed';
        secondaryWriteError.phase = 'write_secondary';
        secondaryWriteError.domain = 'runtime_storage';
        secondaryWriteError.details = {
            storageRole: 'secondary'
        };
        preferredStorage.replaceProviderPoolsSnapshot.mockRejectedValue(secondaryWriteError);

        const config = {
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DUAL_WRITE: true,
            RUNTIME_STORAGE_FALLBACK_TO_FILE: true
        };
        const storage = await initializeRuntimeStorage(config);

        await expect(storage.replaceProviderPoolsSnapshot({ 'grok-custom': [] })).rejects.toMatchObject({
            code: 'runtime_storage_secondary_write_failed',
            domain: 'provider',
            backend: 'dual-write',
            retryable: false,
            details: expect.objectContaining({
                storageRole: 'secondary'
            })
        });
        expect(storage.getInfo()).toMatchObject({
            backend: 'dual-write',
            requestedBackend: 'dual-write',
            authoritativeSource: 'database',
            dualWriteEnabled: true,
            lastFallback: null
        });
        expect(storage.getInfo().lastError).toMatchObject({
            status: 'failed',
            operation: 'replaceProviderPoolsSnapshot',
            backend: 'dual-write'
        });
        expect(config.RUNTIME_STORAGE_BACKEND).toBe('db');
        expect(config.RUNTIME_STORAGE_DUAL_WRITE).toBe(true);
        expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('should return empty snapshot when compat snapshot is requested without config', async () => {
        await expect(loadProviderPoolsCompatSnapshot({})).resolves.toEqual({});
        expect(mockCreateRuntimeStorage).not.toHaveBeenCalled();
    });
test('should surface fallback retry failure when file fallback write also fails', async () => {
    const config = {
        RUNTIME_STORAGE_BACKEND: 'db',
        RUNTIME_STORAGE_FALLBACK_TO_FILE: true
    };
    const dbWriteError = new Error('database is locked');
    dbWriteError.code = 'SQLITE_BUSY';
    preferredStorage.replaceProviderPoolsSnapshot.mockRejectedValue(dbWriteError);
    fallbackStorage.replaceProviderPoolsSnapshot.mockRejectedValue(new Error('file write failed'));

    const storage = await initializeRuntimeStorage(config);

    await expect(storage.replaceProviderPoolsSnapshot({ 'grok-custom': [] })).rejects.toMatchObject({
        code: 'runtime_storage_fallback_retry_failed',
        phase: 'fallback',
        backend: 'file'
    });
    expect(storage.getInfo()).toMatchObject({
        backend: 'file',
        requestedBackend: 'db',
        authoritativeSource: 'file'
    });
    expect(storage.getInfo().lastFallback).toMatchObject({
        status: 'applied',
        triggeredBy: 'replaceProviderPoolsSnapshot',
        toBackend: 'file'
    });
    expect(storage.getInfo().lastError).toMatchObject({
        status: 'failed',
        phase: 'write',
        backend: 'file'
    });
    expect(config.RUNTIME_STORAGE_BACKEND).toBe('file');
    expect(config.RUNTIME_STORAGE_DUAL_WRITE).toBe(false);
});
});

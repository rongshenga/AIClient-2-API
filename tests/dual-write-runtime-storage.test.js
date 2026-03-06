import { jest } from '@jest/globals';
import { DualWriteRuntimeStorage } from '../src/storage/backends/dual-write-runtime-storage.js';

function createStorage(backend, overrides = {}) {
    const storage = {
        kind: backend,
        getInfo: jest.fn(() => ({ backend }))
    };

    storage.initialize = jest.fn(async () => storage);
    storage.close = jest.fn(async () => undefined);
    storage.replaceProviderPoolsSnapshot = jest.fn(async (providerPools = {}) => providerPools);
    storage.linkCredentialFiles = jest.fn(async () => ({
        providerPools: {},
        totalNewProviders: 0
    }));
    storage.flushProviderRuntimeState = jest.fn(async (records = []) => ({
        flushedCount: records.length
    }));
    storage.saveAdminSession = jest.fn(async (_token, tokenInfo = {}) => tokenInfo);

    return Object.assign(storage, overrides);
}

describe('DualWriteRuntimeStorage', () => {
    test('should wrap primary write failures as retryable runtime storage errors', async () => {
        const primaryError = new Error('database is locked');
        primaryError.code = 'SQLITE_BUSY';

        const primaryStorage = createStorage('sqlite', {
            replaceProviderPoolsSnapshot: jest.fn(async () => {
                throw primaryError;
            })
        });
        const secondaryStorage = createStorage('file');
        const storage = new DualWriteRuntimeStorage(primaryStorage, secondaryStorage);

        await expect(storage.replaceProviderPoolsSnapshot({ 'grok-custom': [] })).rejects.toMatchObject({
            name: 'RuntimeStorageError',
            code: 'runtime_storage_primary_write_failed',
            phase: 'write_primary',
            domain: 'runtime_storage',
            backend: 'sqlite',
            operation: 'replaceProviderPoolsSnapshot',
            retryable: true,
            details: expect.objectContaining({
                storageRole: 'primary',
                backendErrorCode: 'SQLITE_BUSY'
            })
        });
        expect(secondaryStorage.replaceProviderPoolsSnapshot).not.toHaveBeenCalled();
    });

    test('should sync linkCredentialFiles provider pools to secondary storage', async () => {
        const providerPools = {
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Linked Grok'
                }
            ]
        };

        const primaryStorage = createStorage('sqlite', {
            linkCredentialFiles: jest.fn(async () => ({
                providerPools,
                totalNewProviders: 1
            }))
        });
        const secondaryStorage = createStorage('file');
        const storage = new DualWriteRuntimeStorage(primaryStorage, secondaryStorage);

        const result = await storage.linkCredentialFiles(['/tmp/grok-1.json'], {
            sourceKind: 'test_link'
        });

        expect(result).toMatchObject({
            providerPools,
            totalNewProviders: 1
        });
        expect(secondaryStorage.replaceProviderPoolsSnapshot).toHaveBeenCalledWith(providerPools, {
            sourceKind: 'test_link'
        });
    });

    test('should wrap secondary write failures without masking the primary write result', async () => {
        const secondaryError = new Error('secondary file write failed');

        const primaryStorage = createStorage('sqlite');
        const secondaryStorage = createStorage('file', {
            replaceProviderPoolsSnapshot: jest.fn(async () => {
                throw secondaryError;
            })
        });
        const storage = new DualWriteRuntimeStorage(primaryStorage, secondaryStorage);

        await expect(storage.replaceProviderPoolsSnapshot({ 'grok-custom': [] })).rejects.toMatchObject({
            name: 'RuntimeStorageError',
            code: 'runtime_storage_secondary_write_failed',
            phase: 'write_secondary',
            domain: 'runtime_storage',
            backend: 'file',
            operation: 'replaceProviderPoolsSnapshot',
            retryable: false,
            details: expect.objectContaining({
                storageRole: 'secondary'
            })
        });
        expect(primaryStorage.replaceProviderPoolsSnapshot).toHaveBeenCalledTimes(1);
        expect(secondaryStorage.replaceProviderPoolsSnapshot).toHaveBeenCalledTimes(1);
    });
});

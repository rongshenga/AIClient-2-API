import { SqliteRuntimeStorage } from '../src/storage/backends/sqlite-runtime-storage.js';

describe('SqliteRuntimeStorage wrapped errors', () => {
    let storage;
    let mockClient;

    beforeEach(() => {
        storage = new SqliteRuntimeStorage({
            RUNTIME_STORAGE_DB_PATH: '/tmp/runtime-storage-errors.sqlite',
            PROVIDER_POOLS_FILE_PATH: '/tmp/provider_pools.json',
            LOG_OUTPUT_MODE: 'none'
        });
        mockClient = {
            exec: jest.fn(async () => undefined),
            query: jest.fn(async () => [])
        };
        storage.client = mockClient;
        storage.initialize = jest.fn(async () => storage);
    });

    test('should wrap repository timeout errors on read operations', async () => {
        const timeoutError = Object.assign(new Error('timed out'), {
            code: 'ETIMEDOUT'
        });
        mockClient.query.mockRejectedValue(timeoutError);

        await expect(storage.loadUsageCacheSnapshot()).rejects.toMatchObject({
            name: 'RuntimeStorageError',
            classification: 'lock_conflict',
            phase: 'read',
            domain: 'usage',
            backend: 'db',
            operation: 'loadUsageCacheSnapshot',
            retryable: true
        });
    });

    test('should wrap backend unavailable failures on write operations', async () => {
        const backendError = Object.assign(new Error('spawn sqlite3 ENOENT'), {
            code: 'ENOENT'
        });
        mockClient.exec.mockRejectedValue(backendError);

        await expect(storage.saveAdminSession('token-1', {
            username: 'admin'
        })).rejects.toMatchObject({
            classification: 'backend_unavailable',
            phase: 'write',
            domain: 'session',
            operation: 'saveAdminSession'
        });
    });

    test('should wrap serialization failures before issuing potluck writes', async () => {
        const circular = {};
        circular.self = circular;

        await expect(storage.savePotluckUserData({
            config: circular,
            users: {}
        })).rejects.toMatchObject({
            classification: 'data_error',
            phase: 'write',
            domain: 'potluck',
            operation: 'savePotluckUserData',
            retryable: false
        });
        expect(mockClient.exec).not.toHaveBeenCalled();
    });
});

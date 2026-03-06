import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { promises as fs } from 'fs';
import { jest } from '@jest/globals';

const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    initialize: jest.fn(),
    cleanupOldLogs: jest.fn()
};

let initializeRuntimeStorage;
let closeRuntimeStorage;
let verifyToken;
let handleLoginRequest;
let initializeUserDataManager;
let resetUserDataManagerForTests;
let updateConfig;
let getConfig;
let addUserCredential;
let getUserCredentials;
let initializeKeyManager;
let resetKeyManagerForTests;
let setConfigGetter;
let createKey;
let getKey;
let incrementUsage;
let applyDailyLimitToAllKeys;

async function createTempDir(prefix) {
    return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

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

function createJsonPostReq(payload) {
    const req = new PassThrough();
    req.method = 'POST';
    req.headers = {
        'content-type': 'application/json',
        'user-agent': 'jest-auth-potluck'
    };
    req.socket = { remoteAddress: '127.0.0.1' };
    process.nextTick(() => {
        req.end(JSON.stringify(payload));
    });
    return req;
}

describe('Auth and potluck runtime storage integration', () => {
    beforeAll(async () => {
        jest.resetModules();
        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));
        ({ initializeRuntimeStorage, closeRuntimeStorage } = await import('../src/storage/runtime-storage-registry.js'));
        ({ verifyToken, handleLoginRequest } = await import('../src/ui-modules/auth.js'));
        ({
            initializeUserDataManager,
            resetUserDataManagerForTests,
            updateConfig,
            getConfig,
            addUserCredential,
            getUserCredentials
        } = await import('../src/plugins/api-potluck/user-data-manager.js'));
        ({
            initializeKeyManager,
            resetKeyManagerForTests,
            setConfigGetter,
            createKey,
            getKey,
            incrementUsage,
            applyDailyLimitToAllKeys
        } = await import('../src/plugins/api-potluck/key-manager.js'));
    });

    afterEach(async () => {
        await closeRuntimeStorage();
        await resetUserDataManagerForTests();
        await resetKeyManagerForTests();
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
        mockLogger.initialize.mockClear();
        mockLogger.cleanupOldLogs.mockClear();
    });

    test('should restore admin sessions from sqlite-backed runtime storage after restart', async () => {
        const tempDir = await createTempDir('auth-runtime-storage-');
        const dbPath = path.join(tempDir, 'runtime.sqlite');
        const config = {
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: dbPath,
            PROVIDER_POOLS_FILE_PATH: path.join(tempDir, 'provider_pools.json')
        };

        await initializeRuntimeStorage(config);
        const req = createJsonPostReq({ password: 'admin123' });
        const res = createMockRes();
        const handled = await handleLoginRequest(req, res);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        const loginPayload = JSON.parse(res.body);
        expect(loginPayload.success).toBe(true);
        expect(await verifyToken(loginPayload.token)).toMatchObject({
            username: 'admin',
            userAgent: 'jest-auth-potluck'
        });

        await closeRuntimeStorage();
        await initializeRuntimeStorage(config);
        expect(await verifyToken(loginPayload.token)).toMatchObject({
            username: 'admin',
            userAgent: 'jest-auth-potluck'
        });
    });

    test('should restore potluck config, credentials and key usage after restart', async () => {
        const tempDir = await createTempDir('potluck-runtime-storage-');
        const dbPath = path.join(tempDir, 'runtime.sqlite');
        const config = {
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: dbPath,
            PROVIDER_POOLS_FILE_PATH: path.join(tempDir, 'provider_pools.json')
        };

        await initializeRuntimeStorage(config);
        await initializeUserDataManager(true);
        setConfigGetter(getConfig);
        await initializeKeyManager(true);

        await updateConfig({
            defaultDailyLimit: 701,
            bonusPerCredential: 334,
            bonusValidityDays: 21,
            persistInterval: 1000
        });

        const keyData = await createKey('Demo Key', 701);
        await addUserCredential(keyData.id, {
            path: 'configs/kiro/demo.json',
            provider: 'claude-kiro-oauth',
            authMethod: 'builder-id'
        });
        await incrementUsage(keyData.id);
        await applyDailyLimitToAllKeys(702);

        await closeRuntimeStorage();
        await resetUserDataManagerForTests();
        await resetKeyManagerForTests();

        await initializeRuntimeStorage(config);
        await initializeUserDataManager(true);
        setConfigGetter(getConfig);
        await initializeKeyManager(true);

        expect(getConfig()).toMatchObject({
            defaultDailyLimit: 701,
            bonusPerCredential: 334,
            bonusValidityDays: 21,
            persistInterval: 1000
        });
        expect(getUserCredentials(keyData.id)).toHaveLength(1);
        const restoredKey = await getKey(keyData.id);
        expect(restoredKey).toMatchObject({
            id: keyData.id,
            name: 'Demo Key',
            dailyLimit: 702,
            todayUsage: 1,
            totalUsage: 1,
            enabled: true
        });
    });
});

import os from 'os';
import path from 'path';
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

let closeRuntimeStorage;
let getRuntimeStorage;
let handleUploadOAuthCredentials;
let initializeRuntimeStorage;

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

describe('Upload config runtime storage integration', () => {
    const originalCwd = process.cwd();

    beforeAll(async () => {
        jest.resetModules();
        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));
        jest.doMock('../src/providers/adapter.js', () => ({
            __esModule: true,
            getServiceAdapter: jest.fn(() => ({})),
            serviceInstances: {}
        }));

        ({ handleUploadOAuthCredentials } = await import('../src/ui-modules/event-broadcast.js'));
        ({
            closeRuntimeStorage,
            getRuntimeStorage,
            initializeRuntimeStorage
        } = await import('../src/storage/runtime-storage-registry.js'));
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        await closeRuntimeStorage();
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
        mockLogger.initialize.mockClear();
        mockLogger.cleanupOldLogs.mockClear();
    });

    test('should auto-link uploaded oauth credential through runtime storage in db mode', async () => {
        const tempDir = await createTempDir('upload-config-runtime-storage-');
        const configsDir = path.join(tempDir, 'configs');
        const providerPoolsPath = path.join(configsDir, 'provider_pools.json');
        const dbPath = path.join(tempDir, 'runtime.sqlite');
        const incomingFilePath = path.join(tempDir, 'incoming-account.json');

        await fs.mkdir(configsDir, { recursive: true });
        await fs.writeFile(incomingFilePath, JSON.stringify({ refreshToken: 'refresh-token' }, null, 2), 'utf8');
        process.chdir(tempDir);

        const currentConfig = {
            providerPools: {},
            PROVIDER_POOLS_FILE_PATH: providerPoolsPath,
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: dbPath,
            RUNTIME_STORAGE_AUTO_IMPORT_PROVIDER_POOLS: false,
            LOG_OUTPUT_MODE: 'none'
        };

        const runtimeStorage = await initializeRuntimeStorage(currentConfig);
        currentConfig.RUNTIME_STORAGE_INFO = runtimeStorage.getInfo();

        const req = {};
        const res = createMockRes();
        const customUpload = {
            single: () => (request, response, callback) => {
                request.file = {
                    path: incomingFilePath,
                    filename: 'account.json',
                    originalname: 'account.json'
                };
                request.body = {
                    provider: 'kiro'
                };
                callback(null);
            }
        };

        const handled = await handleUploadOAuthCredentials(req, res, {
            currentConfig,
            customUpload,
            logPrefix: '[Upload Config Test]'
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);

        const payload = JSON.parse(res.body);
        expect(payload.success).toBe(true);
        expect(payload.filePath).toContain('configs/kiro/');

        await expect(fs.stat(path.join(tempDir, payload.filePath))).resolves.toBeTruthy();
        await expect(fs.stat(providerPoolsPath)).rejects.toMatchObject({ code: 'ENOENT' });

        const persistedSnapshot = await getRuntimeStorage().exportProviderPoolsSnapshot();
        expect(persistedSnapshot['claude-kiro-oauth']).toHaveLength(1);
        expect(persistedSnapshot['claude-kiro-oauth'][0].KIRO_OAUTH_CREDS_FILE_PATH).toContain(payload.filePath);
        expect(currentConfig.providerPools['claude-kiro-oauth']).toHaveLength(1);
    });
});

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

let autoLinkProviderConfigs;
let closeRuntimeStorage;
let getProviderPoolManager;
let getRuntimeStorage;
let initApiService;
let initializeRuntimeStorage;

async function createTempDir(prefix) {
    return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('Service manager runtime storage auto-link', () => {
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

        ({
            autoLinkProviderConfigs,
            getProviderPoolManager,
            initApiService
        } = await import('../src/services/service-manager.js'));
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

    test('should auto-link credentials through runtime storage without rewriting provider_pools.json in db mode', async () => {
        const tempDir = await createTempDir('service-manager-runtime-storage-');
        const configsDir = path.join(tempDir, 'configs');
        const providerPoolsPath = path.join(configsDir, 'provider_pools.json');
        const credentialPath = path.join(configsDir, 'kiro', 'account.json');
        const dbPath = path.join(tempDir, 'runtime.sqlite');

        await fs.mkdir(path.dirname(credentialPath), { recursive: true });
        await fs.writeFile(credentialPath, JSON.stringify({ refreshToken: 'refresh-token' }, null, 2), 'utf8');
        process.chdir(tempDir);

        const config = {
            providerPools: {},
            PROVIDER_POOLS_FILE_PATH: providerPoolsPath,
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: dbPath,
            RUNTIME_STORAGE_AUTO_IMPORT_PROVIDER_POOLS: false,
            LOG_OUTPUT_MODE: 'none'
        };

        const runtimeStorage = await initializeRuntimeStorage(config);
        config.RUNTIME_STORAGE_INFO = runtimeStorage.getInfo();

        const providerPools = await autoLinkProviderConfigs(config);
        expect(providerPools['claude-kiro-oauth']).toHaveLength(1);
        expect(config.providerPools['claude-kiro-oauth']).toHaveLength(1);

        const persistedSnapshot = await getRuntimeStorage().exportProviderPoolsSnapshot();
        expect(persistedSnapshot['claude-kiro-oauth']).toHaveLength(1);
        expect(persistedSnapshot['claude-kiro-oauth'][0].KIRO_OAUTH_CREDS_FILE_PATH).toContain('configs/kiro/account.json');

        await expect(fs.stat(providerPoolsPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    test('should batch-link provided credential paths through runtime storage in db mode', async () => {
        const tempDir = await createTempDir('service-manager-runtime-storage-batch-');
        const configsDir = path.join(tempDir, 'configs');
        const providerPoolsPath = path.join(configsDir, 'provider_pools.json');
        const kiroCredentialPath = path.join(configsDir, 'kiro', 'account.json');
        const geminiCredentialPath = path.join(configsDir, 'gemini', 'account.json');
        const dbPath = path.join(tempDir, 'runtime.sqlite');

        await fs.mkdir(path.dirname(kiroCredentialPath), { recursive: true });
        await fs.mkdir(path.dirname(geminiCredentialPath), { recursive: true });
        await fs.writeFile(kiroCredentialPath, JSON.stringify({ refreshToken: 'refresh-token' }, null, 2), 'utf8');
        await fs.writeFile(geminiCredentialPath, JSON.stringify({ refresh_token: 'refresh-token', project_id: 'project-1' }, null, 2), 'utf8');
        process.chdir(tempDir);

        const config = {
            providerPools: {},
            PROVIDER_POOLS_FILE_PATH: providerPoolsPath,
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: dbPath,
            RUNTIME_STORAGE_AUTO_IMPORT_PROVIDER_POOLS: false,
            LOG_OUTPUT_MODE: 'none'
        };

        const runtimeStorage = await initializeRuntimeStorage(config);
        config.RUNTIME_STORAGE_INFO = runtimeStorage.getInfo();

        const providerPools = await autoLinkProviderConfigs(config, {
            credPaths: [
                'configs/kiro/account.json',
                'configs/gemini/account.json',
                'configs/kiro/account.json'
            ]
        });

        expect(providerPools['claude-kiro-oauth']).toHaveLength(1);
        expect(providerPools['gemini-cli-oauth']).toHaveLength(1);
        expect(config.providerPools['claude-kiro-oauth']).toHaveLength(1);
        expect(config.providerPools['gemini-cli-oauth']).toHaveLength(1);

        const persistedSnapshot = await getRuntimeStorage().exportProviderPoolsSnapshot();
        expect(persistedSnapshot['claude-kiro-oauth']).toHaveLength(1);
        expect(persistedSnapshot['gemini-cli-oauth']).toHaveLength(1);
        expect(persistedSnapshot['claude-kiro-oauth'][0].KIRO_OAUTH_CREDS_FILE_PATH).toContain('configs/kiro/account.json');
        expect(persistedSnapshot['gemini-cli-oauth'][0].GEMINI_OAUTH_CREDS_FILE_PATH).toContain('configs/gemini/account.json');

        await expect(fs.stat(providerPoolsPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    test('should wire ProviderPoolManager runtime flushes to active runtime storage during service init', async () => {
        const tempDir = await createTempDir('service-manager-runtime-storage-flush-');
        const configsDir = path.join(tempDir, 'configs');
        const providerPoolsPath = path.join(configsDir, 'provider_pools.json');
        const dbPath = path.join(tempDir, 'runtime.sqlite');

        await fs.mkdir(configsDir, { recursive: true });
        process.chdir(tempDir);

        const config = {
            REQUIRED_API_KEY: '123456',
            MODEL_PROVIDER: 'grok-custom',
            DEFAULT_MODEL_PROVIDERS: ['grok-custom'],
            providerPools: {},
            PROVIDER_POOLS_FILE_PATH: providerPoolsPath,
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: dbPath,
            RUNTIME_STORAGE_AUTO_IMPORT_PROVIDER_POOLS: false,
            STARTUP_PRELOAD_MAX_PER_PROVIDER: 0,
            STARTUP_PRELOAD_MAX_TOTAL: 0,
            LOG_OUTPUT_MODE: 'none'
        };

        const runtimeStorage = await initializeRuntimeStorage(config);
        await runtimeStorage.replaceProviderPoolsSnapshot({
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Grok One',
                    GROK_COOKIE_TOKEN: 'cookie-token',
                    isHealthy: true,
                    isDisabled: false,
                    usageCount: 0,
                    errorCount: 0,
                    checkModelName: 'grok-3'
                }
            ]
        }, {
            sourceKind: 'test_seed'
        });

        config.RUNTIME_STORAGE_INFO = runtimeStorage.getInfo();
        config.providerPools = await runtimeStorage.loadProviderPoolsSnapshot({
            filePath: providerPoolsPath,
            autoImportFromFile: false
        });

        await initApiService(config);
        const providerPoolManager = getProviderPoolManager();
        expect(providerPoolManager).toBeTruthy();
        expect(providerPoolManager.runtimeStorage).toBeTruthy();

        const selectedProvider = await providerPoolManager.selectProvider('grok-custom');
        expect(selectedProvider?.uuid).toBe('grok-1');
        await providerPoolManager._flushPendingSaves();

        const persistedSnapshot = await getRuntimeStorage().exportProviderPoolsSnapshot();
        expect(persistedSnapshot['grok-custom'][0]).toMatchObject({
            uuid: 'grok-1',
            usageCount: 1
        });
    });
});

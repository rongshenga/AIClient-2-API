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

let initializeConfig;
let reloadConfig;
let closeRuntimeStorage;

async function createTempDir(prefix) {
    return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('Config reload runtime storage compatibility', () => {
    const originalCwd = process.cwd();

    beforeAll(async () => {
        jest.resetModules();
        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));
        jest.doMock('../src/services/service-manager.js', () => ({
            __esModule: true,
            initApiService: jest.fn()
        }));
        jest.doMock('../src/providers/adapter.js', () => ({
            __esModule: true,
            serviceInstances: {}
        }));

        ({ initializeConfig } = await import('../src/core/config-manager.js'));
        ({ reloadConfig } = await import('../src/ui-modules/config-api.js'));
        ({ closeRuntimeStorage } = await import('../src/storage/runtime-storage-registry.js'));
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

    test('should reload provider pools from sqlite runtime storage without raw provider file', async () => {
        const tempDir = await createTempDir('config-reload-runtime-storage-');
        const configsDir = path.join(tempDir, 'configs');
        const promptPath = path.join(configsDir, 'prompt.txt');
        const configPath = path.join(configsDir, 'config.json');
        const poolsPath = path.join(configsDir, 'provider_pools.json');
        const dbPath = path.join(configsDir, 'runtime.sqlite');

        await fs.mkdir(configsDir, { recursive: true });
        await fs.writeFile(promptPath, 'system prompt', 'utf8');
        await fs.writeFile(poolsPath, JSON.stringify({
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Reload Grok',
                    GROK_COOKIE_TOKEN: 'reload-token',
                    isHealthy: true,
                    usageCount: 2,
                    errorCount: 1,
                    checkModelName: 'grok-3'
                }
            ]
        }, null, 2), 'utf8');
        await fs.writeFile(configPath, JSON.stringify({
            REQUIRED_API_KEY: '123456',
            SERVER_PORT: 3000,
            HOST: '0.0.0.0',
            MODEL_PROVIDER: 'grok-custom',
            SYSTEM_PROMPT_FILE_PATH: './configs/prompt.txt',
            SYSTEM_PROMPT_MODE: 'overwrite',
            PROVIDER_POOLS_FILE_PATH: './configs/provider_pools.json',
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: './configs/runtime.sqlite',
            RUNTIME_STORAGE_AUTO_IMPORT_PROVIDER_POOLS: true,
            RUNTIME_STORAGE_FALLBACK_TO_FILE: true,
            LOG_OUTPUT_MODE: 'none'
        }, null, 2), 'utf8');

        process.chdir(tempDir);

        const firstConfig = await initializeConfig([], configPath);
        expect(firstConfig.RUNTIME_STORAGE_INFO.backend).toBe('db');
        expect(firstConfig.providerPools['grok-custom'][0]).toMatchObject({
            uuid: 'grok-1',
            customName: 'Reload Grok',
            GROK_COOKIE_TOKEN: 'reload-token'
        });

        await fs.writeFile(poolsPath, JSON.stringify({}, null, 2), 'utf8');

        const reloadedConfig = await reloadConfig(null);
        expect(reloadedConfig.RUNTIME_STORAGE_INFO.backend).toBe('db');
        expect(reloadedConfig.providerPools['grok-custom'][0]).toMatchObject({
            uuid: 'grok-1',
            customName: 'Reload Grok',
            GROK_COOKIE_TOKEN: 'reload-token'
        });
    });


    test('should flush pending provider runtime state before config reload', async () => {
        const tempDir = await createTempDir('config-reload-runtime-flush-');
        const configsDir = path.join(tempDir, 'configs');
        const promptPath = path.join(configsDir, 'prompt.txt');
        const configPath = path.join(configsDir, 'config.json');
        const poolsPath = path.join(configsDir, 'provider_pools.json');
        const dbPath = path.join(configsDir, 'runtime.sqlite');

        await fs.mkdir(configsDir, { recursive: true });
        await fs.writeFile(promptPath, 'system prompt', 'utf8');
        await fs.writeFile(poolsPath, JSON.stringify({
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Reload Grok',
                    GROK_COOKIE_TOKEN: 'reload-token',
                    isHealthy: true,
                    usageCount: 2,
                    errorCount: 1,
                    checkModelName: 'grok-3'
                }
            ]
        }, null, 2), 'utf8');
        await fs.writeFile(configPath, JSON.stringify({
            REQUIRED_API_KEY: '123456',
            SERVER_PORT: 3000,
            HOST: '0.0.0.0',
            MODEL_PROVIDER: 'grok-custom',
            SYSTEM_PROMPT_FILE_PATH: './configs/prompt.txt',
            SYSTEM_PROMPT_MODE: 'overwrite',
            PROVIDER_POOLS_FILE_PATH: './configs/provider_pools.json',
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: './configs/runtime.sqlite',
            RUNTIME_STORAGE_AUTO_IMPORT_PROVIDER_POOLS: true,
            RUNTIME_STORAGE_FALLBACK_TO_FILE: true,
            LOG_OUTPUT_MODE: 'none'
        }, null, 2), 'utf8');

        process.chdir(tempDir);
        await initializeConfig([], configPath);

        const providerPoolManager = {
            flushRuntimeState: jest.fn(async () => ({
                flushedCount: 1,
                flushReason: 'reload'
            })),
            initializeProviderStatus: jest.fn()
        };

        const reloadedConfig = await reloadConfig(providerPoolManager);
        expect(reloadedConfig.RUNTIME_STORAGE_INFO.backend).toBe('db');
        expect(providerPoolManager.flushRuntimeState).toHaveBeenCalledWith({
            reason: 'reload',
            requestedBy: 'config-api'
        });
        expect(providerPoolManager.initializeProviderStatus).toHaveBeenCalled();
    });

    test('should rebuild provider pool manager cache from db compat snapshot during reload', async () => {
        const tempDir = await createTempDir('config-reload-runtime-storage-manager-');
        const configsDir = path.join(tempDir, 'configs');
        const promptPath = path.join(configsDir, 'prompt.txt');
        const configPath = path.join(configsDir, 'config.json');
        const poolsPath = path.join(configsDir, 'provider_pools.json');
        const dbPath = path.join(configsDir, 'runtime.sqlite');

        await fs.mkdir(configsDir, { recursive: true });
        await fs.writeFile(promptPath, 'system prompt', 'utf8');
        await fs.writeFile(poolsPath, JSON.stringify({
            'grok-custom': [
                {
                    uuid: 'grok-cache-1',
                    customName: 'Reload Cache Node',
                    GROK_COOKIE_TOKEN: 'cache-token',
                    isHealthy: true,
                    usageCount: 4,
                    errorCount: 0,
                    checkModelName: 'grok-3'
                }
            ]
        }, null, 2), 'utf8');
        await fs.writeFile(configPath, JSON.stringify({
            REQUIRED_API_KEY: '123456',
            SERVER_PORT: 3000,
            HOST: '0.0.0.0',
            MODEL_PROVIDER: 'grok-custom',
            SYSTEM_PROMPT_FILE_PATH: './configs/prompt.txt',
            SYSTEM_PROMPT_MODE: 'overwrite',
            PROVIDER_POOLS_FILE_PATH: './configs/provider_pools.json',
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: './configs/runtime.sqlite',
            RUNTIME_STORAGE_AUTO_IMPORT_PROVIDER_POOLS: true,
            RUNTIME_STORAGE_FALLBACK_TO_FILE: true,
            LOG_OUTPUT_MODE: 'none'
        }, null, 2), 'utf8');

        process.chdir(tempDir);

        const providerPoolManager = {
            providerPools: { stale: [] },
            initializeProviderStatus: jest.fn(),
            flushRuntimeState: jest.fn()
        };

        const firstConfig = await initializeConfig([], configPath);
        expect(firstConfig.providerPools['grok-custom'][0].uuid).toBe('grok-cache-1');

        await fs.writeFile(poolsPath, JSON.stringify({}, null, 2), 'utf8');

        const reloadedConfig = await reloadConfig(providerPoolManager);
        expect(reloadedConfig.RUNTIME_STORAGE_INFO.backend).toBe('db');
        expect(reloadedConfig.providerPools['grok-custom'][0]).toMatchObject({
            uuid: 'grok-cache-1',
            customName: 'Reload Cache Node',
            GROK_COOKIE_TOKEN: 'cache-token'
        });
        expect(providerPoolManager.flushRuntimeState).toHaveBeenCalledWith(expect.objectContaining({
            reason: 'reload',
            requestedBy: 'config-api'
        }));
        expect(providerPoolManager.providerPools['grok-custom'][0]).toMatchObject({
            uuid: 'grok-cache-1',
            customName: 'Reload Cache Node'
        });
        expect(providerPoolManager.initializeProviderStatus).toHaveBeenCalledTimes(1);
    });
});

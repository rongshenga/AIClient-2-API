import { jest } from '@jest/globals';

const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    initialize: jest.fn(),
    cleanupOldLogs: jest.fn()
};

const mockBroadcastEvent = jest.fn();
const mockGetServiceAdapter = jest.fn();

let ProviderPoolManager;
let SqliteRuntimeStorage;

function padNumber(value) {
    return String(value).padStart(6, '0');
}

function buildProviderRow(index) {
    return {
        provider_id: `prov_gemini_${padNumber(index)}`,
        provider_type: 'gemini-cli-oauth',
        routing_uuid: `gemini-${padNumber(index)}`,
        display_name: `Gemini ${index}`,
        check_model: 'gemini-2.5-pro',
        project_id: `project-${padNumber(index)}`,
        base_url: 'https://gemini.com',
        config_json: JSON.stringify({
            queueLimit: index % 3
        }),
        source_kind: 'large_pool_test',
        created_at: '2026-03-06T00:00:00.000Z',
        updated_at: '2026-03-06T00:00:00.000Z',
        is_healthy: 1,
        is_disabled: 0,
        usage_count: index % 5,
        error_count: 0,
        last_used_at: null,
        last_health_check_at: null,
        last_health_check_model: 'gemini-2.5-pro',
        last_error_time: null,
        last_error_message: null,
        scheduled_recovery_at: null,
        refresh_count: 0,
        last_selection_seq: index
    };
}

function buildProviderConfig(index, overrides = {}) {
    return {
        uuid: `grok-${padNumber(index)}`,
        customName: `Grok ${index}`,
        GROK_BASE_URL: 'https://grok.com',
        isHealthy: true,
        isDisabled: false,
        usageCount: 0,
        errorCount: 0,
        ...overrides
    };
}

function parseLimitOffset(sql) {
    const limitMatch = sql.match(/LIMIT\s+(\d+)\s+OFFSET\s+(\d+)/i);
    if (!limitMatch) {
        return { limit: 0, offset: 0 };
    }
    return {
        limit: Number.parseInt(limitMatch[1], 10),
        offset: Number.parseInt(limitMatch[2], 10)
    };
}

function parseProviderIds(sql) {
    const match = sql.match(/IN\s*\(([^)]+)\)/i);
    if (!match) {
        return [];
    }

    return match[1]
        .split(',')
        .map((item) => item.trim().replace(/^'+|'+$/g, '').replace(/''/g, "'"))
        .filter(Boolean);
}

function createPagedQueryMock(totalProviders, options = {}) {
    const state = {
        countQueries: 0,
        providerQueries: [],
        secretQueries: [],
        credentialQueries: []
    };

    const query = jest.fn(async (sql) => {
        if (/SELECT COUNT\(\*\) AS count FROM provider_registrations;/i.test(sql)) {
            state.countQueries += 1;
            return [{ count: totalProviders }];
        }

        if (/FROM provider_registrations r/i.test(sql)) {
            const { limit, offset } = parseLimitOffset(sql);
            state.providerQueries.push({ limit, offset, sql });
            const length = Math.max(0, Math.min(limit, totalProviders - offset));
            return Array.from({ length }, (_, index) => buildProviderRow(offset + index));
        }

        if (/FROM provider_inline_secrets/i.test(sql)) {
            const providerIds = parseProviderIds(sql);
            state.secretQueries.push({ providerIds, sql });
            if (options.includeOrphanRows && providerIds.includes('prov_gemini_000000')) {
                return [{
                    provider_id: 'orphan_provider',
                    secret_kind: 'GROK_COOKIE_TOKEN',
                    secret_payload: JSON.stringify('orphan-secret')
                }];
            }
            return [];
        }

        if (/FROM credential_bindings b/i.test(sql)) {
            const providerIds = parseProviderIds(sql);
            state.credentialQueries.push({ providerIds, sql });
            const rows = [];
            if (providerIds.includes('prov_gemini_000000')) {
                rows.push({
                    provider_id: 'prov_gemini_000000',
                    credential_asset_id: 'asset_primary',
                    file_path: 'configs/gemini/primary.json',
                    source_path: 'configs/gemini/primary.json'
                });
            }
            if (options.includeDuplicateCredential && providerIds.includes('prov_gemini_000000')) {
                rows.push({
                    provider_id: 'prov_gemini_000000',
                    credential_asset_id: 'asset_duplicate',
                    file_path: 'configs/gemini/duplicate.json',
                    source_path: 'configs/gemini/duplicate.json'
                });
            }
            if (options.includeOrphanRows && providerIds.includes('prov_gemini_000000')) {
                rows.push({
                    provider_id: 'orphan_provider',
                    credential_asset_id: 'asset_orphan',
                    file_path: 'configs/gemini/orphan.json',
                    source_path: 'configs/gemini/orphan.json'
                });
            }
            return rows;
        }

        return [];
    });

    return {
        state,
        client: {
            exec: jest.fn(async () => undefined),
            query
        }
    };
}

describe('Runtime storage large-pool boundaries', () => {
    beforeAll(async () => {
        jest.resetModules();
        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));
        jest.doMock('../src/ui-modules/event-broadcast.js', () => ({
            broadcastEvent: mockBroadcastEvent
        }));
        jest.doMock('../src/providers/adapter.js', () => ({
            getServiceAdapter: mockGetServiceAdapter,
            getRegisteredProviders: jest.fn(() => [])
        }));

        ({ ProviderPoolManager } = await import('../src/providers/provider-pool-manager.js'));
        ({ SqliteRuntimeStorage } = await import('../src/storage/backends/sqlite-runtime-storage.js'));
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test.each([
        { totalProviders: 0, expectedPages: 0 },
        { totalProviders: 1, expectedPages: 1 },
        { totalProviders: 1000, expectedPages: 1 },
        { totalProviders: 1001, expectedPages: 2 }
    ])('should export compat snapshot across boundary dataset $totalProviders', async ({ totalProviders, expectedPages }) => {
        const storage = new SqliteRuntimeStorage({
            RUNTIME_STORAGE_DB_PATH: '/tmp/runtime-storage-large-pool.sqlite',
            PROVIDER_POOLS_FILE_PATH: '/tmp/provider_pools.json',
            RUNTIME_STORAGE_COMPAT_EXPORT_PAGE_SIZE: 1000,
            LOG_OUTPUT_MODE: 'none'
        });
        const { client, state } = createPagedQueryMock(totalProviders, {
            includeDuplicateCredential: totalProviders > 0,
            includeOrphanRows: totalProviders > 0
        });
        storage.client = client;
        storage.initialize = jest.fn(async () => storage);

        const snapshot = await storage.exportProviderPoolsSnapshot();
        const exportedCount = snapshot['gemini-cli-oauth']?.length || 0;

        expect(exportedCount).toBe(totalProviders);
        expect(state.countQueries).toBe(1);
        expect(state.providerQueries).toHaveLength(expectedPages);
        expect(state.secretQueries).toHaveLength(expectedPages);
        expect(state.credentialQueries).toHaveLength(expectedPages);

        if (totalProviders > 0) {
            expect(snapshot['gemini-cli-oauth'][0]).toMatchObject({
                uuid: 'gemini-000000',
                PROJECT_ID: 'project-000000',
                GEMINI_OAUTH_CREDS_FILE_PATH: './configs/gemini/primary.json'
            });
            expect(snapshot['gemini-cli-oauth'][0].GROK_COOKIE_TOKEN).toBeUndefined();
        }
    });

    test('should use configured startup restore page size when loading provider snapshot', async () => {
        const storage = new SqliteRuntimeStorage({
            RUNTIME_STORAGE_DB_PATH: '/tmp/runtime-storage-restore.sqlite',
            PROVIDER_POOLS_FILE_PATH: '/tmp/provider_pools.json',
            RUNTIME_STORAGE_COMPAT_EXPORT_PAGE_SIZE: 1000,
            RUNTIME_STORAGE_STARTUP_RESTORE_PAGE_SIZE: 2000,
            LOG_OUTPUT_MODE: 'none'
        });
        const { client, state } = createPagedQueryMock(2001);
        storage.client = client;
        storage.initialize = jest.fn(async () => storage);
        storage.fileStorage = {
            loadProviderPoolsSnapshot: jest.fn(async () => ({}))
        };

        const snapshot = await storage.loadProviderPoolsSnapshot({
            autoImportFromFile: false
        });

        expect(snapshot['gemini-cli-oauth']).toHaveLength(2001);
        expect(state.countQueries).toBe(1);
        expect(state.providerQueries.map((item) => [item.limit, item.offset])).toEqual([
            [2000, 0],
            [2000, 2000]
        ]);
        expect(storage.getInfo()).toMatchObject({
            compatExportPageSize: 1000,
            startupRestorePageSize: 2000
        });
    });

    test('should export 100000-provider snapshot with paged query fan-out bounded by page size', async () => {
        const storage = new SqliteRuntimeStorage({
            RUNTIME_STORAGE_DB_PATH: '/tmp/runtime-storage-100k.sqlite',
            PROVIDER_POOLS_FILE_PATH: '/tmp/provider_pools.json',
            RUNTIME_STORAGE_COMPAT_EXPORT_PAGE_SIZE: 1000,
            LOG_OUTPUT_MODE: 'none'
        });
        const { client, state } = createPagedQueryMock(100000);
        storage.client = client;
        storage.initialize = jest.fn(async () => storage);

        const startedAt = Date.now();
        const snapshot = await storage.exportProviderPoolsSnapshot();
        const elapsedMs = Date.now() - startedAt;

        expect(snapshot['gemini-cli-oauth']).toHaveLength(100000);
        expect(state.providerQueries).toHaveLength(100);
        expect(state.secretQueries).toHaveLength(100);
        expect(state.credentialQueries).toHaveLength(100);
        expect(state.providerQueries[0]).toMatchObject({ limit: 1000, offset: 0 });
        expect(state.providerQueries.at(-1)).toMatchObject({ limit: 1000, offset: 99000 });
        expect(elapsedMs).toBeLessThan(10000);
    }, 20000);

    test('should select from a 100000-provider pool via grouped hot path and advance cursor', async () => {
        const providers = Array.from({ length: 100000 }, (_, index) => buildProviderConfig(index, {
            isHealthy: index >= 100
        }));
        const manager = new ProviderPoolManager({
            'grok-custom': providers
        }, {
            globalConfig: {
                LOG_LEVEL: 'error',
                PERSIST_SELECTION_STATE: false,
                POOL_GROUP_SIZE: 100,
                POOL_GROUP_MIN_POOL_SIZE: 2000,
                POOL_GROUP_UNHEALTHY_RATIO_THRESHOLD: 0.8,
                POOL_GROUP_MIN_HEALTHY: 1
            },
            runtimeStorage: {
                flushProviderRuntimeState: jest.fn(async () => ({ flushedCount: 0 })),
                updateProviderRoutingUuid: jest.fn(async () => ({ updated: false }))
            }
        });

        const startedAt = Date.now();
        const selected = await manager.selectProvider('grok-custom', null, { skipUsageCount: true });
        const elapsedMs = Date.now() - startedAt;

        expect(selected).toMatchObject({
            uuid: 'grok-000100'
        });
        expect(manager._groupCursor['grok-custom']).toBe(2);
        expect(manager.pendingSaves.size).toBe(0);
        expect(elapsedMs).toBeLessThan(3000);
    }, 15000);
});

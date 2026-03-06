import { jest } from '@jest/globals';

const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

const mockBroadcastEvent = jest.fn();
const mockGetServiceAdapter = jest.fn();

let ProviderPoolManager;

describe('ProviderPoolManager refresh recovery', () => {
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

        const module = await import('../src/providers/provider-pool-manager.js');
        ProviderPoolManager = module.ProviderPoolManager;
    });

    beforeEach(() => {
        mockBroadcastEvent.mockReset();
        mockGetServiceAdapter.mockReset();
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
    });

    test('resetProviderRefreshStatus should recover unhealthy provider state after refresh succeeds', () => {
        const providerType = 'gemini-cli-oauth';
        const provider = {
            config: {
                uuid: 'gemini-1',
                isHealthy: false,
                needsRefresh: true,
                refreshCount: 3,
                errorCount: 10,
                lastErrorTime: '2026-03-06T01:02:03.000Z',
                lastErrorMessage: 'Refresh failed: token expired',
                scheduledRecoveryTime: '2026-03-06T03:00:00.000Z',
                _lastSelectionSeq: 99
            }
        };

        const manager = Object.create(ProviderPoolManager.prototype);
        manager._findProvider = jest.fn(() => provider);
        manager._debouncedSave = jest.fn();
        manager._logHealthStatusChange = jest.fn();
        manager._log = jest.fn();
        manager._minSelectionSeqByType = {
            [providerType]: 99
        };

        manager.resetProviderRefreshStatus(providerType, 'gemini-1');

        expect(provider.config.isHealthy).toBe(true);
        expect(provider.config.needsRefresh).toBe(false);
        expect(provider.config.refreshCount).toBe(0);
        expect(provider.config.errorCount).toBe(0);
        expect(provider.config.lastErrorTime).toBeNull();
        expect(provider.config.lastErrorMessage).toBeNull();
        expect(provider.config.scheduledRecoveryTime).toBeNull();
        expect(provider.config._lastSelectionSeq).toBe(0);
        expect(typeof provider.config.lastHealthCheckTime).toBe('string');
        expect(manager._minSelectionSeqByType[providerType]).toBe(0);
        expect(manager._logHealthStatusChange).toHaveBeenCalledWith(providerType, provider.config, 'unhealthy', 'healthy', null);
        expect(manager._log).toHaveBeenCalledWith('info', `Reset refresh status and marked healthy for provider gemini-1 (${providerType})`);
        expect(manager._debouncedSave).toHaveBeenCalledWith(providerType);
    });

    test('refresh limit reason should use the configured max attempts consistently', async () => {
        const providerType = 'gemini-cli-oauth';
        const config = {
            uuid: 'gemini-2',
            refreshCount: ProviderPoolManager.MAX_REFRESH_ATTEMPTS
        };
        const providerStatus = {
            uuid: 'gemini-2',
            config
        };

        const manager = Object.create(ProviderPoolManager.prototype);
        manager._log = jest.fn();
        manager.markProviderUnhealthyImmediately = jest.fn();

        await manager._refreshNodeToken(providerType, providerStatus);

        const reason = `Maximum refresh count (${ProviderPoolManager.MAX_REFRESH_ATTEMPTS}) reached`;
        expect(manager._log).toHaveBeenCalledWith('warn', `Node gemini-2 has reached ${reason}, marking as unhealthy`);
        expect(manager.markProviderUnhealthyImmediately).toHaveBeenCalledWith(providerType, config, reason);
        expect(mockGetServiceAdapter).not.toHaveBeenCalled();
    });
});

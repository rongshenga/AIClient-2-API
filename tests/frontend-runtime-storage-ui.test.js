import { jest } from '@jest/globals';

function createClassList(initial = []) {
    const classes = new Set(initial);
    return {
        add(name) {
            classes.add(name);
        },
        remove(name) {
            classes.delete(name);
        },
        toggle(name, force) {
            if (force === undefined) {
                if (classes.has(name)) {
                    classes.delete(name);
                    return false;
                }
                classes.add(name);
                return true;
            }
            if (force) {
                classes.add(name);
                return true;
            }
            classes.delete(name);
            return false;
        },
        contains(name) {
            return classes.has(name);
        }
    };
}

function createMockElement(initial = {}) {
    const listeners = new Map();
    const attributes = new Map();
    return {
        className: initial.className || '',
        classList: initial.classList || createClassList(initial.classes || []),
        style: initial.style || {},
        dataset: initial.dataset || {},
        hidden: initial.hidden ?? false,
        disabled: initial.disabled ?? false,
        textContent: initial.textContent || '',
        innerHTML: initial.innerHTML || '',
        title: initial.title || '',
        children: [],
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        querySelector: initial.querySelector || jest.fn(() => null),
        setAttribute(name, value) {
            attributes.set(name, String(value));
            if (name.startsWith('data-')) {
                const datasetKey = name.slice(5).replace(/-([a-z])/g, (_, part) => part.toUpperCase());
                this.dataset[datasetKey] = String(value);
            }
            this[name] = String(value);
        },
        getAttribute(name) {
            return attributes.get(name) ?? null;
        },
        addEventListener(type, handler) {
            listeners.set(type, handler);
        },
        trigger(type, event = {}) {
            const handler = listeners.get(type);
            if (handler) {
                return handler(event);
            }
            return undefined;
        }
    };
}

function createDiagnosticsContainer() {
    const nodes = {
        '#runtimeStorageMode': createMockElement(),
        '#runtimeStorageSource': createMockElement(),
        '#runtimeStorageProviderSummary': createMockElement(),
        '#runtimeStorageValidation': createMockElement(),
        '#runtimeStorageFallback': createMockElement(),
        '#runtimeStorageError': createMockElement(),
        '#runtimeStorageAlert': createMockElement({ hidden: true, dataset: {} }),
        '#runtimeStorageReloadBtn': createMockElement(),
        '#runtimeStorageExportBtn': createMockElement(),
        '#runtimeStorageRollbackBtn': createMockElement()
    };

    const container = createMockElement({ dataset: {} });
    container.querySelector = jest.fn((selector) => nodes[selector] || null);
    return {
        container,
        nodes
    };
}

describe('frontend event stream and usage manager', () => {
    let showToast;
    let loadProviders;
    let refreshProviderConfig;
    let loadConfigList;
    let dispatchEvent;
    let eventStreamModule;
    let usageManagerModule;
    let usageSection;
    let usageLoadingText;
    let usageLoading;
    let usageError;
    let usageErrorMessage;
    let usageEmpty;
    let usageContent;
    let usageLastUpdate;
    let refreshUsageBtn;
    let fetchCalls;
    let serverTimeValue;

    beforeEach(async () => {
        jest.resetModules();
        showToast = jest.fn();
        loadProviders = jest.fn();
        refreshProviderConfig = jest.fn();
        loadConfigList = jest.fn();
        dispatchEvent = jest.fn();
        fetchCalls = [];

        usageSection = createMockElement({ classList: createClassList([]) });
        usageLoadingText = createMockElement();
        usageLoading = createMockElement({
            style: { display: 'none' },
            querySelector: jest.fn((selector) => selector === 'span' ? usageLoadingText : null)
        });
        usageError = createMockElement({ style: { display: 'none' } });
        usageErrorMessage = createMockElement();
        usageEmpty = createMockElement({ style: { display: 'none' } });
        usageContent = createMockElement();
        usageLastUpdate = createMockElement({ dataset: {} });
        refreshUsageBtn = createMockElement({ disabled: false });
        serverTimeValue = createMockElement();

        global.CustomEvent = class CustomEvent {
            constructor(type, init = {}) {
                this.type = type;
                this.detail = init.detail;
            }
        };

        global.window = {
            dispatchEvent,
            confirm: jest.fn(() => true)
        };

        global.document = {
            getElementById: jest.fn((id) => {
                const mapping = {
                    usage: usageSection,
                    usageLoading: usageLoading,
                    usageError: usageError,
                    usageErrorMessage: usageErrorMessage,
                    usageEmpty: usageEmpty,
                    usageContent: usageContent,
                    usageLastUpdate: usageLastUpdate,
                    refreshUsageBtn: refreshUsageBtn,
                    serverTimeValue: serverTimeValue
                };
                return mapping[id] || null;
            }),
            querySelector: jest.fn(() => null),
            createElement: jest.fn(() => createMockElement())
        };

        global.fetch = jest.fn(async (url) => {
            fetchCalls.push(String(url));
            if (String(url) === '/api/usage') {
                return {
                    ok: false,
                    status: 503,
                    statusText: 'Service Unavailable',
                    json: async () => ({})
                };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        jest.doMock('../static/app/i18n.js', () => ({
            t: (key, params = {}) => {
                if (key === 'usage.taskCompleted') return '刷新完成';
                if (key === 'usage.taskFailed') return '刷新失败';
                if (key === 'usage.allProviders') return '全部提供商';
                if (key === 'usage.taskProgress') return `${params.provider}|${params.processed}/${params.total}|${params.percent}`;
                if (key === 'usage.loading') return '加载中';
                if (key === 'usage.taskStarted') return '任务已开始';
                if (key === 'usage.taskPreparing') return '任务准备中';
                if (key === 'usage.lastUpdateCache') return `缓存更新 ${params.time}`;
                if (key === 'usage.lastUpdate') return `实时更新 ${params.time}`;
                if (key === 'common.success') return '成功';
                if (key === 'common.error') return '错误';
                if (key === 'common.info') return '提示';
                return key;
            },
            getCurrentLanguage: () => 'zh-CN'
        }));

        jest.doMock('../static/app/utils.js', () => ({
            escapeHtml: (value) => String(value),
            showToast,
            getProviderConfigs: () => ([
                { id: 'grok-custom', name: 'Grok Reverse' },
                { id: 'openai-codex-oauth', name: 'Codex OAuth' }
            ])
        }));

        jest.doMock('../static/app/constants.js', () => {
            const serverStatus = createMockElement({
                classList: createClassList([]),
                querySelector: jest.fn((selector) => {
                    if (selector === 'i') {
                        return { style: {} };
                    }
                    if (selector === 'span') {
                        return { textContent: '' };
                    }
                    return null;
                })
            });
            return {
                eventSource: null,
                autoScroll: true,
                elements: {
                    serverStatus,
                    logsContainer: null
                },
                addLog: jest.fn(),
                setEventSource: jest.fn()
            };
        });

        jest.doMock('../static/app/auth.js', () => ({
            getAuthHeaders: () => ({ Authorization: 'Bearer test' })
        }));

        eventStreamModule = await import('../static/app/event-stream.js');
        usageManagerModule = await import('../static/app/usage-manager.js');

        eventStreamModule.setProviderLoaders(loadProviders, refreshProviderConfig);
        eventStreamModule.setConfigLoaders(loadConfigList);
    });

    test('should render connected and disconnected server status states', async () => {
        const { elements } = await import('../static/app/constants.js');
        eventStreamModule.updateServerStatus(true);
        expect(elements.serverStatus.classList.contains('error')).toBe(false);
        expect(elements.serverStatus.innerHTML).toContain('header.status.connected');

        eventStreamModule.updateServerStatus(false);
        expect(elements.serverStatus.classList.contains('error')).toBe(true);
        expect(elements.serverStatus.innerHTML).toContain('header.status.disconnected');
    });

    test('should route provider and config updates to the correct loaders', () => {
        const modal = {
            getAttribute: jest.fn(() => 'grok-custom')
        };
        global.document.querySelector.mockReturnValueOnce(modal);
        eventStreamModule.handleProviderUpdate({ action: 'update', providerType: 'grok-custom' });
        expect(refreshProviderConfig).toHaveBeenCalledWith('grok-custom');

        global.document.querySelector.mockReturnValueOnce(null);
        eventStreamModule.handleProviderUpdate({ action: 'delete', providerType: 'openai-codex-oauth' });
        expect(loadProviders).toHaveBeenCalled();

        eventStreamModule.handleConfigUpdate({ action: 'delete' });
        eventStreamModule.handleConfigUpdate({ action: 'add' });
        eventStreamModule.handleConfigUpdate({ action: 'update' });
        eventStreamModule.handleConfigUpdate({ action: 'unknown' });
        expect(loadConfigList).toHaveBeenCalledTimes(4);
    });

    test('should dispatch usage refresh events and suppress toast when usage section is active', () => {
        eventStreamModule.handleUsageRefresh({
            providerType: 'grok-custom',
            status: 'completed'
        });
        expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
            type: 'usage_refresh_event'
        }));
        expect(showToast).toHaveBeenCalledWith('成功', 'Grok Reverse 刷新完成', 'success');

        showToast.mockClear();
        usageSection.classList.add('active');
        eventStreamModule.handleUsageRefresh({
            providerType: 'grok-custom',
            status: 'failed',
            error: 'network down'
        });
        expect(showToast).not.toHaveBeenCalled();
    });

    test('should expose loading helpers and show usage fetch errors in the UI', async () => {
        usageManagerModule.setUsageLoadingText(usageLoading, '刷新中');
        expect(usageLoadingText.textContent).toBe('刷新中');
        expect(usageManagerModule.buildUsageTaskProgressText({
            providerType: 'grok-custom',
            progress: {
                currentProvider: 'openai-codex-oauth',
                processedInstances: 3,
                totalInstances: 7,
                percent: 42.857
            }
        }, 'Fallback')).toBe('Codex OAuth|3/7|42.9');
        expect(usageManagerModule.shouldShowUsage('gemini-antigravity')).toBe(false);
        expect(usageManagerModule.shouldShowUsage('grok-custom')).toBe(true);

        await usageManagerModule.loadUsage();
        expect(fetchCalls).toContain('/api/usage');
        expect(usageError.style.display).toBe('block');
        expect(usageErrorMessage.textContent).toBe('HTTP 503: Service Unavailable');
    });

    test('should toggle loading state and button disablement during successful usage refresh', async () => {
        usageSection.classList.add('active');
        let taskStatusPollCount = 0;
        global.fetch = jest.fn(async (url) => {
            fetchCalls.push(String(url));
            if (String(url) === '/api/usage?refresh=true&async=true') {
                return {
                    ok: true,
                    json: async () => ({
                        taskId: 'task-1',
                        pollIntervalMs: 1
                    })
                };
            }
            if (String(url) === '/api/usage/tasks/task-1') {
                taskStatusPollCount += 1;
                return {
                    ok: true,
                    json: async () => taskStatusPollCount == 1
                        ? {
                            status: 'running',
                            providerType: 'grok-custom',
                            pollIntervalMs: 1,
                            progress: {
                                currentProvider: 'grok-custom',
                                processedInstances: 1,
                                totalInstances: 2,
                                percent: 50
                            }
                        }
                        : {
                            status: 'completed',
                            providerType: 'grok-custom'
                        }
                };
            }
            if (String(url) === '/api/usage') {
                return {
                    ok: true,
                    json: async () => ({
                        providers: {},
                        fromCache: true,
                        timestamp: '2026-03-06T10:00:00.000Z',
                        serverTime: '2026-03-06T10:00:01.000Z'
                    })
                };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const refreshPromise = usageManagerModule.refreshUsage();
        expect(refreshUsageBtn.disabled).toBe(true);
        expect(usageLoading.style.display).toBe('block');
        await refreshPromise;

        expect(refreshUsageBtn.disabled).toBe(false);
        expect(usageLoading.style.display).toBe('none');
        expect(usageLoadingText.textContent).toBe('加载中');
        expect(showToast).toHaveBeenCalledWith('提示', '任务已开始', 'info');
        expect(showToast).toHaveBeenCalledWith('成功', '刷新完成', 'success');
        expect(serverTimeValue.textContent).toBeTruthy();
    });
});

describe('frontend runtime storage diagnostics panel', () => {
    let providerManagerModule;
    let showToast;

    beforeEach(async () => {
        jest.resetModules();
        showToast = jest.fn();
        global.window = {
            apiClient: {
                post: jest.fn()
            }
        };
        global.localStorage = {
            getItem: jest.fn(() => 'token')
        };

        jest.doMock('../static/app/constants.js', () => ({
            providerStats: {},
            updateProviderStats: jest.fn()
        }));
        jest.doMock('../static/app/utils.js', () => ({
            showToast,
            getProviderConfigs: jest.fn(() => [])
        }));
        jest.doMock('../static/app/file-upload.js', () => ({
            fileUploadHandler: {}
        }));
        jest.doMock('../static/app/i18n.js', () => ({
            t: (key) => key,
            getCurrentLanguage: () => 'zh-CN'
        }));
        jest.doMock('../static/app/routing-examples.js', () => ({
            renderRoutingExamples: jest.fn()
        }));
        jest.doMock('../static/app/models-manager.js', () => ({
            updateModelsProviderConfigs: jest.fn()
        }));
        jest.doMock('../static/app/tutorial-manager.js', () => ({
            updateTutorialProviderConfigs: jest.fn()
        }));
        jest.doMock('../static/app/usage-manager.js', () => ({
            updateUsageProviderConfigs: jest.fn()
        }));
        jest.doMock('../static/app/config-manager.js', () => ({
            updateConfigProviderConfigs: jest.fn()
        }));
        jest.doMock('../static/app/upload-config-manager.js', () => ({
            loadConfigList: jest.fn(),
            updateProviderFilterOptions: jest.fn(),
            reloadConfig: jest.fn(),
            downloadAllConfigs: jest.fn()
        }));
        jest.doMock('../static/app/event-handlers.js', () => ({
            setServiceMode: jest.fn()
        }));

        providerManagerModule = await import('../static/app/provider-manager.js');
    });

    test('should build storage diagnostics view models with alerts permissions and suggested run id', () => {
        const viewModel = providerManagerModule.buildRuntimeStorageDiagnosticsViewModel({
            runtimeStorage: {
                backend: 'dual-write',
                requestedBackend: 'db',
                authoritativeSource: 'database',
                dualWriteEnabled: true,
                lastFallback: {
                    status: 'applied',
                    triggeredBy: 'replaceProviderPoolsSnapshot',
                    toBackend: 'file'
                },
                featureFlagRollback: {
                    runId: 'run-fallback-1'
                }
            },
            providerSummary: {
                providerTypeCount: 2,
                providerCount: 5
            }
        }, {
            hasAdminAccess: false
        });

        expect(viewModel.storageMode).toBe('dual-write');
        expect(viewModel.storageModeLabel).toBe('Dual-write');
        expect(viewModel.sourceOfTruthLabel).toBe('Database');
        expect(viewModel.readOnly).toBe(true);
        expect(viewModel.alert).toMatchObject({
            type: 'warning',
            message: 'Fallback applied via replaceProviderPoolsSnapshot (file)'
        });
        expect(viewModel.diagnostics).toMatchObject({
            validation: '--',
            fallback: 'applied · replaceProviderPoolsSnapshot',
            dualWriteEnabled: true,
            lastErrorMessage: '--'
        });
        expect(viewModel.suggestedRunId).toBe('run-fallback-1');
        expect(viewModel.actions.rollback.disabled).toBe(true);

        const errorViewModel = providerManagerModule.buildRuntimeStorageDiagnosticsViewModel({}, {
            hasAdminAccess: true,
            error: new Error('boom')
        });
        expect(errorViewModel.alert).toMatchObject({
            type: 'error',
            message: 'Failed to load runtime storage diagnostics: boom'
        });
    });

    test('should render diagnostics text alerts and disabled states into the panel container', () => {
        const { container, nodes } = createDiagnosticsContainer();
        const viewModel = providerManagerModule.buildRuntimeStorageDiagnosticsViewModel({
            runtimeStorage: {
                backend: 'db',
                authoritativeSource: 'database',
                lastValidation: {
                    overallStatus: 'fail',
                    runId: 'run-1'
                },
                lastError: {
                    error: {
                        message: 'database is locked'
                    }
                }
            },
            providerSummary: {
                providerTypeCount: 3,
                providerCount: 8
            }
        }, {
            hasAdminAccess: true,
            isLoading: true
        });

        providerManagerModule.renderRuntimeStorageDiagnostics(viewModel, container);

        expect(nodes['#runtimeStorageMode'].textContent).toBe('Loading…');
        expect(nodes['#runtimeStorageSource'].textContent).toBe('Database');
        expect(nodes['#runtimeStorageProviderSummary'].textContent).toBe('3 types / 8 providers');
        expect(nodes['#runtimeStorageValidation'].textContent).toBe('fail · run-1');
        expect(nodes['#runtimeStorageError'].textContent).toBe('database is locked');
        expect(nodes['#runtimeStorageAlert'].hidden).toBe(false);
        expect(nodes['#runtimeStorageAlert'].textContent).toBe('Last runtime storage error: database is locked');
        expect(nodes['#runtimeStorageAlert'].dataset.level).toBe('error');
        expect(nodes['#runtimeStorageReloadBtn'].disabled).toBe(true);
        expect(nodes['#runtimeStorageReloadBtn']['aria-disabled']).toBe('true');
        expect(container.dataset.loading).toBe('true');
        expect(container.dataset.readOnly).toBe('false');
    });

    test('should execute reload export and rollback actions with loading toggles and refresh callbacks', async () => {
        const loadingStates = [];
        const reloadConfigFn = jest.fn(async () => ({ reloaded: true }));
        const exportFn = jest.fn(async () => ({ exported: true }));
        const refreshProvidersFn = jest.fn(async () => undefined);
        const refreshSystemInfoFn = jest.fn(async () => undefined);
        const refreshConfigListFn = jest.fn(async () => undefined);
        const apiClient = {
            post: jest.fn(async () => ({ success: true }))
        };

        await expect(providerManagerModule.executeRuntimeStorageReloadAction({
            reloadConfigFn,
            refreshProvidersFn,
            refreshSystemInfoFn,
            setLoading: (value) => loadingStates.push(`reload:${value}`)
        })).resolves.toEqual({ reloaded: true });

        await expect(providerManagerModule.executeRuntimeStorageExportAction({
            exportFn,
            refreshSystemInfoFn,
            setLoading: (value) => loadingStates.push(`export:${value}`)
        })).resolves.toEqual({ exported: true });

        await expect(providerManagerModule.executeRuntimeStorageRollbackAction({
            apiClient,
            runId: '',
            promptRunIdFn: () => 'run-42',
            confirmFn: () => true,
            notify: showToast,
            refreshConfigListFn,
            refreshProvidersFn,
            refreshSystemInfoFn,
            setLoading: (value) => loadingStates.push(`rollback:${value}`)
        })).resolves.toEqual({ success: true });

        expect(reloadConfigFn).toHaveBeenCalled();
        expect(exportFn).toHaveBeenCalled();
        expect(apiClient.post).toHaveBeenCalledWith('/runtime-storage/rollback', {
            runId: 'run-42'
        });
        expect(showToast).toHaveBeenCalledWith('Success', 'Runtime storage rollback completed (run-42)', 'success');
        expect(loadingStates).toEqual([
            'reload:true',
            'reload:false',
            'export:true',
            'export:false',
            'rollback:true',
            'rollback:false'
        ]);
    });

    test('should skip or surface rollback errors with matching toast feedback', async () => {
        const notify = jest.fn();
        await expect(providerManagerModule.executeRuntimeStorageRollbackAction({
            runId: '',
            promptRunIdFn: () => '',
            confirmFn: () => true,
            notify,
            setLoading: jest.fn()
        })).resolves.toEqual({ skipped: true });

        await expect(providerManagerModule.executeRuntimeStorageRollbackAction({
            runId: 'run-cancelled',
            confirmFn: () => false,
            notify,
            setLoading: jest.fn()
        })).resolves.toEqual({
            skipped: true,
            runId: 'run-cancelled'
        });

        const apiClient = {
            post: jest.fn(async () => {
                throw new Error('rollback failed');
            })
        };
        await expect(providerManagerModule.executeRuntimeStorageRollbackAction({
            apiClient,
            runId: 'run-failed',
            confirmFn: () => true,
            notify,
            setLoading: jest.fn()
        })).rejects.toThrow('rollback failed');
        expect(notify).toHaveBeenCalledWith('Error', 'Runtime storage rollback failed: rollback failed', 'error');
    });
});

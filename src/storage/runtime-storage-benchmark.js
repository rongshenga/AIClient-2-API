import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import { SqliteCliClient } from './sqlite-cli-client.js';
import { SqliteRuntimeStorage } from './backends/sqlite-runtime-storage.js';

const DEFAULT_STARTUP_ROUNDS = 20;
const DEFAULT_SINGLE_FLUSH_ROUNDS = 20;
const DEFAULT_BATCH_FLUSH_ROUNDS = 12;
const DEFAULT_LARGE_FLUSH_ROUNDS = 8;
const DEFAULT_SINGLE_BATCH_SIZE = 1;
const DEFAULT_MID_BATCH_SIZE = 64;
const DEFAULT_LARGE_BATCH_SIZE = 200;
const DEFAULT_FLUSH_DEBOUNCE_MS = 1000;
const DEFAULT_DIRTY_THRESHOLD = 64;
const DEFAULT_FLUSH_BATCH_SIZE = 200;
const PERCENTILES = [50, 95, 99];

function toPositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hrDurationMs(startTime) {
    return Number(process.hrtime.bigint() - startTime) / 1e6;
}

function percentile(sortedSamples, value) {
    if (!Array.isArray(sortedSamples) || sortedSamples.length === 0) {
        return 0;
    }

    if (sortedSamples.length === 1) {
        return sortedSamples[0];
    }

    const rank = Math.ceil((value / 100) * sortedSamples.length) - 1;
    const index = Math.min(sortedSamples.length - 1, Math.max(0, rank));
    return sortedSamples[index];
}

export function summarizeDurationSamples(samples = []) {
    const normalizedSamples = Array.isArray(samples)
        ? samples.filter((value) => Number.isFinite(value) && value >= 0)
        : [];
    const sortedSamples = [...normalizedSamples].sort((left, right) => left - right);
    const totalMs = sortedSamples.reduce((sum, value) => sum + value, 0);
    const averageMs = sortedSamples.length > 0 ? totalMs / sortedSamples.length : 0;

    return {
        sampleCount: sortedSamples.length,
        totalMs: Number(totalMs.toFixed(3)),
        averageMs: Number(averageMs.toFixed(3)),
        minMs: Number((sortedSamples[0] || 0).toFixed(3)),
        maxMs: Number((sortedSamples[sortedSamples.length - 1] || 0).toFixed(3)),
        p50Ms: Number(percentile(sortedSamples, 50).toFixed(3)),
        p95Ms: Number(percentile(sortedSamples, 95).toFixed(3)),
        p99Ms: Number(percentile(sortedSamples, 99).toFixed(3))
    };
}

async function collectTimingSamples(rounds, runner, options = {}) {
    const totalRounds = toPositiveInt(rounds, 1);
    const defaultWarmupRounds = Math.min(3, totalRounds);
    const warmupRounds = options.warmupRounds === undefined
        ? defaultWarmupRounds
        : Math.max(0, Number.parseInt(options.warmupRounds, 10) || 0);

    for (let index = 0; index < warmupRounds; index += 1) {
        await runner(index, { warmup: true });
    }

    const durations = [];
    for (let index = 0; index < totalRounds; index += 1) {
        const startTime = process.hrtime.bigint();
        await runner(index, { warmup: false });
        durations.push(hrDurationMs(startTime));
    }

    return {
        ...summarizeDurationSamples(durations),
        rounds: totalRounds,
        warmupRounds
    };
}

function safeSqliteVersion(sqliteBinary) {
    try {
        return execFileSync(sqliteBinary, ['--version'], {
            encoding: 'utf8'
        }).trim();
    } catch (error) {
        return `unavailable: ${error.message}`;
    }
}

function buildBenchmarkClientOptions(config = {}) {
    return {
        sqliteBinary: config.RUNTIME_STORAGE_SQLITE_BINARY || 'sqlite3',
        busyTimeoutMs: config.RUNTIME_STORAGE_DB_BUSY_TIMEOUT_MS ?? 5000,
        maxRetryAttempts: config.RUNTIME_STORAGE_DB_RETRY_ATTEMPTS ?? 2,
        retryDelayMs: config.RUNTIME_STORAGE_DB_RETRY_DELAY_MS ?? 75
    };
}

export function buildSqliteCliLifecycleStrategy(config = {}) {
    const clientOptions = buildBenchmarkClientOptions(config);
    return {
        driver: 'sqlite3-cli',
        processModel: 'one short-lived sqlite3 process per exec/query attempt',
        queueModel: 'shared serial queue per dbPath',
        transactionModel: 'DAO batches multiple statements into one BEGIN/COMMIT payload',
        retryPolicy: {
            busyTimeoutMs: clientOptions.busyTimeoutMs,
            maxRetryAttempts: clientOptions.maxRetryAttempts,
            retryDelayMs: clientOptions.retryDelayMs
        }
    };
}

function buildProviderPools(batchSize) {
    return {
        'grok-custom': Array.from({ length: batchSize }, (_, index) => ({
            uuid: `benchmark-grok-${index + 1}`,
            customName: `Benchmark Grok ${index + 1}`,
            GROK_BASE_URL: 'https://grok.example.com',
            GROK_COOKIE_TOKEN: `token-${index + 1}`,
            checkModelName: 'grok-4',
            isHealthy: true,
            isDisabled: false,
            usageCount: 0,
            errorCount: 0,
            refreshCount: 0
        }))
    };
}

function buildRuntimeFlushRecords(providers = [], round = 0, persistSelectionState = false) {
    const baseTimeMs = Date.parse('2026-03-06T10:00:00.000Z') + (round * 1000);
    return providers.map((provider, index) => {
        const providerTimestamp = new Date(baseTimeMs + index).toISOString();
        const hasError = (round + index) % 5 === 0;
        return {
            providerId: provider.__providerId,
            providerType: 'grok-custom',
            persistSelectionState,
            runtimeState: {
                isHealthy: !hasError,
                isDisabled: false,
                usageCount: round + index + 1,
                errorCount: hasError ? 1 : 0,
                lastUsed: providerTimestamp,
                lastHealthCheckTime: providerTimestamp,
                lastHealthCheckModel: 'grok-4',
                lastErrorTime: hasError ? providerTimestamp : null,
                lastErrorMessage: hasError ? 'quota exhausted' : null,
                scheduledRecoveryTime: null,
                refreshCount: round % 7,
                lastSelectionSeq: persistSelectionState ? (round * 1000 + index) : null
            }
        };
    });
}

function buildScenarioSummary(label, batchSize, rounds, metrics, topLevelExecCalls, flushDebounceMs) {
    const p95Ms = metrics.p95Ms || 0;
    const averageMs = metrics.averageMs || 0;
    const warmupRounds = Number(metrics.warmupRounds || 0);
    const measuredExecCalls = Math.max(0, topLevelExecCalls - warmupRounds);
    const estimatedP95FlushesPerSecond = p95Ms > 0 ? Number((1000 / p95Ms).toFixed(2)) : 0;
    const estimatedAverageProvidersPerSecond = averageMs > 0
        ? Number(((batchSize / averageMs) * 1000).toFixed(2))
        : 0;
    const flushWindowUtilization = flushDebounceMs > 0
        ? Number((p95Ms / flushDebounceMs).toFixed(4))
        : 0;

    return {
        label,
        batchSize,
        rounds,
        warmupRounds,
        topLevelExecCalls,
        measuredExecCalls,
        expectedExecCalls: rounds,
        metrics,
        estimatedP95FlushesPerSecond,
        estimatedAverageProvidersPerSecond,
        flushWindowUtilization
    };
}

export function assessSqliteCliBenchmark(report = {}, config = {}) {
    const startupExecP95Ms = Number(report?.startup?.exec?.p95Ms || 0);
    const startupQueryP95Ms = Number(report?.startup?.query?.p95Ms || 0);
    const flushScenarios = Array.isArray(report?.flushScenarios) ? report.flushScenarios : [];
    const flushDebounceMs = Number(report?.heuristics?.flushDebounceMs || config.RUNTIME_STORAGE_PROVIDER_FLUSH_DEBOUNCE_MS || DEFAULT_FLUSH_DEBOUNCE_MS);
    const dirtyThreshold = Number(report?.heuristics?.dirtyThreshold || config.RUNTIME_STORAGE_PROVIDER_FLUSH_DIRTY_THRESHOLD || DEFAULT_DIRTY_THRESHOLD);
    const targetBatchSize = Number(report?.heuristics?.flushBatchSize || config.RUNTIME_STORAGE_PROVIDER_FLUSH_BATCH_SIZE || DEFAULT_FLUSH_BATCH_SIZE);
    const thresholdScenario = flushScenarios.find((item) => item.batchSize === dirtyThreshold) || flushScenarios[0] || null;
    const largeBatchScenario = flushScenarios.find((item) => item.batchSize === targetBatchSize) || flushScenarios[flushScenarios.length - 1] || null;
    const findings = [];
    const bottlenecks = [];
    let status = 'acceptable';
    let recommendation = 'keep_sqlite_cli';

    if (startupExecP95Ms > 0) {
        findings.push(`sqlite3 CLI exec p95 ${startupExecP95Ms.toFixed(3)}ms`);
    }
    if (startupQueryP95Ms > 0) {
        findings.push(`sqlite3 CLI query p95 ${startupQueryP95Ms.toFixed(3)}ms`);
    }

    if (startupExecP95Ms > 25 || startupQueryP95Ms > 25) {
        status = 'watch';
        recommendation = 'monitor_cli_startup_cost';
        bottlenecks.push('tiny writes are dominated by sqlite3 process startup cost');
    }

    if (thresholdScenario) {
        findings.push(`${dirtyThreshold}-record flush p95 ${thresholdScenario.metrics.p95Ms.toFixed(3)}ms`);
        if (thresholdScenario.measuredExecCalls !== thresholdScenario.expectedExecCalls) {
            status = 'watch';
            recommendation = 'inspect_flush_batching';
            bottlenecks.push('flush batching issued unexpected top-level exec calls');
        }
    }

    if (largeBatchScenario) {
        findings.push(`${largeBatchScenario.batchSize}-record flush p95 ${largeBatchScenario.metrics.p95Ms.toFixed(3)}ms`);
        if (largeBatchScenario.flushWindowUtilization > 0.5) {
            status = 'watch';
            recommendation = 'consider_worker_or_native_driver';
            bottlenecks.push('large flush batches consume more than half of the configured flush window');
        }
        if (largeBatchScenario.flushWindowUtilization > 1) {
            status = 'upgrade_recommended';
            recommendation = 'upgrade_driver_or_worker';
            bottlenecks.push('large flush batches exceed the configured debounce window');
        }
    }

    return {
        status,
        recommendation,
        findings,
        bottlenecks,
        summary: status === 'acceptable'
            ? '当前 sqlite3 CLI 启动与批量 flush 开销仍在一期可接受窗口内。'
            : status === 'watch'
                ? '当前 sqlite3 CLI 仍可用，但已经出现需要重点监控的启动或批量 flush 开销。'
                : '当前 sqlite3 CLI 已逼近或超出可接受窗口，建议尽快升级为长驻 worker 或原生驱动。',
        heuristics: {
            flushDebounceMs,
            dirtyThreshold,
            flushBatchSize: targetBatchSize
        }
    };
}

export async function runSqliteCliRuntimeStorageBenchmark(config = {}, options = {}) {
    const clientOptions = buildBenchmarkClientOptions(config);
    const startupRounds = toPositiveInt(options.startupRounds, DEFAULT_STARTUP_ROUNDS);
    const singleFlushRounds = toPositiveInt(options.singleFlushRounds, DEFAULT_SINGLE_FLUSH_ROUNDS);
    const batchFlushRounds = toPositiveInt(options.batchFlushRounds, DEFAULT_BATCH_FLUSH_ROUNDS);
    const largeFlushRounds = toPositiveInt(options.largeFlushRounds, DEFAULT_LARGE_FLUSH_ROUNDS);
    const singleBatchSize = toPositiveInt(options.singleBatchSize, DEFAULT_SINGLE_BATCH_SIZE);
    const midBatchSize = toPositiveInt(options.midBatchSize, Number(config.RUNTIME_STORAGE_PROVIDER_FLUSH_DIRTY_THRESHOLD) || DEFAULT_MID_BATCH_SIZE);
    const largeBatchSize = toPositiveInt(options.largeBatchSize, Number(config.RUNTIME_STORAGE_PROVIDER_FLUSH_BATCH_SIZE) || DEFAULT_LARGE_BATCH_SIZE);
    const flushDebounceMs = Number(config.RUNTIME_STORAGE_PROVIDER_FLUSH_DEBOUNCE_MS || DEFAULT_FLUSH_DEBOUNCE_MS);
    const tempRoot = options.tempRoot || await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-storage-benchmark-'));
    const keepArtifacts = options.keepArtifacts === true;
    const dbPath = options.dbPath || path.join(tempRoot, 'runtime-storage-benchmark.sqlite');
    const providerPoolsPath = path.join(tempRoot, 'provider_pools.json');
    const benchmarkConfig = {
        ...config,
        RUNTIME_STORAGE_DB_PATH: dbPath,
        PROVIDER_POOLS_FILE_PATH: providerPoolsPath,
        LOG_OUTPUT_MODE: 'none'
    };
    const startupClient = new SqliteCliClient(dbPath, clientOptions);
    const storage = new SqliteRuntimeStorage(benchmarkConfig);
    storage.client = new SqliteCliClient(dbPath, clientOptions);

    let totalExecCalls = 0;
    const originalExec = storage.client.exec.bind(storage.client);
    storage.client.exec = async (...args) => {
        totalExecCalls += 1;
        return await originalExec(...args);
    };

    try {
        await storage.initialize();

        const startupExec = await collectTimingSamples(startupRounds, async () => {
            await startupClient.exec('SELECT 1;', {
                operation: 'benchmark_exec'
            });
        });
        const startupQuery = await collectTimingSamples(startupRounds, async () => {
            await startupClient.query('SELECT 1 AS value;', {
                operation: 'benchmark_query'
            });
        });

        const scenarioInputs = [
            {
                label: 'single_runtime_flush',
                batchSize: singleBatchSize,
                rounds: singleFlushRounds,
                persistSelectionState: false
            },
            {
                label: 'dirty_threshold_flush',
                batchSize: midBatchSize,
                rounds: batchFlushRounds,
                persistSelectionState: false
            },
            {
                label: 'full_batch_flush',
                batchSize: largeBatchSize,
                rounds: largeFlushRounds,
                persistSelectionState: true
            }
        ];

        const flushScenarios = [];
        for (const scenario of scenarioInputs) {
            const providerPools = buildProviderPools(scenario.batchSize);
            await storage.replaceProviderPoolsSnapshot(providerPools, {
                sourceKind: `benchmark_${scenario.label}`
            });
            const snapshot = await storage.exportProviderPoolsSnapshot();
            const providers = snapshot['grok-custom'] || [];
            const execCallsBeforeScenario = totalExecCalls;

            const metrics = await collectTimingSamples(scenario.rounds, async (round) => {
                await storage.flushProviderRuntimeState(
                    buildRuntimeFlushRecords(providers, round, scenario.persistSelectionState),
                    {
                        persistSelectionState: scenario.persistSelectionState
                    }
                );
            });

            flushScenarios.push(buildScenarioSummary(
                scenario.label,
                scenario.batchSize,
                scenario.rounds,
                metrics,
                totalExecCalls - execCallsBeforeScenario,
                flushDebounceMs
            ));
        }

        const report = {
            generatedAt: new Date().toISOString(),
            environment: {
                nodeVersion: process.version,
                platform: process.platform,
                arch: process.arch,
                cpuCount: os.cpus().length,
                sqliteBinary: clientOptions.sqliteBinary,
                sqliteVersion: safeSqliteVersion(clientOptions.sqliteBinary)
            },
            lifecycle: buildSqliteCliLifecycleStrategy(benchmarkConfig),
            startup: {
                rounds: startupRounds,
                exec: startupExec,
                query: startupQuery
            },
            flushScenarios,
            heuristics: {
                flushDebounceMs,
                dirtyThreshold: Number(config.RUNTIME_STORAGE_PROVIDER_FLUSH_DIRTY_THRESHOLD || DEFAULT_DIRTY_THRESHOLD),
                flushBatchSize: Number(config.RUNTIME_STORAGE_PROVIDER_FLUSH_BATCH_SIZE || DEFAULT_FLUSH_BATCH_SIZE)
            },
            artifacts: {
                tempRoot,
                dbPath,
                providerPoolsPath,
                kept: keepArtifacts
            }
        };
        report.assessment = assessSqliteCliBenchmark(report, benchmarkConfig);
        return report;
    } finally {
        await storage.close().catch(() => undefined);
        if (!keepArtifacts) {
            await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
        }
    }
}

export default runSqliteCliRuntimeStorageBenchmark;

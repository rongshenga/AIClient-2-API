import { assessSqliteCliBenchmark } from '../src/storage/runtime-storage-benchmark.js';

describe('runtime storage benchmark assessment', () => {
    test('should ignore warmup-only exec calls when evaluating flush batching', () => {
        const report = {
            startup: {
                exec: { p95Ms: 5.612 },
                query: { p95Ms: 5.124 }
            },
            flushScenarios: [
                {
                    batchSize: 64,
                    metrics: { p95Ms: 8.867 },
                    warmupRounds: 3,
                    topLevelExecCalls: 15,
                    measuredExecCalls: 12,
                    expectedExecCalls: 12,
                    flushWindowUtilization: 0.0089
                },
                {
                    batchSize: 200,
                    metrics: { p95Ms: 11.811 },
                    warmupRounds: 3,
                    topLevelExecCalls: 11,
                    measuredExecCalls: 8,
                    expectedExecCalls: 8,
                    flushWindowUtilization: 0.0118
                }
            ],
            heuristics: {
                flushDebounceMs: 1000,
                dirtyThreshold: 64,
                flushBatchSize: 200
            }
        };

        expect(assessSqliteCliBenchmark(report)).toMatchObject({
            status: 'acceptable',
            recommendation: 'keep_sqlite_cli',
            bottlenecks: []
        });
    });

    test('should flag flush batching when measured exec calls exceed expected rounds', () => {
        const report = {
            startup: {
                exec: { p95Ms: 5.612 },
                query: { p95Ms: 5.124 }
            },
            flushScenarios: [
                {
                    batchSize: 64,
                    metrics: { p95Ms: 8.867 },
                    measuredExecCalls: 13,
                    expectedExecCalls: 12,
                    flushWindowUtilization: 0.0089
                },
                {
                    batchSize: 200,
                    metrics: { p95Ms: 11.811 },
                    measuredExecCalls: 8,
                    expectedExecCalls: 8,
                    flushWindowUtilization: 0.0118
                }
            ],
            heuristics: {
                flushDebounceMs: 1000,
                dirtyThreshold: 64,
                flushBatchSize: 200
            }
        };

        expect(assessSqliteCliBenchmark(report)).toMatchObject({
            status: 'watch',
            recommendation: 'inspect_flush_batching'
        });
    });
});

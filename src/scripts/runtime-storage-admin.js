#!/usr/bin/env node

import path from 'path';
import {
    detectLegacyAuthAuthority,
    exportLegacyRuntimeStorage,
    getRuntimeStorageMigrationRun,
    listRuntimeStorageMigrationRuns,
    migrateLegacyRuntimeStorage,
    readAdminConfig,
    rollbackRuntimeStorageMigration,
    verifyAuthRuntimeStorageMigration,
    verifyRuntimeStorageMigration
} from '../storage/runtime-storage-migration-service.js';
import { runSqliteCliRuntimeStorageBenchmark } from '../storage/runtime-storage-benchmark.js';

function parseArguments(argv) {
    const [command, ...rest] = argv;
    const positional = [];
    const options = {};

    for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];
        if (!token.startsWith('--')) {
            positional.push(token);
            continue;
        }

        const optionName = token.slice(2);
        const nextToken = rest[index + 1];
        if (!nextToken || nextToken.startsWith('--')) {
            options[optionName] = true;
            continue;
        }

        options[optionName] = nextToken;
        index += 1;
    }

    return {
        command,
        options,
        positional
    };
}

function printHelp() {
    console.log(`Runtime Storage Admin

Usage:
  node src/scripts/runtime-storage-admin.js <command> [options]

Commands:
  migrate         Import legacy files into sqlite runtime storage
  verify          Validate sqlite runtime storage against legacy files
  verify-auth     Validate auth authority migration state (pwd + credential secrets)
  export-legacy   Export compatibility JSON from sqlite runtime storage
  rollback        Restore sqlite/files from migration artifacts
  rollback-auth   Restore auth-related legacy files from migration artifacts
  list-runs       List migration runs from sqlite runtime storage
  show-run        Show one migration run with items
  benchmark       Measure sqlite3 CLI startup and runtime flush cost

Common Options:
  --config <path>                 Config file path, default: configs/config.json
  --provider-pools-file <path>    Override provider_pools.json path
  --token-store-file <path>       Override token-store.json path
  --password-file <path>          Override pwd file path
  --runtime-storage-db-path <path> Override sqlite db path
  --artifact-root <path>          Override migration artifact root

Migrate Options:
  --execute                       Execute migration, default is dry-run
  --force                         Allow importing into non-empty target
  --resume                        Resume an existing migration run
  --step-batch-size <n>           Execute migration steps in batches
  --stop-after-batch <n>          Stop after N batches for checkpoint testing
  --max-anomaly-count <n>         Block migration when anomalies exceed the limit
  --blocked-anomaly-codes <csv>   Block migration when listed anomaly codes appear
  --operator <id>                 Record operator id in migration artifacts
  --report-dir <path>             Override diff report output dir
  --progress-interval <n>         Provider import progress log interval, default: 2000
  --credential-progress-interval <n> Credential preload progress interval, default: 1000
  --prepare-concurrency <n>       Preload credential files concurrently, default: ~80% CPU cores
  --insert-batch-size <n>         Multi-row sqlite insert batch size, default: 250

Verify Options:
  --run-id <id>                   Migration run id
  --report-dir <path>             Override diff report output dir
  --fail-on-diff                  Exit with code 1 when diff exists
  --enforce-cutover-gate          Fail verify when cutover gate is blocked
  --max-anomaly-count <n>         Apply anomaly policy during cutover validation
  --blocked-anomaly-codes <csv>   Apply anomaly code policy during cutover validation

Export Options:
  --domains <csv>                 provider-pools,usage-cache,api-potluck-data,api-potluck-keys
  --output-dir <path>             Output directory for exported files
  --output-file <path>            Output file when exporting a single domain

Rollback Options:
  --run-id <id>                   Migration run id
  --skip-legacy-files             Restore sqlite only, keep current legacy files

Benchmark Options:
  --startup-rounds <n>            sqlite3 exec/query startup samples, default: 20
  --single-flush-rounds <n>       Single-record flush samples, default: 20
  --batch-flush-rounds <n>        Dirty-threshold flush samples, default: 12
  --large-flush-rounds <n>        Full batch flush samples, default: 8
  --single-batch-size <n>         Single flush batch size, default: 1
  --mid-batch-size <n>            Mid flush batch size, default: dirty threshold or 64
  --large-batch-size <n>          Large flush batch size, default: flush batch size or 200
  --keep-artifacts                Keep temporary benchmark sqlite files
  --output-file <path>            Write benchmark JSON report to file
`);
}

function parseDomains(value, fallback) {
    if (!value) {
        return fallback;
    }

    return String(value)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

function parseIntegerOption(value, fallback = null) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function buildOverrides(options) {
    const overrides = {};

    if (options['provider-pools-file']) {
        overrides.PROVIDER_POOLS_FILE_PATH = path.resolve(process.cwd(), options['provider-pools-file']);
    }
    if (options['token-store-file']) {
        overrides.TOKEN_STORE_FILE_PATH = path.resolve(process.cwd(), options['token-store-file']);
    }
    if (options['password-file']) {
        overrides.PASSWORD_FILE_PATH = path.resolve(process.cwd(), options['password-file']);
    }
    if (options['runtime-storage-db-path']) {
        overrides.RUNTIME_STORAGE_DB_PATH = path.resolve(process.cwd(), options['runtime-storage-db-path']);
    }
    if (options['artifact-root']) {
        overrides.RUNTIME_STORAGE_MIGRATION_ARTIFACT_ROOT = path.resolve(process.cwd(), options['artifact-root']);
    }
    if (options['usage-cache-file']) {
        overrides.USAGE_CACHE_FILE_PATH = path.resolve(process.cwd(), options['usage-cache-file']);
    }
    if (options['api-potluck-data-file']) {
        overrides.API_POTLUCK_DATA_FILE_PATH = path.resolve(process.cwd(), options['api-potluck-data-file']);
    }
    if (options['api-potluck-keys-file']) {
        overrides.API_POTLUCK_KEYS_FILE_PATH = path.resolve(process.cwd(), options['api-potluck-keys-file']);
    }

    return overrides;
}

async function main() {
    const { command, options } = parseArguments(process.argv.slice(2));
    if (!command || command === 'help' || command === '--help') {
        printHelp();
        return;
    }

    const configPath = options.config || 'configs/config.json';
    const config = await readAdminConfig(configPath, buildOverrides(options));

    if (command === 'migrate') {
        const result = await migrateLegacyRuntimeStorage(config, {
            execute: options.execute === true,
            force: options.force === true,
            resume: options.resume === true,
            stepBatchSize: parseIntegerOption(options['step-batch-size'], undefined),
            stopAfterBatch: parseIntegerOption(options['stop-after-batch'], undefined),
            progressInterval: parseIntegerOption(options['progress-interval'], undefined),
            credentialProgressInterval: parseIntegerOption(options['credential-progress-interval'], undefined),
            prepareConcurrency: parseIntegerOption(options['prepare-concurrency'], undefined),
            insertBatchSize: parseIntegerOption(options['insert-batch-size'], undefined),
            maxAnomalyCount: parseIntegerOption(options['max-anomaly-count'], undefined),
            blockedAnomalyCodes: parseDomains(options['blocked-anomaly-codes'], []),
            operator: options.operator || null,
            reportDir: options['report-dir'] || null,
            outputDir: options['output-dir'] || null
        });
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    if (command === 'verify') {
        const result = await verifyRuntimeStorageMigration(config, {
            runId: options['run-id'] || null,
            reportDir: options['report-dir'] || null,
            failOnDiff: options['fail-on-diff'] === true,
            enforceCutoverGate: options['enforce-cutover-gate'] === true,
            maxAnomalyCount: parseIntegerOption(options['max-anomaly-count'], undefined),
            blockedAnomalyCodes: parseDomains(options['blocked-anomaly-codes'], []),
            operator: options.operator || null
        });
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    if (command === 'verify-auth') {
        const detection = await detectLegacyAuthAuthority(config, {});
        const result = await verifyAuthRuntimeStorageMigration(config, {});
        console.log(JSON.stringify({
            detection,
            verification: result
        }, null, 2));
        return;
    }

    if (command === 'export-legacy') {
        const result = await exportLegacyRuntimeStorage(config, {
            domains: parseDomains(options.domains, ['provider-pools']),
            outputDir: options['output-dir'] || null,
            outputFile: options['output-file'] || null
        });
        console.log(JSON.stringify({
            providerPools: Object.keys(result.providerPools || {}).length,
            usageProviders: Object.keys(result.usageCache?.providers || {}).length,
            adminSessions: Number(result.sessionSummary?.sessionCount || 0),
            apiPotluckUsers: Object.keys(result.apiPotluckData?.users || {}).length,
            apiPotluckKeys: Object.keys(result.apiPotluckKeys?.keys || {}).length,
            resolvedPaths: result.resolvedPaths
        }, null, 2));
        return;
    }

    if (command === 'rollback') {
        if (!options['run-id']) {
            throw new Error('rollback requires --run-id');
        }

        const result = await rollbackRuntimeStorageMigration(config, {
            runId: options['run-id'],
            restoreLegacyFiles: options['skip-legacy-files'] !== true
        });
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    if (command === 'rollback-auth') {
        if (!options['run-id']) {
            throw new Error('rollback-auth requires --run-id');
        }

        const result = await rollbackRuntimeStorageMigration(config, {
            runId: options['run-id'],
            restoreLegacyFiles: true
        });
        console.log(JSON.stringify({
            runId: result.runId,
            rollbackNotePath: result.rollbackNotePath,
            restoredAuthFiles: (result.restoredFiles || []).filter((filePath) => {
                return filePath.endsWith('/pwd')
                    || filePath.endsWith('\\pwd')
                    || filePath.endsWith('/token-store.json')
                    || filePath.endsWith('\\token-store.json');
            })
        }, null, 2));
        return;
    }

    if (command === 'list-runs') {
        const result = await listRuntimeStorageMigrationRuns(config);
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    if (command === 'show-run') {
        if (!options['run-id']) {
            throw new Error('show-run requires --run-id');
        }

        const result = await getRuntimeStorageMigrationRun(config, options['run-id']);
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    if (command === 'benchmark') {
        const result = await runSqliteCliRuntimeStorageBenchmark(config, {
            startupRounds: options['startup-rounds'],
            singleFlushRounds: options['single-flush-rounds'],
            batchFlushRounds: options['batch-flush-rounds'],
            largeFlushRounds: options['large-flush-rounds'],
            singleBatchSize: options['single-batch-size'],
            midBatchSize: options['mid-batch-size'],
            largeBatchSize: options['large-batch-size'],
            dbPath: options['runtime-storage-db-path'] ? path.resolve(process.cwd(), options['runtime-storage-db-path']) : null,
            keepArtifacts: options['keep-artifacts'] === true
        });

        if (options['output-file']) {
            const outputPath = path.resolve(process.cwd(), options['output-file']);
            await import('fs/promises').then(({ writeFile }) => writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8'));
        }

        console.log(JSON.stringify(result, null, 2));
        return;
    }

    throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
});

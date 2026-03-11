import { SqliteRuntimeStorage } from './backends/sqlite-runtime-storage.js';
import { wrapRuntimeStorage } from './runtime-storage-facade.js';

export function normalizeRuntimeStorageBackend(value) {
    if (typeof value === 'string' && value.trim().toLowerCase() !== 'db') {
        return 'db';
    }
    return 'db';
}

export function getRuntimeStorageDefaults() {
    return {
        RUNTIME_STORAGE_BACKEND: 'db',
        RUNTIME_STORAGE_DB_PATH: 'configs/runtime/runtime-storage.sqlite',
        RUNTIME_STORAGE_DB_BUSY_TIMEOUT_MS: 5000,
        RUNTIME_STORAGE_DB_RETRY_ATTEMPTS: 2,
        RUNTIME_STORAGE_DB_RETRY_DELAY_MS: 75,
        RUNTIME_STORAGE_SQLITE_BINARY: 'sqlite3'
    };
}

export function createRuntimeStorage(config = {}) {
    const normalizedConfig = {
        ...config,
        RUNTIME_STORAGE_BACKEND: 'db'
    };
    const dbStorage = new SqliteRuntimeStorage(normalizedConfig);
    return wrapRuntimeStorage(dbStorage, normalizedConfig);
}

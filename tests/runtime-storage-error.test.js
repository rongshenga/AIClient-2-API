import {
    getRuntimeStorageErrorClassification,
    getRuntimeStorageErrorPolicy,
    serializeRuntimeStorageError,
    wrapRuntimeStorageError
} from '../src/storage/runtime-storage-error.js';

describe('runtime-storage-error', () => {
    test('should classify timeout and sqlite lock errors as retryable lock conflicts', () => {
        const error = new Error('database is locked');
        error.code = 'ETIMEDOUT';

        const wrapped = wrapRuntimeStorageError(error, {
            operation: 'loadUsageCacheSnapshot',
            phase: 'read',
            domain: 'usage',
            backend: 'db'
        });

        expect(getRuntimeStorageErrorClassification(wrapped)).toBe('lock_conflict');
        expect(getRuntimeStorageErrorPolicy(wrapped)).toMatchObject({
            action: 'retry_then_fallback',
            retryable: true,
            maxRetries: 2,
            fallbackToFile: true
        });
        expect(serializeRuntimeStorageError(wrapped)).toMatchObject({
            classification: 'lock_conflict',
            retryable: true,
            policy: {
                action: 'retry_then_fallback',
                maxRetries: 2,
                fallbackToFile: true,
                blockCutover: false,
                warningOnly: false
            }
        });
    });

    test('should classify constraint and backend availability failures', () => {
        const constraint = wrapRuntimeStorageError(new Error('UNIQUE constraint failed'), {
            operation: 'saveAdminSession'
        });
        const unavailable = wrapRuntimeStorageError(Object.assign(new Error('spawn sqlite3 ENOENT'), {
            code: 'ENOENT'
        }), {
            operation: 'initialize'
        });

        expect(constraint.classification).toBe('constraint_conflict');
        expect(constraint.code).toBe('runtime_storage_constraint_conflict');
        expect(unavailable.classification).toBe('backend_unavailable');
        expect(unavailable.policy).toMatchObject({
            action: 'fallback_to_file',
            fallbackToFile: true,
            blockCutover: true
        });
    });

    test('should classify syntax and serialization failures as data errors', () => {
        const syntaxWrapped = wrapRuntimeStorageError(new SyntaxError('Unexpected end of JSON input'), {
            operation: 'sqlite_query'
        });
        const circularWrapped = wrapRuntimeStorageError(new TypeError('Converting circular structure to JSON'), {
            operation: 'savePotluckUserData'
        });

        expect(syntaxWrapped.classification).toBe('data_error');
        expect(circularWrapped.classification).toBe('data_error');
        expect(circularWrapped.policy).toMatchObject({
            action: 'fail_fast',
            blockCutover: true,
            fallbackToFile: false
        });
    });

    test('should classify parameter and migration validation failures', () => {
        const invalidInput = wrapRuntimeStorageError(Object.assign(new Error('invalid argument'), {
            code: 'EINVAL'
        }), {
            operation: 'getRuntimeStorageMigrationRun'
        });
        const validationError = wrapRuntimeStorageError(new Error('migration verification failed'), {
            operation: 'verifyRuntimeStorageMigration'
        });

        expect(invalidInput.classification).toBe('parameter_error');
        expect(validationError.classification).toBe('migration_validation_failed');
        expect(validationError.policy).toMatchObject({
            action: 'block_cutover',
            fallbackToFile: true,
            blockCutover: true
        });
    });

    test('should normalize details for arrays objects and backend error metadata', () => {
        const wrapped = wrapRuntimeStorageError(Object.assign(new Error('database is locked'), {
            code: 'SQLITE_BUSY',
            details: {
                nested: { any: true }
            }
        }), {
            operation: 'replaceProviderPoolsSnapshot',
            details: {
                ids: Array.from({ length: 25 }, (_, index) => `id-${index}`),
                keep: 'ok'
            }
        });

        const serialized = serializeRuntimeStorageError(wrapped);
        expect(serialized.details).toMatchObject({
            keep: 'ok',
            nested: '[object]',
            backendErrorCode: 'SQLITE_BUSY'
        });
        expect(serialized.details.ids).toHaveLength(20);
    });
});

function normalizeDetails(details) {
    if (!details || typeof details !== 'object') {
        return undefined;
    }

    const normalized = {};
    for (const [key, value] of Object.entries(details)) {
        if (value === undefined) {
            continue;
        }

        if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            normalized[key] = value;
            continue;
        }

        if (Array.isArray(value)) {
            normalized[key] = value.slice(0, 20);
            continue;
        }

        if (value instanceof Date) {
            normalized[key] = value.toISOString();
            continue;
        }

        normalized[key] = '[object]';
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export const RUNTIME_STORAGE_ERROR_POLICIES = {
    parameter_error: {
        code: 'runtime_storage_invalid_input',
        action: 'fail_fast',
        retryable: false,
        maxRetries: 0,
        fallbackToFile: false,
        blockCutover: false,
        warningOnly: false
    },
    data_error: {
        code: 'runtime_storage_invalid_data',
        action: 'fail_fast',
        retryable: false,
        maxRetries: 0,
        fallbackToFile: false,
        blockCutover: true,
        warningOnly: false
    },
    constraint_conflict: {
        code: 'runtime_storage_constraint_conflict',
        action: 'fail_fast',
        retryable: false,
        maxRetries: 0,
        fallbackToFile: false,
        blockCutover: true,
        warningOnly: false
    },
    backend_unavailable: {
        code: 'runtime_storage_backend_unavailable',
        action: 'fallback_to_file',
        retryable: false,
        maxRetries: 0,
        fallbackToFile: true,
        blockCutover: true,
        warningOnly: false
    },
    lock_conflict: {
        code: 'runtime_storage_lock_conflict',
        action: 'retry_then_fallback',
        retryable: true,
        maxRetries: 2,
        fallbackToFile: true,
        blockCutover: false,
        warningOnly: false
    },
    secondary_write_failed: {
        code: 'runtime_storage_secondary_write_failed',
        action: 'warn_and_hold_cutover',
        retryable: false,
        maxRetries: 0,
        fallbackToFile: false,
        blockCutover: true,
        warningOnly: true
    },
    migration_validation_failed: {
        code: 'runtime_storage_validation_failed',
        action: 'block_cutover',
        retryable: false,
        maxRetries: 0,
        fallbackToFile: true,
        blockCutover: true,
        warningOnly: false
    },
    operation_failed: {
        code: 'runtime_storage_operation_failed',
        action: 'fail_fast',
        retryable: false,
        maxRetries: 0,
        fallbackToFile: false,
        blockCutover: false,
        warningOnly: false
    }
};

function inferConstraintConflict(message = '') {
    return message.includes('constraint failed')
        || message.includes('unique constraint')
        || message.includes('foreign key constraint');
}

function inferJsonParseFailure(error, message = '') {
    return error instanceof SyntaxError
        || message.includes('unexpected token')
        || message.includes('unexpected end of json input')
        || message.includes('failed to parse')
        || message.includes('json parse')
        || message.includes('circular structure to json')
        || message.includes('serialize');
}

export function getRuntimeStorageErrorClassification(error) {
    if (!error) {
        return 'operation_failed';
    }

    if (typeof error.classification === 'string' && error.classification) {
        return error.classification;
    }

    const code = String(error.code || '').toUpperCase();
    const message = String(error.message || '').toLowerCase();

    if (code.includes('SECONDARY') || message.includes('secondary write')) {
        return 'secondary_write_failed';
    }

    if (code === 'RUNTIME_STORAGE_VALIDATION_FAILED'
        || code === 'RUNTIME_STORAGE_MIGRATION_VALIDATION_FAILED'
        || message.includes('migration verification failed')) {
        return 'migration_validation_failed';
    }

    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code === 'ETIMEDOUT' || code === 'EAGAIN') {
        return 'lock_conflict';
    }

    if (message.includes('database is locked')
        || message.includes('busy timeout')
        || message.includes('temporarily unavailable')
        || message.includes('timed out')) {
        return 'lock_conflict';
    }

    if (code === 'SQLITE_CONSTRAINT' || inferConstraintConflict(message)) {
        return 'constraint_conflict';
    }

    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'ENOTDIR' || code === 'EPIPE') {
        return 'backend_unavailable';
    }

    if (message.includes('spawn ')
        || message.includes('sqlite3 exited with code')
        || message.includes('backend unavailable')) {
        return 'backend_unavailable';
    }

    if (code.startsWith('ERR_INVALID')
        || code === 'EINVAL'
        || message.includes('invalid argument')
        || message.includes('requires runid')
        || message.includes('runid is required')) {
        return 'parameter_error';
    }

    if (inferJsonParseFailure(error, message)) {
        return 'data_error';
    }

    return 'operation_failed';
}

export function getRuntimeStorageErrorPolicy(errorOrClassification) {
    const classification = typeof errorOrClassification === 'string'
        ? errorOrClassification
        : getRuntimeStorageErrorClassification(errorOrClassification);

    return {
        classification,
        ...(RUNTIME_STORAGE_ERROR_POLICIES[classification] || RUNTIME_STORAGE_ERROR_POLICIES.operation_failed)
    };
}

export function isRetryableRuntimeStorageError(error) {
    const policy = getRuntimeStorageErrorPolicy(error);
    if (policy.retryable) {
        return true;
    }

    const code = String(error?.code || '').toUpperCase();
    const message = String(error?.message || '').toLowerCase();
    return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code === 'ETIMEDOUT' || code === 'EAGAIN'
        || message.includes('database is locked')
        || message.includes('busy timeout')
        || message.includes('temporarily unavailable')
        || message.includes('timed out');
}

export function wrapRuntimeStorageError(error, defaults = {}) {
    const classification = defaults.classification
        || error?.classification
        || getRuntimeStorageErrorClassification(error);
    const policy = {
        ...getRuntimeStorageErrorPolicy(classification),
        ...(error?.policy || {}),
        ...(defaults.policy || {})
    };

    const wrapped = new Error(defaults.message || error?.message || 'Runtime storage operation failed');
    wrapped.name = 'RuntimeStorageError';
    wrapped.classification = classification;
    wrapped.code = defaults.code || error?.code || policy.code || 'runtime_storage_operation_failed';
    wrapped.phase = defaults.phase || error?.phase || null;
    wrapped.domain = defaults.domain || error?.domain || null;
    wrapped.backend = defaults.backend || error?.backend || null;
    wrapped.operation = defaults.operation || error?.operation || null;
    wrapped.retryable = defaults.retryable ?? error?.retryable ?? policy.retryable ?? isRetryableRuntimeStorageError(error);
    wrapped.policy = {
        classification,
        code: policy.code || wrapped.code,
        action: defaults.action || policy.action,
        maxRetries: defaults.maxRetries ?? policy.maxRetries ?? 0,
        fallbackToFile: defaults.fallbackToFile ?? policy.fallbackToFile ?? false,
        blockCutover: defaults.blockCutover ?? policy.blockCutover ?? false,
        warningOnly: defaults.warningOnly ?? policy.warningOnly ?? false
    };
    wrapped.details = normalizeDetails({
        ...(error?.details || {}),
        ...(defaults.details || {}),
        classification,
        action: wrapped.policy.action,
        maxRetries: wrapped.policy.maxRetries,
        fallbackToFile: wrapped.policy.fallbackToFile,
        blockCutover: wrapped.policy.blockCutover,
        warningOnly: wrapped.policy.warningOnly,
        backendErrorCode: error?.code || undefined,
        backendErrorMessage: error?.message && error?.message !== wrapped.message ? error.message : undefined
    });

    if (error instanceof Error) {
        wrapped.cause = error;
        wrapped.stack = error.stack || wrapped.stack;
    }

    return wrapped;
}

export function serializeRuntimeStorageError(error) {
    if (!error) {
        return null;
    }

    return {
        message: error.message || 'Runtime storage operation failed',
        code: error.code || 'runtime_storage_operation_failed',
        classification: error.classification || getRuntimeStorageErrorClassification(error),
        phase: error.phase || null,
        domain: error.domain || null,
        backend: error.backend || null,
        operation: error.operation || null,
        retryable: error.retryable === true,
        policy: error.policy
            ? {
                action: error.policy.action || null,
                maxRetries: Number.isFinite(error.policy.maxRetries) ? error.policy.maxRetries : 0,
                fallbackToFile: error.policy.fallbackToFile === true,
                blockCutover: error.policy.blockCutover === true,
                warningOnly: error.policy.warningOnly === true
            }
            : null,
        details: normalizeDetails(error.details) || null
    };
}

import { createHash } from 'crypto';
import * as path from 'path';
import { formatSystemPath, getCredentialPathKeyByProviderType } from '../utils/provider-utils.js';

const RUNTIME_FIELD_MAP = {
    isHealthy: 'is_healthy',
    isDisabled: 'is_disabled',
    usageCount: 'usage_count',
    errorCount: 'error_count',
    lastUsed: 'last_used_at',
    lastHealthCheckTime: 'last_health_check_at',
    lastHealthCheckModel: 'last_health_check_model',
    lastErrorTime: 'last_error_time',
    lastErrorMessage: 'last_error_message',
    scheduledRecoveryTime: 'scheduled_recovery_at',
    refreshCount: 'refresh_count',
    _lastSelectionSeq: 'last_selection_seq'
};

const NON_SECRET_UPPERCASE_FIELDS = new Set([
    'PROJECT_ID',
    'GROK_BASE_URL',
    'GROK_USER_AGENT',
    'CODEX_BASE_URL',
    'FORWARD_BASE_URL',
    'OPENAI_BASE_URL',
    'CLAUDE_BASE_URL'
]);

const TRANSIENT_RUNTIME_FIELDS = new Set([
    'needsRefresh'
]);

const DERIVED_PROVIDER_METADATA_FIELDS = new Set([
    'email',
    'accountId'
]);

function sortObject(value) {
    if (Array.isArray(value)) {
        return value.map((item) => sortObject(item));
    }

    if (value && typeof value === 'object' && !(value instanceof Date)) {
        return Object.keys(value)
            .sort()
            .reduce((result, key) => {
                result[key] = sortObject(value[key]);
                return result;
            }, {});
    }

    return value;
}

function stableSerialize(value) {
    return JSON.stringify(sortObject(value));
}

function stableHash(value) {
    return createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeInteger(value, fallback = 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeNullableInteger(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    return normalizeInteger(value, null);
}

function normalizeTimestamp(value) {
    if (!value) {
        return null;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toBoolean(value, fallback = false) {
    if (value === undefined || value === null) {
        return fallback;
    }
    return Boolean(value);
}

function parseJsonSafe(value, fallback) {
    if (!value) {
        return fallback;
    }

    try {
        return JSON.parse(value);
    } catch (error) {
        return fallback;
    }
}

function pickFirstString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }

    return '';
}

function normalizeStoredPath(filePath) {
    if (!filePath || typeof filePath !== 'string') {
        return null;
    }

    return filePath.replace(/\\/g, '/');
}

function normalizeEmail(value) {
    if (!value || typeof value !== 'string') {
        return null;
    }

    const normalized = value.trim().toLowerCase();
    return normalized || null;
}

function normalizeNullableString(value) {
    if (!value || typeof value !== 'string') {
        return null;
    }

    const normalized = value.trim();
    return normalized || null;
}

function parseJwtPayloadSafe(token) {
    if (!token || typeof token !== 'string') {
        return null;
    }

    try {
        const segments = token.split('.');
        if (segments.length < 2) {
            return null;
        }

        const payloadSegment = segments[1]
            .replace(/-/g, '+')
            .replace(/_/g, '/');
        const padding = payloadSegment.length % 4;
        const padded = padding === 0 ? payloadSegment : payloadSegment + '='.repeat(4 - padding);
        return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    } catch (error) {
        return null;
    }
}

function hasCodexCredentialShape(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    return [
        'access_token',
        'refresh_token',
        'id_token',
        'account_id',
        'email',
        'expired',
        'exp'
    ].some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function extractCodexCredentialPayload(rawToken) {
    if (hasCodexCredentialShape(rawToken)) {
        return rawToken;
    }

    const nestedKeys = ['token', 'credentials', 'auth', 'data', 'oauth', 'codex'];
    for (const key of nestedKeys) {
        const nested = rawToken?.[key];
        if (hasCodexCredentialShape(nested)) {
            return nested;
        }
    }

    return rawToken || {};
}

function normalizeGeminiLikePayload(rawPayload = {}) {
    const hasNestedToken = rawPayload.token && typeof rawPayload.token === 'object' && !Array.isArray(rawPayload.token);
    const payload = hasNestedToken ? rawPayload.token : rawPayload;

    return {
        refreshToken: pickFirstString(payload.refresh_token, payload.refreshToken),
        email: normalizeEmail(payload.email),
        accountId: normalizeNullableString(payload.account_id || payload.accountId),
        externalUserId: normalizeNullableString(payload.sub || payload.user_id || payload.userId)
    };
}

function normalizeCodexPayload(rawPayload = {}) {
    const payload = extractCodexCredentialPayload(rawPayload);
    const idToken = pickFirstString(payload.id_token, rawPayload.id_token);
    const accessToken = pickFirstString(payload.access_token, rawPayload.access_token);
    const idClaims = parseJwtPayloadSafe(idToken);
    const accessClaims = parseJwtPayloadSafe(accessToken);
    const authClaims = payload['https://api.openai.com/auth']
        || rawPayload['https://api.openai.com/auth']
        || idClaims?.['https://api.openai.com/auth']
        || accessClaims?.['https://api.openai.com/auth']
        || {};
    const profileClaims = payload['https://api.openai.com/profile']
        || rawPayload['https://api.openai.com/profile']
        || accessClaims?.['https://api.openai.com/profile']
        || {};

    return {
        refreshToken: pickFirstString(payload.refresh_token, rawPayload.refresh_token),
        email: normalizeEmail(pickFirstString(
            payload.email,
            rawPayload.email,
            idClaims?.email,
            profileClaims?.email
        )),
        accountId: normalizeNullableString(pickFirstString(
            payload.account_id,
            rawPayload.account_id,
            authClaims?.chatgpt_account_id,
            idClaims?.sub,
            accessClaims?.sub
        )),
        externalUserId: normalizeNullableString(pickFirstString(payload.session_id, rawPayload.session_id))
    };
}

function normalizeKiroPayload(rawPayload = {}) {
    return {
        refreshToken: pickFirstString(rawPayload.refreshToken, rawPayload.refresh_token),
        email: normalizeEmail(rawPayload.email),
        accountId: normalizeNullableString(rawPayload.accountId || rawPayload.account_id),
        externalUserId: normalizeNullableString(rawPayload.clientId || rawPayload.client_id)
    };
}

function normalizeIFlowPayload(rawPayload = {}) {
    return {
        refreshToken: pickFirstString(rawPayload.refresh_token, rawPayload.refreshToken),
        email: normalizeEmail(rawPayload.email),
        accountId: normalizeNullableString(rawPayload.account_id || rawPayload.accountId),
        externalUserId: normalizeNullableString(rawPayload.user_id || rawPayload.userId)
    };
}

function normalizeCredentialIdentity(providerType, rawPayload = {}) {
    switch (providerType) {
        case 'openai-codex-oauth':
            return normalizeCodexPayload(rawPayload);
        case 'claude-kiro-oauth':
            return normalizeKiroPayload(rawPayload);
        case 'openai-iflow':
            return normalizeIFlowPayload(rawPayload);
        case 'gemini-cli-oauth':
        case 'gemini-antigravity':
        case 'openai-qwen-oauth':
            return normalizeGeminiLikePayload(rawPayload);
        default:
            return {
                refreshToken: pickFirstString(
                    rawPayload.refresh_token,
                    rawPayload.refreshToken,
                    rawPayload.access_token,
                    rawPayload.accessToken,
                    rawPayload.apiKey,
                    rawPayload.token
                ),
                email: normalizeEmail(rawPayload.email),
                accountId: normalizeNullableString(rawPayload.account_id || rawPayload.accountId),
                externalUserId: normalizeNullableString(rawPayload.user_id || rawPayload.userId)
            };
    }
}

function buildCredentialIdentity(providerType, rawPayload = {}) {
    const normalized = normalizeCredentialIdentity(providerType, rawPayload);
    const email = normalized.email || null;
    const accountId = normalized.accountId || null;
    const externalUserId = normalized.externalUserId || null;

    let identityKey = null;
    if (providerType === 'openai-codex-oauth' && email && accountId) {
        identityKey = `${email}#${accountId}`;
    } else if (email && accountId) {
        identityKey = `${email}#${accountId}`;
    } else if (email) {
        identityKey = email;
    }

    let dedupeKey = identityKey ? `identity:${identityKey}` : null;
    if (!dedupeKey && normalized.refreshToken) {
        dedupeKey = `refresh:${stableHash(normalized.refreshToken)}`;
    }
    if (!dedupeKey && externalUserId) {
        dedupeKey = `external:${providerType}:${stableHash(externalUserId)}`;
    }

    return {
        identityKey,
        dedupeKey,
        email,
        accountId,
        externalUserId
    };
}

export function isCredentialPathField(fieldName) {
    if (!fieldName || typeof fieldName !== 'string') {
        return false;
    }

    return fieldName.endsWith('_FILE_PATH')
        || fieldName.endsWith('_CREDS_FILE_PATH')
        || fieldName.endsWith('_TOKEN_FILE_PATH');
}

export function extractCredentialPathEntries(providerConfig = {}) {
    const entries = [];

    for (const [key, value] of Object.entries(providerConfig || {})) {
        if (key.startsWith('__')) {
            continue;
        }
        if (!isCredentialPathField(key)) {
            continue;
        }

        const normalizedPath = normalizeStoredPath(value);
        if (!normalizedPath) {
            continue;
        }

        entries.push({
            fieldName: key,
            filePath: normalizedPath
        });
    }

    return entries;
}

export function buildStableCredentialAssetId(providerType, dedupeKey) {
    const hash = createHash('sha256')
        .update(`${providerType}::${dedupeKey}`)
        .digest('hex')
        .slice(0, 24);

    return `cred_${hash}`;
}

export function buildCredentialBindingId(bindingType, bindingTargetId, credentialAssetId) {
    const hash = createHash('sha256')
        .update(`${bindingType}::${bindingTargetId}::${credentialAssetId}`)
        .digest('hex')
        .slice(0, 24);

    return `bind_${hash}`;
}

export function buildCredentialFileIndexId(credentialAssetId, filePath) {
    const hash = createHash('sha256')
        .update(`${credentialAssetId}::${normalizeStoredPath(filePath) || ''}`)
        .digest('hex')
        .slice(0, 24);

    return `cfi_${hash}`;
}

export function buildCredentialAssetRecord({
    providerType,
    sourcePath,
    payload = null,
    rawContent = '',
    stats = null,
    sourceKind = 'file_import',
    timestamp = null
}) {
    const normalizedPath = normalizeStoredPath(sourcePath);
    const parsedPayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    const contentFingerprintSource = rawContent && rawContent.trim()
        ? rawContent.trim()
        : (Object.keys(parsedPayload).length > 0 ? stableSerialize(parsedPayload) : (normalizedPath || ''));
    const sourceChecksum = stableHash(contentFingerprintSource);
    const identity = buildCredentialIdentity(providerType, parsedPayload);
    const dedupeKey = identity.dedupeKey
        || (sourceChecksum ? `checksum:${sourceChecksum}` : `path:${stableHash(normalizedPath || providerType)}`);
    const assetId = buildStableCredentialAssetId(providerType, dedupeKey);
    const importedAt = timestamp || new Date().toISOString();

    const asset = {
        id: assetId,
        providerType,
        identityKey: identity.identityKey,
        dedupeKey,
        email: identity.email,
        accountId: identity.accountId,
        externalUserId: identity.externalUserId,
        sourceKind,
        sourcePath: normalizedPath,
        sourceChecksum,
        storageMode: normalizedPath ? 'file_reference' : 'metadata_only',
        isActive: true,
        lastImportedAt: importedAt,
        lastRefreshedAt: null,
        createdAt: importedAt,
        updatedAt: importedAt
    };

    const fileIndex = normalizedPath ? {
        id: buildCredentialFileIndexId(assetId, normalizedPath),
        credentialAssetId: assetId,
        filePath: normalizedPath,
        fileName: path.basename(normalizedPath),
        fileSize: Number.isFinite(stats?.size) ? stats.size : null,
        checksum: sourceChecksum,
        mtime: stats?.mtime instanceof Date ? stats.mtime.toISOString() : normalizeTimestamp(stats?.mtime),
        isPrimary: true,
        createdAt: importedAt,
        updatedAt: importedAt
    } : null;

    return {
        asset,
        fileIndex
    };
}

function buildStableProviderIdentitySource(providerConfig = {}) {
    const staticConfig = {};
    const credentialPaths = {};
    const inlineSecretFingerprints = {};

    for (const [key, value] of Object.entries(providerConfig || {})) {
        if (key === 'uuid' || key === '__providerId') {
            continue;
        }
        if (key.startsWith('__')) {
            continue;
        }
        if (DERIVED_PROVIDER_METADATA_FIELDS.has(key)) {
            continue;
        }
        if (Object.prototype.hasOwnProperty.call(RUNTIME_FIELD_MAP, key)) {
            continue;
        }
        if (TRANSIENT_RUNTIME_FIELDS.has(key)) {
            continue;
        }
        if (isCredentialPathField(key)) {
            const normalizedPath = normalizeStoredPath(value);
            if (normalizedPath) {
                credentialPaths[key] = normalizedPath;
            }
            continue;
        }
        if (isInlineSecretField(key)) {
            inlineSecretFingerprints[key] = stableHash(stableSerialize(value));
            continue;
        }

        staticConfig[key] = value;
    }

    return sortObject({
        staticConfig,
        credentialPaths,
        inlineSecretFingerprints
    });
}

function buildIdentitySeed(providerType, providerConfig, identitySource) {
    const normalizedIdentitySource = identitySource && typeof identitySource === 'object'
        ? identitySource
        : {};
    const identityDiscriminator = {
        customName: providerConfig?.customName || '',
        staticConfig: normalizedIdentitySource.staticConfig || {},
        credentialPaths: normalizedIdentitySource.credentialPaths || {},
        inlineSecretFingerprints: normalizedIdentitySource.inlineSecretFingerprints || {}
    };

    const hasStrongDiscriminator = Object.keys(identityDiscriminator.credentialPaths).length > 0
        || Object.keys(identityDiscriminator.inlineSecretFingerprints).length > 0;

    if (!hasStrongDiscriminator && providerConfig?.uuid) {
        identityDiscriminator.routingUuid = providerConfig.uuid;
    }

    return [
        providerType,
        stableSerialize(identityDiscriminator)
    ].join('::');
}

export function isInlineSecretField(fieldName) {
    if (!fieldName || typeof fieldName !== 'string') {
        return false;
    }

    if (!/^[A-Z0-9_]+$/.test(fieldName)) {
        return false;
    }

    if (fieldName.endsWith('_FILE_PATH') || fieldName.endsWith('_CREDS_FILE_PATH') || fieldName.endsWith('_TOKEN_FILE_PATH')) {
        return false;
    }

    if (NON_SECRET_UPPERCASE_FIELDS.has(fieldName)) {
        return false;
    }

    return /(TOKEN|COOKIE|SECRET|PASSWORD|API_KEY|ACCESS_KEY|AUTH|CLEARANCE|SESSION)/i.test(fieldName);
}

export function buildStableProviderId(providerType, providerConfig = {}) {
    const identitySource = buildStableProviderIdentitySource(providerConfig);
    const hash = createHash('sha256')
        .update(buildIdentitySeed(providerType, providerConfig, identitySource))
        .digest('hex')
        .slice(0, 24);

    return `prov_${hash}`;
}

export function splitProviderConfig(providerType, providerConfig = {}) {
    const explicitProviderId = providerConfig.__providerId || null;
    const sourceConfig = { ...providerConfig };
    const providerId = explicitProviderId || sourceConfig.__providerId || buildStableProviderId(providerType, sourceConfig);
    const inlineSecrets = [];
    const credentialReferences = [];
    const staticConfig = {};

    for (const [key, value] of Object.entries(sourceConfig)) {
        if (key === '__providerId' || key.startsWith('__')) {
            continue;
        }
        if (key === 'uuid' || key === 'customName' || key === 'checkModelName') {
            continue;
        }
        if (DERIVED_PROVIDER_METADATA_FIELDS.has(key)) {
            continue;
        }
        if (Object.prototype.hasOwnProperty.call(RUNTIME_FIELD_MAP, key)) {
            continue;
        }
        if (TRANSIENT_RUNTIME_FIELDS.has(key)) {
            continue;
        }
        if (isCredentialPathField(key)) {
            const normalizedPath = normalizeStoredPath(value);
            if (normalizedPath) {
                credentialReferences.push({
                    fieldName: key,
                    filePath: normalizedPath
                });
            }
            continue;
        }
        if (isInlineSecretField(key)) {
            inlineSecrets.push({
                providerId,
                secretKind: key,
                secretPayload: JSON.stringify(value),
                protectionMode: 'plain_text'
            });
            continue;
        }
        staticConfig[key] = value;
    }

    const registration = {
        providerId,
        providerType,
        routingUuid: sourceConfig.uuid || providerId,
        displayName: sourceConfig.customName || null,
        checkModel: sourceConfig.checkModelName || null,
        projectId: sourceConfig.PROJECT_ID || null,
        baseUrl: Object.keys(staticConfig).find((key) => key.endsWith('_BASE_URL')) ? staticConfig[Object.keys(staticConfig).find((key) => key.endsWith('_BASE_URL'))] : null,
        configJson: JSON.stringify(sortObject(staticConfig)),
        sourceKind: 'provider_pools_json'
    };

    const runtimeState = {
        providerId,
        isHealthy: toBoolean(sourceConfig.isHealthy, true),
        isDisabled: toBoolean(sourceConfig.isDisabled, false),
        usageCount: normalizeInteger(sourceConfig.usageCount, 0),
        errorCount: normalizeInteger(sourceConfig.errorCount, 0),
        lastUsed: normalizeTimestamp(sourceConfig.lastUsed),
        lastHealthCheckTime: normalizeTimestamp(sourceConfig.lastHealthCheckTime),
        lastHealthCheckModel: sourceConfig.lastHealthCheckModel || null,
        lastErrorTime: normalizeTimestamp(sourceConfig.lastErrorTime),
        lastErrorMessage: sourceConfig.lastErrorMessage || null,
        scheduledRecoveryTime: normalizeTimestamp(sourceConfig.scheduledRecoveryTime),
        refreshCount: normalizeInteger(sourceConfig.refreshCount, 0),
        lastSelectionSeq: normalizeNullableInteger(sourceConfig._lastSelectionSeq)
    };

    return {
        providerId,
        registration,
        runtimeState,
        inlineSecrets,
        credentialReferences
    };
}

export function mergeProviderRecord({ registration, runtimeState, inlineSecrets = [], credentialBindings = [] }) {
    const config = parseJsonSafe(registration.config_json || registration.configJson, {});

    config.uuid = registration.routing_uuid || registration.routingUuid;
    config.customName = registration.display_name ?? registration.displayName ?? null;

    if (registration.check_model || registration.checkModel) {
        config.checkModelName = registration.check_model || registration.checkModel;
    }

    if (registration.project_id || registration.projectId) {
        config.PROJECT_ID = registration.project_id || registration.projectId;
    }

    for (const secret of inlineSecrets) {
        config[secret.secret_kind || secret.secretKind] = parseJsonSafe(secret.secret_payload || secret.secretPayload, secret.secret_payload || secret.secretPayload);
    }

    const credentialPathKey = getCredentialPathKeyByProviderType(registration.provider_type || registration.providerType);
    const activeBinding = credentialBindings.find((item) => item && item.filePath);
    if (credentialPathKey && activeBinding?.filePath) {
        config[credentialPathKey] = formatSystemPath(activeBinding.filePath);
    }

    const resolvedEmail = normalizeEmail(activeBinding?.email) || normalizeEmail(config.email);
    const resolvedAccountId = normalizeNullableString(activeBinding?.accountId || activeBinding?.account_id)
        || normalizeNullableString(config.accountId || config.account_id);
    if (resolvedEmail) {
        config.email = resolvedEmail;
    }
    if (resolvedAccountId) {
        config.accountId = resolvedAccountId;
    }

    const runtimeSource = runtimeState || {};
    config.isHealthy = runtimeSource.is_healthy !== undefined && runtimeSource.is_healthy !== null
        ? Boolean(runtimeSource.is_healthy)
        : true;
    config.isDisabled = runtimeSource.is_disabled !== undefined && runtimeSource.is_disabled !== null
        ? Boolean(runtimeSource.is_disabled)
        : false;
    config.usageCount = normalizeInteger(runtimeSource.usage_count, 0);
    config.errorCount = normalizeInteger(runtimeSource.error_count, 0);
    config.lastUsed = runtimeSource.last_used_at || null;
    config.lastHealthCheckTime = runtimeSource.last_health_check_at || null;
    config.lastHealthCheckModel = runtimeSource.last_health_check_model || null;
    config.lastErrorTime = runtimeSource.last_error_time || null;
    config.lastErrorMessage = runtimeSource.last_error_message || null;
    config.scheduledRecoveryTime = runtimeSource.scheduled_recovery_at || null;
    config.refreshCount = normalizeInteger(runtimeSource.refresh_count, 0);

    if (runtimeSource.last_selection_seq !== undefined && runtimeSource.last_selection_seq !== null) {
        config._lastSelectionSeq = normalizeInteger(runtimeSource.last_selection_seq, 0);
    }

    Object.defineProperty(config, '__providerId', {
        value: registration.provider_id || registration.providerId || null,
        enumerable: false,
        configurable: true,
        writable: true
    });

    return config;
}

export function buildProviderPoolsSnapshot(rows = [], secretRows = [], credentialRows = []) {
    const secretsByProvider = new Map();
    for (const secret of secretRows) {
        const providerId = secret.provider_id || secret.providerId;
        if (!secretsByProvider.has(providerId)) {
            secretsByProvider.set(providerId, []);
        }
        secretsByProvider.get(providerId).push(secret);
    }

    const credentialsByProvider = new Map();
    for (const credential of credentialRows) {
        const providerId = credential.provider_id || credential.providerId;
        if (!providerId) {
            continue;
        }
        if (!credentialsByProvider.has(providerId)) {
            credentialsByProvider.set(providerId, []);
        }
        credentialsByProvider.get(providerId).push({
            filePath: normalizeStoredPath(credential.file_path || credential.filePath || credential.source_path || credential.sourcePath),
            credentialAssetId: credential.credential_asset_id || credential.credentialAssetId || null,
            email: normalizeEmail(credential.email),
            accountId: normalizeNullableString(credential.account_id || credential.accountId)
        });
    }

    const snapshot = {};
    for (const row of rows) {
        const providerType = row.provider_type || row.providerType;
        if (!snapshot[providerType]) {
            snapshot[providerType] = [];
        }
        snapshot[providerType].push(mergeProviderRecord({
            registration: row,
            runtimeState: row,
            inlineSecrets: secretsByProvider.get(row.provider_id || row.providerId) || [],
            credentialBindings: credentialsByProvider.get(row.provider_id || row.providerId) || []
        }));
    }

    return snapshot;
}

export function sqlValue(value) {
    if (value === undefined || value === null) {
        return 'NULL';
    }

    if (typeof value === 'boolean') {
        return value ? '1' : '0';
    }

    if (typeof value === 'number') {
        return Number.isFinite(value) ? String(value) : 'NULL';
    }

    return `'${String(value).replace(/'/g, "''")}'`;
}

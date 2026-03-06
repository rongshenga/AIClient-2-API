import {
    buildCredentialAssetRecord,
    buildProviderPoolsSnapshot,
    extractCredentialPathEntries,
    isCredentialPathField,
    isInlineSecretField,
    mergeProviderRecord,
    splitProviderConfig,
    sqlValue
} from '../src/storage/provider-storage-mapper.js';

describe('provider-storage-mapper', () => {
    test('should build credential asset identity from nested codex payload and normalize paths', () => {
        const record = buildCredentialAssetRecord({
            providerType: 'openai-codex-oauth',
            sourcePath: 'configs\\codex\\cred.json',
            payload: {
                token: {
                    refresh_token: 'refresh-token',
                    email: 'User@Example.COM',
                    account_id: 'acct-1'
                }
            },
            rawContent: '{"token":{"refresh_token":"refresh-token"}}',
            timestamp: '2026-03-06T10:00:00.000Z'
        });

        expect(record.asset).toMatchObject({
            providerType: 'openai-codex-oauth',
            identityKey: 'user@example.com#acct-1',
            dedupeKey: 'identity:user@example.com#acct-1',
            email: 'user@example.com',
            accountId: 'acct-1',
            storageMode: 'file_reference',
            sourcePath: 'configs/codex/cred.json'
        });
        expect(record.fileIndex).toMatchObject({
            filePath: 'configs/codex/cred.json',
            fileName: 'cred.json',
            isPrimary: true
        });
    });

    test('should build metadata-only credential assets for empty input payloads', () => {
        const record = buildCredentialAssetRecord({
            providerType: 'grok-custom',
            sourcePath: null,
            payload: null,
            rawContent: '',
            timestamp: '2026-03-06T10:00:00.000Z'
        });

        expect(record.asset.storageMode).toBe('metadata_only');
        expect(record.asset.identityKey).toBeNull();
        expect(record.asset.dedupeKey).toMatch(/^checksum:/);
        expect(record.fileIndex).toBeNull();
    });

    test('should split provider configs into registration runtime secrets and credential references', () => {
        const result = splitProviderConfig('openai-codex-oauth', {
            uuid: 'provider-uuid-1',
            customName: 'Codex Node',
            checkModelName: 'gpt-4.1',
            CODEX_OAUTH_CREDS_FILE_PATH: 'configs\\codex\\oauth.json',
            OPENAI_API_KEY: 'secret-key',
            OPENAI_BASE_URL: 'https://api.example.com/v1',
            isHealthy: false,
            errorCount: '7',
            refreshCount: '3',
            _lastSelectionSeq: '42',
            needsRefresh: true,
            lastErrorTime: 'bad-time'
        });

        expect(result.registration).toMatchObject({
            providerType: 'openai-codex-oauth',
            routingUuid: 'provider-uuid-1',
            displayName: 'Codex Node',
            checkModel: 'gpt-4.1',
            baseUrl: 'https://api.example.com/v1'
        });
        expect(result.runtimeState).toMatchObject({
            isHealthy: false,
            errorCount: 7,
            refreshCount: 3,
            lastSelectionSeq: 42,
            lastErrorTime: null
        });
        expect(result.inlineSecrets).toEqual([
            expect.objectContaining({
                secretKind: 'OPENAI_API_KEY',
                secretPayload: '"secret-key"'
            })
        ]);
        expect(result.credentialReferences).toEqual([
            {
                fieldName: 'CODEX_OAUTH_CREDS_FILE_PATH',
                filePath: 'configs/codex/oauth.json'
            }
        ]);
        expect(JSON.parse(result.registration.configJson)).toMatchObject({
            OPENAI_BASE_URL: 'https://api.example.com/v1'
        });
    });

    test('should merge provider records with invalid config json and preserve raw secret payloads', () => {
        const merged = mergeProviderRecord({
            registration: {
                provider_id: 'prov_1',
                provider_type: 'openai-codex-oauth',
                routing_uuid: 'uuid-1',
                display_name: 'Codex Node',
                check_model: 'gpt-4.1',
                project_id: 'project-1',
                config_json: '{not-json'
            },
            runtimeState: {
                is_healthy: 0,
                is_disabled: 1,
                usage_count: '12',
                error_count: '2',
                last_error_time: '2026-03-06T10:00:00.000Z',
                last_selection_seq: '5'
            },
            inlineSecrets: [
                {
                    secret_kind: 'OPENAI_API_KEY',
                    secret_payload: '{not-json'
                }
            ],
            credentialBindings: [
                {
                    filePath: 'configs/codex/oauth.json',
                    credentialAssetId: 'cred_1'
                }
            ]
        });

        expect(merged).toMatchObject({
            uuid: 'uuid-1',
            customName: 'Codex Node',
            checkModelName: 'gpt-4.1',
            PROJECT_ID: 'project-1',
            OPENAI_API_KEY: '{not-json',
            CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/oauth.json',
            isHealthy: false,
            isDisabled: true,
            usageCount: 12,
            errorCount: 2,
            lastErrorTime: '2026-03-06T10:00:00.000Z',
            _lastSelectionSeq: 5
        });
        expect(merged.__providerId).toBe('prov_1');
        expect(Object.keys(merged)).not.toContain('__providerId');
    });

    test('should group provider pool snapshot rows by provider type and attach paths', () => {
        const snapshot = buildProviderPoolsSnapshot(
            [
                {
                    provider_id: 'prov_a',
                    provider_type: 'grok-custom',
                    routing_uuid: 'uuid-a',
                    display_name: 'Grok A',
                    config_json: '{}',
                    is_healthy: 1,
                    usage_count: 1
                },
                {
                    provider_id: 'prov_b',
                    provider_type: 'openai-codex-oauth',
                    routing_uuid: 'uuid-b',
                    display_name: 'Codex B',
                    config_json: '{}',
                    is_healthy: 0,
                    usage_count: 0
                }
            ],
            [
                {
                    provider_id: 'prov_a',
                    secret_kind: 'GROK_COOKIE_TOKEN',
                    secret_payload: '"secret-a"'
                }
            ],
            [
                {
                    provider_id: 'prov_b',
                    file_path: 'configs/codex/oauth.json',
                    credential_asset_id: 'cred_b'
                }
            ]
        );

        expect(Object.keys(snapshot).sort()).toEqual(['grok-custom', 'openai-codex-oauth']);
        expect(snapshot['grok-custom'][0]).toMatchObject({
            uuid: 'uuid-a',
            customName: 'Grok A',
            GROK_COOKIE_TOKEN: 'secret-a',
            usageCount: 1
        });
        expect(snapshot['openai-codex-oauth'][0]).toMatchObject({
            uuid: 'uuid-b',
            customName: 'Codex B',
            CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/oauth.json',
            isHealthy: false
        });
    });

    test('should expose credential path and secret field helpers', () => {
        expect(isCredentialPathField(undefined)).toBe(false);
        expect(isCredentialPathField('CODEX_OAUTH_CREDS_FILE_PATH')).toBe(true);
        expect(isInlineSecretField('OPENAI_API_KEY')).toBe(true);
        expect(isInlineSecretField('OPENAI_BASE_URL')).toBe(false);
        expect(extractCredentialPathEntries({
            __internal: 'x',
            CODEX_OAUTH_CREDS_FILE_PATH: 'configs\\codex\\oauth.json',
            OPENAI_BASE_URL: 'https://api.example.com'
        })).toEqual([
            {
                fieldName: 'CODEX_OAUTH_CREDS_FILE_PATH',
                filePath: 'configs/codex/oauth.json'
            }
        ]);
    });

    test('should encode sql values safely', () => {
        expect(sqlValue(null)).toBe('NULL');
        expect(sqlValue(true)).toBe('1');
        expect(sqlValue(false)).toBe('0');
        expect(sqlValue(12)).toBe('12');
        expect(sqlValue(Number.POSITIVE_INFINITY)).toBe('NULL');
        expect(sqlValue("can't")).toBe("'can''t'");
    });
test('should normalize default runtime values timestamps and generated routing ids when splitting configs', () => {
    const result = splitProviderConfig('grok-custom', {
        uuid: '',
        customName: null,
        GROK_BASE_URL: 'https://grok.example.com',
        GROK_COOKIE_TOKEN: 'secret-token',
        usageCount: 'not-a-number',
        errorCount: undefined,
        refreshCount: '0',
        lastUsed: 'not-a-date',
        lastErrorTime: '2026-03-06T10:00:00.000Z',
        scheduledRecoveryTime: 'still-not-a-date',
        _lastSelectionSeq: ''
    });

    expect(result.registration.routingUuid).toBe(result.providerId);
    expect(result.runtimeState).toMatchObject({
        providerId: result.providerId,
        isHealthy: true,
        isDisabled: false,
        usageCount: 0,
        errorCount: 0,
        lastUsed: null,
        lastErrorTime: '2026-03-06T10:00:00.000Z',
        scheduledRecoveryTime: null,
        refreshCount: 0,
        lastSelectionSeq: null
    });
});

test('should preserve boolean timestamp and numeric defaults when rebuilding compat snapshots', () => {
    const snapshot = buildProviderPoolsSnapshot([
        {
            provider_id: 'prov_default',
            provider_type: 'grok-custom',
            routing_uuid: 'uuid-default',
            display_name: null,
            config_json: '{"queueLimit":0}',
            last_health_check_at: '2026-03-06T08:00:00.000Z',
            error_count: 'not-a-number'
        }
    ]);

    expect(snapshot['grok-custom'][0]).toMatchObject({
        uuid: 'uuid-default',
        customName: null,
        queueLimit: 0,
        isHealthy: true,
        isDisabled: false,
        usageCount: 0,
        errorCount: 0,
        lastUsed: null,
        lastHealthCheckTime: '2026-03-06T08:00:00.000Z',
        refreshCount: 0
    });
});
});

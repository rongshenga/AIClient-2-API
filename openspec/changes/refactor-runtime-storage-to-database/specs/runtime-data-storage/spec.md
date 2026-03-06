## ADDED Requirements

### Requirement: Database-backed runtime state
The system SHALL support a database-backed runtime storage backend as the authoritative store for mutable high-frequency operational data.

#### Scenario: Provider runtime state writes are transactional
- **WHEN** provider selection state, usage counters, health status, or cache data are updated
- **THEN** the system SHALL persist those updates through the database backend using an atomic write path
- **AND** the system SHALL avoid rewriting large shared JSON files for each runtime update

#### Scenario: Runtime state is restored from database on startup
- **WHEN** the service starts with database-backed runtime storage enabled
- **THEN** the system SHALL load provider runtime state, usage cache, and plugin runtime data from the database backend before serving traffic

### Requirement: File compatibility during migration
The system SHALL preserve compatibility with existing `configs/`-based import, export, and recovery workflows during the migration period.

#### Scenario: Existing credential files can be imported
- **WHEN** legacy credential files or provider config files exist under `configs/`
- **THEN** the system SHALL provide a supported import path to register them into the database-backed storage model

#### Scenario: Operators can export data for backup or recovery
- **WHEN** operators need to back up or restore runtime data during or after migration
- **THEN** the system SHALL provide a documented export and recovery path compatible with existing operational workflows

### Requirement: Credential inventory deduplication
The system SHALL maintain a deduplicated credential inventory for imported or managed provider credentials.

#### Scenario: Re-imported credentials do not create unbounded duplicates
- **WHEN** a credential that matches an existing identity or deduplication key is imported again
- **THEN** the system SHALL update or reference the existing credential record instead of creating an unbounded number of new runtime entries

#### Scenario: Credential records are queryable without directory-wide scans
- **WHEN** the system needs to resolve a credential by provider, identity, or stable key
- **THEN** the system SHALL query the database-backed inventory instead of requiring a full filesystem directory scan

### Requirement: Phased rollout and fallback
The system SHALL support phased rollout from file-backed runtime storage to database-backed runtime storage.

#### Scenario: Feature flag controls the source of truth
- **WHEN** operators enable or disable the database-backed runtime storage feature flag
- **THEN** the system SHALL switch the runtime source of truth according to the configured rollout mode
- **AND** the system SHALL expose enough diagnostics to validate which backend is active

#### Scenario: Migration failure supports rollback
- **WHEN** a migration validation step fails or database-backed storage is not healthy
- **THEN** the system SHALL support reverting to the previous file-compatible runtime path without requiring manual reconstruction of runtime state

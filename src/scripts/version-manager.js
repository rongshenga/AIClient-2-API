import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VALID_RELEASE_TYPES = new Set(['major', 'minor', 'patch']);
const COMMIT_HEADER_PATTERN = /^(?<type>[a-z][a-z0-9-]*)(\([^)]+\))?(?<breaking>!)?:\s+.+$/;
const BREAKING_CHANGE_PATTERN = /^BREAKING[ -]CHANGE:/m;
const VERSION_FILE_NAME = 'VERSION';
const PACKAGE_FILE_NAME = 'package.json';
const VERSION_TRACKED_FILES = [VERSION_FILE_NAME, PACKAGE_FILE_NAME];

function resolveProjectFile(rootDir, fileName) {
    return path.join(rootDir, fileName);
}

function writeLine(stream, text) {
    stream.write(`${text}\n`);
}

export function parseSemver(version) {
    const normalizedVersion = String(version ?? '').trim();
    if (!/^\d+\.\d+\.\d+$/.test(normalizedVersion)) {
        throw new Error(`Expected a semver version like 1.0.0, received "${version}"`);
    }

    const [major, minor, patch] = normalizedVersion
        .split('.')
        .map((part) => Number.parseInt(part, 10));

    return {
        major,
        minor,
        patch,
        raw: normalizedVersion
    };
}

export function formatSemver({ major, minor, patch }) {
    return `${major}.${minor}.${patch}`;
}

export function incrementSemver(version, release = 'patch') {
    if (!VALID_RELEASE_TYPES.has(release)) {
        throw new Error(`Unsupported release type "${release}"`);
    }

    const parsedVersion = parseSemver(version);

    if (release === 'major') {
        return formatSemver({
            major: parsedVersion.major + 1,
            minor: 0,
            patch: 0
        });
    }

    if (release === 'minor') {
        return formatSemver({
            major: parsedVersion.major,
            minor: parsedVersion.minor + 1,
            patch: 0
        });
    }

    return formatSemver({
        major: parsedVersion.major,
        minor: parsedVersion.minor,
        patch: parsedVersion.patch + 1
    });
}

export function detectReleaseTypeFromCommitMessage(message) {
    const normalizedMessage = String(message ?? '').trim();
    if (!normalizedMessage) {
        return {
            release: 'patch',
            reason: 'empty',
            type: 'unknown',
            header: ''
        };
    }

    const [header] = normalizedMessage.split(/\r?\n/, 1);
    const headerMatch = header.match(COMMIT_HEADER_PATTERN);
    const commitType = headerMatch?.groups?.type || 'unknown';
    const hasBreakingChange = Boolean(headerMatch?.groups?.breaking) || BREAKING_CHANGE_PATTERN.test(normalizedMessage);

    if (hasBreakingChange) {
        return {
            release: 'major',
            reason: 'breaking',
            type: commitType,
            header
        };
    }

    if (commitType === 'feat') {
        return {
            release: 'minor',
            reason: 'feat',
            type: commitType,
            header
        };
    }

    return {
        release: 'patch',
        reason: headerMatch ? commitType : 'fallback',
        type: commitType,
        header
    };
}

export function readProjectVersion(rootDir = process.cwd()) {
    const versionFilePath = resolveProjectFile(rootDir, VERSION_FILE_NAME);
    if (!existsSync(versionFilePath)) {
        throw new Error(`Missing ${VERSION_FILE_NAME} file at ${versionFilePath}`);
    }

    return parseSemver(readFileSync(versionFilePath, 'utf8')).raw;
}

export function writeProjectVersionFile(rootDir, version) {
    const versionFilePath = resolveProjectFile(rootDir, VERSION_FILE_NAME);
    writeFileSync(versionFilePath, `${version}\n`, 'utf8');
}

export function writePackageVersion(rootDir, version) {
    const packageFilePath = resolveProjectFile(rootDir, PACKAGE_FILE_NAME);
    if (!existsSync(packageFilePath)) {
        throw new Error(`Missing ${PACKAGE_FILE_NAME} file at ${packageFilePath}`);
    }

    const packageJson = JSON.parse(readFileSync(packageFilePath, 'utf8'));
    packageJson.version = version;
    writeFileSync(packageFilePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
}

export function syncProjectVersion({ rootDir = process.cwd(), version }) {
    const normalizedVersion = parseSemver(version).raw;
    let previousVersion = null;

    try {
        previousVersion = readProjectVersion(rootDir);
    } catch (error) {
        previousVersion = null;
    }

    writeProjectVersionFile(rootDir, normalizedVersion);
    writePackageVersion(rootDir, normalizedVersion);

    return {
        previousVersion,
        version: normalizedVersion
    };
}

export function bumpProjectVersion({ rootDir = process.cwd(), release = 'patch' } = {}) {
    const previousVersion = readProjectVersion(rootDir);
    const version = incrementSemver(previousVersion, release);
    syncProjectVersion({ rootDir, version });

    return {
        previousVersion,
        version,
        release
    };
}

export function runPostCommitVersionHook({ rootDir = process.cwd(), env = process.env } = {}) {
    if (env.SKIP_VERSION_BUMP === '1' || env.SKIP_VERSION_POST_COMMIT === '1') {
        return {
            skipped: true,
            reason: 'env'
        };
    }

    const commitMessage = execFileSync('git', ['log', '-1', '--pretty=%B'], {
        cwd: rootDir,
        env,
        encoding: 'utf8'
    });
    const releaseInfo = detectReleaseTypeFromCommitMessage(commitMessage);
    const result = bumpProjectVersion({ rootDir, release: releaseInfo.release });

    execFileSync('git', ['add', ...VERSION_TRACKED_FILES], {
        cwd: rootDir,
        env,
        stdio: 'ignore'
    });
    execFileSync('git', ['commit', '--amend', '--no-edit', '--no-verify', '--quiet'], {
        cwd: rootDir,
        env: {
            ...env,
            SKIP_VERSION_BUMP: '1',
            SKIP_VERSION_POST_COMMIT: '1'
        },
        stdio: 'ignore'
    });

    return {
        ...result,
        ...releaseInfo,
        skipped: false
    };
}

export function printUsage(stream = process.stdout) {
    writeLine(stream, 'Usage:');
    writeLine(stream, '  node src/scripts/version-manager.js set <version>');
    writeLine(stream, '  node src/scripts/version-manager.js bump [patch|minor|major]');
    writeLine(stream, '  node src/scripts/version-manager.js post-commit');
}

export function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
    const normalizedArgv = argv.filter((arg) => arg !== '--');

    if (normalizedArgv.length === 0 || normalizedArgv[0] === '--help' || normalizedArgv[0] === '-h' || normalizedArgv[0] === 'help') {
        printUsage(io.stdout);
        return 0;
    }

    const [command, value] = normalizedArgv;

    try {
        let result;

        if (command === 'set') {
            if (!value) {
                throw new Error('Missing version value for "set" command');
            }

            result = syncProjectVersion({ version: value });
        } else if (command === 'bump') {
            result = bumpProjectVersion({ release: value || 'patch' });
        } else if (command === 'post-commit') {
            result = runPostCommitVersionHook();
        } else {
            throw new Error(`Unsupported command "${command}"`);
        }

        if (result.skipped) {
            writeLine(io.stdout, 'Version hook skipped');
            return 0;
        }

        const fromVersion = result.previousVersion ?? 'unknown';
        const detail = result.reason ? ` (${result.release} via ${result.reason})` : '';
        writeLine(io.stdout, `Version updated: ${fromVersion} -> ${result.version}${detail}`);
        return 0;
    } catch (error) {
        writeLine(io.stderr, `[version-manager] ${error.message}`);
        return 1;
    }
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
    process.exitCode = main();
}

import { jest } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
    bumpProjectVersion,
    detectReleaseTypeFromCommitMessage,
    incrementSemver,
    main,
    parseSemver,
    syncProjectVersion
} from '../src/scripts/version-manager.js';

describe('version manager', () => {
    let tempDir;
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const projectRoot = path.resolve(currentDir, '..');
    const versionManagerScriptPath = path.join(projectRoot, 'src/scripts/version-manager.js');

    beforeEach(() => {
        tempDir = mkdtempSync(path.join(tmpdir(), 'all2one-version-'));
        writeFileSync(path.join(tempDir, 'VERSION'), '1.0.0\n', 'utf8');
        writeFileSync(path.join(tempDir, 'package.json'), `${JSON.stringify({
            type: 'module',
            packageManager: 'pnpm@10.13.1'
        }, null, 2)}\n`, 'utf8');
    });

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });

    test('should bump patch version and keep VERSION plus package.json in sync', () => {
        const result = bumpProjectVersion({ rootDir: tempDir, release: 'patch' });

        expect(result).toEqual({
            previousVersion: '1.0.0',
            version: '1.0.1',
            release: 'patch'
        });
        expect(readFileSync(path.join(tempDir, 'VERSION'), 'utf8')).toBe('1.0.1\n');
        expect(JSON.parse(readFileSync(path.join(tempDir, 'package.json'), 'utf8'))).toMatchObject({
            version: '1.0.1'
        });
    });

    test('should reset from legacy version content by setting a clean semver value', () => {
        writeFileSync(path.join(tempDir, 'VERSION'), '2.10.5.3\n', 'utf8');

        const result = syncProjectVersion({ rootDir: tempDir, version: '1.0.0' });

        expect(result).toEqual({
            previousVersion: null,
            version: '1.0.0'
        });
        expect(readFileSync(path.join(tempDir, 'VERSION'), 'utf8')).toBe('1.0.0\n');
        expect(JSON.parse(readFileSync(path.join(tempDir, 'package.json'), 'utf8'))).toMatchObject({
            version: '1.0.0'
        });
    });

    test('should validate release type and semver format', () => {
        expect(parseSemver('1.2.3')).toEqual({
            major: 1,
            minor: 2,
            patch: 3,
            raw: '1.2.3'
        });
        expect(incrementSemver('1.2.3', 'minor')).toBe('1.3.0');
        expect(() => incrementSemver('1.2.3', 'banana')).toThrow('Unsupported release type "banana"');
        expect(() => parseSemver('2.10.5.3')).toThrow('Expected a semver version like 1.0.0');
    });

    test('should map conventional commit messages to the expected release level', () => {
        expect(detectReleaseTypeFromCommitMessage('feat(ui): add dashboard')).toMatchObject({
            release: 'minor',
            reason: 'feat',
            type: 'feat'
        });
        expect(detectReleaseTypeFromCommitMessage('fix(auth): handle null token')).toMatchObject({
            release: 'patch',
            reason: 'fix',
            type: 'fix'
        });
        expect(detectReleaseTypeFromCommitMessage('feat(api)!: drop legacy route')).toMatchObject({
            release: 'major',
            reason: 'breaking',
            type: 'feat'
        });
        expect(detectReleaseTypeFromCommitMessage('refactor(core): cleanup\n\nBREAKING CHANGE: remove legacy config')).toMatchObject({
            release: 'major',
            reason: 'breaking',
            type: 'refactor'
        });
        expect(detectReleaseTypeFromCommitMessage('merge branch feature-x')).toMatchObject({
            release: 'patch',
            reason: 'fallback',
            type: 'unknown'
        });
    });

    test('should return non-zero exit code when command is invalid', () => {
        const stdout = { write: jest.fn() };
        const stderr = { write: jest.fn() };

        const exitCode = main(['bump', 'banana'], { stdout, stderr });

        expect(exitCode).toBe(1);
        expect(stderr.write).toHaveBeenCalledWith('[version-manager] Unsupported release type "banana"\n');
    });

    test('should ignore pnpm argument separator when setting version from cli args', () => {
        const stdout = { write: jest.fn() };
        const stderr = { write: jest.fn() };
        const originalCwd = process.cwd();

        process.chdir(tempDir);

        try {
            const exitCode = main(['set', '--', '1.0.2'], { stdout, stderr });

            expect(exitCode).toBe(0);
            expect(stderr.write).not.toHaveBeenCalled();
            expect(readFileSync(path.join(tempDir, 'VERSION'), 'utf8')).toBe('1.0.2\n');
            expect(JSON.parse(readFileSync(path.join(tempDir, 'package.json'), 'utf8'))).toMatchObject({
                version: '1.0.2'
            });
        } finally {
            process.chdir(originalCwd);
        }
    });

    test('should amend the just-created commit through the post-commit hook using feat => minor', () => {
        const hookDir = path.join(tempDir, '.githooks');
        const workFilePath = path.join(tempDir, 'feature.txt');

        execFileSync('git', ['init', '-q'], { cwd: tempDir });
        execFileSync('git', ['config', 'user.name', 'tester'], { cwd: tempDir });
        execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: tempDir });

        writeFileSync(workFilePath, 'base\n', 'utf8');
        execFileSync('git', ['add', 'VERSION', 'package.json', 'feature.txt'], { cwd: tempDir });
        execFileSync('git', ['commit', '-qm', 'chore: init'], { cwd: tempDir });

        mkdirSync(hookDir);
        writeFileSync(path.join(hookDir, 'post-commit'), `#!/bin/sh
set -eu

if [ "\${SKIP_VERSION_BUMP:-0}" = "1" ] || [ "\${SKIP_VERSION_POST_COMMIT:-0}" = "1" ]; then
    exit 0
fi

node "${versionManagerScriptPath}" post-commit
`, 'utf8');
        chmodSync(path.join(hookDir, 'post-commit'), 0o755);
        execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: tempDir });

        writeFileSync(workFilePath, 'base\nmore\n', 'utf8');
        execFileSync('git', ['add', 'feature.txt'], { cwd: tempDir });
        execFileSync('git', ['commit', '-qm', 'feat: add automation'], { cwd: tempDir });

        expect(execFileSync('git', ['show', 'HEAD:VERSION'], { cwd: tempDir, encoding: 'utf8' }).trim()).toBe('1.1.0');
        expect(JSON.parse(execFileSync('git', ['show', 'HEAD:package.json'], { cwd: tempDir, encoding: 'utf8' }))).toMatchObject({
            version: '1.1.0'
        });
    });
});

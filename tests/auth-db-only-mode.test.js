import { jest } from '@jest/globals';

const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    initialize: jest.fn(),
    cleanupOldLogs: jest.fn()
};

describe('Auth db_only mode', () => {
    let validateCredentials;
    let verifyToken;
    let mockRuntimeStorage;
    let mockExistsSync;
    let mockFsPromises;

    beforeEach(async () => {
        jest.resetModules();

        mockRuntimeStorage = {
            getInfo: jest.fn(() => ({ backend: 'db' })),
            getAdminSession: jest.fn(),
            getAdminPasswordHash: jest.fn(),
            saveAdminSession: jest.fn(),
            deleteAdminSession: jest.fn(),
            cleanupExpiredAdminSessions: jest.fn()
        };
        mockExistsSync = jest.fn(() => false);
        mockFsPromises = {
            readFile: jest.fn(),
            writeFile: jest.fn()
        };

        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));
        jest.doMock('../src/core/config-manager.js', () => ({
            __esModule: true,
            CONFIG: {
                LOGIN_EXPIRY: 3600,
                AUTH_STORAGE_MODE: 'db_only'
            }
        }));
        jest.doMock('fs', () => ({
            __esModule: true,
            existsSync: mockExistsSync,
            promises: mockFsPromises
        }));
        jest.doMock('../src/storage/runtime-storage-registry.js', () => ({
            __esModule: true,
            getRuntimeStorage: jest.fn(() => mockRuntimeStorage)
        }));

        ({ validateCredentials, verifyToken } = await import('../src/ui-modules/auth.js'));
    });

    afterEach(() => {
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
    });

    test('should validate password against runtime storage hash without reading configs/pwd in db_only mode', async () => {
        const salt = '00112233445566778899aabbccddeeff';
        const hash = 'd0576b1198b7f458572440c0b4e215d92bac593b7021197e7aeb08e80717cff1';
        mockRuntimeStorage.getAdminPasswordHash.mockResolvedValue({
            version: 1,
            algorithm: 'sha256-salt',
            salt,
            hash
        });

        await expect(validateCredentials('admin123')).resolves.toBe(true);
        expect(mockFsPromises.readFile).not.toHaveBeenCalled();
    });

    test('should disable token-store fallback in db_only mode when runtime storage read fails', async () => {
        const token = 'db-only-token';
        mockRuntimeStorage.getAdminSession.mockRejectedValue(new Error('sqlite busy'));
        mockExistsSync.mockReturnValue(true);
        mockFsPromises.readFile.mockResolvedValue(JSON.stringify({
            tokens: {
                [token]: {
                    username: 'admin',
                    expiryTime: Date.now() + 60_000
                }
            }
        }));

        await expect(verifyToken(token)).resolves.toBeNull();
        expect(mockFsPromises.readFile).not.toHaveBeenCalled();
    });
});

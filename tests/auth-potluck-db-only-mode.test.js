import { jest } from '@jest/globals';

const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

describe('Auth potluck db_only mode', () => {
    let initializeUserDataManager;
    let resetUserDataManagerForTests;
    let updateConfig;
    let initializeKeyManager;
    let resetKeyManagerForTests;
    let createKey;
    let setConfigGetter;
    let fsMock;

    beforeEach(async () => {
        jest.resetModules();

        fsMock = {
            existsSync: jest.fn(() => false),
            mkdirSync: jest.fn(),
            readFileSync: jest.fn(),
            writeFileSync: jest.fn(),
            watch: jest.fn(() => ({ close: jest.fn() })),
            promises: {
                mkdir: jest.fn(async () => undefined),
                writeFile: jest.fn(async () => undefined),
                rename: jest.fn(async () => undefined),
                readFile: jest.fn(async () => '{}')
            }
        };

        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));
        jest.doMock('../src/core/config-manager.js', () => ({
            __esModule: true,
            CONFIG: {
                AUTH_STORAGE_MODE: 'db_only'
            }
        }));
        jest.doMock('../src/storage/runtime-storage-registry.js', () => ({
            __esModule: true,
            getRuntimeStorage: jest.fn(() => null)
        }));
        jest.doMock('fs', () => ({
            __esModule: true,
            ...fsMock
        }));

        ({
            initializeUserDataManager,
            resetUserDataManagerForTests,
            updateConfig
        } = await import('../src/plugins/api-potluck/user-data-manager.js'));
        ({
            initializeKeyManager,
            resetKeyManagerForTests,
            createKey,
            setConfigGetter
        } = await import('../src/plugins/api-potluck/key-manager.js'));
    });

    afterEach(async () => {
        await resetUserDataManagerForTests();
        await resetKeyManagerForTests();
    });

    test('should not write potluck user data file when runtime storage is unavailable in db_only mode', async () => {
        await initializeUserDataManager(true);
        await updateConfig({
            defaultDailyLimit: 777
        });

        expect(fsMock.readFileSync).not.toHaveBeenCalled();
        expect(fsMock.writeFileSync).not.toHaveBeenCalled();
        expect(fsMock.promises.writeFile).not.toHaveBeenCalled();
    });

    test('should not write potluck key file when runtime storage is unavailable in db_only mode', async () => {
        await initializeKeyManager(true);
        setConfigGetter(() => ({
            defaultDailyLimit: 500,
            persistInterval: 1000
        }));
        await createKey('Demo Key', 700);

        expect(fsMock.readFileSync).not.toHaveBeenCalled();
        expect(fsMock.writeFileSync).not.toHaveBeenCalled();
        expect(fsMock.promises.writeFile).not.toHaveBeenCalled();
    });
});


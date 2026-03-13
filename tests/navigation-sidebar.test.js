import { jest } from '@jest/globals';

function createClassList(initial = []) {
    const classes = new Set(initial);
    return {
        add(name) {
            classes.add(name);
        },
        remove(name) {
            classes.delete(name);
        },
        toggle(name, force) {
            if (force === undefined) {
                if (classes.has(name)) {
                    classes.delete(name);
                    return false;
                }
                classes.add(name);
                return true;
            }

            if (force) {
                classes.add(name);
                return true;
            }

            classes.delete(name);
            return false;
        },
        contains(name) {
            return classes.has(name);
        }
    };
}

function createMockElement(initial = {}) {
    const listeners = new Map();
    const attributes = new Map();

    return {
        id: initial.id || '',
        dataset: initial.dataset || {},
        style: initial.style || {},
        className: initial.className || '',
        classList: initial.classList || createClassList(initial.classes || []),
        querySelector: initial.querySelector || jest.fn(() => null),
        setAttribute(name, value) {
            const normalized = String(value);
            attributes.set(name, normalized);
            this[name] = normalized;
        },
        getAttribute(name) {
            return attributes.get(name) || null;
        },
        addEventListener(type, handler) {
            listeners.set(type, handler);
        },
        trigger(type, event = {}) {
            const handler = listeners.get(type);
            if (handler) {
                return handler(event);
            }
            return undefined;
        }
    };
}

describe('navigation sidebar collapse', () => {
    let sidebar;
    let toggleBtn;
    let toggleIcon;
    let dashboardNav;
    let logsNav;
    let dashboardSection;
    let logsSection;
    let contentContainer;
    let resizeHandler;
    let localStorageMock;

    beforeEach(() => {
        jest.resetModules();
        resizeHandler = null;

        toggleIcon = createMockElement({ className: 'fas fa-angles-left' });
        toggleBtn = createMockElement({
            id: 'sidebarCollapseToggle',
            querySelector: jest.fn((selector) => selector === 'i' ? toggleIcon : null)
        });
        sidebar = createMockElement({ classes: ['sidebar'] });

        dashboardNav = createMockElement({
            dataset: { section: 'dashboard' },
            classes: ['nav-item', 'active']
        });
        logsNav = createMockElement({
            dataset: { section: 'logs' },
            classes: ['nav-item']
        });

        dashboardSection = createMockElement({
            id: 'dashboard',
            classes: ['section', 'active']
        });
        logsSection = createMockElement({
            id: 'logs',
            classes: ['section']
        });

        contentContainer = createMockElement({
            id: 'content-container',
            style: {},
            classList: createClassList([])
        });
        contentContainer.scrollTop = 120;

        localStorageMock = {
            getItem: jest.fn(() => null),
            setItem: jest.fn()
        };

        global.CustomEvent = class CustomEvent {
            constructor(type, init = {}) {
                this.type = type;
                this.detail = init.detail;
            }
        };

        global.window = {
            innerWidth: 1440,
            localStorage: localStorageMock,
            addEventListener: jest.fn((type, handler) => {
                if (type === 'resize') {
                    resizeHandler = handler;
                }
            }),
            dispatchEvent: jest.fn(),
            scrollTo: jest.fn()
        };

        global.document = {
            querySelectorAll: jest.fn((selector) => {
                if (selector === '.nav-item') {
                    return [dashboardNav, logsNav];
                }

                if (selector === '.section') {
                    return [dashboardSection, logsSection];
                }

                return [];
            }),
            querySelector: jest.fn((selector) => {
                if (selector === '.sidebar') {
                    return sidebar;
                }

                return null;
            }),
            getElementById: jest.fn((id) => {
                const mapping = {
                    sidebarCollapseToggle: toggleBtn,
                    'content-container': contentContainer,
                    logsContainer: null
                };
                return mapping[id] || null;
            })
        };
    });

    it('桌面端读取持久化状态并支持点击折叠切换', async () => {
        localStorageMock.getItem.mockReturnValue('true');
        const navigationModule = await import('../static/app/navigation.js');

        navigationModule.initNavigation();

        expect(sidebar.classList.contains('is-collapsed')).toBe(true);
        expect(toggleBtn.getAttribute('aria-label')).toBe('展开侧边栏');
        expect(toggleBtn.getAttribute('aria-pressed')).toBe('true');
        expect(toggleIcon.className).toBe('fas fa-angles-right');

        logsNav.trigger('click', {
            preventDefault: jest.fn()
        });

        expect(logsNav.classList.contains('active')).toBe(true);
        expect(dashboardNav.classList.contains('active')).toBe(false);
        expect(logsSection.classList.contains('active')).toBe(true);
        expect(dashboardSection.classList.contains('active')).toBe(false);
        expect(contentContainer.scrollTop).toBe(0);

        toggleBtn.trigger('click', {
            preventDefault: jest.fn(),
            stopPropagation: jest.fn()
        });

        expect(sidebar.classList.contains('is-collapsed')).toBe(false);
        expect(toggleBtn.getAttribute('aria-label')).toBe('收起侧边栏');
        expect(toggleBtn.getAttribute('aria-pressed')).toBe('false');
        expect(toggleIcon.className).toBe('fas fa-angles-left');
        expect(localStorageMock.setItem).toHaveBeenLastCalledWith('all2one.sidebar.collapsed', 'false');
    });

    it('移动端即使存在持久化折叠状态也保持展开，并在回到桌面端后恢复', async () => {
        localStorageMock.getItem.mockReturnValue('true');
        global.window.innerWidth = 640;
        const navigationModule = await import('../static/app/navigation.js');

        navigationModule.initNavigation();

        expect(sidebar.classList.contains('is-collapsed')).toBe(false);
        expect(toggleBtn.getAttribute('aria-label')).toBe('收起侧边栏');
        expect(typeof resizeHandler).toBe('function');

        global.window.innerWidth = 1366;
        resizeHandler();

        expect(sidebar.classList.contains('is-collapsed')).toBe(true);
        expect(toggleBtn.getAttribute('aria-label')).toBe('展开侧边栏');
    });
});

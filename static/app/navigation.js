// 导航功能模块

import { elements } from './constants.js';
import { t } from './i18n.js';

const SIDEBAR_COLLAPSE_STORAGE_KEY = 'all2one.sidebar.collapsed';
const SIDEBAR_DESKTOP_BREAKPOINT = 768;

let navigationInitialized = false;
let sidebarResizeHandler = null;

/**
 * 初始化导航功能
 */
function initNavigation() {
    if (navigationInitialized) {
        return;
    }

    if (!elements.navItems || !elements.sections) {
        console.warn('导航元素未找到');
        return;
    }

    elements.navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const sectionId = item.dataset.section;
            switchToSection(sectionId);
        });
    });

    initSidebarCollapse();
    navigationInitialized = true;
}

function isDesktopSidebarViewport() {
    if (typeof window === 'undefined' || typeof window.innerWidth !== 'number') {
        return true;
    }

    return window.innerWidth > SIDEBAR_DESKTOP_BREAKPOINT;
}

function readSidebarCollapsedState() {
    try {
        return window.localStorage?.getItem(SIDEBAR_COLLAPSE_STORAGE_KEY) === 'true';
    } catch (error) {
        console.warn('[Navigation] Failed to read sidebar state:', error);
        return false;
    }
}

function persistSidebarCollapsedState(collapsed) {
    try {
        window.localStorage?.setItem(SIDEBAR_COLLAPSE_STORAGE_KEY, collapsed ? 'true' : 'false');
    } catch (error) {
        console.warn('[Navigation] Failed to persist sidebar state:', error);
    }
}

function getSidebarElements() {
    const sidebar = document.querySelector('.sidebar');
    const toggleBtn = document.getElementById('sidebarCollapseToggle');
    const toggleIcon = toggleBtn?.querySelector('i') || null;

    return {
        sidebar,
        toggleBtn,
        toggleIcon
    };
}

function updateSidebarToggleState(toggleBtn, toggleIcon, collapsed) {
    if (!toggleBtn) {
        return;
    }

    const labelKey = collapsed ? 'nav.expandSidebar' : 'nav.collapseSidebar';
    toggleBtn.setAttribute('data-i18n-aria-label', labelKey);
    toggleBtn.setAttribute('aria-label', t(labelKey));
    toggleBtn.setAttribute('aria-pressed', collapsed ? 'true' : 'false');

    if (toggleIcon) {
        toggleIcon.className = `fas ${collapsed ? 'fa-angles-right' : 'fa-angles-left'}`;
    }
}

function applySidebarCollapsedState(collapsed, persist = false) {
    const {
        sidebar,
        toggleBtn,
        toggleIcon
    } = getSidebarElements();

    if (!sidebar || !toggleBtn) {
        return;
    }

    const shouldCollapse = isDesktopSidebarViewport() && collapsed;
    sidebar.classList.toggle('is-collapsed', shouldCollapse);
    updateSidebarToggleState(toggleBtn, toggleIcon, shouldCollapse);

    if (persist) {
        persistSidebarCollapsedState(collapsed);
    }
}

function initSidebarCollapse() {
    const {
        sidebar,
        toggleBtn
    } = getSidebarElements();

    if (!sidebar || !toggleBtn) {
        return;
    }

    applySidebarCollapsedState(readSidebarCollapsedState(), false);

    toggleBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        if (!isDesktopSidebarViewport()) {
            return;
        }

        const nextCollapsed = !sidebar.classList.contains('is-collapsed');
        applySidebarCollapsedState(nextCollapsed, true);
    });

    if (!sidebarResizeHandler && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        sidebarResizeHandler = () => {
            applySidebarCollapsedState(readSidebarCollapsedState(), false);
        };
        window.addEventListener('resize', sidebarResizeHandler);
    }
}

function emitSectionActivated(sectionId) {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') {
        return;
    }

    window.dispatchEvent(new CustomEvent('ui:section-activated', {
        detail: { sectionId }
    }));
}

/**
 * 切换到指定章节
 * @param {string} sectionId - 章节ID
 */
function switchToSection(sectionId) {
    // 更新导航状态
    elements.navItems.forEach(nav => {
        nav.classList.remove('active');
        if (nav.dataset.section === sectionId) {
            nav.classList.add('active');
        }
    });

    // 显示对应章节
    elements.sections.forEach(section => {
        section.classList.remove('active');
        if (section.id === sectionId) {
            section.classList.add('active');
            
            // 如果是日志页面，默认滚动到底部
            if (sectionId === 'logs') {
                setTimeout(() => {
                    const logsContainer = document.getElementById('logsContainer');
                    if (logsContainer) {
                        logsContainer.scrollTop = logsContainer.scrollHeight;
                    }
                }, 100);
            }
        }
    });

    // 滚动到顶部
    scrollToTop();
    emitSectionActivated(sectionId);
}

/**
 * 滚动到页面顶部
 */
function scrollToTop() {
    // 尝试滚动内容区域
    const contentContainer = document.getElementById('content-container');
    if (contentContainer) {
        contentContainer.scrollTop = 0;
    }
    
    // 同时滚动窗口到顶部
    window.scrollTo(0, 0);
}

/**
 * 切换到仪表盘页面
 */
function switchToDashboard() {
    switchToSection('dashboard');
}

/**
 * 切换到提供商页面
 */
function switchToProviders() {
    switchToSection('providers');
}

export {
    initNavigation,
    applySidebarCollapsedState,
    switchToSection,
    switchToDashboard,
    switchToProviders
};

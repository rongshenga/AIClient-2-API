// 认证模块 - 处理token管理和API调用封装
/**
 * 认证管理类
 */
class AuthManager {
    constructor() {
        this.tokenKey = 'authToken';
        this.expiryKey = 'authTokenExpiry';
        this.baseURL = window.location.origin;
    }

    /**
     * 获取存储的token
     */
    getToken() {
        return localStorage.getItem(this.tokenKey);
    }

    /**
     * 获取token过期时间
     */
    getTokenExpiry() {
        const expiry = localStorage.getItem(this.expiryKey);
        return expiry ? parseInt(expiry) : null;
    }

    /**
     * 检查token是否有效
     */
    isTokenValid() {
        const token = this.getToken();
        const expiry = this.getTokenExpiry();
        
        if (!token) return false;
        
        // 如果设置了过期时间，检查是否过期
        if (expiry && Date.now() > expiry) {
            this.clearToken();
            return false;
        }
        
        return true;
    }

    /**
     * 保存token到本地存储
     */
    saveToken(token, rememberMe = false) {
        localStorage.setItem(this.tokenKey, token);
        
        if (rememberMe) {
            const expiryTime = Date.now() + (7 * 24 * 60 * 60 * 1000); // 7天
            localStorage.setItem(this.expiryKey, expiryTime.toString());
        }
    }

    /**
     * 清除token
     */
    clearToken() {
        localStorage.removeItem(this.tokenKey);
        localStorage.removeItem(this.expiryKey);
    }

    /**
     * 登出
     */
    async logout() {
        this.clearToken();
        window.location.href = '/login.html';
    }
}

const UI_DEBUG_STORAGE_KEY = 'aiclient.ui_debug';
const UI_DEBUG_QUERY_KEY = 'ui_debug';
const UI_DEBUG_HEADER = 'X-UI-Debug';
const UI_DEBUG_SLOW_REQUEST_MS = 3000;

function syncUiDebugModeFromUrl() {
    try {
        const searchParams = new URLSearchParams(window.location.search);
        const uiDebugValue = searchParams.get(UI_DEBUG_QUERY_KEY);
        if (uiDebugValue === '1' || uiDebugValue === 'true') {
            localStorage.setItem(UI_DEBUG_STORAGE_KEY, '1');
            return;
        }

        if (uiDebugValue === '0' || uiDebugValue === 'false') {
            localStorage.removeItem(UI_DEBUG_STORAGE_KEY);
        }
    } catch (error) {
        console.warn('[UI Debug] Failed to sync debug mode from URL:', error);
    }
}

function isUiDebugModeEnabled() {
    syncUiDebugModeFromUrl();
    if (typeof window.__AICLIENT_FORCE_UI_DEBUG__ === 'boolean') {
        return window.__AICLIENT_FORCE_UI_DEBUG__;
    }
    return localStorage.getItem(UI_DEBUG_STORAGE_KEY) === '1';
}

function buildUiDebugHeaders() {
    return isUiDebugModeEnabled() ? { [UI_DEBUG_HEADER]: '1' } : {};
}

function logUiDebug(message, payload = null, level = 'log') {
    if (!isUiDebugModeEnabled()) {
        return;
    }

    const consoleMethod = typeof console[level] === 'function' ? console[level] : console.log;
    if (payload !== null && payload !== undefined) {
        consoleMethod.call(console, `[UI Debug] ${message}`, payload);
        return;
    }

    consoleMethod.call(console, `[UI Debug] ${message}`);
}

function startUiDebugPendingTimer(method, endpoint) {
    if (!isUiDebugModeEnabled()) {
        return null;
    }

    return window.setTimeout(() => {
        logUiDebug(`${method} ${endpoint} still pending`, {
            thresholdMs: UI_DEBUG_SLOW_REQUEST_MS
        }, 'warn');
    }, UI_DEBUG_SLOW_REQUEST_MS);
}

function clearUiDebugPendingTimer(timerId) {
    if (timerId) {
        window.clearTimeout(timerId);
    }
}

syncUiDebugModeFromUrl();
window.isUiDebugModeEnabled = isUiDebugModeEnabled;
window.logUiDebug = logUiDebug;

/**
 * API调用封装类
 */
class ApiClient {
    constructor() {
        this.authManager = new AuthManager();
        this.baseURL = window.location.origin;
    }

    /**
     * 获取带认证的请求头
     */
    getAuthHeaders() {
        const token = this.authManager.getToken();
        const debugHeaders = buildUiDebugHeaders();
        return token ? {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...debugHeaders
        } : {
            'Content-Type': 'application/json',
            ...debugHeaders
        };
    }

    /**
     * 处理401错误重定向到登录页
     */
    handleUnauthorized() {
        this.authManager.clearToken();
        window.location.href = '/login.html';
    }

    /**
     * 通用API请求方法
     */
    async request(endpoint, options = {}) {
        const url = `${this.baseURL}/api${endpoint}`;
        const headers = {
            ...this.getAuthHeaders(),
            ...options.headers,
            ...buildUiDebugHeaders()
        };

        const config = {
            ...options,
            headers
        };
        const method = (config.method || 'GET').toUpperCase();
        const startedAt = Date.now();
        const pendingTimer = startUiDebugPendingTimer(method, endpoint);
        logUiDebug(`${method} ${endpoint} started`, { url });

        try {
            const response = await fetch(url, config);
            clearUiDebugPendingTimer(pendingTimer);
            
            // 如果是401错误，重定向到登录页
            if (response.status === 401) {
                this.handleUnauthorized();
                throw new Error('未授权访问');
            }

            const contentType = response.headers.get('content-type');
            logUiDebug(`${method} ${endpoint} completed`, {
                status: response.status,
                durationMs: Date.now() - startedAt,
                contentType
            });
            if (contentType && contentType.includes('application/json')) {
                return await response.json();
            } else {
                return await response.text();
            }
        } catch (error) {
            clearUiDebugPendingTimer(pendingTimer);
            if (error.message === '未授权访问') {
                // 已经在handleUnauthorized中处理了重定向
                logUiDebug(`${method} ${endpoint} unauthorized`, {
                    durationMs: Date.now() - startedAt
                }, 'warn');
                throw error;
            }
            logUiDebug(`${method} ${endpoint} failed`, {
                durationMs: Date.now() - startedAt,
                error: error.message
            }, 'error');
            console.error('API请求错误:', error);
            throw error;
        }
    }

    /**
     * GET请求
     */
    async get(endpoint, params = {}) {
        const queryString = new URLSearchParams(params).toString();
        const url = queryString ? `${endpoint}?${queryString}` : endpoint;
        return this.request(url, { method: 'GET' });
    }

    /**
     * POST请求
     */
    async post(endpoint, data = {}) {
        return this.request(endpoint, {
            method: 'POST',
            body: JSON.stringify(data)
        });
    }

    /**
     * PUT请求
     */
    async put(endpoint, data = {}) {
        return this.request(endpoint, {
            method: 'PUT',
            body: JSON.stringify(data)
        });
    }

    /**
     * DELETE请求
     */
    async delete(endpoint) {
        return this.request(endpoint, { method: 'DELETE' });
    }

    /**
     * POST请求（支持FormData上传）
     */
    async upload(endpoint, formData) {
        const url = `${this.baseURL}/api${endpoint}`;
        
        // 获取认证token
        const token = this.authManager.getToken();
        const headers = {
            ...buildUiDebugHeaders()
        };
        
        // 如果有token，添加Authorization头部
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        // 对于FormData请求，不添加Content-Type头部，让浏览器自动设置
        const config = {
            method: 'POST',
            headers,
            body: formData
        };
        const startedAt = Date.now();
        const pendingTimer = startUiDebugPendingTimer('POST', endpoint);
        logUiDebug(`POST ${endpoint} upload started`, { url });

        try {
            const response = await fetch(url, config);
            clearUiDebugPendingTimer(pendingTimer);
            
            // 如果是401错误，重定向到登录页
            if (response.status === 401) {
                this.handleUnauthorized();
                throw new Error('未授权访问');
            }

            const contentType = response.headers.get('content-type');
            logUiDebug(`POST ${endpoint} upload completed`, {
                status: response.status,
                durationMs: Date.now() - startedAt,
                contentType
            });
            if (contentType && contentType.includes('application/json')) {
                return await response.json();
            } else {
                return await response.text();
            }
        } catch (error) {
            clearUiDebugPendingTimer(pendingTimer);
            if (error.message === '未授权访问') {
                logUiDebug(`POST ${endpoint} upload unauthorized`, {
                    durationMs: Date.now() - startedAt
                }, 'warn');
                throw error;
            }
            logUiDebug(`POST ${endpoint} upload failed`, {
                durationMs: Date.now() - startedAt,
                error: error.message
            }, 'error');
            console.error('API请求错误:', error);
            throw error;
        }
    }
}

/**
 * 初始化认证检查
 */
async function initAuth() {
    const authManager = new AuthManager();
    
    // 检查是否已经有有效的token
    if (authManager.isTokenValid()) {
        // 验证token是否仍然有效（发送一个测试请求）
        try {
            const apiClient = new ApiClient();
            await apiClient.get('/health');
            return true;
        } catch (error) {
            // Token无效，清除并重定向到登录页
            authManager.clearToken();
            window.location.href = '/login.html';
            return false;
        }
    } else {
        // 没有有效token，重定向到登录页
        window.location.href = '/login.html';
        return false;
    }
}

/**
 * 登出函数
 */
async function logout() {
    const authManager = new AuthManager();
    await authManager.logout();
}

/**
 * 登录函数（供登录页面使用）
 */
async function login(password, rememberMe = false) {
    const startedAt = Date.now();
    const pendingTimer = startUiDebugPendingTimer('POST', '/login');
    try {
        logUiDebug('POST /login started');
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...buildUiDebugHeaders()
            },
            body: JSON.stringify({
            password,
            rememberMe
            })
        });
        clearUiDebugPendingTimer(pendingTimer);

        const data = await response.json();
        logUiDebug('POST /login completed', {
            status: response.status,
            durationMs: Date.now() - startedAt,
            success: data.success === true
        });

        if (data.success) {
            // 保存token
            const authManager = new AuthManager();
            authManager.saveToken(data.token, rememberMe);
            return { success: true };
        } else {
            return { success: false, message: data.message };
        }
    } catch (error) {
        clearUiDebugPendingTimer(pendingTimer);
        logUiDebug('POST /login failed', {
            durationMs: Date.now() - startedAt,
            error: error.message
        }, 'error');
        console.error('登录错误:', error);
        return { success: false, message: '登录失败，请检查网络连接' };
    }
}

// 创建单例实例
const authManager = new AuthManager();
const apiClient = new ApiClient();

/**
 * 获取带认证的请求头（便捷函数）
 * @returns {Object} 包含认证信息的请求头
 */
function getAuthHeaders() {
    return apiClient.getAuthHeaders();
}

// 导出实例到 window（兼容旧代码）
window.authManager = authManager;
window.apiClient = apiClient;
window.initAuth = initAuth;
window.logout = logout;
window.login = login;

// 导出认证管理器类和API客户端类供其他模块使用
window.AuthManager = AuthManager;
window.ApiClient = ApiClient;

// ES6 模块导出
export {
    AuthManager,
    ApiClient,
    authManager,
    apiClient,
    initAuth,
    logout,
    login,
    getAuthHeaders
};

console.log('认证模块已加载');
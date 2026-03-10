import { existsSync } from 'fs';
import logger from '../utils/logger.js';
import { promises as fs } from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { broadcastEvent } from './event-broadcast.js';
import { scanConfigFiles } from './config-scanner.js';
import {
    exportProviderPoolsCompatSnapshot,
    listCredentialAssetsWithRuntimeStorage
} from '../storage/runtime-storage-registry.js';

function normalizeUiDebugFlag(value) {
    if (typeof value !== 'string') {
        return false;
    }

    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function isUploadConfigDebugEnabled(req = null, currentConfig = {}) {
    if (process.env.NODE_ENV === 'test' || currentConfig?.UI_DEBUG_LOGGING === true) {
        return true;
    }

    const headerValue = req?.headers?.['x-ui-debug'];
    if (Array.isArray(headerValue)) {
        if (headerValue.some((item) => normalizeUiDebugFlag(item))) {
            return true;
        }
    } else if (normalizeUiDebugFlag(headerValue)) {
        return true;
    }

    try {
        const requestUrl = new URL(req?.url || '/', 'http://127.0.0.1');
        return normalizeUiDebugFlag(requestUrl.searchParams.get('ui_debug'));
    } catch {
        return false;
    }
}

function logUploadConfigDebug(enabled, message, payload = null, level = 'info') {
    if (!enabled) {
        return;
    }

    const logMethod = typeof logger[level] === 'function' ? logger[level].bind(logger) : logger.info.bind(logger);
    if (payload !== null && payload !== undefined) {
        logMethod(`[UI Debug][Upload Config] ${message}`, payload);
        return;
    }

    logMethod(`[UI Debug][Upload Config] ${message}`);
}

function getUploadConfigSource(req) {
    try {
        const requestUrl = new URL(req?.url || '/', 'http://127.0.0.1');
        const source = (requestUrl.searchParams.get('source') || '').trim().toLowerCase();
        return source === 'scan' ? 'scan' : 'runtime';
    } catch {
        return 'runtime';
    }
}

function normalizePositiveInt(value, fallback = null) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveUploadConfigLimit(currentConfig = {}) {
    const configured = normalizePositiveInt(currentConfig?.UPLOAD_CONFIGS_MAX_RESULTS, null);
    if (configured === null) {
        // 默认限制返回数量，避免大号池导致 UI 内存暴涨
        return 1000;
    }
    return configured;
}

function resolveUploadConfigListOptions(req, currentConfig = {}) {
    const options = {};
    try {
        const requestUrl = new URL(req?.url || '/', 'http://127.0.0.1');
        const limit = normalizePositiveInt(requestUrl.searchParams.get('limit'), null);
        const offset = normalizePositiveInt(requestUrl.searchParams.get('offset'), 0);
        const sort = requestUrl.searchParams.get('sort');
        const sourceKind = requestUrl.searchParams.get('sourceKind');

        if (limit !== null) {
            options.limit = limit;
        } else {
            const defaultLimit = resolveUploadConfigLimit(currentConfig);
            if (defaultLimit !== null) {
                options.limit = defaultLimit;
            }
        }

        if (Number.isFinite(offset) && offset >= 0) {
            options.offset = offset;
        }

        if (sort === 'asc' || sort === 'desc') {
            options.sort = sort;
        }

        if (typeof sourceKind === 'string' && sourceKind.trim()) {
            options.sourceKind = sourceKind.trim();
        }
    } catch {
        const defaultLimit = resolveUploadConfigLimit(currentConfig);
        if (defaultLimit !== null) {
            options.limit = defaultLimit;
        }
    }

    return options;
}

function mapRuntimeCredentialAssetToConfigItem(asset = {}) {
    const rawPath = String(asset.source_path || '').replace(/\\/g, '/');
    const normalizedPath = rawPath.replace(/^\.\//, '');
    const fileName = normalizedPath ? path.basename(normalizedPath) : String(asset.id || 'credential.json');
    const extension = path.extname(fileName).toLowerCase() || '.json';
    const modifiedAt = asset.last_imported_at || asset.updated_at || new Date().toISOString();

    return {
        name: fileName,
        path: normalizedPath || rawPath || fileName,
        size: 0,
        type: extension === '.json' ? 'oauth' : 'other',
        provider: asset.provider_type || 'unknown',
        extension,
        modified: modifiedAt,
        isValid: true,
        errorMessage: '',
        isUsed: true,
        usageInfo: {
            isUsed: true,
            usageType: 'provider_pool',
            usageDetails: [
                {
                    type: 'Provider Pool',
                    location: 'Runtime credential binding',
                    providerType: asset.provider_type || 'unknown',
                    configKey: asset.source_kind || 'runtime_storage'
                }
            ]
        },
        preview: '',
        sourceKind: asset.source_kind || 'runtime_storage'
    };
}

async function buildRuntimeConfigInventory(currentConfig = {}, options = {}) {
    const assets = await listCredentialAssetsWithRuntimeStorage(currentConfig, null, {
        sort: 'desc',
        ...options
    });

    if (!Array.isArray(assets) || assets.length === 0) {
        return [];
    }

    return assets.map((asset) => mapRuntimeCredentialAssetToConfigItem(asset));
}

/**
 * 获取上传配置文件列表
 */
export async function handleGetUploadConfigs(req, res, currentConfig, providerPoolManager) {
    const debugEnabled = isUploadConfigDebugEnabled(req, currentConfig);
    const startedAt = Date.now();
    const source = getUploadConfigSource(req);
    const listOptions = source === 'runtime' ? resolveUploadConfigListOptions(req, currentConfig) : {};

    logUploadConfigDebug(debugEnabled, 'GET /api/upload-configs started', {
        path: req?.url || '/api/upload-configs',
        source,
        listOptions
    });

    try {
        const configFiles = source === 'scan'
            ? await scanConfigFiles(currentConfig, providerPoolManager, { debugEnabled })
            : await buildRuntimeConfigInventory(currentConfig, listOptions);
        if (source === 'runtime' && Number.isFinite(listOptions?.limit) && Array.isArray(configFiles)) {
            if (configFiles.length >= listOptions.limit) {
                logger.warn(`[UI API] Upload configs list truncated at ${listOptions.limit} items (adjust UPLOAD_CONFIGS_MAX_RESULTS or query limit/offset).`);
            }
        }
        logUploadConfigDebug(debugEnabled, 'GET /api/upload-configs completed', {
            count: Array.isArray(configFiles) ? configFiles.length : 0,
            durationMs: Date.now() - startedAt,
            source,
            listOptions
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(configFiles));
        return true;
    } catch (error) {
        logUploadConfigDebug(debugEnabled, 'GET /api/upload-configs failed', {
            durationMs: Date.now() - startedAt,
            message: error?.message || String(error),
            source
        }, 'warn');
        logger.error('[UI API] Failed to load upload configs:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to load upload configs: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 查看特定配置文件
 */
export async function handleViewConfigFile(req, res, filePath) {
    try {
        const fullPath = path.join(process.cwd(), filePath);
        
        // 安全检查：确保文件路径在允许的目录内
        const allowedDirs = ['configs'];
        const relativePath = path.relative(process.cwd(), fullPath);
        const isAllowed = allowedDirs.some(dir => relativePath.startsWith(dir + path.sep) || relativePath === dir);
        
        if (!isAllowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Access denied: can only view files in configs directory'
                }
            }));
            return true;
        }
        
        if (!existsSync(fullPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'File does not exist'
                }
            }));
            return true;
        }
        
        const content = await fs.readFile(fullPath, 'utf-8');
        const stats = await fs.stat(fullPath);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            path: relativePath,
            content: content,
            size: stats.size,
            modified: stats.mtime.toISOString(),
            name: path.basename(fullPath)
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to view config file:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to view config file: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 删除特定配置文件
 */
export async function handleDeleteConfigFile(req, res, filePath) {
    try {
        const fullPath = path.join(process.cwd(), filePath);
        
        // 安全检查：确保文件路径在允许的目录内
        const allowedDirs = ['configs'];
        const relativePath = path.relative(process.cwd(), fullPath);
        const isAllowed = allowedDirs.some(dir => relativePath.startsWith(dir + path.sep) || relativePath === dir);
        
        if (!isAllowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Access denied: can only delete files in configs directory'
                }
            }));
            return true;
        }
        
        if (!existsSync(fullPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'File does not exist'
                }
            }));
            return true;
        }
        
        
        await fs.unlink(fullPath);
        
        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'delete',
            filePath: relativePath,
            timestamp: new Date().toISOString()
        });
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'File deleted successfully',
            filePath: relativePath
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to delete config file:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to delete config file: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 下载所有配置为 zip
 */
export async function handleDownloadAllConfigs(req, res, currentConfig) {
    try {
        const configsPath = path.join(process.cwd(), 'configs');
        if (!existsSync(configsPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'configs directory does not exist' } }));
            return true;
        }

        const zip = new AdmZip();
        let exportedProviderPools = null;

        if (currentConfig) {
            try {
                exportedProviderPools = await exportProviderPoolsCompatSnapshot(currentConfig);
            } catch (error) {
                logger.warn('[UI API] Failed to export provider pools snapshot for zip backup:', error.message);
            }

            const inMemoryProviderPools = currentConfig.providerPools;
            if ((!exportedProviderPools || Object.keys(exportedProviderPools).length === 0)
                && inMemoryProviderPools
                && Object.keys(inMemoryProviderPools).length > 0) {
                exportedProviderPools = inMemoryProviderPools;
                logger.warn('[UI API] Falling back to in-memory provider pools snapshot for zip backup');
            }
        }
        
        // 递归添加目录函数
        const addDirectoryToZip = async (dirPath, zipPath = '') => {
            const items = await fs.readdir(dirPath, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(dirPath, item.name);
                const itemZipPath = zipPath ? path.join(zipPath, item.name) : item.name;
                const normalizedZipPath = itemZipPath.replace(/\\/g, '/');
                
                if (item.isFile()) {
                    if (exportedProviderPools && normalizedZipPath === 'provider_pools.json') {
                        continue;
                    }
                    const content = await fs.readFile(fullPath);
                    zip.addFile(normalizedZipPath, content);
                } else if (item.isDirectory()) {
                    await addDirectoryToZip(fullPath, itemZipPath);
                }
            }
        };

        await addDirectoryToZip(configsPath);

        if (exportedProviderPools) {
            zip.addFile('provider_pools.json', Buffer.from(JSON.stringify(exportedProviderPools, null, 2), 'utf8'));
        }
        
        const zipBuffer = zip.toBuffer();
        const filename = `configs_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;

        res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Length': zipBuffer.length
        });
        res.end(zipBuffer);
        
        logger.info(`[UI API] All configs downloaded as zip: ${filename}`);
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to download all configs:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to download zip: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 批量删除未绑定的配置文件
 * 只删除 configs/xxx/ 子目录下的未绑定配置文件
 */
export async function handleDeleteUnboundConfigs(req, res, currentConfig, providerPoolManager) {
    try {
        // 首先获取所有配置文件及其绑定状态
        const configFiles = await scanConfigFiles(currentConfig, providerPoolManager);
        
        // 筛选出未绑定的配置文件，并且必须在 configs/xxx/ 子目录下
        // 即路径格式为 configs/子目录名/文件名，而不是直接在 configs/ 根目录下
        const unboundConfigs = configFiles.filter(config => {
            if (config.isUsed) return false;
            
            // 检查路径是否在 configs/xxx/ 子目录下
            // 路径格式应该是 configs/子目录/...
            const normalizedPath = config.path.replace(/\\/g, '/');
            const pathParts = normalizedPath.split('/');
            
            // 路径至少需要3部分：configs/子目录/文件名
            // 例如：configs/kiro/xxx.json 或 configs/gemini/xxx.json
            if (pathParts.length >= 3 && pathParts[0] === 'configs') {
                // 确保第二部分是子目录名（不是文件名）
                return true;
            }
            
            return false;
        });
        
        if (unboundConfigs.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'No unbound config files to delete',
                deletedCount: 0,
                deletedFiles: []
            }));
            return true;
        }
        
        const deletedFiles = [];
        const failedFiles = [];
        
        for (const config of unboundConfigs) {
            try {
                const fullPath = path.join(process.cwd(), config.path);
                
                // 安全检查：确保文件路径在允许的目录内
                const allowedDirs = ['configs'];
                const relativePath = path.relative(process.cwd(), fullPath);
                const isAllowed = allowedDirs.some(dir => relativePath.startsWith(dir + path.sep) || relativePath === dir);
                
                if (!isAllowed) {
                    failedFiles.push({
                        path: config.path,
                        error: 'Access denied: can only delete files in configs directory'
                    });
                    continue;
                }
                
                if (!existsSync(fullPath)) {
                    failedFiles.push({
                        path: config.path,
                        error: 'File does not exist'
                    });
                    continue;
                }
                
                await fs.unlink(fullPath);
                deletedFiles.push(config.path);
                
            } catch (error) {
                failedFiles.push({
                    path: config.path,
                    error: error.message
                });
            }
        }
        
        // 广播更新事件
        if (deletedFiles.length > 0) {
            broadcastEvent('config_update', {
                action: 'batch_delete',
                deletedFiles: deletedFiles,
                timestamp: new Date().toISOString()
            });
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Deleted ${deletedFiles.length} unbound config files`,
            deletedCount: deletedFiles.length,
            deletedFiles: deletedFiles,
            failedCount: failedFiles.length,
            failedFiles: failedFiles
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to delete unbound configs:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to delete unbound configs: ' + error.message
            }
        }));
        return true;
    }
}

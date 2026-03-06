import { existsSync } from 'fs';
import logger from '../utils/logger.js';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CONFIG } from '../core/config-manager.js';
import { getRuntimeStorage } from '../storage/runtime-storage-registry.js';

const TOKEN_STORE_FILE = path.join(process.cwd(), 'configs', 'token-store.json');
const DEFAULT_PASSWORD = 'admin123';

function getSessionStorage() {
    const runtimeStorage = getRuntimeStorage();
    if (!runtimeStorage || typeof runtimeStorage.getAdminSession !== 'function') {
        return null;
    }
    return runtimeStorage;
}

export async function readPasswordFile() {
    const pwdFilePath = path.join(process.cwd(), 'configs', 'pwd');
    try {
        const password = await fs.readFile(pwdFilePath, 'utf8');
        const trimmedPassword = password.trim();
        if (!trimmedPassword) {
            logger.info('[Auth] Password file is empty, using default password: ' + DEFAULT_PASSWORD);
            return DEFAULT_PASSWORD;
        }
        logger.info('[Auth] Successfully read password file');
        return trimmedPassword;
    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.info('[Auth] Password file does not exist, using default password: ' + DEFAULT_PASSWORD);
        } else {
            logger.error('[Auth] Failed to read password file:', error.code || error.message);
            logger.info('[Auth] Using default password: ' + DEFAULT_PASSWORD);
        }
        return DEFAULT_PASSWORD;
    }
}

export async function validateCredentials(password) {
    const storedPassword = await readPasswordFile();
    logger.info('[Auth] Validating password, stored password length:', storedPassword ? storedPassword.length : 0, ', input password length:', password ? password.length : 0);
    const isValid = storedPassword && password === storedPassword;
    logger.info('[Auth] Password validation result:', isValid);
    return isValid;
}

function parseRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                if (!body.trim()) {
                    resolve({});
                } else {
                    resolve(JSON.parse(body));
                }
            } catch (error) {
                reject(new Error('Invalid JSON format'));
            }
        });
        req.on('error', reject);
    });
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function getExpiryTime() {
    const now = Date.now();
    const expiry = (CONFIG.LOGIN_EXPIRY || 3600) * 1000;
    return now + expiry;
}

async function readTokenStore() {
    try {
        if (existsSync(TOKEN_STORE_FILE)) {
            const content = await fs.readFile(TOKEN_STORE_FILE, 'utf8');
            return JSON.parse(content);
        }
        await writeTokenStore({ tokens: {} });
        return { tokens: {} };
    } catch (error) {
        logger.error('[Token Store] Failed to read token store file:', error);
        return { tokens: {} };
    }
}

async function writeTokenStore(tokenStore) {
    try {
        await fs.writeFile(TOKEN_STORE_FILE, JSON.stringify(tokenStore, null, 2), 'utf8');
    } catch (error) {
        logger.error('[Token Store] Failed to write token store file:', error);
    }
}

export async function verifyToken(token) {
    const sessionStorage = getSessionStorage();
    if (sessionStorage) {
        try {
            return await sessionStorage.getAdminSession(token);
        } catch (error) {
            logger.error('[Auth] Failed to verify token via runtime storage:', error.message);
        }
    }

    const tokenStore = await readTokenStore();
    const tokenInfo = tokenStore.tokens[token];
    if (!tokenInfo) {
        return null;
    }

    if (Date.now() > tokenInfo.expiryTime) {
        await deleteToken(token);
        return null;
    }

    return tokenInfo;
}

async function saveToken(token, tokenInfo) {
    const sessionStorage = getSessionStorage();
    if (sessionStorage) {
        await sessionStorage.saveAdminSession(token, tokenInfo);
        return;
    }

    const tokenStore = await readTokenStore();
    tokenStore.tokens[token] = tokenInfo;
    await writeTokenStore(tokenStore);
}

async function deleteToken(token) {
    const sessionStorage = getSessionStorage();
    if (sessionStorage) {
        await sessionStorage.deleteAdminSession(token);
        return;
    }

    const tokenStore = await readTokenStore();
    if (tokenStore.tokens[token]) {
        delete tokenStore.tokens[token];
        await writeTokenStore(tokenStore);
    }
}

export async function cleanupExpiredTokens() {
    const sessionStorage = getSessionStorage();
    if (sessionStorage) {
        await sessionStorage.cleanupExpiredAdminSessions();
        return;
    }

    const tokenStore = await readTokenStore();
    const now = Date.now();
    let hasChanges = false;

    for (const token in tokenStore.tokens) {
        if (now > tokenStore.tokens[token].expiryTime) {
            delete tokenStore.tokens[token];
            hasChanges = true;
        }
    }

    if (hasChanges) {
        await writeTokenStore(tokenStore);
    }
}

export async function checkAuth(req) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return false;
    }

    const token = authHeader.substring(7);
    const tokenInfo = await verifyToken(token);
    return tokenInfo !== null;
}

export async function handleLoginRequest(req, res) {
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Only POST requests are supported' }));
        return true;
    }

    try {
        const requestData = await parseRequestBody(req);
        const { password } = requestData;

        if (!password) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Password cannot be empty' }));
            return true;
        }

        const isValid = await validateCredentials(password);
        if (isValid) {
            const token = generateToken();
            const expiryTime = getExpiryTime();
            await saveToken(token, {
                username: 'admin',
                loginTime: Date.now(),
                expiryTime,
                sourceIp: req.socket?.remoteAddress || null,
                userAgent: req.headers['user-agent'] || null
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Login successful',
                token,
                expiresIn: `${CONFIG.LOGIN_EXPIRY || 3600} seconds`
            }));
        } else {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: 'Incorrect password, please try again'
            }));
        }
    } catch (error) {
        logger.error('[Auth] Login processing error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            message: error.message || 'Server error'
        }));
    }
    return true;
}

const cleanupExpiredTokenTimer = setInterval(cleanupExpiredTokens, 5 * 60 * 1000);
if (typeof cleanupExpiredTokenTimer.unref === 'function') {
    cleanupExpiredTokenTimer.unref();
}

import express from 'express';
import cors from 'cors';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';
import { Composio } from '@composio/core';
import { getProvider, getAvailableProviders, initializeProviders } from './providers/index.js';
import multer from 'multer';
import { requireAuth, requireAdmin, isAdmin } from './supabase/auth-middleware.js';
import * as dbExplorer from './supabase/db-explorer.js';
import { getPublicConfig } from './supabase/client.js';
import * as chatStore from './supabase/chat-store.js';
import * as sessionStore from './supabase/session-store.js';
import * as storage from './supabase/storage.js';
import { searchSimilar, embedMessage, embedAttachment } from './supabase/embeddings.js';
import { setupCronJobs, startEmbeddingCron } from './supabase/cron.js';
import * as reportStore from './supabase/report-store.js';
import * as jobStore from './supabase/job-store.js';
import * as taskStore from './supabase/task-store.js';
import * as vaultStore from './supabase/vault-store.js';
import * as folderStore from './supabase/folder-store.js';
import { startScheduler, triggerJob, stopScheduler } from './job-scheduler.js';
import { BrowserServer, createBrowserMcpServer } from './browser/index.js';
import { createDocumentMcpServer } from './documents/index.js';
import { PluginManager } from './plugins/plugin-manager.js';
import crypto from 'crypto';
import {
  readUserSettingsFile,
  getUserSettingsPath,
  clearUserSettingsCache,
  cloneSettings,
  isSecureMode
} from './utils/settings-utils.js';
import { buildSystemPrompt, fetchDirectExternalContext } from './utils/prompt-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const USER_SETTINGS_PATH = path.join(__dirname, 'user-settings.json');
const USER_SETTINGS_CACHE_TTL_MS = Math.max(1_000, Number(process.env.USER_SETTINGS_CACHE_MS || 5_000));
const USER_SETTINGS_FILE_MODE = 0o600;
const COMPOSIO_SESSION_TTL_MS = Math.max(60_000, Number(process.env.COMPOSIO_SESSION_TTL_MS || 30 * 60 * 1000));
const COMPOSIO_SESSION_MAX = Math.max(20, Number(process.env.COMPOSIO_SESSION_MAX || 200));
const COMPOSIO_SESSION_CLEANUP_MS = Math.max(30_000, Number(process.env.COMPOSIO_SESSION_CLEANUP_MS || 5 * 60 * 1000));
const DEFAULT_CORS_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001'
];

const configuredOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean)
  : [];
const allowedOrigins = new Set(configuredOrigins.length ? configuredOrigins : DEFAULT_CORS_ORIGINS);
const allowNullOrigin =
  process.env.NODE_ENV === 'production'
    ? process.env.ALLOW_NULL_ORIGIN === 'true'
    : process.env.ALLOW_NULL_ORIGIN !== 'false';

let composioSessionCleanupTimer = null;
let composio = null;

function hasComposioApiKey() {
  return Boolean(process.env.COMPOSIO_API_KEY && process.env.COMPOSIO_API_KEY.trim());
}

function ensureComposioClient() {
  if (!hasComposioApiKey()) {
    if (composio !== null) {
      console.log('[COMPOSIO] Disabled: COMPOSIO_API_KEY not configured');
    }
    composio = null;
    return null;
  }
  if (composio) return composio;
  try {
    composio = new Composio();
    console.log('[COMPOSIO] Client initialized');
    return composio;
  } catch (error) {
    console.error('[COMPOSIO] Failed to initialize client:', error.message);
    composio = null;
    return null;
  }
}

function createRateLimiter({ windowMs, maxRequests }) {
  const buckets = new Map();
  return function rateLimit(req, res, next) {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count > maxRequests) {
      return res.status(429).json({ error: 'Too many requests. Please retry later.' });
    }

    next();
  };
}

const rateLimit = {
  chat: createRateLimiter({ windowMs: 60_000, maxRequests: 60 }),
  upload: createRateLimiter({ windowMs: 60_000, maxRequests: 20 }),
  settings: createRateLimiter({ windowMs: 60_000, maxRequests: 30 }),
  reports: createRateLimiter({ windowMs: 60_000, maxRequests: 45 }),
  jobs: createRateLimiter({ windowMs: 60_000, maxRequests: 45 }),
  vault: createRateLimiter({ windowMs: 60_000, maxRequests: 45 }),
  tasks: createRateLimiter({ windowMs: 60_000, maxRequests: 45 }),
  search: createRateLimiter({ windowMs: 60_000, maxRequests: 30 })
};

function sendInternalError(res, err) {
  if (err) {
    console.error('[SERVER] Internal error:', err.message || String(err));
  }
  return res.status(500).json({ error: 'Internal server error' });
}

function getComposioSession(userId) {
  const entry = composioSessions.get(userId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    composioSessions.delete(userId);
    return null;
  }
  composioSessions.delete(userId);
  entry.lastUsed = Date.now();
  entry.expiresAt = entry.lastUsed + COMPOSIO_SESSION_TTL_MS;
  composioSessions.set(userId, entry);
  return entry.session;
}

function setComposioSession(userId, session) {
  if (!userId || !session) return;
  if (composioSessions.has(userId)) {
    composioSessions.delete(userId);
  }
  composioSessions.set(userId, {
    session,
    lastUsed: Date.now(),
    expiresAt: Date.now() + COMPOSIO_SESSION_TTL_MS
  });
  while (composioSessions.size > COMPOSIO_SESSION_MAX) {
    const oldest = composioSessions.keys().next();
    if (oldest.done) break;
    composioSessions.delete(oldest.value);
  }
}

function cleanupExpiredComposioSessions() {
  const now = Date.now();
  for (const [userId, entry] of composioSessions.entries()) {
    if (!entry || entry.expiresAt <= now) {
      composioSessions.delete(userId);
    }
  }
}

function isOriginAllowed(origin) {
  if (!origin || origin === 'null') {
    return allowNullOrigin || process.env.NODE_ENV === 'test';
  }
  if (allowedOrigins.has('*')) return true;
  return allowedOrigins.has(origin);
}

function getAnonymousSessionKey(req) {
  const explicit = req.get?.('x-anon-session-id');
  if (explicit && explicit.trim()) return explicit.trim();

  const ip = req.ip || 'unknown-ip';
  const ua = req.get?.('user-agent') || 'unknown-ua';
  return crypto.createHash('sha256')
    .update(`${ip}|${ua}`)
    .digest('hex')
    .slice(0, 16);
}

function getActorUserId(req) {
  if (req?.user?.id !== 'anonymous') return req.user?.id;
  return `anonymous:${getAnonymousSessionKey(req)}`;
}

function isAnonymousUserId(userId) {
  return typeof userId === 'string' && userId.startsWith('anonymous');
}

function shouldFailDbWrite(err) {
  return !!(err && ['CHAT_FORBIDDEN', 'CHAT_OWNERSHIP_VIOLATION', 'PGRST116', 'VALIDATION_ERROR'].includes(err.code));
}

function sanitizeTextInput(value, { maxLength, allowEmpty } = {}) {
  if (typeof value !== 'string') return allowEmpty ? '' : null;
  const text = value.trim();
  if (!text && !allowEmpty) return null;
  if (maxLength && text.length > maxLength) {
    return text.slice(0, maxLength);
  }
  return text;
}

function sanitizeProviderName(providerName) {
  const normalized = sanitizeTextInput(providerName, { allowEmpty: true, maxLength: 40 });
  if (!normalized) return 'claude';
  return normalized.toLowerCase();
}

function sanitizeChatId(chatId) {
  const value = sanitizeTextInput(chatId, { allowEmpty: true, maxLength: 160 });
  if (!value) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(value)) return null;
  return value;
}

function isUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function isSafeParamId(value) {
  if (!value || typeof value !== 'string') return false;
  if (value.length > 200) return false;
  return /^[A-Za-z0-9._-]+$/.test(value) || isUuid(value);
}

function applyUserSettingsToEnv(settings) {
  const data = settings || {};
  process.env.ANTHROPIC_API_KEY = data.apiKeys?.anthropic || '';
  process.env.COMPOSIO_API_KEY = data.apiKeys?.composio || '';
  process.env.SMITHERY_API_KEY = data.apiKeys?.smithery || '';
  process.env.DATAFORSEO_USERNAME = data.apiKeys?.dataforseoUsername || '';
  process.env.DATAFORSEO_PASSWORD = data.apiKeys?.dataforseoPassword || '';
}

function scheduleComposioSessionCleanup() {
  if (composioSessionCleanupTimer) {
    clearInterval(composioSessionCleanupTimer);
  }
  composioSessionCleanupTimer = setInterval(cleanupExpiredComposioSessions, COMPOSIO_SESSION_CLEANUP_MS);
}

async function assertChatOwnedByUser(chatId, userId) {
  const owner = await chatStore.getChatOwner(chatId);
  if (!owner) {
    return { ok: false, code: 'not_found' };
  }
  if (owner !== userId) {
    return { ok: false, code: 'forbidden' };
  }
  return { ok: true };
}

/** Save user-settings to disk. */
function saveUserSettings(data) {
  const dir = path.dirname(USER_SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const normalized = normalizeUserSettings(data);
  fs.writeFileSync(
    USER_SETTINGS_PATH,
    JSON.stringify(normalized, null, 2),
    { encoding: 'utf8', mode: USER_SETTINGS_FILE_MODE }
  );
  try {
    fs.chmodSync(USER_SETTINGS_PATH, USER_SETTINGS_FILE_MODE);
  } catch (_) {
    // Ignore if chmod is unsupported in the environment.
  }
  clearUserSettingsCache();
}

/** Mask API key for safe response (last 4 chars or null). */
function maskKey(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 4) return '••••';
  return '••••' + trimmed.slice(-4);
}

/** Sanitize MCP server name for use as object key; must not collide with built-in names. */
function sanitizeMcpName(name, id) {
  const s = (name || id || 'unnamed').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64) || 'mcp';
  const reserved = ['composio', 'smithery', 'dataforseo', 'dataforseo_extra', 'browser'];
  if (reserved.includes(s)) return `user_${id || 'mcp'}`;
  return s;
}

// Apply user-settings API keys before any SDK that reads env
applyUserSettingsToEnv(readUserSettingsFile({ force: true }));

const app = express();
const PORT = process.env.PORT || 3001;
let isShuttingDown = false;
const rendererPath = path.join(__dirname, '..', 'renderer');
const rendererIndexPath = path.join(rendererPath, 'index.html');

if (fs.existsSync(rendererPath) && fs.existsSync(rendererIndexPath)) {
  app.get('/', (_req, res) => res.sendFile(rendererIndexPath));
}

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    providers: getAvailableProviders()
  });
});

// Initialize Composio lazily (optional unless COMPOSIO_API_KEY is configured).
ensureComposioClient();

const composioSessions = new Map();
let defaultComposioSession = null;

// Smithery Connect: default connection cache (namespace + connectionId → MCP URL + headers)
const SMITHERY_NAMESPACE = 'open-claude-cowork';
const SMITHERY_DEFAULT_CONNECTION_ID = 'exa';
const SMITHERY_DEFAULT_MCP_URL = 'https://exa.run.tools';
const SMITHERY_API_BASE = 'https://api.smithery.ai';
let defaultSmitheryMcpConfig = null; // { url, headers } or null
let dataforseoMcpConfig = null; // { official, extra } or null

// Browser automation module state
let browserServer = null;
let browserMcpServer = null;

// Browser tool names (used for allowedTools when browser is enabled)
const BROWSER_TOOL_NAMES = [
  'browser_status', 'browser_navigate', 'browser_snapshot', 'browser_screenshot',
  'browser_click', 'browser_type', 'browser_press', 'browser_select',
  'browser_wait', 'browser_tabs', 'browser_switch_tab', 'browser_new_tab',
  'browser_close_tab', 'browser_back', 'browser_forward', 'browser_reload'
];

// Document generation module state
let documentMcpServer = null;

// Plugin system
let pluginManager = null;

const DOCUMENT_TOOL_NAMES = [
  'create_excel', 'create_powerpoint', 'create_pdf', 'list_generated_files'
];

/**
 * Ensure Smithery namespace exists and default connection exists; return MCP config or null.
 * Uses SMITHERY_API_KEY from process.env (or user-settings).
 */
async function ensureSmitheryConnection() {
  const apiKey = process.env.SMITHERY_API_KEY;
  if (!apiKey || !apiKey.trim()) return null;

  const key = apiKey.trim();
  const authHeader = { Authorization: `Bearer ${key}` };

  try {
    // Ensure namespace exists (PUT is idempotent)
    const nsRes = await fetch(`${SMITHERY_API_BASE}/namespaces/${SMITHERY_NAMESPACE}`, {
      method: 'PUT',
      headers: { ...authHeader, 'Content-Type': 'application/json' }
    });
    if (!nsRes.ok && nsRes.status !== 409) {
      const errBody = await nsRes.text();
      console.warn('[SMITHERY] Namespace create failed:', nsRes.status, errBody);
      return null;
    }

    // Create or update connection (PUT with mcpUrl)
    const putRes = await fetch(
      `${SMITHERY_API_BASE}/connect/${SMITHERY_NAMESPACE}/${SMITHERY_DEFAULT_CONNECTION_ID}`,
      {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcpUrl: SMITHERY_DEFAULT_MCP_URL })
      }
    );
    if (putRes.status === 409) {
      // Conflict: different mcpUrl; delete and recreate
      await fetch(
        `${SMITHERY_API_BASE}/connect/${SMITHERY_NAMESPACE}/${SMITHERY_DEFAULT_CONNECTION_ID}`,
        { method: 'DELETE', headers: authHeader }
      );
      const retryRes = await fetch(
        `${SMITHERY_API_BASE}/connect/${SMITHERY_NAMESPACE}/${SMITHERY_DEFAULT_CONNECTION_ID}`,
        {
          method: 'PUT',
          headers: { ...authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({ mcpUrl: SMITHERY_DEFAULT_MCP_URL })
        }
      );
      if (!retryRes.ok) {
        const errBody = await retryRes.text();
        console.warn('[SMITHERY] Connection create retry failed:', retryRes.status, errBody);
        return null;
      }
    } else if (!putRes.ok) {
      const errBody = await putRes.text();
      console.warn('[SMITHERY] Connection create failed:', putRes.status, errBody);
      return null;
    }

    const mcpUrl = `${SMITHERY_API_BASE}/connect/${SMITHERY_NAMESPACE}/${SMITHERY_DEFAULT_CONNECTION_ID}/mcp`;
    return { url: mcpUrl, headers: { Authorization: `Bearer ${key}` } };
  } catch (err) {
    console.warn('[SMITHERY] ensureSmitheryConnection error:', err.message);
    return null;
  }
}

/**
 * Get cached or freshly created Smithery MCP config. Returns { url, headers } or null.
 */
async function getSmitheryMcpConfig() {
  if (defaultSmitheryMcpConfig) return defaultSmitheryMcpConfig;
  defaultSmitheryMcpConfig = await ensureSmitheryConnection();
  return defaultSmitheryMcpConfig;
}

// Pre-initialize Composio session on startup
async function initializeComposioSession() {
  const composioClient = ensureComposioClient();
  if (!composioClient) {
    console.log('[COMPOSIO] Pre-initialization skipped (no API key)');
    return;
  }
  const defaultUserId = 'default-user';
  console.log('[COMPOSIO] Pre-initializing session for:', defaultUserId);
  try {
    defaultComposioSession = await composioClient.create(defaultUserId);
    setComposioSession(defaultUserId, defaultComposioSession);
    console.log('[COMPOSIO] Session ready with MCP URL:', defaultComposioSession.mcp.url);
  } catch (error) {
    console.error('[COMPOSIO] Failed to pre-initialize session:', error.message);
  }
}

/**
 * Build DataForSEO MCP config (official + custom extra server). Cached.
 * Returns { official: {...}, extra: {...} } or null.
 */
function getDataforseoMcpConfig() {
  if (dataforseoMcpConfig) return dataforseoMcpConfig;
  const username = process.env.DATAFORSEO_USERNAME;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!username?.trim() || !password?.trim()) return null;
  dataforseoMcpConfig = {
    official: {
      command: 'npx',
      args: ['-y', 'dataforseo-mcp-server'],
      environment: { DATAFORSEO_USERNAME: username.trim(), DATAFORSEO_PASSWORD: password.trim() }
    },
    extra: {
      command: 'node',
      args: [path.join(__dirname, 'dataforseo-extra-mcp.js')],
      environment: { DATAFORSEO_USERNAME: username.trim(), DATAFORSEO_PASSWORD: password.trim() }
    }
  };
  return dataforseoMcpConfig;
}

/** Pre-initialize Smithery connection when API key is set (populates defaultSmitheryMcpConfig). */
async function initializeSmitheryConnection() {
  const data = readUserSettingsFile();
  if (!data.apiKeys?.smithery?.trim()) return;
  console.log('[SMITHERY] Pre-initializing connection');
  try {
    const config = await getSmitheryMcpConfig();
    if (config) {
      console.log('[SMITHERY] Connection ready');
    }
  } catch (err) {
    console.error('[SMITHERY] Failed to pre-initialize:', err.message);
  }
}

/** Pre-initialize DataForSEO MCP config when credentials are set. */
function initializeDataforseoConfig() {
  const config = getDataforseoMcpConfig();
  if (config) {
    console.log('[DATAFORSEO] MCP config ready (official + extra, local stdio)');
  }
}

/**
 * Build the MCP servers config used by the Claude provider.
 * Merges Composio (from session), Smithery (when key and connection exist), and user-defined MCP from user-settings.
 */
function buildMcpServers(composioSession) {
  const mcpServers = {};

  if (composioSession?.mcp?.url && composioSession?.mcp?.headers) {
    mcpServers.composio = {
      type: 'http',
      url: composioSession.mcp.url,
      headers: composioSession.mcp.headers
    };
  }

  if (defaultSmitheryMcpConfig) {
    mcpServers.smithery = {
      type: 'http',
      url: defaultSmitheryMcpConfig.url,
      headers: defaultSmitheryMcpConfig.headers
    };
  }

  // Add browser MCP server (SDK MCP for builtin, local MCP for agent-browser)
  if (browserMcpServer) {
    mcpServers.browser = browserMcpServer;
  }

  // Add document generation MCP server
  if (documentMcpServer) {
    mcpServers.documents = documentMcpServer;
  }

  // Add DataForSEO MCP servers (official 9-API + custom 4-API)
  const dfsConfig = getDataforseoMcpConfig();
  if (dfsConfig) {
    mcpServers.dataforseo = { type: 'local', ...dfsConfig.official };
    mcpServers.dataforseo_extra = { type: 'local', ...dfsConfig.extra };
  }

  // Add MCP servers from enabled plugins
  if (pluginManager) {
    const pluginServers = pluginManager.getEnabledMcpServers();
    for (const [name, config] of Object.entries(pluginServers)) {
      mcpServers[name] = config;
    }
  }

  const { mcpServers: userList } = readUserSettingsFile();
  for (const entry of userList) {
    const id = entry.id || String(Math.random().toString(36).slice(2));
    const name = sanitizeMcpName(entry.name, id);
    if (entry.type === 'http' && entry.url) {
      mcpServers[name] = {
        type: 'http',
        url: entry.url,
        headers: entry.headers || {}
      };
    } else if (entry.type === 'local' && entry.command) {
      mcpServers[name] = {
        type: 'local',
        command: entry.command,
        args: entry.args,
        environment: entry.environment || {}
      };
    }
  }

  return mcpServers;
}

// Middleware
app.use(cors({
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS policy'));
  },
  allowedHeaders: ['Content-Type', 'Authorization', 'x-anon-session-id'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
}));
app.use(express.json());

// Helper: check if Supabase is configured
const isSupabaseConfigured = () => !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

// ==================== SUPABASE CONFIG ENDPOINT ====================
app.get('/api/config', (_req, res) => {
  res.json(getPublicConfig());
});

// ==================== CHAT CRUD ENDPOINTS ====================
app.get('/api/chats', requireAuth, rateLimit.reports, async (req, res) => {
  try {
    const chats = await chatStore.getUserChats(req.user.id);
    res.json({ chats });
  } catch (err) {
    console.error('[CHATS] List error:', err);
    sendInternalError(res, err);
  }
});

app.get('/api/chats/:chatId', requireAuth, rateLimit.reports, async (req, res) => {
  try {
    if (!isSafeParamId(req.params.chatId)) {
      return res.status(400).json({ error: 'Invalid chatId' });
    }
    const chat = await chatStore.getChat(req.params.chatId, req.user.id);
    res.json(chat);
  } catch (err) {
    if (err.code === 'PGRST116') return res.status(404).json({ error: 'Chat not found' });
    console.error('[CHATS] Get error:', err);
    sendInternalError(res, err);
  }
});

app.post('/api/chats', requireAuth, rateLimit.reports, async (req, res) => {
  try {
    const { id, title, provider, model } = req.body;
    if (id && !isSafeParamId(id)) {
      return res.status(400).json({ error: 'Invalid chatId' });
    }
    const chat = await chatStore.createChat({ id, userId: req.user.id, title, provider, model });
    res.json(chat);
  } catch (err) {
    console.error('[CHATS] Create error:', err);
    sendInternalError(res, err);
  }
});

app.delete('/api/chats/:chatId', requireAuth, rateLimit.reports, async (req, res) => {
  try {
    if (!isSafeParamId(req.params.chatId)) {
      return res.status(400).json({ error: 'Invalid chatId' });
    }
    await chatStore.deleteChat(req.params.chatId, req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[CHATS] Delete error:', err);
    sendInternalError(res, err);
  }
});

app.patch('/api/chats/:chatId', requireAuth, rateLimit.reports, async (req, res) => {
  try {
    if (!isSafeParamId(req.params.chatId)) {
      return res.status(400).json({ error: 'Invalid chatId' });
    }
    const chat = await chatStore.updateChat(req.params.chatId, req.user.id, req.body);
    res.json(chat);
  } catch (err) {
    console.error('[CHATS] Update error:', err);
    sendInternalError(res, err);
  }
});

// ==================== MESSAGES ENDPOINT ====================
app.post('/api/messages', requireAuth, rateLimit.reports, async (req, res) => {
  try {
    const { chatId, role, content, html, metadata } = req.body;
    if (!isSafeParamId(chatId)) {
      return res.status(400).json({ error: 'Invalid chatId' });
    }
    const msg = await chatStore.addMessage({ chatId, userId: req.user.id, role, content, html, metadata });
    res.json(msg);
  } catch (err) {
    console.error('[MESSAGES] Create error:', err);
    sendInternalError(res, err);
  }
});

// ==================== PROFILE ENDPOINTS ====================
app.get('/api/profile', requireAuth, async (req, res) => {
  try {
    const profile = await chatStore.getProfile(req.user.id);
    res.json(profile || {});
  } catch (err) {
    console.error('[PROFILE] Get error:', err);
    sendInternalError(res, err);
  }
});

app.patch('/api/profile', requireAuth, async (req, res) => {
  try {
    const profile = await chatStore.updateProfile(req.user.id, req.body);
    res.json(profile);
  } catch (err) {
    console.error('[PROFILE] Update error:', err);
    sendInternalError(res, err);
  }
});

// ==================== FILE UPLOAD/DOWNLOAD ====================
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB max

app.post('/api/upload', requireAuth, rateLimit.upload, upload.single('file'), async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'File storage requires Supabase' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  try {
    const chatId = req.body.chatId || null;
    const attachment = await storage.uploadFile(req.user.id, req.file, chatId);
    // Tag chat-originated uploads so they appear in the vault
    if (chatId && attachment.id) {
      try { await vaultStore.updateAsset(attachment.id, req.user.id, { source: 'chat' }); } catch (_) {}
    }
    res.json(attachment);
  } catch (err) {
    console.error('[UPLOAD] Error:', err);
    sendInternalError(res, err);
  }
});

app.get('/api/files/:attachmentId/url', requireAuth, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'File storage requires Supabase' });

  try {
    const url = await storage.getFileUrl(req.params.attachmentId, req.user.id);
    res.json({ url });
  } catch (err) {
    console.error('[FILES] URL error:', err);
    sendInternalError(res, err);
  }
});

// ==================== VAULT ENDPOINTS ====================

// List folders at a given level (root when parentId is omitted)
app.get('/api/vault/folders', requireAuth, rateLimit.vault, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Vault requires Supabase' });
  try {
    const folders = await vaultStore.getUserFolders(req.user.id, req.query.parentId || null);
    res.json(folders);
  } catch (err) {
    console.error('[VAULT] List folders error:', err);
    sendInternalError(res, err);
  }
});

// Create folder
app.post('/api/vault/folders', requireAuth, rateLimit.vault, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Vault requires Supabase' });
  const { name, parentId } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const folder = await vaultStore.createFolder(req.user.id, name, parentId || null);
    res.json(folder);
  } catch (err) {
    console.error('[VAULT] Create folder error:', err);
    sendInternalError(res, err);
  }
});

// Rename or move folder
app.patch('/api/vault/folders/:id', requireAuth, rateLimit.vault, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Vault requires Supabase' });
  try {
    let folder;
    if (req.body.name) {
      folder = await vaultStore.renameFolder(req.params.id, req.user.id, req.body.name);
    }
    if (req.body.parentId !== undefined) {
      folder = await vaultStore.moveFolder(req.params.id, req.user.id, req.body.parentId);
    }
    res.json(folder || { ok: true });
  } catch (err) {
    console.error('[VAULT] Update folder error:', err);
    sendInternalError(res, err);
  }
});

// Delete folder (cascade)
app.delete('/api/vault/folders/:id', requireAuth, rateLimit.vault, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Vault requires Supabase' });
  try {
    await vaultStore.deleteFolder(req.params.id, req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[VAULT] Delete folder error:', err);
    sendInternalError(res, err);
  }
});

// Folder breadcrumbs
app.get('/api/vault/folders/:id/breadcrumbs', requireAuth, rateLimit.vault, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Vault requires Supabase' });
  try {
    const crumbs = await vaultStore.getFolderBreadcrumbs(req.params.id, req.user.id);
    res.json(crumbs);
  } catch (err) {
    console.error('[VAULT] Breadcrumbs error:', err);
    sendInternalError(res, err);
  }
});

// List vault assets
app.get('/api/vault/assets', requireAuth, rateLimit.vault, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Vault requires Supabase' });
  try {
    const assets = await vaultStore.getVaultAssets(req.user.id, req.query.folderId || null, {
      sort: req.query.sort,
      dir: req.query.dir,
      source: req.query.source,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    });
    res.json(assets);
  } catch (err) {
    console.error('[VAULT] List assets error:', err);
    sendInternalError(res, err);
  }
});

// Upload to vault
app.post('/api/vault/assets/upload', requireAuth, rateLimit.vault, upload.single('file'), async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Vault requires Supabase' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  try {
    const folderId = req.body.folderId || null;
    const source = req.body.source || 'upload';
    const attachment = await storage.uploadVaultFile(req.user.id, req.file, folderId, source);
    res.json(attachment);

    // Embed text-based files for semantic search (non-blocking)
    const mime = req.file.mimetype || '';
    if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/javascript') {
      const textContent = req.file.buffer?.toString('utf-8');
      if (textContent) {
        embedAttachment(attachment.id, textContent, req.user.id).catch(err =>
          console.error('[VAULT] Embedding error:', err.message)
        );
      }
    }
  } catch (err) {
    console.error('[VAULT] Upload error:', err);
    sendInternalError(res, err);
  }
});

// Update asset (move, rename, describe)
app.patch('/api/vault/assets/:id', requireAuth, rateLimit.vault, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Vault requires Supabase' });
  try {
    const asset = await vaultStore.updateAsset(req.params.id, req.user.id, req.body);
    res.json(asset);
  } catch (err) {
    console.error('[VAULT] Update asset error:', err);
    sendInternalError(res, err);
  }
});

// Delete asset
app.delete('/api/vault/assets/:id', requireAuth, rateLimit.vault, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Vault requires Supabase' });
  try {
    await storage.deleteFile(req.params.id, req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[VAULT] Delete asset error:', err);
    sendInternalError(res, err);
  }
});

// Signed URL for asset
app.get('/api/vault/assets/:id', requireAuth, rateLimit.vault, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Vault requires Supabase' });
  try {
    const url = await storage.getFileUrl(req.params.id, req.user.id);
    res.json({ url });
  } catch (err) {
    console.error('[VAULT] Asset URL error:', err);
    sendInternalError(res, err);
  }
});

app.get('/api/vault/assets/:id/url', requireAuth, rateLimit.vault, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Vault requires Supabase' });
  try {
    const url = await storage.getFileUrl(req.params.id, req.user.id);
    res.json({ url });
  } catch (err) {
    console.error('[VAULT] Asset URL alias error:', err);
    sendInternalError(res, err);
  }
});

// Vault stats
app.get('/api/vault/stats', requireAuth, rateLimit.vault, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Vault requires Supabase' });
  try {
    const stats = await vaultStore.getVaultStats(req.user.id);
    res.json(stats);
  } catch (err) {
    console.error('[VAULT] Stats error:', err);
    sendInternalError(res, err);
  }
});

// ==================== UNIVERSAL FOLDERS ENDPOINTS ====================

// List folders (by type and parent)
app.get('/api/folders', requireAuth, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Folders require Supabase' });
  try {
    const type = req.query.type;
    const parentId = req.query.parentId || null;
    if (!type) return res.status(400).json({ error: 'type is required' });
    const folders = await folderStore.getFolders(req.user.id, type, parentId);
    res.json(folders);
  } catch (err) {
    console.error('[FOLDERS] List error:', err);
    sendInternalError(res, err);
  }
});

// Create folder
app.post('/api/folders', requireAuth, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Folders require Supabase' });
  try {
    const { name, type, parentId } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'name and type are required' });
    const folder = await folderStore.createFolder(req.user.id, name, type, parentId);
    res.json(folder);
  } catch (err) {
    console.error('[FOLDERS] Create error:', err);
    sendInternalError(res, err);
  }
});

// Rename folder
app.patch('/api/folders/:id', requireAuth, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Folders require Supabase' });
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const folder = await folderStore.renameFolder(req.params.id, req.user.id, name);
    res.json(folder);
  } catch (err) {
    console.error('[FOLDERS] Rename error:', err);
    sendInternalError(res, err);
  }
});

// Delete folder
app.delete('/api/folders/:id', requireAuth, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Folders require Supabase' });
  try {
    await folderStore.deleteFolder(req.params.id, req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[FOLDERS] Delete error:', err);
    sendInternalError(res, err);
  }
});

// Folder breadcrumbs
app.get('/api/folders/:id/breadcrumbs', requireAuth, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Folders require Supabase' });
  try {
    const crumbs = await folderStore.getBreadcrumbs(req.params.id, req.user.id);
    res.json(crumbs);
  } catch (err) {
    console.error('[FOLDERS] Breadcrumbs error:', err);
    sendInternalError(res, err);
  }
});

// ==================== SEARCH ENDPOINT ====================
app.post('/api/search', requireAuth, rateLimit.search, async (req, res) => {
  if (!isSupabaseConfigured() || !process.env.OPENAI_API_KEY) {
    return res.status(501).json({ error: 'Search requires Supabase + OpenAI API key' });
  }

  const { query, limit = 10 } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });

  try {
    const results = await searchSimilar(query, req.user.id, limit);
    res.json({ results });
  } catch (err) {
    console.error('[SEARCH] Error:', err);
    sendInternalError(res, err);
  }
});

// ==================== DATABASE EXPLORER ENDPOINTS ====================
// Access check — only needs requireAuth (returns boolean, does not expose data)
app.get('/api/database/access', requireAuth, (req, res) => {
  if (!isSupabaseConfigured()) return res.json({ allowed: false });
  res.json({ allowed: isAdmin(req.user?.email) });
});

// List all tables with stats
app.get('/api/database/tables', requireAuth, requireAdmin, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Database explorer requires Supabase' });
  try {
    const tables = await dbExplorer.listTables();
    res.json({ tables });
  } catch (err) {
    console.error('[DB-EXPLORER] List tables error:', err);
    sendInternalError(res, err);
  }
});

// Get table schema (columns + indexes)
app.get('/api/database/tables/:tableName/schema', requireAuth, requireAdmin, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Database explorer requires Supabase' });
  try {
    const [columns, indexes] = await Promise.all([
      dbExplorer.getTableColumns(req.params.tableName),
      dbExplorer.getTableIndexes(req.params.tableName)
    ]);
    res.json({ columns, indexes });
  } catch (err) {
    console.error('[DB-EXPLORER] Schema error:', err);
    sendInternalError(res, err);
  }
});

// Get table rows (paginated, sortable, searchable)
app.get('/api/database/tables/:tableName/rows', requireAuth, requireAdmin, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Database explorer requires Supabase' });
  try {
    const { page = 0, pageSize = 25, sort, dir = 'ASC', search } = req.query;
    const pageOffset = Number(page) * Number(pageSize);

    // Fetch columns in parallel for vector processing
    const [result, columns] = await Promise.all([
      dbExplorer.getTableRows(req.params.tableName, {
        sortColumn: sort || null,
        sortDirection: dir,
        pageOffset,
        pageSize: Number(pageSize),
        search: search || null
      }),
      dbExplorer.getTableColumns(req.params.tableName)
    ]);

    // Process vector columns for display
    if (result.rows) {
      result.rows = dbExplorer.processRowsForDisplay(result.rows, columns);
    }

    res.json(result);
  } catch (err) {
    console.error('[DB-EXPLORER] Rows error:', err);
    sendInternalError(res, err);
  }
});

// Get overall database statistics
app.get('/api/database/stats', requireAuth, requireAdmin, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Database explorer requires Supabase' });
  try {
    const stats = await dbExplorer.getDatabaseStats();
    res.json(stats);
  } catch (err) {
    console.error('[DB-EXPLORER] Stats error:', err);
    sendInternalError(res, err);
  }
});

// ==================== REPORT ENDPOINTS ====================

app.get('/api/reports/summary', requireAuth, rateLimit.reports, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Reports require Supabase' });
  try {
    const data = await reportStore.getSummary(req.user.id);
    res.json(data);
  } catch (err) {
    console.error('[REPORTS] Summary error:', err);
    sendInternalError(res, err);
  }
});

app.get('/api/reports/daily-messages', requireAuth, rateLimit.reports, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Reports require Supabase' });
  try {
    const days = parseInt(req.query.days) || 30;
    const data = await reportStore.getDailyMessages(req.user.id, days);
    res.json(data);
  } catch (err) {
    console.error('[REPORTS] Daily messages error:', err);
    sendInternalError(res, err);
  }
});

app.get('/api/reports/provider-usage', requireAuth, rateLimit.reports, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Reports require Supabase' });
  try {
    const days = parseInt(req.query.days) || 30;
    const data = await reportStore.getProviderUsage(req.user.id, days);
    res.json(data);
  } catch (err) {
    console.error('[REPORTS] Provider usage error:', err);
    sendInternalError(res, err);
  }
});

app.get('/api/reports/tool-usage', requireAuth, rateLimit.reports, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Reports require Supabase' });
  try {
    const days = parseInt(req.query.days) || 30;
    const data = await reportStore.getToolUsage(req.user.id, days);
    res.json(data);
  } catch (err) {
    console.error('[REPORTS] Tool usage error:', err);
    sendInternalError(res, err);
  }
});

app.post('/api/reports/query', requireAuth, rateLimit.reports, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Reports require Supabase' });
  try {
    const config = req.body;
    if (!config || !config.source) return res.status(400).json({ error: 'Report config with source is required' });
    const data = await reportStore.executeCustomQuery(req.user.id, config);
    res.json(data);
  } catch (err) {
    console.error('[REPORTS] Custom query error:', err);
    sendInternalError(res, err);
  }
});

// Saved reports CRUD
app.get('/api/reports/saved', requireAuth, rateLimit.reports, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Reports require Supabase' });
  try {
    const reports = await reportStore.getSavedReports(req.user.id);
    res.json({ reports });
  } catch (err) {
    console.error('[REPORTS] List saved error:', err);
    sendInternalError(res, err);
  }
});

app.post('/api/reports/saved', requireAuth, rateLimit.reports, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Reports require Supabase' });
  try {
    const { name, description, reportConfig } = req.body;
    if (!name || !reportConfig) return res.status(400).json({ error: 'name and reportConfig are required' });
    const report = await reportStore.createSavedReport(req.user.id, { name, description, reportConfig });
    res.json(report);
  } catch (err) {
    console.error('[REPORTS] Create saved error:', err);
    sendInternalError(res, err);
  }
});

app.get('/api/reports/saved/:reportId', requireAuth, rateLimit.reports, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Reports require Supabase' });
  try {
    const report = await reportStore.getSavedReport(req.params.reportId, req.user.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json(report);
  } catch (err) {
    if (err.code === 'PGRST116') return res.status(404).json({ error: 'Report not found' });
    console.error('[REPORTS] Get saved error:', err);
    sendInternalError(res, err);
  }
});

app.patch('/api/reports/saved/:reportId', requireAuth, rateLimit.reports, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Reports require Supabase' });
  try {
    const report = await reportStore.updateSavedReport(req.params.reportId, req.user.id, req.body);
    res.json(report);
  } catch (err) {
    console.error('[REPORTS] Update saved error:', err);
    sendInternalError(res, err);
  }
});

app.delete('/api/reports/saved/:reportId', requireAuth, rateLimit.reports, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Reports require Supabase' });
  try {
    await reportStore.deleteSavedReport(req.params.reportId, req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[REPORTS] Delete saved error:', err);
    sendInternalError(res, err);
  }
});

app.post('/api/reports/saved/:reportId/run', requireAuth, rateLimit.reports, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Reports require Supabase' });
  try {
    const report = await reportStore.getSavedReport(req.params.reportId, req.user.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    const result = await reportStore.executeCustomQuery(req.user.id, report.report_config);
    await reportStore.updateReportResult(req.params.reportId, req.user?.id, result);
    res.json({ result });
  } catch (err) {
    console.error('[REPORTS] Run saved error:', err);
    sendInternalError(res, err);
  }
});

// ==================== JOB ENDPOINTS ====================

app.get('/api/jobs', requireAuth, rateLimit.jobs, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Jobs require Supabase' });
  try {
    const jobs = await jobStore.getUserJobs(req.user.id);
    res.json({ jobs });
  } catch (err) {
    console.error('[JOBS] List error:', err);
    sendInternalError(res, err);
  }
});

app.post('/api/jobs', requireAuth, rateLimit.jobs, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Jobs require Supabase' });
  try {
    const job = await jobStore.createJob(req.user.id, req.body);
    res.json(job);
  } catch (err) {
    console.error('[JOBS] Create error:', err);
    sendInternalError(res, err);
  }
});

app.get('/api/jobs/:jobId', requireAuth, rateLimit.jobs, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Jobs require Supabase' });
  try {
    const job = await jobStore.getJob(req.params.jobId, req.user.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (err) {
    if (err.code === 'PGRST116') return res.status(404).json({ error: 'Job not found' });
    console.error('[JOBS] Get error:', err);
    sendInternalError(res, err);
  }
});

app.patch('/api/jobs/:jobId', requireAuth, rateLimit.jobs, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Jobs require Supabase' });
  try {
    const job = await jobStore.updateJob(req.params.jobId, req.user.id, req.body);
    res.json(job);
  } catch (err) {
    console.error('[JOBS] Update error:', err);
    sendInternalError(res, err);
  }
});

app.delete('/api/jobs/:jobId', requireAuth, rateLimit.jobs, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Jobs require Supabase' });
  try {
    await jobStore.deleteJob(req.params.jobId, req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[JOBS] Delete error:', err);
    sendInternalError(res, err);
  }
});

app.get('/api/jobs/:jobId/executions', requireAuth, rateLimit.jobs, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Jobs require Supabase' });
  try {
    const limit = parseInt(req.query.limit) || 10;
    const executions = await jobStore.getJobExecutions(req.params.jobId, req.user.id, { limit });
    res.json({ executions });
  } catch (err) {
    console.error('[JOBS] Executions error:', err);
    sendInternalError(res, err);
  }
});

app.post('/api/jobs/:jobId/run', requireAuth, rateLimit.jobs, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Jobs require Supabase' });
  try {
    await triggerJob(req.params.jobId, req.user.id);
    const job = await jobStore.getJob(req.params.jobId, req.user.id);
    res.json(job);
  } catch (err) {
    console.error('[JOBS] Run error:', err);
    sendInternalError(res, err);
  }
});

// ==================== TASK MANAGEMENT ENDPOINTS ====================

// --- Labels (before :taskId to avoid param capture) ---
app.get('/api/tasks/labels', requireAuth, rateLimit.tasks, async (req, res) => {
  try {
    const labels = await taskStore.getUserLabels(req.user.id);
    res.json(labels);
  } catch (err) {
    console.error('[TASKS] List labels error:', err);
    sendInternalError(res, err);
  }
});
app.post('/api/tasks/labels', requireAuth, rateLimit.tasks, async (req, res) => {
  try {
    const label = await taskStore.createLabel(req.user.id, req.body);
    res.status(201).json(label);
  } catch (err) {
    console.error('[TASKS] Create label error:', err);
    sendInternalError(res, err);
  }
});

app.put('/api/tasks/labels/:labelId', requireAuth, rateLimit.tasks, async (req, res) => {
  try {
    if (!isSafeParamId(req.params.labelId)) {
      return res.status(400).json({ error: 'Invalid labelId' });
    }
    const label = await taskStore.updateLabel(req.params.labelId, req.user.id, req.body);
    res.json(label);
  } catch (err) {
    console.error('[TASKS] Update label error:', err);
    sendInternalError(res, err);
  }
});

app.delete('/api/tasks/labels/:labelId', requireAuth, rateLimit.tasks, async (req, res) => {
  try {
    if (!isSafeParamId(req.params.labelId)) {
      return res.status(400).json({ error: 'Invalid labelId' });
    }
    await taskStore.deleteLabel(req.params.labelId, req.user.id);
    res.status(204).end();
  } catch (err) {
    console.error('[TASKS] Delete label error:', err);
    sendInternalError(res, err);
  }
});

// --- Calendar / Board helpers (before :taskId) ---
app.get('/api/tasks/calendar/range', requireAuth, rateLimit.tasks, async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end query params required' });
    const startDate = new Date(start);
    const endDate = new Date(end);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      return res.status(400).json({ error: 'Invalid start or end date' });
    }
    const tasks = await taskStore.getTasksInRange(req.user.id, start, end);
    res.json(tasks);
  } catch (err) {
    console.error('[TASKS] Calendar range error:', err);
    sendInternalError(res, err);
  }
});

app.get('/api/tasks/board', requireAuth, rateLimit.tasks, async (req, res) => {
  try {
    const tasks = await taskStore.getTasksByStatus(req.user.id);
    res.json(tasks);
  } catch (err) {
    console.error('[TASKS] Board error:', err);
    sendInternalError(res, err);
  }
});

// --- Tasks CRUD ---
app.get('/api/tasks', requireAuth, rateLimit.tasks, async (req, res) => {
  try {
    const opts = {};
    if (req.query.status) opts.status = req.query.status;
    if (req.query.priority !== undefined) opts.priority = parseInt(req.query.priority, 10);
    if (req.query.search) opts.search = req.query.search;
    if (req.query.limit) opts.limit = parseInt(req.query.limit, 10);
    const tasks = await taskStore.getUserTasks(req.user.id, opts);
    res.json(tasks);
  } catch (err) {
    console.error('[TASKS] List error:', err);
    sendInternalError(res, err);
  }
});

app.post('/api/tasks', requireAuth, rateLimit.tasks, async (req, res) => {
  try {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const task = await taskStore.createTask(req.user.id, req.body);
    res.status(201).json(task);
  } catch (err) {
    console.error('[TASKS] Create error:', err);
    sendInternalError(res, err);
  }
});

app.get('/api/tasks/:taskId', requireAuth, rateLimit.tasks, async (req, res) => {
  try {
    if (!isSafeParamId(req.params.taskId)) {
      return res.status(400).json({ error: 'Invalid taskId' });
    }
    const task = await taskStore.getTask(req.params.taskId, req.user.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (err) {
    console.error('[TASKS] Get error:', err);
    sendInternalError(res, err);
  }
});

app.put('/api/tasks/:taskId', requireAuth, rateLimit.tasks, async (req, res) => {
  try {
    if (!isSafeParamId(req.params.taskId)) {
      return res.status(400).json({ error: 'Invalid taskId' });
    }
    const task = await taskStore.updateTask(req.params.taskId, req.user.id, req.body);
    res.json(task);
  } catch (err) {
    console.error('[TASKS] Update error:', err);
    sendInternalError(res, err);
  }
});

app.delete('/api/tasks/:taskId', requireAuth, rateLimit.tasks, async (req, res) => {
  try {
    if (!isSafeParamId(req.params.taskId)) {
      return res.status(400).json({ error: 'Invalid taskId' });
    }
    await taskStore.deleteTask(req.params.taskId, req.user.id);
    res.status(204).end();
  } catch (err) {
    console.error('[TASKS] Delete error:', err);
    sendInternalError(res, err);
  }
});

app.put('/api/tasks/:taskId/reorder', requireAuth, rateLimit.tasks, async (req, res) => {
  try {
    if (!isSafeParamId(req.params.taskId)) {
      return res.status(400).json({ error: 'Invalid taskId' });
    }
    const { newStatus, newPosition } = req.body;
    if (!newStatus || newPosition === undefined) {
      return res.status(400).json({ error: 'newStatus and newPosition required' });
    }
    await taskStore.reorderTask(req.user.id, req.params.taskId, newStatus, newPosition);
    res.json({ ok: true });
  } catch (err) {
    console.error('[TASKS] Reorder error:', err);
    sendInternalError(res, err);
  }
});

// --- Label assignments ---
app.post('/api/tasks/:taskId/labels/:labelId', requireAuth, rateLimit.tasks, async (req, res) => {
  try {
    if (!isSafeParamId(req.params.taskId) || !isSafeParamId(req.params.labelId)) {
      return res.status(400).json({ error: 'Invalid taskId or labelId' });
    }
    const assignment = await taskStore.assignLabel(req.params.taskId, req.params.labelId, req.user.id);
    res.status(201).json(assignment);
  } catch (err) {
    console.error('[TASKS] Assign label error:', err);
    sendInternalError(res, err);
  }
});

app.delete('/api/tasks/:taskId/labels/:labelId', requireAuth, rateLimit.tasks, async (req, res) => {
  try {
    if (!isSafeParamId(req.params.taskId) || !isSafeParamId(req.params.labelId)) {
      return res.status(400).json({ error: 'Invalid taskId or labelId' });
    }
    await taskStore.removeLabel(req.params.taskId, req.params.labelId, req.user.id);
    res.status(204).end();
  } catch (err) {
    console.error('[TASKS] Remove label error:', err);
    sendInternalError(res, err);
  }
});

// ==================== CHAT STREAMING ENDPOINT ====================
app.post('/api/chat', requireAuth, rateLimit.chat, async (req, res) => {
  const {
    message,
    chatId,
    provider: providerName = 'claude',
    model = null,
    agents
  } = req.body;

  const userId = getActorUserId(req);

  console.log('[CHAT] Request received:', message);
  console.log('[CHAT] Chat ID:', chatId);
  console.log('[CHAT] User:', userId);
  console.log('[CHAT] Provider:', providerName);
  console.log('[CHAT] Model:', model || '(default)');
  if (chatId && !isSafeParamId(chatId)) {
    return res.status(400).json({ error: 'Invalid chatId' });
  }

  const safeMessage = typeof message === 'string' ? message.trim() : '';
  if (!safeMessage) {
    return res.status(400).json({ error: 'Message is required' });
  }

  // Validate provider
  const availableProviders = getAvailableProviders();
  if (!availableProviders.includes(providerName.toLowerCase())) {
    return res.status(400).json({
      error: `Invalid provider: ${providerName}. Available: ${availableProviders.join(', ')}`
    });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Processing request...' })}\n\n`);

  const heartbeatInterval = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': heartbeat\n\n');
    }
  }, 15000);

  res.on('close', () => {
    clearInterval(heartbeatInterval);
  });

    try {
      // Persist chat + user message to Supabase (non-blocking for anonymous)
      if (isSupabaseConfigured() && !isAnonymousUserId(userId)) {
        try {
          await chatStore.createChat({ id: chatId, userId, title: safeMessage.substring(0, 60), provider: providerName, model });
          await chatStore.addMessage({ chatId, userId, role: 'user', content: safeMessage });
        } catch (dbErr) {
          // If chat ownership/auth checks fail, don't continue the stream.
          if (shouldFailDbWrite(dbErr)) {
            throw dbErr;
          }
          console.error('[CHAT] DB write error (non-fatal):', dbErr.message);
        }
      }

    // Get or create Composio session for this user (optional).
    const composioClient = ensureComposioClient();
    let composioSession = null;
    if (composioClient) {
      composioSession = getComposioSession(userId);
      if (!composioSession) {
        console.log('[COMPOSIO] Creating new session for user:', userId);
        res.write(`data: ${JSON.stringify({ type: 'status', message: 'Initializing session...' })}\n\n`);
        composioSession = await composioClient.create(userId);
        setComposioSession(userId, composioSession);
        console.log('[COMPOSIO] Session created with MCP URL:', composioSession.mcp.url);
      }
    }

    // Ensure Smithery connection is ready when key is set (populates defaultSmitheryMcpConfig)
    await getSmitheryMcpConfig();

    // Get the provider instance
    const provider = getProvider(providerName);

    // Build MCP servers config for Claude provider
    const mcpServers = buildMcpServers(composioSession);

    console.log('[CHAT] Using provider:', provider.name);
    console.log('[CHAT] All stored sessions:', Array.from(provider.sessions.entries()));

    // Accumulate assistant text for DB persistence
    let assistantText = '';
    let toolCallsAccumulated = [];

    // Build allowed tools list — include browser tools when browser is enabled
    const allowedTools = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'Skill', 'Task', 'TaskOutput'];
    if (browserMcpServer) {
      allowedTools.push(...BROWSER_TOOL_NAMES);
    }
    if (documentMcpServer) {
      allowedTools.push(...DOCUMENT_TOOL_NAMES);
    }

    // Fetch chat metadata for context
    let chatMetadata = {};
    if (isSupabaseConfigured() && chatId) {
      try {
        const chat = await chatStore.getChat(chatId, userId);
        chatMetadata = chat?.metadata || {};
      } catch (err) {
        console.warn('[CHAT] Failed to fetch chat metadata:', err.message);
      }
    }

    // Fetch direct content from external pinned resources (Notion, GDrive, YouTube)
    const externalContent = await fetchDirectExternalContext(chatMetadata, composioSession);
    if (externalContent) {
      chatMetadata.externalContent = externalContent;
    }

    // Build system prompt from user instructions + project context + external resources + plugin skills
    let systemPromptAppend = buildSystemPrompt(chatMetadata);
    if (pluginManager) {
      const pluginPrompt = pluginManager.getSystemPromptAdditions();
      if (pluginPrompt) {
        systemPromptAppend = systemPromptAppend
          ? systemPromptAppend + '\n\n' + pluginPrompt
          : pluginPrompt;
      }
    }

    // Merge plugin agent definitions with request-supplied agents
    let mergedAgents = agents || {};
    if (pluginManager) {
      const pluginAgents = pluginManager.getAgentDefinitions();
      if (Object.keys(pluginAgents).length > 0) {
        mergedAgents = { ...pluginAgents, ...mergedAgents };
      }
    }

    // Read permission settings
    const settingsData = readUserSettingsFile();
    const permissions = settingsData.permissions || { mode: 'bypassPermissions', allowedDirectories: [], fileDeleteConfirmation: true };

    // Stream responses from the provider
    try {
      for await (const chunk of provider.query({
        prompt: safeMessage,
        chatId,
        userId,
        mcpServers,
        model,
        allowedTools,
        maxTurns: 100,
        systemPromptAppend: systemPromptAppend || undefined,
        permissionMode: permissions.mode || 'bypassPermissions',
        allowedDirectories: permissions.allowedDirectories || [],
        agents: Object.keys(mergedAgents).length > 0 ? mergedAgents : undefined
      })) {
        // Accumulate text content
        if (chunk.type === 'text' && chunk.content) {
          assistantText += chunk.content;
        }

        // Track tool calls for metadata
        if (chunk.type === 'tool_use') {
          toolCallsAccumulated.push({
            name: chunk.name,
            id: chunk.id,
            timestamp: new Date().toISOString()
          });
        }

        // Persist session_id on session_init
        if (chunk.type === 'system_init' || chunk.type === 'session_init') {
          const sid = chunk.session_id || chunk.sessionId;
          if (sid && isSupabaseConfigured() && !isAnonymousUserId(userId)) {
            sessionStore.setProviderSession(chatId, providerName, sid, userId).catch(err => {
              console.error('[CHAT] Session persist error (non-fatal):', err.message);
            });
          }
        }

        if (chunk.type === 'tool_use') {
          console.log('[SSE] Sending tool_use:', chunk.name);
        }
        if (chunk.type === 'text') {
          console.log('[SSE] Sending text chunk, length:', chunk.content?.length || 0);
        }
        // Send chunk as SSE
        const data = `data: ${JSON.stringify(chunk)}\n\n`;
        res.write(data);
      }
    } catch (streamError) {
      console.error('[CHAT] Stream error during iteration:', streamError);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: streamError.message })}\n\n`);
      }
    }

    // Save assistant message to DB after stream completes + fire-and-forget embedding
    if (assistantText && isSupabaseConfigured() && !isAnonymousUserId(userId)) {
      const metadata = { provider: providerName, model };
      if (toolCallsAccumulated.length > 0) metadata.tool_calls = toolCallsAccumulated;
      chatStore.addMessage({ chatId, userId, role: 'assistant', content: assistantText, metadata })
        .then(msg => {
          if (msg && process.env.OPENAI_API_KEY) {
            embedMessage(msg.id, assistantText, userId).catch(err => {
              console.error('[CHAT] Embedding error (non-fatal):', err.message);
            });
          }
        })
        .catch(err => {
          console.error('[CHAT] Assistant message persist error (non-fatal):', err.message);
        });
    }

    clearInterval(heartbeatInterval);
    if (!res.writableEnded) {
      res.end();
    }
    console.log('[CHAT] Stream completed');
  } catch (error) {
    clearInterval(heartbeatInterval);
    console.error('[CHAT] Error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    res.end();
  }
});

// Abort endpoint to stop active queries
app.post('/api/abort', requireAuth, rateLimit.chat, async (req, res) => {
  const { chatId, provider: providerName = 'claude' } = req.body;

  if (!chatId || !isSafeParamId(chatId)) {
    return res.status(400).json({ error: 'chatId is required' });
  }

  console.log('[ABORT] Request to abort chatId:', chatId, 'provider:', providerName);

  try {
    const userId = getActorUserId(req);
    if (isSupabaseConfigured() && !isAnonymousUserId(userId)) {
      const ownership = await assertChatOwnedByUser(chatId, userId);
      if (!ownership.ok) {
        const status = ownership.code === 'forbidden' ? 403 : 404;
        return res.status(status).json({ error: 'Unauthorized to abort this chat' });
      }
    }

    const provider = getProvider(providerName);
    const aborted = provider.abort(chatId, userId);

    if (aborted) {
      console.log('[ABORT] Successfully aborted chatId:', chatId);
      res.json({ success: true, message: 'Query aborted' });
    } else {
      console.log('[ABORT] No active query found for chatId:', chatId);
      res.json({ success: false, message: 'No active query to abort' });
    }
  } catch (error) {
    console.error('[ABORT] Error:', error);
    sendInternalError(res, error);
  }
});

// Permission response endpoint — resolves pending permission requests from the UI
app.post('/api/permission-response', requireAuth, async (req, res) => {
  const { chatId, requestId, behavior, message: denyMessage } = req.body;

  if (!chatId || !isSafeParamId(chatId) || !requestId || !behavior) {
    return res.status(400).json({ error: 'chatId, requestId, and behavior are required' });
  }

  if (!['allow', 'deny'].includes(behavior)) {
    return res.status(400).json({ error: 'behavior must be "allow" or "deny"' });
  }

  console.log('[PERMISSION] Response for', requestId, ':', behavior);

  try {
    const userId = getActorUserId(req);
    if (isSupabaseConfigured() && !isAnonymousUserId(userId)) {
      const ownership = await assertChatOwnedByUser(chatId, userId);
      if (!ownership.ok) {
        const status = ownership.code === 'forbidden' ? 403 : 404;
        return res.status(status).json({ error: 'Unauthorized to resolve permission for this chat' });
      }
    }

    const provider = getProvider('claude');
    const decision = { behavior };
    if (behavior === 'deny' && denyMessage) {
      decision.message = denyMessage;
    }
    const resolved = provider.resolvePermission(chatId, requestId, decision, userId);

    if (resolved) {
      res.json({ success: true });
    } else {
      res.json({ success: false, message: 'No pending permission request found' });
    }
  } catch (error) {
    console.error('[PERMISSION] Error:', error);
    sendInternalError(res, error);
  }
});

// Get available providers endpoint
app.get('/api/providers', (_req, res) => {
  res.json({
    providers: getAvailableProviders(),
    default: 'claude'
  });
});

// Settings: get (masked keys + mcpServers)
app.get('/api/settings', requireAuth, rateLimit.settings, (_req, res) => {
  try {
    const data = readUserSettingsFile();
    res.json({
      apiKeys: {
        anthropic: maskKey(data.apiKeys.anthropic),
        composio: maskKey(data.apiKeys.composio),
        smithery: maskKey(data.apiKeys.smithery),
        dataforseoUsername: maskKey(data.apiKeys.dataforseoUsername),
        dataforseoPassword: maskKey(data.apiKeys.dataforseoPassword)
      },
      mcpServers: data.mcpServers,
      browser: data.browser || { enabled: false, mode: 'clawd', headless: false, backend: 'builtin', cdpPort: 9222 },
      instructions: data.instructions || { global: '', folders: [] },
      permissions: data.permissions || { mode: 'bypassPermissions', allowedDirectories: [], fileDeleteConfirmation: true },
      documents: data.documents || { outputDirectory: path.join(os.homedir(), 'Documents', 'generated') }
    });
  } catch (err) {
    console.error('[SETTINGS] GET error:', err);
    sendInternalError(res, err);
  }
});

// Settings: put (merge and persist; apply keys; clear Composio/Smithery caches when keys change)
app.put('/api/settings', requireAuth, rateLimit.settings, (req, res) => {
  try {
    const data = readUserSettingsFile();
    const body = req.body || {};
    const prevComposioKey = data.apiKeys.composio;
    const prevSmitheryKey = data.apiKeys.smithery;
    const prevDfsUser = data.apiKeys.dataforseoUsername;
    const prevDfsPass = data.apiKeys.dataforseoPassword;

    if (body.apiKeys && typeof body.apiKeys === 'object') {
      if (body.apiKeys.anthropic !== undefined) data.apiKeys.anthropic = body.apiKeys.anthropic ? String(body.apiKeys.anthropic).trim() : '';
      if (body.apiKeys.composio !== undefined) data.apiKeys.composio = body.apiKeys.composio ? String(body.apiKeys.composio).trim() : '';
      if (body.apiKeys.smithery !== undefined) data.apiKeys.smithery = body.apiKeys.smithery ? String(body.apiKeys.smithery).trim() : '';
      if (body.apiKeys.dataforseoUsername !== undefined) data.apiKeys.dataforseoUsername = body.apiKeys.dataforseoUsername ? String(body.apiKeys.dataforseoUsername).trim() : '';
      if (body.apiKeys.dataforseoPassword !== undefined) data.apiKeys.dataforseoPassword = body.apiKeys.dataforseoPassword ? String(body.apiKeys.dataforseoPassword).trim() : '';
    }
    if (body.mcpServers !== undefined) {
      if (!Array.isArray(body.mcpServers)) {
        return res.status(400).json({ error: 'mcpServers must be an array' });
      }
      data.mcpServers = body.mcpServers.map((entry, i) => {
        const id = entry.id || `mcp_${Date.now()}_${i}`;
        const name = (entry.name || 'unnamed').replace(/[^a-zA-Z0-9_\s-]/g, '').trim() || 'unnamed';
        const type = entry.type === 'local' ? 'local' : 'http';
        const out = { id, name, type };
        if (type === 'http') {
          out.url = entry.url ? String(entry.url).trim() : '';
          out.headers = entry.headers && typeof entry.headers === 'object' ? entry.headers : {};
        } else {
          out.command = entry.command ? String(entry.command).trim() : '';
          out.args = Array.isArray(entry.args) ? entry.args : [];
          out.environment = entry.environment && typeof entry.environment === 'object' ? entry.environment : {};
        }
        return out;
      });
    }

    // Handle browser settings
    if (body.browser && typeof body.browser === 'object') {
      if (!data.browser) data.browser = {};
      if (body.browser.enabled !== undefined) data.browser.enabled = !!body.browser.enabled;
      if (body.browser.mode !== undefined) data.browser.mode = ['clawd', 'chrome'].includes(body.browser.mode) ? body.browser.mode : 'clawd';
      if (body.browser.headless !== undefined) data.browser.headless = !!body.browser.headless;
      if (body.browser.backend !== undefined) data.browser.backend = ['builtin', 'agent-browser'].includes(body.browser.backend) ? body.browser.backend : 'builtin';
      if (body.browser.cdpPort !== undefined) data.browser.cdpPort = parseInt(body.browser.cdpPort) || 9222;
    }

    // Handle instructions
    if (body.instructions && typeof body.instructions === 'object') {
      if (!data.instructions) data.instructions = { global: '', folders: [] };
      if (body.instructions.global !== undefined) {
        data.instructions.global = String(body.instructions.global || '');
      }
      if (Array.isArray(body.instructions.folders)) {
        data.instructions.folders = body.instructions.folders
          .filter(f => f && typeof f === 'object' && f.path)
          .map(f => ({
            path: String(f.path).trim(),
            instructions: String(f.instructions || '').trim()
          }));
      }
    }

    // Handle permissions
    if (body.permissions && typeof body.permissions === 'object') {
      if (!data.permissions) data.permissions = { mode: 'bypassPermissions', allowedDirectories: [], fileDeleteConfirmation: true };
      if (body.permissions.mode !== undefined) {
        const validModes = ['bypassPermissions', 'default', 'plan', 'acceptEdits'];
        data.permissions.mode = validModes.includes(body.permissions.mode) ? body.permissions.mode : 'bypassPermissions';
      }
      if (Array.isArray(body.permissions.allowedDirectories)) {
        data.permissions.allowedDirectories = body.permissions.allowedDirectories
          .filter(d => typeof d === 'string' && d.trim())
          .map(d => d.trim());
      }
      if (body.permissions.fileDeleteConfirmation !== undefined) {
        data.permissions.fileDeleteConfirmation = !!body.permissions.fileDeleteConfirmation;
      }
    }

    // Handle documents settings
    if (body.documents && typeof body.documents === 'object') {
      if (!data.documents) data.documents = { outputDirectory: path.join(os.homedir(), 'Documents', 'generated') };
      if (body.documents.outputDirectory !== undefined) {
        data.documents.outputDirectory = String(body.documents.outputDirectory || '').trim() || path.join(os.homedir(), 'Documents', 'generated');
      }
    }

    saveUserSettings(data);

    // Re-initialize browser if browser settings changed
    if (body.browser) {
      initializeBrowser().catch(err => {
        console.error('[SETTINGS] Browser init error:', err.message);
      });
    }

    // Re-initialize documents if documents settings changed
    if (body.documents) {
      initializeDocuments();
    }

    // Apply API keys to process.env for next requests
    process.env.ANTHROPIC_API_KEY = data.apiKeys.anthropic || '';
    process.env.COMPOSIO_API_KEY = data.apiKeys.composio || '';
    process.env.SMITHERY_API_KEY = data.apiKeys.smithery || '';
    process.env.DATAFORSEO_USERNAME = data.apiKeys.dataforseoUsername || '';
    process.env.DATAFORSEO_PASSWORD = data.apiKeys.dataforseoPassword || '';
    if (prevComposioKey !== data.apiKeys.composio) {
      composioSessions.clear();
      defaultComposioSession = null;
      ensureComposioClient();
      console.log('[SETTINGS] Composio key changed; cleared sessions');
    }
    if (prevSmitheryKey !== data.apiKeys.smithery) {
      defaultSmitheryMcpConfig = null;
      console.log('[SETTINGS] Smithery key changed; cleared connection cache');
    }
    if (prevDfsUser !== data.apiKeys.dataforseoUsername || prevDfsPass !== data.apiKeys.dataforseoPassword) {
      dataforseoMcpConfig = null;
      console.log('[SETTINGS] DataForSEO credentials changed; cleared MCP config cache');
    }

    res.json({
      apiKeys: {
        anthropic: maskKey(data.apiKeys.anthropic),
        composio: maskKey(data.apiKeys.composio),
        smithery: maskKey(data.apiKeys.smithery),
        dataforseoUsername: maskKey(data.apiKeys.dataforseoUsername),
        dataforseoPassword: maskKey(data.apiKeys.dataforseoPassword)
      },
      mcpServers: data.mcpServers,
      browser: data.browser || { enabled: false, mode: 'clawd', headless: false, backend: 'builtin', cdpPort: 9222 },
      instructions: data.instructions || { global: '', folders: [] },
      permissions: data.permissions || { mode: 'bypassPermissions', allowedDirectories: [], fileDeleteConfirmation: true },
      documents: data.documents || { outputDirectory: path.join(os.homedir(), 'Documents', 'generated') }
    });
  } catch (err) {
    console.error('[SETTINGS] PUT error:', err);
    sendInternalError(res, err);
  }
});

// ==================== BROWSER AUTOMATION ====================

/**
 * Initialize browser automation based on user settings.
 * Builtin: creates BrowserServer + SDK MCP server (lazy init, browser launches on first tool call).
 * Agent-browser: registers as a local MCP server (spawned as subprocess).
 */
async function initializeBrowser() {
  const data = readUserSettingsFile();
  const browserSettings = data.browser || {};

  // Stop existing browser if running
  if (browserServer) {
    try { await browserServer.stop(); } catch (_) {}
    browserServer = null;
    browserMcpServer = null;
  }

  if (!browserSettings.enabled) {
    console.log('[BROWSER] Browser automation disabled');
    return;
  }

  if (browserSettings.backend === 'agent-browser') {
    // Agent-browser: register as local MCP server
    browserMcpServer = {
      type: 'local',
      command: 'agent-browser',
      args: ['mcp']
    };
    console.log('[BROWSER] Registered agent-browser as local MCP server');
  } else {
    // Builtin: create BrowserServer + SDK MCP server
    const mode = browserSettings.mode || 'clawd';
    const headless = browserSettings.headless ?? false;
    const cdpPort = browserSettings.cdpPort || 9222;

    browserServer = new BrowserServer({
      mode,
      clawd: { headless, userDataDir: '~/.open-claude-cowork-browser' },
      chrome: { cdpPort }
    });

    browserMcpServer = createBrowserMcpServer(browserServer);
    console.log('[BROWSER] Built-in browser automation ready (lazy init, mode:', mode + ')');
  }

}

// ==================== DOCUMENT GENERATION ====================

/**
 * Initialize document generation MCP server based on user settings.
 */
function initializeDocuments() {
  const data = readUserSettingsFile();
  const docSettings = data.documents || {};
  const outputDir = docSettings.outputDirectory || path.join(os.homedir(), 'Documents', 'generated');

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  documentMcpServer = createDocumentMcpServer(outputDir);
  console.log('[DOCUMENTS] Document generation ready, output:', outputDir);

}

// List generated documents
app.get('/api/documents', requireAuth, (_req, res) => {
  try {
    const data = readUserSettingsFile();
    const outputDir = data.documents?.outputDirectory || path.join(os.homedir(), 'Documents', 'generated');
    if (!fs.existsSync(outputDir)) {
      return res.json({ files: [], outputDirectory: outputDir });
    }
    const files = fs.readdirSync(outputDir)
      .filter(name => /\.(xlsx|pptx|pdf)$/i.test(name))
      .map(name => {
        const fullPath = path.join(outputDir, name);
        const stats = fs.statSync(fullPath);
        const ext = path.extname(name).toLowerCase();
        const typeMap = { '.xlsx': 'excel', '.pptx': 'powerpoint', '.pdf': 'pdf' };
        return { name, size: stats.size, modified: stats.mtime.toISOString(), type: typeMap[ext] || 'unknown' };
      });
    res.json({ files, outputDirectory: outputDir });
  } catch (err) {
    sendInternalError(res, err);
  }
});

// Download a generated document
app.get('/api/documents/:filename', requireAuth, (req, res) => {
  try {
    const data = readUserSettingsFile();
    const outputDir = data.documents?.outputDirectory || path.join(os.homedir(), 'Documents', 'generated');
    const safeName = path.basename(req.params.filename); // prevent path traversal
    const filePath = path.join(outputDir, safeName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    res.download(filePath, safeName);
  } catch (err) {
    sendInternalError(res, err);
  }
});

// ==================== PLUGIN SYSTEM ====================

/** Initialize the plugin manager. */
function initializePlugins() {
  try {
    pluginManager = new PluginManager({
      readSettings: readUserSettingsFile,
      writeSettings: saveUserSettings
    });
    const plugins = pluginManager.listPlugins();
    const enabled = plugins.filter(p => p.enabled);
    console.log(`[PLUGINS] Initialized — ${plugins.length} installed, ${enabled.length} enabled`);
  } catch (err) {
    console.error('[PLUGINS] Initialization failed:', err.message);
  }
}

// List all plugins with status
app.get('/api/plugins', requireAuth, (_req, res) => {
  if (!pluginManager) return res.json({ plugins: [] });
  try {
    res.json({ plugins: pluginManager.listPlugins() });
  } catch (err) {
    sendInternalError(res, err);
  }
});

// Enable a plugin
app.post('/api/plugins/:name/enable', requireAuth, requireAdmin, (req, res) => {
  if (!pluginManager) return res.status(503).json({ error: 'Plugin system not initialized' });
  try {
    pluginManager.enablePlugin(req.params.name);
    res.json({ success: true });
  } catch (err) {
    sendInternalError(res, err);
  }
});

// Disable a plugin
app.post('/api/plugins/:name/disable', requireAuth, requireAdmin, (req, res) => {
  if (!pluginManager) return res.status(503).json({ error: 'Plugin system not initialized' });
  try {
    pluginManager.disablePlugin(req.params.name);
    res.json({ success: true });
  } catch (err) {
    sendInternalError(res, err);
  }
});

// Install a plugin from a git URL
app.post('/api/plugins/install', requireAuth, requireAdmin, (req, res) => {
  if (!pluginManager) return res.status(503).json({ error: 'Plugin system not initialized' });
  const { url, dirName } = req.body;
  if (!url) return res.status(400).json({ error: 'Git URL is required' });
  try {
    const result = pluginManager.installPlugin(url, dirName);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Remove an installed plugin
app.delete('/api/plugins/:name', requireAuth, requireAdmin, (req, res) => {
  if (!pluginManager) return res.status(503).json({ error: 'Plugin system not initialized' });
  try {
    pluginManager.removePlugin(req.params.name);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Browser status endpoint
app.get('/api/browser/status', requireAuth, (_req, res) => {
  const data = readUserSettingsFile();
  const settings = data.browser || {};
  res.json({
    enabled: settings.enabled || false,
    backend: settings.backend || 'builtin',
    mode: settings.mode || 'clawd',
    headless: settings.headless || false,
    running: browserServer ? browserServer.getStatus().running : false,
    currentUrl: browserServer ? browserServer.getStatus().currentUrl : null
  });
});

// API 404 fallback
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

// Serve web UI (renderer) for browser deployment (e.g. Coolify)
if (fs.existsSync(rendererPath)) {
  app.use(express.static(rendererPath));
}

if (process.env.NODE_ENV !== 'test') {
  await initializeProviders();
  await initializeComposioSession();
  await initializeSmitheryConnection();
  scheduleComposioSessionCleanup();
  initializeDataforseoConfig();
  await initializeBrowser();
  initializeDocuments();
  initializePlugins();

  // Start Supabase cron jobs + job scheduler if configured
  if (isSupabaseConfigured()) {
    setupCronJobs();
    startEmbeddingCron();
    startScheduler().catch(err => console.error('[SCHEDULER] Startup error:', err.message));
  }

  // Start server and keep reference to prevent garbage collection
  const server = app.listen(PORT, () => {
    console.log(`\n✓ Backend server running on http://localhost:${PORT}`);
    console.log(`✓ Chat endpoint: POST http://localhost:${PORT}/api/chat`);
    console.log(`✓ Providers endpoint: GET http://localhost:${PORT}/api/providers`);
    console.log(`✓ Health check: GET http://localhost:${PORT}/api/health`);
    console.log(`✓ Available providers: ${getAvailableProviders().join(', ')}\n`);
  });

  // Keep the process alive
  server.on('error', (err) => {
    console.error('Server error:', err);
  });

  const handleShutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n${signal} received. Shutting down server...`);
    stopScheduler();

    if (composioSessionCleanupTimer) {
      clearInterval(composioSessionCleanupTimer);
      composioSessionCleanupTimer = null;
    }

    if (browserServer) {
      try {
        await browserServer.stop();
      } catch (_) {
        // ignore browser shutdown failures
      }
    }

    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 5000);
      server.close(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
    process.exit(0);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
}

export { buildSystemPrompt, fetchDirectExternalContext, readUserSettingsFile };

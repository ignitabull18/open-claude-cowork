import express from 'express';
import cors from 'cors';
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
import { searchSimilar, embedMessage } from './supabase/embeddings.js';
import { setupCronJobs, startEmbeddingCron } from './supabase/cron.js';
import * as reportStore from './supabase/report-store.js';
import * as jobStore from './supabase/job-store.js';
import { startScheduler, triggerJob } from './job-scheduler.js';
import { BrowserServer, createBrowserMcpServer } from './browser/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const USER_SETTINGS_PATH = path.join(__dirname, 'user-settings.json');

/** Load user-settings from disk; apply API keys to process.env so SDKs use them. */
function loadUserSettings() {
  let data = { apiKeys: {}, mcpServers: [] };
  try {
    if (fs.existsSync(USER_SETTINGS_PATH)) {
      const raw = fs.readFileSync(USER_SETTINGS_PATH, 'utf8');
      data = JSON.parse(raw);
      if (!data.apiKeys) data.apiKeys = {};
      if (!Array.isArray(data.mcpServers)) data.mcpServers = [];
    }
  } catch (err) {
    console.warn('[SETTINGS] Could not load user-settings:', err.message);
  }
  if (data.apiKeys.anthropic) {
    process.env.ANTHROPIC_API_KEY = data.apiKeys.anthropic;
  }
  if (data.apiKeys.composio) {
    process.env.COMPOSIO_API_KEY = data.apiKeys.composio;
  }
  if (data.apiKeys.smithery) {
    process.env.SMITHERY_API_KEY = data.apiKeys.smithery;
  }
  if (data.apiKeys.dataforseoUsername) {
    process.env.DATAFORSEO_USERNAME = data.apiKeys.dataforseoUsername;
  }
  if (data.apiKeys.dataforseoPassword) {
    process.env.DATAFORSEO_PASSWORD = data.apiKeys.dataforseoPassword;
  }
  return data;
}

/** Save user-settings to disk. */
function saveUserSettings(data) {
  const dir = path.dirname(USER_SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(USER_SETTINGS_PATH, JSON.stringify(data, null, 2), 'utf8');
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
loadUserSettings();

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize Composio (uses process.env.COMPOSIO_API_KEY)
const composio = new Composio();

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
  const defaultUserId = 'default-user';
  console.log('[COMPOSIO] Pre-initializing session for:', defaultUserId);
  try {
    defaultComposioSession = await composio.create(defaultUserId);
    composioSessions.set(defaultUserId, defaultComposioSession);
    console.log('[COMPOSIO] Session ready with MCP URL:', defaultComposioSession.mcp.url);

    const mcpServers = buildMcpServers(defaultComposioSession);
    updateOpencodeConfig(mcpServers);
    console.log('[OPENCODE] Updated opencode.json with MCP config');
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
      if (defaultComposioSession) {
        const mcpServers = buildMcpServers(defaultComposioSession);
        updateOpencodeConfig(mcpServers);
      }
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
    if (defaultComposioSession) {
      updateOpencodeConfig(buildMcpServers(defaultComposioSession));
    }
  }
}

/**
 * Read user-settings from disk (no env application). Returns { apiKeys, mcpServers }.
 */
function readUserSettingsFile() {
  let data = { apiKeys: {}, mcpServers: [] };
  try {
    if (fs.existsSync(USER_SETTINGS_PATH)) {
      const raw = fs.readFileSync(USER_SETTINGS_PATH, 'utf8');
      data = JSON.parse(raw);
      if (!data.apiKeys) data.apiKeys = {};
      if (!Array.isArray(data.mcpServers)) data.mcpServers = [];
    }
  } catch (_) {
    // ignore
  }
  // Ensure browser settings have defaults
  if (!data.browser) {
    data.browser = { enabled: false, mode: 'clawd', headless: false, backend: 'builtin', cdpPort: 9222 };
  }
  return data;
}

/**
 * Build the MCP servers config used by both Claude and Opencode providers.
 * Merges Composio (from session), Smithery (when key and connection exist), and user-defined MCP from user-settings.
 */
function buildMcpServers(composioSession) {
  const mcpServers = {
    composio: {
      type: 'http',
      url: composioSession.mcp.url,
      headers: composioSession.mcp.headers
    }
  };

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

  // Add DataForSEO MCP servers (official 9-API + custom 4-API)
  const dfsConfig = getDataforseoMcpConfig();
  if (dfsConfig) {
    mcpServers.dataforseo = { type: 'local', ...dfsConfig.official };
    mcpServers.dataforseo_extra = { type: 'local', ...dfsConfig.extra };
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

/** Write full MCP config to opencode.json (Opencode reads this file). */
function updateOpencodeConfig(mcpServers) {
  const opencodeConfigPath = path.join(__dirname, 'opencode.json');
  const mcp = {};
  for (const [name, config] of Object.entries(mcpServers)) {
    // Skip SDK MCP servers (in-process, no type/url/command fields) — they only work with Claude provider
    if (!config.type && !config.url && !config.command) continue;
    if (config.type === 'http' || config.type === 'remote') {
      mcp[name] = { type: 'remote', url: config.url, headers: config.headers || {} };
    } else if (config.type === 'local') {
      mcp[name] = {
        type: 'local',
        command: config.command,
        args: config.args,
        environment: config.environment || {}
      };
    }
  }
  fs.writeFileSync(opencodeConfigPath, JSON.stringify({ mcp }, null, 2));
}

// Middleware
app.use(cors());
app.use(express.json());

// Helper: check if Supabase is configured
const isSupabaseConfigured = () => !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

// ==================== SUPABASE CONFIG ENDPOINT ====================
app.get('/api/config', (_req, res) => {
  res.json(getPublicConfig());
});

// ==================== CHAT CRUD ENDPOINTS ====================
app.get('/api/chats', requireAuth, async (req, res) => {
  try {
    const chats = await chatStore.getUserChats(req.user.id);
    res.json({ chats });
  } catch (err) {
    console.error('[CHATS] List error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chats/:chatId', requireAuth, async (req, res) => {
  try {
    const chat = await chatStore.getChat(req.params.chatId, req.user.id);
    res.json(chat);
  } catch (err) {
    if (err.code === 'PGRST116') return res.status(404).json({ error: 'Chat not found' });
    console.error('[CHATS] Get error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chats', requireAuth, async (req, res) => {
  try {
    const { id, title, provider, model } = req.body;
    const chat = await chatStore.createChat({ id, userId: req.user.id, title, provider, model });
    res.json(chat);
  } catch (err) {
    console.error('[CHATS] Create error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/chats/:chatId', requireAuth, async (req, res) => {
  try {
    await chatStore.deleteChat(req.params.chatId, req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[CHATS] Delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/chats/:chatId', requireAuth, async (req, res) => {
  try {
    const { title } = req.body;
    const chat = await chatStore.updateChatTitle(req.params.chatId, req.user.id, title);
    res.json(chat);
  } catch (err) {
    console.error('[CHATS] Update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== MESSAGES ENDPOINT ====================
app.post('/api/messages', requireAuth, async (req, res) => {
  try {
    const { chatId, role, content, html, metadata } = req.body;
    const msg = await chatStore.addMessage({ chatId, userId: req.user.id, role, content, html, metadata });
    res.json(msg);
  } catch (err) {
    console.error('[MESSAGES] Create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== PROFILE ENDPOINTS ====================
app.get('/api/profile', requireAuth, async (req, res) => {
  try {
    const profile = await chatStore.getProfile(req.user.id);
    res.json(profile || {});
  } catch (err) {
    console.error('[PROFILE] Get error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/profile', requireAuth, async (req, res) => {
  try {
    const profile = await chatStore.updateProfile(req.user.id, req.body);
    res.json(profile);
  } catch (err) {
    console.error('[PROFILE] Update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== FILE UPLOAD/DOWNLOAD ====================
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB max

app.post('/api/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'File storage requires Supabase' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  try {
    const chatId = req.body.chatId || null;
    const attachment = await storage.uploadFile(req.user.id, req.file, chatId);
    res.json(attachment);
  } catch (err) {
    console.error('[UPLOAD] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/files/:attachmentId/url', requireAuth, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'File storage requires Supabase' });

  try {
    const url = await storage.getFileUrl(req.params.attachmentId, req.user.id);
    res.json({ url });
  } catch (err) {
    console.error('[FILES] URL error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== SEARCH ENDPOINT ====================
app.post('/api/search', requireAuth, async (req, res) => {
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// ==================== REPORT ENDPOINTS ====================

app.get('/api/reports/summary', requireAuth, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Reports require Supabase' });
  try {
    const data = await reportStore.getSummary(req.user.id);
    res.json(data);
  } catch (err) {
    console.error('[REPORTS] Summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/daily-messages', requireAuth, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Reports require Supabase' });
  try {
    const days = parseInt(req.query.days) || 30;
    const data = await reportStore.getDailyMessages(req.user.id, days);
    res.json(data);
  } catch (err) {
    console.error('[REPORTS] Daily messages error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/provider-usage', requireAuth, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Reports require Supabase' });
  try {
    const days = parseInt(req.query.days) || 30;
    const data = await reportStore.getProviderUsage(req.user.id, days);
    res.json(data);
  } catch (err) {
    console.error('[REPORTS] Provider usage error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/tool-usage', requireAuth, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Reports require Supabase' });
  try {
    const days = parseInt(req.query.days) || 30;
    const data = await reportStore.getToolUsage(req.user.id, days);
    res.json(data);
  } catch (err) {
    console.error('[REPORTS] Tool usage error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reports/query', requireAuth, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Reports require Supabase' });
  try {
    const config = req.body;
    if (!config || !config.source) return res.status(400).json({ error: 'Report config with source is required' });
    const data = await reportStore.executeCustomQuery(req.user.id, config);
    res.json(data);
  } catch (err) {
    console.error('[REPORTS] Custom query error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Saved reports CRUD
app.get('/api/reports/saved', requireAuth, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Reports require Supabase' });
  try {
    const reports = await reportStore.getSavedReports(req.user.id);
    res.json({ reports });
  } catch (err) {
    console.error('[REPORTS] List saved error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reports/saved', requireAuth, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Reports require Supabase' });
  try {
    const { name, description, reportConfig } = req.body;
    if (!name || !reportConfig) return res.status(400).json({ error: 'name and reportConfig are required' });
    const report = await reportStore.createSavedReport(req.user.id, { name, description, reportConfig });
    res.json(report);
  } catch (err) {
    console.error('[REPORTS] Create saved error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/saved/:reportId', requireAuth, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Reports require Supabase' });
  try {
    const report = await reportStore.getSavedReport(req.params.reportId, req.user.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json(report);
  } catch (err) {
    if (err.code === 'PGRST116') return res.status(404).json({ error: 'Report not found' });
    console.error('[REPORTS] Get saved error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/reports/saved/:reportId', requireAuth, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Reports require Supabase' });
  try {
    const report = await reportStore.updateSavedReport(req.params.reportId, req.user.id, req.body);
    res.json(report);
  } catch (err) {
    console.error('[REPORTS] Update saved error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/reports/saved/:reportId', requireAuth, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Reports require Supabase' });
  try {
    await reportStore.deleteSavedReport(req.params.reportId, req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[REPORTS] Delete saved error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reports/saved/:reportId/run', requireAuth, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Reports require Supabase' });
  try {
    const report = await reportStore.getSavedReport(req.params.reportId, req.user.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    const result = await reportStore.executeCustomQuery(req.user.id, report.report_config);
    await reportStore.updateReportResult(req.params.reportId, result);
    res.json({ result });
  } catch (err) {
    console.error('[REPORTS] Run saved error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== JOB ENDPOINTS ====================

app.get('/api/jobs', requireAuth, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Jobs require Supabase' });
  try {
    const jobs = await jobStore.getUserJobs(req.user.id);
    res.json({ jobs });
  } catch (err) {
    console.error('[JOBS] List error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/jobs', requireAuth, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Jobs require Supabase' });
  try {
    const job = await jobStore.createJob(req.user.id, req.body);
    res.json(job);
  } catch (err) {
    console.error('[JOBS] Create error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/jobs/:jobId', requireAuth, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Jobs require Supabase' });
  try {
    const job = await jobStore.getJob(req.params.jobId, req.user.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (err) {
    if (err.code === 'PGRST116') return res.status(404).json({ error: 'Job not found' });
    console.error('[JOBS] Get error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/jobs/:jobId', requireAuth, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Jobs require Supabase' });
  try {
    const job = await jobStore.updateJob(req.params.jobId, req.user.id, req.body);
    res.json(job);
  } catch (err) {
    console.error('[JOBS] Update error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/jobs/:jobId', requireAuth, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Jobs require Supabase' });
  try {
    await jobStore.deleteJob(req.params.jobId, req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[JOBS] Delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/jobs/:jobId/executions', requireAuth, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Jobs require Supabase' });
  try {
    const limit = parseInt(req.query.limit) || 10;
    const executions = await jobStore.getJobExecutions(req.params.jobId, req.user.id, { limit });
    res.json({ executions });
  } catch (err) {
    console.error('[JOBS] Executions error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/jobs/:jobId/run', requireAuth, async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Jobs require Supabase' });
  try {
    await triggerJob(req.params.jobId, req.user.id);
    const job = await jobStore.getJob(req.params.jobId, req.user.id);
    res.json(job);
  } catch (err) {
    console.error('[JOBS] Run error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== CHAT STREAMING ENDPOINT ====================
app.post('/api/chat', requireAuth, async (req, res) => {
  const {
    message,
    chatId,
    provider: providerName = 'claude',
    model = null
  } = req.body;

  const userId = req.user.id;

  console.log('[CHAT] Request received:', message);
  console.log('[CHAT] Chat ID:', chatId);
  console.log('[CHAT] User:', userId);
  console.log('[CHAT] Provider:', providerName);
  console.log('[CHAT] Model:', model || '(default)');

  if (!message) {
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
    if (isSupabaseConfigured() && userId !== 'anonymous') {
      try {
        await chatStore.createChat({ id: chatId, userId, title: message.substring(0, 60), provider: providerName, model });
        await chatStore.addMessage({ chatId, userId, role: 'user', content: message });
      } catch (dbErr) {
        console.error('[CHAT] DB write error (non-fatal):', dbErr.message);
      }
    }

    // Get or create Composio session for this user
    let composioSession = composioSessions.get(userId);
    if (!composioSession) {
      console.log('[COMPOSIO] Creating new session for user:', userId);
      res.write(`data: ${JSON.stringify({ type: 'status', message: 'Initializing session...' })}\n\n`);
      composioSession = await composio.create(userId);
      composioSessions.set(userId, composioSession);
      console.log('[COMPOSIO] Session created with MCP URL:', composioSession.mcp.url);

      const mcpServers = buildMcpServers(composioSession);
      updateOpencodeConfig(mcpServers);
      console.log('[OPENCODE] Updated opencode.json with MCP config');
    }

    // Ensure Smithery connection is ready when key is set (populates defaultSmitheryMcpConfig)
    await getSmitheryMcpConfig();

    // Get the provider instance
    const provider = getProvider(providerName);

    // Build MCP servers config - passed to Claude; Opencode reads from opencode.json
    const mcpServers = buildMcpServers(composioSession);
    updateOpencodeConfig(mcpServers);

    console.log('[CHAT] Using provider:', provider.name);
    console.log('[CHAT] All stored sessions:', Array.from(provider.sessions.entries()));

    // Accumulate assistant text for DB persistence
    let assistantText = '';
    let toolCallsAccumulated = [];

    // Build allowed tools list — include browser tools when browser is enabled
    const allowedTools = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'Skill'];
    if (browserMcpServer) {
      allowedTools.push(...BROWSER_TOOL_NAMES);
    }

    // Stream responses from the provider
    try {
      for await (const chunk of provider.query({
        prompt: message,
        chatId,
        userId,
        mcpServers,
        model,
        allowedTools,
        maxTurns: 100
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
          if (sid && isSupabaseConfigured() && userId !== 'anonymous') {
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
    if (assistantText && isSupabaseConfigured() && userId !== 'anonymous') {
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
app.post('/api/abort', requireAuth, (req, res) => {
  const { chatId, provider: providerName = 'claude' } = req.body;

  if (!chatId) {
    return res.status(400).json({ error: 'chatId is required' });
  }

  console.log('[ABORT] Request to abort chatId:', chatId, 'provider:', providerName);

  try {
    const provider = getProvider(providerName);
    const aborted = provider.abort(chatId);

    if (aborted) {
      console.log('[ABORT] Successfully aborted chatId:', chatId);
      res.json({ success: true, message: 'Query aborted' });
    } else {
      console.log('[ABORT] No active query found for chatId:', chatId);
      res.json({ success: false, message: 'No active query to abort' });
    }
  } catch (error) {
    console.error('[ABORT] Error:', error);
    res.status(500).json({ error: error.message });
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
app.get('/api/settings', (_req, res) => {
  try {
    const data = readUserSettingsFile();
    res.json({
      apiKeys: {
        anthropic: maskKey(data.apiKeys.anthropic),
        composio: maskKey(data.apiKeys.composio),
        smithery: maskKey(data.apiKeys.smithery)
      },
      mcpServers: data.mcpServers,
      browser: data.browser || { enabled: false, mode: 'clawd', headless: false, backend: 'builtin', cdpPort: 9222 }
    });
  } catch (err) {
    console.error('[SETTINGS] GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Settings: put (merge and persist; apply keys; clear Composio/Smithery caches when keys change)
app.put('/api/settings', (req, res) => {
  try {
    const data = readUserSettingsFile();
    const body = req.body || {};
    const prevComposioKey = data.apiKeys.composio;
    const prevSmitheryKey = data.apiKeys.smithery;

    if (body.apiKeys && typeof body.apiKeys === 'object') {
      if (body.apiKeys.anthropic !== undefined) data.apiKeys.anthropic = body.apiKeys.anthropic ? String(body.apiKeys.anthropic).trim() : '';
      if (body.apiKeys.composio !== undefined) data.apiKeys.composio = body.apiKeys.composio ? String(body.apiKeys.composio).trim() : '';
      if (body.apiKeys.smithery !== undefined) data.apiKeys.smithery = body.apiKeys.smithery ? String(body.apiKeys.smithery).trim() : '';
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

    saveUserSettings(data);

    // Re-initialize browser if browser settings changed
    if (body.browser) {
      initializeBrowser().catch(err => {
        console.error('[SETTINGS] Browser init error:', err.message);
      });
    }

    // Apply API keys to process.env for next requests
    if (data.apiKeys.anthropic) process.env.ANTHROPIC_API_KEY = data.apiKeys.anthropic;
    if (data.apiKeys.composio) process.env.COMPOSIO_API_KEY = data.apiKeys.composio;
    if (data.apiKeys.smithery) process.env.SMITHERY_API_KEY = data.apiKeys.smithery;
    if (prevComposioKey !== data.apiKeys.composio) {
      composioSessions.clear();
      defaultComposioSession = null;
      console.log('[SETTINGS] Composio key changed; cleared sessions');
    }
    if (prevSmitheryKey !== data.apiKeys.smithery) {
      defaultSmitheryMcpConfig = null;
      console.log('[SETTINGS] Smithery key changed; cleared connection cache');
    }

    res.json({
      apiKeys: {
        anthropic: maskKey(data.apiKeys.anthropic),
        composio: maskKey(data.apiKeys.composio),
        smithery: maskKey(data.apiKeys.smithery)
      },
      mcpServers: data.mcpServers,
      browser: data.browser || { enabled: false, mode: 'clawd', headless: false, backend: 'builtin', cdpPort: 9222 }
    });
  } catch (err) {
    console.error('[SETTINGS] PUT error:', err);
    res.status(500).json({ error: err.message });
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

  // Refresh MCP config if Composio session exists
  if (defaultComposioSession) {
    const mcpServers = buildMcpServers(defaultComposioSession);
    updateOpencodeConfig(mcpServers);
  }
}

// Browser status endpoint
app.get('/api/browser/status', (_req, res) => {
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

// Health check endpoint
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    providers: getAvailableProviders()
  });
});

// Serve web UI (renderer) for browser deployment (e.g. Coolify)
const rendererPath = path.join(__dirname, '..', 'renderer');
if (fs.existsSync(rendererPath)) {
  app.use(express.static(rendererPath));
  app.get('/', (_req, res) => res.sendFile(path.join(rendererPath, 'index.html')));
}

await initializeProviders();
await initializeComposioSession();
await initializeSmitheryConnection();
await initializeBrowser();

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

// Prevent the process from exiting
process.on('SIGINT', async () => {
  console.log('\nShutting down server...');
  if (browserServer) {
    try { await browserServer.stop(); } catch (_) {}
  }
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

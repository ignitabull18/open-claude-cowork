import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';
import { Composio } from '@composio/core';
import { getProvider, getAvailableProviders, initializeProviders } from './providers/index.js';
import multer from 'multer';
import { requireAuth } from './supabase/auth-middleware.js';
import { getPublicConfig } from './supabase/client.js';
import * as chatStore from './supabase/chat-store.js';
import * as sessionStore from './supabase/session-store.js';
import * as storage from './supabase/storage.js';
import { searchSimilar, embedMessage } from './supabase/embeddings.js';
import { setupCronJobs, startEmbeddingCron } from './supabase/cron.js';

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

/** Sanitize MCP server name for use as object key; must not be 'composio' or 'smithery'. */
function sanitizeMcpName(name, id) {
  const s = (name || id || 'unnamed').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64) || 'mcp';
  if (s === 'composio') return `user_${id || 'mcp'}`;
  if (s === 'smithery') return `user_${id || 'mcp'}_s`;
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

    // Stream responses from the provider
    try {
      for await (const chunk of provider.query({
        prompt: message,
        chatId,
        userId,
        mcpServers,
        model,
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'Skill'],
        maxTurns: 100
      })) {
        // Accumulate text content
        if (chunk.type === 'text' && chunk.content) {
          assistantText += chunk.content;
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
      chatStore.addMessage({ chatId, userId, role: 'assistant', content: assistantText })
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
      mcpServers: data.mcpServers
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

    saveUserSettings(data);

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
      mcpServers: data.mcpServers
    });
  } catch (err) {
    console.error('[SETTINGS] PUT error:', err);
    res.status(500).json({ error: err.message });
  }
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

// Start Supabase cron jobs if configured
if (isSupabaseConfigured()) {
  setupCronJobs();
  startEmbeddingCron();
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
process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

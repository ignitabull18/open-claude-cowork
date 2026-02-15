import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Plugins live at project_root/plugins/
const PLUGINS_DIR = path.resolve(__dirname, '..', '..', 'plugins');

/**
 * Manages plugin discovery, installation, and configuration.
 * Plugins follow the Anthropic .claude-plugin format:
 *   plugins/<name>/.claude-plugin/plugin.json  — manifest
 *   plugins/<name>/.mcp.json                   — MCP tool connections
 *   plugins/<name>/commands/                   — slash commands (markdown)
 *   plugins/<name>/skills/                     — domain knowledge (markdown)
 */
export class PluginManager {
  /**
   * @param {Object} opts
   * @param {Function} opts.readSettings  — returns user-settings object
   * @param {Function} opts.writeSettings — persists user-settings object
   */
  constructor({ readSettings, writeSettings }) {
    this._readSettings = readSettings;
    this._writeSettings = writeSettings;
    // Ensure plugins directory exists
    if (!fs.existsSync(PLUGINS_DIR)) {
      fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    }
  }

  // ── Discovery ───────────────────────────────────────

  /**
   * Scan the plugins/ directory for installed plugins.
   * Returns an array of { name, manifest, enabled } objects.
   */
  discover() {
    const results = [];
    if (!fs.existsSync(PLUGINS_DIR)) return results;

    for (const entry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = this._readManifest(entry.name);
      if (!manifest) continue;
      results.push({
        name: manifest.name || entry.name,
        dirName: entry.name,
        manifest,
        enabled: this._isEnabled(manifest.name || entry.name)
      });
    }
    return results;
  }

  /**
   * List all plugins with their enabled/disabled status.
   */
  listPlugins() {
    return this.discover().map(p => ({
      name: p.name,
      dirName: p.dirName,
      version: p.manifest.version || '0.0.0',
      author: p.manifest.author || 'Unknown',
      description: p.manifest.description || '',
      icon: p.manifest.icon || 'puzzle',
      category: p.manifest.category || 'general',
      enabled: p.enabled,
      agents: p.manifest.agents ? Object.keys(p.manifest.agents) : [],
      hasMcp: fs.existsSync(path.join(PLUGINS_DIR, p.dirName, '.mcp.json')),
      hasSkills: fs.existsSync(path.join(PLUGINS_DIR, p.dirName, 'skills')),
      hasCommands: fs.existsSync(path.join(PLUGINS_DIR, p.dirName, 'commands'))
    }));
  }

  // ── Enable / Disable ────────────────────────────────

  enablePlugin(name) {
    const settings = this._readSettings();
    if (!settings.plugins) settings.plugins = { enabled: [], installed: [] };
    if (!settings.plugins.enabled.includes(name)) {
      settings.plugins.enabled.push(name);
    }
    this._writeSettings(settings);
    return true;
  }

  disablePlugin(name) {
    const settings = this._readSettings();
    if (!settings.plugins) return true;
    settings.plugins.enabled = (settings.plugins.enabled || []).filter(n => n !== name);
    this._writeSettings(settings);
    return true;
  }

  // ── Install / Remove ────────────────────────────────

  /**
   * Install a plugin from a git URL (clones into plugins/).
   * @param {string} gitUrl — e.g. https://github.com/anthropics/claude-plugin-productivity.git
   * @param {string} [dirName] — optional directory name override
   * @returns {{ name, manifest }} on success
   */
  installPlugin(gitUrl, dirName) {
    const repoName = dirName || gitUrl.split('/').pop().replace(/\.git$/, '');
    const dest = path.join(PLUGINS_DIR, repoName);

    if (fs.existsSync(dest)) {
      throw new Error(`Plugin directory "${repoName}" already exists. Remove it first.`);
    }

    try {
      execFileSync('git', ['clone', '--depth', '1', gitUrl, dest], { stdio: 'pipe', timeout: 60000 });
    } catch (err) {
      throw new Error(`Failed to clone plugin: ${err.message}`);
    }

    const manifest = this._readManifest(repoName);
    if (!manifest) {
      // Clean up — not a valid plugin
      fs.rmSync(dest, { recursive: true, force: true });
      throw new Error('Cloned repository is not a valid plugin (missing .claude-plugin/plugin.json)');
    }

    // Track installation
    const settings = this._readSettings();
    if (!settings.plugins) settings.plugins = { enabled: [], installed: [] };
    if (!settings.plugins.installed) settings.plugins.installed = [];
    settings.plugins.installed.push({
      name: manifest.name || repoName,
      source: gitUrl,
      installedAt: new Date().toISOString()
    });
    // Auto-enable
    if (!settings.plugins.enabled) settings.plugins.enabled = [];
    if (!settings.plugins.enabled.includes(manifest.name || repoName)) {
      settings.plugins.enabled.push(manifest.name || repoName);
    }
    this._writeSettings(settings);

    return { name: manifest.name || repoName, manifest };
  }

  /**
   * Remove an installed plugin by directory name.
   */
  removePlugin(dirName) {
    const dest = path.join(PLUGINS_DIR, dirName);
    if (!fs.existsSync(dest)) {
      throw new Error(`Plugin "${dirName}" not found`);
    }

    // Read manifest to get the logical name before deleting
    const manifest = this._readManifest(dirName);
    const name = manifest?.name || dirName;

    fs.rmSync(dest, { recursive: true, force: true });

    // Clean up settings
    const settings = this._readSettings();
    if (settings.plugins) {
      settings.plugins.enabled = (settings.plugins.enabled || []).filter(n => n !== name);
      settings.plugins.installed = (settings.plugins.installed || []).filter(p => p.name !== name);
      this._writeSettings(settings);
    }

    return true;
  }

  // ── Aggregation for Chat Handler ────────────────────

  /**
   * Get MCP server configs from all enabled plugins.
   * Returns an object { pluginName_serverName: mcpConfig, ... }
   */
  getEnabledMcpServers() {
    const mcpServers = {};
    for (const plugin of this.discover()) {
      if (!plugin.enabled) continue;
      const mcpPath = path.join(PLUGINS_DIR, plugin.dirName, '.mcp.json');
      if (!fs.existsSync(mcpPath)) continue;

      try {
        const mcpConfig = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
        const servers = mcpConfig.mcpServers || mcpConfig;
        for (const [serverName, config] of Object.entries(servers)) {
          const key = `plugin_${plugin.dirName}_${serverName}`;
          mcpServers[key] = config;
        }
      } catch (err) {
        console.error(`[Plugins] Failed to read MCP config for ${plugin.name}:`, err.message);
      }
    }
    return mcpServers;
  }

  /**
   * Get system prompt additions from enabled plugins' skills/ directories.
   * Returns a combined string to append to the system prompt.
   */
  getSystemPromptAdditions() {
    const parts = [];
    for (const plugin of this.discover()) {
      if (!plugin.enabled) continue;
      const skillsDir = path.join(PLUGINS_DIR, plugin.dirName, 'skills');
      if (!fs.existsSync(skillsDir)) continue;

      try {
        for (const file of fs.readdirSync(skillsDir)) {
          if (!file.endsWith('.md')) continue;
          const content = fs.readFileSync(path.join(skillsDir, file), 'utf8').trim();
          if (content) {
            parts.push(`# Plugin: ${plugin.name} — ${file.replace('.md', '')}\n${content}`);
          }
        }
      } catch (err) {
        console.error(`[Plugins] Failed to read skills for ${plugin.name}:`, err.message);
      }
    }
    return parts.join('\n\n');
  }

  /**
   * Get sub-agent definitions from enabled plugins.
   * Returns an object { agentType: agentConfig, ... } for the SDK's agents option.
   */
  getAgentDefinitions() {
    const agents = {};
    for (const plugin of this.discover()) {
      if (!plugin.enabled) continue;
      if (!plugin.manifest.agents) continue;

      for (const [agentType, agentConfig] of Object.entries(plugin.manifest.agents)) {
        agents[agentType] = agentConfig;
      }
    }
    return agents;
  }

  // ── Internal Helpers ────────────────────────────────

  _readManifest(dirName) {
    const manifestPath = path.join(PLUGINS_DIR, dirName, '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(manifestPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      return null;
    }
  }

  _isEnabled(name) {
    const settings = this._readSettings();
    return (settings.plugins?.enabled || []).includes(name);
  }
}

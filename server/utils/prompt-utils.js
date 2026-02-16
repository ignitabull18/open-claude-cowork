import { readUserSettingsFile } from './settings-utils.js';

/**
 * Build a system prompt appendix from global + folder instructions, project info, and external context.
 */
export function buildSystemPrompt(chatMetadata = {}) {
  const data = readUserSettingsFile();
  const instructions = data.instructions || { global: '', folders: [] };
  const parts = [];

  // Project Context
  const project = chatMetadata.project || {};
  if (project.name || project.desc) {
    parts.push(`## Project Context\nName: ${project.name || 'Untitled'}\nGoal: ${project.desc || 'Not specified'}`);
  }

  if (instructions.global && instructions.global.trim()) {
    parts.push('## User Instructions\n' + instructions.global.trim());
  }

  if (Array.isArray(instructions.folders)) {
    for (const folder of instructions.folders) {
      if (folder.path && folder.instructions && folder.instructions.trim()) {
        parts.push(`### Instructions for ${folder.path}\n${folder.instructions.trim()}`);
      }
    }
  }

  // External context (if fetched)
  if (chatMetadata.externalContent) {
    parts.push(chatMetadata.externalContent);
  }

  return parts.join('\n\n');
}

/**
 * Fetch direct content from external pinned resources (Notion, GDrive, YouTube).
 * Uses the Composio MCP session to call tools programmatically.
 */
export async function fetchDirectExternalContext(metadata, composioSession) {
  if (!composioSession?.mcp?.url) return '';
  const integrations = metadata?.integrations || {};
  const parts = [];

  const callTool = async (name, args) => {
    try {
      const res = await fetch(composioSession.mcp.url, {
        method: 'POST',
        headers: { ...composioSession.mcp.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'tools/call', params: { name, arguments: args } })
      });
      if (!res.ok) return null;
      const data = await res.json();
      // Extract content from MCP response format
      if (data.result && data.result.content && Array.isArray(data.result.content)) {
        return data.result.content.map(c => c.text).join('\n');
      }
      return data.result?.content || data.result?.text || JSON.stringify(data.result);
    } catch (err) {
      console.warn(`[CONTEXT] MCP tool call failed (${name}):`, err.message);
      return null;
    }
  };

  // Notion
  if (Array.isArray(integrations.notion) && integrations.notion.length > 0) {
    for (const item of integrations.notion) {
      const content = await callTool('NOTION_GET_PAGE_CONTENT', { page_id: item.id });
      if (content) parts.push(`### Pinned Notion Page: ${item.title}\n${content}`);
    }
  }

  // Google Drive
  if (Array.isArray(integrations.gdrive) && integrations.gdrive.length > 0) {
    for (const item of integrations.gdrive) {
      const content = await callTool('GOOGLEDRIVE_GET_FILE_CONTENT', { file_id: item.id });
      if (content) parts.push(`### Pinned Google Drive File: ${item.title}\n${content}`);
    }
  }

  // YouTube (Transcript)
  if (Array.isArray(integrations.youtube) && integrations.youtube.length > 0) {
    for (const item of integrations.youtube) {
      const content = await callTool('YOUTUBE_GET_TRANSCRIPT', { video_url: item.id });
      if (content) parts.push(`### Pinned YouTube Transcript: ${item.title}\n${content}`);
    }
  }

  return parts.length > 0 ? '## Pinned External Resources\n' + parts.join('\n\n') : '';
}

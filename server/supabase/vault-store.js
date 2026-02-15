import { getAdminClient } from './client.js';

const db = () => getAdminClient();

// ── Folders ──────────────────────────────────────────────────

export async function createFolder(userId, name, parentId = null) {
  const { data, error } = await db()
    .from('vault_folders')
    .insert({ user_id: userId, name, parent_id: parentId })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getUserFolders(userId, parentId = null) {
  let query = db()
    .from('vault_folders')
    .select('*')
    .eq('user_id', userId)
    .order('name');

  if (parentId) {
    query = query.eq('parent_id', parentId);
  } else {
    query = query.is('parent_id', null);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function renameFolder(folderId, userId, name) {
  const { data, error } = await db()
    .from('vault_folders')
    .update({ name, updated_at: new Date().toISOString() })
    .eq('id', folderId)
    .eq('user_id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteFolder(folderId, userId) {
  const { error } = await db()
    .from('vault_folders')
    .delete()
    .eq('id', folderId)
    .eq('user_id', userId);
  if (error) throw error;
}

export async function moveFolder(folderId, userId, newParentId) {
  const { data, error } = await db()
    .from('vault_folders')
    .update({ parent_id: newParentId || null, updated_at: new Date().toISOString() })
    .eq('id', folderId)
    .eq('user_id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getFolderBreadcrumbs(folderId, userId) {
  const { data, error } = await db()
    .rpc('get_folder_breadcrumbs', { folder_uuid: folderId, user_uuid: userId });
  if (error) throw error;
  return data || [];
}

// ── Assets (attachments) ─────────────────────────────────────

export async function getVaultAssets(userId, folderId = null, opts = {}) {
  const { sort = 'created_at', dir = 'desc', source, limit = 50, offset = 0 } = opts;

  let query = db()
    .from('attachments')
    .select('*')
    .eq('user_id', userId)
    .order(sort, { ascending: dir === 'asc' })
    .range(offset, offset + limit - 1);

  if (folderId) {
    query = query.eq('folder_id', folderId);
  } else {
    query = query.is('folder_id', null);
  }

  if (source) {
    query = query.eq('source', source);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function moveAsset(attachmentId, userId, folderId) {
  const { data, error } = await db()
    .from('attachments')
    .update({ folder_id: folderId || null, updated_at: new Date().toISOString() })
    .eq('id', attachmentId)
    .eq('user_id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function renameAsset(attachmentId, userId, displayName) {
  const { data, error } = await db()
    .from('attachments')
    .update({ display_name: displayName, updated_at: new Date().toISOString() })
    .eq('id', attachmentId)
    .eq('user_id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateAsset(attachmentId, userId, updates) {
  const allowed = {};
  if (updates.display_name !== undefined) allowed.display_name = updates.display_name;
  if (updates.description !== undefined) allowed.description = updates.description;
  if (updates.folder_id !== undefined) allowed.folder_id = updates.folder_id || null;
  allowed.updated_at = new Date().toISOString();

  const { data, error } = await db()
    .from('attachments')
    .update(allowed)
    .eq('id', attachmentId)
    .eq('user_id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getVaultStats(userId) {
  const [foldersRes, assetsRes] = await Promise.all([
    db().from('vault_folders').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    db().from('attachments').select('file_size', { count: 'exact' }).eq('user_id', userId)
  ]);

  if (foldersRes.error) throw foldersRes.error;
  if (assetsRes.error) throw assetsRes.error;

  const totalSize = (assetsRes.data || []).reduce((sum, r) => sum + (r.file_size || 0), 0);

  return {
    folderCount: foldersRes.count || 0,
    assetCount: assetsRes.count || 0,
    totalSize
  };
}

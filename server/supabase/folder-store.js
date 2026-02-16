import { getAdminClient } from './client.js';

const db = () => getAdminClient();

export async function createFolder(userId, name, type, parentId = null) {
  const { data, error } = await db()
    .from('universal_folders')
    .insert([{ user_id: userId, name, type, parent_id: parentId }])
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function getFolders(userId, type, parentId = null) {
  let query = db()
    .from('universal_folders')
    .select('*')
    .eq('user_id', userId)
    .eq('type', type);

  if (parentId) {
    query = query.eq('parent_id', parentId);
  } else {
    query = query.eq('parent_id', null);
  }

  const { data, error } = await query.order('name');
  if (error) throw error;
  return data;
}

export async function renameFolder(folderId, userId, newName) {
  const { data, error } = await db()
    .from('universal_folders')
    .update({ name: newName })
    .eq('id', folderId)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteFolder(folderId, userId) {
  const { error } = await db()
    .from('universal_folders')
    .delete()
    .eq('id', folderId)
    .eq('user_id', userId);

  if (error) throw error;
  return true;
}

export async function getBreadcrumbs(folderId, userId) {
  const { data, error } = await db().rpc('get_universal_folder_breadcrumbs', {
    p_folder_id: folderId,
    p_user_id: userId
  });

  if (error) throw error;
  return data;
}

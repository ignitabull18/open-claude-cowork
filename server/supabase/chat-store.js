import { getAdminClient } from './client.js';

const db = () => getAdminClient();

export async function createChat({ id, userId, title, provider, model }) {
  const { data, error } = await db()
    .from('chats')
    .upsert({ id, user_id: userId, title, provider, model }, { onConflict: 'id' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getUserChats(userId) {
  const { data, error } = await db()
    .from('chats')
    .select('id, title, provider, model, created_at, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function getChat(chatId, userId) {
  const { data: chat, error: chatError } = await db()
    .from('chats')
    .select('*')
    .eq('id', chatId)
    .eq('user_id', userId)
    .single();
  if (chatError) throw chatError;

  const { data: messages, error: msgError } = await db()
    .from('messages')
    .select('id, role, content, html, metadata, created_at')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: true });
  if (msgError) throw msgError;

  return { ...chat, messages };
}

export async function deleteChat(chatId, userId) {
  const { error } = await db()
    .from('chats')
    .delete()
    .eq('id', chatId)
    .eq('user_id', userId);
  if (error) throw error;
}

export async function updateChatTitle(chatId, userId, title) {
  const { data, error } = await db()
    .from('chats')
    .update({ title })
    .eq('id', chatId)
    .eq('user_id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function addMessage({ chatId, userId, role, content, html, metadata }) {
  const { data, error } = await db()
    .from('messages')
    .insert({ chat_id: chatId, user_id: userId, role, content, html: html || '', metadata: metadata || {} })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getChatMessages(chatId) {
  const { data, error } = await db()
    .from('messages')
    .select('id, role, content, html, metadata, created_at')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

export async function getProfile(userId) {
  const { data, error } = await db()
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  if (error && error.code !== 'PGRST116') throw error; // PGRST116 = not found
  return data;
}

export async function updateProfile(userId, updates) {
  const { data, error } = await db()
    .from('profiles')
    .update(updates)
    .eq('id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

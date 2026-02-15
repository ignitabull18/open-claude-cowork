import { getAdminClient } from './client.js';

const db = () => getAdminClient();

// ==================== RPC REPORT QUERIES ====================

export async function getDailyMessages(userId, days = 30) {
  const { data, error } = await db().rpc('report_daily_messages', {
    p_user_id: userId,
    p_days: days
  });
  if (error) throw error;
  return data || [];
}

export async function getProviderUsage(userId, days = 30) {
  const { data, error } = await db().rpc('report_provider_usage', {
    p_user_id: userId,
    p_days: days
  });
  if (error) throw error;
  return data || [];
}

export async function getToolUsage(userId, days = 30) {
  const { data, error } = await db().rpc('report_tool_usage', {
    p_user_id: userId,
    p_days: days
  });
  if (error) throw error;
  return data || [];
}

export async function getSummary(userId) {
  const { data, error } = await db().rpc('report_summary', {
    p_user_id: userId
  });
  if (error) throw error;
  return data?.[0] || { total_chats: 0, total_messages: 0, active_days: 0, avg_messages_per_day: 0 };
}

export async function executeCustomQuery(userId, config) {
  const { data, error } = await db().rpc('report_custom_query', {
    p_user_id: userId,
    p_config: config
  });
  if (error) throw error;
  return data || [];
}

// ==================== SAVED REPORTS CRUD ====================

export async function getSavedReports(userId) {
  const { data, error } = await db()
    .from('saved_reports')
    .select('id, name, description, report_config, last_run_at, created_at, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getSavedReport(reportId, userId) {
  const { data, error } = await db()
    .from('saved_reports')
    .select('*')
    .eq('id', reportId)
    .eq('user_id', userId)
    .single();
  if (error) {
    if (error.code === 'PGRST116') return null;
    throw error;
  }
  return data;
}

export async function createSavedReport(userId, { name, description, reportConfig }) {
  const { data, error } = await db()
    .from('saved_reports')
    .insert({
      user_id: userId,
      name,
      description: description || '',
      report_config: reportConfig
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateSavedReport(reportId, userId, updates) {
  const payload = {};
  if (updates.name !== undefined) payload.name = updates.name;
  if (updates.description !== undefined) payload.description = updates.description;
  if (updates.reportConfig !== undefined) payload.report_config = updates.reportConfig;

  const { data, error } = await db()
    .from('saved_reports')
    .update(payload)
    .eq('id', reportId)
    .eq('user_id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteSavedReport(reportId, userId) {
  const { error } = await db()
    .from('saved_reports')
    .delete()
    .eq('id', reportId)
    .eq('user_id', userId);
  if (error) throw error;
}

export async function updateReportResult(reportId, result) {
  const { error } = await db()
    .from('saved_reports')
    .update({ last_result: result, last_run_at: new Date().toISOString() })
    .eq('id', reportId);
  if (error) throw error;
}

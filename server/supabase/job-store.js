import { getAdminClient } from './client.js';

const db = () => getAdminClient();

// ==================== JOBS CRUD ====================

export async function createJob(userId, jobData) {
  const { data, error } = await db()
    .from('scheduled_jobs')
    .insert({
      user_id: userId,
      name: jobData.name,
      description: jobData.description || '',
      job_type: jobData.jobType,
      status: 'active',
      execute_at: jobData.executeAt || null,
      interval_seconds: jobData.intervalSeconds || null,
      cron_expression: jobData.cronExpression || null,
      action_type: jobData.actionType,
      action_config: jobData.actionConfig || {},
      next_run_at: jobData.executeAt || null
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getUserJobs(userId, opts = {}) {
  let query = db()
    .from('scheduled_jobs')
    .select('*')
    .eq('user_id', userId);

  if (opts.status) {
    query = query.eq('status', opts.status);
  }

  query = query.order('created_at', { ascending: false });

  if (opts.limit) {
    query = query.limit(opts.limit);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function getJob(jobId, userId) {
  const { data, error } = await db()
    .from('scheduled_jobs')
    .select('*')
    .eq('id', jobId)
    .eq('user_id', userId)
    .single();
  if (error) throw error;
  return data;
}

export async function updateJob(jobId, userId, updates) {
  const payload = {};
  if (updates.name !== undefined) payload.name = updates.name;
  if (updates.description !== undefined) payload.description = updates.description;
  if (updates.status !== undefined) payload.status = updates.status;
  if (updates.jobType !== undefined) payload.job_type = updates.jobType;
  if (updates.executeAt !== undefined) payload.execute_at = updates.executeAt;
  if (updates.intervalSeconds !== undefined) payload.interval_seconds = updates.intervalSeconds;
  if (updates.cronExpression !== undefined) payload.cron_expression = updates.cronExpression;
  if (updates.actionType !== undefined) payload.action_type = updates.actionType;
  if (updates.actionConfig !== undefined) payload.action_config = updates.actionConfig;
  if (updates.lastRunAt !== undefined) payload.last_run_at = updates.lastRunAt;
  if (updates.nextRunAt !== undefined) payload.next_run_at = updates.nextRunAt;
  if (updates.runCount !== undefined) payload.run_count = updates.runCount;
  if (updates.lastError !== undefined) payload.last_error = updates.lastError;

  const { data, error } = await db()
    .from('scheduled_jobs')
    .update(payload)
    .eq('id', jobId)
    .eq('user_id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteJob(jobId, userId) {
  const { error } = await db()
    .from('scheduled_jobs')
    .delete()
    .eq('id', jobId)
    .eq('user_id', userId);
  if (error) throw error;
}

// ==================== JOB EXECUTIONS ====================

export async function getJobExecutions(jobId, userId, opts = {}) {
  let query = db()
    .from('job_executions')
    .select('*')
    .eq('job_id', jobId)
    .eq('user_id', userId)
    .order('started_at', { ascending: false });

  if (opts.limit) {
    query = query.limit(opts.limit);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function addJobExecution(jobId, userId, execData) {
  const { data, error } = await db()
    .from('job_executions')
    .insert({
      job_id: jobId,
      user_id: userId,
      status: execData.status || 'running',
      started_at: execData.startedAt || new Date().toISOString(),
      completed_at: execData.completedAt || null,
      duration_ms: execData.durationMs || null,
      result: execData.result || {},
      error: execData.error || null
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateJobExecution(executionId, updates) {
  const payload = {};
  if (updates.status !== undefined) payload.status = updates.status;
  if (updates.completedAt !== undefined) payload.completed_at = updates.completedAt;
  if (updates.durationMs !== undefined) payload.duration_ms = updates.durationMs;
  if (updates.result !== undefined) payload.result = updates.result;
  if (updates.error !== undefined) payload.error = updates.error;

  const { data, error } = await db()
    .from('job_executions')
    .update(payload)
    .eq('id', executionId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ==================== SCHEDULER HELPERS ====================

/** Get all active jobs that are due to run (next_run_at <= now). */
export async function getDueJobs() {
  const { data, error } = await db()
    .from('scheduled_jobs')
    .select('*')
    .eq('status', 'active')
    .lte('next_run_at', new Date().toISOString())
    .order('next_run_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

/** Get all active jobs for scheduling on startup. */
export async function getActiveJobs() {
  const { data, error } = await db()
    .from('scheduled_jobs')
    .select('*')
    .eq('status', 'active')
    .order('next_run_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

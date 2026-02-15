import { getAdminClient } from './client.js';

const db = () => getAdminClient();

// ==================== TASKS CRUD ====================

export async function createTask(userId, taskData) {
  // Get max position for the target status column
  const { data: maxPos } = await db()
    .from('tasks')
    .select('position')
    .eq('user_id', userId)
    .eq('status', taskData.status || 'todo')
    .order('position', { ascending: false })
    .limit(1)
    .single();

  const nextPosition = maxPos ? maxPos.position + 1 : 0;

  const { data, error } = await db()
    .from('tasks')
    .insert({
      user_id: userId,
      title: taskData.title,
      description: taskData.description || '',
      status: taskData.status || 'todo',
      priority: taskData.priority !== undefined ? taskData.priority : 3,
      due_date: taskData.dueDate || null,
      position: taskData.position !== undefined ? taskData.position : nextPosition,
      scheduled_job_id: taskData.scheduledJobId || null
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getUserTasks(userId, opts = {}) {
  let query = db()
    .from('tasks')
    .select('*, task_label_assignments(label_id, task_labels(id, name, color))')
    .eq('user_id', userId);

  if (opts.status) query = query.eq('status', opts.status);
  if (opts.priority !== undefined) query = query.eq('priority', opts.priority);
  if (opts.search) query = query.ilike('title', `%${opts.search}%`);

  query = query.order('position', { ascending: true });

  if (opts.limit) query = query.limit(opts.limit);

  const { data, error } = await query;
  if (error) throw error;

  // Flatten nested label joins
  return (data || []).map(flattenTaskLabels);
}

export async function getTask(taskId, userId) {
  const { data, error } = await db()
    .from('tasks')
    .select('*, task_label_assignments(label_id, task_labels(id, name, color))')
    .eq('id', taskId)
    .eq('user_id', userId)
    .single();
  if (error) throw error;
  return flattenTaskLabels(data);
}

export async function updateTask(taskId, userId, updates) {
  const payload = {};
  if (updates.title !== undefined) payload.title = updates.title;
  if (updates.description !== undefined) payload.description = updates.description;
  if (updates.status !== undefined) payload.status = updates.status;
  if (updates.priority !== undefined) payload.priority = updates.priority;
  if (updates.dueDate !== undefined) payload.due_date = updates.dueDate;
  if (updates.position !== undefined) payload.position = updates.position;
  if (updates.scheduledJobId !== undefined) payload.scheduled_job_id = updates.scheduledJobId;

  const { data, error } = await db()
    .from('tasks')
    .update(payload)
    .eq('id', taskId)
    .eq('user_id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteTask(taskId, userId) {
  const { error } = await db()
    .from('tasks')
    .delete()
    .eq('id', taskId)
    .eq('user_id', userId);
  if (error) throw error;
}

export async function reorderTask(userId, taskId, newStatus, newPosition) {
  const { error } = await db().rpc('tasks_reorder', {
    p_user_id: userId,
    p_task_id: taskId,
    p_new_status: newStatus,
    p_new_position: newPosition
  });
  if (error) throw error;
}

// ==================== CALENDAR / BOARD HELPERS ====================

export async function getTasksInRange(userId, start, end) {
  const { data, error } = await db().rpc('tasks_in_range', {
    p_user_id: userId,
    p_start: start,
    p_end: end
  });
  if (error) throw error;
  return data || [];
}

export async function getTasksByStatus(userId) {
  const { data, error } = await db().rpc('tasks_by_status', {
    p_user_id: userId
  });
  if (error) throw error;
  return data || [];
}

// ==================== LABELS CRUD ====================

export async function createLabel(userId, labelData) {
  const { data, error } = await db()
    .from('task_labels')
    .insert({
      user_id: userId,
      name: labelData.name,
      color: labelData.color || '#c4917b'
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getUserLabels(userId) {
  const { data, error } = await db()
    .from('task_labels')
    .select('*')
    .eq('user_id', userId)
    .order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function updateLabel(labelId, userId, updates) {
  const payload = {};
  if (updates.name !== undefined) payload.name = updates.name;
  if (updates.color !== undefined) payload.color = updates.color;

  const { data, error } = await db()
    .from('task_labels')
    .update(payload)
    .eq('id', labelId)
    .eq('user_id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteLabel(labelId, userId) {
  const { error } = await db()
    .from('task_labels')
    .delete()
    .eq('id', labelId)
    .eq('user_id', userId);
  if (error) throw error;
}

// ==================== LABEL ASSIGNMENTS ====================

export async function assignLabel(taskId, labelId) {
  const { data, error } = await db()
    .from('task_label_assignments')
    .insert({ task_id: taskId, label_id: labelId })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function removeLabel(taskId, labelId) {
  const { error } = await db()
    .from('task_label_assignments')
    .delete()
    .eq('task_id', taskId)
    .eq('label_id', labelId);
  if (error) throw error;
}

export async function getTaskLabels(taskId) {
  const { data, error } = await db()
    .from('task_label_assignments')
    .select('label_id, task_labels(id, name, color)')
    .eq('task_id', taskId);
  if (error) throw error;
  return (data || []).map(a => a.task_labels);
}

// ==================== HELPERS ====================

function flattenTaskLabels(task) {
  if (!task) return task;
  const labels = (task.task_label_assignments || [])
    .map(a => a.task_labels)
    .filter(Boolean);
  const { task_label_assignments, ...rest } = task;
  return { ...rest, labels };
}

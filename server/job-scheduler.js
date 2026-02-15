import * as jobStore from './supabase/job-store.js';
import * as reportStore from './supabase/report-store.js';

const POLL_INTERVAL_MS = 60_000; // 60 seconds
const scheduledTimers = new Map(); // jobId → timerRef

let pollTimer = null;

/**
 * Parse a simple cron expression and return the next run date.
 * Supports: "* * * * *" (min hour dom month dow).
 * For simplicity, only handles exact values and wildcards.
 */
function getNextCronRun(cronExpression) {
  // Simple implementation: schedule 1 minute from now for any cron
  // A full cron parser would be more complex; this is a minimal viable approach
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const now = new Date();
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);

  const [minPart, hourPart] = parts;

  // Handle specific minute
  if (minPart !== '*') {
    const targetMin = parseInt(minPart, 10);
    if (!isNaN(targetMin)) {
      next.setMinutes(targetMin);
      if (next <= now) next.setHours(next.getHours() + 1);
    }
  }

  // Handle specific hour
  if (hourPart !== '*') {
    const targetHour = parseInt(hourPart, 10);
    if (!isNaN(targetHour)) {
      next.setHours(targetHour);
      if (next <= now) next.setDate(next.getDate() + 1);
    }
  }

  return next;
}

/** Calculate next_run_at for a job based on its type. */
function calculateNextRun(job) {
  const now = new Date();

  if (job.job_type === 'one_time') {
    return job.execute_at ? new Date(job.execute_at) : null;
  }

  if (job.job_type === 'recurring' && job.interval_seconds) {
    return new Date(now.getTime() + job.interval_seconds * 1000);
  }

  if (job.job_type === 'cron' && job.cron_expression) {
    return getNextCronRun(job.cron_expression);
  }

  return null;
}

/** Execute a single job. */
async function executeJob(job) {
  const startTime = Date.now();
  let execution = null;

  try {
    // Create execution record
    execution = await jobStore.addJobExecution(job.id, job.user_id, {
      status: 'running',
      startedAt: new Date().toISOString()
    });

    let result = {};

    switch (job.action_type) {
      case 'report_generation': {
        const config = job.action_config;
        if (config.reportId) {
          const report = await reportStore.getSavedReport(config.reportId, job.user_id);
          if (report) {
            const queryResult = await reportStore.executeCustomQuery(job.user_id, report.report_config);
            await reportStore.updateReportResult(config.reportId, queryResult);
            result = { reportId: config.reportId, rowCount: Array.isArray(queryResult) ? queryResult.length : 0 };
          } else {
            throw new Error('Report not found: ' + config.reportId);
          }
        }
        break;
      }

      case 'webhook': {
        const config = job.action_config;
        if (!config.url) throw new Error('Webhook URL is required');

        const fetchOpts = {
          method: config.method || 'POST',
          headers: { 'Content-Type': 'application/json', ...(config.headers || {}) }
        };
        if (config.body) fetchOpts.body = typeof config.body === 'string' ? config.body : JSON.stringify(config.body);

        const resp = await fetch(config.url, fetchOpts);
        result = { status: resp.status, statusText: resp.statusText };
        if (!resp.ok) throw new Error(`Webhook returned ${resp.status}: ${resp.statusText}`);
        break;
      }

      case 'data_export': {
        const config = job.action_config;
        const source = config.source || 'messages';
        const format = config.format || 'json';

        // Query the data
        let data;
        if (source === 'messages') {
          data = await reportStore.getDailyMessages(job.user_id, 365);
        } else {
          data = await reportStore.getProviderUsage(job.user_id, 365);
        }

        result = { format, rowCount: Array.isArray(data) ? data.length : 0, source };
        break;
      }

      case 'chat_message': {
        // Chat message execution requires the provider system, which is handled at the API layer
        // For scheduler, we store a placeholder result
        result = { message: 'Chat message jobs should be triggered via API', config: job.action_config };
        break;
      }

      default:
        throw new Error('Unknown action type: ' + job.action_type);
    }

    // Mark execution as success
    const duration = Date.now() - startTime;
    await jobStore.updateJobExecution(execution.id, {
      status: 'success',
      completedAt: new Date().toISOString(),
      durationMs: duration,
      result
    });

    // Update job: increment run_count, set last_run_at, calculate next_run_at
    const updates = {
      lastRunAt: new Date().toISOString(),
      runCount: (job.run_count || 0) + 1,
      lastError: null
    };

    if (job.job_type === 'one_time') {
      updates.status = 'completed';
      updates.nextRunAt = null;
    } else {
      const nextRun = calculateNextRun(job);
      updates.nextRunAt = nextRun ? nextRun.toISOString() : null;
    }

    await jobStore.updateJob(job.id, job.user_id, updates);

    console.log(`[SCHEDULER] Job ${job.id} (${job.name}) completed in ${duration}ms`);
  } catch (err) {
    console.error(`[SCHEDULER] Job ${job.id} (${job.name}) failed:`, err.message);

    const duration = Date.now() - startTime;

    if (execution) {
      await jobStore.updateJobExecution(execution.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        durationMs: duration,
        error: err.message
      }).catch(e => console.error('[SCHEDULER] Failed to update execution:', e.message));
    }

    // Update job with error
    await jobStore.updateJob(job.id, job.user_id, {
      lastRunAt: new Date().toISOString(),
      lastError: err.message,
      runCount: (job.run_count || 0) + 1
    }).catch(e => console.error('[SCHEDULER] Failed to update job:', e.message));
  }
}

/** Poll DB for due jobs and execute them. */
async function pollAndExecute() {
  try {
    const dueJobs = await jobStore.getDueJobs();
    for (const job of dueJobs) {
      // Execute in background (don't await — allow parallel execution)
      executeJob(job).catch(err => {
        console.error(`[SCHEDULER] Unhandled error for job ${job.id}:`, err.message);
      });
    }
  } catch (err) {
    console.error('[SCHEDULER] Poll error:', err.message);
  }
}

/** Initialize the scheduler: load active jobs, start polling. */
export async function startScheduler() {
  console.log('[SCHEDULER] Starting job scheduler');

  try {
    const activeJobs = await jobStore.getActiveJobs();
    console.log(`[SCHEDULER] Found ${activeJobs.length} active jobs`);

    // Set next_run_at for jobs that don't have one
    for (const job of activeJobs) {
      if (!job.next_run_at) {
        const nextRun = calculateNextRun(job);
        if (nextRun) {
          await jobStore.updateJob(job.id, job.user_id, {
            nextRunAt: nextRun.toISOString()
          });
        }
      }
    }
  } catch (err) {
    console.error('[SCHEDULER] Failed to load active jobs:', err.message);
  }

  // Start polling
  pollTimer = setInterval(pollAndExecute, POLL_INTERVAL_MS);

  // Run initial poll
  pollAndExecute();
}

/** Stop the scheduler. */
export function stopScheduler() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  for (const [jobId, timerRef] of scheduledTimers) {
    clearTimeout(timerRef);
  }
  scheduledTimers.clear();
  console.log('[SCHEDULER] Stopped');
}

/** Manually trigger a job to run immediately. */
export async function triggerJob(jobId, userId) {
  const job = await jobStore.getJob(jobId, userId);
  if (!job) throw new Error('Job not found');
  await executeJob(job);
  return job;
}

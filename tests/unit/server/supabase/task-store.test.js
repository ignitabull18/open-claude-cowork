import { vi, describe, it, expect, beforeEach } from 'vitest';
import { resetMockDB, seedTable, createMockSupabaseClient, getTable } from '../../../mocks/supabase.js';

const mockClient = createMockSupabaseClient();

vi.mock('../../../../server/supabase/client.js', () => ({
  getAdminClient: vi.fn(() => mockClient),
  getUserClient: vi.fn(() => mockClient),
  getPublicConfig: vi.fn(() => ({ supabaseUrl: 'https://test.supabase.co', supabaseAnonKey: 'test-anon-key' }))
}));

import { assignLabel, removeLabel } from '../../../../server/supabase/task-store.js';

describe('task-store.js', () => {
  beforeEach(() => {
    resetMockDB();
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  });

  describe('assignLabel', () => {
    it('inserts a task-label relation when both resources belong to user', async () => {
      seedTable('tasks', [
        { id: 't1', user_id: 'user-1' }
      ]);
      seedTable('task_labels', [
        { id: 'l1', user_id: 'user-1' }
      ]);
      seedTable('task_label_assignments', []);

      const result = await assignLabel('t1', 'l1', 'user-1');

      expect(result).toBeDefined();
      expect(result.task_id).toBe('t1');
      expect(result.label_id).toBe('l1');
    });

    it('rejects when task belongs to a different user', async () => {
      seedTable('tasks', [
        { id: 't1', user_id: 'user-2' }
      ]);
      seedTable('task_labels', [
        { id: 'l1', user_id: 'user-1' }
      ]);
      seedTable('task_label_assignments', []);

      await expect(assignLabel('t1', 'l1', 'user-1')).rejects.toEqual(
        expect.objectContaining({ code: 'TASK_FORBIDDEN' })
      );
    });

    it('rejects when label belongs to a different user', async () => {
      seedTable('tasks', [
        { id: 't1', user_id: 'user-1' }
      ]);
      seedTable('task_labels', [
        { id: 'l1', user_id: 'user-2' }
      ]);
      seedTable('task_label_assignments', []);

      await expect(assignLabel('t1', 'l1', 'user-1')).rejects.toEqual(
        expect.objectContaining({ code: 'LABEL_FORBIDDEN' })
      );
    });
  });

  describe('removeLabel', () => {
    it('removes a task-label relation when both resources belong to user', async () => {
      seedTable('tasks', [
        { id: 't1', user_id: 'user-1' }
      ]);
      seedTable('task_labels', [
        { id: 'l1', user_id: 'user-1' }
      ]);
      seedTable('task_label_assignments', [
        { task_id: 't1', label_id: 'l1' }
      ]);

      await expect(removeLabel('t1', 'l1', 'user-1')).resolves.toBeUndefined();
      const assignments = getTable('task_label_assignments');
      expect(assignments).toHaveLength(0);
    });

    it('rejects when task belongs to a different user', async () => {
      seedTable('tasks', [
        { id: 't1', user_id: 'user-2' }
      ]);
      seedTable('task_labels', [
        { id: 'l1', user_id: 'user-2' }
      ]);
      seedTable('task_label_assignments', [
        { task_id: 't1', label_id: 'l1' }
      ]);

      await expect(removeLabel('t1', 'l1', 'user-1')).rejects.toEqual(
        expect.objectContaining({ code: 'TASK_FORBIDDEN' })
      );
    });
  });
});

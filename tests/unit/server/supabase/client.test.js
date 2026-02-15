import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetMockDB, createMockSupabaseClient } from '../../../mocks/supabase.js';

const mockClient = createMockSupabaseClient();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => mockClient)
}));

// We need to reset the cached adminClient between tests since it is module-level state.
// The simplest approach: re-import after resetting the module registry.
describe('client.js', () => {
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    resetMockDB();
    // Set required env vars
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.SUPABASE_ANON_KEY = 'test-anon-key';
    // Reset module so cached adminClient is cleared
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  describe('getAdminClient', () => {
    it('creates a client with the service role key from env', async () => {
      const { createClient } = await import('@supabase/supabase-js');
      const { getAdminClient } = await import('../../../../server/supabase/client.js');

      const client = getAdminClient();

      expect(createClient).toHaveBeenCalledWith(
        'https://test.supabase.co',
        'test-service-role-key',
        { auth: { autoRefreshToken: false, persistSession: false } }
      );
      expect(client).toBeDefined();
    });

    it('returns the same cached client on subsequent calls', async () => {
      const { getAdminClient } = await import('../../../../server/supabase/client.js');

      const first = getAdminClient();
      const second = getAdminClient();

      expect(first).toBe(second);
    });

    it('throws when SUPABASE_URL is missing', async () => {
      delete process.env.SUPABASE_URL;
      const { getAdminClient } = await import('../../../../server/supabase/client.js');

      expect(() => getAdminClient()).toThrow('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
    });

    it('throws when SUPABASE_SERVICE_ROLE_KEY is missing', async () => {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      const { getAdminClient } = await import('../../../../server/supabase/client.js');

      expect(() => getAdminClient()).toThrow('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
    });
  });

  describe('getUserClient', () => {
    it('creates a per-request client with the access token in headers', async () => {
      const { createClient } = await import('@supabase/supabase-js');
      const { getUserClient } = await import('../../../../server/supabase/client.js');

      const client = getUserClient('user-jwt-token');

      expect(createClient).toHaveBeenCalledWith(
        'https://test.supabase.co',
        'test-anon-key',
        {
          global: { headers: { Authorization: 'Bearer user-jwt-token' } },
          auth: { autoRefreshToken: false, persistSession: false }
        }
      );
      expect(client).toBeDefined();
    });

    it('creates a new client for each call (no caching)', async () => {
      const { getUserClient } = await import('../../../../server/supabase/client.js');

      const first = getUserClient('token-a');
      const second = getUserClient('token-b');

      // Both return mock clients; the important thing is createClient is called twice
      const { createClient } = await import('@supabase/supabase-js');
      // Count calls that were for getUserClient (anon key calls)
      const userCalls = createClient.mock.calls.filter(c => c[1] === 'test-anon-key');
      expect(userCalls.length).toBe(2);
    });

    it('throws when SUPABASE_URL is missing', async () => {
      delete process.env.SUPABASE_URL;
      const { getUserClient } = await import('../../../../server/supabase/client.js');

      expect(() => getUserClient('token')).toThrow('Missing SUPABASE_URL or SUPABASE_ANON_KEY env vars');
    });

    it('throws when SUPABASE_ANON_KEY is missing', async () => {
      delete process.env.SUPABASE_ANON_KEY;
      const { getUserClient } = await import('../../../../server/supabase/client.js');

      expect(() => getUserClient('token')).toThrow('Missing SUPABASE_URL or SUPABASE_ANON_KEY env vars');
    });
  });

  describe('getPublicConfig', () => {
    it('returns URL and anon key from env', async () => {
      const { getPublicConfig } = await import('../../../../server/supabase/client.js');

      const config = getPublicConfig();

      expect(config).toEqual({
        supabaseUrl: 'https://test.supabase.co',
        supabaseAnonKey: 'test-anon-key'
      });
    });

    it('returns empty strings when env vars are not set', async () => {
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_ANON_KEY;
      const { getPublicConfig } = await import('../../../../server/supabase/client.js');

      const config = getPublicConfig();

      expect(config).toEqual({
        supabaseUrl: '',
        supabaseAnonKey: ''
      });
    });
  });
});

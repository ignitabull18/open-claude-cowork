import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock external dependencies BEFORE importing the module under test
const mockSessionCreate = vi.fn();
const mockPromptAsync = vi.fn();
const mockEventSubscribe = vi.fn();
const mockServerClose = vi.fn();

const mockCreateOpencode = vi.fn();
const mockCreateOpencodeClient = vi.fn();

vi.mock('@opencode-ai/sdk', () => ({
  createOpencode: mockCreateOpencode,
  createOpencodeClient: mockCreateOpencodeClient
}));

const mockGetProviderSession = vi.fn();
vi.mock('../../../../server/supabase/session-store.js', () => ({
  getProviderSession: mockGetProviderSession,
  saveProviderSession: vi.fn()
}));

// Import module under test AFTER mocks
const { OpencodeProvider } = await import('../../../../server/providers/opencode-provider.js');

// Helper: create an async iterable from an array of events
async function* mockAsyncGenerator(events) {
  for (const event of events) {
    yield event;
  }
}

// Helper: collect all yielded values from an async generator
async function collectChunks(generator) {
  const chunks = [];
  for await (const chunk of generator) {
    chunks.push(chunk);
  }
  return chunks;
}

// Helper: build a mock client with standard methods
function buildMockClient() {
  return {
    session: {
      create: mockSessionCreate,
      promptAsync: mockPromptAsync
    },
    event: {
      subscribe: mockEventSubscribe
    }
  };
}

describe('OpencodeProvider', () => {
  let provider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProviderSession.mockResolvedValue(null);

    // Default: createOpencode returns a client + server pair
    const mockClient = buildMockClient();
    mockCreateOpencode.mockResolvedValue({
      client: mockClient,
      server: { close: mockServerClose }
    });

    // Default session creation result
    mockSessionCreate.mockResolvedValue({ data: { id: 'oc-session-1' } });
    mockPromptAsync.mockResolvedValue({});

    provider = new OpencodeProvider();
  });

  describe('constructor', () => {
    it('starts with null client and serverInstance', () => {
      expect(provider.client).toBeNull();
      expect(provider.serverInstance).toBeNull();
    });

    it('sets default hostname and port', () => {
      expect(provider.hostname).toBe('127.0.0.1');
      expect(provider.port).toBe(4096);
    });

    it('accepts config overrides', () => {
      const custom = new OpencodeProvider({
        model: 'anthropic/claude-sonnet-4-20250514',
        hostname: '0.0.0.0',
        port: 5000
      });
      expect(custom.defaultModel).toBe('anthropic/claude-sonnet-4-20250514');
      expect(custom.hostname).toBe('0.0.0.0');
      expect(custom.port).toBe(5000);
    });

    it('creates empty abortControllers Map', () => {
      expect(provider.abortControllers).toBeInstanceOf(Map);
      expect(provider.abortControllers.size).toBe(0);
    });
  });

  describe('name', () => {
    it('returns "opencode"', () => {
      expect(provider.name).toBe('opencode');
    });
  });

  describe('initialize()', () => {
    it('creates client and server via createOpencode', async () => {
      await provider.initialize();

      expect(mockCreateOpencode).toHaveBeenCalledWith({
        hostname: '127.0.0.1',
        port: 4096
      });
      expect(provider.client).not.toBeNull();
      expect(provider.serverInstance).not.toBeNull();
    });

    it('skips initialization if client already exists', async () => {
      await provider.initialize();
      await provider.initialize(); // second call

      expect(mockCreateOpencode).toHaveBeenCalledTimes(1);
    });

    it('uses createOpencodeClient when useExistingServer is true', async () => {
      const existingClient = buildMockClient();
      mockCreateOpencodeClient.mockReturnValue(existingClient);

      const p = new OpencodeProvider({
        useExistingServer: true,
        existingServerUrl: 'http://localhost:9999'
      });
      await p.initialize();

      expect(mockCreateOpencodeClient).toHaveBeenCalledWith({
        baseUrl: 'http://localhost:9999'
      });
      expect(p.client).toBe(existingClient);
      expect(p.serverInstance).toBeNull();
    });

    it('throws if createOpencode fails', async () => {
      mockCreateOpencode.mockRejectedValue(new Error('Port in use'));

      await expect(provider.initialize()).rejects.toThrow('Port in use');
    });
  });

  describe('query()', () => {
    // Set up the common case: initialized client, empty event stream by default
    function setupQueryMocks(events = []) {
      const mockClient = buildMockClient();
      mockCreateOpencode.mockResolvedValue({
        client: mockClient,
        server: { close: mockServerClose }
      });

      mockClient.session.create = mockSessionCreate;
      mockClient.session.promptAsync = mockPromptAsync;
      mockClient.event.subscribe = mockEventSubscribe;

      mockEventSubscribe.mockResolvedValue({
        stream: mockAsyncGenerator(events)
      });

      // Reset provider to use fresh mocks
      provider = new OpencodeProvider();
      // Pre-assign client so initialize() is a no-op
      provider.client = mockClient;

      return mockClient;
    }

    it('creates session if none exists and yields session_init', async () => {
      setupQueryMocks([
        { type: 'session.idle', properties: {} }
      ]);

      const chunks = await collectChunks(provider.query({
        prompt: 'hello',
        chatId: 'chat-1'
      }));

      expect(mockSessionCreate).toHaveBeenCalled();
      expect(chunks[0]).toEqual({
        type: 'session_init',
        session_id: 'oc-session-1',
        provider: 'opencode'
      });
    });

    it('reuses existing session from cache (does not create new one)', async () => {
      setupQueryMocks([
        { type: 'session.idle', properties: {} }
      ]);

      // Pre-set a session in the cache
      provider.sessions.set('chat-existing', 'existing-sess-id');

      await collectChunks(provider.query({
        prompt: 'continue',
        chatId: 'chat-existing'
      }));

      expect(mockSessionCreate).not.toHaveBeenCalled();
    });

    it('yields text deltas (only new text since last yield)', async () => {
      setupQueryMocks([
        // Simulate the user's message first (should be skipped)
        {
          type: 'message.part.updated',
          properties: {
            part: { type: 'text', text: 'user prompt', messageID: 'msg-user', id: 'part-user' }
          }
        },
        // Then the assistant's text arriving incrementally
        {
          type: 'message.part.updated',
          properties: {
            part: { type: 'text', text: 'Hello', messageID: 'msg-asst', id: 'part-1' }
          }
        },
        {
          type: 'message.part.updated',
          properties: {
            part: { type: 'text', text: 'Hello world!', messageID: 'msg-asst', id: 'part-1' }
          }
        },
        { type: 'session.idle', properties: {} }
      ]);

      const chunks = await collectChunks(provider.query({
        prompt: 'say hello',
        chatId: 'chat-text'
      }));

      const textChunks = chunks.filter(c => c.type === 'text');
      // First text delta: "Hello", second delta: " world!" (only the new part)
      expect(textChunks).toHaveLength(2);
      expect(textChunks[0].content).toBe('Hello');
      expect(textChunks[1].content).toBe(' world!');
    });

    it('yields tool_use chunks', async () => {
      setupQueryMocks([
        // User's message (skipped)
        {
          type: 'message.part.updated',
          properties: {
            part: { type: 'text', text: 'user msg', messageID: 'msg-u', id: 'p-u' }
          }
        },
        // Tool invocation
        {
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'tool-invocation',
              messageID: 'msg-a',
              id: 'p-tool',
              toolInvocationId: 'tool-call-1',
              toolName: 'Read',
              state: { input: { file: 'index.js' } }
            }
          }
        },
        { type: 'session.idle', properties: {} }
      ]);

      const chunks = await collectChunks(provider.query({
        prompt: 'read file',
        chatId: 'chat-tool'
      }));

      expect(chunks).toContainEqual({
        type: 'tool_use',
        name: 'Read',
        input: { file: 'index.js' },
        id: 'tool-call-1',
        provider: 'opencode'
      });
    });

    it('does not yield duplicate tool_use for the same callID', async () => {
      setupQueryMocks([
        // User message
        {
          type: 'message.part.updated',
          properties: {
            part: { type: 'text', text: 'msg', messageID: 'msg-u2', id: 'p-u2' }
          }
        },
        // Same tool call arriving twice
        {
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'tool-invocation',
              messageID: 'msg-a2',
              id: 'p-t1',
              toolInvocationId: 'dup-tool',
              toolName: 'Bash',
              state: { input: { command: 'ls' } }
            }
          }
        },
        {
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'tool-invocation',
              messageID: 'msg-a2',
              id: 'p-t1',
              toolInvocationId: 'dup-tool',
              toolName: 'Bash',
              state: { input: { command: 'ls' } }
            }
          }
        },
        { type: 'session.idle', properties: {} }
      ]);

      const chunks = await collectChunks(provider.query({
        prompt: 'run ls',
        chatId: 'chat-dup'
      }));

      const toolUseChunks = chunks.filter(c => c.type === 'tool_use');
      expect(toolUseChunks).toHaveLength(1);
    });

    it('yields tool_result chunks', async () => {
      setupQueryMocks([
        // User message
        {
          type: 'message.part.updated',
          properties: {
            part: { type: 'text', text: 'user', messageID: 'msg-u3', id: 'p-u3' }
          }
        },
        // Tool result
        {
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'tool-result',
              messageID: 'msg-a3',
              id: 'p-tr',
              toolInvocationId: 'tool-r-1',
              result: 'file content here'
            }
          }
        },
        { type: 'session.idle', properties: {} }
      ]);

      const chunks = await collectChunks(provider.query({
        prompt: 'show result',
        chatId: 'chat-result'
      }));

      expect(chunks).toContainEqual({
        type: 'tool_result',
        result: 'file content here',
        tool_use_id: 'tool-r-1',
        provider: 'opencode'
      });
    });

    it('yields done on session.idle', async () => {
      setupQueryMocks([
        { type: 'session.idle', properties: {} }
      ]);

      const chunks = await collectChunks(provider.query({
        prompt: 'hello',
        chatId: 'chat-idle'
      }));

      const lastChunk = chunks[chunks.length - 1];
      expect(lastChunk).toEqual({ type: 'done', provider: 'opencode' });
    });

    it('yields error on session.error', async () => {
      setupQueryMocks([
        {
          type: 'session.error',
          properties: { message: 'Model not available' }
        }
      ]);

      const chunks = await collectChunks(provider.query({
        prompt: 'hello',
        chatId: 'chat-error'
      }));

      expect(chunks).toContainEqual({
        type: 'error',
        message: 'Model not available',
        provider: 'opencode'
      });
    });

    it('filters events from other sessions', async () => {
      setupQueryMocks([
        // Event from a different session - should be ignored
        {
          type: 'message.part.updated',
          properties: {
            part: { type: 'text', text: 'wrong session', messageID: 'msg-other', id: 'p-other' },
            sessionID: 'other-session-id'
          }
        },
        { type: 'session.idle', properties: {} }
      ]);

      const chunks = await collectChunks(provider.query({
        prompt: 'hello',
        chatId: 'chat-filter'
      }));

      const textChunks = chunks.filter(c => c.type === 'text');
      expect(textChunks).toHaveLength(0);
    });

    it('cleans up abort controller after query completes', async () => {
      setupQueryMocks([
        { type: 'session.idle', properties: {} }
      ]);

      await collectChunks(provider.query({
        prompt: 'hello',
        chatId: 'chat-ac-cleanup'
      }));

      expect(provider.abortControllers.has('chat-ac-cleanup')).toBe(false);
    });

    it('yields error chunk on caught exception', async () => {
      setupQueryMocks([]);
      // Make promptAsync throw
      mockPromptAsync.mockRejectedValue(new Error('network timeout'));

      const chunks = await collectChunks(provider.query({
        prompt: 'fail',
        chatId: 'chat-throw'
      }));

      expect(chunks).toContainEqual({
        type: 'error',
        message: 'network timeout',
        provider: 'opencode'
      });
    });
  });

  describe('abort()', () => {
    it('returns true when an active controller exists and removes it', () => {
      const controller = new AbortController();
      provider.abortControllers.set('chat-a', controller);

      const result = provider.abort('chat-a');
      expect(result).toBe(true);
      expect(provider.abortControllers.has('chat-a')).toBe(false);
      expect(controller.signal.aborted).toBe(true);
    });

    it('returns false when no active query for the chatId', () => {
      expect(provider.abort('no-such-chat')).toBe(false);
    });
  });

  describe('cleanup()', () => {
    it('calls super.cleanup() to clear sessions', async () => {
      provider.sessions.set('x', '1');
      await provider.initialize();
      await provider.cleanup();
      expect(provider.sessions.size).toBe(0);
    });

    it('closes server instance when one exists', async () => {
      await provider.initialize();
      expect(provider.serverInstance).not.toBeNull();

      await provider.cleanup();
      expect(mockServerClose).toHaveBeenCalled();
      expect(provider.serverInstance).toBeNull();
    });

    it('sets client to null after cleanup', async () => {
      await provider.initialize();
      expect(provider.client).not.toBeNull();

      await provider.cleanup();
      expect(provider.client).toBeNull();
    });

    it('handles server close errors gracefully', async () => {
      mockServerClose.mockRejectedValue(new Error('close failed'));
      await provider.initialize();

      // Should not throw
      await expect(provider.cleanup()).resolves.toBeUndefined();
    });
  });
});

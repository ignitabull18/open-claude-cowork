/**
 * Web adapter for window.electronAPI when running in the browser (e.g. deployed on Coolify).
 * Uses relative URLs so the same origin serves both the UI and the API.
 */
(function () {
  if (typeof window.electronAPI !== 'undefined') return;

  let currentAbortController = null;

  window.electronAPI = {
    abortCurrentRequest: function () {
      if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
      }
    },

    stopQuery: async function (chatId, provider) {
      try {
        const response = await fetch('/api/abort', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId, provider: provider || 'claude' })
        });
        return await response.json();
      } catch (err) {
        return { success: false, error: err.message };
      }
    },

    sendMessage: function (message, chatId, provider, model) {
      if (currentAbortController) currentAbortController.abort();
      currentAbortController = new AbortController();

      return fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, chatId, provider: provider || 'claude', model }),
        signal: currentAbortController.signal
      }).then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + response.statusText);
        return {
          getReader: async function () {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            return {
              read: async function () {
                const { done, value } = await reader.read();
                return { done, value: done ? undefined : decoder.decode(value, { stream: true }) };
              }
            };
          }
        };
      }).catch(function (err) {
        throw new Error('Failed to connect to backend: ' + err.message);
      });
    },

    getProviders: async function () {
      try {
        const response = await fetch('/api/providers');
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return await response.json();
      } catch (err) {
        return { providers: ['claude'], default: 'claude' };
      }
    },

    checkBackend: async function () {
      try {
        const response = await fetch('/api/health', { method: 'GET' });
        return response.ok;
      } catch (err) {
        return false;
      }
    }
  };
})();

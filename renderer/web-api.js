/**
 * Web adapter for window.electronAPI when running in the browser (e.g. deployed on Coolify).
 * Uses relative URLs when served from the same origin; uses API_BASE (or localhost:3001) when
 * loaded as file:// so /api/settings etc. resolve to the backend.
 */
(function () {
  if (typeof window.electronAPI !== 'undefined') return;

  let currentAbortController = null;

  // When origin is file: (e.g. opening index.html in browser), relative fetch hits file:// and 404s.
  var apiBase = '';
  if (typeof window !== 'undefined' && window.location && window.location.protocol === 'file:') {
    apiBase = window.API_BASE_URL || 'http://localhost:3001';
  } else if (typeof window !== 'undefined' && window.API_BASE_URL) {
    apiBase = window.API_BASE_URL;
  }

  // Expose apiBase for other scripts (e.g. auth.js)
  window._apiBase = apiBase;

  function apiUrl(path) {
    return apiBase + path;
  }

  // Build headers with optional auth token
  function buildHeaders(extra) {
    var headers = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
    if (window._authToken) {
      headers['Authorization'] = 'Bearer ' + window._authToken;
    }
    return headers;
  }

  window.electronAPI = {
    setAuthToken: function (token) { window._authToken = token; },
    getAuthToken: function () { return window._authToken || null; },

    abortCurrentRequest: function () {
      if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
      }
    },

    stopQuery: async function (chatId, provider) {
      try {
        const response = await fetch(apiUrl('/api/abort'), {
          method: 'POST',
          headers: buildHeaders(),
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

      return fetch(apiUrl('/api/chat'), {
        method: 'POST',
        headers: buildHeaders(),
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
        const response = await fetch(apiUrl('/api/providers'));
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return await response.json();
      } catch (err) {
        return { providers: ['claude'], default: 'claude' };
      }
    },

    checkBackend: async function () {
      try {
        const response = await fetch(apiUrl('/api/health'), { method: 'GET' });
        return response.ok;
      } catch (err) {
        return false;
      }
    },

    getSettings: async function () {
      const response = await fetch(apiUrl('/api/settings'), { headers: buildHeaders() });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.json();
    },

    updateSettings: async function (body) {
      const response = await fetch(apiUrl('/api/settings'), {
        method: 'PUT',
        headers: buildHeaders(),
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        const data = await response.json().catch(function () { return {}; });
        throw new Error(data.error || 'HTTP ' + response.status);
      }
      return await response.json();
    }
  };
})();

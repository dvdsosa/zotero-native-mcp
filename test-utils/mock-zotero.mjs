/**
 * A stand-in for Zotero's local API, faithful to the parts of the protocol the
 * client depends on: the Zotero-Server-ID handshake, local API keys (including
 * the single-use kind "Allow" issues), and the status codes Zotero returns.
 *
 * Lets the client be tested end to end in CI, where no Zotero is running.
 */
import { createServer } from 'node:http';

export async function startMockZotero(options = {}) {
  const state = {
    serverId: options.serverId ?? 'MOCKSERVER01',
    validKeys: new Set(options.validKeys ?? []),
    singleUseKeys: new Set(options.singleUseKeys ?? []),
    authorizeResponse: options.authorizeResponse ?? { allow: true, remember: true },
    requests: [],
    libraryVersion: 42,
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      state.requests.push({ method: req.method, path: url.pathname, headers: req.headers, body });
      const send = (code, payload, headers = {}) => {
        res.writeHead(code, {
          'Content-Type': 'application/json',
          'Zotero-Server-ID': state.serverId,
          'X-Zotero-Version': '10.0.1',
          'Zotero-API-Version': '3',
          ...headers,
        });
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };

      if (url.pathname === '/api/') return send(200, 'Nothing to see here.');

      if (url.pathname === '/api/local/authorize') {
        if (!state.authorizeResponse.allow) return send(403, { denied: true });
        const key = 'issued-key-' + (state.requests.filter((r) => r.path === '/api/local/authorize').length);
        state.validKeys.add(key);
        if (!state.authorizeResponse.remember) state.singleUseKeys.add(key);
        return send(200, { key, remember: state.authorizeResponse.remember });
      }

      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        const sentId = req.headers['zotero-server-id'];
        if (!sentId) return send(428, 'Zotero-Server-ID not provided', { 'Content-Type': 'text/plain' });
        if (sentId !== state.serverId) {
          return send(412, 'Zotero-Server-ID does not match this server', { 'Content-Type': 'text/plain' });
        }
        const key = req.headers['zotero-api-key'];
        if (!key || !state.validKeys.has(key)) {
          return send(401, 'API key required -- POST /api/local/authorize to obtain one',
            { 'Content-Type': 'text/plain' });
        }
        if (state.singleUseKeys.has(key)) {
          state.singleUseKeys.delete(key);
          state.validKeys.delete(key);
        }
        state.libraryVersion += 1;
        return send(200, { successful: { 0: { key: 'NEWKEY01', version: state.libraryVersion, data: {} } }, failed: {} },
          { 'Last-Modified-Version': String(state.libraryVersion) });
      }

      if (url.pathname === '/api/users/0/items/MISSING1') {
        return send(404, 'Not found', { 'Content-Type': 'text/plain' });
      }
      return send(200, [{ key: 'ABCD1234', version: 1, data: { itemType: 'book', title: 'Dune' } }],
        { 'Total-Results': '1', 'Last-Modified-Version': String(state.libraryVersion) });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    state,
    baseUrl: `http://127.0.0.1:${port}`,
    authorizeCount: () => state.requests.filter((r) => r.path === '/api/local/authorize').length,
    // Data writes only; the authorize endpoint is also a POST but is not one.
    writes: () => state.requests.filter(
      (r) => ['POST', 'PATCH', 'DELETE', 'PUT'].includes(r.method) && r.path !== '/api/local/authorize'),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Runs the Worker on plain Node with the node:sqlite D1 stand-in, for local use when wrangler isn't available.
//   JOT_KEYS='{"laptop":"<32+ chars>"}' npm run serve    → http://127.0.0.1:8787, data in .jot-dev.sqlite

import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import worker from '../src/index.js';
import { D1 } from './d1.js';

// Wraps the Worker's fetch handler as a Node request listener. `env` may be changed between requests.
export function nodeHandler(env, { origin } = {}) {
  return async (req, res) => {
    try {
      const base = origin || `http://${req.headers.host}`;
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const request = new Request(new URL(req.url, base), {
        method: req.method,
        headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])),
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: hasBody ? 'half' : undefined,
      });
      const response = await worker.fetch(request, env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      res.writeHead(500);
      res.end(String(err && err.name));
    }
  };
}

export function serveWorker(env, { port = 8787, host = '127.0.0.1', tls } = {}) {
  const handler = nodeHandler(env, { origin: tls ? `https://${tls.hostname || 'localhost'}` : undefined });
  const server = tls ? https.createServer({ key: tls.key, cert: tls.cert }, handler) : http.createServer(handler);
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = { DB: new D1(process.env.JOT_DB || '.jot-dev.sqlite'), JOT_KEYS: process.env.JOT_KEYS };
  const port = Number(process.env.PORT || 8787);
  await serveWorker(env, { port });
  console.log(`jot-api (node) on http://127.0.0.1:${port}`);
}

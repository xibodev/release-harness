/**
 * Network probes.
 *
 * Two primitives, both of which answer one question: did something respond at
 * this address, and what did it say? Interpreting that answer -- deciding
 * whether a response constitutes a broken promise -- is deliberately not done
 * here. It belongs to attribution, where the rules about what may be blamed on
 * the subject live.
 *
 * The larger probe set that used to live in this file (S3, Postgres, Redis,
 * Mailpit, custom side effects) was written for the scenario architecture and
 * emitted the old PRODUCT_BUG vocabulary directly, deciding attribution at the
 * point of observation. That is the defect this release removes, so those
 * probes went with it rather than being carried forward unreachable. Their
 * replacements will be assertion kinds, which have to state what they are
 * asserting before anyone can be blamed for failing it.
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export async function probeHttp({ host = '127.0.0.1', port = 80, path = '/', scheme = 'http', method = 'GET', headers = {}, expectedStatus = 200, timeoutMs = 5000 }) {
  const client = scheme === 'https' ? https : http;
  const url = `${scheme}://${host}:${port}${path}`;
  const start = Date.now();

  return new Promise((resolve) => {
    const req = client.request(url, { method, headers, timeout: timeoutMs, rejectUnauthorized: false }, (res) => {
      const elapsed = Date.now() - start;
      const resHeaders = res.headers;
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        const ok = res.statusCode === expectedStatus || (expectedStatus === 200 && res.statusCode >= 200 && res.statusCode < 400);
        resolve({
          ok,
          status: res.statusCode,
          headers: resHeaders,
          body,
          elapsedMs: elapsed,
          message: `HTTP ${res.statusCode} in ${elapsed}ms`,
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, elapsedMs: Date.now() - start, message: `HTTP probe timed out after ${timeoutMs}ms` });
    });

    req.on('error', (err) => {
      resolve({ ok: false, status: 0, elapsedMs: Date.now() - start, message: err.message });
    });

    req.end();
  });
}

export async function probeTcp({ host = '127.0.0.1', port, timeoutMs = 5000 }) {
  const start = Date.now();
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);

    socket.connect(port, host, () => {
      const elapsed = Date.now() - start;
      socket.destroy();
      resolve({ ok: true, elapsedMs: elapsed, message: `TCP connect to ${host}:${port} ok (${elapsed}ms)` });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({ ok: false, elapsedMs: Date.now() - start, message: `TCP timeout after ${timeoutMs}ms` });
    });

    socket.on('error', (err) => {
      socket.destroy();
      resolve({ ok: false, elapsedMs: Date.now() - start, message: err.message });
    });
  });
}

/**
 * MinIO / S3 Storage Probe with digest, content-type, and local-path bypass verification.
 */

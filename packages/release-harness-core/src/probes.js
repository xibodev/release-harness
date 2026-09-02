import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import crypto from 'node:crypto';

/**
 * Independent side-effect and health probes.
 */

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
export async function probeS3({ host = '127.0.0.1', port = 9000, scheme = 'http', bucket, key, probe_type = 's3_object_exists', expected_content_type, expected_sha256, forbidden_paths, observed_storage_path, timeoutMs = 4000 }) {
  if (!bucket || !key) {
    return { ok: false, message: 'S3 probe requires "bucket" and "key" parameters', cause: 'HARNESS_CONFIGURATION', isHarnessError: true };
  }

  // 1. Enforce local bypass control (e.g. database stores /tmp/* or local filesystem path instead of S3)
  if (Array.isArray(forbidden_paths) && observed_storage_path) {
    for (const pattern of forbidden_paths) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      if (regex.test(observed_storage_path)) {
        return {
          ok: false,
          message: `Storage bypass violation: observed storage path "${observed_storage_path}" matches forbidden local pattern "${pattern}"`,
          cause: 'PRODUCT_BUG',
        };
      }
    }
  }

  const s3Path = `/${bucket}/${key}`;
  const res = await probeHttp({ host, port, path: s3Path, scheme, timeoutMs });

  if (probe_type === 's3_object_exists') {
    if (!res.ok) {
      return { ok: false, message: `S3 object "${bucket}/${key}" absent (expected HTTP 200, got ${res.status || res.message})`, cause: 'PRODUCT_BUG' };
    }

    if (expected_content_type) {
      const actualType = res.headers['content-type'];
      if (actualType && !actualType.includes(expected_content_type)) {
        return { ok: false, message: `S3 object content-type mismatch: expected "${expected_content_type}", got "${actualType}"`, cause: 'PRODUCT_BUG' };
      }
    }

    if (expected_sha256) {
      const computedSha = crypto.createHash('sha256').update(res.body).digest('hex');
      if (computedSha !== expected_sha256) {
        return { ok: false, message: `S3 object SHA-256 digest mismatch: expected "${expected_sha256}", computed "${computedSha}"`, cause: 'PRODUCT_BUG' };
      }
    }

    return { ok: true, message: `S3 object "${bucket}/${key}" verified (HTTP ${res.status} in ${res.elapsedMs}ms)` };
  } else if (probe_type === 's3_object_absent') {
    if (res.status === 404) {
      return { ok: true, message: `S3 object "${bucket}/${key}" confirmed absent (HTTP 404 in ${res.elapsedMs}ms)` };
    }
    return { ok: false, message: `S3 object "${bucket}/${key}" unexpectedly exists (HTTP ${res.status})`, cause: 'PRODUCT_BUG' };
  }

  return { ok: false, message: `Unsupported S3 probe_type: ${probe_type}`, cause: 'HARNESS_CONFIGURATION', isHarnessError: true };
}

/**
 * PostgreSQL Probe -- unimplemented, and says so.
 *
 * The harness ships no SQL client. This probe previously opened a TCP socket,
 * dropped `expected_rows_count` and `forbidden_values` into an empty block, and
 * returned `ok: true` claiming "read-only query assertion satisfied" whenever
 * the port answered. An open port is not an executed query, so every green it
 * produced was unearned.
 *
 * An advertised-and-stubbed probe returning green is worse than one that
 * refuses: it launders an unverified claim into a signed verdict. It now fails
 * closed as a harness configuration fault and names the custom probe as the
 * supported way to assert database state.
 *
 * `host` and `port` are kept because the message names the target the scenario
 * declared -- that is how an operator locates the offending side-effect, and how
 * a port-shifted run can prove the offset reached the probe.
 * `expected_rows_count`, `forbidden_values` and `timeoutMs` are gone from the
 * signature: accepting a parameter you discard is the defect being fixed.
 */
export async function probePostgres({ host = '127.0.0.1', port = 5432, query, probe_type = 'sql_query' }) {
  // The read-only policy rejection stays FIRST. A mutating query is a distinct
  // and more specific misconfiguration than an unimplemented probe, and an
  // author who wrote DROP TABLE needs to be told exactly that -- not pointed at
  // a custom probe that would happily run it.
  if (typeof query === 'string') {
    const dangerousKeywords = ['insert', 'update', 'delete', 'drop', 'alter', 'truncate', 'grant', 'revoke', 'create'];
    const normalizedQuery = query.toLowerCase().trim();
    if (dangerousKeywords.some((kw) => normalizedQuery.startsWith(kw) || normalizedQuery.includes(` ${kw} `))) {
      return {
        ok: false,
        message: 'PostgreSQL assertion rejected: mutating SQL queries are strictly forbidden in read-only release probes',
        cause: 'HARNESS_CONFIGURATION',
        isHarnessError: true,
      };
    }
  }

  return {
    ok: false,
    message:
      `PostgreSQL probe "${probe_type}" against ${host}:${port} is not implemented: the harness ships no ` +
      'SQL client, so it cannot execute the query or evaluate expected_rows_count / forbidden_values. ' +
      'Assert database state with a custom probe that runs your own query tool ' +
      '(service: "custom", probe_type: "custom", params.command).',
    cause: 'HARNESS_CONFIGURATION',
    isHarnessError: true,
  };
}

/**
 * Redis Key/Value Probe using Redis RESP protocol.
 */
export async function probeRedis({ host = '127.0.0.1', port = 6379, probe_type = 'redis_key_exists', key, expected_value, timeoutMs = 3000 }) {
  if (!key) {
    return { ok: false, message: 'Redis probe requires "key" parameter', cause: 'HARNESS_CONFIGURATION', isHarnessError: true };
  }

  const start = Date.now();
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);

    socket.connect(port, host, () => {
      // Send Redis EXISTS or GET command formatted as RESP
      if (probe_type === 'redis_key_exists' || probe_type === 'redis_key_absent') {
        socket.write(`*2\r\n$6\r\nEXISTS\r\n$${Buffer.byteLength(key)}\r\n${key}\r\n`);
      } else {
        socket.write(`*2\r\n$3\r\nGET\r\n$${Buffer.byteLength(key)}\r\n${key}\r\n`);
      }
    });

    socket.on('data', (data) => {
      const elapsed = Date.now() - start;
      const resp = data.toString('utf8');
      socket.destroy();

      if (probe_type === 'redis_key_exists') {
        const exists = resp.startsWith(':1');
        resolve({
          ok: exists,
          message: exists ? `Redis key "${key}" exists (${elapsed}ms)` : `Redis key "${key}" absent`,
          cause: exists ? 'NONE' : 'PRODUCT_BUG',
        });
      } else if (probe_type === 'redis_key_absent') {
        const absent = resp.startsWith(':0');
        resolve({
          ok: absent,
          message: absent ? `Redis key "${key}" confirmed absent (${elapsed}ms)` : `Redis key "${key}" unexpectedly exists`,
          cause: absent ? 'NONE' : 'PRODUCT_BUG',
        });
      } else if (probe_type === 'redis_key_value_equals') {
        const match = expected_value !== undefined ? resp.includes(String(expected_value)) : true;
        resolve({
          ok: match,
          message: match ? `Redis key "${key}" value matched expected (${elapsed}ms)` : `Redis key "${key}" value mismatch`,
          cause: match ? 'NONE' : 'PRODUCT_BUG',
        });
      } else {
        resolve({ ok: false, message: `Unsupported Redis probe_type: ${probe_type}`, cause: 'HARNESS_CONFIGURATION', isHarnessError: true });
      }
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({ ok: false, message: `Redis probe timed out after ${timeoutMs}ms`, cause: 'HARNESS_ENVIRONMENT', isHarnessError: true });
    });

    socket.on('error', (err) => {
      resolve({ ok: false, message: `Redis probe error: ${err.message}`, cause: 'HARNESS_ENVIRONMENT', isHarnessError: true });
    });
  });
}

/**
 * Mailpit Message Probe.
 */
export async function probeMailpit({ host = '127.0.0.1', port = 8025, probe_type = 'mail_received', to, subject, contains_text, timeoutMs = 3000 }) {
  const res = await probeHttp({ host, port, path: '/api/v1/messages', timeoutMs });
  if (!res.ok) {
    return { ok: false, message: `Mailpit API unreachable at ${host}:${port} (${res.message})`, cause: 'HARNESS_ENVIRONMENT', isHarnessError: true };
  }

  let messages = [];
  try {
    const data = JSON.parse(res.body);
    messages = data.messages || [];
  } catch {
    return { ok: false, message: 'Failed to parse Mailpit messages response', cause: 'HARNESS_ENVIRONMENT', isHarnessError: true };
  }

  if (probe_type === 'mailpit_inbox_empty') {
    const empty = messages.length === 0;
    return { ok: empty, message: empty ? 'Mailpit inbox empty' : `Mailpit inbox contains ${messages.length} unexpected messages`, cause: empty ? 'NONE' : 'PRODUCT_BUG' };
  }

  if (probe_type === 'mail_received') {
    let matched = messages.some((m) => {
      const toMatch = to ? (m.To || []).some((rec) => rec.Address === to) : true;
      const subjMatch = subject ? (m.Subject || '').includes(subject) : true;
      const textMatch = contains_text ? (m.Snippet || '').includes(contains_text) : true;
      return toMatch && subjMatch && textMatch;
    });

    return {
      ok: matched,
      message: matched ? `Email to "${to || '*'}" with subject "${subject || '*'}" verified in Mailpit` : `No matching email found in Mailpit (Total: ${messages.length})`,
      cause: matched ? 'NONE' : 'PRODUCT_BUG',
    };
  }

  return { ok: false, message: `Unsupported Mailpit probe_type: ${probe_type}`, cause: 'HARNESS_CONFIGURATION', isHarnessError: true };
}

export async function verifySecurityHeaders(originUrl, securityHeaderContract) {
  if (!securityHeaderContract) return { ok: true };
  const parsed = new URL(originUrl);
  const res = await probeHttp({
    host: parsed.hostname,
    port: parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'), 10),
    path: parsed.pathname || '/',
    scheme: parsed.protocol.replace(':', ''),
  });

  if (!res.ok) {
    return { ok: false, error: `Failed to probe origin for headers: ${res.message}` };
  }

  const headers = res.headers;
  const errors = [];

  for (const reqHeader of securityHeaderContract.required || []) {
    const lower = reqHeader.toLowerCase();
    if (!headers[lower]) {
      errors.push(`Missing required security header: ${reqHeader}`);
    }
  }

  for (const forbHeader of securityHeaderContract.forbidden || []) {
    const lower = forbHeader.toLowerCase();
    if (headers[lower]) {
      errors.push(`Found forbidden security header: ${forbHeader} (${headers[lower]})`);
    }
  }

  for (const [key, val] of Object.entries(securityHeaderContract.exact || {})) {
    const actual = headers[key.toLowerCase()];
    if (actual !== val) {
      errors.push(`Header "${key}" mismatch: expected exact "${val}", got "${actual}"`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    headers,
  };
}

/**
 * Universal Fail-Closed Side-Effect Verifier.
 */
export async function verifySideEffect(sideEffect) {
  if (!sideEffect || typeof sideEffect !== 'object') {
    return { ok: false, message: 'Invalid side effect specification', cause: 'HARNESS_CONFIGURATION', isHarnessError: true };
  }

  const { service, probe_type, params = {} } = sideEffect;

  if (service === 'minio' || service === 's3') {
    return probeS3({ ...params, probe_type });
  }

  if (service === 'postgres') {
    return probePostgres({ ...params, probe_type });
  }

  if (service === 'redis') {
    return probeRedis({ ...params, probe_type });
  }

  if (service === 'mailpit') {
    return probeMailpit({ ...params, probe_type });
  }

  // Fail-closed on unknown services or unsupported combinations (no optimistic stubs allowed)
  return {
    ok: false,
    message: `Unsupported side-effect probe combination: service "${service}", probe_type "${probe_type}". Unsupported probes fail closed.`,
    cause: 'HARNESS_CONFIGURATION',
    isHarnessError: true,
  };
}

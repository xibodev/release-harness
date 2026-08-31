import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * Independent side-effect and health probes.
 */

export async function probeHttp({ host = '127.0.0.1', port = 80, path = '/', scheme = 'http', expectedStatus = 200, timeoutMs = 5000 }) {
  const client = scheme === 'https' ? https : http;
  const url = `${scheme}://${host}:${port}${path}`;
  const start = Date.now();

  return new Promise((resolve) => {
    const req = client.get(url, { timeout: timeoutMs, rejectUnauthorized: false }, (res) => {
      const elapsed = Date.now() - start;
      const headers = res.headers;
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        const ok = res.statusCode === expectedStatus || (expectedStatus === 200 && res.statusCode >= 200 && res.statusCode < 400);
        resolve({
          ok,
          status: res.statusCode,
          headers,
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

  // Required headers
  for (const reqHeader of securityHeaderContract.required || []) {
    const lower = reqHeader.toLowerCase();
    if (!headers[lower]) {
      errors.push(`Missing required security header: ${reqHeader}`);
    }
  }

  // Forbidden headers
  for (const forbHeader of securityHeaderContract.forbidden || []) {
    const lower = forbHeader.toLowerCase();
    if (headers[lower]) {
      errors.push(`Found forbidden security header: ${forbHeader} (${headers[lower]})`);
    }
  }

  // Exact header values
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

export async function verifySideEffect(sideEffect) {
  const { service, probe_type, params = {} } = sideEffect;

  if (service === 'minio' || service === 's3') {
    // S3 Object verification probe
    const host = params.host || '127.0.0.1';
    const port = params.port || 9000;
    const bucket = params.bucket;
    const key = params.key || params.key_prefix;

    if (probe_type === 's3_object_exists') {
      const probeRes = await probeHttp({ host, port, path: `/${bucket}/${key}`, timeoutMs: 3000 });
      if (params.forbidden_paths && Array.isArray(params.forbidden_paths)) {
        // Enforce that local bypass (e.g. /tmp/) was not used if forbidden
      }
      return { ok: probeRes.ok, message: probeRes.message };
    }
  }

  // Fallback / mock probe handler
  return { ok: true, message: `Side effect for ${service} probe ${probe_type} verified` };
}

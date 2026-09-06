import http from 'node:http';
import net from 'node:net';

// A browser-scoped forward proxy checks every destination connection, including
// initial popup navigations and redirects. Chromium owns redirects/cookies; HTTP
// is streamed unchanged and TLS is tunneled without inspecting application data.
export async function installNetworkGuard(decide, record, onError) {
  const sockets = new Set();
  let closing = false;
  const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
  const authorize = url => {
    const decision = decide(url);
    record(url, decision);
    return decision.allowed;
  };
  const server = http.createServer((req, res) => {
    try {
      const target = new URL(req.url);
      if (target.protocol !== 'http:' || !authorize(target.href)) {
        res.writeHead(403); res.end('Blocked by release-harness network policy'); return;
      }
      const headers = { ...req.headers, host: target.host };
      delete headers['proxy-connection'];
      delete headers['proxy-authorization'];
      const upstream = http.request(target, { method: req.method, headers, agent: false }, response => {
        res.writeHead(response.statusCode, response.statusMessage, response.rawHeaders);
        response.on('aborted', () => res.destroy());
        response.on('error', () => res.destroy());
        response.on('close', () => { if (!response.complete) res.destroy(); });
        response.pipe(res);
      });
      upstream.on('socket', track);
      upstream.on('error', () => {
        if (res.headersSent) res.destroy();
        else { res.writeHead(502); res.end(); }
      });
      req.on('aborted', () => upstream.destroy());
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    } catch (err) {
      if (!closing) onError(err);
      res.writeHead(502); res.end();
    }
  });
  server.on('connect', (req, client, head) => {
    try {
      const target = new URL(`https://${req.url}`);
      // Chromium also uses CONNECT for plaintext ws. A CONNECT authority alone
      // cannot select a scheme. Acknowledge locally, but connect upstream only
      // after a bounded TLS ClientHello or complete WebSocket upgrade identifies it.
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      let prefix = Buffer.alloc(0);
      const timer = setTimeout(() => client.destroy(), 5000);
      client.once('close', () => clearTimeout(timer));
      const classify = chunk => {
        prefix = Buffer.concat([prefix, chunk]);
        if (prefix.length > 16384) { client.destroy(); return; }
        let url;
        if (prefix[0] === 0x16) {
          if (prefix.length < 6) return;
          if (prefix[1] !== 3 || prefix[2] > 3 || prefix[5] !== 1) { client.destroy(); return; }
          url = target.href;
        } else {
          const end = prefix.indexOf('\r\n\r\n');
          if (end < 0) return;
          const lines = prefix.subarray(0, end).toString('latin1').split('\r\n');
          const request = /^GET (\/[^ ]*) HTTP\/1\.[01]$/.exec(lines.shift());
          const headers = new Map();
          for (const line of lines) {
            const colon = line.indexOf(':');
            if (colon < 1) { client.destroy(); return; }
            const name = line.slice(0, colon).toLowerCase();
            if (headers.has(name)) { client.destroy(); return; }
            headers.set(name, line.slice(colon + 1).trim());
          }
          const authority = headers.get('host');
          if (!request || !authority || headers.get('upgrade')?.toLowerCase() !== 'websocket'
            || !headers.get('connection')?.toLowerCase().split(/\s*,\s*/).includes('upgrade')) { client.destroy(); return; }
          const websocket = new URL(`ws://${authority}${request[1]}`);
          if (websocket.hostname !== target.hostname || Number(websocket.port || 80) !== Number(target.port || 443)) { client.destroy(); return; }
          url = websocket.href;
        }
        client.pause();
        client.removeListener('data', onData);
        clearTimeout(timer);
        if (!authorize(url)) { client.destroy(); return; }
        const upstream = track(net.connect(Number(target.port || 443), target.hostname.replace(/^\[|\]$/g, '')));
        upstream.once('connect', () => {
          upstream.write(prefix);
          client.pipe(upstream); upstream.pipe(client);
          client.resume();
        });
        upstream.on('error', () => client.destroy());
        upstream.on('close', () => client.destroy());
        client.on('error', () => upstream.destroy());
        client.on('close', () => upstream.destroy());
        client.on('end', () => upstream.end());
      };
      const onData = chunk => {
        try { classify(chunk); }
        catch (err) { if (!closing) onError(err); client.destroy(); }
      };
      client.on('data', onData);
      if (head.length) classify(head);
    } catch (err) { if (!closing) onError(err); client.destroy(); }
  });
  server.on('upgrade', (req, client, head) => {
    try {
      const target = new URL(req.url);
      if (!['http:', 'ws:'].includes(target.protocol) || !authorize(target.href.replace(/^http:/, 'ws:'))) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      const upstream = track(net.connect(Number(target.port || 80), target.hostname));
      upstream.once('connect', () => {
        upstream.write(`${req.method} ${target.pathname}${target.search} HTTP/${req.httpVersion}\r\n`);
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          if (!/^proxy-/i.test(req.rawHeaders[i])) upstream.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
        }
        upstream.write('\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
    } catch (err) { if (!closing) onError(err); client.destroy(); }
  });
  server.on('connection', socket => { track(socket); socket.on('error', () => {}); });
  server.on('error', err => { if (!closing) onError(err); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    proxy: { server: `http://127.0.0.1:${server.address().port}`, bypass: '<-loopback>' },
    beginClose() { closing = true; },
    async close() {
      closing = true;
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

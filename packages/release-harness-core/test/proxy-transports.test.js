import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ScenarioRunner, networkDecision } from '../src/scenario-runner.js';
import { installNetworkGuard } from '../src/network-guard.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-transports-'));
const servers = [];
const sockets = new Set();
const listen = async server => {
  servers.push(server);
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
};
const policy = { mode: 'sealed', allowed_egress: [] };
let upgrades = 0;
const upgrade = (req, socket) => {
  upgrades++;
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on('data', () => {});
  socket.on('error', () => {});
};
let udp;
try {
  // Ephemeral test-only identity; no private key is committed or reused.
  const openssl = process.platform === 'win32' && fs.existsSync('C:/Program Files/Git/usr/bin/openssl.exe')
    ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl';
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore', timeout: 15000 });
  const handler = (req, res) => {
    if (req.url === '/interrupted') {
      res.writeHead(200, { 'Content-Length': '100' }); res.write('short');
      setTimeout(() => res.socket?.destroy(), 20); return;
    }
    res.setHeader('Content-Type', 'text/html'); res.end('<html><body>transport test</body></html>');
  };
  const plain = http.createServer(handler); plain.on('upgrade', upgrade);
  const plainPort = await listen(plain);
  const tls = https.createServer({ key: fs.readFileSync(path.join(root, 'key.pem')), cert: fs.readFileSync(path.join(root, 'cert.pem')) }, handler);
  tls.on('upgrade', upgrade);
  const tlsPort = await listen(tls);
  const other = http.createServer(handler); other.on('upgrade', upgrade);
  const otherPort = await listen(other);
  const otherTls = https.createServer({ key: fs.readFileSync(path.join(root, 'key.pem')), cert: fs.readFileSync(path.join(root, 'cert.pem')) }, handler);
  otherTls.on('upgrade', upgrade);
  const otherTlsPort = await listen(otherTls);
  const scenario = { id: 'transport', name: 'Transport', origin_id: 'web', tier: 'smoke', policy: 'required', steps: [{ action: 'navigate', target: '/' }, { action: 'extension:test' }] };
  async function run(base, operation, extraOrigins = [], networkPolicy = policy) {
    const runner = new ScenarioRunner({ origins: [{ origin_id: 'web', url_source: base }, ...extraOrigins], networkPolicy, evidenceDir: root, customExtensions: { test: operation } });
    if (process.env.RELEASE_HARNESS_TEST_PLAYWRIGHT_PACKAGE) runner.playwright = createRequire(process.env.RELEASE_HARNESS_TEST_PLAYWRIGHT_PACKAGE)('playwright');
    const result = await runner.runScenario(scenario);
    assert.equal(result.failed, false, result.error_message);
    assert.ok(!result.is_harness_error, result.error_message);
    return result;
  }
  const wsAttempt = async (page, url) => page.evaluate(url => new Promise(resolve => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => { socket.close(); resolve('timeout'); }, 3000);
    socket.onopen = () => { clearTimeout(timer); socket.close(); resolve('open'); };
    socket.onerror = socket.onclose = () => { clearTimeout(timer); resolve('denied'); };
  }), url);
  const plainBase = `http://127.0.0.1:${plainPort}`;
  const tlsBase = `https://127.0.0.1:${tlsPort}`;
  let before = upgrades;
  console.log('Testing plaintext WebSocket through Chromium CONNECT...');
  const ws = await run(plainBase, async page => assert.equal(await wsAttempt(page, `ws://127.0.0.1:${plainPort}/ws`), 'open'));
  assert.equal(upgrades, before + 1);
  assert.equal(ws.network_violations.length, 0);
  before = upgrades;
  console.log('Testing TLS WebSocket through Chromium CONNECT...');
  const wss = await run(tlsBase, async page => assert.equal(await wsAttempt(page, `wss://127.0.0.1:${tlsPort}/ws`), 'open'));
  assert.equal(upgrades, before + 1);
  assert.equal(wss.network_violations.length, 0);
  for (const [base, url] of [[plainBase, `ws://127.0.0.1:${otherPort}/ws`], [tlsBase, `wss://127.0.0.1:${otherTlsPort}/ws`]]) {
    before = upgrades;
    const denied = await run(base, async page => assert.equal(await wsAttempt(page, url), 'denied'));
    assert.equal(upgrades, before);
    assert.ok(denied.network_violations.length);
  }
  // No browser mixed-content assumption: a plaintext WS upgrade through CONNECT
  // to an HTTPS-only declared authority must be rejected before upstream connect.
  let upstreamConnections = 0;
  const countConnections = () => upstreamConnections++;
  plain.on('connection', countConnections);
  const observations = [];
  const guard = await installNetworkGuard(url => networkDecision(url, policy, [`https://127.0.0.1:${plainPort}`]), (url, result) => observations.push({ url, ...result }), err => { throw err; });
  try {
    await new Promise((resolve, reject) => {
      const client = net.connect(Number(new URL(guard.proxy.server).port), '127.0.0.1');
      client.setTimeout(3000, () => { client.destroy(); reject(new Error('CONNECT downgrade hung')); });
      client.on('connect', () => client.write(`CONNECT 127.0.0.1:${plainPort} HTTP/1.1\r\nHost: 127.0.0.1:${plainPort}\r\n\r\n`));
      client.once('data', () => client.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${plainPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
      client.on('close', resolve); client.on('error', reject);
    });
    assert.equal(upstreamConnections, 0);
    assert.equal(observations.at(-1).allowed, false);
  } finally { guard.beginClose(); await guard.close(); plain.removeListener('connection', countConnections); }
  // Actual browser request to a plaintext endpoint listed only as HTTPS.
  const downgrade = await run(plainBase, async page => {
    const outcome = await page.evaluate(async url => { try { const res = await fetch(url); return res.status; } catch { return 'rejected'; } }, `http://127.0.0.1:${otherPort}/`);
    assert.notEqual(outcome, 200);
  }, [{ origin_id: 'secure-only', url_source: `https://127.0.0.1:${otherPort}` }]);
  assert.ok(downgrade.network_violations.some(v => v.port === otherPort));
  console.log('PASS: real TLS/WS/WSS allowed+denied and HTTPS-only plaintext downgrade rejection');

  await run(plainBase, async page => {
    const outcome = await page.evaluate(async () => Promise.race([
      fetch('/interrupted').then(res => res.text()).then(() => 'unexpected-success', () => 'rejected'),
      new Promise(resolve => setTimeout(() => resolve('hung'), 2000)),
    ]));
    assert.equal(outcome, 'rejected');
  });
  console.log('PASS: interrupted upstream response rejects browser body promptly');

  udp = dgram.createSocket('udp4');
  await new Promise(resolve => udp.bind(0, '127.0.0.1', resolve));
  let packets = 0;
  udp.on('message', () => packets++);
  const stunAttempt = async page => {
    const supported = await page.evaluate(async port => {
      if (!globalThis.RTCPeerConnection) return false;
      const pc = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }] });
      pc.createDataChannel('probe');
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise(resolve => setTimeout(resolve, 1500));
      pc.close(); return true;
    }, udp.address().port);
    assert.equal(supported, true);
  };
  await run(plainBase, stunAttempt);
  assert.equal(packets, 0, 'Sealed Chromium must send no non-proxied STUN UDP packets');
  await run(plainBase, stunAttempt, [], { mode: 'open' });
  assert.ok(packets > 0, 'Positive control: this actual Chromium/STUN fixture must emit UDP when unsealed');
  console.log('PASS: actual RTCPeerConnection/STUN reaches no undeclared UDP listener');
} finally {
  udp?.close();
  for (const socket of sockets) socket.destroy();
  for (const server of servers) await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}

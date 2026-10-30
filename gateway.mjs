// Obsidian MCP gateway: bearer-token gate in front of supergateway,
// which bridges the official filesystem MCP server (stdio) to
// Streamable HTTP. supergateway does not validate inbound tokens,
// so this proxy is the auth layer. Inner port is loopback-only.
import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const TOKEN = process.env.MCP_TOKEN || '';
const PUBLIC_PORT = 8080;
const INNER_PORT = 18081;

if (!TOKEN) {
  console.error('MCP_TOKEN env is required');
  process.exit(1);
}

const child = spawn('supergateway', [
  '--stdio', 'mcp-server-filesystem /vault',
  '--outputTransport', 'streamableHttp',
  '--port', String(INNER_PORT),
  '--host', '127.0.0.1',
], { stdio: 'inherit' });
child.on('exit', (code) => {
  console.error('supergateway exited with', code);
  process.exit(1);
});

function tokenOk(req) {
  const given = Buffer.from(req.headers['authorization'] || '');
  const expected = Buffer.from('Bearer ' + TOKEN);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// Browser-based clients and connection-check pages call this gateway
// cross-origin, so every response carries CORS headers and OPTIONS
// preflights are answered here (preflight requests carry no token).
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  if (req.url === '/' || req.url === '/healthz') {
    // Landing and health probe. Generic API-key connection checks
    // often probe the host root, so answer 200 here. This reveals
    // nothing sensitive and never touches the vault.
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: true, service: 'obsidian-mcp', mcp: '/mcp' }));
    return;
  }
  if (!req.url.startsWith('/mcp')) {
    res.writeHead(404);
    res.end();
    return;
  }
  if (!tokenOk(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  if (req.method === 'GET') {
    // Stateless gateway: there is no SSE stream to open on GET.
    // Answer capability probes with a small descriptor instead of
    // supergateway's 405. MCP clients use POST, which is proxied.
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ ok: true, transport: 'streamable-http', methods: ['POST'] }));
    return;
  }
  const upstream = http.request(
    { host: '127.0.0.1', port: INNER_PORT, path: req.url, method: req.method, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode, { ...up.headers, 'Access-Control-Allow-Origin': '*' });
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});

server.listen(PUBLIC_PORT, '0.0.0.0', () => {
  console.log('obsidian-mcp gateway listening on', PUBLIC_PORT);
});

process.on('SIGTERM', () => {
  child.kill('SIGTERM');
  process.exit(0);
});

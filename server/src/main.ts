// Entry point: starts `opencode serve`, the sync engine, and the remote UI.
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { Auth, SESSION_COOKIE, parseCookies } from './auth.ts';
import { loadConfig, saveConfig } from './config.ts';
import { OpenCode } from './opencode.ts';
import { Relay } from './relay.ts';
import { Store } from './store.ts';
import { getTailscaleIPv4, resolveListenHost } from './tailscale.ts';
import { handleRequest, type ApiContext } from './api.ts';
import { acceptKey, proxyPty } from './ws.ts';
import { asId, normalizeDir, withinAllowlist } from './validate.ts';

const MIN_NODE = 22;

function nodeMajor(): number {
  const m = process.version.match(/^v(\d+)/);
  return m ? Number(m[1]) : 0;
}

function isLoopbackAddr(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
}

async function main(): Promise<void> {
  if (nodeMajor() < MIN_NODE) {
    console.error(`OpenCode Remote needs Node.js ${MIN_NODE}+ (found ${process.version}).`);
    process.exit(1);
  }
  const { config, secretsPath, hostExplicit } = loadConfig();

  // Fail safe: never bind a non-loopback interface without authentication.
  const envPw = process.env.OCR_PASSWORD;
  if (!isLoopbackAddr(config.host) && hostExplicit && !config.passwordHash && !envPw) {
    console.error(
      `Refusing to listen on ${config.host} without a password. Set one via OCR_PASSWORD, or keep OCR_HOST=127.0.0.1 and use the loopback setup screen.`,
    );
    process.exit(1);
  }
  if (envPw && !config.passwordHash) {
    if (envPw.length < 12) {
      console.error('OCR_PASSWORD must be at least 12 characters.');
      process.exit(1);
    }
    const { hashPassword } = await import('./config.ts');
    config.passwordHash = hashPassword(envPw);
    config.passwordSetAt = Date.now();
    delete process.env.OCR_PASSWORD;
    saveConfig(secretsPath, config);
    console.log('Adopted initial password from OCR_PASSWORD.');
  }

  const store = new Store(config.dataDir);
  const auth = new Auth(config, () => saveConfig(secretsPath, config));
  const oc = new OpenCode();
  const relay = new Relay(oc, config, store);

  console.log('Starting managed OpenCode server…');
  try {
    await oc.start();
  } catch (e) {
    console.error(`Could not start opencode: ${(e as Error).message}`);
    console.error('Is the OpenCode CLI installed? See README “Prerequisites”.');
    process.exit(1);
  }
  console.log(`OpenCode server ready (version ${oc.getVersion()}).`);
  relay.start();

  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
  const webRoot = path.join(root, 'web');
  let appVersion = '0.0.0';
  try {
    const pkg = JSON.parse((await import('node:fs')).readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string };
    if (pkg.version) appVersion = pkg.version;
  } catch {
    /* version stays unknown */
  }
  const ctx: ApiContext = {
    config,
    secretsPath,
    auth,
    oc,
    relay,
    store,
    webRoot,
    saveSettings: () => saveConfig(secretsPath, config),
    appVersion,
  };

  const servers: http.Server[] = [];
  const makeServer = (): http.Server => {
    const server = http.createServer((req, res) => {
      // Safety net: no request may ever crash the process.
      void handleRequest(ctx, req, res).catch((e) => {
        console.error('[api] unhandled:', (e as Error)?.message || e);
        try {
          if (!res.writableEnded) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 'internal', message: 'Internal error' } }));
          }
        } catch {
          /* ignore */
        }
      });
    });

    server.on('upgrade', (req, socket) => {
      void handleTerminalUpgrade(ctx, req, socket as unknown as import('node:net').Socket).catch(() => {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      });
    });
    servers.push(server);
    return server;
  };

  oc.onStatusChange((healthy) => {
    relay.emit('health', { ok: healthy });
    if (!healthy) {
      console.error('Managed OpenCode server died — phone clients will show disconnected. Restarting…');
      void oc.start().then(() => relay.emit('health', { ok: true })).catch(() => undefined);
    }
  });

  // Binding: always loopback (laptop browser + setup), plus the Tailnet IP
  // when it is safe (password configured) — never LAN-wide, never public.
  // Explicit OCR_HOST/config wins and replaces the whole set. A stale or
  // unreachable Tailnet IP degrades to loopback instead of crashing.
  const tailscaleIP = await getTailscaleIPv4();
  const hasPassword = !!config.passwordHash;
  const decision = resolveListenHost(hostExplicit ? config.host : undefined, '127.0.0.1', tailscaleIP, hasPassword);
  let hosts: string[];
  if (hostExplicit) {
    // An explicit address is added to loopback, never a replacement for it —
    // the laptop browser must keep working. 0.0.0.0 already covers loopback.
    hosts = isLoopbackAddr(config.host) || config.host === '0.0.0.0' ? [config.host] : ['127.0.0.1', config.host];
  } else if (decision.host !== '127.0.0.1' && tailscaleIP) {
    hosts = ['127.0.0.1', tailscaleIP];
  } else {
    hosts = ['127.0.0.1'];
  }
  if (hosts.length > 1) {
    console.log(`Network: listening on loopback + tailscale ${tailscaleIP} (password is set).`);
    console.log('Windows may ask you to allow Node.js through the firewall once — click Allow.');
  } else if (tailscaleIP) {
    console.log(`Network: ${decision.note}.`);
  }
  ctx.listenHost = hosts[hosts.length - 1];

  const bound: string[] = [];
  let settled = 0;
  const onListening = (): void => {
    if (settled < hosts.length) return; // print once every interface settled
    ctx.listenHost = bound[bound.length - 1] || '127.0.0.1';
    console.log('');
    console.log(`OpenCode Remote is running: http://127.0.0.1:${config.port}`);
    if (tailscaleIP && bound.includes(tailscaleIP)) {
      console.log(`Phone URL (Tailscale): http://${tailscaleIP}:${config.port}`);
    }
    if (auth.setupRequired) {
      console.log('First run: open the URL above ON THIS LAPTOP to set your remote password.');
    } else {
      console.log('Open the phone setup (Connection tab) for the Tailscale URL.');
    }
    console.log('Press Ctrl+C to stop.');
  };

  const tryListen = (remaining: string[]): void => {
    if (!remaining.length) {
      if (!bound.length) {
        console.error('Could not bind any interface — is the port already in use?');
        process.exit(1);
      }
      onListening();
      return;
    }
    const [host, ...rest] = remaining;
    const server = makeServer();
    const onError = (err: Error & { code?: string }): void => {
      if ((err.code === 'EADDRNOTAVAIL' || err.code === 'EADDRNOTUSE') && !hostExplicit) {
        console.error(`Could not bind ${host} (${err.code}) — continuing without it.`);
        settled++;
        tryListen(rest);
        return;
      }
      console.error(`Could not listen on ${host}:${config.port}: ${err.message}`);
      process.exit(1);
    };
    server.once('error', onError);
    server.listen(config.port, host, () => {
      server.removeListener('error', onError);
      bound.push(host);
      settled++;
      if (rest.length) tryListen(rest);
      else onListening();
    });
  };
  tryListen(hosts);

  const shutdown = (): void => {
    console.log('\nStopping…');
    relay.stop();
    for (const s of servers) {
      try {
        s.closeAllConnections();
        s.close();
      } catch {
        /* ignore */
      }
    }
    void oc.stop().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function handleTerminalUpgrade(ctx: ApiContext, req: import('node:http').IncomingMessage, socket: net.Socket): Promise<void> {
  const deny = (): void => {
    try {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
    } catch {
      /* ignore */
    }
  };
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const m = url.pathname.match(/^\/api\/ptys\/([^/]+)\/connect$/);
    if (!m || (req.headers.upgrade || '').toLowerCase() !== 'websocket') return deny();
    const key = req.headers['sec-websocket-key'];
    if (!key || Array.isArray(key)) return deny();
    const cookies = parseCookies(req.headers.cookie);
    if (!ctx.auth.verify(cookies[SESSION_COOKIE])) return deny();
    const ptyID = asId(decodeURIComponent(m[1]), 'pty', 'pty');
    // Directory must be supplied explicitly and allowlisted — never inferred.
    const dirParam = url.searchParams.get('directory');
    if (!dirParam) return deny();
    let dir = normalizeDir(dirParam);
    if (!withinAllowlist(dir, ctx.config.projects)) return deny();
    const cursorParam = url.searchParams.get('cursor');
    const cursor = cursorParam === null || cursorParam === '' ? undefined : Number(cursorParam);
    // Complete the WS handshake, then bridge to the native PTY socket.
    const accept = acceptKey(key);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    await proxyPty(socket, {
      oc: ctx.oc,
      ptyID,
      directory: dir,
      cursor: cursor !== undefined && Number.isSafeInteger(cursor) && cursor >= -1 ? cursor : undefined,
      upstreamAuth: ctx.oc.upstreamAuth(),
      onResize: async (rows, cols) => {
        await ctx.oc.ptyUpdate(ptyID, dir, { size: { rows, cols } });
      },
    });
  } catch {
    deny();
  }
}

export { handleTerminalUpgrade };

import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error('Fatal:', (e as Error).message);
    process.exit(1);
  });
}

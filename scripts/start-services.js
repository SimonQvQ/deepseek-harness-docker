// Keep DSH's browser authentication on the loopback hop behind Caddy.
// The launch token and signed cookie never need to reach the user's browser.
const { spawn } = require('node:child_process');
const { mkdir, writeFile, rename } = require('node:fs/promises');
const { dirname } = require('node:path');
const { createInterface } = require('node:readline');
const { setTimeout: delay } = require('node:timers/promises');

function launchToken(line) {
  if (!line.includes('dsh web:')) return undefined;
  const address = line.match(/https?:\/\/\S+/)?.[0];
  if (!address) return undefined;
  try { return new URL(address).searchParams.get('token') || undefined; }
  catch { return undefined; }
}

async function request(url, cookie = '') {
  return fetch(url, {
    redirect: 'manual',
    headers: cookie ? { Cookie: cookie } : {},
    signal: AbortSignal.timeout(5000),
  });
}

async function exchangeSession(baseUrl, token) {
  let cookie = '';
  if (token) {
    const url = new URL('/', baseUrl);
    url.searchParams.set('token', token);
    const exchange = await request(url);
    await exchange.body?.cancel();
    if (exchange.status !== 303) throw new Error('DSH launch-token exchange failed');
    cookie = (exchange.headers.getSetCookie?.() || [])
      .map(value => value.split(';', 1)[0])
      .filter(value => /^dsh-auth-[A-Za-z0-9_-]+=/.test(value))
      .join('; ');
    if (!cookie) throw new Error('DSH did not issue a browser-session cookie');
  }
  // A 401 must never count as readiness; older DSH releases need no cookie.
  const page = await request(baseUrl, cookie);
  await page.body?.cancel();
  if (page.status !== 200) throw new Error(`DSH homepage returned HTTP ${page.status}`);
  return cookie;
}

function caddyCommand(args, cookie, config) {
  return spawn('caddy', [...args, '--config', config, '--adapter', 'caddyfile'], {
    stdio: 'inherit',
    env: { ...process.env, DSH_BROWSER_COOKIE: cookie },
  });
}

async function startServices({
  dshBin = '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
  config = '/etc/caddy/Caddyfile',
  authFile = process.env.DSH_AUTH_FILE || '/run/dsh-auth/cookie',
  refreshIntervalMs = 15 * 60 * 1000,
} = {}) {
  const host = process.env.DSH_HOST || '127.0.0.1';
  const port = process.env.DSH_PORT || '3079';
  const baseUrl = `http://${host.includes(':') ? `[${host}]` : host}:${port}/`;
  let token;
  let proxy;
  let refresh;
  let stopping = false;
  const dsh = spawn(process.execPath, [
    '--expose-internals', dshBin, 'web', '--host', host, '--port', port, '--no-open',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  function stop(code) {
    if (stopping) return;
    stopping = true;
    clearInterval(refresh);
    process.exitCode = code;
    for (const child of [dsh, proxy]) {
      if (!child || child.exitCode !== null || child.signalCode !== null) continue;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      timer.unref();
      child.once('exit', () => clearTimeout(timer));
    }
  }

  process.once('SIGTERM', () => stop(0));
  process.once('SIGINT', () => stop(0));
  dsh.once('error', () => { console.error('Unable to start DSH'); stop(1); });
  dsh.once('exit', code => {
    if (!stopping) { console.error('DSH exited unexpectedly'); stop(code || 1); }
  });
  for (const stream of [dsh.stdout, dsh.stderr]) {
    const lines = createInterface({ input: stream });
    lines.on('line', line => {
      const nextToken = launchToken(line);
      if (nextToken) token = nextToken;
      // Do not publish a launch URL containing the credential in container logs.
      console.log(line.replace(/([?&]token=)[^\s&]+/g, '$1[redacted]'));
    });
  }

  try {
    console.log('Waiting for an authenticated DSH homepage...');
    let cookie;
    const deadline = Date.now() + 60000;
    while (!stopping && Date.now() < deadline) {
      try { cookie = await exchangeSession(baseUrl, token); break; }
      catch { await delay(500); }
    }
    if (stopping) return;
    if (cookie === undefined) throw new Error('DSH was not ready within 60 seconds');

    async function saveCookie(value) {
      await mkdir(dirname(authFile), { recursive: true, mode: 0o700 });
      await writeFile(`${authFile}.tmp`, value, { mode: 0o600 });
      await rename(`${authFile}.tmp`, authFile);
    }
    await saveCookie(cookie);
    proxy = caddyCommand(['run'], cookie, config);
    proxy.once('error', () => { console.error('Unable to start Caddy'); stop(1); });
    proxy.once('exit', code => {
      if (!stopping) { console.error('Caddy exited unexpectedly'); stop(code || 1); }
    });
    console.log('DSH is ready; starting Caddy.');

    // Renew before cookie expiry, without restarting DSH or interrupting sessions.
    let refreshing = false;
    refresh = setInterval(async () => {
      if (refreshing || stopping || !token) return;
      refreshing = true;
      try {
        const renewed = await exchangeSession(baseUrl, token);
        const reload = caddyCommand(['reload'], renewed, config);
        const timeout = setTimeout(() => reload.kill('SIGTERM'), 10000);
        await new Promise((resolve, reject) => {
          reload.once('error', reject);
          reload.once('exit', code => code === 0 ? resolve() : reject(new Error('Caddy reload failed')));
        }).finally(() => clearTimeout(timeout));
        await saveCookie(renewed);
      } catch {
        console.error('WARNING: DSH session refresh failed; will retry.');
      } finally { refreshing = false; }
    }, refreshIntervalMs);
  } catch (error) {
    console.error(error.message);
    stop(1);
  }
}

module.exports = { launchToken, exchangeSession, startServices };
if (require.main === module) startServices();

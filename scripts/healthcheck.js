const { readFile } = require('node:fs/promises');

(async () => {
  const cookie = await readFile(process.env.DSH_AUTH_FILE || '/run/dsh-auth/cookie', 'utf8');
  const host = process.env.DSH_HOST || '127.0.0.1';
  const response = await fetch(`http://${host.includes(':') ? `[${host}]` : host}:${process.env.DSH_PORT || '3079'}/`, {
    headers: cookie ? { Cookie: cookie } : {},
    redirect: 'manual',
    signal: AbortSignal.timeout(4000),
  });
  await response.body?.cancel();
  process.exitCode = response.status === 200 ? 0 : 1;
})().catch(() => { process.exitCode = 1; });

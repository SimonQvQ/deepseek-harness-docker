const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { exchangeSession, launchToken } = require('../scripts/start-services.js');

async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}/`;
}

test('exchange the process token and verify the signed cookie on the homepage', async t => {
  const seen = [];
  const url = await serve(t, (req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie });
    if (req.url === '/?token=process-token') {
      res.writeHead(303, {
        location: './',
        'set-cookie': ['unrelated=ignore; Path=/', 'dsh-auth-test=signed-value; HttpOnly; Path=/'],
      });
    } else if (req.headers.cookie === 'dsh-auth-test=signed-value') {
      res.writeHead(200, { 'content-type': 'text/html' });
    } else { res.writeHead(401); }
    res.end();
  });
  assert.equal(await exchangeSession(url, 'process-token'), 'dsh-auth-test=signed-value');
  assert.deepEqual(seen, [
    { url: '/?token=process-token', cookie: undefined },
    { url: '/', cookie: 'dsh-auth-test=signed-value' },
  ]);
});

test('unauthenticated 401 is never accepted as readiness', async t => {
  const url = await serve(t, (_, res) => { res.writeHead(401); res.end(); });
  await assert.rejects(exchangeSession(url), /HTTP 401/);
  await assert.rejects(exchangeSession(url, 'invalid'), /exchange failed/);
});

test('a redirect without a DSH cookie fails closed', async t => {
  const url = await serve(t, (_, res) => {
    res.writeHead(303, { location: './', 'set-cookie': 'unrelated=value; Path=/' });
    res.end();
  });
  await assert.rejects(exchangeSession(url, 'token'), /did not issue/);
});

test('a cookie rejected by DSH fails readiness', async t => {
  const url = await serve(t, (req, res) => {
    if (req.url.includes('token=')) {
      res.writeHead(303, { 'set-cookie': 'dsh-auth-test=expired; Path=/' });
    } else { res.writeHead(401); }
    res.end();
  });
  await assert.rejects(exchangeSession(url, 'token'), /HTTP 401/);
});

test('support older DSH versions with an unauthenticated homepage', async t => {
  const url = await serve(t, (_, res) => { res.writeHead(200); res.end('<html></html>'); });
  assert.equal(await exchangeSession(url), '');
});

test('take launch tokens only from the DSH announcement', () => {
  assert.equal(launchToken('dsh web: http://127.0.0.1:3079/?token=abc_DEF-123'), 'abc_DEF-123');
  assert.equal(launchToken('dsh web: http://[::1]:3079/?token=ipv6-token'), 'ipv6-token');
  assert.equal(launchToken('dsh web: http://localhost:3079/'), undefined);
  assert.equal(launchToken('visit http://example.com/?token=unrelated'), undefined);
});

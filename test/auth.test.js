import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { closeDatabases, openDatabase, writeJob } from '../src/database.js';

async function testSecondaryPasskeyOptions(context) {
  const envKeys = ['PASSKEY_RP_ID', 'PASSKEY_ORIGIN', 'PASSKEY_RP_ID_SECONDARY', 'PASSKEY_ORIGIN_SECONDARY'];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.PASSKEY_RP_ID = 'music.example.com';
  process.env.PASSKEY_ORIGIN = 'https://music.example.com';
  process.env.PASSKEY_RP_ID_SECONDARY = '192-168-6-66.sslip.io';
  process.env.PASSKEY_ORIGIN_SECONDARY = 'https://192-168-6-66.sslip.io:4123';
  const { registerAuthRoutes } = await import('../src/auth.js');
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(async () => {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [origin, expectedRPID] of [
    [undefined, process.env.PASSKEY_RP_ID],
    [process.env.PASSKEY_ORIGIN, process.env.PASSKEY_RP_ID],
    [process.env.PASSKEY_ORIGIN_SECONDARY, process.env.PASSKEY_RP_ID_SECONDARY],
    ['https://192-168-6-66.sslip.io:4124', process.env.PASSKEY_RP_ID],
    ['https://untrusted.example', process.env.PASSKEY_RP_ID]
  ]) {
    for (const flow of ['register', 'login']) {
      const response = await fetch(`${base}/api/auth/${flow}/options`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify({ name: 'Local listener' })
      });
      assert.equal(response.status, 200);
      const { options, requestId } = await response.json();
      await fetch(`${base}/api/auth/${flow}/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId })
      });
      assert.equal(flow === 'register' ? options.rp.id : options.rpId, expectedRPID);
    }
  }
  for (const missingKey of ['PASSKEY_RP_ID_SECONDARY', 'PASSKEY_ORIGIN_SECONDARY']) {
    const value = process.env[missingKey];
    delete process.env[missingKey];
    const response = await fetch(`${base}/api/auth/login/options`, { method: 'POST' });
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /Set both/);
    process.env[missingKey] = value;
  }
  process.env.PASSKEY_RP_ID_SECONDARY = '192.168.6.66';
  const invalidRPID = await fetch(`${base}/api/auth/login/options`, {
    method: 'POST', headers: { Origin: process.env.PASSKEY_ORIGIN_SECONDARY }
  });
  assert.equal(invalidRPID.status, 500);
  assert.match((await invalidRPID.json()).error, /hostname, not an IP address/);
}

test('PAT HTTP lifecycle and user/admin authorization', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-pat-http-'));
  process.env.DATABASE_PATH = path.join(directory, 'test.sqlite');
  process.env.AUTH_STORE_PATH = path.join(directory, 'auth.json');
  process.env.JOB_STORE_PATH = path.join(directory, 'jobs.json');
  const store = await import('../src/authStore.js');
  const { attachUser, registerAuthRoutes, requireAuth } = await import('../src/auth.js');
  const credential = (id) => ({ id, publicKey: Buffer.from(id), counter: 0 });
  const admin = await store.registerUser('Admin', 'admin', credential('admin'));
  const user = await store.registerUser('Listener', 'listener', credential('listener'));
  await store.updateUser(user.id, { status: 'approved' }, admin.id);
  const adminSession = await store.createSession(admin.id);
  const userSession = await store.createSession(user.id);
  const adminHeaders = { Cookie: `ssytdlp_session=${adminSession.token}` };
  const userHeaders = { Cookie: `ssytdlp_session=${userSession.token}` };
  const app = express();
  app.use(express.json(), attachUser);
  registerAuthRoutes(app);
  app.post('/protected', requireAuth, (req, res) => res.json({ userId: req.user.id }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    closeDatabases();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (url, method = 'GET', headers = {}, body) => fetch(`${base}${url}`, {
    method, headers: { ...headers, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const mobileSession = await store.createSession(user.id);
  const mobileHeaders = { Authorization: `Bearer ${mobileSession.token}` };
  assert.deepEqual(await (await call('/protected', 'POST', mobileHeaders)).json(), { userId: user.id });
  assert.equal((await (await call('/api/auth/me', 'GET', mobileHeaders)).json()).user.id, user.id);
  assert.equal((await call('/api/auth/pats', 'GET', mobileHeaders)).status, 200);
  assert.equal((await call('/api/admin/users', 'GET', mobileHeaders)).status, 403);
  assert.equal((await call('/protected', 'POST', { ...userHeaders, Authorization: 'Bearer invalid' })).status, 401);
  assert.equal((await call('/protected', 'POST', { ...userHeaders, Authorization: `Basic ${mobileSession.token}` })).status, 401);
  const mobileLogout = await call('/api/auth/logout', 'POST', { ...userHeaders, ...mobileHeaders });
  assert.equal(mobileLogout.status, 204);
  assert.equal(mobileLogout.headers.get('set-cookie'), null);
  assert.equal((await call('/protected', 'POST', mobileHeaders)).status, 401);
  assert.equal((await call('/protected', 'POST', userHeaders)).status, 200);
  assert.equal((await call('/api/auth/pats', 'POST', {}, { name: 'No login' })).status, 401);
  assert.equal((await call('/api/auth/pats', 'POST', userHeaders, { name: ' ' })).status, 400);
  const created = await call('/api/auth/pats', 'POST', userHeaders, { name: 'Automation' });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const pat = await created.json();
  const patHeaders = { 'X-PAT': pat.token };
  assert.deepEqual(await (await call('/protected', 'POST', patHeaders)).json(), { userId: user.id });
  assert.equal((await call('/protected', 'POST', { Authorization: `Bearer ${pat.token}` })).status, 401);
  assert.equal((await call('/protected', 'POST', { ...userHeaders, 'X-PAT': 'bad' })).status, 401);
  assert.equal((await call('/api/auth/pats', 'POST', patHeaders, { name: 'Chained' })).status, 401);
  assert.equal((await call('/api/auth/api-token', 'POST', userHeaders)).status, 404);
  const listed = await (await call('/api/auth/pats', 'GET', userHeaders)).json();
  assert.deepEqual(listed.tokens, [{ id: pat.id, name: pat.name, createdAt: pat.createdAt }]);
  assert.equal((await call(`/api/auth/pats/${pat.id}`, 'DELETE', adminHeaders)).status, 404);
  assert.equal((await call(`/api/admin/users/${admin.id}`, 'GET', userHeaders)).status, 403);
  assert.equal((await call(`/api/admin/users/${user.id}/pats/${pat.id}`, 'DELETE', userHeaders)).status, 403);
  const details = await (await call(`/api/admin/users/${user.id}`, 'GET', adminHeaders)).json();
  assert.equal(details.user.id, user.id);
  assert.deepEqual(details.tokens, listed.tokens);
  assert.equal((await call(`/api/admin/users/missing`, 'GET', adminHeaders)).status, 404);
  assert.equal((await call(`/api/admin/users/${user.id}/pats/${pat.id}`, 'DELETE', adminHeaders)).status, 204);
  assert.equal((await call('/protected', 'POST', patHeaders)).status, 401);
  const second = await (await call('/api/auth/pats', 'POST', userHeaders, { name: 'Laptop' })).json();
  assert.equal((await call(`/api/auth/pats/${second.id}`, 'DELETE', userHeaders)).status, 204);
  assert.equal((await call('/protected', 'POST', { 'X-PAT': second.token })).status, 401);

  await context.test('admin user deletion removes account access, protects admins, and preserves jobs', async () => {
    const target = await store.registerUser('Delete Listener', 'delete-listener', credential('delete-listener'));
    await store.updateUser(target.id, { status: 'approved' }, admin.id);
    const session = await store.createSession(target.id);
    const mobile = await store.createSession(target.id);
    const token = await store.createPrivateAccessToken(target.id, 'Delete token');
    const adminToken = await store.createPrivateAccessToken(admin.id, 'Admin automation');
    const route = `/api/admin/users/${target.id}`;
    const database = openDatabase();
    database.prepare('INSERT INTO user_preferences (user_id) VALUES (?)').run(target.id);
    database.prepare('INSERT INTO library_backups (user_id) VALUES (?)').run(target.id);
    const backup = database.prepare('SELECT * FROM library_backups WHERE user_id = ?').get(target.id);
    const job = { id: 'retained-job', url: 'https://example.com/music', status: 'completed', initiatedBy: target };
    writeJob(database, job);

    assert.equal((await call(route, 'DELETE')).status, 401);
    assert.equal((await call(route, 'DELETE', userHeaders)).status, 403);
    assert.equal((await call(route, 'DELETE', { 'X-PAT': adminToken.token })).status, 401);
    assert.equal((await call(route, 'DELETE', { ...userHeaders, 'X-PAT': adminToken.token })).status, 403);
    assert.ok(store.getUser(target.id));
    const selfDelete = await call(`/api/admin/users/${admin.id}`, 'DELETE', adminHeaders);
    assert.equal(selfDelete.status, 409);
    assert.match((await selfDelete.json()).error, /own account/);
    await assert.rejects(store.deleteUser(admin.id, user.id), /At least one approved admin/);
    assert.ok(store.getSessionUser(adminSession.token));
    assert.equal((await call('/api/admin/users/missing', 'DELETE', adminHeaders)).status, 404);

    const deleted = await call(route, 'DELETE', adminHeaders);
    assert.equal(deleted.status, 204);
    assert.equal(deleted.headers.get('cache-control'), 'no-store');
    assert.equal(await deleted.text(), '');
    assert.equal(store.getUser(target.id), null);
    assert.equal(store.findCredential('delete-listener'), null);
    for (const table of ['credentials', 'sessions', 'private_access_tokens', 'user_preferences']) {
      assert.equal(database.prepare(`SELECT count(*) AS count FROM ${table} WHERE user_id = ?`).get(target.id).count, 0);
    }
    assert.deepEqual(database.prepare('SELECT * FROM library_backups WHERE user_id = ?').get(target.id), backup);
    for (const headers of [{ Cookie: `ssytdlp_session=${session.token}` }, { Authorization: `Bearer ${mobile.token}` }, { 'X-PAT': token.token }]) {
      assert.equal((await call('/protected', 'POST', headers)).status, 401);
    }
    assert.equal((await call(route, 'GET', adminHeaders)).status, 404);
    assert.equal((await call(route, 'DELETE', adminHeaders)).status, 404);
    assert.equal((await (await call('/api/admin/users', 'GET', adminHeaders)).json()).users.some((account) => account.id === target.id), false);
    assert.deepEqual(JSON.parse(database.prepare('SELECT data FROM jobs WHERE id = ?').get(job.id).data), job);
    assert.equal((await call('/protected', 'POST', userHeaders)).status, 200);

    for (const status of ['pending', 'revoked', 'approved']) {
      const account = await store.registerUser(`Delete ${status}`, status, credential(`delete-${status}`));
      await store.updateUser(account.id, { status, role: status === 'approved' ? 'admin' : 'user' }, admin.id);
      assert.equal((await call(`/api/admin/users/${account.id}`, 'DELETE', { Authorization: `Bearer ${adminSession.token}` })).status, 204);
      assert.equal(store.getUser(account.id), null);
    }
    const replacement = await store.registerUser('Delete Listener', 'replacement', credential('replacement'));
    assert.notEqual(replacement.id, target.id);
    assert.equal(replacement.status, 'pending');
    await store.deleteUser(replacement.id, admin.id);
    await store.deletePrivateAccessToken(admin.id, adminToken.id);
  });

  await context.test('passkey options select the configured secondary browser origin', testSecondaryPasskeyOptions);

  await context.test('browser app handoff verifies passkeys and binds single-use codes to PKCE', async () => {
    const envKeys = ['PASSKEY_RP_ID', 'PASSKEY_ORIGIN', 'PASSKEY_RP_ID_SECONDARY', 'PASSKEY_ORIGIN_SECONDARY'];
    const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    try {
      process.env.PASSKEY_RP_ID = 'music.example.com';
      process.env.PASSKEY_ORIGIN = 'https://music.example.com';
      process.env.PASSKEY_RP_ID_SECONDARY = '192-168-6-66.sslip.io';
      process.env.PASSKEY_ORIGIN_SECONDARY = 'https://192-168-6-66.sslip.io:4123';
      assert.equal((await call('/.well-known/assetlinks.json')).status, 404);
      assert.equal((await call('/api/auth/login/options', 'POST', {}, { client: 'android' })).status, 400);
      assert.equal((await call('/api/auth/login/options', 'POST', {}, { client: 'unknown' })).status, 400);
      const codeVerifier = crypto.randomBytes(32).toString('base64url');
      const appRequest = { client: 'browser-app', redirectUri: 'com.ssytdlp.app:/oauth/callback',
        state: crypto.randomBytes(32).toString('base64url'), codeChallengeMethod: 'S256',
        codeChallenge: crypto.createHash('sha256').update(codeVerifier).digest('base64url') };
      for (const changes of [{ redirectUri: 'https://evil.example/callback' }, { redirectUri: 'javascript:alert(1)' },
        { redirectUri: `${appRequest.redirectUri}?extra=1` }, { codeChallengeMethod: 'plain' },
        { codeChallenge: 'short' }, { state: 'short' }, { state: ['invalid'] }]) {
        assert.equal((await call('/api/auth/login/options', 'POST', userHeaders, { ...appRequest, ...changes })).status, 400);
      }

      const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const jwk = publicKey.export({ format: 'jwk' });
      const credentialId = crypto.randomBytes(32).toString('base64url');
      const keyBytes = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1],
        [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
      assert.equal((await call('/api/auth/register/options', 'POST', {}, { name: 'Newcomer', client: 'browser-app' })).status, 400);
      const register = async (name, rpID, origin) => {
        const optionsResponse = await call('/api/auth/register/options', 'POST', { Origin: origin }, { name });
        assert.equal(optionsResponse.status, 200);
        const registration = await optionsResponse.json();
        assert.equal(registration.options.rp.id, rpID);
        const registeredId = crypto.randomBytes(32);
        const idLength = Buffer.alloc(2);
        idLength.writeUInt16BE(registeredId.length);
        const registrationAuthData = Buffer.concat([
          crypto.createHash('sha256').update(rpID).digest(), Buffer.from([69, 0, 0, 0, 0]),
          Buffer.alloc(16), idLength, registeredId, keyBytes
        ]);
        const attestation = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', registrationAuthData]]));
        const registered = await call('/api/auth/register/verify', 'POST', { Origin: origin }, {
          requestId: registration.requestId,
          response: { id: registeredId.toString('base64url'), rawId: registeredId.toString('base64url'), type: 'public-key',
            clientExtensionResults: {}, response: {
              clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: registration.options.challenge, origin })).toString('base64url'),
              attestationObject: Buffer.from(attestation).toString('base64url'), transports: ['internal']
            } }
        });
        assert.equal(registered.status, 201);
        assert.equal(registered.headers.get('set-cookie'), null);
        const newAccount = await registered.json();
        assert.equal(newAccount.user.status, 'pending');
        assert.equal(newAccount.session, undefined);
        return { user: newAccount.user, credentialId: registeredId.toString('base64url') };
      };
      await register('Newcomer', process.env.PASSKEY_RP_ID, process.env.PASSKEY_ORIGIN);
      const localAccount = await register('Local Newcomer', process.env.PASSKEY_RP_ID_SECONDARY, process.env.PASSKEY_ORIGIN_SECONDARY);
      await store.updateUser(localAccount.user.id, { status: 'approved' }, admin.id);
      const account = await store.registerUser('Mobile Listener', 'mobile-listener', { id: credentialId, publicKey: keyBytes, counter: 0 });
      await store.updateUser(account.id, { status: 'approved' }, admin.id);
      const start = async (appLogin = false) => {
        const result = await call('/api/auth/login/options', 'POST', {}, appLogin ? appRequest : {});
        assert.equal(result.status, 200);
        assert.equal(result.headers.get('cache-control'), 'no-store');
        const payload = await result.json();
        assert.equal(payload.options.rpId, 'music.example.com');
        assert.equal(payload.options.userVerification, 'required');
        return payload;
      };
      const assertion = (options, origin, rpID = 'music.example.com', flags = 5, id = credentialId) => {
        const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin }));
        const authenticatorData = Buffer.concat([crypto.createHash('sha256').update(rpID).digest(), Buffer.from([flags, 0, 0, 0, 0])]);
        const signature = crypto.sign('sha256', Buffer.concat([authenticatorData, crypto.createHash('sha256').update(clientData).digest()]), privateKey);
        return { id, rawId: id, type: 'public-key', clientExtensionResults: {},
          response: { clientDataJSON: clientData.toString('base64url'), authenticatorData: authenticatorData.toString('base64url'), signature: signature.toString('base64url') } };
      };
      const origin = process.env.PASSKEY_ORIGIN;
      const login = await start(true);
      const verifyBody = { requestId: login.requestId, response: assertion(login.options, origin), client: 'web', redirectUri: 'https://evil.example/' };
      const verified = await call('/api/auth/login/verify', 'POST', {}, verifyBody);
      assert.equal(verified.status, 200);
      assert.equal(verified.headers.get('set-cookie'), null);
      assert.equal(verified.headers.get('cache-control'), 'no-store');
      const handoff = await verified.json();
      assert.deepEqual(Object.keys(handoff), ['redirectUrl']);
      const redirect = new URL(handoff.redirectUrl);
      assert.equal(`${redirect.protocol}${redirect.pathname}`, appRequest.redirectUri);
      assert.equal(redirect.searchParams.get('state'), appRequest.state);
      assert.deepEqual([...redirect.searchParams.keys()], ['code', 'state']);
      const exchangeBody = { code: redirect.searchParams.get('code'), codeVerifier, redirectUri: appRequest.redirectUri };
      const exchanged = await call('/api/auth/app/token', 'POST', {}, exchangeBody);
      assert.equal(exchanged.status, 200);
      assert.equal(exchanged.headers.get('cache-control'), 'no-store');
      assert.equal(exchanged.headers.get('set-cookie'), null);
      const result = await exchanged.json();
      assert.equal(result.user.id, account.id);
      assert.equal(result.user.credentials, undefined);
      assert.equal(result.session.tokenType, 'Bearer');
      assert.ok(Date.parse(result.session.expiresAt) > Date.now());
      const headers = { Authorization: `Bearer ${result.session.token}` };
      assert.equal((await call('/protected', 'POST', headers)).status, 200);
      assert.equal((await call('/api/auth/app/token', 'POST', {}, exchangeBody)).status, 400);
      assert.equal((await call('/api/auth/login/verify', 'POST', {}, verifyBody)).status, 400);

      const browserLogin = await start();
      const browserVerified = await call('/api/auth/login/verify', 'POST', {}, {
        ...appRequest, requestId: browserLogin.requestId, response: assertion(browserLogin.options, origin)
      });
      assert.equal(browserVerified.status, 200);
      assert.match(browserVerified.headers.get('set-cookie'), /ssytdlp_session=.*HttpOnly/);
      const browserResult = await browserVerified.json();
      assert.equal(browserResult.session, undefined);
      assert.equal(browserResult.redirectUrl, undefined);

      const localOrigin = process.env.PASSKEY_ORIGIN_SECONDARY;
      const localRPID = process.env.PASSKEY_RP_ID_SECONDARY;
      for (const [assertedOrigin, assertedRPID, expectedStatus] of [
        [localOrigin, localRPID, 200],
        [origin, localRPID, 400],
        ['https://192-168-6-66.sslip.io:4124', localRPID, 400],
        [localOrigin, process.env.PASSKEY_RP_ID, 400]
      ]) {
        const optionsResponse = await call('/api/auth/login/options', 'POST', { Origin: localOrigin }, {});
        assert.equal(optionsResponse.status, 200);
        const attempt = await optionsResponse.json();
        assert.equal(attempt.options.rpId, localRPID);
        const verifiedAttempt = await call('/api/auth/login/verify', 'POST', { Origin: assertedOrigin }, {
          requestId: attempt.requestId,
          response: assertion(attempt.options, assertedOrigin, assertedRPID, 5, localAccount.credentialId)
        });
        assert.equal(verifiedAttempt.status, expectedStatus);
        if (expectedStatus === 200) {
          assert.equal((await verifiedAttempt.json()).user.id, localAccount.user.id);
          assert.match(verifiedAttempt.headers.get('set-cookie'), /ssytdlp_session=.*HttpOnly; Secure/);
        } else {
          assert.equal(verifiedAttempt.headers.get('set-cookie'), null);
        }
      }

      for (const [badOrigin, rpID, flags] of [
        ['android:apk-key-hash:untrusted'], ['https://evil.example'],
        [localOrigin, localRPID],
        [origin, 'wrong.example.com'], [origin, undefined, 1]
      ]) {
        const attempt = await start(true);
        const rejected = await call('/api/auth/login/verify', 'POST', {}, {
          requestId: attempt.requestId, response: assertion(attempt.options, badOrigin, rpID, flags)
        });
        assert.equal(rejected.status, 400);
        assert.equal(rejected.headers.get('set-cookie'), null);
        assert.equal((await rejected.json()).session, undefined);
      }
      const getCode = async () => {
        const attempt = await start(true);
        const verifiedAttempt = await call('/api/auth/login/verify', 'POST', {}, {
          requestId: attempt.requestId, response: assertion(attempt.options, origin)
        });
        assert.equal(verifiedAttempt.status, 200);
        return new URL((await verifiedAttempt.json()).redirectUrl).searchParams.get('code');
      };
      for (const changes of [{ codeVerifier: crypto.randomBytes(32).toString('base64url') },
        { codeVerifier: 'short' }, { codeVerifier: undefined }, { redirectUri: 'https://evil.example' }]) {
        const code = await getCode();
        assert.equal((await call('/api/auth/app/token', 'POST', userHeaders, { ...exchangeBody, code, ...changes })).status, 400);
        assert.equal((await call('/api/auth/app/token', 'POST', {}, { ...exchangeBody, code })).status, 400);
      }
      const expiredCode = await getCode();
      const originalNow = Date.now;
      try {
        Date.now = () => originalNow() + 61_000;
        assert.equal((await call('/api/auth/app/token', 'POST', {}, { ...exchangeBody, code: expiredCode })).status, 400);
      } finally { Date.now = originalNow; }
      const revokedCode = await getCode();
      await store.updateUser(account.id, { status: 'revoked' }, admin.id);
      assert.equal((await call('/api/auth/app/token', 'POST', {}, { ...exchangeBody, code: revokedCode })).status, 403);
      for (const [status, code] of [['pending', 'ACCESS_PENDING'], ['revoked', 'ACCESS_REVOKED']]) {
        await store.updateUser(account.id, { status }, admin.id);
        assert.equal((await call('/protected', 'POST', headers)).status, 401);
        const attempt = await start(true);
        const rejected = await call('/api/auth/login/verify', 'POST', {}, {
          requestId: attempt.requestId, response: assertion(attempt.options, origin)
        });
        assert.equal(rejected.status, 403);
        assert.equal((await rejected.json()).code, code);
      }
    } finally {
      for (const key of envKeys) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
      }
    }
  });
});
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { closeDatabases } from '../src/database.js';

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
});
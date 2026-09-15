import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function loadStore(testContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-auth-'));
  testContext.after(() => fs.rm(directory, { recursive: true, force: true }));
  process.env.AUTH_STORE_PATH = path.join(directory, 'auth.json');
  return import(`../src/authStore.js?test=${crypto.randomUUID()}`);
}

const credential = (id) => ({ id, publicKey: Buffer.from(`key-${id}`), counter: 0 });

test('first registered user is an approved admin and later users are pending', async (testContext) => {
  const store = await loadStore(testContext);
  const first = await store.registerUser('Alice', 'alice-handle', credential('alice-key'));
  const second = await store.registerUser('Bob', 'bob-handle', credential('bob-key'));

  assert.equal(first.role, 'admin');
  assert.equal(first.status, 'approved');
  assert.equal(second.role, 'user');
  assert.equal(second.status, 'pending');
});

test('admins can approve users and revoked users lose their sessions', async (testContext) => {
  const store = await loadStore(testContext);
  const admin = await store.registerUser('Admin', 'admin-handle', credential('admin-key'));
  const user = await store.registerUser('Listener', 'listener-handle', credential('listener-key'));
  await store.updateUser(user.id, { status: 'approved' }, admin.id);
  const session = await store.createSession(user.id);

  assert.equal(store.getSessionUser(session.token)?.id, user.id);
  await store.updateUser(user.id, { status: 'revoked' }, admin.id);
  assert.equal(store.getSessionUser(session.token), null);
});

test('the last approved admin cannot be demoted or revoked', async (testContext) => {
  const store = await loadStore(testContext);
  const admin = await store.registerUser('Admin', 'admin-handle', credential('admin-key'));

  await assert.rejects(
    store.updateUser(admin.id, { role: 'user' }, admin.id),
    /At least one approved admin is required/
  );
});

test('approved user sessions survive an authentication store reload', async (testContext) => {
  const store = await loadStore(testContext);
  const admin = await store.registerUser('Admin', 'admin-handle', credential('admin-key'));
  const session = await store.createSession(admin.id);
  const reloadedStore = await import(`../src/authStore.js?reload=${crypto.randomUUID()}`);

  assert.equal(reloadedStore.getSessionUser(session.token)?.id, admin.id);
  assert.equal(reloadedStore.getSessionUser('not-a-session'), null);
});
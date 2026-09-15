import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { closeDatabases, openDatabase } from '../src/database.js';

async function loadStore(testContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-auth-'));
  testContext.after(() => {
    closeDatabases();
    return fs.rm(directory, { recursive: true, force: true });
  });
  process.env.DATABASE_PATH = path.join(directory, 'test.sqlite');
  process.env.JOB_STORE_PATH = path.join(directory, 'jobs.json');
  process.env.AUTH_STORE_PATH = path.join(directory, 'auth.json');
  return import(`../src/authStore.js?test=${crypto.randomUUID()}`);
}

const credential = (id) => ({ id, publicKey: Buffer.from(`key-${id}`), counter: 0 });

test('duplicate credentials and names are rejected and credential updates persist', async (testContext) => {
  const store = await loadStore(testContext);
  const admin = await store.registerUser('Alice', 'alice-handle', credential('alice-key'));
  await assert.rejects(store.registerUser('alice', 'other-handle', credential('other-key')), /name is already registered/);
  await assert.rejects(store.registerUser('Other', 'other-handle', credential('alice-key')), /passkey is already registered/);
  assert.equal(await store.updateCredentialCounter(admin.id, 'alice-key', 42), true);
  assert.equal(await store.updateCredentialCounter('missing', 'alice-key', 99), false);
  const session = await store.createSession(admin.id);
  await store.deleteSession(session.token);
  closeDatabases();
  const reloaded = await import(`../src/authStore.js?counter=${crypto.randomUUID()}`);
  assert.equal(reloaded.findCredential('alice-key').credential.counter, 42);
  assert.equal(reloaded.getSessionUser(session.token), null);
  assert.equal(reloaded.listUsers().length, 1);
});

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
  closeDatabases();
  const reloadedStore = await import(`../src/authStore.js?reload=${crypto.randomUUID()}`);

  assert.equal(reloadedStore.getSessionUser(session.token)?.id, admin.id);
  assert.equal(reloadedStore.getSessionUser('not-a-session'), null);
});

test('named PATs coexist, hide secrets in listings and enforce ownership on deletion', async (testContext) => {
  const store = await loadStore(testContext);
  const admin = await store.registerUser('Admin', 'admin-handle', credential('admin-key'));
  const first = await store.createPrivateAccessToken(admin.id, ' Laptop ');
  const second = await store.createPrivateAccessToken(admin.id, 'Automation');
  assert.equal(first.name, 'Laptop');
  assert.equal(store.getPrivateAccessTokenUser(first.token)?.id, admin.id);
  assert.equal(store.getPrivateAccessTokenUser(second.token)?.id, admin.id);
  const stored = openDatabase().prepare('SELECT * FROM private_access_tokens WHERE id = ?').get(second.id);
  assert.equal(JSON.stringify(stored).includes(second.token), false);
  assert.equal(typeof stored.token_hash, 'string');
  assert.equal(store.listPrivateAccessTokens(admin.id).length, 2);
  for (const token of store.listPrivateAccessTokens(admin.id)) {
    assert.deepEqual(Object.keys(token).sort(), ['createdAt', 'id', 'name']);
  }
  assert.equal(await store.deletePrivateAccessToken('other-user', first.id), false);
  assert.equal(await store.deletePrivateAccessToken(admin.id, first.id), true);
  assert.equal(store.getPrivateAccessTokenUser(first.token), null);
  assert.equal(store.getPrivateAccessTokenUser(second.token)?.id, admin.id);
  closeDatabases();
  const reloaded = await import(`../src/authStore.js?reload=${crypto.randomUUID()}`);
  assert.equal(reloaded.getPrivateAccessTokenUser(second.token)?.id, admin.id);
  assert.equal(reloaded.getPrivateAccessTokenUser('not-a-token'), null);
});

test('PAT names and approval are required and revocation survives reapproval', async (testContext) => {
  const store = await loadStore(testContext);
  const admin = await store.registerUser('Admin', 'admin-handle', credential('admin-key'));
  const user = await store.registerUser('Listener', 'listener-handle', credential('listener-key'));
  await assert.rejects(store.createPrivateAccessToken(user.id, 'Pending'), /Approved user required/);
  for (const name of ['', ' ', 'a'.repeat(65), {}, undefined]) {
    await assert.rejects(store.createPrivateAccessToken(admin.id, name), /PAT name/);
  }
  await store.updateUser(user.id, { status: 'approved' }, admin.id);
  const pat = await store.createPrivateAccessToken(user.id, 'Automation');

  await store.updateUser(user.id, { status: 'revoked' }, admin.id);
  assert.equal(store.getPrivateAccessTokenUser(pat.token), null);
  await store.updateUser(user.id, { status: 'approved' }, admin.id);
  assert.equal(store.getPrivateAccessTokenUser(pat.token), null);
  assert.deepEqual(store.listPrivateAccessTokens(user.id), []);
});

test('upgrade discards old API tokens while preserving sessions and named PATs', async (testContext) => {
  const store = await loadStore(testContext);
  const admin = await store.registerUser('Admin', 'admin-handle', credential('admin-key'));
  const session = await store.createSession(admin.id);
  const pat = await store.createPrivateAccessToken(admin.id, 'Keep this PAT');
  openDatabase().exec(`CREATE TABLE api_tokens (user_id TEXT PRIMARY KEY, token_hash TEXT, created_at TEXT);
    INSERT INTO api_tokens VALUES ('legacy-user', 'legacy-hash', '2026-09-15');`);
  closeDatabases();
  const reloaded = await import(`../src/authStore.js?upgrade=${crypto.randomUUID()}`);
  assert.equal(openDatabase().prepare("SELECT name FROM sqlite_master WHERE name = 'api_tokens'").get(), undefined);
  assert.equal(reloaded.getSessionUser(session.token)?.id, admin.id);
  assert.equal(reloaded.getPrivateAccessTokenUser(pat.token)?.id, admin.id);
});
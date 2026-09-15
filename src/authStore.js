import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const authStorePath = process.env.AUTH_STORE_PATH || path.resolve(process.cwd(), 'data', 'auth.json');
const users = new Map();
const sessions = new Map();
let persistenceQueue = Promise.resolve();

async function loadAuth() {
  let stored;
  try {
    stored = JSON.parse(await fs.readFile(authStorePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error(`Unable to load authentication data from ${authStorePath}: ${error.message}`);
  }

  if (!stored || !Array.isArray(stored.users) || !Array.isArray(stored.sessions)) {
    throw new Error(`Invalid authentication data in ${authStorePath}`);
  }

  for (const user of stored.users) {
    if (user?.id && user.name && Array.isArray(user.credentials)) users.set(user.id, user);
  }
  for (const session of stored.sessions) {
    if (session?.tokenHash && session.userId && session.expiresAt) sessions.set(session.tokenHash, session);
  }
}

function persistAuth() {
  persistenceQueue = persistenceQueue.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(authStorePath), { recursive: true });
    const temporaryPath = `${authStorePath}.${process.pid}.tmp`;
    const data = { users: [...users.values()], sessions: [...sessions.values()] };
    await fs.writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`);
    await fs.rename(temporaryPath, authStorePath);
  });
  return persistenceQueue;
}

await loadAuth();

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    credentialCount: user.credentials.length
  };
}

function normalizeName(name) {
  const normalized = String(name || '').trim().replace(/\s+/g, ' ');
  if (normalized.length < 2 || normalized.length > 64) {
    const error = new Error('Name must be between 2 and 64 characters');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function countApprovedAdmins(excludingUserId = null) {
  return [...users.values()].filter((user) => (
    user.id !== excludingUserId && user.role === 'admin' && user.status === 'approved'
  )).length;
}

export function listUsers() {
  return [...users.values()]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map(publicUser);
}

export function findCredential(credentialId) {
  for (const user of users.values()) {
    const credential = user.credentials.find((item) => item.id === credentialId);
    if (credential) {
      return {
        user,
        credential: {
          ...credential,
          publicKey: Buffer.from(credential.publicKey, 'base64url')
        }
      };
    }
  }
  return null;
}

export async function registerUser(name, userHandle, credential) {
  const normalizedName = normalizeName(name);
  if ([...users.values()].some((user) => user.name.toLowerCase() === normalizedName.toLowerCase())) {
    const error = new Error('That name is already registered');
    error.statusCode = 409;
    throw error;
  }
  if (findCredential(credential.id)) {
    const error = new Error('That passkey is already registered');
    error.statusCode = 409;
    throw error;
  }

  const isFirstUser = users.size === 0;
  const now = new Date().toISOString();
  const user = {
    id: crypto.randomUUID(),
    name: normalizedName,
    userHandle,
    role: isFirstUser ? 'admin' : 'user',
    status: isFirstUser ? 'approved' : 'pending',
    credentials: [{
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: credential.transports || []
    }],
    createdAt: now,
    updatedAt: now
  };
  users.set(user.id, user);
  await persistAuth();
  return publicUser(user);
}

export async function updateCredentialCounter(userId, credentialId, counter) {
  const user = users.get(userId);
  const credential = user?.credentials.find((item) => item.id === credentialId);
  if (!credential) return false;
  credential.counter = counter;
  user.updatedAt = new Date().toISOString();
  await persistAuth();
  return true;
}

export async function updateUser(userId, changes, actorId) {
  const user = users.get(userId);
  if (!user) return null;
  const status = changes.status ?? user.status;
  const role = changes.role ?? user.role;
  if (!['pending', 'approved', 'revoked'].includes(status) || !['user', 'admin'].includes(role)) {
    const error = new Error('Invalid user role or access status');
    error.statusCode = 400;
    throw error;
  }
  if (user.id === actorId && status !== 'approved') {
    const error = new Error('You cannot revoke your own access');
    error.statusCode = 409;
    throw error;
  }
  if (user.role === 'admin' && user.status === 'approved'
    && (role !== 'admin' || status !== 'approved') && countApprovedAdmins(user.id) === 0) {
    const error = new Error('At least one approved admin is required');
    error.statusCode = 409;
    throw error;
  }

  user.status = status;
  user.role = role;
  user.updatedAt = new Date().toISOString();
  if (status !== 'approved') {
    for (const [tokenHash, session] of sessions) {
      if (session.userId === user.id) sessions.delete(tokenHash);
    }
  }
  await persistAuth();
  return publicUser(user);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('base64url');
}

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const session = {
    tokenHash: hashToken(token),
    userId,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  };
  sessions.set(session.tokenHash, session);
  await persistAuth();
  return { token, expiresAt: session.expiresAt };
}

export function getSessionUser(token) {
  if (!token) return null;
  const session = sessions.get(hashToken(token));
  if (!session || Date.parse(session.expiresAt) <= Date.now()) return null;
  const user = users.get(session.userId);
  if (!user || user.status !== 'approved') return null;
  return publicUser(user);
}

export async function deleteSession(token) {
  if (!token) return;
  sessions.delete(hashToken(token));
  await persistAuth();
}
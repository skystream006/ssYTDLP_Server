import crypto from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from '@simplewebauthn/server';
import {
  createSession,
  deleteSession,
  findCredential,
  getSessionUser,
  listUsers,
  registerUser,
  updateCredentialCounter,
  updateUser
} from './authStore.js';

const challenges = new Map();
const challengeLifetimeMs = 5 * 60 * 1000;
const sessionCookie = 'ssytdlp_session';

function getWebAuthnConfig(req) {
  const rpID = process.env.PASSKEY_RP_ID || req.hostname;
  const origin = process.env.PASSKEY_ORIGIN || `${req.protocol}://${req.get('host')}`;
  return { rpID, origin };
}

function rememberChallenge(data) {
  const requestId = crypto.randomUUID();
  challenges.set(requestId, { ...data, expiresAt: Date.now() + challengeLifetimeMs });
  return requestId;
}

function takeChallenge(requestId, type) {
  const challenge = challenges.get(requestId);
  challenges.delete(requestId);
  if (!challenge || challenge.type !== type || challenge.expiresAt < Date.now()) {
    const error = new Error('The passkey request expired. Please try again.');
    error.statusCode = 400;
    throw error;
  }
  return challenge;
}

function getCookie(req, name) {
  const prefix = `${name}=`;
  const pair = String(req.headers.cookie || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return pair ? decodeURIComponent(pair.slice(prefix.length)) : null;
}

function sessionCookieOptions(req, expiresAt) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure || process.env.PASSKEY_ORIGIN?.startsWith('https://'),
    expires: new Date(expiresAt),
    path: '/'
  };
}

async function issueSession(req, res, user) {
  const session = await createSession(user.id);
  res.cookie(sessionCookie, session.token, sessionCookieOptions(req, session.expiresAt));
}

function sendError(res, error) {
  return res.status(error.statusCode || 400).json({ error: error.message });
}

export function attachUser(req, _res, next) {
  req.user = getSessionUser(getCookie(req, sessionCookie));
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Passkey login required' });
  return next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Passkey login required' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required' });
  return next();
}

export function registerAuthRoutes(app) {
  app.get('/api/auth/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Passkey login required' });
    return res.json({ user: req.user });
  });

  app.post('/api/auth/register/options', async (req, res) => {
    try {
      const name = String(req.body?.name || '').trim();
      if (name.length < 2 || name.length > 64) {
        return res.status(400).json({ error: 'Name must be between 2 and 64 characters' });
      }
      const userHandle = crypto.randomBytes(32);
      const { rpID, origin } = getWebAuthnConfig(req);
      const options = await generateRegistrationOptions({
        rpName: 'ssYTDLP',
        rpID,
        userName: name,
        userDisplayName: name,
        userID: userHandle,
        attestationType: 'none',
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'required'
        }
      });
      const requestId = rememberChallenge({
        type: 'registration',
        challenge: options.challenge,
        name,
        userHandle: userHandle.toString('base64url'),
        rpID,
        origin
      });
      return res.json({ requestId, options });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/auth/register/verify', async (req, res) => {
    try {
      const challenge = takeChallenge(req.body?.requestId, 'registration');
      const verification = await verifyRegistrationResponse({
        response: req.body?.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.origin,
        expectedRPID: challenge.rpID,
        requireUserVerification: true
      });
      if (!verification.verified || !verification.registrationInfo) {
        return res.status(400).json({ error: 'Passkey registration could not be verified' });
      }
      const user = await registerUser(
        challenge.name,
        challenge.userHandle,
        verification.registrationInfo.credential
      );
      if (user.status === 'approved') await issueSession(req, res, user);
      return res.status(201).json({ user });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/auth/login/options', async (req, res) => {
    try {
      const { rpID, origin } = getWebAuthnConfig(req);
      const options = await generateAuthenticationOptions({
        rpID,
        userVerification: 'required'
      });
      const requestId = rememberChallenge({
        type: 'authentication',
        challenge: options.challenge,
        rpID,
        origin
      });
      return res.json({ requestId, options });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/auth/login/verify', async (req, res) => {
    try {
      const challenge = takeChallenge(req.body?.requestId, 'authentication');
      const match = findCredential(req.body?.response?.id);
      if (!match) return res.status(401).json({ error: 'Passkey is not registered on this server' });
      const verification = await verifyAuthenticationResponse({
        response: req.body.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.origin,
        expectedRPID: challenge.rpID,
        credential: match.credential,
        requireUserVerification: true
      });
      if (!verification.verified) {
        return res.status(401).json({ error: 'Passkey login could not be verified' });
      }
      await updateCredentialCounter(
        match.user.id,
        match.credential.id,
        verification.authenticationInfo.newCounter
      );
      if (match.user.status === 'pending') {
        return res.status(403).json({ error: 'Your access request is waiting for administrator approval', code: 'ACCESS_PENDING' });
      }
      if (match.user.status !== 'approved') {
        return res.status(403).json({ error: 'Your access has been revoked', code: 'ACCESS_REVOKED' });
      }
      await issueSession(req, res, match.user);
      return res.json({ user: match.user });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/auth/logout', async (req, res) => {
    const token = getCookie(req, sessionCookie);
    await deleteSession(token);
    res.clearCookie(sessionCookie, { path: '/' });
    return res.status(204).end();
  });

  app.get('/api/admin/users', requireAdmin, (_req, res) => {
    res.json({ users: listUsers() });
  });

  app.patch('/api/admin/users/:id', requireAdmin, async (req, res) => {
    try {
      const user = await updateUser(req.params.id, {
        status: req.body?.status,
        role: req.body?.role
      }, req.user.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      return res.json({ user });
    } catch (error) {
      return sendError(res, error);
    }
  });
}
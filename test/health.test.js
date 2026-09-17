import test from 'node:test';
import assert from 'node:assert/strict';
import { getTranscriptionHealth } from '../src/health.js';

function configureEndpoint(context, endpoint = 'http://transcription:4317/api/transcribe') {
  const previous = process.env.TRANSCRIPTION_ENDPOINT;
  process.env.TRANSCRIPTION_ENDPOINT = endpoint;
  context.after(() => {
    if (previous === undefined) delete process.env.TRANSCRIPTION_ENDPOINT;
    else process.env.TRANSCRIPTION_ENDPOINT = previous;
  });
}

test('transcription health skips requests when not configured', async (context) => {
  configureEndpoint(context, ' ');
  const probe = context.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected request'));
  assert.equal((await getTranscriptionHealth()).status, 'not_configured');
  assert.equal(probe.mock.callCount(), 0);
});

test('transcription health uses a bounded HEAD probe and accepts POST-only endpoints', async (context) => {
  configureEndpoint(context);
  for (const status of [200, 204, 405]) {
    const probe = context.mock.method(globalThis, 'fetch', async (endpoint, options) => {
      assert.equal(endpoint, 'http://transcription:4317/api/transcribe');
      assert.equal(options.method, 'HEAD');
      assert.equal(options.redirect, 'manual');
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.body, undefined);
      return new Response(null, { status });
    });
    assert.equal((await getTranscriptionHealth()).status, 'active');
    probe.mock.restore();
  }
});

test('transcription health reports HTTP errors and redirects without leaking the endpoint', async (context) => {
  configureEndpoint(context, 'http://transcription:4317/api/transcribe?token=secret');
  for (const status of [301, 401, 403, 404, 500, 503]) {
    const probe = context.mock.method(globalThis, 'fetch', async () => new Response(null, { status }));
    assert.deepEqual(await getTranscriptionHealth(), {
      status: 'error', message: `Endpoint returned HTTP ${status}`
    });
    probe.mock.restore();
  }
});

test('transcription health reports network failures without throwing', async (context) => {
  configureEndpoint(context);
  context.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
  assert.deepEqual(await getTranscriptionHealth(), {
    status: 'unreachable', message: 'Unable to connect to endpoint'
  });
});

test('transcription health reports timeouts without throwing', async (context) => {
  configureEndpoint(context);
  context.mock.method(globalThis, 'fetch', async () => {
    throw new DOMException('Timed out', 'TimeoutError');
  });
  assert.deepEqual(await getTranscriptionHealth(), {
    status: 'unreachable', message: 'Endpoint timed out after 2 seconds'
  });
});
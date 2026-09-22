import test from 'node:test';
import assert from 'node:assert/strict';
import { submitJobUrl } from '../frontend/src/jobSubmission.js';

test('job submission sends the chosen format and metadata-only flag, defaulting to audio', async () => {
  for (const downloadType of [undefined, 'audio', 'video']) {
    const job = { id: 'created' };
    const result = await submitJobUrl(' https://youtu.be/video ', {
      downloadType, metadataOnly: true,
      request: async (url, options) => {
        assert.equal(url, '/api/jobs');
        assert.equal(options.method, 'POST');
        assert.deepEqual(JSON.parse(options.body), {
          url: 'https://youtu.be/video', metadataOnly: true, downloadType: downloadType || 'audio'
        });
        return job;
      }
    });
    assert.deepEqual(result, { job, created: true });
  }
});
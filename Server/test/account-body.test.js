import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { handleAccountRequest } from '../src/account-http.js';

test('profile JSON retains Korean nicknames when network chunks split a UTF-8 character', async () => {
  const body = Buffer.from(JSON.stringify({ nickname: '새닉네임' }));
  const split = body.indexOf(Buffer.from('새')) + 1;
  const req = Readable.from([body.subarray(0, split), body.subarray(split)]);
  req.method = 'PATCH'; req.headers = { authorization: 'Bearer token', 'content-type': 'application/json' };
  let response;
  await handleAccountRequest(req, { setHeader() {} }, '/api/account/profile', {
    updateProfile: async (_token, input) => ({ profile: input })
  }, (status, payload) => { response = { status, body: JSON.parse(payload) }; });
  assert.deepEqual(response, { status: 200, body: { profile: { nickname: '새닉네임' } } });
});

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after, before } from 'node:test';
import { GET, POST } from '../api/generate';

/** A stand-in for Google, so the route is tested end to end without a key or a network. */
let upstream: Server;
let origin = '';
let seenKey: string | undefined;
let seenModel = '';
let mode: 'ok' | 'quota' | 'gone' = 'ok';

before(async () => {
  upstream = createServer((req, res) => {
    seenKey = String(req.headers['x-goog-api-key'] ?? '');
    seenModel = /models\/([^:]+):/.exec(req.url ?? '')?.[1] ?? '';
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (mode === 'quota') {
        res.statusCode = 429;
        res.end(JSON.stringify({ error: { message: 'Quota exceeded, limit: 0, free_tier' } }));
      } else if (mode === 'gone') {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { message: 'not found' } }));
      } else {
        res.end(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }, { inlineData: { mimeType: 'image/png', data: 'QUJD' } }] } }] }));
      }
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  process.env.GEMINI_API_ORIGIN = origin;
});

after(() => {
  upstream.close();
});

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request('http://localhost/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

const GOOD = {
  mode: 'edit',
  model: 'gemini-nano-banana-2.1',
  imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8',
  imageMimeType: 'image/png',
  prompt: 'add a hat',
  keepLineStyle: true,
  aspectRatio: '16:9',
};

test('without any key the route says so and does not call Google', async () => {
  delete process.env.GEMINI_API_KEY;
  seenKey = undefined;
  const response = await post(GOOD);
  const json = (await response.json()) as { ok: boolean; code: string };
  assert.equal(response.status, 401);
  assert.equal(json.code, 'no_key');
  assert.equal(seenKey, undefined);
});

test('a visitor key is used for the call and is not echoed back', async () => {
  mode = 'ok';
  const response = await post(GOOD, { 'x-user-api-key': 'AIza-visitor-key' });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.equal(seenKey, 'AIza-visitor-key');
  assert.equal(seenModel, 'gemini-nano-banana-2.1');
  assert.equal(text.includes('AIza-visitor-key'), false);
  assert.equal((JSON.parse(text) as { image: { data: string } }).image.data, 'QUJD');
});

test('the server key is used when the visitor brings none, and GET reports that it exists', async () => {
  process.env.GEMINI_API_KEY = 'AIza-server-key';
  mode = 'ok';
  const response = await post(GOOD, { 'x-forwarded-for': '203.0.113.7' });
  assert.equal(response.status, 200);
  assert.equal(seenKey, 'AIza-server-key');
  assert.deepEqual(await GET().json(), { ok: true, configured: true });
});

test('the shared key is rate limited per address, a visitor key is not', async () => {
  process.env.GEMINI_API_KEY = 'AIza-server-key';
  mode = 'ok';
  const statuses: number[] = [];
  for (let i = 0; i < 10; i += 1) statuses.push((await post(GOOD, { 'x-forwarded-for': '198.51.100.9' })).status);
  assert.deepEqual(statuses.slice(0, 8), Array(8).fill(200));
  assert.deepEqual(statuses.slice(8), [429, 429]);
  assert.equal((await post(GOOD, { 'x-forwarded-for': '198.51.100.9', 'x-user-api-key': 'AIza-mine' })).status, 200);
});

test('a free key without image quota is a clear 402', async () => {
  mode = 'quota';
  const response = await post(GOOD, { 'x-user-api-key': 'AIza-free' });
  const json = (await response.json()) as { code: string; error: string };
  assert.equal(response.status, 402);
  assert.equal(json.code, 'billing_required');
  assert.match(json.error, /billing/i);
});

test('a retired model on every fallback is reported, after trying the chain', async () => {
  mode = 'gone';
  const response = await post({ ...GOOD, model: 'gemini-2.5-flash-image' }, { 'x-user-api-key': 'AIza-x' });
  const json = (await response.json()) as { code: string };
  assert.equal(json.code, 'model_unavailable');
});

test('bad input is refused before anything is sent', async () => {
  seenKey = undefined;
  const cases: [unknown, RegExp][] = [
    ['not json', /JSON/],
    [{ ...GOOD, model: 'imagen-4.0-generate-001' }, /not available/],
    [{ ...GOOD, mode: 'delete' }, /mode/],
    [{ ...GOOD, imageBase64: 'data:image/png;base64,AAAA' }, /base64/],
    [{ ...GOOD, prompt: '   ' }, /change/],
    [{ ...GOOD, prompt: 'x'.repeat(501) }, /500/],
    [{ ...GOOD, imageMimeType: 'image/gif' }, /image\/png/],
  ];
  for (const [body, pattern] of cases) {
    const response = await post(body, { 'x-user-api-key': 'AIza-x' });
    const json = (await response.json()) as { code: string; error: string };
    assert.equal(response.status, 400, String(pattern));
    assert.match(json.error, pattern);
  }
  assert.equal(seenKey, undefined);
});

test('an oversized body is refused by length before it is read', async () => {
  const response = await post(GOOD, { 'content-length': '9000000', 'x-user-api-key': 'AIza-x' });
  assert.equal(response.status, 413);
});

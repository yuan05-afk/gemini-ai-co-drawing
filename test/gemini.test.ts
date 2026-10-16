import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBody,
  buildInstruction,
  classifyHttpError,
  generate,
  GeminiError,
  parseResponse,
  parseRetryAfter,
  type EditRequest,
} from '../src/lib/gemini';
import { ALLOWED_MODEL_IDS, MODELS, modelChain, nearestAspectRatio, SUPPORTED_ASPECT_RATIOS } from '../src/lib/models';

const REQUEST: EditRequest = {
  mode: 'edit',
  model: 'gemini-nano-banana-2.1',
  imageBase64: 'AAAA',
  imageMimeType: 'image/png',
  prompt: 'add a red hat',
  keepLineStyle: true,
  aspectRatio: '16:9',
};

const IMAGE_REPLY = {
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Done.' }, { inlineData: { mimeType: 'image/png', data: 'QUJD' } }] } }],
};

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('the edit body sends the drawing first, then the instruction, and asks for text and an image at the canvas ratio', () => {
  const body = buildBody(REQUEST) as { contents: { parts: unknown[] }[]; generationConfig: Record<string, unknown> };
  assert.deepEqual(body.contents[0].parts[0], { inlineData: { mimeType: 'image/png', data: 'AAAA' } });
  assert.match(String((body.contents[0].parts[1] as { text: string }).text), /add a red hat/);
  assert.deepEqual(body.generationConfig, { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9' } });
});

test('describe mode asks for words only', () => {
  const body = buildBody({ ...REQUEST, mode: 'describe', prompt: '' }) as Record<string, unknown>;
  assert.equal('generationConfig' in body, false);
  assert.match(buildInstruction('', 'describe', true), /Describe this drawing/);
});

test('the line-style hint is optional', () => {
  assert.match(buildInstruction('color it', 'edit', true), /minimal line-drawing style/);
  assert.doesNotMatch(buildInstruction('color it', 'edit', false), /line-drawing/);
});

test('every model the UI lists is on the server allowlist, and no retired id is', () => {
  for (const model of MODELS) assert.ok(ALLOWED_MODEL_IDS.has(model.id), model.id);
  for (const retired of ['gemini-2.5-flash-image-preview', 'gemini-2.0-flash-preview-image-generation', 'imagen-4.0-generate-001']) {
    assert.equal(ALLOWED_MODEL_IDS.has(retired), false, retired);
  }
  assert.deepEqual(modelChain('gemini-3-pro-image').slice(0, 2), ['gemini-3-pro-image', 'gemini-nano-banana-2.1']);
});

test('the canvas shape maps to a supported aspect ratio', () => {
  assert.equal(nearestAspectRatio(960, 540), '16:9');
  assert.equal(nearestAspectRatio(800, 600), '4:3');
  assert.equal(nearestAspectRatio(720, 720), '1:1');
  assert.equal(nearestAspectRatio(540, 960), '9:16');
  assert.ok((SUPPORTED_ASPECT_RATIOS as readonly string[]).includes(nearestAspectRatio(1000, 333)));
});

test('retry hints are read from Google’s message', () => {
  assert.equal(parseRetryAfter('Please retry in 9h28m49.6s.'), 9 * 3600 + 28 * 60 + 50);
  assert.equal(parseRetryAfter('Please retry in 34s'), 34);
  assert.equal(parseRetryAfter('nothing here'), undefined);
});

test('a free key with no image quota is billing_required, not a wait', () => {
  const error = classifyHttpError(429, {
    error: { message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-2.5-flash-preview-image' },
  });
  assert.equal(error.code, 'billing_required');
});

test('other statuses map to the code the UI explains', () => {
  assert.equal(classifyHttpError(429, { error: { message: 'Too many requests. Please retry in 20s' } }).code, 'rate_limited');
  assert.equal(classifyHttpError(429, { error: { message: 'Please retry in 20s' } }).retryAfterSeconds, 20);
  assert.equal(classifyHttpError(403, null).code, 'invalid_key');
  assert.equal(classifyHttpError(400, { error: { message: 'API key not valid. Please pass a valid API key.' } }).code, 'invalid_key');
  assert.equal(classifyHttpError(404, null).code, 'model_unavailable');
  assert.equal(classifyHttpError(503, null).code, 'overloaded');
  assert.equal(classifyHttpError(400, { error: { message: 'bad aspect ratio' } }).code, 'bad_request');
});

test('a reply with an image gives the image and any text', () => {
  const result = parseResponse('m', IMAGE_REPLY, 'edit');
  assert.equal(result.text, 'Done.');
  assert.deepEqual(result.image, { mimeType: 'image/png', data: 'QUJD' });
});

test('words without a picture is no_image and keeps what the model said', () => {
  const only = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'I cannot draw that.' }] } }] };
  assert.throws(
    () => parseResponse('m', only, 'edit'),
    (error: unknown) => error instanceof GeminiError && error.code === 'no_image' && error.modelText === 'I cannot draw that.',
  );
});

test('a blocked prompt and a safety stop are reported as blocked', () => {
  assert.throws(() => parseResponse('m', { promptFeedback: { blockReason: 'SAFETY' } }, 'edit'), (e: unknown) => e instanceof GeminiError && e.code === 'blocked');
  assert.throws(
    () => parseResponse('m', { candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] }, 'edit'),
    (e: unknown) => e instanceof GeminiError && e.code === 'blocked',
  );
});

test('describe mode needs text, and ignores thought parts', () => {
  const ok = parseResponse('m', { candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: 'A cat.' }] } }] }, 'describe');
  assert.equal(ok.text, 'A cat.');
  assert.throws(() => parseResponse('m', { candidates: [{ content: { parts: [] } }] }, 'describe'), (e: unknown) => e instanceof GeminiError);
});

test('generate sends the key as a header, never in the URL', async () => {
  const seen: { url: string; key: string | null }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, key: new Headers(init.headers).get('x-goog-api-key') });
    return reply(200, IMAGE_REPLY);
  }) as unknown as typeof fetch;
  const result = await generate(REQUEST, { apiKey: 'AIzaTEST', fetchImpl, origin: 'http://mock' });
  assert.equal(result.model, 'gemini-nano-banana-2.1');
  assert.equal(seen[0].key, 'AIzaTEST');
  assert.equal(seen[0].url.includes('AIzaTEST'), false);
  assert.equal(seen[0].url, 'http://mock/v1beta/models/gemini-nano-banana-2.1:generateContent');
});

test('a retired model falls through its chain and the result says which model ran', async () => {
  const tried: string[] = [];
  const fetchImpl = (async (url: string) => {
    const model = /models\/([^:]+):/.exec(url)![1];
    tried.push(model);
    return model === 'gemini-2.5-flash-image' ? reply(200, IMAGE_REPLY) : reply(404, { error: { message: 'not found' } });
  }) as unknown as typeof fetch;
  const result = await generate(REQUEST, { apiKey: 'k', fetchImpl, origin: 'http://mock' });
  assert.deepEqual(tried, ['gemini-nano-banana-2.1', 'gemini-3.1-flash-image', 'gemini-2.5-flash-image']);
  assert.equal(result.model, 'gemini-2.5-flash-image');
});

test('no billing stops at once instead of trying every model', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return reply(429, { error: { message: 'Quota exceeded, limit: 0, free_tier' } });
  }) as unknown as typeof fetch;
  await assert.rejects(
    generate(REQUEST, { apiKey: 'k', fetchImpl, origin: 'http://mock' }),
    (error: unknown) => error instanceof GeminiError && error.code === 'billing_required',
  );
  assert.equal(calls, 1);
});

test('a busy model is retried once, then the next model is tried, then it gives up', async () => {
  let calls = 0;
  const flaky = (async () => {
    calls += 1;
    return calls === 1 ? reply(503, { error: { message: 'busy' } }) : reply(200, IMAGE_REPLY);
  }) as unknown as typeof fetch;
  const result = await generate(REQUEST, { apiKey: 'k', fetchImpl: flaky, origin: 'http://mock', retryDelayMs: 1 });
  assert.equal(result.image?.data, 'QUJD');
  assert.equal(calls, 2);

  let always = 0;
  const busy = (async () => {
    always += 1;
    return reply(503, {});
  }) as unknown as typeof fetch;
  await assert.rejects(generate(REQUEST, { apiKey: 'k', fetchImpl: busy, origin: 'http://mock', retryDelayMs: 1 }), (e: unknown) => e instanceof GeminiError && e.code === 'overloaded');
  // Two tries on each of the three models in the chain.
  assert.equal(always, 6);
});

test('a missing key fails before any network call', async () => {
  const fetchImpl = (async () => {
    throw new Error('should not be called');
  }) as unknown as typeof fetch;
  await assert.rejects(generate(REQUEST, { apiKey: '', fetchImpl }), (e: unknown) => e instanceof GeminiError && e.code === 'no_key');
});

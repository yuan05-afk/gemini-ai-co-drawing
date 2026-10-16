import { generate, GeminiError, type EditRequest, type GeminiErrorCode } from '../src/lib/gemini.js';
import { ALLOWED_MODEL_IDS, SUPPORTED_ASPECT_RATIOS } from '../src/lib/models.js';

/**
 * POST /api/generate
 *
 * Runs a Gemini call on the server so the owner's key never reaches the browser.
 * A visitor who sends their own key in `x-user-api-key` pays for their own call and
 * skips the rate limit. Without either key the route answers `no_key`.
 */

export const config = { maxDuration: 60 };

const MAX_BODY_BYTES = 4_400_000; // Vercel rejects request bodies above 4.5 MB
const MAX_PROMPT_CHARS = 500;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_CALLS_PER_WINDOW = 8;

const hits = new Map<string, number[]>();

/** Best-effort per-instance limiter. It slows casual abuse of the owner's key; it is not a quota. */
function limited(ip: string, now = Date.now()): { limited: boolean; retryAfter: number } {
  const recent = (hits.get(ip) ?? []).filter((time) => now - time < WINDOW_MS);
  if (recent.length >= MAX_CALLS_PER_WINDOW) {
    hits.set(ip, recent);
    return { limited: true, retryAfter: Math.ceil((WINDOW_MS - (now - recent[0])) / 1000) };
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [key, times] of hits) if (!times.some((time) => now - time < WINDOW_MS)) hits.delete(key);
  }
  return { limited: false, retryAfter: 0 };
}

const STATUS: Record<GeminiErrorCode, number> = {
  invalid_key: 401,
  no_key: 401,
  billing_required: 402,
  rate_limited: 429,
  model_unavailable: 502,
  overloaded: 503,
  blocked: 422,
  no_image: 422,
  bad_request: 400,
  too_large: 413,
  network: 502,
  unknown: 502,
};

function fail(code: GeminiErrorCode, error: string, extra: Record<string, unknown> = {}) {
  return Response.json({ ok: false, code, error, ...extra }, { status: STATUS[code], headers: { 'cache-control': 'no-store' } });
}

function parseBody(value: unknown): EditRequest | string {
  if (!value || typeof value !== 'object') return 'Send a JSON body.';
  const body = value as Record<string, unknown>;
  if (body.mode !== 'edit' && body.mode !== 'describe') return 'mode must be "edit" or "describe".';
  if (typeof body.model !== 'string' || !ALLOWED_MODEL_IDS.has(body.model)) return 'That model is not available here.';
  if (body.imageMimeType !== 'image/png' && body.imageMimeType !== 'image/jpeg') return 'imageMimeType must be image/png or image/jpeg.';
  if (typeof body.imageBase64 !== 'string' || body.imageBase64.length < 20 || !/^[A-Za-z0-9+/=]+$/.test(body.imageBase64)) {
    return 'imageBase64 must be base64 image data without a data: prefix.';
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (body.mode === 'edit' && !prompt) return 'Describe the change you want.';
  if (prompt.length > MAX_PROMPT_CHARS) return `Keep the prompt under ${MAX_PROMPT_CHARS} characters.`;
  const ratio = (SUPPORTED_ASPECT_RATIOS as readonly string[]).includes(String(body.aspectRatio)) ? String(body.aspectRatio) : '1:1';
  return {
    mode: body.mode,
    model: body.model,
    imageBase64: body.imageBase64,
    imageMimeType: body.imageMimeType,
    prompt,
    keepLineStyle: body.keepLineStyle !== false,
    aspectRatio: ratio as EditRequest['aspectRatio'],
  };
}

export async function POST(request: Request): Promise<Response> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) return fail('too_large', 'The drawing is too large to send. Choose a smaller canvas.');

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail('bad_request', 'The request body was not valid JSON.');
  }
  const parsed = parseBody(raw);
  if (typeof parsed === 'string') return fail('bad_request', parsed);

  const userKey = request.headers.get('x-user-api-key')?.trim();
  const apiKey = userKey || process.env.GEMINI_API_KEY || '';
  if (!apiKey) {
    return fail('no_key', 'No Gemini API key is configured. Add your own key in Settings.');
  }

  if (!userKey) {
    const ip = (request.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim();
    const gate = limited(ip);
    if (gate.limited) {
      return fail('rate_limited', 'This demo allows a few edits every ten minutes. Add your own key in Settings to keep going.', {
        retryAfterSeconds: gate.retryAfter,
      });
    }
  }

  try {
    const result = await generate(parsed, { apiKey, origin: process.env.GEMINI_API_ORIGIN || undefined });
    return Response.json({ ok: true, ...result }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof GeminiError) {
      return fail(error.code, error.message, { retryAfterSeconds: error.retryAfterSeconds, modelText: error.modelText });
    }
    console.error(error);
    return fail('unknown', 'Something went wrong on the server.');
  }
}

export function GET(): Response {
  return Response.json(
    { ok: true, configured: Boolean(process.env.GEMINI_API_KEY) },
    { headers: { 'cache-control': 'no-store' } },
  );
}

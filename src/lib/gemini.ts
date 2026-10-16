import { modelChain, type AspectRatio } from './models';

/**
 * Talks to the Gemini REST API with plain fetch. The same code runs in the
 * browser (when a visitor brings their own key) and in the Vercel route
 * (api/generate.ts), so there is one place that knows the request shape.
 */

export const GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com';

export type GeminiErrorCode =
  | 'invalid_key'
  | 'billing_required'
  | 'rate_limited'
  | 'model_unavailable'
  | 'overloaded'
  | 'blocked'
  | 'no_image'
  | 'bad_request'
  | 'too_large'
  | 'no_key'
  | 'network'
  | 'unknown';

export class GeminiError extends Error {
  code: GeminiErrorCode;
  retryAfterSeconds?: number;
  /** Text the model sent back instead of an image, when there is any. */
  modelText?: string;

  constructor(code: GeminiErrorCode, message: string, extra: { retryAfterSeconds?: number; modelText?: string } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.code = code;
    this.retryAfterSeconds = extra.retryAfterSeconds;
    this.modelText = extra.modelText;
  }
}

export type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

type GenerateResponse = {
  candidates?: {
    finishReason?: string;
    content?: { parts?: { text?: string; inlineData?: { mimeType?: string; data?: string }; thought?: boolean }[] };
  }[];
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  error?: { code?: number; message?: string; status?: string };
};

export type GeminiResult = {
  model: string;
  text: string;
  image: { mimeType: string; data: string } | null;
};

/** Seconds from "Please retry in 9h28m49.6s" or "retry in 34s", when the message has it. */
export function parseRetryAfter(message: string): number | undefined {
  const match = /retry in\s+((?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?)/i.exec(message);
  if (!match || !match[1]) return undefined;
  const hours = Number(/(\d+)h/.exec(match[1])?.[1] ?? 0);
  const minutes = Number(/(\d+)m/.exec(match[1])?.[1] ?? 0);
  const seconds = Number(/(\d+(?:\.\d+)?)s/.exec(match[1])?.[1] ?? 0);
  const total = Math.ceil(hours * 3600 + minutes * 60 + seconds);
  return total > 0 ? total : undefined;
}

/** Turns Google's HTTP error into one code the UI can explain in plain words. */
export function classifyHttpError(status: number, body: unknown): GeminiError {
  const message =
    (body as GenerateResponse | null)?.error?.message ??
    (typeof body === 'string' ? body : '') ??
    '';
  const text = String(message);

  if (status === 429) {
    // A zero free-tier limit means the key has no billing, not that the visitor was too fast.
    if (/limit:\s*0/i.test(text) || /free[_ ]tier/i.test(text)) {
      return new GeminiError(
        'billing_required',
        'This key has no free quota for image models. Image editing needs a Gemini API key with billing enabled.',
      );
    }
    return new GeminiError('rate_limited', 'Too many requests right now. Wait a moment and try again.', {
      retryAfterSeconds: parseRetryAfter(text),
    });
  }
  if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID|permission denied/i.test(text)) {
    return new GeminiError('invalid_key', 'Google did not accept this API key. Check it and try again.');
  }
  if (status === 404) {
    return new GeminiError('model_unavailable', 'That model is no longer available.');
  }
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return new GeminiError('overloaded', 'Gemini is busy right now. Try again in a few seconds.');
  }
  if (status === 413) {
    return new GeminiError('too_large', 'The drawing is too large to send. Try a smaller canvas.');
  }
  if (status === 400) {
    return new GeminiError('bad_request', text ? `Google rejected the request: ${text.split('\n')[0]}` : 'Google rejected the request.');
  }
  return new GeminiError('unknown', text || `Unexpected response (${status}).`);
}

export type EditRequest = {
  mode: 'edit' | 'describe';
  model: string;
  /** PNG or JPEG of the canvas, base64 without the data: prefix. */
  imageBase64: string;
  imageMimeType: 'image/png' | 'image/jpeg';
  prompt: string;
  keepLineStyle: boolean;
  aspectRatio: AspectRatio;
};

/** What we ask the model to do. Kept in one place so it is easy to read and test. */
export function buildInstruction(prompt: string, mode: 'edit' | 'describe', keepLineStyle: boolean): string {
  const clean = prompt.trim();
  if (mode === 'describe') {
    return clean
      ? `Describe this drawing in two or three friendly sentences. Also answer this: ${clean}`
      : 'Describe this drawing in two or three friendly sentences.';
  }
  const style = keepLineStyle ? ' Keep the same minimal line-drawing style and the same composition.' : '';
  return `Edit the attached drawing: ${clean}.${style} Return the edited image.`;
}

export function buildBody(request: EditRequest) {
  const parts: GeminiPart[] = [
    { inlineData: { mimeType: request.imageMimeType, data: request.imageBase64 } },
    { text: buildInstruction(request.prompt, request.mode, request.keepLineStyle) },
  ];
  const body: Record<string, unknown> = { contents: [{ role: 'user', parts }] };
  if (request.mode === 'edit') {
    body.generationConfig = {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: request.aspectRatio },
    };
  }
  return body;
}

/** Reads a generateContent reply. Throws a GeminiError when there is nothing usable. */
export function parseResponse(model: string, json: GenerateResponse, mode: 'edit' | 'describe'): GeminiResult {
  const blocked = json.promptFeedback?.blockReason;
  if (blocked) {
    throw new GeminiError('blocked', json.promptFeedback?.blockReasonMessage || `The request was blocked (${blocked}).`);
  }
  const candidate = json.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  let text = '';
  let image: GeminiResult['image'] = null;
  for (const part of parts) {
    if (part.thought) continue;
    if (part.text) text += (text ? '\n' : '') + part.text;
    if (part.inlineData?.data && !image) {
      image = { mimeType: part.inlineData.mimeType || 'image/png', data: part.inlineData.data };
    }
  }
  if (mode === 'edit' && !image) {
    const reason = candidate?.finishReason;
    if (reason && reason !== 'STOP') {
      throw new GeminiError('blocked', `Gemini stopped before drawing (${reason}).`, { modelText: text || undefined });
    }
    throw new GeminiError('no_image', 'Gemini answered with words but no picture. Try rephrasing the change.', {
      modelText: text || undefined,
    });
  }
  if (mode === 'describe' && !text) {
    throw new GeminiError('no_image', 'Gemini did not return a description. Try again.');
  }
  return { model, text, image };
}

type CallOptions = {
  apiKey: string;
  /** Override for tests, or a proxy. Defaults to Google. */
  origin?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

async function callOnce(model: string, request: EditRequest, options: CallOptions): Promise<GeminiResult> {
  const fetcher = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${options.origin ?? GEMINI_ORIGIN}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey },
      body: JSON.stringify(buildBody(request)),
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    throw new GeminiError('network', 'Could not reach Gemini. Check your connection and try again.');
  }

  let json: GenerateResponse | null = null;
  try {
    json = (await response.json()) as GenerateResponse;
  } catch {
    json = null;
  }
  if (!response.ok) throw classifyHttpError(response.status, json);
  return parseResponse(model, json ?? {}, request.mode);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls the chosen model. A busy model (503) is retried once after a short pause. A model
 * that is gone (404) or still busy moves to the next model in its fallback chain.
 * Anything else, such as a bad key or no billing, is thrown at once.
 */
export async function generate(request: EditRequest, options: CallOptions & { retryDelayMs?: number }): Promise<GeminiResult> {
  if (!options.apiKey) throw new GeminiError('no_key', 'Add a Gemini API key to use this.');
  const chain = modelChain(request.model);
  let lastError: GeminiError | null = null;

  for (const model of chain) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await callOnce(model, request, options);
      } catch (error) {
        if (!(error instanceof GeminiError)) throw error;
        lastError = error;
        if (error.code === 'overloaded' && attempt === 0) {
          await sleep(options.retryDelayMs ?? 1200);
          continue;
        }
        break;
      }
    }
    // A missing or busy model is worth swapping for the next one. A bad key or no billing is the same for every model.
    if (lastError?.code !== 'model_unavailable' && lastError?.code !== 'overloaded') break;
  }

  throw lastError ?? new GeminiError('unknown', 'Something went wrong.');
}

/** Short sentence for each error, with what the visitor can do next. */
export function adviceFor(code: GeminiErrorCode): string {
  switch (code) {
    case 'billing_required':
      return 'Open Google AI Studio, enable billing on the key’s project, then try again. Describe mode still works on a free key.';
    case 'invalid_key':
      return 'Paste the key again from Google AI Studio (it starts with AIza).';
    case 'no_key':
      return 'Open Settings and add your own Gemini API key. It stays in this browser.';
    case 'rate_limited':
      return 'Wait a little, then press Send again.';
    case 'overloaded':
      return 'Gemini is under heavy demand. Press Send again in a few seconds.';
    case 'model_unavailable':
      return 'Pick another model from the list.';
    case 'blocked':
      return 'Try a different drawing or wording.';
    case 'no_image':
      return 'Try describing the change more concretely, for example “add a red hat”.';
    case 'too_large':
      return 'Choose a smaller canvas size.';
    case 'network':
      return 'Check your connection.';
    default:
      return 'Try again in a moment.';
  }
}

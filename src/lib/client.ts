import { generate, GeminiError, type EditRequest, type GeminiErrorCode, type GeminiResult } from './gemini';

const KEY_STORAGE = 'gemini-codrawing:key';
const REMEMBER_STORAGE = 'gemini-codrawing:remember';

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Reads the visitor's own key. It lives in this browser only. */
export function loadKey(): { key: string; remember: boolean } {
  const remember = safe(() => localStorage.getItem(REMEMBER_STORAGE) === '1', false);
  const key = safe(() => (remember ? localStorage.getItem(KEY_STORAGE) : sessionStorage.getItem(KEY_STORAGE)) ?? '', '');
  return { key, remember };
}

export function saveKey(key: string, remember: boolean) {
  safe(() => {
    localStorage.removeItem(KEY_STORAGE);
    sessionStorage.removeItem(KEY_STORAGE);
    localStorage.setItem(REMEMBER_STORAGE, remember ? '1' : '0');
    if (key) (remember ? localStorage : sessionStorage).setItem(KEY_STORAGE, key);
  }, undefined);
}

export function looksLikeKey(value: string): boolean {
  return /^AIza[0-9A-Za-z_-]{30,}$/.test(value.trim());
}

type ProxyReply =
  | ({ ok: true } & GeminiResult)
  | { ok: false; code: GeminiErrorCode; error: string; retryAfterSeconds?: number; modelText?: string };

/**
 * With a visitor key the browser calls Google directly, so the key never touches this site's server.
 * Without one, the request goes through /api/generate, which uses the owner's key if there is one.
 */
export async function requestGemini(request: EditRequest, userKey: string, signal?: AbortSignal): Promise<GeminiResult> {
  if (userKey) return generate(request, { apiKey: userKey, signal });

  let response: Response;
  try {
    response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    throw new GeminiError('network', 'Could not reach the server. Check your connection and try again.');
  }

  let reply: ProxyReply | null = null;
  try {
    reply = (await response.json()) as ProxyReply;
  } catch {
    reply = null;
  }
  if (!reply) {
    if (response.status === 413) throw new GeminiError('too_large', 'The drawing is too large to send. Choose a smaller canvas.');
    throw new GeminiError('unknown', `The server answered ${response.status} without a message.`);
  }
  if (!reply.ok) {
    throw new GeminiError(reply.code, reply.error, { retryAfterSeconds: reply.retryAfterSeconds, modelText: reply.modelText });
  }
  return { model: reply.model, text: reply.text, image: reply.image };
}

/** Whether the server has a key of its own, so the UI can say what Send will use. */
export async function serverHasKey(): Promise<boolean> {
  try {
    const response = await fetch('/api/generate', { method: 'GET' });
    if (!response.ok) return false;
    const reply = (await response.json()) as { configured?: boolean };
    return Boolean(reply.configured);
  } catch {
    return false;
  }
}

/** Asks Google for one model to see whether the key is accepted. Does not use any generation quota. */
export async function checkKey(key: string): Promise<{ ok: boolean; text: string }> {
  if (!key) return { ok: false, text: 'Paste a key first.' };
  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
      headers: { 'x-goog-api-key': key },
    });
    if (response.ok) {
      return {
        ok: true,
        text: 'Google accepted this key. Describe mode will work. Image editing also needs billing enabled on the key’s project.',
      };
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      return { ok: false, text: 'Google did not accept this key. Copy it again from AI Studio.' };
    }
    return { ok: false, text: `Google answered ${response.status}. Try again in a moment.` };
  } catch {
    return { ok: false, text: 'Could not reach Google. Check your connection.' };
  }
}

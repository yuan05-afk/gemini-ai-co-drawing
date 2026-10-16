// Manual check against the real API with the key in GEMINI_API_KEY: npx tsx test/live.mts
import { generate, GeminiError } from '../src/lib/gemini';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/wcAAwAB/epv2AAAAABJRU5ErkJggg==';
const base = { imageBase64: png, imageMimeType: 'image/png' as const, keepLineStyle: true, aspectRatio: '16:9' as const };
const key = process.env.GEMINI_API_KEY ?? '';

for (const request of [
  { ...base, mode: 'describe' as const, model: 'gemini-2.5-flash', prompt: '' },
  { ...base, mode: 'edit' as const, model: 'gemini-nano-banana-2.1', prompt: 'make it blue' },
]) {
  try {
    const result = await generate(request, { apiKey: key, retryDelayMs: 2000 });
    console.log(request.mode, 'OK via', result.model, '| text:', result.text.slice(0, 80), '| image:', result.image ? 'yes' : 'no');
  } catch (error) {
    console.log(request.mode, 'FAILED:', error instanceof GeminiError ? `${error.code} - ${error.message}` : String(error));
  }
}

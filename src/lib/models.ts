/**
 * Models this app can call, checked against the live Gemini API model list
 * (October 2026). Google retires preview models often, so every edit model
 * lists fallbacks: if one answers 404, the next is tried and the UI says which ran.
 *
 * Retired and removed: gemini-2.5-flash-image-preview, gemini-2.0-flash-preview-image-generation,
 * and the whole Imagen family (shut down by Google).
 */

export type ModelMode = 'edit' | 'describe';

export type ModelOption = {
  id: string;
  label: string;
  note: string;
  mode: ModelMode;
  /** Tried in order when this model is not found (retired or renamed). */
  fallbacks: readonly string[];
};

export const MODELS: readonly ModelOption[] = [
  {
    id: 'gemini-nano-banana-2.1',
    label: 'Nano Banana 2.1',
    note: 'Best all-rounder for editing. Recommended.',
    mode: 'edit',
    fallbacks: ['gemini-3.1-flash-image', 'gemini-2.5-flash-image'],
  },
  {
    id: 'gemini-3.1-flash-lite-image',
    label: 'Nano Banana 2 Lite',
    note: 'Fastest and cheapest. Simple edits.',
    mode: 'edit',
    fallbacks: ['gemini-2.5-flash-image'],
  },
  {
    id: 'gemini-3-pro-image',
    label: 'Nano Banana Pro',
    note: 'Slowest, for the most detailed results.',
    mode: 'edit',
    fallbacks: ['gemini-nano-banana-2.1', 'gemini-3.1-flash-image'],
  },
  {
    id: 'gemini-2.5-flash-image',
    label: 'Nano Banana (classic)',
    note: 'The original model. Kept as a safe fallback.',
    mode: 'edit',
    fallbacks: ['gemini-3.1-flash-image'],
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini Flash (describe)',
    note: 'Describes your drawing in words. Works on free keys.',
    mode: 'describe',
    fallbacks: ['gemini-flash-latest', 'gemini-3.5-flash'],
  },
];

export const DEFAULT_MODEL_ID = MODELS[0].id;

export function findModel(id: string): ModelOption | undefined {
  return MODELS.find((model) => model.id === id);
}

/** Only these ids may be sent to Google through this site's API route. */
export const ALLOWED_MODEL_IDS: ReadonlySet<string> = new Set(
  MODELS.flatMap((model) => [model.id, ...model.fallbacks]),
);

export function modelChain(id: string): string[] {
  const option = findModel(id);
  return option ? [option.id, ...option.fallbacks] : [id];
}

/** Aspect ratios the Gemini image models accept (from the live API's own validation message). */
export const SUPPORTED_ASPECT_RATIOS = [
  '1:1',
  '1:4',
  '1:8',
  '2:3',
  '3:2',
  '3:4',
  '4:1',
  '4:3',
  '4:5',
  '5:4',
  '8:1',
  '9:16',
  '16:9',
  '21:9',
] as const;

export type AspectRatio = (typeof SUPPORTED_ASPECT_RATIOS)[number];

export type CanvasPreset = { id: string; label: string; ratio: AspectRatio; width: number; height: number };

export const CANVAS_PRESETS: readonly CanvasPreset[] = [
  { id: 'wide', label: '16:9', ratio: '16:9', width: 960, height: 540 },
  { id: 'photo', label: '4:3', ratio: '4:3', width: 800, height: 600 },
  { id: 'square', label: '1:1', ratio: '1:1', width: 720, height: 720 },
  { id: 'portrait', label: '3:4', ratio: '3:4', width: 600, height: 800 },
  { id: 'tall', label: '9:16', ratio: '9:16', width: 540, height: 960 },
];

/** The supported ratio closest to width:height, so an output matches the canvas shape. */
export function nearestAspectRatio(width: number, height: number): AspectRatio {
  const target = width / height;
  let best: AspectRatio = '1:1';
  let bestGap = Infinity;
  for (const ratio of SUPPORTED_ASPECT_RATIOS) {
    const [w, h] = ratio.split(':').map(Number);
    const gap = Math.abs(Math.log(w / h / target));
    if (gap < bestGap) {
      best = ratio;
      bestGap = gap;
    }
  }
  return best;
}

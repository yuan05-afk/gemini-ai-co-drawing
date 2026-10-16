/**
 * The drawing surface, kept apart from React so it is easy to reason about.
 *
 * `base` is an off-screen canvas that holds the committed picture. The visible canvas
 * (`view`) draws `base`, then the picture being placed (`floating`) with its handles.
 * Every committed change becomes a history entry stored as a PNG blob, so a long
 * session does not hold dozens of raw bitmaps in memory.
 */

export type Tool = 'pen' | 'eraser';

export type HistoryKind = 'start' | 'draw' | 'place' | 'clear' | 'edit' | 'describe';

export type HistoryEntry = {
  id: string;
  kind: HistoryKind;
  label: string;
  /** Extra text, such as the model that ran or a description. */
  note?: string;
  url: string;
  blob: Blob;
  time: number;
};

type Handle = 'nw' | 'ne' | 'sw' | 'se';

type Floating = {
  bitmap: ImageBitmap;
  x: number;
  y: number;
  width: number;
  height: number;
  aspect: number;
};

type Interaction =
  | { type: 'stroke'; lastX: number; lastY: number; midX: number; midY: number }
  | { type: 'drag'; startX: number; startY: number; originX: number; originY: number }
  | { type: 'resize'; handle: Handle; startX: number; startY: number; origin: { x: number; y: number; width: number; height: number } };

export type StudioState = {
  width: number;
  height: number;
  historyIndex: number;
  historyLength: number;
  hasFloating: boolean;
  dirty: boolean;
  busyRestoring: boolean;
  /** Bumps on every change, so a panel that lists the history re-renders when entries are trimmed. */
  revision: number;
};

const MAX_HISTORY = 40;
const HANDLE_CSS_PX = 14;
const MIN_FLOATING = 24;

function uid() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not read the canvas.'))), type, quality);
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image.'));
    reader.readAsDataURL(blob);
  });
}

export class Studio {
  width: number;
  height: number;
  tool: Tool = 'pen';
  color = '#111111';
  size = 6;

  history: HistoryEntry[] = [];
  historyIndex = -1;

  private base: HTMLCanvasElement;
  private baseCtx: CanvasRenderingContext2D;
  private view: HTMLCanvasElement | null = null;
  private floating: Floating | null = null;
  private interaction: Interaction | null = null;
  private frame = 0;
  private listeners = new Set<() => void>();
  private snapshotQueue: Promise<unknown> = Promise.resolve();
  private restoring = false;
  private drawnSinceSnapshot = false;
  private cached: StudioState | null = null;
  private revision = 0;
  private started = false;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.base = document.createElement('canvas');
    this.base.width = width;
    this.base.height = height;
    const ctx = this.base.getContext('2d', { willReadFrequently: false });
    if (!ctx) throw new Error('Canvas is not supported in this browser.');
    this.baseCtx = ctx;
    this.fillWhite();
  }

  // ---- subscription (for useSyncExternalStore) -------------------------------------------------

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): StudioState => {
    const next: StudioState = {
      width: this.width,
      height: this.height,
      historyIndex: this.historyIndex,
      historyLength: this.history.length,
      hasFloating: this.floating !== null,
      dirty: this.history.length > 1 || this.drawnSinceSnapshot,
      busyRestoring: this.restoring,
      revision: this.revision,
    };
    const prev = this.cached;
    if (prev && (Object.keys(next) as (keyof StudioState)[]).every((key) => prev[key] === next[key])) return prev;
    this.cached = next;
    return next;
  };

  private emit() {
    this.revision += 1;
    this.cached = null;
    for (const listener of this.listeners) listener();
  }

  // ---- view -----------------------------------------------------------------------------------

  attach(view: HTMLCanvasElement | null) {
    this.view = view;
    if (view) {
      view.width = this.width;
      view.height = this.height;
      this.render();
    }
  }

  private fillWhite() {
    this.baseCtx.fillStyle = '#ffffff';
    this.baseCtx.fillRect(0, 0, this.width, this.height);
  }

  requestRender() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render() {
    const view = this.view;
    if (!view) return;
    const ctx = view.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.drawImage(this.base, 0, 0);
    const floating = this.floating;
    if (!floating) return;
    ctx.drawImage(floating.bitmap, floating.x, floating.y, floating.width, floating.height);
    const scale = this.scaleFactor();
    ctx.save();
    ctx.strokeStyle = '#1d4ed8';
    ctx.lineWidth = 2 * scale;
    ctx.setLineDash([6 * scale, 4 * scale]);
    ctx.strokeRect(floating.x, floating.y, floating.width, floating.height);
    ctx.setLineDash([]);
    const size = HANDLE_CSS_PX * scale;
    for (const rect of Object.values(this.handleRects(floating, size))) {
      ctx.fillStyle = '#1d4ed8';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2 * scale;
      ctx.fillRect(rect.x, rect.y, rect.size, rect.size);
      ctx.strokeRect(rect.x, rect.y, rect.size, rect.size);
    }
    ctx.restore();
  }

  /** Canvas pixels per CSS pixel, so handles stay a finger-sized target on any screen. */
  private scaleFactor() {
    const view = this.view;
    if (!view) return 1;
    const rect = view.getBoundingClientRect();
    return rect.width > 0 ? view.width / rect.width : 1;
  }

  private handleRects(floating: Floating, size: number) {
    const half = size / 2;
    return {
      nw: { x: floating.x - half, y: floating.y - half, size },
      ne: { x: floating.x + floating.width - half, y: floating.y - half, size },
      sw: { x: floating.x - half, y: floating.y + floating.height - half, size },
      se: { x: floating.x + floating.width - half, y: floating.y + floating.height - half, size },
    } satisfies Record<Handle, { x: number; y: number; size: number }>;
  }

  /** Converts a pointer position on the visible canvas to canvas pixels. */
  toCanvas(clientX: number, clientY: number) {
    const view = this.view;
    if (!view) return { x: 0, y: 0 };
    const rect = view.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * view.width,
      y: ((clientY - rect.top) / rect.height) * view.height,
    };
  }

  // ---- pointer handling -------------------------------------------------------------------------

  pointerDown(x: number, y: number, pressure = 0.5) {
    const floating = this.floating;
    if (floating) {
      const size = HANDLE_CSS_PX * 1.6 * this.scaleFactor();
      for (const [key, rect] of Object.entries(this.handleRects(floating, size)) as [Handle, { x: number; y: number; size: number }][]) {
        if (x >= rect.x && x <= rect.x + rect.size && y >= rect.y && y <= rect.y + rect.size) {
          this.interaction = {
            type: 'resize',
            handle: key,
            startX: x,
            startY: y,
            origin: { x: floating.x, y: floating.y, width: floating.width, height: floating.height },
          };
          return;
        }
      }
      if (x >= floating.x && x <= floating.x + floating.width && y >= floating.y && y <= floating.y + floating.height) {
        this.interaction = { type: 'drag', startX: x, startY: y, originX: floating.x, originY: floating.y };
        return;
      }
      // A tap outside the picture puts it down, then the same gesture starts a stroke.
      this.placeNow();
    }
    this.beginStroke(x, y, pressure);
  }

  private strokeWidth(pressure: number) {
    const base = this.tool === 'eraser' ? this.size * 2.4 : this.size;
    // Pens report pressure; a mouse reports a constant 0.5, which keeps the width as chosen.
    return pressure > 0 && pressure !== 0.5 ? Math.max(1, base * (0.4 + pressure)) : base;
  }

  private styleStroke(pressure: number) {
    const ctx = this.baseCtx;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = this.strokeWidth(pressure);
    ctx.strokeStyle = this.tool === 'eraser' ? '#ffffff' : this.color;
    ctx.fillStyle = ctx.strokeStyle;
  }

  private beginStroke(x: number, y: number, pressure: number) {
    this.styleStroke(pressure);
    const ctx = this.baseCtx;
    // A tap leaves a dot.
    ctx.beginPath();
    ctx.arc(x, y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    this.interaction = { type: 'stroke', lastX: x, lastY: y, midX: x, midY: y };
    this.drawnSinceSnapshot = true;
    this.requestRender();
    this.emit();
  }

  pointerMove(x: number, y: number, pressure = 0.5) {
    const action = this.interaction;
    if (!action) return;
    if (action.type === 'stroke') {
      this.styleStroke(pressure);
      const ctx = this.baseCtx;
      const midX = (action.lastX + x) / 2;
      const midY = (action.lastY + y) / 2;
      ctx.beginPath();
      ctx.moveTo(action.midX, action.midY);
      ctx.quadraticCurveTo(action.lastX, action.lastY, midX, midY);
      ctx.stroke();
      action.lastX = x;
      action.lastY = y;
      action.midX = midX;
      action.midY = midY;
      this.requestRender();
      return;
    }
    const floating = this.floating;
    if (!floating) return;
    if (action.type === 'drag') {
      floating.x = Math.max(-floating.width + MIN_FLOATING, Math.min(this.width - MIN_FLOATING, action.originX + (x - action.startX)));
      floating.y = Math.max(-floating.height + MIN_FLOATING, Math.min(this.height - MIN_FLOATING, action.originY + (y - action.startY)));
    } else {
      const { origin, handle } = action;
      const dx = x - action.startX;
      // Corner drags keep the picture's shape, driven by the horizontal movement.
      const grow = handle === 'ne' || handle === 'se' ? dx : -dx;
      const width = Math.max(MIN_FLOATING, origin.width + grow);
      const height = width / floating.aspect;
      floating.width = width;
      floating.height = height;
      floating.x = handle === 'nw' || handle === 'sw' ? origin.x + (origin.width - width) : origin.x;
      floating.y = handle === 'nw' || handle === 'ne' ? origin.y + (origin.height - height) : origin.y;
    }
    this.requestRender();
  }

  async pointerUp() {
    const action = this.interaction;
    this.interaction = null;
    if (action?.type === 'stroke') {
      await this.snapshot('draw', 'Drawing');
      this.drawnSinceSnapshot = false;
    } else if (action) {
      this.requestRender();
    }
  }

  // ---- placing pictures -------------------------------------------------------------------------

  /** Puts a picture on the canvas as a movable layer, fitted inside 80% of the canvas. */
  async addPicture(source: Blob) {
    await this.placeNowAsync();
    const bitmap = await createImageBitmap(source);
    const maxW = this.width * 0.8;
    const maxH = this.height * 0.8;
    const scale = Math.min(1, maxW / bitmap.width, maxH / bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    this.floating?.bitmap.close();
    this.floating = {
      bitmap,
      width,
      height,
      x: (this.width - width) / 2,
      y: (this.height - height) / 2,
      aspect: bitmap.width / bitmap.height,
    };
    this.requestRender();
    this.emit();
  }

  /** Flattens the movable picture into the drawing. Resolves once the history entry exists. */
  async placeNowAsync() {
    this.placeNow();
    await this.snapshotQueue;
  }

  placeNow() {
    const floating = this.floating;
    if (!floating) return;
    this.baseCtx.drawImage(floating.bitmap, floating.x, floating.y, floating.width, floating.height);
    floating.bitmap.close();
    this.floating = null;
    this.render();
    void this.snapshot('place', 'Picture placed');
    this.emit();
  }

  discardFloating() {
    if (!this.floating) return;
    this.floating.bitmap.close();
    this.floating = null;
    this.requestRender();
    this.emit();
  }

  // ---- history ----------------------------------------------------------------------------------

  snapshot(kind: HistoryKind, label: string, note?: string): Promise<HistoryEntry> {
    // Encode now, while the canvas still shows this exact state, then queue the bookkeeping in order.
    const encoded = toBlob(this.base, 'image/png');
    const run = async () => {
      const blob = await encoded;
      const entry: HistoryEntry = { id: uid(), kind, label, note, blob, url: URL.createObjectURL(blob), time: Date.now() };
      this.history.push(entry);
      while (this.history.length > MAX_HISTORY) {
        const [oldest, ...rest] = this.history;
        // Keep the blank start so "Revert" always has somewhere to go back to.
        const dropped = rest.shift();
        if (dropped) URL.revokeObjectURL(dropped.url);
        this.history = [oldest, ...rest];
      }
      this.historyIndex = this.history.length - 1;
      this.emit();
      return entry;
    };
    const next = this.snapshotQueue.then(run, run);
    this.snapshotQueue = next.catch(() => undefined);
    return next;
  }

  async start() {
    // React StrictMode runs effects twice in development; one blank entry is enough.
    if (this.started) return;
    this.started = true;
    this.fillWhite();
    await this.snapshot('start', 'Blank canvas');
    this.render();
  }

  private async restore(index: number) {
    const entry = this.history[index];
    if (!entry) return;
    this.restoring = true;
    this.emit();
    try {
      this.discardFloating();
      const bitmap = await createImageBitmap(entry.blob);
      this.baseCtx.clearRect(0, 0, this.width, this.height);
      this.fillWhite();
      this.baseCtx.drawImage(bitmap, 0, 0, this.width, this.height);
      bitmap.close();
      this.historyIndex = index;
      this.render();
    } finally {
      this.restoring = false;
      this.emit();
    }
  }

  async undo() {
    await this.placeNowAsync();
    if (this.historyIndex > 0) await this.restore(this.historyIndex - 1);
  }

  async redo() {
    await this.placeNowAsync();
    if (this.historyIndex < this.history.length - 1) await this.restore(this.historyIndex + 1);
  }

  async goTo(index: number) {
    this.discardFloating();
    await this.restore(index);
  }

  async clear() {
    this.discardFloating();
    this.fillWhite();
    this.render();
    await this.snapshot('clear', 'Canvas cleared');
  }

  /** Starts over at a new size. Releases every stored picture. */
  async resize(width: number, height: number) {
    this.discardFloating();
    for (const entry of this.history) URL.revokeObjectURL(entry.url);
    this.history = [];
    this.historyIndex = -1;
    this.width = width;
    this.height = height;
    this.base.width = width;
    this.base.height = height;
    this.started = false;
    if (this.view) {
      this.view.width = width;
      this.view.height = height;
    }
    await this.start();
  }

  // ---- model results and export -----------------------------------------------------------------

  /** Replaces the drawing with a picture from the model, fitted inside the canvas without stretching. */
  async applyImage(blob: Blob, label: string, note?: string) {
    this.discardFloating();
    const bitmap = await createImageBitmap(blob);
    this.fillWhite();
    const scale = Math.min(this.width / bitmap.width, this.height / bitmap.height);
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    this.baseCtx.drawImage(bitmap, (this.width - w) / 2, (this.height - h) / 2, w, h);
    bitmap.close();
    this.render();
    await this.snapshot('edit', label, note);
  }

  /** Records a description without changing the picture. */
  async recordDescription(label: string, note: string) {
    await this.snapshot('describe', label, note);
  }

  /** The current picture for Gemini. Large canvases fall back to JPEG to stay under the upload limit. */
  async exportForModel(): Promise<{ base64: string; mimeType: 'image/png' | 'image/jpeg' }> {
    await this.placeNowAsync();
    let blob = await toBlob(this.base, 'image/png');
    let mimeType: 'image/png' | 'image/jpeg' = 'image/png';
    if (blob.size > 2_800_000) {
      blob = await toBlob(this.base, 'image/jpeg', 0.9);
      mimeType = 'image/jpeg';
    }
    return { base64: await blobToBase64(blob), mimeType };
  }

  async exportDownload(): Promise<Blob> {
    await this.placeNowAsync();
    return toBlob(this.base, 'image/png');
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.floating?.bitmap.close();
    for (const entry of this.history) URL.revokeObjectURL(entry.url);
    this.history = [];
    this.listeners.clear();
  }
}

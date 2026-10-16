import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type DragEvent, type FormEvent, type PointerEvent } from 'react';
import { Info, KeyRound, LoaderCircle, SendHorizontal, Sparkles, X } from 'lucide-react';
import { HistoryPanel } from './components/HistoryPanel';
import { SettingsDialog } from './components/SettingsDialog';
import { Toolbar } from './components/Toolbar';
import { loadKey, requestGemini, saveKey, serverHasKey } from './lib/client';
import { adviceFor, GeminiError, type GeminiErrorCode } from './lib/gemini';
import { CANVAS_PRESETS, DEFAULT_MODEL_ID, findModel, MODELS, nearestAspectRatio } from './lib/models';
import { Studio, type Tool } from './lib/studio';

const IDEAS = ['Color it in', 'Make it a watercolor painting', 'Add a hat', 'Turn it into a pixel-art sprite', 'Clean up my lines'];

type Problem = { code: GeminiErrorCode; message: string; modelText?: string };

function base64ToBlob(base64: string, mimeType: string) {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return new Blob([bytes], { type: mimeType });
}

function modelLabel(id: string) {
  return findModel(id)?.label ?? id;
}

export default function App() {
  const [studio] = useState(() => new Studio(CANVAS_PRESETS[0].width, CANVAS_PRESETS[0].height));
  const state = useSyncExternalStore(studio.subscribe, studio.getState);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [tool, setToolState] = useState<Tool>('pen');
  const [color, setColorState] = useState('#111111');
  const [size, setSizeState] = useState(6);
  const [presetId, setPresetId] = useState(CANVAS_PRESETS[0].id);
  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [prompt, setPrompt] = useState('');
  const [keepStyle, setKeepStyle] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [{ key: userKey, remember }, setKeyState] = useState(loadKey);
  const [serverConfigured, setServerConfigured] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const model = findModel(modelId) ?? MODELS[0];
  const preset = CANVAS_PRESETS.find((item) => item.id === presetId) ?? CANVAS_PRESETS[0];

  useEffect(() => {
    studio.attach(canvasRef.current);
    void studio.start();
    return () => {
      studio.attach(null);
    };
  }, [studio]);

  useEffect(() => {
    let cancelled = false;
    void serverHasKey().then((configured) => {
      if (!cancelled) setServerConfigured(configured);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setTool = (next: Tool) => {
    studio.tool = next;
    setToolState(next);
  };
  const setColor = (next: string) => {
    studio.color = next;
    setColorState(next);
  };
  const setSize = (next: number) => {
    studio.size = next;
    setSizeState(next);
  };

  const addPicture = useCallback(
    async (file: File | Blob) => {
      try {
        await studio.addPicture(file);
        setAnnouncement('Picture added. Drag it, resize it from a corner, then press Enter to place it.');
      } catch {
        setProblem({ code: 'bad_request', message: 'That file could not be read as a picture.' });
      }
    },
    [studio],
  );

  // Keyboard shortcuts and paste.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      const mod = event.ctrlKey || event.metaKey;
      if (mod && !typing && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        void (event.shiftKey ? studio.redo() : studio.undo());
      } else if (mod && !typing && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        void studio.redo();
      } else if (!typing && studio.getState().hasFloating && event.key === 'Enter') {
        event.preventDefault();
        studio.placeNow();
      } else if (studio.getState().hasFloating && event.key === 'Escape') {
        studio.discardFloating();
      }
    }
    function onPaste(event: ClipboardEvent) {
      for (const item of event.clipboardData?.items ?? []) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            event.preventDefault();
            void addPicture(file);
            return;
          }
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('paste', onPaste);
    };
  }, [studio, addPicture]);

  function onPointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const { x, y } = studio.toCanvas(event.clientX, event.clientY);
    studio.pointerDown(x, y, event.pressure || 0.5);
  }
  function onPointerMove(event: PointerEvent<HTMLCanvasElement>) {
    const { x, y } = studio.toCanvas(event.clientX, event.clientY);
    studio.pointerMove(x, y, event.pressure || 0.5);
  }
  function onPointerUp(event: PointerEvent<HTMLCanvasElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    void studio.pointerUp();
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file?.type.startsWith('image/')) void addPicture(file);
  }

  async function changePreset(id: string) {
    const next = CANVAS_PRESETS.find((item) => item.id === id);
    if (!next || next.id === presetId) return;
    if (studio.getState().dirty && !window.confirm('Changing the canvas shape starts a new drawing. Continue?')) return;
    setPresetId(id);
    setProblem(null);
    setAnswer(null);
    await studio.resize(next.width, next.height);
  }

  async function download() {
    const blob = await studio.exportDownload();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'gemini-codrawing.png';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const text = prompt.trim();
    if (model.mode === 'edit' && !text) return;
    if (!userKey && !serverConfigured) {
      setProblem({ code: 'no_key', message: 'No Gemini API key yet.' });
      setSettingsOpen(true);
      return;
    }

    setBusy(true);
    setProblem(null);
    setAnswer(null);
    const controller = new AbortController();
    abortRef.current = controller;
    setAnnouncement(model.mode === 'edit' ? 'Asking Gemini to edit your drawing.' : 'Asking Gemini to describe your drawing.');
    try {
      const image = await studio.exportForModel();
      const result = await requestGemini(
        {
          mode: model.mode,
          model: model.id,
          imageBase64: image.base64,
          imageMimeType: image.mimeType,
          prompt: text,
          keepLineStyle: keepStyle,
          aspectRatio: nearestAspectRatio(state.width, state.height),
        },
        userKey,
        controller.signal,
      );
      const ranOn = result.model !== model.id ? `${modelLabel(result.model)} (${modelLabel(model.id)} was not available)` : modelLabel(result.model);
      if (model.mode === 'edit' && result.image) {
        await studio.applyImage(base64ToBlob(result.image.data, result.image.mimeType), text, `${ranOn}${result.text ? `\n${result.text}` : ''}`);
        if (result.text) setAnswer(result.text);
        setAnnouncement('Gemini finished. The canvas now shows the edit.');
      } else {
        await studio.recordDescription(text || 'Describe my drawing', result.text);
        setAnswer(result.text);
        setAnnouncement('Gemini described your drawing.');
      }
      setPrompt('');
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') {
        setAnnouncement('Cancelled.');
      } else if (error instanceof GeminiError) {
        setProblem({ code: error.code, message: error.message, modelText: error.modelText });
        setAnnouncement(error.message);
      } else {
        console.error(error);
        setProblem({ code: 'unknown', message: 'Something unexpected went wrong.' });
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  const keySource = userKey ? 'your key' : serverConfigured ? 'the demo key' : 'no key yet';

  return (
    <div className="notebook-paper-bg flex min-h-screen flex-col items-center text-gray-900">
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-3 pt-5 pb-24 sm:px-6 sm:pt-10 lg:flex-row">
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="mb-4 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="font-hand text-2xl leading-tight font-bold sm:text-3xl">Gemini Co-Drawing</h1>
              <p className="mt-1 text-sm text-gray-600 sm:text-base">
                Sketch it, then tell Gemini what to change. Built with{' '}
                <a className="underline" href="https://ai.google.dev/gemini-api/docs/image-generation" target="_blank" rel="noopener noreferrer">
                  Gemini native image generation
                </a>
                .
              </p>
              <p className="mt-0.5 text-xs text-gray-500">
                Idea by{' '}
                <a className="underline" href="https://x.com/trudypainter" target="_blank" rel="noopener noreferrer">
                  @trudypainter
                </a>{' '}
                and{' '}
                <a className="underline" href="https://x.com/alexanderchen" target="_blank" rel="noopener noreferrer">
                  @alexanderchen
                </a>
                . Rebuilt by Yuan.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="flex flex-shrink-0 items-center gap-2 self-start border-2 border-black bg-white px-3 py-2 text-sm font-medium shadow-[3px_3px_0_0_#000] transition hover:translate-x-px hover:translate-y-px hover:shadow-[2px_2px_0_0_#000] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
            >
              <KeyRound className="size-4" aria-hidden="true" />
              {userKey ? 'Your key is set' : 'Add your key'}
            </button>
          </header>

          <div className="mb-3">
            <Toolbar
              tool={tool}
              color={color}
              size={size}
              canUndo={state.historyIndex > 0 && !state.busyRestoring}
              canRedo={state.historyIndex < state.historyLength - 1 && !state.busyRestoring}
              hasFloating={state.hasFloating}
              presetId={presetId}
              disabled={busy}
              onTool={setTool}
              onColor={setColor}
              onSize={setSize}
              onUpload={(file) => void addPicture(file)}
              onPlace={() => studio.placeNow()}
              onDiscard={() => studio.discardFloating()}
              onUndo={() => void studio.undo()}
              onRedo={() => void studio.redo()}
              onDownload={() => void download()}
              onClear={() => void studio.clear()}
              onPreset={(id) => void changePreset(id)}
            />
          </div>

          <div
            className="relative mb-5 flex w-full justify-center"
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <canvas
              ref={canvasRef}
              aria-label="Drawing canvas. Draw with a mouse, finger or pen."
              role="img"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              style={{ aspectRatio: `${state.width} / ${state.height}`, maxHeight: '68vh' }}
              className={`w-auto max-w-full touch-none border-2 bg-white shadow-[6px_6px_0_0_rgba(0,0,0,0.9)] ${
                tool === 'eraser' ? 'cursor-cell' : 'cursor-crosshair'
              } ${dragging ? 'border-blue-500 ring-4 ring-blue-300/50' : 'border-black'}`}
            />
            {busy ? (
              <div className="absolute inset-0 flex items-center justify-center bg-white/60 backdrop-blur-[1px]" role="status">
                <div className="flex items-center gap-3 border-2 border-black bg-white px-4 py-3 shadow-[4px_4px_0_0_#000]">
                  <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
                  <span className="font-hand text-lg">{model.mode === 'edit' ? 'Gemini is drawing...' : 'Gemini is looking...'}</span>
                  <button
                    type="button"
                    onClick={() => abortRef.current?.abort()}
                    className="ml-2 border border-black px-2 py-0.5 text-sm hover:bg-gray-100"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          {problem ? (
            <div role="alert" className="mb-4 flex gap-3 border-2 border-red-700 bg-red-50 p-3 text-sm text-red-950">
              <Info className="mt-0.5 size-5 flex-shrink-0" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{problem.message}</p>
                <p className="mt-1 text-red-900">{adviceFor(problem.code)}</p>
                {problem.modelText ? <p className="mt-2 border-l-2 border-red-300 pl-3 text-red-900 italic">&ldquo;{problem.modelText}&rdquo;</p> : null}
                {problem.code === 'billing_required' || problem.code === 'invalid_key' || problem.code === 'no_key' ? (
                  <button type="button" onClick={() => setSettingsOpen(true)} className="mt-2 underline">
                    Open key settings
                  </button>
                ) : null}
              </div>
              <button type="button" onClick={() => setProblem(null)} aria-label="Dismiss" className="h-fit rounded p-1 hover:bg-red-100">
                <X className="size-4" />
              </button>
            </div>
          ) : null}

          {answer ? (
            <section aria-label="Gemini's reply" className="mb-4 border-2 border-black bg-yellow-50 p-3 text-sm">
              <h2 className="font-hand mb-1 flex items-center gap-1.5 text-lg">
                <Sparkles className="size-4" aria-hidden="true" />
                Gemini says
              </h2>
              <p className="whitespace-pre-wrap">{answer}</p>
            </section>
          ) : null}

          <form onSubmit={submit} className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <label className="flex flex-col gap-1 text-xs font-medium text-gray-700 sm:w-64">
                Model
                <select
                  value={modelId}
                  onChange={(event) => setModelId(event.target.value)}
                  disabled={busy}
                  className="h-11 border-2 border-black bg-white px-2 text-sm text-gray-900 focus-visible:outline-2 focus-visible:outline-blue-600"
                >
                  <optgroup label="Edit the drawing">
                    {MODELS.filter((item) => item.mode === 'edit').map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Describe the drawing">
                    {MODELS.filter((item) => item.mode === 'describe').map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </label>
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium text-gray-700">
                {model.mode === 'edit' ? 'What should change?' : 'Anything specific to look for? (optional)'}
                <div className="relative">
                  <input
                    type="text"
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    placeholder={model.mode === 'edit' ? 'Add your change...' : 'Describe my drawing'}
                    required={model.mode === 'edit'}
                    maxLength={500}
                    disabled={busy}
                    className="h-11 w-full border-2 border-black bg-white p-3 pr-14 font-mono text-sm text-gray-900 shadow-sm focus:ring-2 focus:ring-blue-200 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={busy || (model.mode === 'edit' && !prompt.trim())}
                    aria-label={model.mode === 'edit' ? 'Send the edit to Gemini' : 'Ask Gemini to describe'}
                    className="absolute top-1/2 right-1.5 flex size-8 -translate-y-1/2 items-center justify-center bg-black text-white transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300"
                  >
                    {busy ? <LoaderCircle className="size-5 animate-spin" aria-hidden="true" /> : <SendHorizontal className="size-5" aria-hidden="true" />}
                  </button>
                </div>
              </label>
            </div>

            <p className="text-xs text-gray-600">{model.note}</p>

            {model.mode === 'edit' ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-gray-700">Try:</span>
                {IDEAS.map((idea) => (
                  <button
                    key={idea}
                    type="button"
                    disabled={busy}
                    onClick={() => setPrompt(idea)}
                    className="rounded-full border border-gray-400 bg-white/80 px-3 py-1 text-xs hover:border-black hover:bg-white disabled:opacity-50"
                  >
                    {idea}
                  </button>
                ))}
                <label className="ml-auto flex items-center gap-2 text-xs text-gray-700">
                  <input type="checkbox" checked={keepStyle} onChange={(event) => setKeepStyle(event.target.checked)} className="size-4 accent-black" />
                  Keep my line-drawing style
                </label>
              </div>
            ) : null}

            <p className="text-xs text-gray-500">
              Sending with <strong className="font-semibold text-gray-700">{keySource}</strong>
              {model.mode === 'edit' ? ` as a ${preset.label} picture` : ''}.{' '}
              {!userKey ? (
                <button type="button" onClick={() => setSettingsOpen(true)} className="underline">
                  Use your own key
                </button>
              ) : null}
            </p>
          </form>
          <p className="sr-only" aria-live="polite">
            {announcement}
          </p>
        </div>

        <HistoryPanel
          entries={studio.history}
          index={state.historyIndex}
          busy={busy || state.busyRestoring}
          onGoTo={(index) => void studio.goTo(index)}
        />
      </main>

      <SettingsDialog
        open={settingsOpen}
        initialKey={userKey}
        initialRemember={remember}
        serverConfigured={serverConfigured}
        onClose={() => setSettingsOpen(false)}
        onSave={(key, rememberChoice) => {
          saveKey(key, rememberChoice);
          setKeyState({ key, remember: rememberChoice });
          setSettingsOpen(false);
          setProblem(null);
        }}
      />
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { KeyRound, LoaderCircle, X } from 'lucide-react';
import { checkKey, looksLikeKey } from '../lib/client';

type Props = {
  open: boolean;
  initialKey: string;
  initialRemember: boolean;
  serverConfigured: boolean;
  onClose: () => void;
  onSave: (key: string, remember: boolean) => void;
};

export function SettingsDialog({ open, initialKey, initialRemember, serverConfigured, onClose, onSave }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [key, setKey] = useState(initialKey);
  const [remember, setRemember] = useState(initialRemember);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setKey(initialKey);
      setRemember(initialRemember);
      setResult(null);
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open, initialKey, initialRemember]);

  async function onCheck() {
    setChecking(true);
    setResult(null);
    const outcome = await checkKey(key.trim());
    setResult(outcome);
    setChecking(false);
  }

  const trimmed = key.trim();
  const shapeWarning = trimmed && !looksLikeKey(trimmed);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
      className="m-auto w-[min(92vw,30rem)] border-2 border-black bg-white p-0 text-gray-900 shadow-[6px_6px_0_0_#000] backdrop:bg-black/50"
      aria-labelledby="settings-title"
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(trimmed, remember);
        }}
        className="flex flex-col gap-4 p-5"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id="settings-title" className="font-hand flex items-center gap-2 text-2xl">
            <KeyRound className="size-5" aria-hidden="true" />
            Your Gemini key
          </h2>
          <button type="button" onClick={onClose} className="rounded p-1 hover:bg-gray-100" aria-label="Close settings">
            <X className="size-5" />
          </button>
        </div>

        <p className="text-sm leading-6 text-gray-700">
          Image editing runs on Google&apos;s Gemini image models. Bring your own key and your drawings go straight from this
          browser to Google. The key is never sent to this site&apos;s server.
          {serverConfigured ? ' This demo also has a shared key with a small allowance, used when you leave this empty.' : ''}
        </p>

        <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor="api-key">
          API key
          <input
            id="api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(event) => {
              setKey(event.target.value);
              setResult(null);
            }}
            placeholder="AIza..."
            className="border-2 border-black bg-white px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </label>
        {shapeWarning ? (
          <p className="-mt-2 text-xs text-amber-700">That does not look like a Gemini key. They start with AIza and are about 39 characters.</p>
        ) : null}

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} className="size-4 accent-black" />
          Remember it on this device
        </label>
        <p className="-mt-2 text-xs text-gray-500">Off means it is forgotten when you close the tab.</p>

        <ul className="list-disc space-y-1 pl-5 text-xs leading-5 text-gray-600">
          <li>
            Get a key at{' '}
            <a className="underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">
              aistudio.google.com/apikey
            </a>
            .
          </li>
          <li>Free keys can describe a drawing. Editing it into a new picture needs billing enabled on the key&apos;s project.</li>
        </ul>

        {result ? (
          <p role="status" className={`border-2 px-3 py-2 text-sm ${result.ok ? 'border-green-700 bg-green-50 text-green-900' : 'border-red-700 bg-red-50 text-red-900'}`}>
            {result.text}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          {key ? (
            <button
              type="button"
              onClick={() => {
                setKey('');
                onSave('', remember);
              }}
              className="mr-auto border-2 border-transparent px-3 py-2 text-sm text-red-700 underline"
            >
              Forget key
            </button>
          ) : null}
          <button
            type="button"
            onClick={onCheck}
            disabled={!trimmed || checking}
            className="flex items-center gap-2 border-2 border-black bg-white px-4 py-2 text-sm font-medium hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {checking ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
            Check key
          </button>
          <button type="submit" className="border-2 border-black bg-black px-4 py-2 text-sm font-medium text-white hover:bg-gray-800">
            Save
          </button>
        </div>
      </form>
    </dialog>
  );
}

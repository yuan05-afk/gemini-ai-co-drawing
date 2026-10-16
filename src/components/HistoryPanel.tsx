import { History as HistoryIcon, RotateCcw } from 'lucide-react';
import type { HistoryEntry } from '../lib/studio';

type Props = {
  entries: readonly HistoryEntry[];
  index: number;
  busy: boolean;
  onGoTo: (index: number) => void;
};

const KIND_LABEL: Record<HistoryEntry['kind'], string> = {
  start: 'Start',
  draw: 'Drawing',
  place: 'Picture',
  clear: 'Cleared',
  edit: 'Gemini edit',
  describe: 'Description',
};

function formatPrompt(text: string) {
  const parts = text.split(/(\*\*.*?\*\*)/g);
  return parts.map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <span key={i}>{part}</span>,
  );
}

export function HistoryPanel({ entries, index, busy, onGoTo }: Props) {
  // Newest first, so the latest change is always in view.
  const ordered = entries.map((entry, i) => ({ entry, i })).reverse();
  return (
    <aside
      aria-labelledby="history-title"
      className="flex max-h-[70vh] w-full flex-shrink-0 flex-col border-2 border-black bg-white/85 p-4 lg:max-h-[calc(60vh+9rem)] lg:w-80"
    >
      <h2 id="history-title" className="font-hand mb-3 flex items-center justify-center gap-2 text-xl">
        <HistoryIcon className="size-5" aria-hidden="true" />
        History
      </h2>
      <ol className="-mr-2 flex-1 space-y-3 overflow-y-auto pr-2">
        {ordered.map(({ entry, i }) => {
          const current = i === index;
          return (
            <li
              key={entry.id}
              aria-current={current ? 'step' : undefined}
              className={`rounded-lg p-2 transition-colors ${current ? 'bg-blue-100 ring-2 ring-blue-500' : 'bg-gray-100 hover:bg-gray-200'}`}
            >
              <div className="flex items-start gap-3">
                <img
                  src={entry.url}
                  alt=""
                  width={96}
                  height={56}
                  loading="lazy"
                  className="mt-0.5 h-14 w-24 flex-shrink-0 rounded border border-gray-300 bg-white object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-semibold tracking-wide text-gray-500 uppercase">{KIND_LABEL[entry.kind]}</p>
                  <p className="text-sm font-medium break-words whitespace-pre-wrap text-gray-900">{formatPrompt(entry.label)}</p>
                  {entry.note ? <p className="mt-0.5 text-xs break-words whitespace-pre-wrap text-gray-600">{entry.note}</p> : null}
                  <p className="mt-0.5 text-xs text-gray-500">{new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                </div>
              </div>
              {!current ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onGoTo(i)}
                  className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-gray-300 bg-white py-1.5 text-sm font-medium text-blue-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  <RotateCcw className="size-3.5" aria-hidden="true" />
                  Revert to this version
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

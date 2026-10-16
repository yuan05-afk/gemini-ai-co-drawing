import { useRef } from 'react';
import { Check, Download, Eraser, ImagePlus, PenLine, Redo2, Trash2, Undo2, X } from 'lucide-react';
import { CANVAS_PRESETS } from '../lib/models';
import type { Tool } from '../lib/studio';

const SWATCHES = ['#111111', '#e11d48', '#f97316', '#eab308', '#16a34a', '#2563eb', '#7c3aed'];

type Props = {
  tool: Tool;
  color: string;
  size: number;
  canUndo: boolean;
  canRedo: boolean;
  hasFloating: boolean;
  presetId: string;
  disabled: boolean;
  onTool: (tool: Tool) => void;
  onColor: (color: string) => void;
  onSize: (size: number) => void;
  onUpload: (file: File) => void;
  onPlace: () => void;
  onDiscard: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onDownload: () => void;
  onClear: () => void;
  onPreset: (id: string) => void;
};

const button =
  'flex size-10 flex-shrink-0 items-center justify-center rounded-full bg-white text-gray-800 shadow-sm transition hover:scale-105 hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100';

export function Toolbar(props: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const colorRef = useRef<HTMLInputElement>(null);
  const custom = !SWATCHES.includes(props.color);

  return (
    <menu
      aria-label="Drawing tools"
      className="m-0 flex max-w-full flex-wrap items-center gap-2 rounded-3xl bg-gray-300 p-2 shadow-sm"
    >
      <div role="group" aria-label="Tool" className="flex flex-shrink-0 gap-1 rounded-full bg-gray-200 p-1">
        <button
          type="button"
          aria-pressed={props.tool === 'pen'}
          aria-label="Pen"
          onClick={() => props.onTool('pen')}
          className={`${button} ${props.tool === 'pen' ? '!bg-black !text-white' : ''}`}
        >
          <PenLine className="size-5" />
        </button>
        <button
          type="button"
          aria-pressed={props.tool === 'eraser'}
          aria-label="Eraser"
          onClick={() => props.onTool('eraser')}
          className={`${button} ${props.tool === 'eraser' ? '!bg-black !text-white' : ''}`}
        >
          <Eraser className="size-5" />
        </button>
      </div>

      <div role="group" aria-label="Color" className="flex flex-shrink-0 items-center gap-1.5 rounded-full bg-gray-200 px-2 py-1">
        {SWATCHES.map((swatch) => (
          <button
            key={swatch}
            type="button"
            aria-label={`Color ${swatch}`}
            aria-pressed={props.color === swatch && props.tool === 'pen'}
            onClick={() => {
              props.onColor(swatch);
              props.onTool('pen');
            }}
            style={{ backgroundColor: swatch }}
            className={`size-7 rounded-full border-2 transition hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
              props.color === swatch && props.tool === 'pen' ? 'border-white ring-2 ring-black' : 'border-white'
            }`}
          />
        ))}
        <button
          type="button"
          aria-label="Pick a custom color"
          onClick={() => colorRef.current?.click()}
          style={{ background: custom ? props.color : 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)' }}
          className={`size-7 rounded-full border-2 border-white transition hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${custom ? 'ring-2 ring-black' : ''}`}
        >
          <input
            ref={colorRef}
            type="color"
            value={props.color}
            onChange={(event) => {
              props.onColor(event.target.value);
              props.onTool('pen');
            }}
            className="pointer-events-none absolute size-px opacity-0"
            tabIndex={-1}
            aria-hidden="true"
          />
        </button>
      </div>

      <label className="flex flex-shrink-0 items-center gap-2 rounded-full bg-gray-200 px-3 py-2 text-xs font-medium text-gray-700">
        Size
        <input
          type="range"
          min={2}
          max={40}
          value={props.size}
          onChange={(event) => props.onSize(Number(event.target.value))}
          className="h-1.5 w-20 accent-black"
          aria-valuetext={`${props.size} pixels`}
        />
        <span aria-hidden="true" className="flex size-6 items-center justify-center">
          <span className="rounded-full bg-black" style={{ width: Math.max(3, Math.min(props.size, 24)), height: Math.max(3, Math.min(props.size, 24)) }} />
        </span>
      </label>

      <label className="flex flex-shrink-0 items-center gap-1.5 rounded-full bg-gray-200 py-1 pr-1 pl-3 text-xs font-medium text-gray-700">
        Canvas
        <select
          value={props.presetId}
          onChange={(event) => props.onPreset(event.target.value)}
          disabled={props.disabled}
          className="h-8 rounded-full border-0 bg-white px-2 text-xs focus-visible:outline-2 focus-visible:outline-blue-600"
          aria-label="Canvas shape"
        >
          {CANVAS_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>

      <button type="button" className={button} onClick={() => fileRef.current?.click()} aria-label="Add a picture" title="Add a picture (or paste or drop one)">
        <ImagePlus className="size-5" />
      </button>
      {props.hasFloating ? (
        <>
          <button type="button" className={`${button} !bg-green-600 !text-white hover:!bg-green-700`} onClick={props.onPlace} aria-label="Place the picture on the canvas" title="Place picture (Enter)">
            <Check className="size-5" />
          </button>
          <button type="button" className={button} onClick={props.onDiscard} aria-label="Discard the picture" title="Discard picture (Esc)">
            <X className="size-5" />
          </button>
        </>
      ) : null}
      <span className="hidden flex-1 sm:block" aria-hidden="true" />
      <button type="button" className={button} onClick={props.onUndo} disabled={!props.canUndo} aria-label="Undo" title="Undo (Ctrl+Z)">
        <Undo2 className="size-5" />
      </button>
      <button type="button" className={button} onClick={props.onRedo} disabled={!props.canRedo} aria-label="Redo" title="Redo (Ctrl+Y)">
        <Redo2 className="size-5" />
      </button>
      <button type="button" className={button} onClick={props.onDownload} aria-label="Download as PNG" title="Download as PNG">
        <Download className="size-5" />
      </button>
      <button type="button" className={button} onClick={props.onClear} aria-label="Clear the canvas" title="Clear the canvas">
        <Trash2 className="size-5" />
      </button>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) props.onUpload(file);
          event.target.value = '';
        }}
      />
    </menu>
  );
}

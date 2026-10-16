import { useRef, useState } from 'react';
import { OnScreenKeyboard } from '../ui/OnScreenKeyboard';

export function TimePad({ fields, onChange, initialField = 0 }: { fields: { label: string; value: number; max: number }[]; onChange: (index: number, value: number) => void; initialField?: number }) {
  const [selected, setSelected] = useState(initialField);
  const digits = useRef(0);
  const select = (index: number) => { setSelected(index); digits.current = 0; };
  const press = (key: string) => {
    const field = fields[selected];
    if (key === 'Clear') { onChange(selected, 0); digits.current = 0; return; }
    if (key === 'Backspace') { onChange(selected, Math.floor(field.value / 10)); digits.current = Math.max(0, digits.current - 1); return; }
    const value = Number(`${digits.current === 0 || digits.current >= 2 ? '' : field.value}${key}`);
    if (value > field.max) return;
    onChange(selected, value); digits.current = digits.current >= 2 ? 1 : digits.current + 1;
  };
  return <div className="clock-time-pad" onKeyDown={event => {
    if (/^[0-9]$/.test(event.key) || event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault(); press(event.key === 'Delete' ? 'Clear' : event.key);
    }
  }}>
    <div className="clock-time-fields" role="group" aria-label="Time values">{fields.map((field, index) => <button type="button" key={field.label} className={selected === index ? 'is-selected' : ''} aria-label={`${field.label}: ${field.value}`} aria-pressed={selected === index} onClick={() => select(index)}><strong>{String(field.value).padStart(2, '0')}</strong><span>{field.label}</span></button>)}</div>
    <div className="clock-keypad" role="group" aria-label={`Enter ${fields[selected].label.toLowerCase()}`}>{['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Clear', '0', 'Backspace'].map(key => <button type="button" key={key} className={key.length > 1 ? 'clock-keypad-action' : ''} aria-label={key} onClick={() => press(key)}>{key === 'Backspace' ? '⌫' : key}</button>)}</div>
    <p className="clock-input-hint">Tap a unit, then enter a number.</p>
  </div>;
}

export function ClockNameEditor({ value, onChange, onDone, suggestions }: { value: string; onChange: (value: string) => void; onDone: () => void; suggestions: string[] }) {
  const input = useRef<HTMLInputElement>(null);
  const pointerDown = useRef(false);
  const pendingDone = useRef(false);
  const edit = (text: string | null) => {
    const start = input.current?.selectionStart ?? value.length;
    const end = input.current?.selectionEnd ?? value.length;
    const previous = [...value.slice(0, start)];
    const from = text === null && start === end ? start - (previous.at(-1)?.length ?? 0) : start;
    const next = `${value.slice(0, from)}${text ?? ''}${value.slice(end)}`.slice(0, 48);
    onChange(next);
    requestAnimationFrame(() => { input.current?.focus({ preventScroll: true }); const caret = Math.min(next.length, from + (text?.length ?? 0)); input.current?.setSelectionRange(caret, caret); });
  };
  return <div className="clock-name-editor"
    onPointerDownCapture={() => { pointerDown.current = true; pendingDone.current = false; }}
    onPointerUpCapture={() => { pointerDown.current = false; }}
    onPointerCancel={() => { pointerDown.current = false; pendingDone.current = false; }}
    onClickCapture={event => {
      // Keyboard keys act on pointerdown to keep the caret. Keep Done mounted
      // through the complete tap, so its click cannot hit Save underneath it.
      if (pendingDone.current) { event.stopPropagation(); pendingDone.current = false; onDone(); }
    }}>
    <label className="clock-label-input">Name<input ref={input} autoFocus inputMode="none" autoComplete="off" maxLength={48} value={value} placeholder="Optional name" onChange={event => onChange(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onDone(); } }} /></label>
    <div className="clock-name-suggestions">{suggestions.map(name => <button type="button" key={name} onClick={() => onChange(name)}>{name}</button>)}</div>
    <OnScreenKeyboard open compact onChar={edit} onBackspace={() => edit(null)} onSubmit={() => { if (pointerDown.current) pendingDone.current = true; else onDone(); }} submitLabel="Done" />
  </div>;
}

export function ClockRing({ progress, small = false }: { progress: number; small?: boolean }) {
  const amount = Math.min(1, Math.max(0, progress));
  return <svg viewBox="0 0 100 100" className={`clock-ring${small ? ' clock-ring--small' : ''}`} aria-hidden><circle className="clock-ring-track" cx="50" cy="50" r="44" /><circle className="clock-ring-progress" cx="50" cy="50" r="44" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - amount * 100} /></svg>;
}

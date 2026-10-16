export type OnScreenKeyboardProps = {
  open: boolean;
  onChar: (char: string) => void;
  onBackspace: () => void;
};

const ROW_NUM = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const;
const ROW_Q = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'] as const;
const ROW_A = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'] as const;
const ROW_Z = ['z', 'x', 'c', 'v', 'b', 'n', 'm'] as const;

function Key({
  label,
  className,
  ariaLabel,
  onPress,
}: {
  label: string;
  className?: string;
  ariaLabel?: string;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      className={className ? `osk-key ${className}` : 'osk-key'}
      aria-label={ariaLabel ?? label}
      onPointerDown={(e) => {
        e.preventDefault();
        onPress();
      }}
    >
      {label}
    </button>
  );
}

export function OnScreenKeyboard({ open, onChar, onBackspace }: OnScreenKeyboardProps) {
  if (!open) return null;

  return (
    <div className="osk" role="group" aria-label="On-screen keyboard">
      <div className="osk-row">
        {ROW_NUM.map((c) => (
          <Key key={c} label={c} onPress={() => onChar(c)} />
        ))}
      </div>
      <div className="osk-row">
        {ROW_Q.map((c) => (
          <Key key={c} label={c} onPress={() => onChar(c)} />
        ))}
      </div>
      <div className="osk-row">
        {ROW_A.map((c) => (
          <Key key={c} label={c} onPress={() => onChar(c)} />
        ))}
      </div>
      <div className="osk-row">
        {ROW_Z.map((c) => (
          <Key key={c} label={c} onPress={() => onChar(c)} />
        ))}
        <Key label="⌫" className="osk-key--wide" ariaLabel="Backspace" onPress={onBackspace} />
      </div>
      <div className="osk-row">
        <Key label="Space" className="osk-key--space" ariaLabel="Space" onPress={() => onChar(' ')} />
      </div>
    </div>
  );
}

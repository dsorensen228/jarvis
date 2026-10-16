export type OnScreenKeyboardProps = {
  open: boolean;
  onChar: (char: string) => void;
  onBackspace: () => void;
  onSubmit?: () => void;
  submitLabel?: string;
  submitDisabled?: boolean;
  onDismiss?: () => void;
  compact?: boolean;
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
  disabled,
}: {
  label: string;
  className?: string;
  ariaLabel?: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={className ? `osk-key ${className}` : 'osk-key'}
      aria-label={ariaLabel ?? label}
      disabled={disabled}
      onPointerDown={(e) => {
        e.preventDefault();
        onPress();
      }}
      onClick={(e) => {
        // Pointer presses are handled above to preserve the input's caret/focus.
        // Keyboard and assistive-technology activation still use a click event.
        if (e.detail === 0) onPress();
      }}
    >
      {label}
    </button>
  );
}

export function OnScreenKeyboard({
  open, onChar, onBackspace, onSubmit, submitLabel = 'Search', submitDisabled,
  onDismiss, compact,
}: OnScreenKeyboardProps) {
  if (!open) return null;

  return (
    <div className={`osk${compact ? ' osk--compact' : ''}`} role="group" aria-label="On-screen keyboard">
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
        {onDismiss && <Key label="Hide" ariaLabel="Hide keyboard" className="osk-key--action" onPress={onDismiss} />}
        <Key label="Space" className="osk-key--space" ariaLabel="Space" onPress={() => onChar(' ')} />
        {onSubmit && <Key label={submitLabel} className="osk-key--submit" onPress={onSubmit} disabled={submitDisabled} />}
      </div>
    </div>
  );
}

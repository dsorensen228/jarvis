/** Inline SVGs for fixed top chrome. */

export function IconRobot({ muted = false }: { muted?: boolean }) {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="5" y="7" width="14" height="13" rx="3" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M12 7V4M3 11v5m18-5v5m-12 0h6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <circle cx="12" cy="3" r="1" fill="currentColor" />
      <circle cx="9" cy="12" r="1.25" fill="currentColor" />
      <circle cx="15" cy="12" r="1.25" fill="currentColor" />
      {muted ? (
        <path
          d="M19 5l-14 14"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      ) : null}
    </svg>
  );
}

export function IconVolume({ muted }: { muted: boolean }) {
  if (muted) {
    return (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M4 10v4h4l5 4V6L8 10H4zm13.5 2a4.5 4.5 0 01-1.5 3.36M19 5l-14 14"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 10v4h4l5 4V6L8 10H4z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        d="M16 8.5a5 5 0 010 7M18.5 6a8 8 0 010 12"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconLight({ on }: { on: boolean }) {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9 18h6m-5 3h4m-6-7c-1.2-1-2-2.7-2-4.5a6 6 0 1112 0c0 1.8-.8 3.5-2 4.5-.5.4-.8.9-.9 1.5H9c-.1-.6-.4-1.1-.9-1.5z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {on ? <circle cx="12" cy="10" r="2.2" fill="currentColor" /> : null}
    </svg>
  );
}

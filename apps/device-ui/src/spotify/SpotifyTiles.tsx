import { useState } from 'react';

export function DiskPlaceholder() {
  return (
    <svg className="spotify-disk-placeholder" viewBox="0 0 48 48" width="48" height="48" aria-hidden>
      <circle cx="24" cy="24" r="22" fill="#2a2a32" stroke="#3a3a44" strokeWidth="1.5" />
      <circle cx="24" cy="24" r="14" fill="#1e1e26" stroke="#3a3a44" strokeWidth="1" />
      <circle cx="24" cy="24" r="4" fill="#0a0a0c" />
      <path
        d="M24 10 A14 14 0 0 1 33 33"
        fill="none"
        stroke="#4a4a56"
        strokeWidth="0.75"
        opacity="0.6"
      />
    </svg>
  );
}

export function SpotifyCoverArt({ src }: { src: string | null | undefined }) {
  const [bad, setBad] = useState(false);
  const show = src && !bad;
  return (
    <div className="spotify-tile-cover-wrap">
      {show ? (
        <img
          src={src}
          alt=""
          className="spotify-tile-cover-img"
          loading="lazy"
          decoding="async"
          onError={() => setBad(true)}
        />
      ) : (
        <DiskPlaceholder />
      )}
    </div>
  );
}

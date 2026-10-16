import { useEffect, useMemo, useRef, useState } from 'react';
import { buildResearchReportDocument } from './researchReport';
import './research-report.css';

export interface ResearchReportViewerProps {
  html: string;
  title: string;
  onClose: () => void;
}

export function ResearchReportViewer({ html, title, onClose }: ResearchReportViewerProps) {
  const [fontSize, setFontSize] = useState(16);
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const reportDocument = useMemo(() => buildResearchReportDocument(html, title), [html, title]);
  const scale = fontSize / 16;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const current = dialog.current;
    current?.showModal();
    // Reading and scrolling an opaque iframe cannot reset the shell's idle timer.
    window.dispatchEvent(new CustomEvent('jarvis-report-reading', { detail: { active: true } }));
    return () => {
      current?.close();
      window.dispatchEvent(new CustomEvent('jarvis-report-reading', { detail: { active: false } }));
      previous?.focus();
    };
  }, []);

  return <dialog
    ref={dialog}
    className="research-report-viewer"
    aria-label={title}
    onCancel={event => { event.preventDefault(); close.current(); }}
  >
    <header className="research-report-toolbar">
      <button type="button" className="research-report-back" aria-label="Back to research task" onClick={onClose}>← Back</button>
      <h2 title={title}>{title}</h2>
      <div className="research-report-text-controls" role="group" aria-label="Report text size">
        <button type="button" aria-label="Decrease report text size" disabled={fontSize <= 14} onClick={() => setFontSize(size => Math.max(14, size - 2))}>A−</button>
        <output aria-live="polite" aria-label="Report text size">{fontSize}</output>
        <button type="button" aria-label="Increase report text size" disabled={fontSize >= 22} onClick={() => setFontSize(size => Math.min(22, size + 2))}>A+</button>
      </div>
    </header>
    <div className="research-report-viewport">
      <iframe
        className="research-report-frame"
        title={`${title} — report content`}
        srcDoc={reportDocument}
        sandbox=""
        referrerPolicy="no-referrer"
        // Resize the opaque frame without reloading it or losing its reading position.
        style={{ width: `${100 / scale}%`, height: `${100 / scale}%`, transform: `scale(${scale})` }}
      />
    </div>
  </dialog>;
}

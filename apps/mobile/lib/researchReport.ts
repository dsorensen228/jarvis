export interface ReportColors {
  background: string;
  surface: string;
  surfaceElevated: string;
  text: string;
  textMuted: string;
  accent: string;
  border: string;
}

export function isExternalReportUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url) || /[\u0000-\u0020\u007f]/.test(url)) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      Boolean(parsed.hostname) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function isLocalReportUrl(url: string): boolean {
  return /^about:(?:blank|srcdoc)(?:#.*)?$/.test(url);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

/** The API sanitizes the fragment; the viewer adds isolation and trusted theme CSS. */
export function buildResearchReportDocument(
  html: string,
  colors: ReportColors,
  colorScheme: 'light' | 'dark',
  title = 'Research report',
  documentUrl: 'about:blank' | 'about:srcdoc' = 'about:blank',
): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri about:">
<base href="${documentUrl}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="${colorScheme}">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: ${colorScheme}; --background:${colors.background}; --surface:${colors.surface}; --elevated:${colors.surfaceElevated}; --text:${colors.text}; --muted:${colors.textMuted}; --accent:${colors.accent}; --border:${colors.border}; }
* { box-sizing:border-box; }
html { background:var(--surface); overflow-wrap:anywhere; }
body { margin:0; color:var(--text); font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif; }
main { max-width:900px; padding:32px 36px 64px; margin:auto; }
h1,h2,h3,h4 { line-height:1.28; letter-spacing:-.025em; color:var(--text); }
h1 { font-size:clamp(27px,5vw,40px); margin:0 0 24px; }
h2 { font-size:25px; margin:40px 0 16px; padding-top:24px; border-top:1px solid var(--border); }
h3 { font-size:20px; margin:28px 0 12px; }
h4 { font-size:17px; margin:24px 0 10px; }
p,ul,ol,dl { margin:0 0 20px; }
li { margin:7px 0; padding-left:3px; }
ul,ol { padding-left:24px; }
a { color:var(--accent); text-underline-offset:3px; }
strong { font-weight:700; }
.lead { font-size:19px; line-height:1.7; color:var(--muted); }
.muted,figcaption,small { color:var(--muted); }
.callout,blockquote { margin:24px 0; padding:18px 22px; background:var(--elevated); border:1px solid var(--border); border-left:3px solid var(--accent); border-radius:12px; }
.callout > :last-child,blockquote > :last-child { margin-bottom:0; }
.metric-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:14px; margin:24px 0; }
.metric { background:var(--elevated); border:1px solid var(--border); border-radius:14px; padding:20px; }
.metric strong { display:block; color:var(--accent); font-size:28px; line-height:1.3; margin-bottom:8px; }
.table-wrap { width:100%; overflow-x:auto; margin:24px 0; border:1px solid var(--border); border-radius:12px; }
table { width:100%; border-collapse:collapse; font-size:14px; line-height:1.6; }
th,td { text-align:left; vertical-align:top; padding:13px 16px; border-bottom:1px solid var(--border); }
th { background:var(--elevated); font-weight:700; }
tr:last-child td { border-bottom:0; }
figure { margin:28px 0; padding:20px; border:1px solid var(--border); border-radius:14px; background:var(--elevated); }
svg,img { display:block; max-width:100%; height:auto; margin:auto; }
svg { color:var(--text); }
svg:not([fill]) { fill:currentColor; }
figcaption { margin-top:14px; font-size:13px; line-height:1.6; }
.source-list { font-size:13px; line-height:1.7; }
.source-list li { padding-bottom:8px; }
pre { overflow-x:auto; padding:18px; border-radius:12px; background:var(--background); border:1px solid var(--border); font-size:13px; line-height:1.6; }
code { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:.9em; }
hr { border:0; border-top:1px solid var(--border); margin:28px 0; }
summary { cursor:pointer; font-weight:600; }
details { margin:20px 0; }
@media (max-width:520px) { body { font-size:15px; } main { padding:24px 18px 44px; } h2 { font-size:22px; } .lead { font-size:17px; } figure { padding:12px; } th,td { padding:10px; } .metric-grid { grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); } }
</style></head><body><main class="research-report">${html}</main></body></html>`;
}

const HTML_TAGS = new Set('article section header footer main aside nav div span h1 h2 h3 h4 h5 h6 p br hr strong em b i u s small mark sub sup blockquote q cite abbr time pre code kbd ul ol li dl dt dd figure figcaption table caption thead tbody tfoot tr th td a details summary'.split(' '));
const SVG_TAGS = new Set('svg g path rect circle ellipse line polyline polygon text tspan title desc defs marker'.split(' '));
const COMMON_ATTRIBUTES = new Set('class id title role aria-label aria-labelledby aria-describedby'.split(' '));
const SVG_ATTRIBUTES = new Set('fill stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset fill-opacity stroke-opacity opacity fill-rule transform x y x1 y1 x2 y2 cx cy r rx ry width height d points dx dy text-anchor dominant-baseline font-size font-weight marker-start marker-mid marker-end viewBox preserveAspectRatio refX refY markerWidth markerHeight orient'.split(' '));
const HTML_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(['href']),
  th: new Set(['scope', 'colspan', 'rowspan']),
  td: new Set(['colspan', 'rowspan']),
  ol: new Set(['start', 'reversed']),
  li: new Set(['value']),
  time: new Set(['datetime']),
};
const REPORT_CLASSES = new Set('research-report lead callout metric-grid metric table-wrap source-list muted'.split(' '));
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.:-]*$/;
const SAFE_COLOR = /^(?:#[0-9a-fA-F]{3,8}|[A-Za-z]+|(?:rgb|rgba|hsl|hsla)\([0-9.,% +\-/]+\))$/;

function externalSourceUrl(value: string): string | null {
  if (!/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.hostname && !url.username && !url.password ? value : null;
  } catch {
    return null;
  }
}

/** The API sanitizes report HTML. This additional kiosk boundary keeps navigation local. */
function prepareReportFragment(html: string): string {
  // Template contents are inert: parsing cannot load resources or upgrade custom elements.
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const element of template.content.querySelectorAll('*')) {
    const svg = element.namespaceURI === 'http://www.w3.org/2000/svg';
    const tag = element.localName;
    if (!(svg ? SVG_TAGS : HTML_TAGS).has(tag)) {
      element.remove();
      continue;
    }
    const source = tag === 'a' ? externalSourceUrl(element.getAttribute('href') ?? '') : null;
    for (const attribute of [...element.attributes]) {
      const { name, value } = attribute;
      const allowed = COMMON_ATTRIBUTES.has(name) || (svg ? SVG_ATTRIBUTES.has(name) : HTML_ATTRIBUTES[tag]?.has(name));
      if (!allowed ||
          (name === 'id' && !IDENTIFIER.test(value)) ||
          (name === 'href' && !/^#[A-Za-z][A-Za-z0-9_.:-]*$/.test(value)) ||
          (['fill', 'stroke'].includes(name) && !SAFE_COLOR.test(value)) ||
          (name.startsWith('marker-') && !/^(?:none|url\(#[A-Za-z][A-Za-z0-9_.:-]*\))$/.test(value))) {
        element.removeAttribute(name);
      } else if (name === 'class') {
        element.setAttribute('class', value.split(/\s+/).filter(item => REPORT_CLASSES.has(item)).join(' '));
      }
    }
    if (source) {
      element.classList.add('report-source-reference');
      if (element.textContent?.trim() !== source) {
        const address = document.createElement('span');
        address.className = 'report-source-url';
        address.textContent = source;
        element.after(address);
      }
    }
  }
  for (const table of template.content.querySelectorAll('table')) {
    if (!table.parentElement?.classList.contains('table-wrap')) {
      const wrapper = document.createElement('div');
      wrapper.className = 'table-wrap';
      table.replaceWith(wrapper);
      wrapper.append(table);
    }
  }
  return template.innerHTML;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

export function buildResearchReportDocument(html: string, title: string, fontSize = 16): string {
  const size = Number.isFinite(fontSize) ? Math.min(22, Math.max(14, fontSize)) : 16;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri about:">
<base href="about:srcdoc">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme:dark; --background:#000; --surface:#0d0911; --elevated:#18101e; --text:#eee8f2; --muted:#beb1c8; --accent:#d699f6; --border:#463050; }
* { box-sizing:border-box; }
html { background:var(--background); overflow-wrap:anywhere; scroll-padding-top:12px; }
body { margin:0; color:var(--text); font:${size}px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif; }
main.research-report { max-width:960px; padding:20px 24px 48px; margin:auto; }
h1,h2,h3,h4,h5,h6 { line-height:1.3; color:var(--text); }
h1 { font-size:1.7em; margin:0 0 20px; }
h2 { font-size:1.4em; margin:32px 0 14px; padding-top:18px; border-top:1px solid var(--border); }
h3 { font-size:1.15em; margin:24px 0 12px; }
h4,h5,h6 { font-size:1em; margin:20px 0 10px; }
p,ul,ol,dl { margin:0 0 16px; }
li { margin:6px 0; }
ul,ol { padding-left:24px; }
dd { margin-left:24px; }
a[href] { color:var(--accent); text-underline-offset:3px; }
a[href]:focus-visible,summary:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
.report-source-reference { color:var(--text); }
.report-source-url { display:block; color:var(--muted); font-size:.9em; overflow-wrap:anywhere; }
.lead { font-size:1.1em; color:var(--muted); }
.muted,figcaption,small { color:var(--muted); }
.callout,blockquote { margin:20px 0; padding:14px 16px; background:var(--elevated); border:1px solid var(--border); border-left:3px solid var(--accent); border-radius:10px; }
.callout > :last-child,blockquote > :last-child { margin-bottom:0; }
.metric-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin:20px 0; }
.metric { background:var(--elevated); border:1px solid var(--border); border-radius:10px; padding:16px; }
.metric strong { display:block; color:var(--accent); font-size:1.6em; line-height:1.3; margin-bottom:6px; }
.table-wrap { width:100%; overflow-x:auto; margin:20px 0; border:1px solid var(--border); border-radius:10px; overscroll-behavior-x:contain; }
table { width:100%; border-collapse:collapse; font-size:.95em; line-height:1.5; overflow-wrap:normal; }
caption { text-align:left; padding:12px; font-weight:600; }
th,td { text-align:left; vertical-align:top; min-width:110px; padding:12px; border-bottom:1px solid var(--border); }
th { background:var(--elevated); }
tr:last-child td { border-bottom:0; }
figure { margin:22px 0; padding:14px; border:1px solid var(--border); border-radius:10px; background:var(--elevated); }
svg { display:block; max-width:100%; height:auto; margin:auto; color:var(--text); }
svg:not([fill]) { fill:currentColor; }
figcaption { margin-top:12px; font-size:.9em; }
.source-list { font-size:.95em; }
.source-list li { padding-bottom:8px; }
pre { overflow-x:auto; padding:14px; border-radius:10px; background:var(--surface); border:1px solid var(--border); font-size:.9em; }
code,kbd { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:.9em; }
hr { border:0; border-top:1px solid var(--border); margin:24px 0; }
summary { cursor:pointer; font-weight:600; min-height:48px; padding:10px 0; }
details { margin:18px 0; }
@media (max-width:520px) { main.research-report { padding:16px 14px 32px; } figure { padding:10px; } th,td { padding:10px; } }
</style></head><body><main class="research-report">${prepareReportFragment(html)}</main></body></html>`;
}

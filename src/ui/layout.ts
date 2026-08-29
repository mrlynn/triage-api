/**
 * The whole UI's markup helpers.
 *
 * Server-rendered strings. No React, no bundler, no Tailwind, no build step.
 *
 * WHY: the queue and the trace page exist so a human — a reviewer, or a
 * skeptical security lead — can see what the service decided and why. That is
 * three pages. Reaching for a frontend framework to render three read-mostly
 * pages would add a build pipeline, a dependency tree, and a second thing to
 * keep in sync with the course, in exchange for nothing the pages need.
 *
 * It is styled enough to be read carefully and not styled enough to be mistaken
 * for a product. That is the correct amount for a reference implementation.
 */

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const CSS = `
:root{--bg:#fbfbfa;--fg:#1a1a19;--dim:#6b6b68;--line:#e3e3e0;--card:#fff;
--ok:#1a7f4b;--warn:#a8620a;--bad:#b3261e;--accent:#2a5db0}
@media (prefers-color-scheme:dark){:root{--bg:#151514;--fg:#e8e8e5;--dim:#9a9a96;
--line:#2e2e2c;--card:#1d1d1b;--ok:#4ac47f;--warn:#e0a24a;--bad:#f2685c;--accent:#7aa5f0}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:960px;margin:0 auto;padding:2rem 1.25rem 5rem}
header{border-bottom:1px solid var(--line);margin-bottom:1.75rem;padding-bottom:1rem}
h1{font-size:1.3rem;margin:0 0 .35rem}
h2{font-size:1rem;margin:2rem 0 .6rem;text-transform:uppercase;letter-spacing:.06em;color:var(--dim)}
a{color:var(--accent)}
.sub{color:var(--dim);font-size:.85rem}
.stats{display:flex;gap:1.75rem;flex-wrap:wrap;margin:.75rem 0 0}
.stat b{display:block;font-size:1.5rem;font-weight:600;font-variant-numeric:tabular-nums}
.stat span{color:var(--dim);font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;
padding:1rem 1.1rem;margin-bottom:.75rem}
.row{display:flex;justify-content:space-between;gap:1rem;align-items:baseline;flex-wrap:wrap}
.tag{display:inline-block;font-size:.72rem;padding:.15rem .5rem;border-radius:99px;
border:1px solid var(--line);color:var(--dim);margin-right:.35rem;white-space:nowrap}
.tag.urgent,.tag.bad{color:var(--bad);border-color:var(--bad)}
.tag.high,.tag.warn{color:var(--warn);border-color:var(--warn)}
.tag.ok{color:var(--ok);border-color:var(--ok)}
.msg{white-space:pre-wrap;margin:.6rem 0 0;padding:.7rem .85rem;background:var(--bg);
border-radius:6px;border:1px solid var(--line);font-size:.9rem}
pre{overflow-x:auto;background:var(--bg);border:1px solid var(--line);border-radius:6px;
padding:.75rem;font-size:.8rem;margin:.4rem 0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
button{font:inherit;font-size:.82rem;padding:.3rem .7rem;border-radius:6px;
border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button:hover{border-color:var(--accent);color:var(--accent)}
.empty{color:var(--dim);padding:2.5rem 0;text-align:center}
.note{border-left:3px solid var(--accent);padding:.6rem .9rem;background:var(--card);
border-radius:0 6px 6px 0;font-size:.87rem;margin:.9rem 0}
.note.warn{border-left-color:var(--warn)}
table{width:100%;border-collapse:collapse;font-size:.85rem}
td,th{text-align:left;padding:.4rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:500;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
nav a{margin-right:1rem;font-size:.85rem}
`;

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><main>${body}</main></body></html>`;
}

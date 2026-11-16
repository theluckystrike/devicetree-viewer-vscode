'use strict';
// Webview HTML for the viewer and the Pro tool panels. No vscode import, so tests can check the CSP: no remote origin,
// no connect-src, no worker or blob source, scripts only with the page nonce.
const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

const PREFIX = 'dtViewer';
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function csp(cspSource, n) {
  return ["default-src 'none'", `style-src ${cspSource} 'nonce-${n}'`, `script-src 'nonce-${n}'`, `img-src ${cspSource} data:`, `font-src ${cspSource}`].join('; ');
}

function head(p, n) {
  const footer = footerHtml(PREFIX, p.showSupportLinks !== false, '');
  return { footer, html: `<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(p.cspSource, n)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${attr(p.styleUri)}">
${footer ? `<style nonce="${n}">${FOOTER_CSS}</style>` : ''}
${typeof p.head === 'function' ? p.head(n) : ''}
<title>${attr(p.title)}</title>` };
}

/** p: { cspSource, scriptUri, styleUri, title, showSupportLinks, head?(nonce) } */
function editorHtml(p) {
  const n = p.nonce || crypto.randomBytes(18).toString('base64url');
  const h = head(p, n);
  return `<!DOCTYPE html>
<html lang="en">
<head>
${h.html}
</head>
<body>
<div id="toolbar" role="toolbar" aria-label="Device tree viewer">
  <span id="fmt" class="chip" title="Format and size"></span>
  <input id="search" type="search" spellcheck="false" placeholder="Search nodes, labels, compatible, properties" aria-label="Search the tree">
  <span id="count" class="muted"></span>
  <span id="tabs" class="grp" hidden><button class="tb tab sel" id="tabTree" data-tab="tree">Tree</button><button class="tb tab" id="tabDts" data-tab="dts">DTS text</button></span>
  <button class="tb" id="expand" title="Expand every node">Expand all</button>
  <button class="tb" id="collapse" title="Collapse to the first level">Collapse</button>
  <button class="tb" id="openText" title="Open the file in the text editor">Open as Text</button>
</div>
<div id="app">
  <aside id="side" aria-label="Nodes">
    <div id="tree" role="tree"></div>
  </aside>
  <main id="main">
    <div id="msg" role="alert" hidden></div>
    <section id="details" aria-label="Node details"><p class="muted">Click a node in the tree.</p></section>
    <pre id="dts" hidden aria-label="DTS text"></pre>
  </main>
  <aside id="info" aria-label="File facts">
    <section id="facts"></section>
  </aside>
</div>
<div id="status"><span id="statusText"></span></div>
<div id="footer"></div>
<template id="zovo-footer">${h.footer}</template>
<script nonce="${n}" src="${attr(p.scriptUri)}"></script>
</body>
</html>`;
}

/** Panel of a Pro tool. p: { cspSource, scriptUri, styleUri, title, head?(nonce), showSupportLinks } */
function panelHtml(p) {
  const n = p.nonce || crypto.randomBytes(18).toString('base64url');
  const h = head(p, n);
  return `<!DOCTYPE html>
<html lang="en">
<head>
${h.html}
</head>
<body class="panel">
<div id="toolbar" role="toolbar"><strong id="title"></strong><span id="actions"></span></div>
<div id="app" class="panelApp">
  <div id="report"><p class="muted">Working...</p></div>
</div>
<div id="footer">${h.footer}</div>
<script nonce="${n}" src="${attr(p.scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { editorHtml, panelHtml, csp };

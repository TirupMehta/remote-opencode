// Copies xterm builds from node_modules into web/vendor (served statically).
// Prefers ESM builds; falls back to UMD. Fails loudly with an actionable
// message instead of shipping a broken terminal.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'web', 'vendor');
fs.mkdirSync(vendor, { recursive: true });

function pick(pkgDir, candidates) {
  for (const c of candidates) {
    const p = path.join(pkgDir, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const xtermDir = path.join(root, 'node_modules', '@xterm', 'xterm');
if (!fs.existsSync(xtermDir)) {
  console.error('Missing node_modules/@xterm/xterm. Run `npm install` first.');
  process.exit(1);
}
// @xterm/xterm v5 layout: lib/xterm.mjs + lib/xterm.js (UMD?) + css/xterm.css
const esm = pick(xtermDir, ['lib/xterm.mjs', 'lib/xterm.esm.js', 'out/xterm.mjs']);
const umd = pick(xtermDir, ['lib/xterm.js', 'out/xterm.js']);
const css = pick(xtermDir, ['css/xterm.css', 'lib/xterm.css', 'out/xterm.css']);

if (esm) {
  fs.copyFileSync(esm, path.join(vendor, 'xterm.mjs'));
  console.log(`xterm ESM: ${path.relative(root, esm)}`);
} else if (umd) {
  fs.copyFileSync(umd, path.join(vendor, 'xterm.js'));
  console.log(`xterm UMD: ${path.relative(root, umd)}`);
} else {
  console.error('Could not find an xterm JS build under node_modules/@xterm/xterm.');
  process.exit(1);
}
if (css) {
  fs.copyFileSync(css, path.join(vendor, 'xterm.css'));
  console.log(`xterm CSS: ${path.relative(root, css)}`);
}

const fitDir = path.join(root, 'node_modules', '@xterm', 'addon-fit');
if (fs.existsSync(fitDir)) {
  const fitEsm = pick(fitDir, ['lib/addon-fit.mjs', 'lib/fit.mjs', 'out/addon-fit.mjs']);
  const fitUmd = pick(fitDir, ['lib/addon-fit.js', 'out/addon-fit.js']);
  if (fitEsm) {
    fs.copyFileSync(fitEsm, path.join(vendor, 'addon-fit.mjs'));
    console.log(`fit ESM: ${path.relative(root, fitEsm)}`);
  } else if (fitUmd) {
    fs.copyFileSync(fitUmd, path.join(vendor, 'addon-fit.js'));
    console.log(`fit UMD: ${path.relative(root, fitUmd)}`);
  }
} else {
  console.log('Note: @xterm/addon-fit not installed; terminal works without auto-fit.');
}
console.log('web/vendor ready.');

// GitHub Pages serves 404.html for unknown paths — copy index so the app loads.
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist');
const index = path.join(dist, 'index.html');
const fallback = path.join(dist, '404.html');

if (!fs.existsSync(index)) {
  console.error('pages-fallback: dist/index.html missing — run vite build first');
  process.exit(1);
}

fs.copyFileSync(index, fallback);
console.log('pages-fallback: wrote dist/404.html');

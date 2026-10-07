import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const target = path.join(root, 'public', 'ocr');
const assets = [
  [require.resolve('tesseract.js/package.json'), 'dist/worker.min.js', 'worker.min.js'],
  [require.resolve('tesseract.js-core/package.json'), 'tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'],
  [require.resolve('tesseract.js-core/package.json'), 'tesseract-core-lstm.wasm', 'tesseract-core-lstm.wasm'],
  [require.resolve('@tesseract.js-data/chi_sim/package.json'), '4.0.0_best_int/chi_sim.traineddata.gz', 'chi_sim.traineddata.gz'],
  [require.resolve('@tesseract.js-data/eng/package.json'), '4.0.0_best_int/eng.traineddata.gz', 'eng.traineddata.gz'],
];

await mkdir(target, { recursive: true });
for (const [manifest, relative, name] of assets) {
  await copyFile(path.resolve(path.dirname(manifest), relative), path.join(target, name));
}

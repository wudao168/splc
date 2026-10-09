import { defineConfig } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';

const now = new Date();
const pad = value => String(value).padStart(2, '0');
const buildId = `V${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}.${pad(now.getHours())}${pad(now.getMinutes())}`;
const builtAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

export default defineConfig({
  server: { proxy: { '/api': 'http://127.0.0.1:8765' } },
  build: { sourcemap: false },
  define: { __CAIDAN_BUILD__: JSON.stringify(buildId), __CAIDAN_BUILT_AT__: JSON.stringify(builtAt) },
  plugins: [{
    name: 'caidan-build-stamp',
    closeBundle() {
      mkdirSync('dist', { recursive: true });
      writeFileSync('dist/build-id.txt', `${buildId}\n${builtAt}\n`, 'utf8');
    },
  }],
});

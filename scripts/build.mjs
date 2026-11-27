// Builds the whole dashboard into dist/:
//   dist/aws-dashboard.mjs  the server and its dependencies in one file
//   dist/public/            the browser app
// The dist folder runs with only Node installed: node dist/aws-dashboard.mjs
import { rmSync } from 'node:fs';
import { build as bundleServer } from 'esbuild';
import { build as buildWeb } from 'vite';

rmSync('dist', { recursive: true, force: true });

await buildWeb();

await bundleServer({
  entryPoints: ['server/src/index.ts'],
  outfile: 'dist/aws-dashboard.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'none',
  logLevel: 'info',
  // Bundled CommonJS dependencies expect require, __filename and __dirname to exist.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __pathDirname(__filename);',
    ].join('\n'),
  },
});

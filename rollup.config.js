import { defineConfig } from 'rollup';
import typescript from '@rollup/plugin-typescript';
import tsConfigPaths from 'rollup-plugin-tsconfig-paths';
import json from '@rollup/plugin-json';

const plugins = [
  tsConfigPaths(),
  typescript({ outputToFilesystem: true }),
  json({ preferConst: true })
];

export default defineConfig([
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/src/index.js',
      format: 'esm',
      sourcemap: true
    },
    plugins,
    external: [
      '@hopscotch-trading/js-commons-core/utils',
      '@hopscotch-trading/js-commons-core/lang',
      '@hopscotch-trading/js-commons-core/services',
      '@xmtp/message-kit',
      'async-mutex',
      'openai',
      'node-cache'
    ]
  }
]);

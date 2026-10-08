import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/wire.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  dts: true,
  clean: true,
})

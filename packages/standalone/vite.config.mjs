import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwind from '@tailwindcss/vite'
import { standaloneSharedUi } from '../../scripts/lib/standalone-shared-ui.mjs'

const root = fileURLToPath(new URL('./frontend', import.meta.url))
export default {
  root, base: '/assets/',
  plugins: [tailwind(), standaloneSharedUi()],
  build: {
    outDir: fileURLToPath(new URL('./web', import.meta.url)),
    emptyOutDir: false, write: false, assetsDir: '', target: 'es2022',
    cssCodeSplit: false,
    rollupOptions: {
      // lucide-react ships ESM files carrying React's "use client" directive.
      // Rollup has no use for it in a single-page bundle and warns once per file
      // — noise the user cannot act on, from a dependency they did not write.
      // Filtered by that exact message so every other warning still surfaces.
      onwarn(warning, warn) {
        const id = typeof warning?.id === 'string' ? warning.id : ''
        if (warning?.code === 'MODULE_LEVEL_DIRECTIVE' && id.includes('lucide-react')) return
        warn(warning)
      },
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: asset => asset.names?.some(name => path.extname(name) === '.css') ? 'app.css' : '[name]-[hash][extname]',
      },
    },
  },
}

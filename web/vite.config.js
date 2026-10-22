import { defineConfig } from 'vite';

// Transpile to older JavaScript so the app also runs on older phone browsers
export default defineConfig({
  build: {
    target: ['es2019', 'safari13', 'chrome80'],
  },
});

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/game/reverse-recaptcha/',
  // Vite更新で既存の対応ブラウザを狭めない（Vite 5の既定値）。
  build: { target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'] },
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // ここにベースパスを追加します
  base: '/game/reverse-recaptcha/', 
})
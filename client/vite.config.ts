import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const devPort = Number(env.VITE_DEV_PORT || 5173)
  const apiTarget = env.VITE_API_TARGET || 'http://localhost:5174'

  return {
    plugins: [react()],
    base: command === 'build' ? './' : '/',
    server: {
      port: devPort,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true
        }
      }
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return
            if (id.includes('/antd/') || id.includes('\\antd\\')) return 'antd'
            if (id.includes('/katex/') || id.includes('\\katex\\')) return 'katex'
            if (
              id.includes('react-markdown') ||
              id.includes('remark-') ||
              id.includes('rehype-') ||
              id.includes('micromark') ||
              id.includes('mdast')
            ) {
              return 'markdown'
            }
            if (id.includes('/react/') || id.includes('\\react\\') || id.includes('react-dom')) return 'react'
            return 'vendor'
          }
        }
      }
    }
  }
})

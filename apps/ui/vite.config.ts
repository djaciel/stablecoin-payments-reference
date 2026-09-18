import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    // 0.0.0.0, not localhost: a server bound to the container's loopback is unreachable
    // from your machine no matter what the published port says.
    host: true,
    port: 5173,
    // Fail instead of silently moving to 5174, which would leave the published port
    // pointing at nothing.
    strictPort: true,
    proxy: {
      // The browser only ever talks to localhost:5173. Everything under /api is forwarded
      // to the api container over the compose network, which is why the demo needs no CORS
      // configuration, no api URL in the UI and no environment variable to run.
      // `api` is the compose service name; running Vite outside compose needs an api
      // reachable under that name, or this line changed by hand.
      '/api': {
        target: 'http://api:3000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})

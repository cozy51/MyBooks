import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/** 開発サーバーでも api/ の Vercel Function（/api/embed）を動かす */
function devApi(): Plugin {
  return {
    name: 'mybooks-dev-api',
    configureServer(server) {
      // .env.local などのサーバー用の値（GEMINI_API_KEY など）を process.env に読み込む
      for (const [key, value] of Object.entries(loadEnv(server.config.mode, process.cwd(), ''))) process.env[key] ??= value
      server.middlewares.use('/api/embed', async (req, res) => {
        try {
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)
          const headers = new Headers()
          for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value)
          const { POST } = await server.ssrLoadModule('/api/embed.ts') as { POST: (r: Request) => Promise<Response> }
          const response = req.method === 'POST'
            ? await POST(new Request(`http://localhost${req.originalUrl ?? ''}`, { method: 'POST', headers, body: Buffer.concat(chunks) }))
            : new Response(null, { status: 405 })
          res.statusCode = response.status
          response.headers.forEach((value, key) => res.setHeader(key, value))
          res.end(Buffer.from(await response.arrayBuffer()))
        } catch (e) { res.statusCode = 500; res.end(String(e)) }
      })
    },
  }
}

export default defineConfig({ plugins: [react(), devApi()] })

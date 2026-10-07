import { defineConfig, mergeConfig } from 'vite'
import appConfig from '../vite.config'
// Unit, browser and interactive development servers must not invalidate each other's optimized modules.
export default mergeConfig(appConfig, defineConfig({ cacheDir: 'node_modules/.vite-browser-tests' }))

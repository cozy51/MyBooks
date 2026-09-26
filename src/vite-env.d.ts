/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Google Cloud の OAuth クライアントID（Google Drive 保存に使用） */
  readonly VITE_GOOGLE_CLIENT_ID?: string
}

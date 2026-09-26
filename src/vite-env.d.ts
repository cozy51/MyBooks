/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Google Cloud の OAuth クライアントID（Google Drive 保存に使用） */
  readonly VITE_GOOGLE_CLIENT_ID?: string
  /** Google Cloud の APIキー（Driveから表紙を選ぶ Google Picker に使用） */
  readonly VITE_GOOGLE_API_KEY?: string
  /** 表紙画像を置く Google Drive フォルダのID */
  readonly VITE_DRIVE_COVER_FOLDER_ID?: string
}

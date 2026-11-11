/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HOMEBASE_URL?: string;
  readonly VITE_HOMEBASE_PRESENCE_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

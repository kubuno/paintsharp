// Vite `?url` asset import for wasm files (fonteditor-core WOFF2 module).
declare module '*.wasm?url' {
  const url: string
  export default url
}

import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.ryspa.mousse.client', appName: 'Mousse', webDir: 'dist',
  server: { androidScheme: 'https' },
  // The direct path to a computer on the same network is a ws:// WebSocket from the https://localhost
  // page. Its bytes are TLS pinned to the computer's key inside the app, so the WebSocket being
  // plain adds no exposure. The page itself only loads the app's bundled files.
  android: { allowMixedContent: true },
  plugins: { StatusBar: { overlaysWebView: true, style: 'DARK', backgroundColor: '#000000' } }
}
export default config

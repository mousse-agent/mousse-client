import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.ryspa.mousse.client', appName: 'Mousse', webDir: 'dist',
  server: { androidScheme: 'https' },
  plugins: { StatusBar: { overlaysWebView: true, style: 'DARK', backgroundColor: '#000000' } }
}
export default config

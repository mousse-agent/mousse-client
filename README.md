# Mousse Mobile

The official responsive Capacitor client for a user's Mousse Main Service (MMS). It is a separate repository: it does not use Electron IPC, named pipes, the Mousse home directory, or provider secrets.

## Run

```bash
npm install
npm run dev
npm test
npm run build
```

Use `npm run cap:sync` to copy a production build into the Android and iOS projects, then `npm run cap:android` or `npm run cap:ios` to open the platform project. The app ID is `com.ryspa.mousse.client`.

For a no-account local UI check, run `node scripts/mock-mms.mjs`, then connect to `http://127.0.0.1:28478`. Plain HTTP is deliberately accepted only for loopback URLs; real remote connections require trusted HTTPS.

## Connection and security

Implementation follows `mousse/docs/CLIENT_CONNECTION_SPEC.md` protocol 1.0:

- discovers both well-known metadata documents and checks protocol major 1;
- dynamically registers the public installed client with `com.ryspa.mousse:/oauth/callback`;
- uses the system browser, Authorization Code flow, 256-bit `state`, S256 PKCE, exact issuer validation, and no client secret;
- stores refresh/access token material in Keychain/Keystore through `@aparajita/capacitor-secure-storage` on native platforms. The browser development fallback is Capacitor Preferences and must not be treated as secure production credential storage;
- sends bearer tokens only in headers; mutations get a fresh UUID `Idempotency-Key`;
- rotates refresh tokens and reconnects SSE with `Last-Event-ID`, backoff, reset reloads, visibility/background suspension, and resume snapshots.

The app never logs tokens, sends them in URLs, disables TLS validation, or exposes a certificate-ignore option.

## Feature parity

See [FEATURE_PARITY.md](FEATURE_PARITY.md). Server capabilities are authoritative: a method absent from a particular MMS capability response is presented as unavailable/error rather than emulated locally.

## Tests

`npm test` runs unit coverage for URL/PKCE, RPC bearer/idempotency behaviour, SSE reset parsing, and the protocol integration mock. `npm run test:integration` runs just the mock-server integration test.

## Accessibility and mobile behavior

The UI uses semantic buttons, labels, focus-visible states, live message updates, labelled icon buttons, color-independent connection text, reduced-density mobile navigation, and `viewport-fit=cover` with safe-area insets. On a compact viewport the workspace sidebar becomes an accessible drawer and the main areas use a bottom navigation bar.

## Releases

`.github/workflows/release.yml` publishes a GitHub release with the web bundle (`mousse-client-web-<version>.zip`), a signed Android APK (`mousse-client-<version>.apk`) and `SHA256SUMS.txt`. It typechecks and runs the tests first.

1. Set `version` in `package.json` (and `package-lock.json`) to the new version and merge it.
2. Push a matching tag, `git tag v0.2.0 && git push origin v0.2.0`, or run the Release workflow from the Actions tab.

A version with a suffix such as `0.3.0-beta.1` becomes a pre-release. The APK's version code comes from the version: `1.2.3` is `1002003`.

The APK is signed with the release key in the repository's Actions secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and optionally `ANDROID_KEY_PASSWORD` (defaults to the keystore password). Keep a copy of that key: Android installs updates only when they are signed with the same key. A local `assembleRelease` signs the same way when `MOUSSE_KEYSTORE_FILE` and the other `MOUSSE_KEY*` variables are set.

## License

[MIT](LICENSE)

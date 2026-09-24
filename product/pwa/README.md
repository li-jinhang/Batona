# Batona iOS PWA

This browser client is published at `https://117.72.10.87/projects/dsh-link/pwa/`. Its source stays in this product repository; generated static assets are copied to the separate WebMainIndex site repository for publication.

## Build and browser verification

Use Node.js 18 or later:

```powershell
npm ci
npm run typecheck
npx playwright install chromium
npm run test:e2e
```

The end-to-end fixture starts an isolated Hosted Gateway, an in-process simulated PC tunnel, and a same-origin reverse proxy. It uses no production accounts, real Agent sessions, model calls, or Apple Push service. It verifies the installation gate, PC-approved pairing and occupied phone slot, backend/session behavior, notification subscription cleanup, category-only push, notification-click refresh, and offline shell.

Build the production files with `npm run build`. The Vite base path and Service Worker scope are intentionally fixed to `/projects/dsh-link/pwa/`; do not publish this build under a different path without changing and verifying both.

## Static publication

Copy the contents of `dist/` into `D:\_Projects\00-001WebMainIndex\projects\dsh-link\pwa\`. The static host should serve:

- `index.html` with revalidation (`Cache-Control: no-cache` or equivalent);
- `sw.js` and `manifest.webmanifest` with revalidation;
- fingerprinted files under `assets/` with a long-lived immutable cache policy;
- PNG icons as `image/png` and the manifest as `application/manifest+json` or `application/manifest+json; charset=utf-8`.

Keep the Service Worker scope confined to this PWA path. Do not add `/api/`, `/ws`, or session responses to static caches. The HTML's restrictive Content Security Policy is delivered as a meta policy; because `frame-ancestors` is not supported in meta CSP, include [`product/server/nginx-batona-pwa-static.conf`](../server/nginx-batona-pwa-static.conf) in the HTTPS site's server block. It adds clickjacking protection, no-cache headers for the entry/manifest/worker, immutable caching for fingerprinted assets, and camera/notification policy.

Before deploying user-visible site changes, preserve the current server files, merge the live `data/updates.json` history with the new entry, validate JSON, and deploy only the required page, assets, release data, PWA build, and update record. Preserve the website repository's separate user changes.

## Gateway Web Push provisioning

Push delivery is disabled until VAPID settings are present in the Gateway config. After deploying the Gateway build, provision its keys on the server with the repository script:

```bash
node product/server/gateway/scripts/init-web-push.mjs \
  /etc/batona-gateway/config.json \
  /etc/batona-gateway/web-push \
  'mailto:<actual-operator-address>'
```

The script generates keys once, preserves them on rerun, refuses key files outside the protected directory, backs up the config once, applies restrictive key/directory permissions, and never prints secret values. Back up the VAPID private key together with the encrypted Hosted Gateway account vault; losing it invalidates existing browser subscriptions. Do not copy key files or backup config into either Git repository or the public site.

The server must make outbound HTTPS connections to Apple Web Push. Re-check the public TLS certificate using normal system trust before release. Automated Chromium tests do not qualify iOS Home Screen installation, storage separation, keyboard/safe-area behavior, or real Apple notification delivery; those remain release checks on an iPhone running iOS 16.4 or later.

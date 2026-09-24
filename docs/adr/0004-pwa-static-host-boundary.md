# Host the PWA under the DSH Link origin

The PWA source remains with the Batona product, while its built static files are published by the DSH Link site at a stable same-origin path. This keeps the existing Hosted Gateway Origin and WebSocket checks usable without a CORS/subdomain redesign, and gives the Service Worker a bounded scope. The path is consequential because Home Screen installation state and Web Push subscriptions are tied to the origin/path; the trade-off is a coordinated static-site and Gateway release instead of serving the entire PWA from the Gateway.

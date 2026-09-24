# Autonomous browser surfaces

- `/owner`: public, server-rendered administration shell. No identity, authored content, or private update state is embedded. Authenticated reads and decisions use `/api/readiness` and `/api/operations` with the existing Secure, HttpOnly owner cookie.
- `/owner/app.js`: trusted first-party application script; document CSP authorizes this script through a per-response nonce. No remote dependencies, inline handlers, or authored HTML insertion.
- `/unlock`: public reader-access shell using `/api/viewer-access` and `/api/viewer/unlock`. A viewer session does not authorize administration.
- `/`: preserved published-content entry. Original sandbox CSP and viewer authorization remain unchanged; it is not an administration route.

The claim key and viewing passwords are password inputs sent only in POST JSON bodies. They are cleared before requests and never stored in URLs or browser storage. Claiming is one-use; this UI does not invent a recovery/sign-in mechanism after the existing owner session expires.

Review displays before/after content with DOM textContent, including HTML as inert source text. Comments show context, blocking/resolved status, and earlier-version labels. Approval, publication, change requests, and comment actions reread current proposal/publication identities before submitting compare-and-set arguments and a fresh idempotency key. Changed review state or comments require a refresh. Mutation receipts are followed by live readback, not optimistic success.

Reader-access configuration uses the existing password_required/password and public/confirmDisable schemas. Public reading and publication require explicit confirmation. No restore HTTP endpoint is provided.

Verification: package build and real-process HTTP tests cover public shells, nonce CSP, script syntax, absence of private content, sealed/owner API gates, one-use claiming, and retained sandboxed publication. Browser interaction and visual verification (including 390px) remain the integrating parent's responsibility; these tests do not establish accessibility conformance or complete-MVI acceptance.

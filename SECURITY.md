# Security Policy

## Secrets

New one-click deployments require one Cloudflare Worker Secret, never stored in
source code:

- `INSTANCE_SECRET` - at least 32 bytes; encrypts the generated instance
  configuration stored in the private R2 bucket

Existing deployments may continue to use the legacy Worker Secrets:

- `ADMIN_TOKEN` - Admin authentication token
- `DOWNLOAD_TOKEN` - Provider download authentication token
- `ADMIN_USERNAME` - Admin web login username
- `ADMIN_PASSWORD_HASH` - PBKDF2-SHA256 password derivation; never store plaintext
- `SESSION_SECRET` - Independent key used to sign short-lived admin sessions

When legacy Secrets are not present, first-run setup generates the admin token,
download token, password derivation, and session signing key. They are encrypted
with AES-GCM before being written to R2. Losing or rotating `INSTANCE_SECRET`
without a migration makes that configuration unreadable.

## Never Commit

- `.dev.vars` files
- `wrangler.production.jsonc`
- Real tokens or subscription URLs
- Worker secrets

## SSRF Protection

The system blocks access to:

- localhost and loopback addresses
- Private IP ranges (10.x, 172.16-31.x, 192.168.x)
- Link-local addresses (169.254.x.x)
- Cloud metadata endpoints

## Token Comparison

Tokens are compared using timing-safe comparison to prevent timing attacks.

## Admin Browser Sessions

- Browser login uses an `HttpOnly`, `Secure`, `SameSite=Strict` session cookie.
- Sessions are signed, server-expiring after eight hours, and are not persisted by the browser.
- Unsafe cookie-authenticated requests must be same-origin.
- Login responses use generic credential errors and Cloudflare rate limiting.
- `ADMIN_TOKEN` remains available only for compatible script/API authentication.

## R2 Data

- Only the source hostname is stored, never full subscription URLs
- All versions are immutable
- Path traversal is prevented via slug validation

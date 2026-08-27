# Upstream fetch compatibility

## 403 reproduction

The affected subscription URL was tested with its credential removed from all
recorded output. The response varies by `User-Agent`, but succeeds from a normal
client network:

| Request profile        | Status | Content                 |
| ---------------------- | -----: | ----------------------- |
| Browser UA             |    200 | Base64 URI subscription |
| `clash-verge/v2.4.5`   |    200 | Full Clash YAML         |
| SlClash application UA |    200 | Full Clash YAML         |

The same URL was then tested from the production-equivalent remote runtime:

| Fetch path                                   | Status | Content          |
| -------------------------------------------- | -----: | ---------------- |
| Worker `fetch()`                             |    403 | HTML denial page |
| Browser Run with native Chromium fingerprint |    403 | HTML denial page |
| Browser Run with the configured Clash UA     |    403 | HTML denial page |

Changing `Accept`, redirects, or the browser fingerprint cannot make this
specific upstream reachable because both available remote network paths are
denied before subscription parsing begins.

## SlClash comparison

SlClash downloads profiles through `Dio.get<Uint8List>` backed by Dart
`HttpClient`. It sets the application `User-Agent` and follows the normal HTTP
client behavior. It does not depend on a special Cookie, referer, authorization
header, or subscription-specific request transformation.

This confirms two separate compatibility requirements:

1. Preserve a Clash-compatible UA so compatible airports can return Clash YAML.
2. Provide a private alternate egress path when the normal remote paths are
   denied.

## Fallback design

The updater keeps the inexpensive direct request first and retains Browser Run
for upstreams where browser execution is sufficient. If both paths are denied,
it may use an optional private Workers VPC service binding:

1. The binding reaches a non-public relay through an account-owned Tunnel.
2. The relay validates every initial and redirected URL against SSRF rules.
3. The relay performs a bounded GET with the configured client UA.
4. Only the response body and approved subscription metadata headers return to
   the Worker.
5. Logs contain the provider slug, request ID, method, status, and timing only.
   They never contain the source URL, query, credential, or response body.

The relay is a generic compatibility path. No airport hostname, subscription
path, or credential is hard-coded into application logic.

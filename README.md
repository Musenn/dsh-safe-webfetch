# dsh-safe-webfetch

`dsh-safe-webfetch` adds a local `web_fetch` implementation to DeepSeek Harness. It makes direct anonymous HTTP(S) requests to the requested public site and extracts readable article content on the same machine. It does not use a search, crawling, reader, proxy, or hosted extraction API.

DeepSeek's existing `web_search` provider is left unchanged. The bundle re-enables only the host-plane `web_fetch` tool because Web App agent presets already own `web_search`.

## Security model

- Only anonymous HTTP and HTTPS URLs are accepted.
- URL credentials, loopback, private, link-local, multicast, reserved, documentation, and IPv4-mapped private addresses are blocked.
- Every DNS answer must be public. One private answer rejects the entire request.
- The validated address is pinned into the connection, closing the DNS rebinding gap between validation and connection.
- Every same-origin redirect is resolved and checked again. Cross-origin redirects require a new `web_fetch` call.
- Response bytes, decoded characters, time, redirects, and concurrency are bounded.
- Browser cookies, local files, profile data, credentials, conversations, and sessions are never read.
- HTML is parsed without executing scripts. Readability extraction and active-element removal run locally.

These controls materially reduce SSRF risk; they do not turn untrusted page text into trusted instructions. Treat fetched content as external data.

## VPN fake-IP mode

Some TUN-based VPN clients return addresses from `198.18.0.0/15` for every public hostname. Strict SSRF policy blocks that reserved benchmark range by default.

Set `allowVpnFakeIp: true` only when the local VPN is known to use fake-IP routing. The exception is narrow:

- it applies only to a hostname resolved through system DNS;
- all returned answers must be inside `198.18.0.0/15`;
- a URL containing a literal `198.18.*` address remains blocked;
- local hostname suffixes remain blocked.

Turn the option off when fake-IP routing is not required.

## Install

From a source checkout of this repository:

```sh
npm install
npm test
npm pack
```

Install the resulting archive into a DSH profile:

```sh
dsh plugin --profile web add ./dsh-safe-webfetch-0.1.0.tgz
```

The package is a DSH Profile Bundle and works with both packaged and official source-checkout launchers. Restart DSH after adding or updating a profile plugin.

## Dynamic pages

Static HTTP fetching cannot render client-side applications, pass interactive challenges, or use an authenticated browser session. When a response looks like a JavaScript shell or challenge page, the returned content recommends `browser_open` and `browser_content`. This complements a real browser plugin without duplicating browser automation.

## Configuration

The bundle defaults are defined in `cordis.patch.yml`:

| Field | Default | Purpose |
| --- | ---: | --- |
| `maxResponseBytes` | 5,000,000 | Network body cap |
| `maxBodyChars` | 160,000 | Decoded source cap |
| `timeoutMs` | 30,000 | Provider deadline |
| `maxRedirects` | 5 | Same-origin redirect cap |
| `maxConcurrency` | 4 | Concurrent fetch cap |
| `minReadableChars` | 180 | Readability threshold |
| `allowVpnFakeIp` | `false` | Explicit TUN fake-IP compatibility |

Override an installed row in the profile's `cordis.patch.yml`:

```yaml
- id: safe-webfetch
  config:
    allowVpnFakeIp: true
```

## Current scope

The provider returns HTML, plain text, JSON, and XML through the native DSH fetch result. PDF and other binary formats are rejected. Authenticated, JavaScript-rendered, or challenged pages belong to the installed browser fallback.

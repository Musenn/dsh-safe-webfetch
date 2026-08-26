import assert from "node:assert/strict";
import test from "node:test";
import {
  isPublicAddress,
  isVpnFakeIp,
  resolveSafeTarget,
  validateUrl,
} from "../lib/policy.js";

test("URL policy accepts only anonymous HTTP(S)", () => {
  assert.equal(validateUrl("https://example.com/page", 2048).hostname, "example.com");
  assert.throws(() => validateUrl("file:///etc/passwd", 2048), { code: "WEB_INVALID_URL" });
  assert.throws(() => validateUrl("https://user:pass@example.com", 2048), { code: "WEB_BLOCKED_URL" });
  assert.throws(() => validateUrl(`https://example.com/${"x".repeat(2050)}`, 2048), { code: "WEB_INVALID_URL" });
});

test("address policy rejects local and special networks", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.2", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("93.184.216.34"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  assert.equal(isVpnFakeIp("198.18.1.73"), true);
});

test("DNS rebinding defense rejects any private answer", async () => {
  const url = new URL("https://public.example.com/page");
  await assert.rejects(resolveSafeTarget(url, {
    lookup: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
  }), { code: "WEB_DNS_BLOCKED" });
});

test("VPN fake-IP compatibility is explicit, DNS-only, and all-or-nothing", async () => {
  const lookup = async () => [{ address: "198.18.1.73", family: 4 }];
  await assert.rejects(resolveSafeTarget(new URL("https://example.com"), { lookup }), { code: "WEB_DNS_BLOCKED" });
  const result = await resolveSafeTarget(new URL("https://example.com"), { lookup, allowVpnFakeIp: true });
  assert.equal(result.selected.address, "198.18.1.73");
  await assert.rejects(resolveSafeTarget(new URL("https://198.18.1.73"), { lookup, allowVpnFakeIp: true }), { code: "WEB_BLOCKED_URL" });
});

test("local hostnames are blocked before DNS", async () => {
  for (const hostname of ["localhost", "service.local", "node.internal", "router.home.arpa", "router.lan", "site.test", "hidden.onion"]) {
    await assert.rejects(resolveSafeTarget(new URL(`https://${hostname}`), { lookup: async () => assert.fail("unexpected DNS") }), { code: "WEB_BLOCKED_URL" });
  }
});

import { isIP } from "node:net";
import { lookup as systemLookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

const VPN_FAKE_IP = ipaddr.parseCIDR("198.18.0.0/15");
const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".lan",
  ".home",
  ".corp",
  ".intranet",
  ".test",
  ".invalid",
  ".example",
  ".onion",
];

export class PolicyError extends Error {
  constructor(message, code = "WEB_BLOCKED_URL", options) {
    super(message, options);
    this.name = "PolicyError";
    this.code = code;
  }
}

export function validateUrl(input, maxUrlLength) {
  if (typeof input !== "string" || input.length === 0 || input.length > maxUrlLength) {
    throw new PolicyError(`URL must contain 1-${maxUrlLength} characters`, "WEB_INVALID_URL");
  }
  let url;
  try {
    url = new URL(input);
  } catch (cause) {
    throw new PolicyError("invalid URL", "WEB_INVALID_URL", { cause });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PolicyError("only HTTP and HTTPS URLs are allowed", "WEB_INVALID_URL");
  }
  if (url.username || url.password) {
    throw new PolicyError("credentials in URLs are not allowed");
  }
  if (url.hostname.includes("%")) {
    throw new PolicyError("IPv6 zone identifiers are not allowed");
  }
  return url;
}

export function normalizeHostname(hostname) {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

export function isBlockedHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  return normalized === "localhost" || BLOCKED_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

export function isVpnFakeIp(address) {
  try {
    const parsed = ipaddr.process(address);
    return parsed.kind() === "ipv4" && parsed.match(VPN_FAKE_IP);
  } catch {
    return false;
  }
}

export function isPublicAddress(address) {
  let parsed;
  try {
    parsed = ipaddr.process(address);
  } catch {
    return false;
  }
  return parsed.range() === "unicast";
}

function normalizeAnswer(answer) {
  if (!answer || typeof answer.address !== "string" || (answer.family !== 4 && answer.family !== 6)) {
    throw new PolicyError("DNS returned an invalid address", "WEB_DNS_BLOCKED");
  }
  return { address: answer.address, family: answer.family };
}

export async function resolveSafeTarget(url, options = {}) {
  const hostname = normalizeHostname(url.hostname);
  if (isBlockedHostname(hostname)) {
    throw new PolicyError(`hostname ${hostname} is not publicly routable`);
  }

  const family = isIP(hostname);
  if (family !== 0) {
    if (!isPublicAddress(hostname)) {
      throw new PolicyError(`IP address ${hostname} is not publicly routable`);
    }
    return { hostname, answers: [{ address: hostname, family }], selected: { address: hostname, family } };
  }

  let rawAnswers;
  try {
    rawAnswers = await (options.lookup ?? systemLookup)(hostname, { all: true, verbatim: true });
  } catch (cause) {
    throw new PolicyError(`DNS lookup failed for ${hostname}`, "WEB_DNS_ERROR", { cause });
  }
  const answers = rawAnswers.map(normalizeAnswer);
  if (answers.length === 0) throw new PolicyError(`DNS returned no addresses for ${hostname}`, "WEB_DNS_ERROR");

  const fakeIpAnswers = answers.filter((answer) => isVpnFakeIp(answer.address));
  const publicAnswers = answers.filter((answer) => isPublicAddress(answer.address));
  const blockedAnswers = answers.filter((answer) => !isVpnFakeIp(answer.address) && !isPublicAddress(answer.address));
  if (blockedAnswers.length > 0) {
    throw new PolicyError(`DNS for ${hostname} includes a non-public address`, "WEB_DNS_BLOCKED");
  }
  if (fakeIpAnswers.length > 0) {
    if (!options.allowVpnFakeIp || publicAnswers.length > 0 || fakeIpAnswers.length !== answers.length) {
      throw new PolicyError(`DNS for ${hostname} resolves to the reserved VPN fake-IP range`, "WEB_DNS_BLOCKED");
    }
  }

  const eligible = fakeIpAnswers.length > 0 ? fakeIpAnswers : publicAnswers;
  const selected = eligible.find((answer) => answer.family === 4) ?? eligible[0];
  return { hostname, answers, selected };
}

export function sameOrigin(left, right) {
  return left.protocol === right.protocol && left.hostname === right.hostname && left.port === right.port;
}

export function pinnedLookup(resolution) {
  return (hostname, options, callback) => {
    if (normalizeHostname(hostname) !== resolution.hostname) {
      callback(new Error("transport requested an unexpected hostname"));
      return;
    }
    if (options?.all) {
      callback(null, [{ address: resolution.selected.address, family: resolution.selected.family }]);
      return;
    }
    callback(null, resolution.selected.address, resolution.selected.family);
  };
}

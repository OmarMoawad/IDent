/**
 * Phase 1 session 22 — egress classification.
 *
 * Replaces session 21's `isLoopbackUrl` boolean. The boolean was too coarse
 * for the claim the UI makes: it answered "is this exactly localhost?" and
 * everything else — a LAN box, a VPN peer, a hosted API — collapsed into a
 * single "leaves the machine" bucket. Those are materially different
 * disclosures to a user, and the difference is the whole product promise.
 *
 * So classification is now a named tier, and the tier is what gets
 * surfaced. `leavesMachine` survives as a derived convenience, never as the
 * source of truth.
 *
 * **What this can and cannot establish.** Read this before trusting a tier
 * in a security argument:
 *
 * - It classifies the *configured origin*, at the moment it is asked. It is
 *   not a runtime guarantee about where bytes went.
 * - A hostname can resolve to several addresses. We classify every one and
 *   report the **widest** tier, because a name that resolves to both
 *   127.0.0.1 and a public address can send traffic to the public address.
 *   Failing toward the more alarming disclosure is the only safe direction.
 * - DNS can change between this check and the request (rebinding). A tier
 *   is therefore a point-in-time observation, not a lease. Pinning the
 *   resolved address for the life of the connection is the mitigation, and
 *   this module does not implement it — see `dnsRebindingCaveat`.
 * - HTTP redirects can move a request to a different origin after
 *   classification. The tier describes the first hop only. A client that
 *   follows redirects invalidates the claim; `assistant-client.ts` is
 *   expected not to.
 * - An HTTP proxy in the environment can carry a loopback-*looking*
 *   request off the machine. `proxyOverrideFor` detects that case, and it
 *   overrides the address-derived tier — a proxied request is classified
 *   by where the proxy is, not by where the URL points.
 */
import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";

/**
 * Ordered least to most exposed. The numeric order is load-bearing:
 * `widest()` takes a max over it, so a new tier must be inserted at the
 * right position rather than appended.
 */
export const EGRESS_TIERS = [
  "same_process",
  "loopback",
  "same_machine",
  "private_network",
  "public_internet",
  "unknown",
] as const;

export type EgressTier = (typeof EGRESS_TIERS)[number];

export type EgressAssessment = {
  tier: EgressTier;
  /** Positive, user-facing statement of where processing happens. */
  statement: string;
  /**
   * True for anything past `loopback`. Derived, never authoritative — read
   * `tier` when the distinction between a LAN peer and a hosted API
   * matters, which for a disclosure it usually does.
   */
  leavesMachine: boolean;
  /** The origin classified, for display next to the statement. */
  origin: string;
  /**
   * Addresses the hostname resolved to, when DNS was consulted. Empty for
   * the synchronous path, which deliberately performs no I/O.
   */
  resolvedAddresses: string[];
  /** Set when a proxy, not the URL, determined the tier. */
  proxiedVia?: string;
  /** Why this tier, in one line, for logs and for the operator view. */
  reason: string;
};

const TIER_RANK = new Map<EgressTier, number>(EGRESS_TIERS.map((tier, index) => [tier, index]));

/** `unknown` is treated as leaving: an unverifiable claim is not a safe one. */
export function tierLeavesMachine(tier: EgressTier): boolean {
  return tier !== "same_process" && tier !== "loopback";
}

/** Most-exposed wins. See the multi-address note in the module comment. */
export function widest(tiers: readonly EgressTier[]): EgressTier {
  if (tiers.length === 0) return "unknown";
  return tiers.reduce((worst, tier) => ((TIER_RANK.get(tier) ?? 5) > (TIER_RANK.get(worst) ?? 5) ? tier : worst));
}

export const dnsRebindingCaveat =
  "Classified at resolution time. DNS can change between this check and the request; " +
  "pin the resolved address for the life of the connection if the tier must hold.";

/**
 * RFC 6761 reserves `localhost` for loopback, and resolvers are required to
 * treat it so. We take that at face value rather than resolving it — a
 * `/etc/hosts` that remaps `localhost` is a compromised machine, and no
 * classification here would help.
 */
const LITERAL_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "[::]"]);

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function ipv4Octets(value: string): number[] {
  return value.split(".").map(Number);
}

/**
 * Address-family classification for a literal IP. Deliberately does not
 * consider local interfaces — `classifyAddress` layers that on top, because
 * "is this one of my own addresses" needs `os` state that pure range
 * arithmetic does not.
 */
export function classifyIpLiteral(raw: string): EgressTier {
  const address = stripBrackets(raw).toLowerCase();

  if (isIpv4(address)) {
    const [a, b] = ipv4Octets(address);
    if (a === 127) return "loopback";
    // Unspecified: binds everywhere locally, but as a destination it is
    // loopback on every platform we support.
    if (address === "0.0.0.0") return "loopback";
    if (a === 10) return "private_network";
    if (a === 172 && b >= 16 && b <= 31) return "private_network";
    if (a === 192 && b === 168) return "private_network";
    // Link-local (169.254/16) and CGNAT (100.64/10) are not the public
    // internet and not this machine — the same bucket as a LAN peer.
    if (a === 169 && b === 254) return "private_network";
    if (a === 100 && b >= 64 && b <= 127) return "private_network";
    return "public_internet";
  }

  if (address.includes(":")) {
    if (address === "::1" || address === "::") return "loopback";
    // Unique-local fc00::/7 and link-local fe80::/10 — private overlays
    // (Tailscale, WireGuard) land here, which is the intent.
    if (/^f[cd][0-9a-f]{2}:/.test(address)) return "private_network";
    if (/^fe[89ab][0-9a-f]:/.test(address)) return "private_network";
    // IPv4-mapped (::ffff:a.b.c.d) carries a v4 address; classify that.
    const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return classifyIpLiteral(mapped[1]);
    return "public_internet";
  }

  return "unknown";
}

/** Every non-internal address bound to a local interface. */
function localInterfaceAddresses(): Set<string> {
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      // Strip the zone index (fe80::1%en0) so comparison matches.
      addresses.add(entry.address.split("%")[0].toLowerCase());
    }
  }
  return addresses;
}

/**
 * Classify one resolved address, including the "same machine, but via a
 * real interface rather than loopback" case the old boolean could not
 * express. That case matters: the packet is addressed to this host, but it
 * is reachable to anything that can route to that interface.
 */
export function classifyAddress(address: string, locals: Set<string> = localInterfaceAddresses()): EgressTier {
  const normalized = stripBrackets(address).split("%")[0].toLowerCase();
  const byRange = classifyIpLiteral(normalized);
  if (byRange === "loopback") return "loopback";
  if (locals.has(normalized)) return "same_machine";
  return byRange;
}

/**
 * A proxy in the environment routes the request somewhere the URL does not
 * name. `NO_PROXY` exemptions are honoured, since a `NO_PROXY=localhost`
 * (the common default) means loopback traffic really does stay local.
 */
export function proxyOverrideFor(hostname: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const host = stripBrackets(hostname).toLowerCase();
  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  for (const entry of noProxy) {
    if (entry === "*") return null;
    const bare = entry.startsWith(".") ? entry.slice(1) : entry;
    if (host === bare || host.endsWith(`.${bare}`)) return null;
  }

  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy;
  return proxy?.trim() ? proxy.trim() : null;
}

function statementFor(tier: EgressTier, origin: string, proxiedVia?: string): string {
  if (proxiedVia) {
    return `Processed via the proxy at ${proxiedVia}, which forwards this request off this machine.`;
  }
  switch (tier) {
    case "same_process":
      return `Processed in this server's own process (${origin}). Nothing crosses a network interface.`;
    case "loopback":
      return `Processed locally at ${origin}, on this machine's loopback interface. Nothing leaves this machine.`;
    case "same_machine":
      return `Processed at ${origin} — this machine, but reached over a real network interface rather than loopback, so anything that can route to that address can reach it too.`;
    case "private_network":
      return `Processed at ${origin}, on a private network or VPN. It leaves this machine, but not to the public internet.`;
    case "public_internet":
      return `Processed at ${origin}, over the public internet.`;
    case "unknown":
      return `Could not establish where ${origin} is. Treated as leaving this machine, because an unverified destination is not a safe one.`;
  }
}

function assess(
  tier: EgressTier,
  origin: string,
  reason: string,
  resolvedAddresses: string[] = [],
  proxiedVia?: string,
): EgressAssessment {
  return {
    tier,
    statement: statementFor(tier, origin, proxiedVia),
    leavesMachine: proxiedVia ? true : tierLeavesMachine(tier),
    origin,
    resolvedAddresses,
    ...(proxiedVia ? { proxiedVia } : {}),
    reason,
  };
}

/**
 * A destination known to be a hosted, public-internet API by construction —
 * Anthropic's, today. Stated rather than resolved: running the hostname
 * through `classifyUrlSync` would yield `unknown` (it needs DNS), and
 * "could not establish where this goes" is a worse disclosure than the
 * fact we already have. The tier is not in doubt; only the address is.
 */
export function publicEndpoint(origin: string, reason = "Hosted third-party API."): EgressAssessment {
  return assess("public_internet", origin, reason);
}

/**
 * Synchronous classification — no DNS, no I/O. Handles literal addresses
 * and the reserved loopback names; any other hostname is `unknown`, because
 * without resolving it we genuinely do not know, and guessing from the
 * shape of a name is how a boolean gets something wrong confidently.
 *
 * Used where classification must not await (provider resolution). The
 * status endpoint uses `classifyUrl` for the resolved answer.
 */
export function classifyUrlSync(raw: string, env: NodeJS.ProcessEnv = process.env): EgressAssessment {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return assess("unknown", raw, "Not a parseable URL.");
  }

  const origin = url.origin;
  const hostname = url.hostname.toLowerCase();

  // A unix socket never touches a network interface at all.
  if (url.protocol === "unix:" || url.protocol === "http+unix:") {
    return assess("same_process", origin, "Unix domain socket.");
  }

  const proxy = proxyOverrideFor(hostname, env);
  if (proxy) {
    return assess("public_internet", origin, `Proxy configured (${proxy}) and not exempted by NO_PROXY.`, [], proxy);
  }

  if (LITERAL_LOOPBACK_HOSTS.has(hostname)) {
    return assess("loopback", origin, "Reserved loopback name or literal loopback address.");
  }

  const literal = classifyIpLiteral(hostname);
  if (literal !== "unknown") {
    return assess(literal, origin, `Literal IP address in the ${literal} range.`, [stripBrackets(hostname)]);
  }

  return assess("unknown", origin, "Hostname needs DNS resolution; none performed on the synchronous path.");
}

/**
 * Full classification, resolving the hostname. Returns the **widest** tier
 * across every address the name resolves to — see the module comment for
 * why that direction and not the narrowest.
 */
export async function classifyUrl(raw: string, env: NodeJS.ProcessEnv = process.env): Promise<EgressAssessment> {
  const sync = classifyUrlSync(raw, env);
  if (sync.tier !== "unknown" || sync.proxiedVia) return sync;
  // Anything still unknown here is a hostname we chose not to guess at.
  if (sync.reason === "Not a parseable URL.") return sync;

  const hostname = new URL(raw).hostname.toLowerCase();

  try {
    const results = await lookup(stripBrackets(hostname), { all: true, verbatim: true });
    if (results.length === 0) {
      return assess("unknown", sync.origin, "Hostname resolved to no addresses.");
    }
    const locals = localInterfaceAddresses();
    const addresses = results.map((result) => result.address);
    const tiers = addresses.map((address) => classifyAddress(address, locals));
    const tier = widest(tiers);
    const detail =
      addresses.length > 1
        ? `Resolved to ${addresses.length} addresses (${addresses.join(", ")}); reporting the widest tier.`
        : `Resolved to ${addresses[0]}.`;
    return assess(tier, sync.origin, detail, addresses);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return assess("unknown", sync.origin, `DNS resolution failed: ${message}`);
  }
}

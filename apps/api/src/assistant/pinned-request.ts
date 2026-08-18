import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import { classifyUrl, type EgressAssessment } from "./egress.js";

/**
 * Session 22c — external review finding #6: *"egress claims are not
 * technically enforced."*
 *
 * Session 22 classified where the assistant's provider is and showed the
 * user a sentence about it. The sentence was true when it was composed
 * and nothing kept it true: DNS could change between the check and the
 * request (rebinding), and a redirect could move the request to another
 * origin entirely after classification. `egress.ts` said so in its own
 * module comment — which is honest, and is not the same as the UI telling
 * the truth. The review's point was exactly that.
 *
 * So this is the enforcement half. A request sent through here:
 *
 * 1. **Connects to the address that was classified.** The hostname is
 *    resolved once, the tier is computed from those addresses, and the
 *    socket is then pinned to one of them via `lookup`. A DNS answer that
 *    changes after classification cannot move the connection, because no
 *    second resolution happens.
 * 2. **Refuses redirects.** `node:http` does not follow them, and a 3xx
 *    is treated as a failure rather than a response: a provider that
 *    answers a redirect is a provider whose disclosed destination is no
 *    longer the destination.
 * 3. **Refuses a destination wider than the caller allows.** The caller
 *    states the tiers it is prepared to talk to, and anything else fails
 *    before a byte is sent.
 *
 * What it still does not do, said plainly rather than left implied: it
 * pins the *address*, not the machine at that address, and it does not
 * verify a TLS certificate beyond Node's defaults. Pinning makes the
 * disclosure hold for the life of one request. It is not an attestation
 * about who is listening on that address.
 */

export class EgressViolationError extends Error {
  constructor(
    message: string,
    readonly assessment: EgressAssessment,
  ) {
    super(message);
    this.name = "EgressViolationError";
  }
}

export type PinnedResponse = {
  status: number;
  body: string;
  /** The address actually connected to — for the disclosure, and for logs. */
  pinnedAddress: string;
  assessment: EgressAssessment;
};

/** Tiers the assistant may talk to unless a caller says otherwise. */
export type TierAllowance = { allow: readonly EgressAssessment["tier"][] } | { allowAny: true };

function isAllowed(assessment: EgressAssessment, allowance: TierAllowance): boolean {
  if ("allowAny" in allowance) return true;
  return allowance.allow.includes(assessment.tier);
}

export async function postJsonPinned(
  url: string,
  options: {
    headers: Record<string, string>;
    body: string;
    allowance: TierAllowance;
    timeoutMs?: number;
  },
): Promise<PinnedResponse> {
  const assessment = await classifyUrl(url);

  if (!isAllowed(assessment, options.allowance)) {
    throw new EgressViolationError(
      `Refusing to send data to a ${assessment.tier} destination (${assessment.origin}).`,
      assessment,
    );
  }

  const target = new URL(url);
  const isHttps = target.protocol === "https:";

  /**
   * The address to pin to. `classifyUrl` reports the **widest** tier
   * across every address a name resolved to, so if the assessment passed
   * the allowance, every resolved address did — which is what makes
   * taking the first one safe rather than arbitrary. A literal-IP URL
   * resolves to itself and lands here unchanged.
   */
  const pinnedAddress = assessment.resolvedAddresses[0] ?? target.hostname.replace(/^\[|\]$/g, "");
  const family = pinnedAddress.includes(":") ? 6 : 4;

  const send = isHttps ? httpsRequest : httpRequest;

  return await new Promise<PinnedResponse>((resolve, reject) => {
    const req = send(
      {
        protocol: target.protocol,
        // `hostname` stays the real name so TLS SNI and certificate
        // verification are still done against it; only the address the
        // socket dials is overridden.
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: { ...options.headers, "content-length": Buffer.byteLength(options.body).toString() },
        // The pin. Called instead of a real DNS lookup, so nothing is
        // resolved a second time and a changed record cannot take effect.
        lookup: (_hostname, _opts, callback) => {
          // Node's overloads allow both shapes; `all` wants an array.
          const cb = callback as (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void;
          if (_opts && typeof _opts === "object" && "all" in _opts && _opts.all) {
            cb(null, [{ address: pinnedAddress, family }]);
            return;
          }
          cb(null, pinnedAddress, family);
        },
      },
      (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;

        // A redirect is a change of destination after the disclosure was
        // made. Refused rather than followed — and the socket is destroyed
        // rather than drained, since nothing in the body is wanted.
        if (status >= 300 && status < 400) {
          response.destroy();
          reject(
            new EgressViolationError(
              `Assistant provider answered ${status} with a redirect; the disclosed destination would no longer be the destination.`,
              assessment,
            ),
          );
          return;
        }

        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ status, body, pinnedAddress, assessment }));
      },
    );

    req.setTimeout(options.timeoutMs ?? 120_000, () => {
      req.destroy(new Error("Assistant provider timed out."));
    });
    req.on("error", reject);
    req.write(options.body);
    req.end();
  });
}

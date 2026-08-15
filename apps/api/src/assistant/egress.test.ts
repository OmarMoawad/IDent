import { describe, expect, it } from "vitest";
import {
  classifyAddress,
  classifyIpLiteral,
  classifyUrl,
  classifyUrlSync,
  proxyOverrideFor,
  publicEndpoint,
  tierLeavesMachine,
  widest,
} from "./egress.js";

const env = (values: Record<string, string> = {}) => values as unknown as NodeJS.ProcessEnv;

describe("classifyIpLiteral", () => {
  it("puts every loopback form in the loopback tier", () => {
    for (const address of ["127.0.0.1", "127.1.2.3", "::1", "0.0.0.0", "::ffff:127.0.0.1"]) {
      expect(classifyIpLiteral(address)).toBe("loopback");
    }
  });

  it("separates private ranges from the public internet", () => {
    // The distinction session 21's boolean could not draw: these are off
    // this machine but not on the public internet.
    for (const address of ["10.0.0.5", "172.16.4.1", "172.31.255.254", "192.168.1.50", "169.254.1.1", "100.64.0.1"]) {
      expect(classifyIpLiteral(address)).toBe("private_network");
    }
    // fd00::/8 is unique-local; a Tailscale/WireGuard peer lands here.
    expect(classifyIpLiteral("fd7a:115c:a1e0::1")).toBe("private_network");
    expect(classifyIpLiteral("fe80::1")).toBe("private_network");
  });

  it("does not mistake near-miss ranges for private ones", () => {
    // 172.15 and 172.32 are outside 172.16/12; a boundary slip here would
    // silently downgrade a public address to "private".
    expect(classifyIpLiteral("172.15.0.1")).toBe("public_internet");
    expect(classifyIpLiteral("172.32.0.1")).toBe("public_internet");
    expect(classifyIpLiteral("100.63.0.1")).toBe("public_internet");
    expect(classifyIpLiteral("100.128.0.1")).toBe("public_internet");
    expect(classifyIpLiteral("11.0.0.1")).toBe("public_internet");
  });

  it("classifies an IPv4-mapped address by its IPv4 payload", () => {
    expect(classifyIpLiteral("::ffff:192.168.1.5")).toBe("private_network");
    expect(classifyIpLiteral("::ffff:8.8.8.8")).toBe("public_internet");
  });
});

describe("classifyAddress", () => {
  it("reports a non-loopback local interface address as same_machine", () => {
    // Same host, but reachable to anything that can route to that
    // interface — a materially weaker position than loopback, and the tier
    // says so instead of collapsing it into "local".
    const locals = new Set(["192.168.1.20"]);
    expect(classifyAddress("192.168.1.20", locals)).toBe("same_machine");
    expect(classifyAddress("192.168.1.21", locals)).toBe("private_network");
  });

  it("keeps loopback ahead of the interface check", () => {
    expect(classifyAddress("127.0.0.1", new Set(["127.0.0.1"]))).toBe("loopback");
  });

  it("ignores an IPv6 zone index", () => {
    expect(classifyAddress("fe80::1%en0", new Set())).toBe("private_network");
  });
});

describe("widest", () => {
  it("returns the most exposed tier, because failing toward disclosure is the safe direction", () => {
    expect(widest(["loopback", "public_internet"])).toBe("public_internet");
    expect(widest(["loopback", "private_network"])).toBe("private_network");
    expect(widest(["loopback"])).toBe("loopback");
    expect(widest([])).toBe("unknown");
  });

  it("ranks unknown above public_internet", () => {
    // An unverifiable destination is not safer than a known-public one.
    expect(widest(["public_internet", "unknown"])).toBe("unknown");
  });
});

describe("tierLeavesMachine", () => {
  it("treats unknown as leaving", () => {
    expect(tierLeavesMachine("unknown")).toBe(true);
    expect(tierLeavesMachine("same_machine")).toBe(true);
    expect(tierLeavesMachine("loopback")).toBe(false);
    expect(tierLeavesMachine("same_process")).toBe(false);
  });
});

describe("proxyOverrideFor", () => {
  it("detects a proxy that would carry the request off-machine", () => {
    expect(proxyOverrideFor("localhost", env({ HTTPS_PROXY: "http://proxy.corp:8080" }))).toBe("http://proxy.corp:8080");
  });

  it("honours NO_PROXY exemptions", () => {
    expect(proxyOverrideFor("localhost", env({ HTTP_PROXY: "http://proxy.corp:8080", NO_PROXY: "localhost,127.0.0.1" }))).toBeNull();
    expect(proxyOverrideFor("api.internal.example", env({ HTTP_PROXY: "http://p:8080", NO_PROXY: ".example" }))).toBeNull();
    expect(proxyOverrideFor("anything", env({ HTTP_PROXY: "http://p:8080", NO_PROXY: "*" }))).toBeNull();
  });

  it("is null when no proxy is set", () => {
    expect(proxyOverrideFor("localhost", env({}))).toBeNull();
  });
});

describe("classifyUrlSync", () => {
  it("classifies the default local base URL as loopback and says so positively", () => {
    const result = classifyUrlSync("http://localhost:11434/v1", env({}));
    expect(result.tier).toBe("loopback");
    expect(result.leavesMachine).toBe(false);
    // Item 4: the disclosure asserts where processing happens rather than
    // merely omitting a warning.
    expect(result.statement).toContain("Processed locally at http://localhost:11434");
    expect(result.statement).toContain("Nothing leaves this machine");
  });

  it("classifies a LAN literal as private_network, not as generic egress", () => {
    const result = classifyUrlSync("http://192.168.1.50:11434/v1", env({}));
    expect(result.tier).toBe("private_network");
    expect(result.leavesMachine).toBe(true);
    expect(result.statement).toContain("not to the public internet");
  });

  it("refuses to guess at a hostname on the no-I/O path", () => {
    // Guessing from the shape of a name is how a boolean gets something
    // wrong confidently. `unknown` here is the honest answer; the status
    // route resolves it.
    const result = classifyUrlSync("https://api.example.com/v1", env({}));
    expect(result.tier).toBe("unknown");
    expect(result.leavesMachine).toBe(true);
  });

  it("lets a proxy override a loopback-looking URL", () => {
    // The whole point of the proxy check: this URL reads as loopback and
    // the request still leaves the machine.
    const result = classifyUrlSync("http://localhost:11434/v1", env({ HTTPS_PROXY: "http://proxy.corp:8080" }));
    expect(result.tier).toBe("public_internet");
    expect(result.leavesMachine).toBe(true);
    expect(result.proxiedVia).toBe("http://proxy.corp:8080");
    expect(result.statement).toContain("proxy");
  });

  it("classifies a unix socket as same_process", () => {
    expect(classifyUrlSync("unix:///var/run/model.sock", env({})).tier).toBe("same_process");
  });

  it("returns unknown for an unparseable URL", () => {
    const result = classifyUrlSync("not-a-url", env({}));
    expect(result.tier).toBe("unknown");
    expect(result.leavesMachine).toBe(true);
  });
});

describe("classifyUrl", () => {
  it("resolves a hostname that the sync path would not guess at", async () => {
    // localhost.localdomain-style names aside, this is the one hostname we
    // can rely on resolving identically on any developer machine.
    const result = await classifyUrl("http://localhost:11434/v1", env({}));
    expect(result.tier).toBe("loopback");
  });

  it("reports unknown when the name does not resolve", async () => {
    const result = await classifyUrl("http://this-host-does-not-exist.invalid/v1", env({}));
    expect(result.tier).toBe("unknown");
    expect(result.leavesMachine).toBe(true);
    expect(result.reason).toMatch(/DNS resolution failed|no addresses/);
  });

  it("passes a proxied URL straight through without resolving", async () => {
    const result = await classifyUrl("https://api.example.com/v1", env({ HTTPS_PROXY: "http://proxy.corp:8080" }));
    expect(result.proxiedVia).toBe("http://proxy.corp:8080");
  });
});

describe("publicEndpoint", () => {
  it("states a hosted API's tier rather than resolving it", () => {
    const result = publicEndpoint("https://api.anthropic.com", "Anthropic's hosted API.");
    expect(result.tier).toBe("public_internet");
    expect(result.leavesMachine).toBe(true);
    expect(result.statement).toContain("public internet");
  });
});

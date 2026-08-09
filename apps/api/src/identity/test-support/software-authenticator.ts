import { type CBORType, encodeCBOR } from "@levischuck/tiny-cbor";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { ORIGIN, RP_ID } from "../webauthn-config.js";

/**
 * A minimal, from-scratch WebAuthn authenticator implemented with Node's
 * built-in crypto, used only by tests. It exists so the identity/webauthn
 * test suite exercises @simplewebauthn/server's real signature/attestation
 * verification against genuine ECDSA P-256 responses — not a mocked
 * "verified: true" — the same way a real passkey would, minus the browser.
 * There is no navigator.credentials shim here; apps/web still has no UI to
 * drive one (see IDent_STATE.md).
 */

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function sha256(data: Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

function buildClientDataJSON(type: "webauthn.create" | "webauthn.get", challenge: string): Buffer {
  const json = JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false });
  return Buffer.from(json, "utf-8");
}

/**
 * Node's SPKI/DER export for a P-256 EC public key always ends with the
 * uncompressed point (0x04 || x[32] || y[32]) — the algorithm identifier
 * prefix ahead of it is fixed-length for this key type, so slicing the
 * last 65 bytes is reliable here (not a general-purpose SPKI parser).
 */
function splitP256Point(publicKeyDer: Buffer): { x: Buffer; y: Buffer } {
  const rawPoint = publicKeyDer.subarray(publicKeyDer.length - 65);
  if (rawPoint[0] !== 0x04) throw new Error("Unexpected EC point encoding in SPKI DER");
  return { x: Buffer.from(rawPoint.subarray(1, 33)), y: Buffer.from(rawPoint.subarray(33, 65)) };
}

function encodeCosePublicKeyP256(publicKeyDer: Buffer): Uint8Array {
  const { x, y } = splitP256Point(publicKeyDer);
  const coseKey = new Map<number, CBORType>([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, x],
    [-3, y],
  ]);
  return encodeCBOR(coseKey);
}

function buildAuthenticatorData(options: {
  counter: number;
  userVerified: boolean;
  attestedCredentialData?: { credentialId: Buffer; publicKeyCose: Uint8Array };
}): Buffer {
  const rpIdHash = sha256(Buffer.from(RP_ID, "utf-8"));

  let flags = 0x01; // UP: user present
  if (options.userVerified) flags |= 0x04; // UV: user verified
  if (options.attestedCredentialData) flags |= 0x40; // AT: attested credential data included

  const counterBuf = Buffer.alloc(4);
  counterBuf.writeUInt32BE(options.counter, 0);

  const parts: Buffer[] = [rpIdHash, Buffer.from([flags]), counterBuf];

  if (options.attestedCredentialData) {
    const { credentialId, publicKeyCose } = options.attestedCredentialData;
    const aaguid = Buffer.alloc(16); // all-zero AAGUID: no vendor identity to claim
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(credentialId.length, 0);
    parts.push(aaguid, credIdLen, credentialId, Buffer.from(publicKeyCose));
  }

  return Buffer.concat(parts);
}

export type SimulatedRegistrationResponse = {
  id: string;
  rawId: string;
  type: "public-key";
  clientExtensionResults: Record<string, never>;
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports: string[];
  };
};

export type SimulatedAuthenticationResponse = {
  id: string;
  rawId: string;
  type: "public-key";
  clientExtensionResults: Record<string, never>;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
};

export class SoftwareAuthenticator {
  private credentialId: Buffer | undefined;
  private privateKey: KeyObject | undefined;
  private publicKeyCose: Uint8Array | undefined;
  private counter = 0;

  register(challenge: string): SimulatedRegistrationResponse {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    this.publicKeyCose = encodeCosePublicKeyP256(publicKey.export({ format: "der", type: "spki" }));
    this.credentialId = randomBytes(32);
    this.counter = 1;

    const clientDataJSON = buildClientDataJSON("webauthn.create", challenge);
    const authData = buildAuthenticatorData({
      counter: this.counter,
      userVerified: true,
      attestedCredentialData: { credentialId: this.credentialId, publicKeyCose: this.publicKeyCose },
    });

    const attestationObject = encodeCBOR(
      new Map<string, CBORType>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );

    const credentialIdB64 = base64url(this.credentialId);
    return {
      id: credentialIdB64,
      rawId: credentialIdB64,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: base64url(clientDataJSON),
        attestationObject: base64url(attestationObject),
        transports: ["internal"],
      },
    };
  }

  authenticate(challenge: string): SimulatedAuthenticationResponse {
    if (!this.credentialId || !this.privateKey) {
      throw new Error("register() must be called before authenticate()");
    }
    this.counter += 1;

    const clientDataJSON = buildClientDataJSON("webauthn.get", challenge);
    const authData = buildAuthenticatorData({ counter: this.counter, userVerified: true });
    const signedData = Buffer.concat([authData, sha256(clientDataJSON)]);
    // Node's default signature encoding for EC keys is DER, matching the
    // ECDSA signature encoding WebAuthn assertions are specified to use.
    const signature = createSign("sha256").update(signedData).sign(this.privateKey);

    const credentialIdB64 = base64url(this.credentialId);
    return {
      id: credentialIdB64,
      rawId: credentialIdB64,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: base64url(clientDataJSON),
        authenticatorData: base64url(authData),
        signature: base64url(signature),
      },
    };
  }
}

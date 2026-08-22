import { describe, expect, it } from "vitest";
import {
  ConnectedSourceNotConnectedError,
  ConnectedSourceOwnershipError,
} from "../../comms/connection-service.js";
import { GMAIL_MODIFY_SCOPE, CALENDAR_EVENTS_SCOPE, GMAIL_READONLY_SCOPE } from "../../comms/comms-config.js";
import { ConnectionServiceTokenProvider } from "./executor-factory.js";

const accessor = (scope: string) => async () => ({ accessToken: "tok", scope });

describe("ConnectionServiceTokenProvider", () => {
  it("grants a token when the required write scope is present", async () => {
    const provider = new ConnectionServiceTokenProvider(accessor(`${GMAIL_MODIFY_SCOPE} ${CALENDAR_EVENTS_SCOPE}`));
    expect(await provider.tokenFor({ identityId: "i", sourceId: "s", capability: "gmail.modify" })).toEqual({ accessToken: "tok" });
    expect(await provider.tokenFor({ identityId: "i", sourceId: "s", capability: "calendar.events" })).toEqual({ accessToken: "tok" });
  });

  it("reports missing_scope for a read-only grant, so the UI prompts a reconnect", async () => {
    const provider = new ConnectionServiceTokenProvider(accessor(GMAIL_READONLY_SCOPE));
    expect(await provider.tokenFor({ identityId: "i", sourceId: "s", capability: "gmail.modify" })).toEqual({ ineligible: "missing_scope" });
  });

  it("maps connection errors to safe ineligibility codes, never leaking details", async () => {
    const notConnected = new ConnectionServiceTokenProvider(async () => {
      throw new ConnectedSourceNotConnectedError();
    });
    expect(await notConnected.tokenFor({ identityId: "i", sourceId: "s", capability: "gmail.modify" })).toEqual({ ineligible: "not_connected" });

    const notOwned = new ConnectionServiceTokenProvider(async () => {
      throw new ConnectedSourceOwnershipError();
    });
    expect(await notOwned.tokenFor({ identityId: "i", sourceId: "s", capability: "gmail.modify" })).toEqual({ ineligible: "not_owned" });
  });
});

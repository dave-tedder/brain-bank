// The key boundary, both ways. EXTERNAL_CRM_PUSH_KEY unlocks external-crm-sync
// and nothing else; MCP_ACCESS_KEY unlocks everything else and not this.
// Run: deno test --allow-env supabase/functions/external-crm-sync/

import { assertEquals } from "jsr:@std/assert@1.0.19";
import { authenticateAccessKey } from "../_shared/access-key.ts";
import { authenticatePushKey, PUSH_KEY_ENV, PUSH_KEY_HEADER } from "./_auth.ts";

const MCP_KEY = "mcp-key-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PUSH_KEY = "push-key-BBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function withKeys<T>(fn: () => T): T {
  const prevMcp = Deno.env.get("MCP_ACCESS_KEY");
  const prevPush = Deno.env.get(PUSH_KEY_ENV);
  Deno.env.set("MCP_ACCESS_KEY", MCP_KEY);
  Deno.env.set(PUSH_KEY_ENV, PUSH_KEY);
  try {
    return fn();
  } finally {
    if (prevMcp === undefined) Deno.env.delete("MCP_ACCESS_KEY");
    else Deno.env.set("MCP_ACCESS_KEY", prevMcp);
    if (prevPush === undefined) Deno.env.delete(PUSH_KEY_ENV);
    else Deno.env.set(PUSH_KEY_ENV, prevPush);
  }
}

Deno.test("boundary: the push key is refused by open-brain-mcp's authenticator (header and bearer)", () => {
  withKeys(() => {
    assertEquals(
      authenticateAccessKey(new Headers({ "x-brain-key": PUSH_KEY })).ok,
      false,
    );
    assertEquals(
      authenticateAccessKey(
        new Headers({ authorization: `Bearer ${PUSH_KEY}` }),
        { allowBearer: true },
      ).ok,
      false,
    );
    assertEquals(
      authenticateAccessKey(new Headers({ [PUSH_KEY_HEADER]: PUSH_KEY })).ok,
      false,
    );
    // Positive control: the same authenticator accepts its own key, so the
    // refusals above are about the key, not a broken fixture.
    assertEquals(
      authenticateAccessKey(new Headers({ "x-brain-key": MCP_KEY })).ok,
      true,
    );
  });
});

Deno.test("boundary: the MCP key is refused by external-crm-sync (any header form)", () => {
  withKeys(() => {
    assertEquals(
      authenticatePushKey(new Headers({ [PUSH_KEY_HEADER]: MCP_KEY })),
      { ok: false, reason: "mismatch" },
    );
    assertEquals(
      authenticatePushKey(new Headers({ "x-brain-key": MCP_KEY })),
      { ok: false, reason: "missing" },
    );
    assertEquals(
      authenticatePushKey(new Headers({ authorization: `Bearer ${MCP_KEY}` })),
      { ok: false, reason: "missing" },
    );
    // Positive control.
    assertEquals(
      authenticatePushKey(new Headers({ [PUSH_KEY_HEADER]: PUSH_KEY })),
      { ok: true, reason: "ok" },
    );
  });
});

Deno.test("boundary: the push key is accepted ONLY in x-push-key, never as x-brain-key or bearer", () => {
  withKeys(() => {
    assertEquals(
      authenticatePushKey(new Headers({ "x-brain-key": PUSH_KEY })).ok,
      false,
    );
    assertEquals(
      authenticatePushKey(new Headers({ authorization: `Bearer ${PUSH_KEY}` }))
        .ok,
      false,
    );
  });
});

Deno.test("boundary: an unconfigured or empty push key refuses everything, including an empty header", () => {
  assertEquals(
    authenticatePushKey(new Headers({ [PUSH_KEY_HEADER]: "" }), ""),
    { ok: false, reason: "not_configured" },
  );
  assertEquals(
    authenticatePushKey(new Headers({ [PUSH_KEY_HEADER]: "anything" }), ""),
    { ok: false, reason: "not_configured" },
  );
  const prev = Deno.env.get(PUSH_KEY_ENV);
  Deno.env.delete(PUSH_KEY_ENV);
  try {
    assertEquals(
      authenticatePushKey(new Headers({ [PUSH_KEY_HEADER]: "anything" })).reason,
      "not_configured",
    );
  } finally {
    if (prev !== undefined) Deno.env.set(PUSH_KEY_ENV, prev);
  }
});

Deno.test("boundary: a near-miss push key is refused", () => {
  withKeys(() => {
    assertEquals(
      authenticatePushKey(new Headers({ [PUSH_KEY_HEADER]: PUSH_KEY + "x" })).ok,
      false,
    );
    assertEquals(
      authenticatePushKey(new Headers({ [PUSH_KEY_HEADER]: PUSH_KEY.slice(1) }))
        .ok,
      false,
    );
    // Same length, one byte different: a length-only comparison would pass this.
    const sameLength = PUSH_KEY.slice(0, -1) + (PUSH_KEY.endsWith("B") ? "C" : "B");
    assertEquals(sameLength.length, PUSH_KEY.length);
    assertEquals(
      authenticatePushKey(new Headers({ [PUSH_KEY_HEADER]: sameLength })).ok,
      false,
    );
  });
});

# Security Policy

Brain Bank is an open-source semantic memory engine. It accepts captured content, stores it in a Supabase Postgres database, and exposes it through MCP, REST, and Slack endpoints. If you find a security issue, please follow the disclosure path below.

## Reporting a Vulnerability

**Use GitHub Security Advisories, not public issues.** Open a draft advisory at:

[https://github.com/dave-tedder/brain-bank/security/advisories/new](https://github.com/dave-tedder/brain-bank/security/advisories/new)

That keeps the report private until a fix is ready. A public issue or pull request that names a vulnerability before it is fixed exposes every operator running the engine.

If you cannot use Security Advisories for some reason, do not file a public issue. Reach out through any of the operator's other public channels and ask for a private channel before sharing details.

## What to Include

- A description of the vulnerability and its impact.
- A reproduction recipe: the endpoint or capture path involved, the payload or sequence of calls, and the resulting behavior.
- The affected version (the latest commit on `main` is preferred; tag if you tested against a specific release).
- Any known mitigations or workarounds.

## What to Expect

- **Acknowledgement:** within 7 days, an acknowledgement that the report was received and is being investigated.
- **Investigation + fix:** best-effort, typically within 30 days for high-severity issues. Lower-severity issues may take longer.
- **Public disclosure:** once a fix is released, the advisory will be published with credit to the reporter (unless the reporter prefers to remain anonymous).

This is a single-maintainer open-source project, so timelines are best-effort, not contractual.

## Supported Versions

Only the latest tagged release receives security fixes. Operators running older releases or unreleased commits should expect to upgrade to the latest tag to receive a fix.

| Version | Supported |
| ------- | --------- |
| Latest tagged release on `main` | Yes |
| Pre-release / `[Unreleased]` `dev` branch | Yes (best-effort) |
| Older tagged releases | No |

## Threat Model

Brain Bank is designed for a **single trusted operator**. The `MCP_ACCESS_KEY` is a shared secret between the operator's deploy and any client that authenticates against it (the operator's own dashboard, Slack workspace, ChatGPT GPT, etc.). The threat model assumes:

- The operator owns and controls every credential in `.env` and Supabase secrets.
- The Edge Function endpoints are reachable from the public internet but gated by `MCP_ACCESS_KEY` (REST + MCP) or the Slack signing secret (Slack inbound).
- A leak of `MCP_ACCESS_KEY` allows an attacker to write captures and read all stored thoughts. The mitigation is to rotate the key (see `docs/troubleshooting.md`).
- A leak of the Supabase `service_role` key allows full database access. Same mitigation: rotate.
- The operator sets a per-month spend cap on their OpenRouter account so a leaked key cannot drain unlimited LLM credits.

If you intend to run Brain Bank for multiple users or untrusted callers, the engine does not currently provide per-key rate limiting or quotas. Place a Cloudflare Worker, API Gateway, or similar enforcement layer in front of the Edge Functions before exposing the deploy beyond the operator.

## What is NOT in Scope

The following are accepted limitations of the current design and are not security vulnerabilities:

- **Operator-side credential leaks.** If an operator commits `.env` to git, posts a screenshot containing `MCP_ACCESS_KEY`, or shares a server log without redacting URL-parameter auth values, that is operator error. The engine documents the rotation path.
- **Costs from a leaked key.** As above; OpenRouter spend caps are the backstop.
- **Lack of per-tenant isolation.** Brain Bank is single-tenant by design. Multi-tenant deployments are out of scope until a future release.

If you are unsure whether something falls inside or outside this scope, file the advisory anyway. We would rather review one borderline report than miss a real issue.

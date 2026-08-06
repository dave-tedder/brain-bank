# Briefing exception paths

Two blocks lifted out of `SKILL.md` because they fire on a minority of runs. Read
the relevant one when its condition holds; otherwise ignore this file.

- **"An MCP looks missing"** — read section 1 before writing any diagnosis.
- **"I am about to create an intake"** — read section 2 before setting `risk` or
  `project_slug`.

---

## 1. Forbidden while diagnosing a "missing" MCP

- Do NOT run `claude mcp list`. It lists ONLY Code-registered servers and never
  lists Desktop servers. Its output is not evidence of anything.
- Do NOT read `~/.claude.json`, `claude_desktop_config.json`, or check for a
  project `.mcp.json`. Those describe **registration**. Registration is not
  **reachability**. A Desktop server is genuinely reachable from a Code session.
- Do NOT run `claude mcp add` or `claude mcp remove`. The servers are already
  live; you would duplicate working servers. A PreToolUse hook can block this
  (see `scripts/hooks/block-mcp-registration.sh`).
- Do NOT build a causal story about WHY the MCP is missing. If you catch yourself
  explaining why, that IS the tell. Stop and re-run ToolSearch.

**The rule is about the KIND of evidence, not the specific command.** No static
artifact (CLI listing, JSON config, worktree state, missing `.mcp.json`) can prove
an MCP is unavailable. Only a live call can, and only after the retries above.

This exists because the misdiagnosis recurred in two separate sessions on the
same day **while a memory note describing it was in context**, each time
reasoning confidently from a different artifact. Treat any "the MCP isn't here"
conclusion as a red flag about your own reasoning first.

---

## 2. Risk rating rubric (for any intake you create)

Risk = **BLAST RADIUS OF THE AGENT'S ACTIONS.** NOT sensitivity of the subject.

- `low` — draft-and-propose. Research -> report; content/copy drafted but never
  sent; local documentation draft; read-only verification -> report. Touches
  nothing live. Worst case: a proposal the operator rejects.
- `medium` — mutates something real but reversible.
- `high` — irreversible, public, or financial.

**CRITICAL:** scheduled OE-5 runners pass `max_risk=low` to
`claim_next_agent_task`. A task rated `medium` or `high` is INVISIBLE to every
scheduled lane. It sits in Agent Todo forever: not blocked, not failed, not
flagged, never claimed. Promoting it looks identical to queuing it and silently
does nothing. Only an attended manual claim (default `max_risk=medium`) sees it.

So: rate draft-and-propose work `low`, even when the SUBJECT feels weighty. Put
subject-matter caution in `boundaries`, which travels with the packet regardless
of the risk field. An image-sourcing task was once rated `medium` because the
topic touched copyright; the task could only ever write a proposal, and the
rating quietly made it unrunnable.

**Risk is FROZEN at intake.** No verb amends it (`admin_amend_agent_task` covers
project_slug, add_sources, operator_action, operator_target, requires_local
only). A mis-rated task must be RECREATED at the right risk and the old one
superseded via `admin_amend_agent_task` with a DO-NOT-WORK reason plus an
`add_sources` pointer. Do NOT use `block_agent_task` for this: it requires a
claimed/assigned task and would write a false AGENT BLOCKED receipt under an
agent code with no run behind it.

Also always set `project_slug` on intake. The closeout controller routes strictly
by slug and holds anything it cannot resolve.

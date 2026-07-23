# brain-bank skills

Claude Code skills shipped with brain-bank. Skills are auto-discovered when a user installs brain-bank as a plugin and when Claude Code is active in a brain-bank clone.

## Available skills

| Skill | Fires on |
|---|---|
| [`brain-bank-setup`](brain-bank-setup/SKILL.md) | Explicit `/brain-bank-setup`, or fresh-clone detection (no profile.json + no .env + no supabase link). Guides a first-time deploy end-to-end. |
| [`auto-resolve-patterns`](auto-resolve-patterns/SKILL.md) | Edits to `checkAutoResolve`, any LAYER 0/1/1.5/2/3/3.5 guard, `extractMetadata`, or either mirrored capture file. |
| [`open-engine-briefing`](open-engine-briefing/SKILL.md) | Operator asks for a briefing, "what happened on the board", "what needs me", or invokes `/open-engine-briefing`. |
| [`open-engine-critic`](open-engine-critic/SKILL.md) | Running one cross-runtime critic heartbeat: advisory review of finished Agent Review / Needs Operator tasks. |
| [`open-engine-sentinel`](open-engine-sentinel/SKILL.md) | Running the operations sentinel: runtime health, stale claims, old Standing drafts, one PASS/FAIL report. |
| [`open-engine-triage`](open-engine-triage/SKILL.md) | Running one triage heartbeat: reads open action items and creates full-packet Standing drafts on the board. |
| [`pg-cron-patterns`](pg-cron-patterns/SKILL.md) | Writing or editing a pg_cron job, especially a one-shot / cleanup / confirm-once job that needs to report a verdict a human will actually see. |
| [`queue-runner`](queue-runner/SKILL.md) | Manually running one queue-runner heartbeat against the agent task board (claim, resume, block, complete, ledger receipts). |
| [`routines-cloud-tasks`](routines-cloud-tasks/SKILL.md) | Creating, editing, or debugging the scheduled cloud routines that run the Open Engine lanes (RemoteTrigger, env vars, prompt voice, webhook triggers). |

See each skill's `SKILL.md` for the full trigger description and behavior.

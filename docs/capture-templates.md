# Capture Templates

Structured prefixes that improve metadata extraction accuracy. Use these when capturing thoughts via any channel (Slack, voice, MCP, ChatGPT, REST).

The extraction model recognizes these prefixes and maps them to the correct type and fields automatically.

## Templates

### DECISION
Record a decision with reasoning and impact.

Format: DECISION: [what you decided] because [why]. Affects [who/what].

Example: DECISION: Moving to a new scheduling tool because the old setup was taking too long to configure. Affects the whole intake flow.

Extracted as: type=observation, action_items from "affects", dates from any mentioned deadlines.

### CLIENT
Record a client interaction, preference, or note.

Format: CLIENT: [name] - [detail]. Next: [action].

Example: CLIENT: Jane Doe - wants the proposal revised with the smaller budget option. Next: send the updated quote by Friday.

Extracted as: type=person_note, people=[name], action_items from "Next:".

### IDEA
Capture a new idea with optional project link and priority.

Format: IDEA: [concept]. Related to [project]. Priority: [H/M/L].

Example: IDEA: Add voice memo transcription via Whisper. Related to Brain Bank. Priority: M.

Extracted as: type=idea, project from "Related to", priority from H/M/L.

### MEETING
Record meeting outcomes with action items.

Format: MEETING: [who] re [topic]. Decided: [x]. Action: [y] by [date].

Example: MEETING: Alex re Q3 planning. Decided: ship the smaller scope first. Action: draft the timeline by next Monday.

Extracted as: type=observation, people=[who], action_items from "Action:", dates from any mentioned dates.

## Notes

- Prefixes are case-insensitive (DECISION:, Decision:, decision: all work).
- You don't have to follow the format exactly. The prefix is the main signal.
- Plain text without a prefix still works fine. Templates just improve extraction accuracy.
- The `project` and `priority` fields are extracted from all thoughts, not just templated ones. If the model can infer a project or priority from context, it will.

## Metadata fields these templates feed

- **project**: Which project or system the thought relates to (e.g., "Brain Bank", "Gmail Bridge", a client name). Null if general.
- **priority**: "high" for urgent/time-sensitive/revenue-impacting, "low" for informational, "normal" otherwise. Null if unclear.

These fields are extracted automatically from all capture channels. No changes needed to existing workflows.

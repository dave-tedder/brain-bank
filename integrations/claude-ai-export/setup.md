# Claude.ai Memory Export to Brain Bank

Claude.ai (web and app) stores its own memory about you, but that memory is trapped inside Claude.ai. This process periodically exports those memories into Brain Bank so they're searchable across all your AI clients.

## When to Do This

Once a month, or whenever you've had a particularly productive stretch of conversations on Claude.ai. It takes about 5 minutes.

## Steps

### Step 1: Export Claude.ai Memories

1. Go to claude.ai
2. Click your profile icon (bottom left)
3. Go to Settings > Capabilities > Memory
4. Scroll through your stored memories
5. Select All or relevant memories
6. Click the export/download option (if available)

If there's no bulk export, you can ask Claude in a conversation:
> "List all of your stored memories about me. Format each one as a separate paragraph."

Copy the response.

### Step 2: Capture to Brain Bank

Option A (Slack): Paste each distinct memory as a separate message in your capture channel. One thought per message for clean metadata extraction.

Option B (Claude Code): In a Claude Code session, ask:
> "Capture the following memories to Brain Bank. Each paragraph is a separate thought. Deduplicate against what's already in the brain."

Then paste the memories. Claude Code will use the `capture_thought` MCP tool for each one. The dedup system will catch anything already captured.

Option C (Batch via REST API): If you have many memories, you can use the REST API directly:
```bash
curl -X POST "https://<your-supabase-project-ref>.supabase.co/functions/v1/open-brain-mcp/capture" \
  -H "Content-Type: application/json" \
  -H "x-brain-key: YOUR_BRAIN_KEY" \
  -d '{"content": "Your memory text here"}'
```

### Step 3: Verify

In Claude Code or Slack, search for something you just captured to confirm it landed.

## Tips

- Don't capture generic memories like "User prefers dark mode" unless they're relevant to your work/business.
- Focus on capturing: decisions you've made, preferences you've expressed, project context, people and relationships mentioned, technical choices.
- The dedup system will catch exact duplicates, but rephrased versions of the same info will get through. Skim for obvious duplicates before bulk capturing.
- Claude.ai memories and Brain Bank memories serve different purposes. Claude.ai memories shape future Claude.ai conversations. Brain Bank memories are searchable context for all AI clients. Both are useful.

## Future Improvement

Once Anthropic adds an API for Claude.ai memory export, this can be automated. For now, it's a manual periodic task. The value compounds with each export since Brain Bank gets a richer picture of your thinking over time.

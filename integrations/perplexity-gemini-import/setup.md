# Perplexity & Gemini Import to Brain Bank

Both Perplexity Pro and Google Gemini accumulate research context and memories. This process extracts the valuable signal and captures it to Brain Bank.

## Perplexity Pro

### Export

1. Go to perplexity.ai
2. Click your profile icon > Settings
3. Look for "Your Threads" or "History"
4. Perplexity doesn't have a bulk memory export like ChatGPT, so you'll need to extract manually

### Best Approach: Research Session Summaries

Instead of trying to export everything, capture the conclusions from your research sessions:

After a productive Perplexity research session, ask Perplexity:
> "Summarize the key findings, decisions, and action items from our conversation. Format each finding as a separate paragraph."

Then capture those summaries to Brain Bank via:
- Paste into your capture channel (one thought per message)
- Or paste into Claude Code and ask it to capture each one

### What to Capture

- Research conclusions (not the full thread, just the findings)
- Source references you want to remember
- Decisions made based on research
- Comparisons you found useful (e.g., tool X vs tool Y conclusions)

## Google Gemini

### Memory Export

1. Go to gemini.google.com
2. Click your profile > Settings > Extensions or Memory
3. Look for stored memories/context
4. If Gemini has a memory list, copy it

### Gems Context

If you have Gems (custom prompt chains) with accumulated context:

1. Open each relevant Gem
2. Ask: "What do you know about me and my projects? List everything as separate facts."
3. Capture the unique facts to Brain Bank

### Google Activity Export (Optional, Broader)

For a more comprehensive export:

1. Go to myactivity.google.com
2. Filter by "Gemini" or "AI"
3. This shows your interaction history
4. Skim for valuable context (decisions, research findings)

## Import to Brain Bank

For both platforms, the capture flow is the same:

**Quick (few items):** Paste each fact/finding as a separate message in your capture channel.

**Batch (many items):** In Claude Code:
> "I have research findings from Perplexity/Gemini to import into Brain Bank. Capture each paragraph as a separate thought. Deduplicate against existing content."

Then paste the content.

**Script (advanced):** Save findings to a text file (one thought per line), then:
```bash
while IFS= read -r line; do
  [ -z "$line" ] && continue
  curl -s -X POST "https://<your-supabase-project-ref>.supabase.co/functions/v1/open-brain-mcp/capture" \
    -H "Content-Type: application/json" \
    -H "x-brain-key: YOUR_BRAIN_KEY" \
    -d "$(jq -n --arg c "$line" '{content: $c}')"
  sleep 1
done < findings.txt
```

## Frequency

- After major research sessions (when you find something worth remembering)
- Monthly memory sweep (export stored memories, deduplicate, capture new ones)
- Before starting a new project phase (capture relevant research context so it's available to all AI clients)

## Tips

- Quality over quantity. Don't dump raw search results. Capture the conclusions and decisions.
- Tag the source in your capture: "From Perplexity research: ..." so you know where the finding originated.
- Expect your first export to be the largest (everything accumulated so far); subsequent exports will typically be incremental.

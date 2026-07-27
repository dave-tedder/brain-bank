# Instagram Signals Import

**Note:** if you've set up the Meta DM Scanner (`scan-prompt.md` in this directory), DM scanning is already automated. The approaches below are for content-performance capture (post analytics, engagement patterns) that the DM scanner doesn't cover.

Capture the signal from your Instagram activity into Brain Bank: what content resonates, inquiries via DMs, and engagement patterns.

## What's Worth Capturing

- **DMs with useful context**: inquiries, preferences mentioned, reference material described
- **High-performing posts**: what content gets the most engagement and why
- **Comments with useful feedback**: compliments on specific work, questions about your process
- **Content strategy notes**: what you planned to post vs what actually performed

## Current Options

Instagram's API is restrictive. There's no easy automated pipeline. Here are the practical approaches:

### Approach 1: Manual Capture (Best for Now)

When you notice something worth remembering from Instagram:
- Voice capture via Siri Shortcut: "Brain thought: got several DMs about the piece I posted yesterday. People are asking about that style more than usual."
- Your capture channel: type the observation directly
- Claude Code: "Capture to Brain Bank: the post I put up yesterday got 450 likes, 12 saves. Best performing piece this month."

### Approach 2: Weekly Instagram Review

Set a weekly reminder (or fold it into a routine before your weekly digest). Spend 5 minutes reviewing your Instagram analytics and capture the highlights:

> "This week's Instagram: the progress-shot post got 600 likes and 8 DMs asking about availability. Several new followers from a new region. The flash/reference-sheet post underperformed. Custom work outperforms flash-style posts for engagement."

One thought like this per week is more valuable than trying to capture every interaction.

### Approach 3: Scheduling-tool Export (Periodic)

If you use a social scheduling tool (Later, Buffer, Hootsuite, etc.):
1. Export your analytics from the tool (if it offers CSV/report export)
2. Have Claude Code summarize the key patterns
3. Capture the summary to Brain Bank

### Approach 4: Instagram Data Download (Quarterly)

Instagram lets you download your data:
1. Go to Instagram Settings > Your Activity > Download Your Information
2. Request a download (JSON format)
3. In Claude Code: "Parse my Instagram data export and capture the key patterns to Brain Bank. Focus on: top performing content, DM themes, frequently asked questions."

## What NOT to Capture

- Every individual like or comment (too noisy)
- Follower counts (vanity metrics, not actionable signal)
- Competitor content (capture your reaction/takeaway, not their content)
- Spam DMs

## Future Automation

If Instagram opens up their API for business accounts (Meta Business Suite API), a more automated pipeline could:
- Monitor DMs for keyword patterns and capture those threads
- Track post performance and auto-capture weekly summaries
- Flag comments with questions for follow-up

For now, the manual + weekly review approach gives you most of the value with minimal effort.

# WordPress Content Import to Brain Bank

Import your published portfolio content, blog posts, and page content from your WordPress site(s) into Brain Bank. This makes your own written content searchable by meaning across all AI clients.

This assumes you already have a WordPress MCP server connected for each site (many WordPress-MCP plugins register one server per site, e.g. `mcp__<your-site>-wp__*` tools). If you don't have one, set that up first — this doc only covers the import once the MCP connection exists.

## What Gets Imported

- Blog posts (published content, descriptions, portfolio pieces)
- Key pages (about, services, etc.)
- NOT: media files, comments, or draft content

## How to Run

In a Claude Code session, say:

> "Import my WordPress content to Brain Bank. Use the WP MCP to read published posts from my-site.com. For each post, capture the title and content as a thought. Skip drafts. Deduplicate against existing brain content."

Claude will:
1. Use `mcp__<your-site>-wp__wp_get_posts` (or your MCP server's equivalent tool) to list published posts
2. Read each post's content
3. Format as: "WordPress post from [site]: [title]\n\n[content excerpt]"
4. Capture to Brain Bank via `capture_thought` MCP tool
5. Dedup will catch any content already in the brain

If you run more than one WordPress site through Brain Bank, repeat the same pattern for each site's MCP server.

## Selective Import

If you don't want everything, be specific:

> "Import only portfolio posts from my-site.com to Brain Bank. Skip general blog posts."

Or:

> "Import the About page and Services page from my-site.com to Brain Bank."

## Ongoing Sync

For new posts going forward, you have two options:

### Option A: Manual (on publish)
After publishing a new post, drop the URL or content into your capture channel. Done.

### Option B: WordPress Hook (automated)
Add a webhook in WordPress that fires on post publish and POSTs to Brain Bank. This requires adding a small plugin or function to your WordPress site. Ask Claude Code to set this up using your WP MCP server:

> "Create a WordPress hook on my-site.com that captures new published posts to Brain Bank automatically via the REST API."

This would use your MCP server's file-write tool (e.g. `wp_plugin_put_file`) to add a small PHP file that hooks into `publish_post` and calls the Brain Bank capture endpoint.

## Why This Matters

Your portfolio descriptions, blog posts, and service pages contain your voice and expertise. When an AI client searches Brain Bank for a topic you write about publicly, it should find not just your thoughts about it, but also how you've described it publicly. This enriches the context available for communications, content creation, and business decisions.

## Note on multiple sites

If you run several WordPress sites (a personal site, a business site, a family member's site), each needs its own MCP server connection, but the same import pattern applies to each — just repeat the "How to Run" prompt with that site's MCP tool names.

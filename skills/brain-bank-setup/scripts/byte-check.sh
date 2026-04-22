#!/usr/bin/env bash
# byte-check.sh: static analysis for the brain-bank-setup skill.
#
# Usage:
#   ./byte-check.sh              # runs against ../SKILL.md (the real skill)
#   ./byte-check.sh <file.md>    # runs against a custom target (e.g., a fixture)
#
# Exit codes:
#   0  all checks pass
#   1  one or more checks failed
#
# Checks performed:
#   1. YAML frontmatter parses (via python3 yaml), when frontmatter is present.
#   2. No banned words (global CLAUDE.md list) or em dashes outside of
#      backtick-wrapped inline code.
#   3. No placeholder strings (TODO, TBD, FIXME, XXX, {{NAME}}) outside of
#      backtick-wrapped inline code.
#   4. Markdown forward-links [text](path.md) resolve to real files.
#   5. Shape-check grep patterns in the SKILL.md secrets table match their
#      known-valid example values (ensures regexes have not drifted).
#      Advisory only: emits WARN, does not set FAIL.
#
# Test fixtures:
#   scripts/test-fixtures/clean.md  expected PASS
#   scripts/test-fixtures/dirty.md  expected FAIL on checks 2, 3, 4
#
# Manual run (from brain-bank repo root):
#   ./skills/brain-bank-setup/scripts/byte-check.sh
#
# Implementation note: Python heredocs embedded in $() command substitutions
# must avoid literal backtick characters. Bash 3.2 (macOS system bash) scans
# for backtick-command-substitutions even inside quoted <<'HEREDOC' delimiters
# when the heredoc itself is inside a $() subshell. All inline-code regex
# patterns use chr(96) instead of a literal backtick for this reason.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-$SCRIPT_DIR/../SKILL.md}"

if [ ! -f "$TARGET" ]; then
  echo "FAIL: target file not found: $TARGET"
  exit 1
fi

# Resolve to absolute path for reliable use across all checks
TARGET="$(cd "$(dirname "$TARGET")" && pwd)/$(basename "$TARGET")"
TARGET_DIR="$(dirname "$TARGET")"

echo "byte-check.sh running against $TARGET"
FAIL=0

# ---------------------------------------------------------------------------
# Check 1: YAML frontmatter parses (skip when no frontmatter)
# ---------------------------------------------------------------------------
FRONTMATTER_RESULT=$(python3 - "$TARGET" <<'PYEOF'
import sys, os

filepath = sys.argv[1]
text = open(filepath, 'r', encoding='utf-8').read()
lines = text.splitlines()

if not lines or lines[0].strip() != '---':
    print("SKIP")
    sys.exit(0)

# Has frontmatter opener - check for closer and parse
try:
    import yaml
except ImportError:
    print("SKIP_NO_YAML")
    sys.exit(0)

parts = text.split('---')
if len(parts) < 3:
    print("FAIL: frontmatter missing closing ---")
    sys.exit(1)

try:
    yaml.safe_load(parts[1])
    print("OK")
except Exception as e:
    print(f"FAIL: YAML parse error: {e}")
    sys.exit(1)
PYEOF
)

case "$FRONTMATTER_RESULT" in
  SKIP*)
    ;;  # no frontmatter or no pyyaml - skip silently
  FAIL*)
    echo "FAIL: YAML frontmatter does not parse ($FRONTMATTER_RESULT)"
    FAIL=1
    ;;
esac

# ---------------------------------------------------------------------------
# Check 2: No banned words or em dashes
# Banned words (global CLAUDE.md list): inked, inking, tapestry, delve,
# delving, realm, synergy, holistic, robust. Also catches em dash (U+2014).
# Lines where the violation only appears inside backtick-wrapped inline
# code are exempt.
# Note: backticks in the regex below use chr(96) to avoid bash 3.2 parsing
# backtick-command-substitutions inside heredocs inside $().
# ---------------------------------------------------------------------------
BANNED_VIOLATIONS=$(python3 - "$TARGET" <<'PYEOF'
import re, sys

bt = chr(96)  # backtick, avoids bash 3.2 heredoc-in-$() parse issue
filepath = sys.argv[1]

word_re = re.compile(
    r'\b(inked|inking|tapestry|delve|delving|realm|synergy|holistic|robust)\b',
    re.IGNORECASE
)
em_dash_re = re.compile(r'\u2014')
inline_code_re = re.compile(bt + r'[^' + bt + r']*' + bt)

violations = []
with open(filepath, 'r', encoding='utf-8') as f:
    for lineno, line in enumerate(f, 1):
        stripped = line.rstrip('\n')
        # Em dash: always a violation
        if em_dash_re.search(stripped):
            violations.append(f"{lineno}: {stripped}")
            continue
        # Word match: exempt if the word only appears in inline code
        if word_re.search(stripped):
            prose = inline_code_re.sub('', stripped)
            if word_re.search(prose):
                violations.append(f"{lineno}: {stripped}")

for v in violations:
    print(v)
PYEOF
)

if [ -n "$BANNED_VIOLATIONS" ]; then
  echo "FAIL check2: banned word or em dash found:"
  echo "$BANNED_VIOLATIONS" | head -5
  FAIL=1
fi

# ---------------------------------------------------------------------------
# Check 3: No placeholder strings outside of inline code
# Flags: TODO, TBD, FIXME, XXX, {{ALL_CAPS}} patterns.
# Exempt when the violation only appears inside backtick-wrapped inline code.
# Note: backticks use chr(96) for the same bash 3.2 reason as Check 2.
# ---------------------------------------------------------------------------
PLACEHOLDER_VIOLATIONS=$(python3 - "$TARGET" <<'PYEOF'
import re, sys

bt = chr(96)  # backtick, avoids bash 3.2 heredoc-in-$() parse issue
filepath = sys.argv[1]

placeholder_re = re.compile(r'\b(TODO|TBD|FIXME|XXX)\b|\{\{[A-Z_]+\}\}')
inline_code_re = re.compile(bt + r'[^' + bt + r']*' + bt)

violations = []
with open(filepath, 'r', encoding='utf-8') as f:
    for lineno, line in enumerate(f, 1):
        stripped = line.rstrip('\n')
        if not placeholder_re.search(stripped):
            continue
        prose = inline_code_re.sub('', stripped)
        if placeholder_re.search(prose):
            violations.append(f"{lineno}: {stripped}")

for v in violations:
    print(v)
PYEOF
)

if [ -n "$PLACEHOLDER_VIOLATIONS" ]; then
  echo "FAIL check3: placeholder string found outside backtick-wrapped inline code:"
  echo "$PLACEHOLDER_VIOLATIONS" | head -5
  FAIL=1
fi

# ---------------------------------------------------------------------------
# Check 4: Markdown forward-links [text](path.md) resolve to real files.
# Only checks .md relative links. Skips http(s):// and anchor-only (#) links.
# ---------------------------------------------------------------------------
LINK_VIOLATIONS=$(python3 - "$TARGET" "$TARGET_DIR" <<'PYEOF'
import re, os, sys

filepath = sys.argv[1]
target_dir = sys.argv[2]

link_re = re.compile(r'\[[^\]]*\]\(([^)]+)\)')
http_re = re.compile(r'^https?://')

violations = []
with open(filepath, 'r', encoding='utf-8') as f:
    for lineno, line in enumerate(f, 1):
        for m in link_re.finditer(line):
            href = m.group(1)
            href_no_frag = href.split('#')[0]
            if not href_no_frag:
                continue
            if http_re.match(href_no_frag):
                continue
            if not href_no_frag.endswith('.md'):
                continue
            resolved = os.path.normpath(os.path.join(target_dir, href_no_frag))
            if not os.path.isfile(resolved):
                violations.append(
                    f"{lineno}: broken link '{href}' (resolved: {resolved})"
                )

for v in violations:
    print(v)
PYEOF
)

if [ -n "$LINK_VIOLATIONS" ]; then
  echo "FAIL check4: broken forward-link(s) found:"
  echo "$LINK_VIOLATIONS" | head -5
  FAIL=1
fi

# ---------------------------------------------------------------------------
# Check 5: Shape-check grep patterns in SKILL.md match known-valid examples.
# Advisory only (WARN, not FAIL). Only runs when target has the secrets table.
# Backticks in Python code use chr(96) for the same bash 3.2 reason.
# ---------------------------------------------------------------------------
if grep -q "Shape-check grep patterns" "$TARGET"; then
  SHAPE_OUTPUT=$(python3 - "$TARGET" <<'PYEOF'
import re, sys

bt = chr(96)  # backtick, avoids bash 3.2 heredoc-in-$() parse issue
filepath = sys.argv[1]

# Known-valid example values for each secret key.
# Each value must satisfy the shape regex published in SKILL.md's secrets table.
test_values = {
    "SUPABASE_URL":              "SUPABASE_URL=https://abcdefghij1234567890.supabase.co",
    "SUPABASE_SERVICE_ROLE_KEY": "SUPABASE_SERVICE_ROLE_KEY=eyJ" + ("a" * 200),
    "OPENROUTER_API_KEY":        "OPENROUTER_API_KEY=sk-or-" + ("a" * 30),
    "MCP_ACCESS_KEY":            "MCP_ACCESS_KEY=" + ("a" * 64),
    "SLACK_BOT_TOKEN":           "SLACK_BOT_TOKEN=xoxb-" + ("a" * 50),
    "SLACK_SIGNING_SECRET":      "SLACK_SIGNING_SECRET=" + ("a" * 32),
}

text = open(filepath, 'r', encoding='utf-8').read()
lines = text.splitlines()

warnings = []
for key, test_val in test_values.items():
    # Locate the table row for this key: a line containing `^KEY=
    pattern_str = None
    search = bt + "^" + key + "="
    for line in lines:
        if search in line:
            # Extract the regex between the backticks: `^KEY=...<end-backtick>
            m = re.search(
                bt + r'(\^' + re.escape(key) + r'[^' + bt + r']*)' + bt,
                line
            )
            if m:
                pattern_str = m.group(1)
                break
    if pattern_str is None:
        warnings.append(f"WARN check5: no shape pattern found for {key}")
        continue
    try:
        if not re.search(pattern_str, test_val):
            warnings.append(
                "WARN check5: pattern for " + key + " does not match known-valid example\n"
                "  pattern : " + pattern_str + "\n"
                "  example : " + test_val[:60] + "..."
            )
    except re.error as e:
        warnings.append(f"WARN check5: pattern for {key} is invalid regex: {e}")

if warnings:
    for w in warnings:
        print(w)
else:
    print("check5: all shape patterns match known-valid examples")
PYEOF
)
  echo "$SHAPE_OUTPUT"
fi

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
if [ "$FAIL" -eq 0 ]; then
  echo "PASS: all checks"
  exit 0
else
  echo "FAIL: one or more checks failed (see above)"
  exit 1
fi

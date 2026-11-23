#!/usr/bin/env python3
"""Mint the route snapshot publisher's PostgREST token (loop-closing Task 5.4).

Produces an HS256 JWT whose role claim is `closeout_route_publisher` (see
supabase/migrations/20261120b_closeout_routes.sql), signed with the project's
legacy JWT secret, which you paste at a hidden prompt. That role can EXECUTE
public.publish_closeout_routes and nothing else. Nothing secret is printed and
nothing goes to the clipboard: the token lands in a mode-600 file,
~/.config/brain-bank/route-publisher-jwt, and the anon key you paste at the
second prompt lands next to it as route-publisher-apikey. Both are read by
scripts/open-engine/publish-route-snapshot.mjs.

Same approach and reasons as scripts/loop-closing/mint-sentinel-read-jwt.py:
files, not the macOS Keychain (its tty prompt silently keeps 128 characters of a
~230-character JWT), and never the secret on a command line.

Run it in your own terminal:
    python3 scripts/open-engine/mint-route-publisher-jwt.py
The project ref for the token's `ref` claim comes from BRAIN_BANK_PROJECT_REF,
or from the host of BB_MCP_URL. Rotate by running it again; the files are
replaced in place. Revoke by dropping the role's EXECUTE grant (or the role).
"""
import base64, getpass, hashlib, hmac, json, os, sys, time
from urllib.parse import urlparse

STORE = os.path.join(os.path.expanduser("~"), ".config", "brain-bank")
ROLE = "closeout_route_publisher"
VALID_DAYS = 365


def b64(x: bytes) -> str:
    return base64.urlsafe_b64encode(x).rstrip(b"=").decode()


def project_ref() -> str:
    ref = os.environ.get("BRAIN_BANK_PROJECT_REF", "").strip()
    if ref:
        return ref
    host = urlparse(os.environ.get("BB_MCP_URL", "")).hostname or ""
    if host.endswith(".supabase.co"):
        return host.split(".")[0]
    sys.exit("Set BRAIN_BANK_PROJECT_REF (or BB_MCP_URL) first. Nothing written.")


def file_put(name: str, value: str) -> str:
    os.makedirs(STORE, mode=0o700, exist_ok=True)
    os.chmod(STORE, 0o700)
    path = os.path.join(STORE, name)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(value + "\n")
    os.chmod(path, 0o600)
    with open(path) as f:
        back = f.read().strip()
    if back != value:
        sys.exit("read-back mismatch for %s" % path)
    return path


def main() -> None:
    ref = project_ref()
    secret = getpass.getpass("Legacy JWT secret (hidden, from Dashboard > Project Settings > JWT Keys): ").strip()
    if len(secret) < 32:
        sys.exit("That does not look like the project JWT secret (too short). Nothing written.")
    apikey = getpass.getpass("anon public API key (hidden, Dashboard > Project Settings > API Keys): ").strip()
    if not apikey.startswith("eyJ") and not apikey.startswith("sb_publishable_"):
        sys.exit("That does not look like the anon/publishable key. Nothing written.")

    now = int(time.time())
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {"iss": "supabase", "ref": ref, "role": ROLE, "sub": "open-engine-route-publisher",
               "iat": now, "exp": now + VALID_DAYS * 86400}
    signing_input = b64(json.dumps(header, separators=(",", ":")).encode()) + "." + \
        b64(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
    token = signing_input + "." + b64(sig)
    del secret

    jwt_path = file_put("route-publisher-jwt", token)
    key_path = file_put("route-publisher-apikey", apikey)
    print("Minted role=%s iat=%d exp=%d (%s UTC)." % (
        ROLE, now, payload["exp"], time.strftime("%Y-%m-%d", time.gmtime(payload["exp"]))))
    print("Token stored in %s (mode 600)." % jwt_path)
    print("anon key stored in %s (mode 600)." % key_path)
    print("Next: node scripts/open-engine/publish-route-snapshot.mjs --dry-run, then without --dry-run.")


if __name__ == "__main__":
    main()

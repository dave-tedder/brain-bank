#!/usr/bin/env python3
"""Mint the Open Engine cloud sentinel's read-only PostgREST token.

Loop-closing Task 0.2. Produces an HS256 JWT whose role claim is `sentinel_reader`
(see supabase/migrations/20261105_sentinel_reader_role.sql), signed with the
project's legacy JWT secret, which you paste at a hidden prompt. Nothing secret is
printed. The token goes to the clipboard (paste it into the cloud environment's
BRAIN_BANK_SENTINEL_READ_JWT) and into a mode-600 file,
~/.config/brain-bank/sentinel-read-jwt, so verify-sentinel-reads.sh can use it
locally. The anon key you paste at the second prompt lands next to it in
~/.config/brain-bank/sentinel-apikey (cloud env var BRAIN_BANK_SENTINEL_APIKEY).
Your Supabase project ref is read from BRAIN_BANK_PROJECT_REF, or asked for.

Why files and not the macOS Keychain: `security add-generic-password -w` with no
value reads the password from the tty through a 128-byte buffer and silently keeps
the first 128 characters. A JWT is about 230, so a Keychain store keeps a
128-character stub; the read-back check below exists to catch exactly that. Passing the value as an
argument would put it in the process list, which this project's secrets rule
forbids, so a 0600 file in a local, not cloud-synced, directory is the honest store.

Run it in your own terminal, never with the secret on the command line:
    python3 scripts/loop-closing/mint-sentinel-read-jwt.py
Rotate by running it again; the files are replaced in place.
"""
import base64, getpass, hashlib, hmac, json, os, subprocess, sys, time

STORE = os.path.join(os.path.expanduser("~"), ".config", "brain-bank")

ROLE = "sentinel_reader"
VALID_DAYS = 365

def b64(x: bytes) -> str:
    return base64.urlsafe_b64encode(x).rstrip(b"=").decode()

def file_put(name: str, value: str) -> str:
    # 0700 directory, 0600 file, written through a descriptor opened with the mode
    # already set, so there is no window where the file is wider than 0600.
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
    ref = os.environ.get("BRAIN_BANK_PROJECT_REF", "").strip() or input("Supabase project ref: ").strip()
    if not ref.isalnum():
        sys.exit("That does not look like a Supabase project ref. Nothing written.")
    secret = getpass.getpass("Legacy JWT secret (hidden, from Dashboard > Project Settings > JWT Keys): ").strip()
    if len(secret) < 32:
        sys.exit("That does not look like the project JWT secret (too short). Nothing written.")
    apikey = getpass.getpass("anon public API key (hidden, Dashboard > Project Settings > API Keys): ").strip()
    if not apikey.startswith("eyJ") and not apikey.startswith("sb_publishable_"):
        sys.exit("That does not look like the anon/publishable key. Nothing written.")

    now = int(time.time())
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {"iss": "supabase", "ref": ref, "role": ROLE, "sub": "open-engine-sentinel",
               "iat": now, "exp": now + VALID_DAYS * 86400}
    signing_input = b64(json.dumps(header, separators=(",", ":")).encode()) + "." + \
                    b64(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
    token = signing_input + "." + b64(sig)
    del secret

    jwt_path = file_put("sentinel-read-jwt", token)
    key_path = file_put("sentinel-apikey", apikey)
    subprocess.run(["pbcopy"], input=token.encode(), check=True)

    print("Minted role=%s iat=%d exp=%d (%s UTC)." % (
        ROLE, now, payload["exp"], time.strftime("%Y-%m-%d", time.gmtime(payload["exp"]))))
    print("Token copied to clipboard and stored in %s (mode 600)." % jwt_path)
    print("anon key stored in %s (mode 600)." % key_path)
    print("Paste the clipboard into your cloud environment as BRAIN_BANK_SENTINEL_READ_JWT,")
    print("then paste the anon key as BRAIN_BANK_SENTINEL_APIKEY. Clear the clipboard afterwards (pbcopy </dev/null).")

if __name__ == "__main__":
    main()

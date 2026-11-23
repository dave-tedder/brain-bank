// Who owns a disposition CSV for the length of an --apply run. A run reads the file,
// may replace it, closes items, and appends what the RPC answered. Two runs doing that
// at once can lose an acknowledged record: one plans from the old bytes, the other
// finishes, and the first replaces the file with its stale plan.
//
// Claim, then look. Each run writes its own uniquely named claim beside the file, then
// lists the claims there. Whoever writes second always sees the first, so two runs can
// never both proceed. They can both refuse, which writes nothing and is safe to retry.
// Unique names also mean recovering a dead run's claim can never remove a live one.
//
// A claim is proved stale only on this host: the process is gone, or its pid now belongs
// to a process with a different start time. Anything else, including another host, an
// unreadable claim or a start time that cannot be read, refuses and needs a person.
//
// This serializes runs that share a local directory and this code. It does not reach
// another machine's copy of the file, a file synced between machines, or an older copy
// of this tool, which takes no claim.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';

function claimPattern(path) {
  const name = basename(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${name}\\.claim\\.[0-9a-f-]{36}\\.json$`);
}

// ps renders a start time in its caller's zone and language. Pinned, so the string in a
// claim compares equal whoever wrote it and whoever reads it: launchd beside a Terminal
// would otherwise read a live owner as a dead one and delete its claim.
function processStartedAt(pid) {
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  });
  const started = result.status === 0 ? result.stdout.trim() : '';
  return started || null;
}

function holderIsGone(claim) {
  if (claim.host !== hostname() || !Number.isInteger(claim.pid) || claim.pid <= 0) return false;
  try {
    process.kill(claim.pid, 0);
  } catch (err) {
    return err.code === 'ESRCH';
  }
  const started = processStartedAt(claim.pid);
  return Boolean(claim.started_at && started && started !== claim.started_at);
}

// Either { busy: true, holders } with nothing left behind, or a held claim.
export function claimDispositionFile(path) {
  const dir = dirname(path);
  const own = join(dir, `${basename(path)}.claim.${randomUUID()}.json`);
  // Written beside it and renamed in, so a claim is only ever seen whole. A half-written
  // one would read as unreadable, refuse every later run, and need a person.
  const temp = `${own}.tmp`;
  writeFileSync(temp, JSON.stringify({
    pid: process.pid,
    host: hostname(),
    started_at: processStartedAt(process.pid),
    claimed_at: new Date().toISOString(),
  }), { flag: 'wx' });
  try {
    renameSync(temp, own);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
  const pattern = claimPattern(path);
  const holders = [];
  const recovered = [];
  for (const name of readdirSync(dir)) {
    const other = join(dir, name);
    if (!pattern.test(name) || other === own) continue;
    let claim = null;
    try {
      claim = JSON.parse(readFileSync(other, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') continue;
    }
    if (claim && holderIsGone(claim)) {
      rmSync(other, { force: true });
      recovered.push(name);
    } else {
      holders.push({ file: other, ...(claim && typeof claim === 'object' ? claim : { unreadable: true }) });
    }
  }
  if (holders.length > 0) {
    rmSync(own, { force: true });
    return { busy: true, holders };
  }
  return {
    busy: false,
    recovered,
    held: () => existsSync(own),
    release: () => rmSync(own, { force: true }),
  };
}

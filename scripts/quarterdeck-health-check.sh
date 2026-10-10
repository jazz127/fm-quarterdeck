#!/usr/bin/env bash
# Firstmate custom check: no output on health/skip, one diagnostic on failure.
set -u
umask 077
state=${FM_QUARTERDECK_HEALTH_STATE_DIR:-${FM_HOME:+$FM_HOME/state}}
if [[ -z "$state" ]]; then
  state=$(cd -- "$(dirname -- "$0")" && pwd -P)
fi
fail() { printf '%s\n' 'Quarterdeck health: check unavailable (configuration, dependency or deadline)'; }
if [[ ! -d "$state" ]] || ! command -v python3 >/dev/null || ! command -v timeout >/dev/null || ! command -v flock >/dev/null; then
  fail
  exit 0
fi
# Serialize attempts and keep all bookkeeping in the selected Firstmate state.
exec 9>"$state/fm-quarterdeck-health.lock" 2>/dev/null || { fail; exit 0; }
flock -n 9 || exit 0
source_root=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
if ! timeout 25 python3 - "$state" "$source_root/prototype/data/agent-state.json" 2>/dev/null <<'PY'
import datetime
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request

class Unhealthy(Exception):
    pass

def reject(message):
    raise Unhealthy(message)

def probe(url):
    # Never inherit an HTTP proxy for loopback/private health reads.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(url, timeout=3) as response:
            data = response.read(1024 * 1024 + 1)
            if len(data) > 1024 * 1024:
                reject('response too large')
            return json.loads(data)
    except Unhealthy:
        raise
    except Exception:
        reject('endpoint unavailable or invalid JSON')

def snapshot(base, age):
    data = probe(base + '/api/bearings')
    if not isinstance(data, dict) or data.get('schema') != 'fm-quarterdeck-call.v1':
        reject("Captain's Call snapshot not ready")
    if data.get('stale') is True or data.get('state') == 'stale':
        reject("Captain's Call snapshot stale")
    if data.get('error'):
        reject("Captain's Call snapshot error")
    # No viewers means no run yet; loading is a valid idle snapshot.
    if data.get('state') == 'loading':
        return
    if data.get('state') != 'ready':
        reject("Captain's Call snapshot not ready")
    try:
        stamp = datetime.datetime.fromisoformat(data['generatedAt'].replace('Z', '+00:00'))
        if stamp.tzinfo is None:
            raise ValueError()
        elapsed = time.time() - stamp.timestamp()
    except Exception:
        reject("Captain's Call snapshot timestamp missing or invalid")
    if elapsed < -60 or elapsed > age:
        reject("Captain's Call snapshot stale")

def preferences(setting):
    defaults = {'awayCheckInMinutes': 10, 'openNoteAlarmMinutes': 15}
    try:
        current = setting('FM_QUARTERDECK_STATE_PATH')
        legacy = setting('FM_AGENTOS_STATE_PATH')
        if current and legacy and current != legacy:
            return defaults
        owner = Path(current or legacy or sys.argv[2])
        if not owner.is_absolute():
            return defaults
        file = owner.parent / 'quarterdeck-preferences.json'
        fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd) as handle:
            import stat
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 4096:
                return defaults
            value = json.loads(handle.read(4097))
        return {key: value[key] if isinstance(value, dict) and type(value.get(key)) is int and 1 <= value[key] <= 1440 else fallback
                for key, fallback in defaults.items()}
    except Exception:
        return defaults

def inbox(setting, alarm_minutes):
    home = setting('FM_HOME')
    if not isinstance(home, str) or not Path(home).is_absolute():
        reject('inbox unavailable (explicit FM_HOME required)')
    age = alarm_minutes * 60
    # Use the guarded read interface, not private endpoint files. Bound both
    # execution and output before parsing; never print bodies or diagnostics.
    try:
        with subprocess.Popen(
                [str(Path(home) / 'bin/fm-inbox.sh'), 'receipts', '--all-pending'],
                cwd=home, env={**os.environ, 'FM_HOME': home},
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as process:
            try:
                data = bytearray()
                deadline = time.monotonic() + 3
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    while True:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0 or not selector.select(remaining):
                            raise ValueError()
                        chunk = os.read(process.stdout.fileno(), 65536)
                        if not chunk:
                            break
                        data.extend(chunk)
                        if len(data) > 1024 * 1024:
                            raise ValueError()
                if process.wait(timeout=max(0.001, deadline - time.monotonic())) != 0:
                    raise ValueError()
            finally:
                if process.poll() is None:
                    process.kill()
            receipts = json.loads(data)
        if receipts.get('schema') != 'fm-inbox-receipts.v1' or not isinstance(receipts.get('pending'), list):
            raise ValueError()
        # Only pending coverage matters here. Known handled/reply omissions
        # cannot hide an open note; unknown or malformed coverage fails closed.
        omitted = receipts.get('omitted', [])
        if not isinstance(omitted, list):
            raise ValueError()
        for omission in omitted:
            surface = omission.get('surface') if isinstance(omission, dict) else None
            if not isinstance(surface, str) or not (
                    re.fullmatch(r'(?:handled notes|replies) omitted by bound: [0-9]+', surface)
                    or re.fullmatch(r'malformed replies without a valid sequence: [0-9]+ \(.+\)', surface)):
                raise ValueError()
        overdue = []
        now = time.time()
        for note in receipts['pending']:
            note_id = note['id']
            match = re.fullmatch(r'([0-9]{1,12})(?:[-_.][A-Za-z0-9_.-]{1,100})?', note_id) if isinstance(note_id, str) else None
            if not match:
                raise ValueError()
            if now - int(match[1]) > age:
                overdue.append(note_id)
    except Exception:
        reject('inbox unavailable or invalid receipts')
    if overdue:
        ids = ', '.join(sorted(set(overdue))[:20])
        extra = max(0, len(set(overdue)) - 20)
        suffix = f' (+{extra} more; list inbox)' if extra else ''
        return f'inbox notes overdue: {ids}{suffix}; act safely, then bin/fm-inbox.sh reply <id> <text> and bin/fm-inbox.sh drain --ack <id> required'
    return None

def main():
    state = Path(sys.argv[1])
    config_path = state / 'quarterdeck-health.json'
    config = json.loads(config_path.read_text()) if config_path.exists() else {}
    def setting(key, default=''):
        return os.environ.get(key, config.get(key, default))
    saved = preferences(setting)  # Read-only, every invocation, including throttled runs.
    stamp = state / 'fm-quarterdeck-health.stamp'
    now = time.time()
    if setting('FM_QUARTERDECK_HEALTH_FORCE') != '1' and stamp.exists():
        elapsed = now - float(stamp.read_text())
        if 0 <= elapsed < saved['awayCheckInMinutes'] * 60:
            return
    stamp.write_text(str(now))  # Throttle failed attempts too; watcher wake owns recovery.
    issues = []
    try:
        message = inbox(setting, saved['openNoteAlarmMinutes'])
        if message:
            issues.append(message)
    except Unhealthy as error:
        issues.append(str(error))
    try:
        dashboard(setting)
    except Unhealthy as error:
        issues.append(str(error))
    except Exception:
        issues.append('invalid dashboard configuration or state')
    if issues:
        print('Quarterdeck health: ' + '; '.join(issues))

def dashboard(setting):
    port = str(setting('FM_QUARTERDECK_HEALTH_PORT'))
    tailnet = setting('FM_QUARTERDECK_HEALTH_URL')
    if not port or not tailnet:
        try:
            # An explicit binary wins; WSL may expose only the Windows CLI.
            binary = setting('TAILSCALE_BIN') or shutil.which('tailscale') or shutil.which('tailscale.exe') or 'tailscale'
            result = subprocess.run(
                [binary, 'serve', 'status', '--json'],
                capture_output=True, timeout=3, check=True)
            routes = []
            for host, web in json.loads(result.stdout).get('Web', {}).items():
                proxy = web.get('Handlers', {}).get('/', {}).get('Proxy', '')
                target = urllib.parse.urlsplit(proxy)
                if host.endswith(':443') and target.scheme == 'http' and target.hostname in ('127.0.0.1', 'localhost', '::1') and target.port:
                    routes.append((str(target.port), 'https://' + host[:-4]))
            if len(routes) != 1:
                raise ValueError()
            discovered_port, discovered_url = routes[0]
            port = port or discovered_port
            tailnet = tailnet or discovered_url
        except FileNotFoundError:
            # Explicit local-only configuration is valid without Tailscale.
            if not port or tailnet:
                reject('Serve route discovery unavailable or ambiguous')
        except Exception:
            reject('Serve route discovery unavailable or ambiguous')
    if not port.isdigit() or not 1 <= int(port) <= 65535:
        reject('local port not configured')
    age = int(setting('FM_QUARTERDECK_HEALTH_MAX_AGE', '900'))
    if not 1 <= age <= 86400:
        reject('snapshot age limit invalid')
    local = 'http://127.0.0.1:' + port
    health = probe(local + '/api/health')
    if not isinstance(health, dict) or health.get('ok') is not True:
        reject('local server unhealthy')
    snapshot(local, age)
    if tailnet:
        url = urllib.parse.urlsplit(tailnet)
        if url.scheme != 'https' or not url.hostname or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
            reject('private HTTPS origin invalid')
        health = probe(tailnet.rstrip('/') + '/api/health')
        if not isinstance(health, dict) or health.get('ok') is not True:
            reject('private HTTPS server unhealthy')
        snapshot(tailnet.rstrip('/'), age)

try:
    main()
except Unhealthy as error:
    print('Quarterdeck health: ' + str(error))
except Exception:
    print('Quarterdeck health: invalid configuration or state')
PY
then
  fail
fi
exit 0

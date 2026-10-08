"""Entry point for the always-on LAN / WAN web service.

Started from the Windows logon Run entry with pythonw.exe, so there is no console
window; output is appended to .data/lan-server.log instead. Use --allow-hosts to
whitelist additional names, for example a DDNS domain used from the internet.
"""
import argparse
import os
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))

parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
parser.add_argument('--allow-hosts', default='')
known, rest = parser.parse_known_args()
extra = [name.strip() for name in known.allow_hosts.split(',') if name.strip()]
if extra:
    existing = [name.strip() for name in (os.environ.get('CAIDAN_ALLOWED_HOSTS') or '').split(',') if name.strip()]
    os.environ['CAIDAN_ALLOWED_HOSTS'] = ','.join(existing + extra)
sys.argv = [sys.argv[0], *rest]

from server.app import main

if __name__ == '__main__':
    data = Path(os.environ.get('CAIDAN_DATA') or root / '.data')
    data.mkdir(parents=True, exist_ok=True)
    log = open(data / 'lan-server.log', 'a', encoding='utf-8', buffering=1)
    sys.stdout = sys.stderr = log
    main()

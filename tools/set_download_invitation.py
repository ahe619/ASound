"""Rotate the website-only invitation; OSS itself remains publicly readable.

python tools/set_download_invitation.py --generate
Without --generate, prompts privately for the owner's chosen code.
The generated/chosen code is saved in ignored build/download-invitation.txt.
Publish the changed packs.json to activate it; previous approvals then expire.
"""
import argparse
import getpass
import hashlib
import json
from pathlib import Path
import secrets


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--generate', action='store_true')
    args = parser.parse_args()
    code = ('SOUNDOA-' + secrets.token_hex(6).upper()) if args.generate else getpass.getpass('New invitation code: ').strip().upper()
    if not 12 <= len(code) <= 128 or not code.isascii() or not all(c.isalnum() or c == '-' for c in code):
        raise SystemExit('Use 12-128 ASCII letters, numbers or hyphens.')
    root = Path(__file__).resolve().parent.parent
    catalog = root / 'app/packs.json'
    data = json.loads(catalog.read_text(encoding='utf-8'))
    if not data.get('aliyunDownload'):
        raise SystemExit('Configure aliyunDownload before setting its invitation.')
    data['aliyunDownload']['codeSha256'] = hashlib.sha256(code.encode()).hexdigest()
    secret = root / 'build/download-invitation.txt'
    secret.parent.mkdir(parents=True, exist_ok=True)
    secret.write_text(code + '\n', encoding='utf-8')
    catalog.write_text(json.dumps(data, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print('Invitation saved to build/download-invitation.txt. Publish the updated packs.json to activate it.')


if __name__ == '__main__':
    main()

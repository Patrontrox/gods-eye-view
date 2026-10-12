#!/usr/bin/env python3
"""Digitally sign a PDF using pyHanko's embedded PDF signature support.

Requires: pip install pyHanko, a valid private key and matching X.509 certificate.
pyHanko signs the PDF itself, unlike sign-pdf.mjs (detached audit receipts).
Certificate trust, revocation, time stamping and production PAdES validation
are deployment responsibilities. Never share private keys with the browser.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
from pathlib import Path


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('source', type=Path)
    p.add_argument('destination', type=Path)
    p.add_argument('--key', type=Path, required=True)
    p.add_argument('--cert', type=Path, required=True)
    p.add_argument('--field', default='GEVSignature')
    args = p.parse_args()
    if args.source.resolve() == args.destination.resolve():
        p.error('Refusing to overwrite original PDF')
    if not args.source.is_file() or not args.key.is_file() or not args.cert.is_file():
        p.error('PDF, private key and X.509 certificate must already exist')
    if args.source.stat().st_size > 30 * 1024 * 1024 or args.source.read_bytes()[:5] != b'%PDF-':
        p.error('Expected PDF smaller than 30 MiB')
    executable = shutil.which('pyhanko')
    if not executable:
        p.error('pyHanko is not installed: pip install pyHanko')
    # Use the standard pyHanko PDF embedded CMS signature flow.
    command = [executable, 'sign', 'addsig', '--field', args.field, 'pemder',
               '--key', str(args.key), '--cert', str(args.cert),
               str(args.source), str(args.destination)]
    subprocess.run(command, check=True)
    print('PDF signature embedded. Validate with: pyhanko sign validate --pretty-print FILE.pdf')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

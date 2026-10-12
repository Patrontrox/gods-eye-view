#!/usr/bin/env node
/** Usage: node sign-pdf.mjs sign file.pdf key.pem | verify file.pdf file.sig.json trusted-public.pem */
import { readFileSync, writeFileSync } from 'node:fs';
import { signReportPdf, verifyReportPdf } from './report-signature.mjs';
const [action, pdf, other, publicKey] = process.argv.slice(2);
try {
  if (action === 'sign' && pdf && other && !publicKey) {
    const receipt = signReportPdf(readFileSync(pdf), readFileSync(other));
    writeFileSync(`${pdf}.sig.json`, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(`Detached PDF signature saved: ${pdf}.sig.json`);
  } else if (action === 'verify' && pdf && other && publicKey) {
    if (!verifyReportPdf(readFileSync(pdf), JSON.parse(readFileSync(other, 'utf8')), readFileSync(publicKey))) process.exitCode = 1;
    else console.log('PDF signature verified against the trusted public key');
  } else {
    console.error('Usage: node sign-pdf.mjs sign file.pdf key.pem | verify file.pdf file.sig.json trusted-public.pem');
    process.exitCode = 2;
  }
} catch (error) { console.error(`Signing/verification error: ${error.message}`); process.exitCode = 1; }

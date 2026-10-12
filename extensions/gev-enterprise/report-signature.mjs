/** Portable, detached Ed25519 PDF signature (NOT embedded PAdES).
 * Signatures cover the exact PDF bytes, and receipts can be checked offline.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
const MAX_PDF = 30 * 1024 * 1024;
function pdfBytes(bytes) {
  const data = Buffer.from(bytes);
  if (data.byteLength < 8 || data.byteLength > MAX_PDF || data.subarray(0, 5).toString() !== '%PDF-') throw new Error('A PDF of at most 30 MiB is required');
  return data;
}
export function signReportPdf(bytes, privateKeyPem) {
  const data = pdfBytes(bytes);
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('An Ed25519 signing key is required');
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'pem' });
  const digest = createHash('sha256').update(data).digest('hex');
  return Object.freeze({ version: 1, scheme: 'Ed25519-PDF-detached-v1', sha256: digest,
    signature: sign(null, data, key).toString('base64'), publicKey: publicKey.toString(),
    signedAt: new Date().toISOString(), bytes: data.byteLength,
    note: 'Detached signature; not an embedded PDF/PAdES signature.' });
}
export function verifyReportPdf(bytes, receipt, trustedPublicKeyPem) {
  const data = pdfBytes(bytes);
  if (!receipt || receipt.scheme !== 'Ed25519-PDF-detached-v1' ||
      receipt.bytes !== data.length || !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
      createHash('sha256').update(data).digest('hex') !== receipt.sha256 ||
      typeof receipt.signature !== 'string' || receipt.signature.length > 160) return false;
  try {
    const key = createPublicKey(trustedPublicKeyPem);
    return key.asymmetricKeyType === 'ed25519' && verify(null, data, key, Buffer.from(receipt.signature, 'base64'));
  } catch { return false; }
}

/**
 * Decrypt Chromium cookie encrypted_value blobs using the DPAPI-unwrapped AES-256-GCM key.
 *
 * Chromium layout for v10/v11 cookies:
 *   [0..3)   "v10" | "v11"
 *   [3..15)  12-byte nonce/IV
 *   [15..n-16) ciphertext
 *   [n-16..n)  16-byte GCM auth tag
 * v20 uses app-bound encryption and is reported as unsupported.
 */
const fs = require('fs');
const crypto = require('crypto');

const [, , keyB64Path, cookiesJsonPath, outJsonPath] = process.argv;
if (!keyB64Path || !cookiesJsonPath || !outJsonPath) {
  console.error('usage: node decrypt_cookies.js <key.b64> <cookies.json> <out.json>');
  process.exit(2);
}

const key = Buffer.from(fs.readFileSync(keyB64Path, 'ascii').trim(), 'base64');
if (key.length !== 32) {
  console.error(`expected 32-byte key, got ${key.length}`);
  process.exit(3);
}

const rows = JSON.parse(fs.readFileSync(cookiesJsonPath, 'utf8'));
const out = [];
const stats = { v10: 0, v11: 0, v20: 0, plain: 0, empty: 0, failed: 0, unknown: [] };

for (const r of rows) {
  const enc = Buffer.from(r.enc || '', 'base64');
  let value = r.value || '';

  if (enc.length === 0) {
    stats.empty++;
  } else if (value.length > 0) {
    stats.plain++;
  } else {
    const tag = enc.subarray(0, 3).toString('latin1');
    if (tag === 'v10' || tag === 'v11') {
      try {
        const iv = enc.subarray(3, 15);
        const ct = enc.subarray(15, enc.length - 16);
        const authTag = enc.subarray(enc.length - 16);
        const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
        d.setAuthTag(authTag);
        let plain = Buffer.concat([d.update(ct), d.final()]);
        // Chrome 130+ binds cookies to their domain: plaintext = SHA256(domain)[0:32] || value
        if (plain.length > 32) {
          const maybeHash = plain.subarray(0, 32);
          const body = plain.subarray(32);
          const expect = crypto.createHash('sha256').update(r.host).digest();
          if (maybeHash.equals(expect) || body.toString('utf8').match(/^[\x20-\x7e]+$/)) {
            plain = body;
            stats.domainBound = (stats.domainBound || 0) + 1;
          }
        }
        value = plain.toString('utf8');
        stats[tag]++;
      } catch (e) {
        stats.failed++;
        value = '';
        if (stats.unknown.length < 8) stats.unknown.push(`${r.host}/${r.name}: ${e.message}`);
      }
    } else if (tag === 'v20') {
      stats.v20++;
      value = '';
    } else {
      if (stats.unknown.length < 8) {
        stats.unknown.push(`${r.host}/${r.name}: prefix=${JSON.stringify(tag)} len=${enc.length}`);
      }
    }
  }

  out.push({ ...r, value, encLen: enc.length });
}

fs.writeFileSync(outJsonPath, JSON.stringify(out, null, 1), 'utf8');

const quark = out.filter((c) => /quark|uc\.cn/i.test(c.host) && c.value);
console.log('--- decryption stats ---');
console.log(JSON.stringify(stats, null, 1));
console.log(`--- total ${out.length}, with value ${out.filter((c) => c.value).length} ---`);
console.log(`--- quark cookies with value: ${quark.length}`);
for (const c of quark) {
  console.log(`   ${c.host.padEnd(30)} ${c.name.padEnd(24)}（值已隐藏）`);
}

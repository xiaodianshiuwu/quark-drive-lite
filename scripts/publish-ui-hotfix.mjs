#!/usr/bin/env node
'use strict';
/**
 * 1-command L2 Signed Frontend UI Hotfix Publisher.
 *
 * Packs the 7 allowlisted static assets under src/renderer/, verifies JS syntax,
 * and publishes them to qdl-hub (/api/admin/runtime/ui-hotfix), where the server
 * writes the deterministic JSON bundle to /downloads/ and signs it with Ed25519
 * inside /api/v1/updates/latest.
 *
 * Usage:
 *   HUB_DEPLOY_TOKEN=... node scripts/publish-ui-hotfix.mjs \
 *     --version 1.3.0-ui.1 \
 *     --min 1.3.0 --max 1.3.99 \
 *     --changelog "修复目录详情负缓存与界面细节"
 *
 * Options:
 *   --url <hubUrl>        Default: https://qdl.xiaodianshiuwu.space (or QDL_HUB_URL)
 *   --version <ver>       Required unless --clear is passed
 *   --min <semver>        minBinaryVersion (default: package.json version)
 *   --max <semver>        maxBinaryVersion (optional, e.g. 1.3.99)
 *   --changelog <text>    Short summary shown to users
 *   --clear               Clear active UI hotfix (revert clients to built-in UI)
 *   --dry-run             Verify & print bundle size/SHA-256 without uploading
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RENDERER_DIR = path.join(ROOT, 'src', 'renderer');
const ALLOWED_UI_FILES = [
  'index.html',
  'app.js',
  'api.js',
  'styles.css',
  'virtual-list.js',
  'tauri-bridge.js',
  'startup.html',
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--clear' || a === '--dry-run') {
      out[a.slice(2)] = true;
    } else if (a.startsWith('--') && i + 1 < argv.length) {
      out[a.slice(2)] = argv[++i];
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const baseUrl = String(args.url || process.env.QDL_HUB_URL || 'https://qdl.xiaodianshiuwu.space').replace(/\/+$/, '');
  const token = String(process.env.HUB_DEPLOY_TOKEN || '').trim();

  if (args.clear) {
    if (!token) throw new Error('Missing HUB_DEPLOY_TOKEN environment variable');
    const res = await fetch(`${baseUrl}/api/admin/runtime/ui-hotfix`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Deploy-Token': token,
      },
      body: JSON.stringify({ clear: true }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    console.log('[publish-ui-hotfix] Cleared active UI hotfix on', baseUrl);
    return;
  }

  const version = String(args.version || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(version)) {
    throw new Error('Pass a valid --version (e.g. --version 1.3.0-ui.1)');
  }
  const minBinaryVersion = String(args.min || pkg.version).trim();
  const maxBinaryVersion = args.max ? String(args.max).trim() : '';
  const changelog = String(args.changelog || '').trim();

  // Verify JS syntax of every bundled JS file before publishing
  for (const name of ALLOWED_UI_FILES) {
    if (!name.endsWith('.js')) continue;
    const fp = path.join(RENDERER_DIR, name);
    if (fs.existsSync(fp)) {
      execFileSync(process.execPath, ['--check', fp], { stdio: 'inherit' });
    }
  }

  const files = {};
  let totalRaw = 0;
  for (const name of ALLOWED_UI_FILES) {
    const fp = path.join(RENDERER_DIR, name);
    if (!fs.existsSync(fp)) continue;
    const content = fs.readFileSync(fp, 'utf8');
    files[name] = content;
    totalRaw += Buffer.byteLength(content, 'utf8');
  }
  if (!files['index.html'] || !files['app.js']) {
    throw new Error('Missing core renderer files (index.html / app.js)');
  }

  const payload = {
    version,
    minBinaryVersion,
    ...(maxBinaryVersion ? { maxBinaryVersion } : {}),
    changelog,
    files,
  };
  const previewBuf = Buffer.from(
    JSON.stringify({ version, minBinaryVersion, ...(maxBinaryVersion ? { maxBinaryVersion } : {}), files }),
    'utf8'
  );
  const sha = crypto.createHash('sha256').update(previewBuf).digest('hex');
  console.log(
    `[publish-ui-hotfix] Prepared ${version} (${Object.keys(files).length} files, ${(totalRaw / 1024).toFixed(1)} KB raw, bundle SHA-256 ${sha.slice(0, 16)}…)`
  );

  if (args['dry-run']) {
    console.log('[publish-ui-hotfix] Dry run complete.');
    return;
  }
  if (!token) {
    throw new Error('Missing HUB_DEPLOY_TOKEN environment variable (or pass --dry-run)');
  }

  const res = await fetch(`${baseUrl}/api/admin/runtime/ui-hotfix`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Deploy-Token': token,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  console.log('[publish-ui-hotfix] Published & Ed25519-signed:', JSON.stringify(data.uiHotfix, null, 2));
}

main().catch((err) => {
  console.error('[publish-ui-hotfix] ERROR:', err.message || err);
  process.exit(1);
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mode = process.argv[2];
if (mode !== 'stage' && mode !== 'activate') {
  throw new Error('Expected stage or activate.');
}

const token = process.env.HUB_DEPLOY_TOKEN?.trim();
const rawHubUrl = process.env.HUB_URL?.trim();
if (!token || !rawHubUrl) {
  console.log('HUB_DEPLOY_TOKEN or HUB_URL not configured; skipping Hub deployment.');
  process.exit(0);
}

const hub = new URL(rawHubUrl);
if (hub.protocol !== 'https:' || hub.username || hub.password ||
  hub.pathname !== '/' || hub.search || hub.hash) {
  throw new Error('HUB_URL must be an HTTPS origin.');
}

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const prefix = `QuarkDriveLite-${version}-`;
const packages = [
  ['macos-arm64', 'macOS-arm64.zip'],
  ['macos-x64', 'macOS-x64.zip'],
  ['windows-x64-setup', 'Windows-x64-Setup.exe'],
  ['windows-x64-portable', 'Windows-x64-Portable.zip'],
  ['linux-x64-deb', 'Linux-x64.deb'],
].map(([key, suffix]) => {
  const filename = prefix + suffix;
  const contents = readFileSync(resolve('all-artifacts', filename));
  if (!contents.length) throw new Error(`Empty Hub package: ${filename}`);
  const sha256 = createHash('sha256').update(contents).digest('hex');
  return { key, filename, contents, sha256 };
});

const release = {
  version,
  channel: process.env.CHANNEL || 'stable',
  releaseDate: new Date().toISOString().slice(0, 10),
  changelog: readFileSync('hub-changelog.txt', 'utf8').trim(),
  ...(process.env.MIN_VERSION?.trim() ? { minVersion: process.env.MIN_VERSION.trim() } : {}),
};

async function request(route, { method = 'GET', contentType, body } = {}) {
  const headers = { 'X-Hub-Deploy-Token': token };
  if (contentType) headers['Content-Type'] = contentType;
  const response = await fetch(new URL(route, hub), {
    method,
    headers,
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Hub ${method} failed with HTTP ${response.status}.`);
  const result = await response.json();
  if (!result.ok) throw new Error(`Hub rejected a ${method} request.`);
  return result;
}

async function writeRelease(isLatest) {
  await request('/api/admin/releases', {
    method: 'POST',
    contentType: 'application/json',
    body: JSON.stringify({ ...release, isLatest }),
  });
}

function assertPackageMatches(actual, expected) {
  if (actual?.filename !== expected.filename ||
    actual.size !== expected.contents.length || actual.sha256 !== expected.sha256) {
    throw new Error(`Hub package metadata mismatch: ${expected.filename}`);
  }
}

function assertComplete(record) {
  if (!record) throw new Error('Hub release was not staged.');
  const assets = JSON.parse(record.assets_json);
  for (const expected of packages) assertPackageMatches(assets[expected.key], expected);
}

const { releases } = await request('/api/admin/releases');
const existing = releases.find((entry) => entry.version === version);
if (mode === 'activate') {
  assertComplete(existing);
  if (existing.is_latest !== 1) {
    await writeRelease(true);
    const live = await request('/api/admin/releases');
    const active = live.releases.find((entry) => entry.version === version && entry.is_latest === 1);
    assertComplete(active);
  }
  console.log(`Hub release v${version} is active with all five packages.`);
} else if (existing?.is_latest === 1) {
  assertComplete(existing);
  console.log(`Hub release v${version} is already active with matching packages.`);
} else {
  // Older Hub servers fall back to the newest row when no active baseline exists.
  if (!releases.some((entry) => entry.is_latest === 1)) {
    throw new Error('Hub needs an active release or maintenance entry before staging.');
  }
  await writeRelease(false);
  for (const expected of packages) {
    const query = new URLSearchParams({ filename: expected.filename, assetKey: expected.key, version });
    const receipt = await request(`/api/admin/releases/upload?${query}`, {
      method: 'POST',
      contentType: 'application/octet-stream',
      body: expected.contents,
    });
    assertPackageMatches(receipt, expected);
  }
  const staged = await request('/api/admin/releases');
  const record = staged.releases.find((entry) => entry.version === version && entry.is_latest === 0);
  assertComplete(record);
  console.log(`Hub release v${version} is staged and all five packages match.`);
}

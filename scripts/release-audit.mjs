// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('='.repeat(70));
console.log('DeepSeek StreamArchive — Chrome Release Audit');
console.log('='.repeat(70));

let failures = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  [PASS] ${message}`);
  } else {
    console.error(`  [FAIL] ${message}`);
    failures++;
  }
}

// 1. Read package.json
const pkgPath = path.join(rootDir, 'package.json');
assert(fs.existsSync(pkgPath), 'package.json exists');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
console.log(`Package: ${pkg.name} v${pkg.version}`);

// 2. Read manifest.json in .output/chrome-mv3
const manifestPath = path.join(rootDir, '.output', 'chrome-mv3', 'manifest.json');
assert(fs.existsSync(manifestPath), '.output/chrome-mv3/manifest.json exists');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

console.log('\n--- Manifest Integrity Checks ---');
assert(manifest.manifest_version === 3, 'Manifest version is 3');
assert(manifest.name === 'DeepSeek StreamArchive', 'Extension name matches exact branding');
assert(manifest.version === pkg.version, `Manifest version (${manifest.version}) matches package.json (${pkg.version})`);
assert(manifest.minimum_chrome_version === '114', `minimum_chrome_version is declared as '114' (got '${manifest.minimum_chrome_version}')`);
assert(manifest.homepage_url === 'https://github.com/MalenkiySolovey/deepseek-stream-archive', 'homepage_url points to official repository');

const allowedPermissions = new Set(['storage', 'sidePanel']);
const manifestPermissions = new Set(manifest.permissions || []);
assert(
  manifestPermissions.size === allowedPermissions.size &&
  [...manifestPermissions].every(p => allowedPermissions.has(p)),
  `Permissions strictly match ['storage', 'sidePanel'] (found: ${JSON.stringify(manifest.permissions)})`
);

const forbiddenPermissions = [
  '<all_urls>',
  'tabs',
  'activeTab',
  'cookies',
  'webRequest',
  'webRequestBlocking',
  'debugger',
  'history',
  'downloads',
  'scripting',
  'declarativeNetRequest',
  'management',
  'nativeMessaging',
  'geolocation',
  'notifications',
  'proxy',
  'topSites'
];

for (const fp of forbiddenPermissions) {
  assert(!manifestPermissions.has(fp), `Forbidden permission '${fp}' is not present`);
}

const allowedHostPermissions = ['https://chat.deepseek.com/*'];
const hostPermissions = manifest.host_permissions || [];
assert(
  hostPermissions.length === 1 && hostPermissions[0] === allowedHostPermissions[0],
  `host_permissions strictly restricted to ['https://chat.deepseek.com/*'] (found: ${JSON.stringify(hostPermissions)})`
);

// 3. Scan bundle code for security invariants
console.log('\n--- Bundle Security Invariant Checks ---');

function getAllFiles(dir, exts = ['.js']) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results = results.concat(getAllFiles(fullPath, exts));
    } else if (exts.some(ext => file.endsWith(ext))) {
      results.push(fullPath);
    }
  }
  return results;
}

const outputDir = path.join(rootDir, '.output', 'chrome-mv3');
const jsFiles = getAllFiles(outputDir, ['.js']);
assert(jsFiles.length > 0, `Compiled JavaScript files exist in .output/chrome-mv3 (${jsFiles.length} files found)`);

for (const filePath of jsFiles) {
  const relPath = path.relative(outputDir, filePath);
  const content = fs.readFileSync(filePath, 'utf8');

  // Eval / new Function checks
  assert(!content.includes('eval(') && !content.includes('eval ('), `No eval() in ${relPath}`);
  assert(!content.includes('new Function('), `No new Function() in ${relPath}`);

  // Remote code loading
  assert(!/<script[^>]+src=["']https?:\/\//i.test(content), `No remote script tag injections in ${relPath}`);
  assert(!/import\s*\(\s*["']https?:\/\//i.test(content), `No remote module imports in ${relPath}`);
  assert(!/new\s+Worker\s*\(\s*["']https?:\/\//i.test(content), `No remote worker instantiation in ${relPath}`);

  // Credential scraping / harvesting
  assert(!content.includes('document.cookie'), `No document.cookie access in ${relPath}`);
  assert(!content.includes('localStorage.getItem("userToken")') && !content.includes("localStorage.getItem('userToken')"), `No userToken scraping in ${relPath}`);
  assert(!/["']Bearer\s+["']\s*\+/i.test(content), `No Bearer token synthesis/extraction in ${relPath}`);

  // Injected/content script specific DOM & React invariants
  if (relPath.startsWith('content-scripts')) {
    assert(!content.includes('innerHTML'), `No innerHTML in content script ${relPath}`);
    assert(!content.includes('outerHTML'), `No outerHTML in content script ${relPath}`);
    assert(!content.includes('insertAdjacentHTML'), `No insertAdjacentHTML in content script ${relPath}`);
    assert(!content.includes('__reactFiber'), `No __reactFiber internal probing in content script ${relPath}`);
    assert(!content.includes('__reactProps'), `No __reactProps internal probing in content script ${relPath}`);
  }
}

// 4. Inspect release ZIP
console.log('\n--- Release ZIP Archive Audit ---');
const zipFileName = `deepseek-stream-archive-${pkg.version}-chrome.zip`;
const zipPath = path.join(rootDir, '.output', zipFileName);

assert(fs.existsSync(zipPath), `Release ZIP package exists at .output/${zipFileName}`);

if (fs.existsSync(zipPath)) {
  const zipBuffer = fs.readFileSync(zipPath);
  const zipSize = zipBuffer.length;
  const hash = crypto.createHash('sha256').update(zipBuffer).digest('hex');

  console.log(`  Package size: ${(zipSize / 1024).toFixed(2)} KB (${zipSize} bytes)`);
  console.log(`  Package SHA-256: ${hash}`);

  // Read Central Directory of the ZIP
  let endRecordOffset = -1;
  for (let i = zipBuffer.length - 22; i >= 0; i--) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      endRecordOffset = i;
      break;
    }
  }

  assert(endRecordOffset !== -1, 'ZIP central directory structure is valid');

  if (endRecordOffset !== -1) {
    const entryCount = zipBuffer.readUInt16LE(endRecordOffset + 10);
    const cdOffset = zipBuffer.readUInt32LE(endRecordOffset + 16);
    let cur = cdOffset;
    const entries = [];

    for (let i = 0; i < entryCount; i++) {
      if (zipBuffer.readUInt32LE(cur) !== 0x02014b50) break;
      const nameLen = zipBuffer.readUInt16LE(cur + 28);
      const extraLen = zipBuffer.readUInt16LE(cur + 30);
      const commentLen = zipBuffer.readUInt16LE(cur + 32);
      const filename = zipBuffer.toString('utf8', cur + 46, cur + 46 + nameLen);
      entries.push(filename);
      cur += 46 + nameLen + extraLen + commentLen;
    }

    console.log(`  Found ${entries.length} entries in ZIP`);

    const forbiddenExtensions = ['.ts', '.tsx', '.svelte', '.map', '.env', '.DS_Store', '.log'];
    const forbiddenDirs = ['node_modules/', 'tests/', '.git/', '.github/', 'src/', 'e2e/'];

    for (const entry of entries) {
      for (const ext of forbiddenExtensions) {
        assert(!entry.endsWith(ext), `ZIP entry '${entry}' does not have dev extension '${ext}'`);
      }
      for (const dir of forbiddenDirs) {
        assert(!entry.startsWith(dir), `ZIP entry '${entry}' is not inside dev directory '${dir}'`);
      }
    }

    const requiredEntries = [
      'manifest.json',
      'background.js',
      'sidepanel.html',
      'content-scripts/content.js',
      'content-scripts/interceptor.js',
      'icons/icon-16.png',
      'icons/icon-48.png',
      'icons/icon-128.png'
    ];

    for (const req of requiredEntries) {
      assert(entries.includes(req), `ZIP contains essential artifact '${req}'`);
    }
  }
}

console.log('\n' + '='.repeat(70));
if (failures === 0) {
  console.log('AUDIT RESULT: PASSED (0 failures). Release candidate is store-ready.');
  console.log('='.repeat(70));
  process.exit(0);
} else {
  console.error(`AUDIT RESULT: FAILED (${failures} failures detected).`);
  console.log('='.repeat(70));
  process.exit(1);
}

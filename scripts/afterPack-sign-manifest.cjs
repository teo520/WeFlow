#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MANIFEST_NAME = '.wf_manifest.json';
const SIGNATURE_NAME = '.wf_manifest.sig';
const MODULE_FILENAME = {
  win32: 'wcdb_api.dll',
  darwin: 'wcdb_api.dylib',
  linux: 'wcdb_api.so',
};

function readTextIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function loadEnvFile(projectDir, fileName) {
  const envPath = path.join(projectDir, fileName);
  const content = readTextIfExists(envPath);
  if (!content) return false;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
  return true;
}

function ensureSigningEnv() {
  const projectDir = process.cwd();
  if (!process.env.WF_SIGN_PRIVATE_KEY) {
    loadEnvFile(projectDir, '.env.local');
    loadEnvFile(projectDir, '.env');
  }

  const keyB64 = (process.env.WF_SIGN_PRIVATE_KEY || '').trim();
  const required = (process.env.WF_SIGNING_REQUIRED || '').trim() === '1';
  if (!keyB64) {
    if (required) {
      throw new Error(
        'WF_SIGN_PRIVATE_KEY is missing (WF_SIGNING_REQUIRED=1). ' +
          'Set it in CI Secret or .env.local for local build.',
      );
    }
    return null;
  }
  return keyB64;
}

function getPlatform(context) {
  return (
    context?.electronPlatformName ||
    context?.packager?.platform?.name ||
    process.platform
  );
}

function getProductFilename(context) {
  return (
    context?.packager?.appInfo?.productFilename ||
    context?.packager?.config?.productName ||
    'WeFlow'
  );
}

function getResourcesDir(appOutDir) {
  if (appOutDir.endsWith('.app')) {
    return path.join(appOutDir, 'Contents', 'Resources');
  }
  return path.join(appOutDir, 'resources');
}

function normalizeRel(baseDir, filePath) {
  return path.relative(baseDir, filePath).split(path.sep).join('/');
}

function sha256FileHex(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function findFirstExisting(paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

function findExecutablePath({ appOutDir, platform, productFilename, executableName }) {
  if (platform === 'win32') {
    return findFirstExisting([
      path.join(appOutDir, `${productFilename}.exe`),
      path.join(appOutDir, `${executableName || ''}.exe`),
    ]);
  }

  if (platform === 'darwin') {
    const macOsDir = path.join(appOutDir, 'Contents', 'MacOS');
    const preferred = findFirstExisting([path.join(macOsDir, productFilename)]);
    if (preferred) return preferred;
    if (!fs.existsSync(macOsDir)) return null;
    const files = fs
      .readdirSync(macOsDir)
      .map((name) => path.join(macOsDir, name))
      .filter((p) => fs.statSync(p).isFile());
    return files[0] || null;
  }

  return findFirstExisting([
    path.join(appOutDir, executableName || ''),
    path.join(appOutDir, productFilename),
    path.join(appOutDir, productFilename.toLowerCase()),
  ]);
}

function findByBasenameRecursive(rootDir, basename) {
  if (!fs.existsSync(rootDir)) return null;
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase() === basename.toLowerCase()) {
        return full;
      }
    }
  }
  return null;
}

function getModulePath(resourcesDir, appOutDir, platform) {
  const filename = MODULE_FILENAME[platform] || MODULE_FILENAME[process.platform];
  if (!filename) return null;

  const direct = findFirstExisting([
    path.join(resourcesDir, 'resources', filename),
    path.join(resourcesDir, filename),
  ]);
  if (direct) return direct;

  const inResources = findByBasenameRecursive(resourcesDir, filename);
  if (inResources) return inResources;

  return findByBasenameRecursive(appOutDir, filename);
}

function signDetachedEd25519(payloadUtf8, privateKeyDerB64) {
  const privateKeyDer = Buffer.from(privateKeyDerB64, 'base64');
  const keyObject = crypto.createPrivateKey({
    key: privateKeyDer,
    format: 'der',
    type: 'pkcs8',
  });
  return crypto.sign(null, Buffer.from(payloadUtf8, 'utf8'), keyObject);
}

module.exports = async function afterPack(context) {
  const privateKeyDerB64 = ensureSigningEnv();
  if (!privateKeyDerB64) {
    console.log('[wf-sign] skip: WF_SIGN_PRIVATE_KEY not provided and signing not required.');
    return;
  }

  const appOutDir = context?.appOutDir;
  if (!appOutDir || !fs.existsSync(appOutDir)) {
    throw new Error(`[wf-sign] invalid appOutDir: ${String(appOutDir)}`);
  }

  const platform = String(getPlatform(context)).toLowerCase();
  const productFilename = getProductFilename(context);
  const executableName = context?.packager?.config?.linux?.executableName || '';
  const resourcesDir = getResourcesDir(appOutDir);
  if (!fs.existsSync(resourcesDir)) {
    throw new Error(`[wf-sign] resources directory not found: ${resourcesDir}`);
  }

  const exePath = findExecutablePath({
    appOutDir,
    platform,
    productFilename,
    executableName,
  });
  if (!exePath) {
    throw new Error(
      `[wf-sign] executable not found. platform=${platform}, appOutDir=${appOutDir}, productFilename=${productFilename}`,
    );
  }

  const modulePath = getModulePath(resourcesDir, appOutDir, platform);
  if (!modulePath) {
    throw new Error(
      `[wf-sign] ${MODULE_FILENAME[platform] || 'wcdb_api'} not found under resources: ${resourcesDir}`,
    );
  }

  const manifest = {
    schema: 1,
    platform,
    version: context?.packager?.appInfo?.version || '',
    generatedAt: new Date().toISOString(),
    targets: [
      {
        id: 'exe',
        path: normalizeRel(resourcesDir, exePath),
        sha256: sha256FileHex(exePath),
      },
      {
        id: 'module',
        path: normalizeRel(resourcesDir, modulePath),
        sha256: sha256FileHex(modulePath),
      },
    ],
  };

  const payload = `${JSON.stringify(manifest, null, 2)}\n`;
  const signature = signDetachedEd25519(payload, privateKeyDerB64).toString('base64');

  const manifestPath = path.join(resourcesDir, MANIFEST_NAME);
  const signaturePath = path.join(resourcesDir, SIGNATURE_NAME);
  fs.writeFileSync(manifestPath, payload, 'utf8');
  fs.writeFileSync(signaturePath, `${signature}\n`, 'utf8');

  console.log(`[wf-sign] manifest: ${manifestPath}`);
  console.log(`[wf-sign] signature: ${signaturePath}`);
  console.log(`[wf-sign] exe: ${manifest.targets[0].path}`);
  console.log(`[wf-sign] exe.sha256: ${manifest.targets[0].sha256}`);
  console.log(`[wf-sign] module: ${manifest.targets[1].path}`);
  console.log(`[wf-sign] module.sha256: ${manifest.targets[1].sha256}`);
};

#!/usr/bin/env node
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import {
  basename,
  extname,
  join,
  relative,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const arguments_ = process.argv.slice(2);
const sourceCheckout = arguments_.includes('--source-checkout');
const unknownArguments = arguments_.filter(
  (argument) => argument !== '--source-checkout',
);
if (unknownArguments.length > 0) {
  console.error(
    `Unknown public-export scan option(s): ${unknownArguments.join(', ')}`,
  );
  process.exit(2);
}
const allowGitMetadata = process.env.LATTICE_ALLOW_GIT_METADATA === '1';
const forbiddenDirectories = new Set([
  '.codex',
  '.git',
  '.lattice',
  '.cache',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'tmp',
  'temp',
]);
const generatedCheckoutDirectories = new Set([
  '.cache',
  '.git',
  '.lattice',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'tmp',
  'temp',
]);
const forbiddenPrivateFiles = new Set([
  '.env',
  '.npmrc',
  'auth.json',
  'config.toml',
  'credentials.json',
  'hooks.json',
  'lattice.config.json',
]);
const forbiddenArtifactExtensions = new Set([
  '.db',
  '.har',
  '.jsonl',
  '.log',
  '.sqlite',
  '.sqlite3',
  '.tgz',
  '.zip',
]);
const rawArtifactName =
  /(?:^|[-_.])(conversation|recording|session-dump|transcript|raw-telemetry|request-payload|response-payload)(?:[-_.]|$)/i;
const rawFields = [
  'prompt',
  'system_prompt',
  'transcript',
  'conversation',
  'tool_payload',
  'mcp_payload',
  'injected_context',
  'authorization',
  'cookie',
  'api_key',
  'access_token',
  'refresh_token',
  'billing',
  'session_id',
];
const textExtensions = new Set([
  '',
  '.cff',
  '.csv',
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.sha256',
  '.toml',
  '.ts',
  '.txt',
  '.yaml',
  '.yml',
]);
const structuredExtensions = new Set(['.json', '.jsonl', '.yaml', '.yml']);
const implementationVocabularyRoots = [
  'src/',
  'tests/',
];
const implementationVocabularyFiles = new Set([
  'scripts/scan-public-export.mjs',
]);
const syntheticWindowsUserPath = 'C:/' + 'Users/example';
const syntheticUnixUserSubpath = '/' + 'Users/example';
const privateLegacyProjectName = 'lit' + 'ter';
const syntheticBenchmarkEmail = 'lattice@' + 'example.invalid';
const syntheticTestEmail = 'tests@' + 'example.invalid';
const syntheticEmailAllowlist = new Map([
  ['src/benchmark.ts', new Set([syntheticBenchmarkEmail])],
  ['tests/helpers.ts', new Set([syntheticTestEmail])],
]);
const publicContactEmail = 'ptech1500@' + 'gmail.com';
const reviewedPublicEmailAllowlist = new Map([
  ['CODE_OF_CONDUCT.md', new Set([publicContactEmail])],
  ['README.md', new Set([publicContactEmail])],
  ['SUPPORT.md', new Set([publicContactEmail])],
]);
const syntheticPathAllowlist = new Map([
  [
    'tests/mcp-server.test.ts',
    new Set([syntheticWindowsUserPath, syntheticUnixUserSubpath]),
  ],
]);
const structuredFieldAllowlist = new Map([
  [
    'package-lock.json',
    new Set(['cookie']),
  ],
]);

const findings = [];
const exemptions = new Map();
const manifest = [];
let textFiles = 0;
let binaryFiles = 0;

function normalized(path) {
  return relative(root, path).replaceAll('\\', '/');
}

function addFinding(category, path, detail) {
  findings.push({ category, path, detail });
}

function addExemption(path, detail) {
  const entries = exemptions.get(path) ?? new Set();
  entries.add(detail);
  exemptions.set(path, entries);
}

function implementationVocabularyAllowed(path) {
  return (
    implementationVocabularyFiles.has(path) ||
    implementationVocabularyRoots.some((prefix) => path.startsWith(prefix))
  );
}

function inspectStructuredKeys(value, path) {
  if (Array.isArray(value)) {
    value.forEach((entry) => inspectStructuredKeys(entry, path));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (rawFields.includes(key.toLowerCase())) {
      if (structuredFieldAllowlist.get(path)?.has(key.toLowerCase())) {
        addExemption(path, `dependency name in package lock: ${key}`);
      } else {
        addFinding('raw-structured-field', path, `forbidden key: ${key}`);
      }
    }
    inspectStructuredKeys(entry, path);
  }
}

function scanText(path, value) {
  if (value.toLowerCase().includes(privateLegacyProjectName)) {
    addFinding(
      'private-project-reference',
      path,
      'legacy private project name',
    );
  }

  const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  for (const match of value.matchAll(emailPattern)) {
    if (syntheticEmailAllowlist.get(path)?.has(match[0].toLowerCase())) {
      addExemption(path, `synthetic reserved-domain email: ${match[0]}`);
    } else if (reviewedPublicEmailAllowlist.get(path)?.has(match[0].toLowerCase())) {
      addExemption(path, `owner-authorized public contact email: ${match[0]}`);
    } else {
      addFinding('email-address', path, 'email address');
    }
  }

  const phonePatterns = [
    /\+\d(?:[ .()-]*\d){7,14}\b/g,
    /\(\d{3}\)[ -]?\d{3}[ -]?\d{4}\b/g,
  ];
  for (const pattern of phonePatterns) {
    if (pattern.test(value)) addFinding('phone-number', path, 'phone-like value');
  }

  const actualPersonalPaths = [
    /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`]+(?:[\\/][^\s"'`]*)?/gi,
    new RegExp('/' + 'Users/' + "[^/\\s\"']+(?:/[^\\s\"']*)?", 'gi'),
    new RegExp('/' + 'home/' + "[^/\\s\"']+(?:/[^\\s\"']*)?", 'gi'),
  ];
  for (const pattern of actualPersonalPaths) {
    for (const match of value.matchAll(pattern)) {
      const allowed = syntheticPathAllowlist.get(path)?.has(match[0]);
      if (allowed) {
        addExemption(path, `synthetic personal-path fixture: ${match[0]}`);
      } else {
        addFinding('personal-absolute-path', path, 'absolute user path');
      }
    }
  }

  const secretPatterns = [
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
    ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g],
    ['openai-style-token', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
    ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
    ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
    ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
    [
      'assigned-secret',
      /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\b\s*[:=]\s*["'`][A-Za-z0-9_./+=:-]{12,}["'`]/gi,
    ],
    ['bearer-value', /\bBearer\s+[A-Za-z0-9_./+=:-]{12,}\b/gi],
  ];
  for (const [category, pattern] of secretPatterns) {
    if (pattern.test(value)) addFinding(category, path, 'credential-like value');
  }

  const serializedField = new RegExp(
    `["'](?:${rawFields.join('|')})["']\\s*:`,
    'gi',
  );
  const yamlField = new RegExp(
    `^\\s*(?:${rawFields.join('|')})\\s*:`,
    'gim',
  );
  const fieldMatches = [...value.matchAll(serializedField), ...value.matchAll(yamlField)];
  if (fieldMatches.length > 0) {
    if (implementationVocabularyAllowed(path)) {
      addExemption(
        path,
        `${fieldMatches.length} raw-field vocabulary occurrence(s) in implementation/test code`,
      );
    } else if (!structuredExtensions.has(extname(path).toLowerCase())) {
      addFinding(
        'serialized-raw-field',
        path,
        `${fieldMatches.length} raw conversation/log field occurrence(s)`,
      );
    }
  }

  if (extname(path).toLowerCase() === '.json') {
    try {
      inspectStructuredKeys(JSON.parse(value), path);
    } catch {
      addFinding('invalid-json', path, 'cannot safely inspect structured keys');
    }
  } else if (
    ['.yaml', '.yml'].includes(extname(path).toLowerCase()) &&
    fieldMatches.length > 0
  ) {
    addFinding(
      'raw-structured-field',
      path,
      `${fieldMatches.length} forbidden YAML key occurrence(s)`,
    );
  }
}

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const name = normalized(path);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      addFinding('symlink-or-junction', name, 'export must contain regular files only');
      continue;
    }
    if (entry.isDirectory()) {
      if (forbiddenDirectories.has(entry.name.toLowerCase())) {
        if (
          sourceCheckout &&
          generatedCheckoutDirectories.has(entry.name.toLowerCase())
        ) {
          addExemption(
            name,
            'generated or version-control directory in a source checkout',
          );
        } else if (entry.name === '.git' && allowGitMetadata) {
          addExemption(name, 'version-control metadata in a checked-out CI workspace');
        } else {
          addFinding('forbidden-directory', name, entry.name);
        }
        continue;
      }
      walk(path);
      continue;
    }
    if (!entry.isFile()) continue;

    const lowerBase = basename(entry.name).toLowerCase();
    const extension = extname(entry.name).toLowerCase();
    if (
      forbiddenPrivateFiles.has(lowerBase) &&
      !lowerBase.includes('.example.')
    ) {
      addFinding('private-config-file', name, entry.name);
    }
    if (forbiddenArtifactExtensions.has(extension) || rawArtifactName.test(lowerBase)) {
      addFinding('raw-or-generated-artifact', name, entry.name);
    }

    const bytes = readFileSync(path);
    manifest.push([
      name,
      bytes.length,
      createHash('sha256').update(bytes).digest('hex'),
    ]);
    if (textExtensions.has(extension)) {
      textFiles += 1;
      scanText(name, bytes.toString('utf8'));
    } else {
      binaryFiles += 1;
    }
  }
}

walk(root);
manifest.sort(([left], [right]) => left.localeCompare(right));
const exportDigest = createHash('sha256')
  .update(manifest.map((entry) => entry.join('\0')).join('\n'))
  .digest('hex');

console.log(`Public export scan root: ${basename(root)}`);
console.log(
  `Scan mode: ${sourceCheckout ? 'source checkout' : 'strict public export'}`,
);
console.log(
  `Files inspected: ${manifest.length} (${textFiles} text, ${binaryFiles} binary/name-only)`,
);
console.log(`Export manifest SHA-256: ${exportDigest}`);
if (exemptions.size > 0) {
  console.log('Reviewed narrow exemptions:');
  for (const [path, details] of [...exemptions].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`- ${path}: ${[...details].join('; ')}`);
  }
}
if (findings.length > 0) {
  console.error(`Public export scan failed (${findings.length} finding(s)):`);
  for (const finding of findings) {
    console.error(`- [${finding.category}] ${finding.path}: ${finding.detail}`);
  }
  console.error('No files were modified or deleted.');
  process.exitCode = 1;
} else {
  console.log('Public export scan passed: no blocking findings.');
  console.log('No files were modified or deleted.');
}

#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const skippedDirectories = new Set([
  '.git',
  '.lattice',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
]);
const textExtensions = new Set([
  '',
  '.cff',
  '.json',
  '.js',
  '.md',
  '.mjs',
  '.toml',
  '.ts',
  '.txt',
  '.yaml',
  '.yml',
]);
const failures = [];
let checked = 0;

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (skippedDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(path);
      continue;
    }
    if (!entry.isFile() || !textExtensions.has(extname(entry.name))) continue;

    const name = relative(root, path).replaceAll('\\', '/');
    const value = readFileSync(path, 'utf8');
    checked += 1;
    if (value.includes('\uFFFD')) failures.push(`${name}: invalid UTF-8 replacement character`);
    if (value.length > 0 && !value.endsWith('\n')) {
      failures.push(`${name}: missing final newline`);
    }
    value.split(/\r?\n/).forEach((line, index) => {
      if (/[ \t]+$/.test(line)) {
        failures.push(`${name}:${index + 1}: trailing whitespace`);
      }
    });
    if (extname(entry.name) === '.json') {
      try {
        JSON.parse(value);
      } catch {
        failures.push(`${name}: invalid JSON`);
      }
    }
  }
}

walk(root);
if (failures.length > 0) {
  console.error(`Format check failed (${failures.length} finding(s)):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log(`Format check passed: ${checked} text files checked.`);
}

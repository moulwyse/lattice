import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defineConfig} from 'vitest/config';
// Keep user settings and the known-repository list out of the real profile.
const settings=join(tmpdir(),`lattice-vitest-${process.pid}`,'settings.json');
export default defineConfig({test:{include:['tests/**/*.test.ts'],testTimeout:20000,env:{LATTICE_SETTINGS_PATH:settings}}});

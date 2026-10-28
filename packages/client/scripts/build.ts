/**
 * Builds the published package into dist/: the CLI and library bundled with
 * esbuild (including the private @via443/protocol package, which isn't
 * published; `ws` stays a dependency), plus type declarations for the library.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const root = join(import.meta.dirname, '..');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string; dependencies: Record<string, string> };

await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts', 'src/cli.ts'],
  outdir: 'dist',
  bundle: true,
  // cli.js and index.js share the tunnel code through a chunk.
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: Object.keys(pkg.dependencies),
  define: { VIA443_VERSION: JSON.stringify(pkg.version) },
  logLevel: 'warning',
});

execFileSync(join(root, '../../node_modules/.bin/tsc'), ['-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });

// Keep only the declarations the entry point reaches, with imports pointing at .d.ts siblings.
const keep = new Set<string>();
const visit = (file: string) => {
  if (keep.has(file)) return;
  keep.add(file);
  let source = readFileSync(join(dist, file), 'utf8');
  source = source.replace(/(from\s+'\.\/[\w-]+)\.ts'/g, "$1.js'");
  writeFileSync(join(dist, file), source);
  for (const [, name] of source.matchAll(/from\s+'\.\/([\w-]+)\.js'/g)) visit(`${name}.d.ts`);
};
visit('index.d.ts');
for (const file of readdirSync(dist)) {
  if (file.endsWith('.d.ts') && !keep.has(file)) rmSync(join(dist, file));
}

// Nothing published may refer to the unpublished workspace packages.
for (const file of readdirSync(dist, { recursive: true }) as string[]) {
  const path = join(dist, file);
  if (existsSync(path) && !dirname(path).endsWith('node_modules') && path.match(/\.(js|ts)$/)) {
    if (/['"]@via443\//.test(readFileSync(path, 'utf8'))) throw new Error(`dist/${file} refers to an unpublished @via443 package`);
  }
}
// npm always ships a LICENSE file from the package folder; the repo keeps one at the root.
copyFileSync(join(root, '../../LICENSE'), join(root, 'LICENSE'));
console.log(`built via443 ${pkg.version} into dist/`);

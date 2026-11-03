//  writer-node.mjs: lets a pure node suite import the writer core
//  (ui-src/writer/*.js) as it is, bare 'prosemirror-*' imports included.
//
//  Those packages are installed in scripts/node_modules (npm ci --prefix
//  scripts), which node's ESM resolver never looks in for a file under
//  ui-src/. This resolve hook answers a bare specifier that node cannot
//  find from there. esbuild resolves the same way for writer.js
//  (nodePaths in build-writer.mjs).
//
//  Usage, before the first dynamic import of the core:
//    import { importWriter } from './lib/writer-node.mjs';
//    const core = await importWriter('parse.js', 'serialize.js');
import * as nodeModule from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scripts = join(here, '..');
export const writerDir = join(scripts, '..', 'ui-src', 'writer');

//  a bare specifier node cannot find from the importing file is resolved
//  again as if scripts/package.json imported it, with the same import
//  conditions, so the packages' ESM builds load
const from = pathToFileURL(join(scripts, 'package.json')).href;
const bare = (spec) => /^[a-z@][\w@./-]*$/i.test(spec) && !spec.startsWith('node:');
if (nodeModule.registerHooks) {
  nodeModule.registerHooks({
    resolve(spec, ctx, next) {
      try { return next(spec, ctx); } catch (e) {
        if (bare(spec)) return next(spec, { ...ctx, parentURL: from });
        throw e;
      }
    },
  });
} else {
  const hook = `export async function resolve(spec, ctx, next) {
    try { return await next(spec, ctx); } catch (e) {
      if (/^[a-z@][\\w@./-]*$/i.test(spec) && !spec.startsWith('node:')) return next(spec, { ...ctx, parentURL: ${JSON.stringify(from)} });
      throw e;
    }
  }`;
  nodeModule.register('data:text/javascript,' + encodeURIComponent(hook));
}

//  the named core modules, merged into one namespace object
export async function importWriter(...files) {
  const mods = await Promise.all(files.map((f) => import(pathToFileURL(join(writerDir, f)).href)));
  return Object.assign({}, ...mods);
}

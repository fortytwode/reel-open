import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const root=path.dirname(fileURLToPath(import.meta.url));
const outfile=path.join(root,'local-ai/build/transformers.bundle.mjs');
const result=await build({
  entryPoints:[path.join(root,'local-ai/transformers-entry.mjs')],
  outfile,bundle:true,format:'esm',platform:'browser',target:'chrome120',
  metafile:true,write:false,logLevel:'warning',
});
const output=result.outputFiles.find(file=>file.path===outfile);
assert.ok(output,'Bundled Transformers worker runtime was not produced.');
const imports=result.metafile.outputs[path.relative(root,outfile).replaceAll(path.sep,'/')].imports;
assert.deepEqual(imports,[],`Worker bundle has unresolved external imports: ${imports.map(item=>item.path).join(', ')}`);
await mkdir(path.dirname(outfile),{recursive:true});
await writeFile(outfile,output.contents);
process.stdout.write(`LOCAL_AI_BUNDLE_OK ${output.contents.byteLength}\n`);

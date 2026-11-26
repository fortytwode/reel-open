import assert from 'node:assert/strict';
import {startAssetServer} from '../src/asset-server.mjs';

const root=process.argv[2];
assert.ok(root,'Supply the extracted resources/app directory.');
const server=await startAssetServer({root});
try{
  const paths=[
    ['/',1],['/renderer.mjs',100],['/preload.cjs',100],['/worker.mjs',500],
    ['/transformers.web.min.js',400_000],['/ort-wasm-simd-threaded.mjs',1_000],
    ['/ort-wasm-simd-threaded.wasm',1_000_000],['/whisper-languages.js',1_000],
  ];
  let packagedWorker='';
  for(const [asset,minBytes] of paths){
    const response=await fetch(server.localAIOrigin+asset);
    assert.equal(response.status,200,asset);
    if(asset==='/worker.mjs')packagedWorker=await response.clone().text();
    let bytes=0;
    for await(const chunk of response.body)bytes+=chunk.byteLength;
    assert.ok(bytes>=minBytes,`Packaged local inference asset is truncated: ${asset}`);
    process.stdout.write(`PACKAGE_ASSET_OK ${asset} ${bytes}\n`);
  }
  assert.match(packagedWorker,/onnx-community\/whisper-large-v3-turbo/);
  assert.match(packagedWorker,/360ebcde2559d60bb474678be3c1de9ef347d01a/);
  process.stdout.write('PACKAGE_LOCAL_AI_PREFLIGHT_OK\n');
}finally{
  await server.close();
}

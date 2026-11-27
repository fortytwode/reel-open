import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

// Packages preserve the repo's desktop-windows/ and web/ sibling layout.
// No generic file serving or HTTP mutations.
export async function startAssetServer({root=fileURLToPath(new URL('../../',import.meta.url))}={}) {
  const repoRoot=path.resolve(root);
  const asset=relative=>pathToFileURL(path.resolve(repoRoot,relative));
  const files=new Map([
    ['/',asset('desktop-windows/ui/index.html')],
    ['/setup.css',asset('desktop-windows/ui/setup.css')],
    ['/setup.mjs',asset('desktop-windows/ui/setup.mjs')],
    ['/capture/',asset('desktop-windows/capture/index.html')],
    ['/capture/renderer.mjs',asset('desktop-windows/capture/renderer.mjs')],
    ...['capture.js','core.js','whisper-languages.js','audio.js','encoder-worker.js','fmp4.js'].map(name=>
      [`/web/reel/${name}`,asset(`web/reel/${name}`)]),
    ['/web/vendor/mp4-muxer.mjs',asset('web/vendor/mp4-muxer.mjs')]
  ]);
  let origin;
  const server=createServer(async(request,response)=>{
    const send=(code,body,type='text/plain; charset=utf-8')=>{
      response.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':"default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'; connect-src 'none'; media-src 'self' blob:; img-src 'self' blob:; frame-ancestors 'none'",
        'Cross-Origin-Resource-Policy':'same-origin'});response.end(body);
    };
    if(request.headers.host!==origin?.slice(7)) return send(403,'Unexpected host');
    if(request.method!=='GET') return send(405,'Method not allowed');
    let url;
    try { url=new URL(request.url,origin); } catch { return send(400,'Invalid request'); }
    if(url.origin!==origin || url.username || url.password) return send(403,'Unexpected origin');
    const file=files.get(url.pathname);
    if(!file) return send(404,'Not found');
    try {
      const content=await readFile(file);
      const type=file.pathname.endsWith('.html')?'text/html; charset=utf-8':file.pathname.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8';
      send(200,content,type);
    } catch { send(500,'Reel assets are unavailable.'); }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  origin=`http://127.0.0.1:${server.address().port}`;
  const localFiles=new Map([
    ['/','desktop-windows/local-ai/index.html'],['/renderer.mjs','desktop-windows/local-ai/renderer.mjs'],['/preload.cjs','desktop-windows/local-ai/preload.cjs'],
    ['/worker.mjs','desktop-windows/local-ai/worker.mjs'],['/transformers.bundle.mjs','desktop-windows/local-ai/build/transformers.bundle.mjs'],
    ['/ort-wasm-simd-threaded.mjs','desktop-windows/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs'],
    ['/ort-wasm-simd-threaded.wasm','desktop-windows/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm'],
    ['/whisper-languages.js','web/reel/whisper-languages.js'],
    ['/model-pinning.mjs','desktop-windows/local-ai/model-pinning.mjs'],
    ['/transformers.LICENSE','desktop-windows/local-ai/TRANSFORMERS-LICENSE'],
  ].map(([path,file])=>[path,asset(file)]));
  let localAIOrigin;
  const localServer=createServer(async(request,response)=>{
    const send=(code,body,type='text/plain; charset=utf-8')=>{
      response.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://huggingface.co https://us.aws.cdn.hf.co https://us.gcp.cdn.hf.co; img-src 'self'; frame-ancestors 'none'",
        'Cross-Origin-Resource-Policy':'same-origin'});response.end(body);
    };
    if(request.headers.host!==localAIOrigin?.slice(7))return send(403,'Unexpected host');
    if(request.method!=='GET')return send(405,'Method not allowed');
    let url;try{url=new URL(request.url,localAIOrigin);}catch{return send(400,'Invalid request');}
    if(url.origin!==localAIOrigin||url.username||url.password)return send(403,'Unexpected origin');
    const file=localFiles.get(url.pathname);if(!file)return send(404,'Not found');
    try{const content=await readFile(file);const type=file.pathname.endsWith('.html')?'text/html; charset=utf-8':file.pathname.endsWith('.wasm')?'application/wasm':file.pathname.endsWith('.LICENSE')?'text/plain; charset=utf-8':'text/javascript; charset=utf-8';send(200,content,type);}
    catch{send(500,'Local transcription assets are unavailable.');}
  });
  await new Promise((resolve,reject)=>{localServer.once('error',reject);localServer.listen(0,'127.0.0.1',resolve);});
  localAIOrigin=`http://127.0.0.1:${localServer.address().port}`;
  const close=async()=>{await Promise.all([server,localServer].map(item=>new Promise((resolve,reject)=>item.close(error=>error?reject(error):resolve()))));};
  return {origin,localAIOrigin,close};
}

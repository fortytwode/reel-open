import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';

const files=new Map([
  ['/',new URL('../ui/index.html',import.meta.url)],
  ['/setup.css',new URL('../ui/setup.css',import.meta.url)],
  ['/setup.mjs',new URL('../ui/setup.mjs',import.meta.url)],
  ['/capture/',new URL('../capture/index.html',import.meta.url)],
  ['/capture/renderer.mjs',new URL('../capture/renderer.mjs',import.meta.url)],
  ...['capture.js','core.js','whisper-languages.js','audio.js','encoder-worker.js','fmp4.js'].map(name=>
    [`/web/reel/${name}`,new URL(`../../web/reel/${name}`,import.meta.url)]),
  ['/web/vendor/mp4-muxer.mjs',new URL('../../web/vendor/mp4-muxer.mjs',import.meta.url)]
]);
// Packages preserve the repo's desktop-windows/ and web/ sibling layout.
// No generic file serving or HTTP mutations.
export async function startAssetServer() {
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
    ['/','../local-ai/index.html'],['/renderer.mjs','../local-ai/renderer.mjs'],['/preload.cjs','../local-ai/preload.cjs'],
    ['/worker.mjs','../local-ai/worker.mjs'],['/transformers.web.min.js','../node_modules/@huggingface/transformers/dist/transformers.web.min.js'],
    ['/ort-wasm-simd-threaded.mjs','../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs'],
    ['/ort-wasm-simd-threaded.wasm','../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm'],
    ['/whisper-languages.js','../../web/reel/whisper-languages.js'],
    ['/transformers.LICENSE','../local-ai/TRANSFORMERS-LICENSE'],
  ].map(([path,file])=>[path,new URL(file,import.meta.url)]));
  let localAIOrigin;
  const localServer=createServer(async(request,response)=>{
    const send=(code,body,type='text/plain; charset=utf-8')=>{
      response.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://huggingface.co https://cdn-lfs.huggingface.co https://cas-bridge.xethub.hf.co; img-src 'self'; frame-ancestors 'none'",
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

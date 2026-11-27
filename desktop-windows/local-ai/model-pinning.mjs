export const MODEL_ID='onnx-community/whisper-large-v3-turbo';
export const MODEL_REVISION='360ebcde2559d60bb474678be3c1de9ef347d01a';
export const MODEL_PATH=`/${MODEL_ID}/resolve/${MODEL_REVISION}/`;
export const MODEL_FILES=new Set(['added_tokens.json','config.json','generation_config.json','merges.txt','normalizer.json',
  'onnx/decoder_model_merged_quantized.onnx','onnx/encoder_model_quantized.onnx','preprocessor_config.json',
  'quantize_config.json','special_tokens_map.json','tokenizer.json','tokenizer_config.json','vocab.json']);

export const SUMMARY_MODEL_ID='Xenova/flan-t5-small';
export const SUMMARY_MODEL_REVISION='311454e83bc784267fd7eef5940ee854144abbec';
export const SUMMARY_MODEL_PATH=`/${SUMMARY_MODEL_ID}/resolve/${SUMMARY_MODEL_REVISION}/`;
export const SUMMARY_MODEL_FILES=new Set(['config.json','generation_config.json','onnx/decoder_model_merged_quantized.onnx',
  'onnx/encoder_model_quantized.onnx','quantize_config.json','special_tokens_map.json','spiece.model','tokenizer.json','tokenizer_config.json']);

export const PINNED_MODELS=Object.freeze([
  Object.freeze({id:MODEL_ID,revision:MODEL_REVISION,path:MODEL_PATH,files:MODEL_FILES}),
  Object.freeze({id:SUMMARY_MODEL_ID,revision:SUMMARY_MODEL_REVISION,path:SUMMARY_MODEL_PATH,files:SUMMARY_MODEL_FILES}),
]);

export function modelForRequestPath(pathname){
  for(const model of PINNED_MODELS){
    const mainPrefix=`/${model.id}/resolve/main/`;
    const pinnedPrefix=model.path;
    if(pathname.startsWith(mainPrefix)||pathname.startsWith(pinnedPrefix)){
      const prefix=pathname.startsWith(mainPrefix)?mainPrefix:pinnedPrefix;
      return {model,file:pathname.slice(prefix.length),isMain:prefix===mainPrefix};
    }
  }
  return null;
}

export function modelForCachePath(url){
  if(url.hostname!=='huggingface.co'||url.protocol!=='https:'||url.port!==''||url.username||url.password||url.hash)return null;
  for(const model of PINNED_MODELS){
    const prefix=`/api/resolve-cache/models/${model.id}/${model.revision}/`;
    if(!url.pathname.startsWith(prefix))continue;
    const file=url.pathname.slice(prefix.length);
    if(!model.files.has(file))return null;
    const entries=[...url.searchParams],originalPath=`${model.path}${file}`;
    const cachePath=`/${model.id}/resolve/${model.revision}/${file}`;
    const encodedOriginal=`/${model.id}/resolve/${model.revision}/${file}`;
    const hasOriginal=entries.some(([key,value])=>decodeURIComponent(key)===encodedOriginal&&value==='');
    if(entries.length===2&&hasOriginal&&entries.some(([key,value])=>key==='etag'&&/^"?[a-f0-9]{40}"?$/iu.test(value)))
      return {model,file,cachePath,originalPath};
    return null;
  }
  return null;
}

/** Paths are fixed, and the exact signed URL is still admitted only after an allowed Hub redirect. */
export const MODEL_CDN_PATHS=new Set([
  '/xet-bridge-us/66fbc1d373c445b0a3a6acfe/8a2747c40e92b6856b7aaccfff90d0342d9fbd4aa095c7d1dc637da59662cdce',
  '/xet-bridge-us/66fbc1d373c445b0a3a6acfe/2e276de9ccae304a023b1022703be08500c0eb96b7b999e725eebd0af1572f6c',
  '/xet-bridge-us/645181169d916c596e3490a6/e7463c1c6b7c46ae0de79b004f3d7318bf4307ef0bef4de3be2e38ae80fab160',
  '/xet-bridge-us/645181169d916c596e3490a6/25d2f732f698950e8807e07a20bafe057fb7dd69a291e36c81455ca861998d9b',
  '/xet-bridge-us/645181169d916c596e3490a6/366214183dbf2b2c76e4158b6fd6886de2de269d756c5b9857375c9ca9021608',
]);

/** Pin only Transformers.js's known unpinned metadata/config probes. */
export function pinModelRequest(input,init){
  const isRequest=typeof Request!=='undefined'&&input instanceof Request;
  const method=(init?.method??(isRequest?input.method:'GET')).toUpperCase();
  if(method!=='GET')return input;
  let request;
  try{request=isRequest?new Request(input,init):new Request(input,init);}catch{return input;}
  const url=new URL(request.url),match=modelForRequestPath(url.pathname);
  if(url.protocol!=='https:'||url.hostname!=='huggingface.co'||url.port!==''||url.username||url.password||url.hash
    ||url.search||!match?.isMain||!match.model.files.has(match.file))return input;
  url.pathname=`${match.model.path}${match.file}`;
  return new Request(url,request);
}

export function withPinnedModelFetch(fetchImpl,{cacheStorage=globalThis.caches,cacheName='transformers-cache'}={}){
  if(typeof fetchImpl!=='function')throw TypeError('A fetch implementation is required.');
  return async(input,init)=>{
    const pinned=pinModelRequest(input,init);
    if(pinned!==input&&cacheStorage&&typeof cacheStorage.open==='function'){
      try{
        const cache=await cacheStorage.open(cacheName),cached=await cache.match(pinned);
        if(cached)return cached;
      }catch{}
    }
    return fetchImpl(pinned,init);
  };
}

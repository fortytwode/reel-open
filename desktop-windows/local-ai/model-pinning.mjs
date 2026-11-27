export const MODEL_ID='onnx-community/whisper-large-v3-turbo';
export const MODEL_REVISION='360ebcde2559d60bb474678be3c1de9ef347d01a';
export const MODEL_PATH=`/${MODEL_ID}/resolve/${MODEL_REVISION}/`;
export const MODEL_FILES=new Set(['added_tokens.json','config.json','generation_config.json','merges.txt','normalizer.json',
  'onnx/decoder_model_merged_quantized.onnx','onnx/encoder_model_quantized.onnx','preprocessor_config.json',
  'quantize_config.json','special_tokens_map.json','tokenizer.json','tokenizer_config.json','vocab.json']);

export const SUMMARY_MODEL_ID='onnx-community/t5-cnn-25k-ONNX';
export const SUMMARY_MODEL_REVISION='c8ac103cd6b1937ba0f6c5d4bcc9eb18d8e19c95';
export const SUMMARY_MODEL_PATH=`/${SUMMARY_MODEL_ID}/resolve/${SUMMARY_MODEL_REVISION}/`;
export const SUMMARY_MODEL_FILES=new Set(['config.json','generation_config.json','onnx/decoder_model_merged_quantized.onnx',
  'onnx/encoder_model_quantized.onnx','spiece.model','tokenizer.json','tokenizer_config.json']);
export const SUMMARY_TOKENIZER_MODEL_ID='google-t5/t5-small';
export const SUMMARY_TOKENIZER_REVISION='df1b051c49625cf57a3d0d8d3863ed4d13564fe4';
export const SUMMARY_TOKENIZER_PATH=`/${SUMMARY_TOKENIZER_MODEL_ID}/resolve/${SUMMARY_TOKENIZER_REVISION}/`;
export const SUMMARY_TOKENIZER_FILES=new Set(['spiece.model','tokenizer.json','tokenizer_config.json']);

export const PINNED_MODELS=Object.freeze([
  Object.freeze({id:MODEL_ID,revision:MODEL_REVISION,path:MODEL_PATH,files:MODEL_FILES}),
  Object.freeze({id:SUMMARY_MODEL_ID,revision:SUMMARY_MODEL_REVISION,path:SUMMARY_MODEL_PATH,files:SUMMARY_MODEL_FILES}),
  Object.freeze({id:SUMMARY_TOKENIZER_MODEL_ID,revision:SUMMARY_TOKENIZER_REVISION,path:SUMMARY_TOKENIZER_PATH,files:SUMMARY_TOKENIZER_FILES}),
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
  '/xet-bridge-us/6aad31d90f859544e744ef1d/fa8a8c26eeb7e447f7cb065a019723dc082760099351540b7812bad7633fbc6f',
  '/xet-bridge-us/6aad31d90f859544e744ef1d/79da1e37ca464b964c942b66507b1387f904f32533b90a332260ca8201af9c88',
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
    ||url.search||!match||!match.model.files.has(match.file))return input;
  const summaryTokenizerAlias=match.model.id===SUMMARY_MODEL_ID&&SUMMARY_TOKENIZER_FILES.has(match.file);
  if(!match.isMain&&!summaryTokenizerAlias)return input;
  const model=summaryTokenizerAlias
    ?{path:SUMMARY_TOKENIZER_PATH}:match.model;
  url.pathname=`${model.path}${match.file}`;
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
        const url=new URL(pinned.url),tokenizerPrefix=`${SUMMARY_TOKENIZER_PATH}`;
        if(url.hostname==='huggingface.co'&&url.pathname.startsWith(tokenizerPrefix)){
          const file=url.pathname.slice(tokenizerPrefix.length);
          if(SUMMARY_MODEL_FILES.has(file)){
            const summaryCacheURL=`https://huggingface.co${SUMMARY_MODEL_PATH}${file}`;
            const summaryCached=await cache.match(summaryCacheURL);
            if(summaryCached)return summaryCached;
          }
        }
      }catch{}
    }
    return fetchImpl(pinned,init);
  };
}

/** Diagnostic-only projection. Never attach response bodies, headers or arbitrary
 * object keys. Unknown words/codes are withheld rather than trusting redaction. */
export interface ProviderErrorDetails {
 providerHttpStatus?:number;
 providerErrorCode?:string;
 providerErrorMessage?:string;
 providerSdkErrorName?:string;
 providerSdkErrorCode?:string;
}
const words=new Set(('a allowed an and are as at available availability bad be between boarding book booking cannot class coach code date day days departure destination does end error exist failed failure for format from given has in invalid is it journey limit maximum minimum no not of on only origin pair parameter please point quota railway request requested required reservation reserved restricted route same section selected service short sorry source specified station stations supported the these this time to train travel try unavailable unsupported use valid validation was with wrong').split(' '));
const codes=new Set(['SECTION_NOT_BOOKABLE','BOOKING_SECTION_RESTRICTED','INVALID_REQUEST','BAD_REQUEST','INVALID_STATION_PAIR','INVALID_STATION','INVALID_DATE','INVALID_TRAIN','INVALID_CLASS','INVALID_QUOTA','BOOKING_NOT_ALLOWED','BOOKING_UNSUPPORTED','UNSUPPORTED_CLASS','VALIDATION_ERROR','TRAIN_NOT_FOUND','STATION_NOT_FOUND','E_VALIDATION','ERR_BAD_REQUEST','ERR_INVALID_ARG_VALUE','ETIMEDOUT','ECONNRESET','ENOTFOUND']);
const names=new Set(['Error','TypeError','RangeError','SyntaxError','TimeoutError','AbortError','AxiosError','RailKitError']);
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'?v as Record<string,unknown>:{};
export function safeProviderErrorMessage(value:unknown):string|undefined {
 if(typeof value!=='string'||!value.trim())return undefined;
 if(value.length>16384)return '[redacted]';
 let text=value;
 for(const [key,secret] of Object.entries(process.env))if(/key|token|secret|password|credential|authorization|cookie/i.test(key)&&secret)text=text.split(secret).join('[redacted]');
 text=text.replace(/https?:\/\/\S+|\b(?:Bearer|Basic)\s+\S+|\b(?:authorization|api[-_ ]?key|token|secret|password|cookie)\s*[:=]\s*[^\r\n]+/gi,'[redacted]');
 text=text.replace(/[^\s.,:;!?()]+/g,token=>words.has(token.toLowerCase())?token:'[redacted]').replace(/\s+/g,' ').trim();
 if(text.length<=240)return text;
 const prefix=text.slice(0,237);return prefix.slice(0,prefix.lastIndexOf(' ')).trimEnd()+'...';
}
export function safeProviderErrorDetails(value:unknown,httpStatus?:number):ProviderErrorDetails {
 const v=object(value),saved=object(v.transportEvidence),response=object(v.response),data=object(response.data),error=object(v.error),nested=object(v.data);
 const candidates=[saved,v,error,data,object(data.error),nested,object(nested.error)];
 const status=[httpStatus,...candidates.flatMap(o=>[o.providerHttpStatus,o.statusCode,o.status]),response.status].find(s=>typeof s==='number'&&Number.isInteger(s)&&s>=100&&s<=599) as number|undefined;
 const code=candidates.flatMap(o=>[o.providerErrorCode,o.errorCode,o.code]).find(c=>typeof c==='string'&&codes.has(c)) as string|undefined;
 const message=candidates.flatMap(o=>[o.providerErrorMessage,o.error,o.providerMessage,o.message]).find(m=>typeof m==='string'&&m.length>0);
 const sdkName=[saved.providerSdkErrorName,v.providerSdkErrorName,value instanceof Error?v.name:undefined].find(n=>typeof n==='string'&&names.has(n)) as string|undefined;
 const sdkCode=[saved.providerSdkErrorCode,v.providerSdkErrorCode,value instanceof Error?v.code:undefined].find(c=>typeof c==='string'&&codes.has(c)) as string|undefined;
 return {...(status===undefined?{}:{providerHttpStatus:status}),...(code?{providerErrorCode:code}:{}),...(message?{providerErrorMessage:safeProviderErrorMessage(message)}:{}),...(sdkName?{providerSdkErrorName:sdkName}:{}),...(sdkCode?{providerSdkErrorCode:sdkCode}:{})};
}

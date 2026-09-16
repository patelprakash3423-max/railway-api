import {redact} from './errors.js';
export type SearchLogger=(record:Record<string,unknown>)=>void;
export const jsonLogger:SearchLogger=record=>console.log(redact(JSON.stringify(record)));

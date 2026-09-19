import {isIP} from 'node:net';
import type {ClientIdentityMode} from '../config/hardening.js';

export type ClientIdentityClass =
 'ANONYMOUS_LOCAL'|'ANONYMOUS_DIRECT'|'UNTRUSTED_PROXY'|'UNKNOWN_PEER'|'DIRECT_PEER'|'INTERNAL_CLIENT';
export interface HttpClientIdentity {key:string;classification:ClientIdentityClass}
export function isAnonymousClient(key:string):boolean {
 return key==='anonymous-clients'||key==='proxy-clients'||key==='unknown-client';
}
/** No HTTP header, source port, request ID, browser hint or body field is a user
 * identity. Default to global/provider protection, including local browsers and
 * headerless proxies/NAT. DIRECT_PEER is an explicit operator assertion that
 * each socket peer represents one client on a controlled, direct-only boundary.
 * It must not be enabled on Render or shared loopback/NAT/proxy ingress.
 * Forwarding indicators always force anonymous admission, even in that mode.
 */
export function resolveClientIdentity(remoteAddress:string|undefined,forwarded:unknown,mode:ClientIdentityMode='ANONYMOUS'):HttpClientIdentity {
 if(forwarded!==undefined)return {key:'proxy-clients',classification:'UNTRUSTED_PROXY'};
 const peer=remoteAddress?.toLowerCase().replace(/^::ffff:(?=\d+\.)/,'');
 if(!peer||!isIP(peer))return {key:'unknown-client',classification:'UNKNOWN_PEER'};
 if(mode==='DIRECT_PEER')return {key:peer,classification:'DIRECT_PEER'};
 const local=peer==='::1'||peer.startsWith('127.');
 return {key:'anonymous-clients',classification:local?'ANONYMOUS_LOCAL':'ANONYMOUS_DIRECT'};
}
/** Compatibility helper for internal callers; classification is logged separately. */
export function clientIdentity(remoteAddress:string|undefined,forwarded:unknown,mode:ClientIdentityMode='ANONYMOUS'):string {
 return resolveClientIdentity(remoteAddress,forwarded,mode).key;
}

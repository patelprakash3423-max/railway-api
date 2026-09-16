import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
const local=h=>h==='localhost'||h==='127.0.0.1'||h==='::1'||h==='[::1]';
const original=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 const a=Array.isArray(args[0])?args[0]:args;
 const o=a[0];
 const host=typeof o==='object'?o.host:(typeof a[1]==='string'?a[1]:'localhost');
 if(!(typeof o==='object'&&o.path)&&!local(host??'localhost'))throw Error('External network forbidden in V3 verification');
 return original.apply(this,args);
};
const secure=tls.connect;
tls.connect=function(...args){const o=args[0];if(!local(typeof o==='object'?o.host:args[1]))throw Error('External TLS forbidden');return secure.apply(this,args);};
dgram.createSocket=()=>{throw Error('UDP forbidden');};

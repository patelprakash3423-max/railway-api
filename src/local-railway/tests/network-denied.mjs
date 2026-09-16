// Loaded before offline CLI validation/tests. Fail closed on network access.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dgram from 'node:dgram';
const deny = () => { throw new Error('Network forbidden in local railway validation'); };
globalThis.fetch = deny;
http.request = deny; http.get = deny; https.request = deny; https.get = deny;
net.Socket.prototype.connect = deny; dgram.createSocket = deny;

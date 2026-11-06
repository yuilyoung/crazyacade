import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocketTransport } from '../public/socket-transport.js';
class Socket {
 static instances=[];
 constructor(url) { this.url=url;this.listeners=new Map();this.sent=[];this.readyState=0;Socket.instances.push(this); }
 addEventListener(type,fn){this.listeners.set(type,fn);}
 removeEventListener(type,fn){if(this.listeners.get(type)===fn)this.listeners.delete(type);}
 send(value){this.sent.push(value);}
 close(){this.readyState=3;}
 emit(type,event){this.listeners.get(type)?.(event);}
}
test('socket adapter frames commands, filters malformed JSON, removes all callbacks on close',()=>{
 const messages=[];const transport=createSocketTransport({url:'ws://localhost',WebSocketClass:Socket});
 const port=transport.connect({type:'join'},{onMessage:m=>messages.push(m)});const socket=Socket.instances.at(-1);
 assert.equal(port.send({type:'input'}),false);socket.readyState=1;socket.emit('open');
 assert.deepEqual(JSON.parse(socket.sent[0]),{type:'join'});port.send({type:'input',action:'up'});
 socket.emit('message',{data:'broken'});socket.emit('message',{data:'null'});socket.emit('message',{data:'{"type":"state"}'});
 assert.deepEqual(messages,[{type:'state'}]);port.close();assert.equal(socket.listeners.size,0);assert.equal(port.send({type:'input'}),false);
});

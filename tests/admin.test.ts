import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../src/db.js';
import * as game from '../src/game.js';

test('admin creates a group-scoped key and disabling it blocks MCP',async()=>{
  const db=new PGlite();
  await db.exec(await readFile(new URL('../sql/001_init.sql',import.meta.url),'utf8'));
  const oldQuery=pool.query.bind(pool),oldConnect=pool.connect.bind(pool);
  (pool as any).query=(sql:string,params?:unknown[])=>db.query(sql,params);
  (pool as any).connect=async()=>({query:(sql:string,params?:unknown[])=>db.query(sql,params),release:()=>{}});
  process.env.ADMIN_USERNAME='admin';process.env.ADMIN_PASSWORD='integration-test-password-123';
  const {app}=await import('../src/server.js');
  try{
    const login=await app.inject({method:'POST',url:'/admin/api/login',payload:{username:'admin',password:process.env.ADMIN_PASSWORD}});
    assert.equal(login.statusCode,200);
    const csrf=login.json().csrf;
    const cookie=String(login.headers['set-cookie']).split(';')[0];
    const keyResponse=await app.inject({method:'POST',url:'/admin/api/keys',headers:{cookie,'x-csrf-token':csrf},payload:{name:'群 AI',groups:['group-a'],grants:['read','game']}});
    assert.equal(keyResponse.statusCode,200);
    const {id,key}=keyResponse.json();
    const headers={authorization:`Bearer ${key}`,'x-qq-group-id':'group-a','x-qq-user-id':'player-a','x-qq-message-id':'message-a','x-qq-message-time':'2026-10-27T00:00:00Z','x-request-id':'request-a',accept:'application/json, text/event-stream'};
    const payload={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1.0.0'}}};
    assert.equal((await app.inject({method:'POST',url:'/mcp',headers,payload})).statusCode,200);
    assert.equal((await app.inject({method:'POST',url:'/mcp',headers:{...headers,'x-qq-group-id':'group-b'},payload})).statusCode,401);
    const disabled=await app.inject({method:'PATCH',url:`/admin/api/keys/${id}`,headers:{cookie,'x-csrf-token':csrf},payload:{enabled:false}});
    assert.equal(disabled.statusCode,200);
    assert.equal((await app.inject({method:'POST',url:'/mcp',headers,payload})).statusCode,401);
    const world=await game.createWorld({groupId:'group-a',userId:'owner',messageId:'admin-world',requestId:'admin-world',keyId:'test',permissions:['world']},'后台世界',{});
    const base=`/admin/api/worlds/${world.worldId}`;
    const adminHeaders={cookie,'x-csrf-token':csrf};
    assert.equal((await app.inject({method:'POST',url:base+'/archive',headers:adminHeaders})).statusCode,200);
    assert.equal((await app.inject({method:'POST',url:base+'/resume',headers:adminHeaders})).statusCode,200);
    assert.equal((await app.inject({method:'DELETE',url:base,headers:{cookie}})).statusCode,401);
    assert.equal((await app.inject({method:'DELETE',url:base,headers:adminHeaders})).statusCode,200);
    assert.equal((await app.inject({method:'POST',url:base+'/recover',headers:adminHeaders})).statusCode,200);
    assert.equal((await app.inject({method:'DELETE',url:base,headers:adminHeaders})).statusCode,200);
    assert.equal((await app.inject({method:'DELETE',url:base+'/purge',headers:adminHeaders})).statusCode,200);
    assert.equal((await db.query('SELECT id FROM worlds WHERE id=$1',[world.worldId])).rows.length,0);
  }finally{
    await app.close();(pool as any).query=oldQuery;(pool as any).connect=oldConnect;await db.close();
    delete process.env.ADMIN_USERNAME;delete process.env.ADMIN_PASSWORD;
  }
});

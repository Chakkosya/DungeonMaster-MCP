import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';

test('HTTP routes expose admin UI and reject unauthenticated MCP',async()=>{
  const original=pool.query.bind(pool);
  (pool as any).query=async()=>({rows:[{n:1}]});
  const {app}=await import('../src/server.js');
  try{
    const ui=await app.inject({method:'GET',url:'/admin/'});
    assert.equal(ui.statusCode,200);
    assert.match(ui.body,/DungeonMaster/);
    const mcp=await app.inject({method:'POST',url:'/mcp',payload:{jsonrpc:'2.0',method:'initialize',id:1}});
    assert.equal(mcp.statusCode,401);
    (pool as any).query=async(sql:string)=>sql.includes('SELECT k.*')?{rows:[{id:'key-1',permissions:['read'],enabled:true}]}:{rows:[]};
    const authorized=await app.inject({method:'POST',url:'/mcp',headers:{
      authorization:'Bearer dnd_testkey','x-qq-group-id':'group-1','x-qq-user-id':'player-1',
      'x-qq-message-id':'message-1','x-qq-message-time':'2026-10-27T00:00:00Z','x-request-id':'request-1',
      accept:'application/json, text/event-stream'
    },payload:{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1.0.0'}}}});
    assert.equal(authorized.statusCode,200);
    assert.match(authorized.body,/DungeonMaster MCP/);
    const health=await app.inject({method:'GET',url:'/healthz'});
    assert.equal(health.statusCode,200);
  }finally{await app.close();(pool as any).query=original;}
});

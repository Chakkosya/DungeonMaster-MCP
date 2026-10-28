import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../src/mcp.js';

test('MCP exposes the expected game tools and DM prompt',async()=>{
  const actor={groupId:'group-1',userId:'player-1',messageId:'message-1',requestId:'request-1',keyId:'key-1',permissions:['read']};
  const server=createMcpServer(actor);
  const client=new Client({name:'test',version:'1.0.0'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport),client.connect(clientTransport)]);
  try{
    const tools=await client.listTools();
    assert.ok(tools.tools.some(x=>x.name==='create_world'));
    assert.ok(tools.tools.some(x=>x.name==='restore_save'));
    const prompts=await client.listPrompts();
    assert.ok(prompts.prompts.some(x=>x.name==='dm_guide'));
    const resources=await client.listResources();
    assert.ok(resources.resources.some(x=>x.uri==='dnd://dm-guide'));
    const info=await client.callTool({name:'get_server_info',arguments:{}});
    assert.equal((info.structuredContent as any).result.autosaves,3);
  }finally{await client.close();await server.close();}
});

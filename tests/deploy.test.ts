import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';

test('Compose declares persistent database and backup volumes',async()=>{
  const config=YAML.parse(await readFile(new URL('../compose.yaml',import.meta.url),'utf8'));
  for(const name of ['db','migrate','server','worker','caddy'])assert.ok(config.services[name]);
  for(const name of ['migrate','server','worker'])assert.equal(config.services[name].image,'ghcr.io/chakkosya/dungeonmaster-mcp:latest');
  assert.ok('postgres_data' in config.volumes);
  assert.ok('backups' in config.volumes);
  assert.ok(config.services.db.volumes.some((x:string)=>x.startsWith('postgres_data:')));
  assert.ok(config.services.worker.volumes.some((x:string)=>x.startsWith('backups:')));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { spellSlotsForClass } from '../src/rules.js';

test('SRD 5.1 spell slots follow class level tables',()=>{
  assert.deepEqual(spellSlotsForClass('圣武士',1),{});
  assert.deepEqual(spellSlotsForClass('圣武士',5),{'1':4,'2':2});
  assert.deepEqual(spellSlotsForClass('游侠',17),{'1':4,'2':3,'3':3,'4':3,'5':1});
  assert.deepEqual(spellSlotsForClass('法师',5),{'1':4,'2':3,'3':2});
});

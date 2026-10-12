import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGeoJson } from './geojson.js';
import { containsPoint, createGeofenceEngine } from './geofence.js';
import { openHistoryStore } from './history.js';
import { correlateObservations } from './correlation.js';
import { serializeWorkspace, parseWorkspace } from './workspace.js';
import { validateOtTopology } from './otTopology.js';

const square = { type:'Polygon', coordinates:[[
  [-1,-1],[1,-1],[1,1],[-1,1],[-1,-1],
]] };
test('GeoJSON importer validates local feature collections and rejects invalid coordinates',()=>{
  const txt=JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',properties:{name:'area'},geometry:square}]});
  const res=parseGeoJson(txt);
  assert.equal(res.summary.featureCount,1);
  assert.equal(res.summary.vertexCount,5);
  assert.deepEqual(res.summary.bounds,[-1,-1,1,1]);
  assert.throws(()=>parseGeoJson(txt.replace('1,1','188,1')), /outside/);
  assert.throws(()=>parseGeoJson(' '.repeat(6*1024*1024)),/limit/);
});
test('geofence enters/exits with live evidence, suppresses stale events and duplicate observations',()=>{
  const engine=createGeofenceEngine({rules:[{id:'restricted-demo',transition:'both',geometry:square}]});
  const now=1000000;
  const mk=(lon,at)=>({id:'aircraft-a',kind:'aircraft',source:'adsb',lon,lat:0,observedAt:at});
  assert.deepEqual(engine.observe([mk(2,now-3000)],now),[]);
  let entry=engine.observe([mk(0,now-2000)],now);
  assert.equal(entry.length,1);assert.equal(entry[0].transition,'enter');
  assert.equal(entry[0].causal,undefined);
  assert.deepEqual(engine.observe([mk(2,now-3000)],now),[]);
  assert.deepEqual(engine.observe([mk(2,now-1000)],now),[]); // rate-limited
  assert.deepEqual(engine.observe([mk(0,now-500000)],now),[]); // stale
  assert.equal(containsPoint(square,0,0),true);
  assert.equal(containsPoint(square,3,0),false);
  assert.throws(()=>createGeofenceEngine({rules:[{id:'a',transition:'both',geometry:{type:'Polygon',coordinates:[[[179,0],[-179,0],[-179,1],[179,1],[179,0]]]}}]}), /Antimeridian/);
});
test('SQLite local history defaults OFF; when opted in records, queries, deduplicates, prunes',()=>{
  const off=openHistoryStore();
  assert.equal(off.enabled,false);
  assert.throws(()=>off.append([]),/disabled/);
  let timestamp=172800000;
  const db=openHistoryStore({enabled:true,retentionDays:1,now:()=>timestamp});
  try {
    const a={kind:'aircraft',id:'abc123',source:'adsb',lat:0,lon:0,observedAt:timestamp-1000};
    assert.equal(db.append([a,a]),1);
    assert.equal(db.query({from:0,to:timestamp,kind:'aircraft'}).length,1);
    assert.throws(()=>db.append([{...a,id:'invalid user name'}]),/asset ID/);
    timestamp+=2*86400000;
    assert.equal(db.prune(),1);
    assert.deepEqual(db.query({from:0,to:timestamp,kind:'aircraft'}),[]);
  } finally {db.close();}
});
test('correlations are labeled as noncausal coincidences with sources',()=>{
  const a={id:'vessel',source:'AIS',lat:0,lon:0,observedAt:20000};
  const b={id:'port',source:'OSM',lat:0,lon:0.001,observedAt:23000};
  const found=correlateObservations([a],[b],{radiusMeters:200});
  assert.equal(found.length,1);
  assert.equal(found[0].causal,false);
  assert.deepEqual(correlateObservations([a],[b],{radiusMeters:10}),[]);
  assert.throws(()=>correlateObservations(Array(2500).fill(a),Array(2500).fill(b)), /workload/);
});
test('workspace import/export preserves benign state but refuses nested credentials',()=>{
  const value={title:'Demo',camera:{lat:45,lon:-3},layers:['flights']};
  assert.deepEqual(parseWorkspace(serializeWorkspace(value)),value);
  assert.throws(()=>serializeWorkspace({...value,visual:{apiKey:'abc'}}),/credentials/);
  assert.throws(()=>parseWorkspace('{"version":2,"data":{}}'),/Unsupported/);
});
test('private OT topology is purely aggregated zones/conduits',()=>{
  const top={zones:[{id:'zone1',label:'Control',classification:'control'},{id:'zone2',label:'DMZ',classification:'dmz'}],
    conduits:[{from:'zone1',to:'zone2',status:'unknown',observedAt:1}]};
  assert.deepEqual(validateOtTopology(top),top);
  assert.throws(()=>validateOtTopology({...top,zones:[{...top.zones[0],ip:'10.0.0.1'},top.zones[1]]}),/Detailed OT/);
});

import { createRefinementScheduler } from './refinementScheduler.js';
import { renderEvidenceReport } from './report.js';
test('optional refinement coalesces and ignores stale camera generations',async()=>{
  const scheduled=new Map(); let n=0; const cancelled=[]; let committed=0;
  const governor=createRefinementScheduler({schedule:(fn)=>{scheduled.set(++n,fn);return n;},cancel:(id)=>{cancelled.push(id);scheduled.delete(id);}});
  governor.motionStart();
  governor.request(({current})=>{if(current()) committed+=1;});
  governor.request(({current})=>{if(current()) committed+=10;});
  assert.equal(scheduled.size,0);
  governor.motionStop();assert.equal(scheduled.size,1);
  const flush=[...scheduled.values()][0]; flush();
  await Promise.resolve();await Promise.resolve();
  assert.equal(committed,10);
  governor.motionStart();
  governor.request(({current})=>{if(current()) committed+=100;});
  governor.motionStop();
  governor.dispose();
  for(const f of scheduled.values()) f();
  assert.equal(committed,10);
});
test('HTML evidence report escapes hostile strings and identifies provenance',()=>{
  const html=renderEvidenceReport({title:'<test>',observations:[{kind:'aircraft',id:'a',source:'<img src=x>',observedAt:1000,note:'"<script>"'}]});
  assert.match(html,/&lt;script&gt;/);
  assert.doesNotMatch(html,/<script>/);
  assert.match(html,/not verified facts/);
});

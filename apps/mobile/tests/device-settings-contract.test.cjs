const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const ts = require('typescript');
const React = require('react');
const { create, act } = require('react-test-renderer');

function loadTypeScript(relative, mocks = {}) {
  const filename = resolve(__dirname, relative);
  const loaded = new Module(filename, module);
  loaded.require = (id) => {
    if (id in mocks) return mocks[id];
    if (id === './chat-stream') return loadTypeScript('../lib/api-client/chat-stream.ts');
    return require(id);
  };
  loaded._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, filename);
  return loaded.exports;
}

function loadClient() {
  return loadTypeScript('../lib/api-client/client.ts', {
    'react-native': { Platform: { OS: 'web' } },
    '../runtimePublicEnv': { getApiBaseUrl: () => 'https://jarvis.test', ngrokSkipBrowserWarningHeaders: () => ({}) },
  });
}


const raw = (extra = {}) => ({id:'device-1',name:'Entry',kind:'camera',base_url:'https://camera.local:8443/gateway/',room:'Hall',metadata:{describe_scene_prompt:'Check parcels',is_main_describe_camera:true},created_at:'now',updated_at:'now',...extra});

test('normalizes reported device state without inventing online status',async(t)=>{
 t.mock.method(global,'fetch',async()=>new Response(JSON.stringify([
  raw({metadata:{connected:true,last_seen_at:'2026-10-14T12:00:00Z',last_heartbeat_at:'2026-10-14T12:01:00Z',health:{connected:false,ready:false,frame_sequence:42},camera_model:'imx500',resolution:[1280,720],detector_degraded_reason:'warming'},callback_configured:true}),
  raw({id:'unknown',kind:'voice',base_url:null,metadata:{connected:'true'}}),
 ])));
 const rows=await loadClient().getJarvisDevices();
 assert.equal(rows[0].base_url,'https://camera.local:8443/gateway/');
 assert.equal(rows[0].reported_connected,false);
 assert.equal(rows[0].last_heartbeat_at,'2026-10-14T12:01:00Z');
 assert.equal(rows[0].health.ready,false);
 assert.equal(rows[0].camera_model,'imx500');
 assert.deepEqual(rows[0].resolution,[1280,720]);
 assert.equal(rows[0].callback_configured,true);
 assert.equal(rows[1].reported_connected,null);
 assert.equal(rows[1].base_url,null);
 assert.equal(rows[1].last_seen_at,null);
});

test('camera creation defaults bare callback hosts to 8089 and writes secret atomically',async(t)=>{
 const calls=[];
 t.mock.method(global,'fetch',async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify(raw({callback_configured:true})),{status:201});});
 await loadClient().createJarvisDevice({device_name:'Camera',device_type:'camera',address:'camera.local',callback_secret:' camera-callback-token '});
 assert.equal(calls.length,1);
 assert.equal(calls[0].body.base_url,'http://camera.local:8089');
 assert.equal(calls[0].body.callback_token,'camera-callback-token');
});

test('voice creation accepts no callback endpoint',async(t)=>{
 let payload;
 t.mock.method(global,'fetch',async(url,options)=>{payload=JSON.parse(options.body);return new Response(JSON.stringify(raw({kind:'voice',base_url:null})),{status:201});});
 await loadClient().createJarvisDevice({device_name:'Voice',device_type:'voice_interface'});
 assert.equal(payload.base_url,null);
 assert.equal(payload.kind,'voice');
});

test('settings updates preserve exact endpoint and blank secret without a second request',async(t)=>{
 const calls=[];
 t.mock.method(global,'fetch',async(url,options)=>{calls.push({url,method:options.method,body:options.body?JSON.parse(options.body):null});return new Response(JSON.stringify(options.method === 'PATCH' ? raw() : [raw()]));});
 await loadClient().updateJarvisDevice('device-1',{device_name:'Front entry',callback_secret:'   ',doorbell_alerts_enabled:true});
 assert.equal(calls.length,1);
 assert.equal(calls[0].method,'PATCH');
 assert.ok(!('base_url' in calls[0].body));
 assert.ok(!('callback_token' in calls[0].body));
 assert.deepEqual(calls[0].body.metadata,{doorbell_alerts_enabled:true});
});

test('explicit endpoint edits preserve HTTPS path and can clear an optional endpoint',async(t)=>{
 const bodies=[];
 t.mock.method(global,'fetch',async(url,options)=>{if(!options.method||options.method==='GET')return new Response(JSON.stringify([raw()])); bodies.push(JSON.parse(options.body));return new Response(JSON.stringify(raw()));});
 const client=loadClient();
 await client.updateJarvisDevice('device-1',{base_url:'https://camera.local/gateway/',callback_secret:'new-callback-secret'});
 await client.updateJarvisDevice('device-1',{base_url:null});
 assert.equal(bodies[0].base_url,'https://camera.local/gateway/');
 assert.equal(bodies[0].callback_token,'new-callback-secret');
 assert.equal(bodies[1].base_url,null);
});

test('legacy unchanged address fields preserve the stored scheme and path',async(t)=>{
 let payload;
 t.mock.method(global,'fetch',async(url,options)=>{
  if(!options.method||options.method==='GET')return new Response(JSON.stringify([raw()]));
  payload=JSON.parse(options.body);return new Response(JSON.stringify(raw()));
 });
 await loadClient().updateJarvisDevice('device-1',{device_name:'Renamed',address:'camera.local',callback_port:8443});
 assert.equal(payload.base_url,'https://camera.local:8443/gateway/');
});


test('camera reconnect report takes precedence over an older heartbeat and keeps raw device kind',async(t)=>{
 t.mock.method(global,'fetch',async()=>new Response(JSON.stringify([
  raw({metadata:{connected:true,last_seen_at:'2026-10-14T12:02:00Z',last_heartbeat_at:'2026-10-14T12:01:00Z',health:{connected:false}}}),
  raw({kind:'display'}),
 ])));
 const rows=await loadClient().getJarvisDevices();
 assert.equal(rows[0].reported_connected,true);
 assert.equal(rows[1].raw_kind,'display');
});

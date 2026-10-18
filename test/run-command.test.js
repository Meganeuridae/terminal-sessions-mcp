const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ConnectomeTestingMCP}=require('../dist/src/mcp/mcp-server');

function wrapper(client){const m=new ConnectomeTestingMCP();m.getClient=()=>client;return m;}

test('runCommand retains session-limit failure instead of executing a missing session',async()=>{
  let executed=false;
  const m=wrapper({listSessions:async()=>[],createSession:async()=>{throw new Error('Session limit reached (150). Reuse an existing one.');},exec:async()=>{executed=true;throw new Error('Session board not found');}});
  await assert.rejects(m.runCommand({session:'board',command:'pwd'}),/Session limit reached/);
  assert.equal(executed,false);
});

test('runCommand preserves the creation cause even if the race-check also fails',async()=>{
  let lists=0;
  const m=wrapper({listSessions:async()=>{if(lists++)throw new Error('Disconnected');return [];},createSession:async()=>{throw new Error('Invalid working directory');}});
  await assert.rejects(m.runCommand({session:'board',command:'pwd'}),/Invalid working directory/);
});

test('runCommand tolerates another caller creating the same session concurrently',async()=>{
  let lists=0,executed=false;
  const m=wrapper({listSessions:async()=>lists++?[{id:'board'}]:[],createSession:async()=>{throw new Error('Session board already exists');},exec:async()=>{executed=true;return {output:'ready',exitCode:0,duration:1};}});
  assert.equal((await m.runCommand({session:'board',command:'pwd'})).output,'ready');assert.equal(executed,true);
});

test('runCommand reuses existing sessions at capacity without creating another',async()=>{
  let creates=0;
  const m=wrapper({listSessions:async()=>[{id:'linn-board'}],createSession:async()=>{creates++;throw new Error('Must not create');},exec:async()=>({output:'ready',exitCode:0,duration:1})});
  assert.equal((await m.runCommand({session:'linn-board',command:'pwd'})).exitCode,0);
  assert.equal(creates,0,'no create for a session the listing holds');
});

test('runCommand lists again on a fresh connection when the first listing loses its connection, then runs the command',async()=>{
  let lists=0,creates=0,executed=false;
  const m=wrapper({listSessions:async()=>{if(lists++===0)throw new Error('Connection lost');return [{id:'board'}];},createSession:async()=>{creates++;},exec:async()=>{executed=true;return {output:'ready',exitCode:0,duration:1};}});
  assert.equal((await m.runCommand({session:'board',command:'pwd'})).output,'ready');
  assert.equal(lists,2,'listed once more');
  assert.equal(creates,0);
  assert.equal(executed,true);
});

test("runCommand fails with the listing's error when the listing fails other than by a lost connection, and runs nothing",async()=>{
  let lists=0,creates=0,executed=false;
  const m=wrapper({listSessions:async()=>{lists++;throw new Error('Request timeout: session.list');},createSession:async()=>{creates++;},exec:async()=>{executed=true;return {output:'ready',exitCode:0,duration:1};}});
  await assert.rejects(m.runCommand({session:'board',command:'pwd'}),/^Error: Request timeout: session\.list$/);
  assert.equal(lists,1,'not tried again');
  assert.equal(creates,0);
  assert.equal(executed,false);
});

test('runCommand creates a missing session under its service-mapped id, with the cwd given, when the listing holds only other sessions',async()=>{
  const created=[],executed=[];
  const m=wrapper({listSessions:async()=>[{id:'other'}],createSession:async(p)=>{created.push(p);return {sessionId:p.id};},exec:async(id)=>{executed.push(id);return {output:'ready',exitCode:0,duration:1};}});
  m.serviceMap.set('web','svc-1');
  assert.equal((await m.runCommand({session:'web',command:'pwd',cwd:'/srv'})).output,'ready');
  assert.deepEqual(created,[{id:'svc-1',cwd:'/srv'}]);
  assert.deepEqual(executed,['svc-1']);
});

test("the second listing, not the creation error's wording, decides whether a refused create is the session existing after all",async()=>{
  let lists=0,executed=false;
  const listed=wrapper({listSessions:async()=>lists++?[{id:'board'}]:[],createSession:async()=>{throw new Error('Session board is already running');},exec:async()=>{executed=true;return {output:'ready',exitCode:0,duration:1};}});
  assert.equal((await listed.runCommand({session:'board',command:'pwd'})).output,'ready','other wording, and the session is listed: runs');
  assert.equal(executed,true);
  executed=false;
  const absent=wrapper({listSessions:async()=>[],createSession:async()=>{throw new Error('Session board already exists');},exec:async()=>{executed=true;return {output:'ready',exitCode:0,duration:1};}});
  await assert.rejects(absent.runCommand({session:'board',command:'pwd'}),/Session board already exists/,"the server's wording, and the session isn't listed: the creation's error");
  assert.equal(executed,false);
});

test("runCommand fails with the retry's error when the listing loses its connection twice, and runs nothing",async()=>{
  let lists=0,creates=0,executed=false;
  const m=wrapper({listSessions:async()=>{lists++;throw new Error('Connection lost');},createSession:async()=>{creates++;},exec:async()=>{executed=true;return {output:'ready',exitCode:0,duration:1};}});
  await assert.rejects(m.runCommand({session:'board',command:'pwd'}),/^Error: Connection lost$/);
  assert.equal(lists,2,'listed once more, then gave up');
  assert.equal(creates,0);
  assert.equal(executed,false);
});

test('a refused create runs the command only if the second listing holds the named session itself',async()=>{
  let lists=0,executed=false;
  const m=wrapper({listSessions:async()=>lists++?[{id:'other'}]:[],createSession:async()=>{throw new Error('Session limit reached (150). Reuse an existing one.');},exec:async()=>{executed=true;return {output:'ready',exitCode:0,duration:1};}});
  await assert.rejects(m.runCommand({session:'board',command:'pwd'}),/Session limit reached/,'another session listed: the creation error');
  assert.equal(executed,false);
  let mapped=0;
  const svc=wrapper({listSessions:async()=>mapped++?[{id:'svc-1'}]:[],createSession:async()=>{throw new Error('Session svc-1 already exists');},exec:async(id)=>({output:`ran in ${id}`,exitCode:0,duration:1})});
  svc.serviceMap.set('web','svc-1');
  assert.equal((await svc.runCommand({session:'web',command:'pwd'})).output,'ran in svc-1','the mapped id is the one looked for');
});

test("a create whose answer was lost runs the command when the second listing shows the session it made",async()=>{
  let lists=0,executed=false;
  const m=wrapper({listSessions:async()=>lists++?[{id:'board'}]:[],createSession:async()=>{throw new Error('Connection lost');},exec:async()=>{executed=true;return {output:'ready',exitCode:0,duration:1};}});
  assert.equal((await m.runCommand({session:'board',command:'pwd'})).output,'ready');
  assert.equal(executed,true);
});

// The real client against a WebSocket server, for what the stand-in can't show.
const net=require('node:net');
const WebSocket=require('ws');
const {RobustSessionClient}=require('../dist/src/client/websocket-client');
const freePort=()=>new Promise((resolve)=>{const s=net.createServer().listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>resolve(port));});});

test('closing a client whose socket is still connecting leaves the process running',async()=>{
  const port=await freePort();
  const c=new RobustSessionClient(`ws://127.0.0.1:${port}`);
  c.close(); // ws emits 'error' for a socket closed before it connected
  await new Promise((r)=>setTimeout(r,100));
});

test('two calls that lose one connection together both get through on one fresh client',async()=>{
  const port=await freePort();
  const wss=new WebSocket.Server({port,host:'127.0.0.1'});
  let connections=0;
  wss.on('connection',(ws)=>{
    const n=++connections;let lists=0;
    ws.on('message',(raw)=>{
      const msg=JSON.parse(String(raw));
      if(n===1){if(msg.method==='session.list'&&++lists===2)ws.terminate();return;} // drops once both listings are in flight
      const reply=(result)=>ws.send(JSON.stringify({id:msg.id,result}));
      if(msg.method==='session.list')reply([{id:'board'}]);
      else if(msg.method==='session.exec')reply({output:'ran',exitCode:0,duration:1});
      else ws.send(JSON.stringify({id:msg.id,error:`unexpected ${msg.method}`}));
    });
  });
  const m=new ConnectomeTestingMCP(`ws://127.0.0.1:${port}`);
  try{
    const [run,listed]=await Promise.all([m.runCommand({session:'board',command:'pwd'}),m.listSessions()]);
    assert.equal(run.output,'ran');
    assert.equal(listed.length,1);
    assert.equal(connections,2,'one fresh connection for both');
  }finally{
    m.getClient().close();
    await new Promise((r)=>wss.close(r));
  }
});

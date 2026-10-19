const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const fullSource = fs.readFileSync(process.argv[2] || path.join(__dirname, 'shangou.js'), 'utf8');
const source = fullSource.split('var UI_OK = true;')[0];
const baseCfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.example.json'), 'utf8'));
const TARGET = new Date(2026, 9, 18, 14, 0, 0).getTime();

function harness(options = {}) {
  let tick = TARGET - (options.startBefore || 3500), mono = 100000;
  function advance(ms) {tick+=ms;mono+=ms;}
  const calls = [], logs = [];
  const cfg = JSON.parse(JSON.stringify(baseCfg));
  Object.assign(cfg.timing, {fireMode:'state',fireWindowMs: 1000, sentinelMs: 1500, clickGapMs: 250,
    pollGapMs: 15, refreshAfterMs: 4000}, options.timing);
  const text = () => options.text ? options.text(tick - TARGET) :
    tick < TARGET + 100 ? '14:00开抢' : '立即抢';
  function node() {
    return {text, desc: () => '', bounds: () => options.badBounds ?
      {left: 100, top: 200, right: 300, bottom: 260} :
      {left: 795, top: 807, right: 1002, bottom: 891}};
  }
  const selector = {boundsInside() {return this;}, findOnce: node, find: () => [node()]};
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [tick])); }
    static now() { const t=tick; advance(1); return t; }
  }
  const ctx = {
    Date: ClockDate, console: {log() {}, error() {}},
    files: {join: (...x) => x.join('/'), exists: () => false, write() {}, ensureDir() {}},
    engines: {myEngine: () => ({source:'/sdcard/shangou/shangou.js'})},
    sleep: ms => {advance(Math.max(1, ms));},
    device: {width:1080, height:2340},
    currentPackage: () => options.wrongPackage ? 'com.huawei.search' : 'me.ele',
    currentActivity: () => 'test.Activity',
    textMatches: () => selector, textContains: () => selector,
    click: (x,y) => {calls.push({at:tick, x,y,method:'click'}); advance(152); return true;},
    press: (x,y,duration) => {calls.push({at:tick,x,y,method:'press',duration});advance(duration);return true;},
    swipe() {},
  };
  if(options.monotonicClock)ctx.android={os:{SystemClock:{elapsedRealtime:()=>{const t=mono;advance(1);return t;}}}};
  vm.createContext(ctx);
  vm.runInContext(source, ctx, {timeout:1000});
  Object.assign(ctx, {CFG:cfg, HAS_UI:false, STOP:false, TIME_OFFSET:0,
    log: s => logs.push(String(s)), flushLog() {}, keepAlive() {}, shot: () => '',
    inActivityPage: () => true, ensureActivityPage: () => true, bringUpApp() {},
    blindTapReady: () => true,
    lockTargetSession: () => options.lock !== false,
    forceSelectSession: () => options.lock !== false,
    readButtonText: text, readButtonTextFast: text,
    forceRefreshSession: () => true});
  if(options.checkThrows) ctx.preClickCheck = () => {throw new Error('accessibility read failed');};
  return {ctx,calls,logs,jumpWall:ms=>{tick+=ms;},run: () => vm.runInContext(`doFire(${TARGET}, '14:00')`,ctx,{timeout:1500})};
}
const cases = [];
function test(name, fn) { cases.push([name,fn]); }

test('锁场失败必须返回 wrong_session，且不点击', () => {
  const h = harness({lock:false});
  assert.equal(h.run(),'wrong_session'); assert.equal(h.calls.length,0);
});
test('哨兵发现 ready 也不能在目标整点前点击', () => {
  const h = harness({text: d => d < -2000 ? '14:00开抢' : '立即抢'});
  h.run(); assert(h.calls.length > 0);
  assert(h.calls.every(c => c.at >= TARGET),'出现整点前点击');
});
test('校验抛异常必须阻止点击', () => {
  const h = harness({checkThrows:true}); h.run(); assert.equal(h.calls.length,0);
});
test('正常放开后出手，10秒配置按窗口结束', () => {
  const h = harness(); h.run(); assert(h.calls.length > 0);
  assert(h.calls.every(c => c.at >= TARGET + 100 && c.at < TARGET + 1000));
});
test('正在抢回落后继续出手，处理中不点击', () => {
  const h = harness({timing:{fireWindowMs:2000},text:d =>
    d < 100 ? '14:00开抢' : d < 500 ? '立即抢' : d < 1200 ? '正在抢' : '立即抢'});
  h.run(); assert(h.calls.some(c => c.at >= TARGET+1200));
  assert(h.calls.every(c => c.at < TARGET+500 || c.at >= TARGET+1200));
});
test('前台错误不点击', () => {
  const h=harness({wrongPackage:true}); h.run(); assert.equal(h.calls.length,0);
});
test('按钮边界不覆盖坐标不点击', () => {
  const h=harness({badBounds:true}); h.run(); assert.equal(h.calls.length,0);
});
test('blind 分支有点击，变量已初始化', () => {
  const h=harness({timing:{fireMode:'blind'}}); h.run(); assert(h.calls.length>0);
  assert(h.calls.every(c => c.at>=TARGET));
});
test('blind 前台错误也不点击', () => {
  const h=harness({wrongPackage:true,timing:{fireMode:'blind'}}); h.run(); assert.equal(h.calls.length,0);
});
test('未来场次不能仅凭点格后立即抢通过锁定', () => {
  const h=harness({text:()=>'立即抢'});
  vm.runInContext(source.slice(source.indexOf('function forceSelectSession('),source.indexOf('function lockTargetSession(')), h.ctx);
  h.ctx.waitButtonContains=()=> '立即抢';
  assert.equal(h.ctx.forceSelectSession('14:00', TARGET),false);
});
test('选场失败原因写入结果', () => {
  const h=harness(); h.ctx.textContains=()=>({exists:()=>false});
  assert.equal(h.ctx.judge('wrong_session').verdict,'wrong_session');
});
test('刷新后正在抢为暂态，回落后继续', () => {
  let refreshed=false;
  const h=harness({timing:{fireWindowMs:3000,refreshAfterMs:1,notstartRefreshAfter:1},
    text:d => d < 0 ? '14:00开抢' : !refreshed ? '14:00开抢' : d<1000 ? '正在抢':'立即抢'});
  h.ctx.forceRefreshSession=()=>{refreshed=true;return true;};
  h.run(); assert(h.calls.some(c=>c.at>=TARGET+1000));
});
test('T-3秒场次漂移后重锁失败不点击', () => {
  const h=harness({text:d=>d < -3100 ? '14:00开抢':'立即抢'});
  h.ctx.forceSelectSession=()=>false;
  assert.equal(h.run(),'wrong_session'); assert.equal(h.calls.length,0);
});
test('最后3秒不调用慢页面扫描，首击留在开抢窗口', () => {
  const h=harness();
  h.ctx.inActivityPage=()=>{h.ctx.sleep(5000);return true;};
  h.run(); assert(h.calls.length>0,'慢扫描吞掉整个出手窗口');
  assert(h.calls[0].at<TARGET+500);
});
test('出手使用配置的10ms短按并记录API耗时', () => {
  const h=harness({timing:{pressDurationMs:10}});
  h.ctx.tapAt(899,849,'test','fire');
  assert.equal(h.calls[0].method,'press'); assert.equal(h.calls[0].duration,10);
  assert(h.ctx.CLICKS[0].durationMs>=10);
});
test('选场操作仍用click，隔离提速改动', () => {
  const h=harness({timing:{pressDurationMs:10}});
  h.ctx.tapAt(500,570,'select','op'); assert.equal(h.calls[0].method,'click');
});
test('短按抛异常不会补点第二次', () => {
  const h=harness({timing:{pressDurationMs:10}});
  h.ctx.press=()=>{throw new Error('gesture failed');};
  h.ctx.tapAt(899,849,'test','fire'); assert.equal(h.calls.length,0);
  assert.equal(h.ctx.CLICKS[0].ok,false);
});
test('配置短按0时可回退原click进行对照', () => {
  const h=harness({timing:{pressDurationMs:0}});
  h.ctx.tapAt(899,849,'test','fire'); assert.equal(h.calls[0].method,'click');
});
test('连点预检必须拒绝不覆盖目标坐标的按钮', () => {
  const h=harness({badBounds:true,timing:{fireMode:'blind'}});
  assert.equal(h.run(),'precheck_failed');assert.equal(h.calls.length,0);
});
test('连点中单次手势只记内存，不逐次输出日志', () => {
  const h=harness({timing:{fireMode:'blind',pressDurationMs:10}});
  h.ctx.FIRE_PHASE=true;h.ctx.tapAt(899,849,'rapid','fire');
  assert.equal(h.ctx.CLICKS.length,1);assert.equal(h.logs.length,0);
});
test('连点10秒不被旧60次上限提前截断，间隔低于250ms', () => {
  const h=harness({timing:{fireMode:'blind',fireWindowMs:10000,blindGapMs:20,blindMaxClicks:1000,pressDurationMs:10}});
  h.run();assert(h.calls.length>150);assert(h.calls.at(-1).at>=TARGET+9800);
  assert(h.calls[1].at-h.calls[0].at<100);
});
test('连点手势失败后停止，不继续无效循环', () => {
  const h=harness({timing:{fireMode:'blind',pressDurationMs:10}});let attempts=0;
  h.ctx.press=()=>{attempts++;return false;};
  assert.equal(h.run(),'gesture_failed');assert.equal(attempts,1);assert.equal(h.ctx.FIRE_PHASE,false);
});
test('连点前台改变后停止，并清理出手标记', () => {
  const h=harness({timing:{fireMode:'blind',pressDurationMs:10,blindGapMs:20,blindMaxClicks:1000}});
  h.ctx.currentPackage=()=>h.calls.length>=3?'com.huawei.search':'me.ele';
  assert.equal(h.run(),'lost_page');assert.equal(h.calls.length,3);assert.equal(h.ctx.FIRE_PHASE,false);
});
test('包名检查耗时跨过窗口后不再发起手势', () => {
  const h=harness({timing:{fireMode:'blind',fireWindowMs:100,pressDurationMs:10,blindGapMs:0}});
  h.ctx.currentPackage=()=>{h.ctx.sleep(80);return 'me.ele';};
  h.run();assert(h.calls.every(c=>c.at<TARGET+100));
});
test('连点期间不读取按钮状态或刷新场次', () => {
  const h=harness({timing:{fireMode:'blind',fireWindowMs:1000,pressDurationMs:10,blindGapMs:20}});
  const read=h.ctx.readButtonTextFast;
  h.ctx.readButtonTextFast=()=>{assert.equal(h.ctx.FIRE_PHASE,false);return read();};
  h.ctx.readButtonText=h.ctx.readButtonTextFast;
  h.ctx.forceRefreshSession=()=>{throw new Error('Unexpected refresh');};
  assert.equal(h.run(),'fired');
});
test('独立观察器记录状态变化和瞬时提示，不产生点击或逐次日志', () => {
  const h=harness();let t=TARGET;
  h.ctx.now=()=>t;h.ctx.sleep=ms=>{t+=ms;};h.ctx.FIRE_PHASE=true;
  h.ctx.CFG.timing.feedbackPollMs=100;
  h.ctx.readButtonTextFast=()=>t<TARGET+300?'14:00开抢':t<TARGET+600?'正在抢':'立即抢';
  h.ctx.textMatches=()=>({boundsInside(){return this;},findOnce:()=>t>=TARGET+200&&t<TARGET+300?{text:()=> '操作太频繁了'}:null});
  const sink={samples:[],messages:[],errors:[],stop:false};
  h.ctx.observeFireFeedback(TARGET,TARGET+1000,sink);
  assert.deepEqual(Array.from(sink.samples,x=>x.text),['14:00开抢','正在抢','立即抢']);
  assert.equal(sink.messages[0].text,'操作太频繁了');
  assert.equal(sink.finished,true);assert.equal(h.calls.length,0);assert.equal(h.logs.length,0);
});
test('观察器读取异常仅记录，仍继续采样', () => {
  const h=harness();let t=TARGET,reads=0;
  h.ctx.now=()=>t;h.ctx.sleep=ms=>{t+=ms;};h.ctx.FIRE_PHASE=true;
  h.ctx.CFG.timing.feedbackPollMs=100;
  h.ctx.readButtonTextFast=()=>{if(reads++===0)throw new Error('temporary');return '立即抢';};
  h.ctx.textMatches=()=>({boundsInside(){return this;},findOnce:()=>null});
  const sink={samples:[],messages:[],errors:[],stop:false};
  h.ctx.observeFireFeedback(TARGET,TARGET+500,sink);
  assert.equal(sink.errors.length,1);assert.equal(sink.samples[0].text,'立即抢');assert.equal(h.calls.length,0);
});
test('先等立即抢再开始快速连点，未开放期间零点击', () => {
  const h=harness({timing:{fireMode:'readyBurst',pressDurationMs:10,blindGapMs:20,blindMaxClicks:1000,fireWindowMs:2000},
    text:d=>d<680?'14:00开抢':'立即抢'});
  assert.equal(h.run(),'fired');assert(h.calls.length>20);
  assert(h.calls.every(c=>c.at>=TARGET+680));assert(h.calls[0].at<TARGET+800);
  assert(h.calls[1].at-h.calls[0].at<100);
});
test('整个窗口未变立即抢时不出手', () => {
  const h=harness({timing:{fireMode:'readyBurst',pressDurationMs:10},text:()=> '14:00开抢'});
  assert.equal(h.run(),'no_click');assert.equal(h.calls.length,0);
});
test('开放后开始连点，后续正在抢不打断连点', () => {
  const h=harness({timing:{fireMode:'readyBurst',pressDurationMs:10,blindGapMs:20,blindMaxClicks:1000,fireWindowMs:2000},
    text:d=>d<300?'14:00开抢':d<700?'立即抢':d<1500?'正在抢':'立即抢'});
  assert.equal(h.run(),'fired');assert(h.calls.some(c=>c.at>=TARGET+800&&c.at<TARGET+1400));
});
test('等待可抢时遇到已抢完，停止且无点击', () => {
  const h=harness({timing:{fireMode:'readyBurst',pressDurationMs:10},text:d=>d<100?'14:00开抢':'已抢完'});
  assert.equal(h.run(),'no_click');assert.equal(h.calls.length,0);
});

test('可抢触发后不再逐次读按钮或输出手势日志', () => {
  const h=harness({timing:{fireMode:'readyBurst',pressDurationMs:10,fireWindowMs:1500}});
  const read=h.ctx.readButtonTextFast;
  h.ctx.readButtonTextFast=()=>{assert.equal(h.ctx.FIRE_PHASE,false);return read();};
  h.ctx.readButtonText=h.ctx.readButtonTextFast;
  assert.equal(h.run(),'fired');assert(h.calls.length>10);
  assert(h.logs.every(s=>!s.includes('🔫')));
});

test('可抢触发时坐标复核失败，零点击', () => {
  const h=harness({timing:{fireMode:'readyBurst',pressDurationMs:10}});
  const check=h.ctx.preClickCheck;
  h.ctx.preClickCheck=(txt,st,allow)=>allow?check(txt,st,allow):{ok:false,why:'moved'};
  assert.equal(h.run(),'precheck_failed');assert.equal(h.calls.length,0);
  assert.equal(h.ctx.FIRE_FEEDBACK.stop,true);
});

test('可抢出现已晚于窗口截止，不补点', () => {
  const h=harness({timing:{fireMode:'readyBurst',pressDurationMs:10,fireWindowMs:1000},
    text:d=>d<1100?'14:00开抢':'立即抢'});
  assert.equal(h.run(),'no_click');assert.equal(h.calls.length,0);
});

test('timerBurst按整点开始，无需等文字检索完成', () => {
  const h=harness({timing:{fireMode:'timerBurst',pressDurationMs:10,blindGapMs:0,fireWindowMs:1000},text:()=> '14:00开抢'});
  const read=h.ctx.readButtonTextFast;
  h.ctx.readButtonTextFast=()=>{assert.equal(h.ctx.FIRE_PHASE,false);return read();};
  h.ctx.readButtonText=h.ctx.readButtonTextFast;
  assert.equal(h.run(),'fired');assert(h.calls.length>30);
  assert(h.calls[0].at>=TARGET&&h.calls[0].at<TARGET+30);
  assert(h.logs.every(s=>!s.includes('🔫')));
});

function installTimeSource(h, samples) {
  let index=0;
  h.ctx.CFG.timeSync.samples=3;h.ctx.CFG.timeSync.budgetMs=5000;
  h.ctx.http={get:()=>{
    const s=samples[Math.min(index++,samples.length-1)];
    if(s.error){h.ctx.sleep(100);throw new Error('network');}
    const start=h.ctx.Date.now();h.ctx.sleep(s.rtt);
    return {body:{string:()=>JSON.stringify({data:{t:String(Math.round(start+s.rtt/2)+s.offset)}})}};
  }};
}

test('三次对时选择往返时间最小样本', () => {
  const h=harness({monotonicClock:true});
  installTimeSource(h,[{rtt:300,offset:600},{rtt:40,offset:50},{rtt:90,offset:70}]);
  h.ctx.syncTime();assert(Math.abs(h.ctx.TIME_OFFSET-50)<5,'应选低RTT样本，而非首次响应');
});

test('对时后系统墙钟跳变不会让校准时间跳跃', () => {
  const h=harness({monotonicClock:true});installTimeSource(h,[{rtt:40,offset:50}]);
  h.ctx.syncTime();const before=h.ctx.now();h.jumpWall(300000);h.ctx.sleep(50);
  const elapsed=h.ctx.now()-before;assert(elapsed>=50&&elapsed<60,'校准时间被墙钟跳变影响');
});

test('重新对时失败保留已有校准', () => {
  const h=harness({monotonicClock:true});installTimeSource(h,[{rtt:40,offset:500}]);
  h.ctx.syncTime();const offset=h.ctx.TIME_OFFSET;
  installTimeSource(h,[{error:true}]);h.ctx.syncTime();
  assert.equal(h.ctx.TIME_OFFSET,offset);
});

test('原生对时使用独立总调用超时，响应体异常也关闭响应', () => {
  const h=harness();let timeout=0,closed=0,gets=0;
  const response={isSuccessful:()=>true,body:()=>({string:()=>{throw new Error('body failed');}}),close:()=>closed++};
  h.ctx.java={util:{concurrent:{TimeUnit:{MILLISECONDS:'ms'}}}};
  const builder={callTimeout:(ms,unit)=>{timeout=ms;assert.equal(unit,'ms');return builder;},build:()=>({newCall:()=>({execute:()=>response})})};
  h.ctx.http={client:()=>({newBuilder:()=>builder}),buildRequest:()=>({}),get:()=>gets++};
  assert.throws(()=>h.ctx.readServerTimeBody('https://example.invalid',1200),/body failed/);
  assert.equal(timeout,1200);assert.equal(closed,1);assert.equal(gets,0);
});

test('总对时预算耗尽后不继续访问其他时间源', () => {
  const h=harness({monotonicClock:true});let requests=0;
  h.ctx.CFG.timeSync.budgetMs=1000;
  h.ctx.http={get:()=>{requests++;h.ctx.sleep(1100);throw new Error('timeout');}};
  h.ctx.syncTime();assert.equal(requests,1);
});

test('前端挤爆提示记录为拒绝线索，不伪造风险返回码', () => {
  const h=harness();
  h.ctx.FIRE_FEEDBACK={samples:[{text:'正在抢'}],messages:[{text:'挤爆了，稍后再试',offsetMs:6975}]};
  const evidence=h.ctx.summarizePageEvidence(h.ctx.FIRE_FEEDBACK,'立即抢');
  assert.equal(evidence.status,'rejection_observed');
  assert.equal(evidence.hints[0].kind,'busy_or_restricted');
  assert.equal(evidence.serviceErrorCode,null);assert.equal(evidence.causeConfirmed,false);
  assert.equal(evidence.processingObserved,true);
});

test('未开始提示不推断风控；没有采样不推断点击无效', () => {
  const h=harness();
  const a=h.ctx.summarizePageEvidence({samples:[],messages:[{text:'本场活动还未开始'}]},'立即抢');
  assert.equal(a.status,'not_started_observed');assert.equal(a.hints[0].kind,'not_started');
  const b=h.ctx.summarizePageEvidence(null,'立即抢');
  assert.equal(b.status,'unconfirmed');assert.equal(b.causeConfirmed,false);
});

test('处理中回落只记录前端转换，不声称请求已发送', () => {
  const h=harness();
  const evidence=h.ctx.summarizePageEvidence({samples:[{text:'正在抢'},{text:'立即抢'}],messages:[]},'立即抢');
  assert.equal(evidence.status,'processing_observed');assert.equal(evidence.returnedToReady,true);
  assert.equal(evidence.serviceErrorCode,null);
});

test('认证成功和普通资格说明不当作拒绝提示', () => {
  const h=harness();
  const evidence=h.ctx.summarizePageEvidence({samples:[],messages:[{text:'学生认证成功'},{text:'活动参与资格说明'}]},'立即抢');
  assert.equal(evidence.status,'unconfirmed');assert.equal(evidence.hints.length,0);
});

test('每次结果独立归档，并保留兼容的最新结果与场次身份', () => {
  const h=harness();const saved={};
  h.ctx.textContains=()=>({exists:()=>false});h.ctx.files.write=(path,body)=>{saved[path]=body;};
  h.ctx.CURRENT_SESSION={label:'14:00',target:TARGET};
  h.ctx.FIRE_FEEDBACK={samples:[],messages:[{text:'挤爆了，稍后再试'}]};
  h.ctx.CLICKS=[{kind:'fire',ok:true}];
  const first=h.ctx.judge('fired'), second=h.ctx.judge('fired');
  assert.equal(first.build,h.ctx.BUILD_ID);assert.equal(first.session.label,'14:00');
  assert.equal(first.pageEvidence.status,'rejection_observed');
  assert.notEqual(first.archivePath,second.archivePath);
  assert(saved[first.archivePath]);assert(saved[second.archivePath]);assert(saved[h.ctx.RESULT_PATH]);
});

test('归档失败保留最新结果并明确记录写入错误', () => {
  const h=harness();const saved={};h.ctx.textContains=()=>({exists:()=>false});
  h.ctx.files.write=(path,body)=>{if(path!==h.ctx.RESULT_PATH)throw new Error('full');saved[path]=body;};
  const result=h.ctx.judge('no_click');
  assert(saved[h.ctx.RESULT_PATH]);assert(result.archiveError.includes('full'));
  assert.equal(result.archiveSaved,false);
});

test('观察器记录采样耗时及完成观察的时间，不改变点击', () => {
  const h=harness();let t=TARGET;
  h.ctx.now=()=>t;h.ctx.monotonicMs=()=>t;h.ctx.sleep=ms=>{t+=ms;};h.ctx.FIRE_PHASE=true;
  h.ctx.readButtonTextFast=()=>{t+=12;return '立即抢';};
  h.ctx.textMatches=()=>({boundsInside(){return this;},findOnce:()=>{t+=30;return null;}});
  const sink={samples:[],messages:[],errors:[],stop:false};
  h.ctx.observeFireFeedback(TARGET,TARGET+1000,sink);
  assert(sink.metrics.iterations>=3);assert.equal(sink.metrics.maxButtonReadMs,12);
  assert.equal(sink.metrics.maxMessageReadMs,30);
  assert.equal(sink.samples[0].observedOffsetMs,12);assert.equal(h.calls.length,0);
});

function real(h,name) {
  const start=fullSource.indexOf('function '+name+'(');
  assert(start>=0,'缺少函数 '+name);
  const next=fullSource.indexOf('\nfunction ',start+1);
  vm.runInContext(fullSource.slice(start,next<0?undefined:next),h.ctx);
}

test('非目标前台禁止关闭弹窗，包括可读关闭节点',()=>{
  const h=harness({wrongPackage:true});
  h.ctx.textContains=()=>({findOnce:()=>({bounds:()=>({left:10,top:10,right:30,bottom:30})})});
  h.ctx.descContains=()=>({findOnce:()=>null});
  h.ctx.dismissPopup();assert.equal(h.calls.length,0);
});
test('关闭节点点击后切出目标应用，不继续盲点',()=>{
  const h=harness();let pkg='me.ele';h.ctx.currentPackage=()=>pkg;
  h.ctx.inActivityPage=()=>false;
  h.ctx.textContains=()=>({findOnce:()=>({bounds:()=>({left:10,top:10,right:30,bottom:30})})});
  const tap=h.ctx.tapAt;h.ctx.tapAt=(...args)=>{const r=tap(...args);pkg='com.huawei.android.launcher';return r;};
  h.ctx.dismissPopup();assert.equal(h.calls.length,1);
});
test('活动页判断不能采信其他应用中的立即抢文字',()=>{
  const h=harness({wrongPackage:true});real(h,'inActivityPage');
  h.ctx.textContains=()=>({exists:()=>true});assert.equal(h.ctx.inActivityPage(),false);
});
test('前台校验优先使用实时活动窗口，事件缓存过期不得放行',()=>{
  const h=harness();
  h.ctx.auto={service:{getRootInActiveWindow:()=>({getPackageName:()=> 'com.huawei.android.launcher',recycle(){}})}};
  assert.equal(h.ctx.foregroundPackage(),'com.huawei.android.launcher');
});
test('获取实时活动窗口失败不回退到过期前台事件',()=>{
  const h=harness();h.ctx.auto={service:{getRootInActiveWindow:()=>null}};
  assert.equal(h.ctx.foregroundPackage(),'');
});
test('无障碍服务失联时不能信任缓存包名继续导航',()=>{
  const h=harness();h.ctx.auto={service:null};
  assert.equal(h.ctx.foregroundPackage(),'');
});
test('App启动优先指定明确组件，并核验前台',()=>{
  const h=harness();let pkg='com.huawei.android.launcher';const attempts=[];
  h.ctx.currentPackage=()=>pkg;
  h.ctx.app={startActivity:opts=>{attempts.push(opts);pkg='me.ele';},launchPackage:()=>{throw new Error('不得先隐式启动');}};
  assert.equal(h.ctx.launchAppForeground(),true);
  assert.equal(attempts[0].className,'me.ele.Launcher');
});
test('拉起失败后立即结束进场，禁止继续入口与弹窗点击',()=>{
  const h=harness({wrongPackage:true});real(h,'bringUpApp');
  h.ctx.launchAppForeground=()=>false;h.ctx.inActivityPage=()=>false;
  h.ctx.tapHomeEntry=()=>{throw new Error('启动失败后仍尝试入口');};
  h.ctx.dismissPopup=()=>{throw new Error('启动失败后仍关闭弹窗');};
  assert.equal(h.ctx.bringUpApp(),false);assert.equal(h.calls.length,0);
});
test('没有进入页面也归档当前场次结果，不能残留上一场作为最新',()=>{
  const h=harness();const saved={};h.ctx.files.write=(p,b)=>{saved[p]=b;};
  h.ctx.ensureActivityPage=()=>false;h.ctx.syncTime=()=>{};
  h.ctx.runSession({label:'14:00',ts:TARGET});
  assert(saved[h.ctx.RESULT_PATH]);const result=JSON.parse(saved[h.ctx.RESULT_PATH]);
  assert.equal(result.verdict,'not_in_page');assert.equal(result.fireCount,0);
  assert.equal(result.session.label,'14:00');assert(saved[result.archivePath]);
});
test('守候执行器在独立非UI脚本启动，不依赖控制页生命周期',()=>{
  const h=harness();const saved={};let executed=null;
  h.ctx.files.read=()=>source+'var UI_OK = true;';h.ctx.files.write=(p,b)=>{saved[p]=b;};
  h.ctx.engines.execScriptFile=p=>{executed=p;return {getEngine:()=>({id:9})};};
  h.ctx.startDaemonWorker();assert.equal(executed,h.ctx.DAEMON_PATH);
  assert(saved[executed]);assert(!saved[executed].includes('ui.layout'));
  assert(saved[executed].includes('daemonLoop()'));
});
test('独立守候在运行时，即使心跳过期也禁止重复启动',()=>{
  const h=harness();h.ctx.engines.myEngine=()=>({id:1});
  h.ctx.engines.all=()=>[{id:2,source:h.ctx.DAEMON_PATH}];
  assert.equal(h.ctx.anotherInstanceAlive(),true);
});
test('守候引擎已消失不能仅凭残留心跳判断运行中',()=>{
  const h=harness();h.ctx.engines.myEngine=()=>({id:1});h.ctx.engines.all=()=>[{id:1,source:'ui.js'}];
  h.ctx.files.exists=()=>true;h.ctx.files.read=()=>String(h.ctx.now());
  assert.equal(h.ctx.anotherInstanceAlive(),false);
});
test('控制页停止操作终止唯一守候并清除自动启动，保留其他脚本',()=>{
  const h=harness();real(h,'actStop');const stopped=[],removed=[];
  h.ctx.engines.myEngine=()=>({id:1});
  h.ctx.engines.all=()=>[
    {id:1,source:'controller.js',forceStop:()=>stopped.push(1)},
    {id:2,source:h.ctx.DAEMON_PATH,forceStop:()=>stopped.push(2)},
    {id:3,source:'another-task.js',forceStop:()=>stopped.push(3)}];
  h.ctx.files.exists=()=>true;h.ctx.files.remove=p=>removed.push(p);h.ctx.BUSY=true;
  h.ctx.actStop();assert.deepEqual(stopped,[2]);assert.equal(h.ctx.BUSY,false);
  assert(removed.includes(h.ctx.AUTOSTART_FLAG));assert(removed.includes(h.ctx.HEART_PATH));
});
test('UI自动启动派发独立守候后关闭控制页',()=>{
  const h=harness();real(h,'actRun');let started=0,finished=0;
  h.ctx.auto={service:{}};h.ctx.HAS_UI=true;h.ctx.ui={finish:()=>finished++};
  h.ctx.engines.all=()=>[];h.ctx.startDaemonWorker=()=>started++;
  h.ctx.actRun(true);assert.equal(started,1);assert.equal(finished,1);
});
test('再次打开控制页不会重复启动独立守候',()=>{
  const h=harness();real(h,'actRun');h.ctx.auto={service:{}};
  h.ctx.engines.myEngine=()=>({id:1});h.ctx.engines.all=()=>[{id:2,source:h.ctx.DAEMON_PATH}];
  h.ctx.startDaemonWorker=()=>{throw new Error('重复派发');};
  h.ctx.actRun(true);assert.equal(h.ctx.BUSY,false);
});
test('手动启动后独立守候消失，原控制页仍可再次启动',()=>{
  const h=harness();real(h,'actRun');let started=0;
  h.ctx.auto={service:{}};h.ctx.HAS_UI=true;h.ctx.ui={finish(){}};
  h.ctx.engines.all=()=>[];h.ctx.startDaemonWorker=()=>started++;
  h.ctx.actRun(true);assert.equal(started,1);
  h.ctx.actRun(true);assert.equal(started,2);
});

let failures=0;
for (const [name,fn] of cases) {
  try {fn(); console.log('PASS '+name);}
  catch(e) {failures++;console.log('FAIL '+name+' | '+e.message);}
}
console.log(`${cases.length-failures}/${cases.length} passed`);
process.exitCode=failures?1:0;

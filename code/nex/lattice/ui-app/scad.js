/* BUILT FILE, do not edit. Source: ui-src/scad/, build: scripts/build-scad.mjs */
(()=>{var A=`
const log = [];
self.onmessage = async (e) => {
  const { glue, mod, files, args, out } = e.data;
  try {
    const OpenSCAD = (await import(glue)).default;
    const inst = await OpenSCAD({
      noInitialRun: true,
      print: (s) => log.push([0, s]),
      printErr: (s) => log.push([1, s]),
      instantiateWasm: (imports, done) => {
        WebAssembly.instantiate(mod, imports).then((i) => done(i, mod));
        return {};
      },
    });
    for (const [p, t] of files) {
      const parts = p.split('/').filter(Boolean);
      let d = '';
      for (const s of parts.slice(0, -1)) {
        d += '/' + s;
        try { inst.FS.mkdir(d); } catch (x) {}
      }
      inst.FS.writeFile(p, t);
    }
    let rc = 0;
    try { rc = inst.callMain(args); }
    catch (x) {
      rc = typeof x === 'number' ? x : (x && typeof x.status === 'number' ? x.status : 1);
      if (!(x && x.name === 'ExitStatus')) log.push([1, 'OpenSCAD stopped: ' + ((x && x.message) || x)]);
    }
    let data = null;
    try { data = inst.FS.readFile(out); } catch (x) {}
    self.postMessage({ rc, log, data }, data ? [data.buffer] : []);
  } catch (x) {
    log.push([1, 'the OpenSCAD runtime failed: ' + ((x && x.message) || x)]);
    self.postMessage({ rc: -1, log, data: null });
  }
};
`;function S({wasm:r,js:s}){let t=null,o=null,e=null,l=()=>t||(t=(async()=>{let n=await fetch(r,{credentials:"same-origin"});if(!n.ok)throw new Error("the runtime answered "+n.status);return WebAssembly.compileStreaming&&/application\/wasm/.test(n.headers.get("content-type")||"")?WebAssembly.compileStreaming(n):WebAssembly.compile(await n.arrayBuffer())})().catch(n=>{throw t=null,n})),c=()=>o||(o=(async()=>{let n=await fetch(s,{credentials:"same-origin"});if(!n.ok)throw new Error("the runtime answered "+n.status);return URL.createObjectURL(new Blob([await n.text()],{type:"text/javascript"}))})().catch(n=>{throw o=null,n})),u=()=>Promise.all([l(),c()]);function g({files:n,args:m,out:y,timeout:d}){d=d||6e4;let p=null,i=0,a,$=performance.now(),k=new Promise(f=>{a=f}),h=f=>{clearTimeout(i),p&&(p.terminate(),p=null);let w=a;a=null,w&&w({ms:Math.round(performance.now()-$),...f})};return u().then(([f,w])=>{a&&(e||(e=URL.createObjectURL(new Blob([A],{type:"text/javascript"}))),p=new Worker(e,{type:"module"}),p.onmessage=x=>h(x.data),p.onerror=x=>h({rc:-1,log:[[1,"the OpenSCAD worker failed: "+(x.message||"out of memory?")]],data:null,error:!0}),i=setTimeout(()=>h({rc:-1,log:[[1,`stopped after ${Math.round(d/1e3)} s`]],data:null,timeout:!0}),d),p.postMessage({glue:w,mod:f,files:n,args:m,out:y}))},f=>h({rc:-1,log:[[1,"could not load the OpenSCAD runtime: "+(f&&f.message||f)]],data:null,error:!0})),{promise:k,cancel:()=>h({rc:-1,log:[],data:null,cancelled:!0})}}return{run:g,ready:u}}var M={depth:8,files:64,bytes:4194304};function T(r){return r.replace(/\b(?:include|use)\s*<[^>\n]*>|\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"/g,s=>/^(include|use)/.test(s)?s:s.replace(/[^\n]/g," "))}function b(r){let s=[],t=T(String(r)),o=/(^|[;\s}])(include|use)\s*<([^>\n]*)>/g,e;for(;e=o.exec(t);){let l=e.index+e[1].length,c=String(r).slice(l,l+e[0].length-e[1].length).replace(/^(include|use)\s*</,"").replace(/>$/,"");s.push({kind:e[2],ref:c,line:t.slice(0,l).split(`
`).length})}return s}function O(r,s){let t=String(s).trim();if(!t)return{error:"an empty include"};if(/^[a-z][a-z0-9+.-]*:/i.test(t)||t.startsWith("/")||t.startsWith("\\")||t.includes("\\"))return{error:`${t}: only lattice pages can be included, by a relative path`};let o=(r?r.split("/"):[]).concat(t.split("/")),e=[];for(let u of o)if(!(u===""||u===".")){if(u===".."){if(!e.length)return{error:`${t}: reaches above the top of your pages`};e.pop();continue}e.push(u)}if(!e.length)return{error:`${t}: names no page`};let l=e.join("/");return{page:l.replace(/\.scad$/i,""),file:"/w/"+l}}var W=r=>r.includes("/")?r.slice(0,r.lastIndexOf("/")):"";async function R(r,s,t,o=M){let e="/w/"+r+".scad",l=new Map([[e,s]]),c=[],u=s.length,g=[{page:r,text:s,depth:0}],n=new Map;for(;g.length;){let{page:m,text:y,depth:d}=g.shift();for(let p of b(y)){let i=O(W(m),p.ref);if(i.error){c.push(`line ${p.line} of ${m}: ${i.error}`);continue}if(l.has(i.file))continue;if(d+1>o.depth){c.push(`${i.page}: includes nest deeper than ${o.depth}, not read`);continue}if(l.size>=o.files){c.push(`more than ${o.files} included files, the rest not read`),g.length=0;break}let a=n.get(i.page);if(a===void 0){try{a=await t(i.page)}catch{a=null}n.set(i.page,a)}if(typeof a=="string"){if(u+a.length>o.bytes){c.push(`${i.page}: the included files pass ${o.bytes>>20} MB, not read`);continue}u+=a.length,l.set(i.file,a),g.push({page:i.page,text:a,depth:d+1})}}}return{main:e,files:[...l.entries()],notes:c}}window.LatScad={makeRunner:S,scanIncludes:b,resolveRef:O,collect:R};})();

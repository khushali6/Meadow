/**
 * Checks written as `node -e "…"` so they behave the same under /bin/sh and cmd.exe. The scripts avoid every
 * character either shell interprets inside double quotes ($ ` \ " %), and paths travel base64-encoded.
 */
export const portableCheck = {
  node(script: string) {
    if (/["$`\\%]/.test(script)) throw new Error("Portable check scripts can't contain shell-sensitive characters.");
    return { cmd: `node -e "const B=s=>Buffer.from(s,'base64').toString();${script}"` };
  },
  arg: (value: string) => `B('${Buffer.from(value).toString("base64")}')`,
  hasTests(dir: string) {
    return portableCheck.node(`const fs=require('fs'),p=require('path');const skip=new Set(['node_modules','.git','dist','build','vendor']);const walk=d=>{let es=[];try{es=fs.readdirSync(d,{withFileTypes:true})}catch(e){return false}return es.some(e=>!skip.has(e.name)&&(e.isDirectory()?walk(p.join(d,e.name)):/test|spec/i.test(e.name)))};process.exit(walk(${portableCheck.arg(dir)})?0:1)`);
  },
  fewerMarkers(file: string, now: number) {
    return portableCheck.node(`let t='';try{t=require('fs').readFileSync(${portableCheck.arg(file)},'utf8')}catch(e){}process.exit((t.match(/TODO|FIXME|HACK|XXX/g)||[]).length<${Math.floor(now)}?0:1)`);
  },
  singleWriter(table: string) {
    const name = table.replace(/[^A-Za-z0-9_]/g, "");
    return portableCheck.node(`const fs=require('fs'),p=require('path');const re=new RegExp('(INSERT INTO|UPDATE) +'+${portableCheck.arg(name)},'i');const skip=new Set(['node_modules','.git','dist','build','vendor']);const owners=new Set();const walk=d=>{let es=[];try{es=fs.readdirSync(d,{withFileTypes:true})}catch(e){return}for(const e of es){if(skip.has(e.name))continue;const f=p.join(d,e.name);if(e.isDirectory())walk(f);else{try{if(fs.statSync(f).size<1e6&&re.test(fs.readFileSync(f,'utf8')))owners.add(p.relative('.',f).split(p.sep).slice(0,2).join('/'))}catch(x){}}}};walk('.');process.exit(owners.size<=1?0:1)`);
  },
  /** Passes when any of `files` differs from HEAD, or (with no files) when anything does. */
  changed(files: string[]) {
    const list = files.map(file => portableCheck.arg(file)).join(",");
    return portableCheck.node(files.length ? `const out=require('child_process').execFileSync('git',['diff','--name-only','HEAD','--',${list}]).toString();process.exit(out.trim()?0:1)` : `const r=require('child_process').spawnSync('git',['diff','--quiet','HEAD']);process.exit(r.status===1?0:1)`);
  },
  minLines(file: string, lines: number) {
    return portableCheck.node(`let n=0;try{n=require('fs').readFileSync(${portableCheck.arg(file)},'utf8').split(String.fromCharCode(10)).length}catch(e){}process.exit(n>=${Math.floor(lines)}?0:1)`);
  },
};

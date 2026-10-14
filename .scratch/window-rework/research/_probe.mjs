function camelToDash(n){return n.replace(/[A-Z]/g,l=>`-${l.toLowerCase()}`)}
class N{
  constructor(tag){this.tag=tag;this.children=[];this._text="";this.parent=null;this.attributes=new Map();this.dataset=new Proxy({},{get:(_,k)=>this.attributes.get(`data-${camelToDash(k)}`),set:(_,k,v)=>{this.attributes.set(`data-${camelToDash(k)}`,String(v));return true;}});}
  get className(){return this.attributes.get("class")??""} set className(v){this.attributes.set("class",v)}
  get textContent(){return this.children.length?this.children.map(c=>c.textContent).join(""):this._text} set textContent(v){this.children.length=0;this._text=String(v)}
  get lastElementChild(){return this.children[this.children.length-1]}
  get firstElementChild(){return this.children[0]}
  append(...ns){for(const n of ns){n.parent=this;this.children.push(n)}}
  remove(){const p=this.parent; if(p){const i=p.children.indexOf(this); if(i>=0)p.children.splice(i,1)}}
  removeChild(n){const i=this.children.indexOf(n);if(i>=0)this.children.splice(i,1)}
  replaceChildren(...ns){this.children.length=0;for(const n of ns){n.parent=this;this.children.push(n)}}
  setAttribute(k,v){this.attributes.set(k,v)} getAttribute(k){return this.attributes.get(k)??null}
  addEventListener(){} set innerHTML(v){}
}
globalThis.document={createElement:(t)=>new N(t),createTextNode:(t)=>{const n=new N("#text");n.textContent=t;return n;}};
Object.defineProperty(globalThis,"navigator",{value:{clipboard:{writeText:()=>Promise.resolve()}},configurable:true,writable:true});
globalThis.window={setTimeout:()=>0};
const { renderMarkdown, parseBlocks } = await import("../../../packages/web/src/render/markdown.ts");

const answer = "# 标题\n\n第一段文字，会逐帧增长。\n\n- 列表一\n- 列表二\n\n```ts\nconst a = 1;\n```\n\n最后一段。";
function domText(root){ const out=[]; const walk=n=>{ if(n.tag==="#text"){out.push(n.textContent)} else { for(const c of n.children) walk(c)} }; walk(root); return out.join(""); }
const c=new N("div"); let state;
const news=[]; for(let i=4;i<answer.length;i+=4) news.push(i);
news.push(answer.length);
for(const i of news){ const t=answer.slice(0,i); state=renderMarkdown(c,t,state); }
// Compare every non-blank-line char of the source to the DOM text (markers/whitespace aside).
const expectedText = answer.split("\n").filter(l=>l.trim().length>0).map(l=>l.replace(/^(#{1,6}\s+)/,"").replace(/^```[a-z]*$/,"").replace(/^[-*]\s+/,"")).join("");
const got = domText(c);
console.log("expected(last block):", JSON.stringify("最后一段。"));
console.log("dom blocks:", c.children.map(ch=>ch.tag+":"+JSON.stringify(ch.textContent)).join(" | "));
console.log("contains last paragraph fully:", c.children.at(-1).textContent === "最后一段。");
console.log("contains 列表二:", got.includes("列表二"), "contains const a = 1;:", got.includes("const a = 1;"));

// ---- differential: incremental vs full re-render, over growing prefixes ----
function serialize(n){ return n.tag+"("+(n.className||"")+")["+JSON.stringify(n._text)+"]{"+ (n.children||[]).map(serialize).join(",")+"}"; }
function build(){ const cont=new N("div"); let st; return { cont, feed(t){ st=renderMarkdown(cont,t,st); return cont; } }; }
function buildFull(){ const cont=new N("div"); return { cont, feed(t){ renderMarkdown(cont,t,undefined); return cont; } }; }
const chunks = [
 "# H1\n\ntext para one\n\n- a\n- b\n- c\n\n```js\nlet x=1;\nlet y=2;\n```\n\n> quote\n> more\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n---\n\nfinal paragraph with `code` and **bold**\n",
 "para A\n\npara B\n\n#### deep\n\n1. one\n2. two\n\n```\nplain\n```\n\ntail ### not heading\n",
 "\n\n\n# after blanks\n\nline1\nline2\nline3\n\n~~~\nfenced tilde\n~~~\n",
];
let mismatches = 0;
for(const source of chunks){
  const inc = build(); const full = buildFull();
  for(let i=1;i<=source.length;i++){
    const t = source.slice(0,i);
    inc.feed(t); full.feed(t);
    const a = serialize(inc.cont.children); const b = serialize(full.cont.children);
    // Compare only structure+text (className may differ due to state reuse of style attrs? no)
    if(a!==b){ mismatches++; if(mismatches<=3){ console.log("MISMATCH at i="+i+" text="+JSON.stringify(t.slice(-12))); console.log(" inc :",a.slice(0,300)); console.log(" full:",b.slice(0,300)); } break; }
  }
}
console.log("differential mismatches:", mismatches);

// exact-length final equality
for(const source of chunks){
  const inc = build(); const full = buildFull();
  for(let i=1;i<=source.length;i+=1){ inc.feed(source.slice(0,i)); }
  full.feed(source);
  console.log("final equal:", serialize(inc.cont.children)===serialize(full.cont.children));
}

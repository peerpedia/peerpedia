import { EditorView, lineNumbers, highlightActiveLine, ViewUpdate } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { bananamark } from 'bananamark-codemirror';
import { defineDialect } from 'bananamark';
import { dialectOptions } from '../../../editor/dialect.js';

type Variant = 'a'|'b'|'c';
type Surface = 'write'|'references'|'publication';
type Mode = 'source'|'split'|'preview';
type Chapter = {id:string; title:string; markdown:string};
type Rendered = {id:string; html:string; title:string};
const chapters: Chapter[] = [
 {id:'introduction',title:'About this note',markdown:String.raw`# About this note

These notes introduce **vertex operator algebras** through their basic structures and examples.

We begin with the state–field correspondence, then study subalgebras and homomorphisms. Each construction preserves the algebraic structure needed in later chapters.

## How to read these notes

Start with the definition in @def:vertex-algebra. Then compare a vertex algebra with its conformal counterpart.

::: remark [A local writing workflow]
Keep the source on your computer. Read the rendered paper alongside it, and publish a version when it is ready.
:::
`},
 {id:'vertex-algebras',title:'Vertex algebras',markdown:String.raw`# Vertex algebras

A vertex algebra packages infinitely many operations into a single **state–field correspondence**.

::: definition [Vertex algebra] {@def:vertex-algebra}
A vertex algebra is a vector space $V$ with a vacuum vector $\mathbf{1}$, a translation operator $T$, and a map

$$
Y(a,z)=\sum_{n\in\mathbb{Z}}a_{(n)}z^{-n-1}.
$$

The vacuum, translation and locality axioms encode the compatibility of these data.
:::

## The vacuum axiom

The vacuum field acts as the identity:

$$
Y(\mathbf{1},z)=\operatorname{id}_V,
\qquad Y(a,z)\mathbf{1}\in a+zV[[z]].
$$

::: proposition [Creation property] {@prop:creation}
For every state $a\in V$, we have $Y(a,z)\mathbf{1}=e^{zT}a$.
:::

::: proof
Apply translation covariance to the vacuum and compare coefficients of $z$.
:::

The identity in @prop:creation will be used throughout the next chapter.
`},
 {id:'constructions',title:'Basic structures',markdown:String.raw`# Basic structures

We study subalgebras and homomorphisms of vertex algebras. Throughout, tensor products are over $\mathbb{C}$.

## Vertex subalgebras

::: definition [Vertex subalgebra] {@def:subalgebra}
A **vertex subalgebra** $U\subseteq V$ contains the vacuum and is closed under all vertex operations:

$$
\mathbf{1}\in U,\qquad Y(u,z)v\in U((z)).
$$
:::

::: proposition [Inherited structure] {@prop:inherited}
Every vertex subalgebra inherits the translation operator and the state–field correspondence from $V$.
:::

::: proof
Use @prop:creation to verify that $U$ is stable under translation. The remaining axioms restrict from $V$.
:::

## Homomorphisms

A linear map $f:U\to V$ is a homomorphism when

$$
f(\mathbf{1}_U)=\mathbf{1}_V,\qquad
f\bigl(Y_U(u,z)v\bigr)=Y_V(f(u),z)f(v).
$$
`},
 {id:'examples',title:'First examples',markdown:String.raw`# First examples

## The trivial vertex algebra

The one-dimensional space $V=\mathbb{C}\mathbf{1}$ is a vertex algebra with $T=0$ and

$$
Y(\lambda\mathbf{1},z)(\mu\mathbf{1})=\lambda\mu\mathbf{1}.
$$

::: example [Commutative algebras]
A commutative algebra $A$ with a derivation $D$ gives a vertex algebra by setting $Y(a,z)b=(e^{zD}a)b$.
:::

This construction makes the translation axiom visible directly.
`}];
let variant: Variant = (['a','b','c'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'a') as Variant;
let current = 1;
let mode: Mode = variant === 'b' ? 'source' : 'split';
let surface: Surface = 'write';
let sidebar = true;
let changed = false;
let published = false;
let editor: EditorView | undefined;
let rendered: Rendered[] = [];
let timer: ReturnType<typeof setTimeout>;
let renderVersion = 0;
let title = 'Introduction to Vertex Operator Algebras';
const app = document.querySelector<HTMLElement>('#app')!;
const dialog = document.querySelector<HTMLDialogElement>('#dialog')!;
const iconPaths: Record<string,string> = {
 book:'M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4z M13 7a3 3 0 0 1 3-3h5v15h-4a4 4 0 0 0-4 2',
 list:'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
 arrow:'M12 19V5M6 11l6-6 6 6',
 plus:'M12 5v14M5 12h14',
 more:'M5 12h.01M12 12h.01M19 12h.01',
 close:'m6 6 12 12M6 18 18 6',
 check:'m5 12 4 4L19 6',
 back:'m14 6-6 6 6 6',
 files:'M4 3h10l4 4v14H4zM14 3v5h4',
 ref:'M9 5H5v14h4M15 5h4v14h-4M10 8l4 8',
 settings:'M4 7h16M4 17h16M8 4v6M16 14v6',
 split:'M3 4h18v16H3zM12 4v16',
 chevron:'m8 10 4 4 4-4'
};
function icon(name:string):string { return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${iconPaths[name] || iconPaths.files}"/></svg>`; }
function escape(value:string):string { return value.replace(/[&<>"']/g,(char:string):string => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!)); }
function button(action:string,label:string,style:string='',glyph:string=''):string { return `<button data-action="${action}" class="${style}">${glyph?icon(glyph):''}${label}</button>`; }
function iconButton(action:string,label:string,glyph:string):string { return `<button data-action="${action}" class="icon-button" aria-label="${label}" title="${label}">${icon(glyph)}</button>`; }
function status():string { return published ? 'Published · demo' : changed ? 'Local changes' : 'Matches downloaded version'; }
function rows():string { return chapters.map((chapter:Chapter,index:number):string => `<div class="chapter-row ${index===current?'active':''}"><button class="chapter" data-chapter="${index}"><span class="number">${String(index+1).padStart(2,'0')}</span><span>${escape(chapter.title)}</span>${index===current?'<i class="chapter-dot"></i>':''}</button>${iconButton('chapter-menu:'+index,'Chapter actions: '+chapter.title,'more')}</div>`).join(''); }
function outline():string { return `<div class="outline-title"><span>MANUSCRIPT</span>${iconButton('add','Add chapter','plus')}</div><nav aria-label="Chapters">${rows()}</nav><div class="outline-bottom">${variant==='c'?'':button('references','References','quiet','ref')}${button('details','Paper details','quiet','settings')}</div><div class="paper-state"><span class="dot"></span><span class="state-text">${status()}</span><small>peerpedia.dev · ChenqiMeng</small></div>`; }
function modeButtons():string { return `<div class="segmented" aria-label="Writing view">${(['source','split','preview'] as Mode[]).map((item:Mode):string => `<button data-mode="${item}" aria-pressed="${mode===item}">${{source:'Source',split:'Split',preview:'Preview'}[item]}</button>`).join('')}</div>`; }
function render():void {
 editor?.destroy(); editor = undefined;
 document.body.dataset.variant = variant;
 document.querySelectorAll<HTMLButtonElement>('[data-variant]').forEach((el:HTMLButtonElement):void => {el.setAttribute('aria-pressed',String(el.dataset.variant===variant));});
 document.querySelector('#concept')!.textContent = {a:'A · 紧凑双栏 — 目录留在右侧，正文与预览并排；低频操作收进菜单。',b:'B · 专注写作 — 默认只有正文；章节、文献和发布按需打开。',c:'C · 任务分区 — 写作、文献、发布各有完整空间；不用挤在同一个侧栏。'}[variant];
 app.className = `workspace ${variant} ${sidebar?'':'hide-outline'} surface-${surface}`;
 const paperButton = button('papers',`<span>${escape(title)}</span>${icon('chevron')}`,'paper-switch','book');
 const toolbar = variant==='b' ? `<div class="focus-top">${button('chapters','Chapters','quiet','list')}<span class="focus-paper">${escape(title)}</span>${button('publish','Publish','publish-button','arrow')}</div>` : `<div class="workspace-top">${paperButton}<span class="local-label"><span class="dot"></span>Saved locally</span>${variant==='c'?'':button('publish','Publish','publish-button','arrow')}</div>`;
 const rail = variant==='c' ? `<nav class="task-rail" aria-label="Paper workspace"><div class="monogram">p.</div>${button('write','Write',surface==='write'?'selected':'','files')}${button('references','References',surface==='references'?'selected':'','ref')}${button('publication','Publish',surface==='publication'?'selected':'','arrow')}<div class="rail-end">CM</div></nav>` : '';
 const manuscript = `<section class="writing"><header class="writing-toolbar"><div class="breadcrumb">${variant==='b'?'<span class="small-caps">CHAPTER '+String(current+1).padStart(2,'0')+'</span>':iconButton('outline','Toggle manuscript outline','list')}<span>${escape(chapters[current].title)}</span></div>${modeButtons()}</header><div class="panes mode-${mode}"><section class="source-pane"><div class="pane-label"><span>Source</span><span>BananaMark</span></div><div id="editor" class="peerpedia-article peerpedia-theme-tokens"></div></section><section class="preview-pane"><div class="pane-label"><span>Paper preview</span><span id="preview-state">Rendering locally…</span></div><iframe id="preview" title="Rendered paper" sandbox="allow-same-origin"></iframe></section></div></section>`;
 const nav = variant!=='b' && surface==='write' ? `<aside class="outline">${outline()}</aside>` : '';
 const content = surface==='write' ? manuscript : surface==='references' ? references() : publication(false);
 app.innerHTML = `${rail}<div class="workspace-body">${toolbar}<div class="workspace-content">${variant==='c'?nav:''}${content}${variant==='a'?nav:''}</div><footer class="statusbar"><span><span class="dot"></span><span id="save-status">${changed?'Demo edits in memory':'Saved locally'}</span></span><span>${variant==='b'?button('references','References','status-action')+button('details','Paper details','status-action'): 'Source mode · BananaMark'}<span class="wordcount">${chapters[current].markdown.split(/\s+/).length} words</span></span></footer></div>`;
 if(surface==='write') mountEditor();
 bind(app);
}
function mountEditor():void {
 editor = new EditorView({parent:document.querySelector('#editor')!,state:EditorState.create({doc:chapters[current].markdown,extensions:[
  lineNumbers(), highlightActiveLine(), EditorView.lineWrapping,
  bananamark({dialect:defineDialect(dialectOptions),locale:'en',lint:false}),
  EditorView.contentAttributes.of({'aria-label':'Manuscript source'}),
  EditorView.updateListener.of((update:ViewUpdate):void => { if(!update.docChanged)return; chapters[current].markdown=update.state.doc.toString(); changed=true;published=false;document.querySelector('#save-status')!.textContent='Demo edits in memory'; const stateLabel=document.querySelector('.state-text');if(stateLabel)stateLabel.textContent=status(); const count=document.querySelector('.wordcount');if(count)count.textContent=chapters[current].markdown.split(/\s+/).length+' words'; clearTimeout(timer);timer=setTimeout(():void=>{void refreshPreview();},350); })
 ]})});
 if(rendered.length) paintPreview();
 void refreshPreview();
}
async function refreshPreview():Promise<void> {
 const version=++renderVersion;
 const pendingLabel=document.querySelector('#preview-state');if(pendingLabel)pendingLabel.textContent='Rendering locally…';
 try {
  const response=await fetch('/render',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pages:chapters})});
  const result=await response.json() as {pages?:Rendered[];error?:string};
  if(version!==renderVersion)return;
  if(!response.ok || !result.pages)throw new Error(result.error || 'Preview unavailable');
  rendered=result.pages;paintPreview();
 } catch(error:unknown) { if(version!==renderVersion)return;const label=document.querySelector('#preview-state');if(label)label.textContent=error instanceof Error?error.message:'Preview unavailable'; }
}
function paintPreview():void {
 const frame=document.querySelector<HTMLIFrameElement>('#preview');
 const page=rendered.find((item:Rendered):boolean=>item.id===chapters[current].id);
 if(!frame||!page)return;
 frame.srcdoc=`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/theme/style.css"><style>html{background:white;color-scheme:light}body{padding:30px 34px;margin:0 auto;max-width:720px}article{font-size:17px!important}article h1{font-size:27px!important}article h2{font-size:23px!important}a{pointer-events:none}</style></head><body><article class="peerpedia-article peerpedia-theme-tokens">${page.html}</article></body></html>`;
 document.querySelector('#preview-state')!.textContent='Up to date';
}
function references():string {return `<section class="full-surface"><div class="surface-heading"><div><span class="eyebrow">PAPER LIBRARY</span><h2>References</h2><p>One bibliography, available in every chapter.</p></div>${button('add-reference','Add reference','primary','plus')}</div><label class="search-field">${icon('ref')}<input aria-label="Search references" placeholder="Search title, author or citation key"></label><div class="reference-list"><button class="reference-item" data-action="edit-reference"><span class="reference-symbol">[1]</span><span><strong>Vertex Algebras for Beginners</strong><small>Victor Kac · 1998 · Book</small><code>@kac1998</code></span>${icon('more')}</button><div class="library-note">Sample reference for this demo. Your vault is not connected.</div></div>${button('write','Back to manuscript','quiet','back')}</section>`;}
function publication(inDialog:boolean):string {return `<section class="${inDialog?'':'full-surface'}"><span class="eyebrow">PEERPEDIA · PUBLICATION</span><h2 id="${inDialog?'dialog-title':'publication-title'}">Publish a version</h2><p class="lede">Review what will go live, then publish when you are ready.</p><div class="publication-paper">${icon('book')}<div><strong>${escape(title)}</strong><small>${chapters.length} chapters · ChenqiMeng · CC BY 4.0</small></div><span class="badge">${status()}</span></div><div class="review-grid"><div><h3>Version summary</h3><label class="field">What changed?<textarea id="summary" placeholder="Describe this version…">Clarify the vacuum axiom and the creation property.</textarea></label><div class="change-line"><span>Vertex algebras</span><span class="change-count">+ 8 − 2</span></div><p class="hint">Illustrative change counts in this demo.</p></div><div class="checks"><h3>Before publishing</h3><p>${icon('check')} Manuscript can be rendered</p><p>${icon('check')} Reference labels are resolved</p><p>${icon('check')} Paper details are complete</p><div class="remote-check"><span id="remote-status">Remote version not checked</span>${button('check-remote','Check now','text-button')}</div></div></div><details class="advanced"><summary>Version history and remote changes</summary><p>Downloaded version · 24 Nov 2026</p>${button('compare','Compare with downloaded version','quiet')}</details><div class="publication-footer"><span>Demo only — no files will be uploaded.</span>${button('confirm-publish','Publish demo version','primary','arrow')}</div></section>`;}
function openDialog(content:string,kind:string=''):void {dialog.className=kind;dialog.innerHTML=`${iconButton('close','Close dialog','close')}${content}`;dialog.showModal();bind(dialog);}
function closeDialog():void {dialog.close();}
function toast(message:string):void {const element=document.querySelector<HTMLElement>('#toast')!;element.textContent=message;element.classList.add('visible');setTimeout(():void=>element.classList.remove('visible'),2600);}
function chapterMenu(index:number):void {
 const chapter=chapters[index];
 openDialog(`<span class="eyebrow">CHAPTER ${index+1}</span><h2 id="dialog-title">${escape(chapter.title)}</h2><div class="menu-list">${button('rename:'+index,'Rename chapter','menu-item')}${index>0?button('move-up:'+index,'Move up','menu-item'):''}${index<chapters.length-1?button('move-down:'+index,'Move down','menu-item'):''}${button('remove:'+index,'Remove from manuscript','menu-item danger')}</div><p class="hint">In Obsidian, this menu also opens from a chapter’s context menu.</p>`,'small-dialog');
}
function bind(container:HTMLElement):void {
 container.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((element:HTMLButtonElement):void=>element.addEventListener('click',():void=>act(element.dataset.action!)));
 container.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((element:HTMLButtonElement):void=>element.addEventListener('click',():void=>{mode=element.dataset.mode as Mode;render();}));
 container.querySelectorAll<HTMLButtonElement>('[data-chapter]').forEach((element:HTMLButtonElement):void=>element.addEventListener('click',():void=>{current=Number(element.dataset.chapter);surface='write';closeDialog();render();}));
 const search=container.querySelector<HTMLInputElement>('[aria-label="Search references"]');
 search?.addEventListener('input',():void=>{const item=container.querySelector<HTMLElement>('.reference-item')!;item.hidden=!item.textContent!.toLowerCase().includes(search.value.toLowerCase());});
}
function act(action:string):void {
 const [name,value]=action.split(':');const index=Number(value);
 if(name==='close'){closeDialog();return;}
 if(name==='write'){surface='write';closeDialog();render();return;}
 if(name==='outline'){sidebar=!sidebar;render();return;}
 if(name==='chapters'){openDialog(`<span class="eyebrow">MANUSCRIPT</span><h2 id="dialog-title">Your chapters</h2>${rows()}<div class="dialog-footer">${button('add','Add chapter','quiet','plus')}${button('papers','Switch paper','quiet')}</div>`,'chapter-dialog');return;}
 if(name==='chapter-menu'){chapterMenu(index);return;}
 if(name==='publish'||name==='publication'){if(variant==='c'){surface='publication';render();}else openDialog(publication(true),'publication-dialog');return;}
 if(name==='references'){if(variant==='b'){openDialog(`<h2 id="dialog-title" class="sr-only">References</h2>${references()}`,'reference-dialog');}else{surface='references';render();}return;}
 if(name==='check-remote'){document.querySelector('#remote-status')!.textContent='No newer version · simulated';toast('Demo check complete. No network request to Peerpedia.');return;}
 if(name==='confirm-publish'){published=true;changed=false;closeDialog();surface='write';render();toast('Demo version published. Nothing was uploaded.');return;}
 if(name==='compare'){openDialog(`<h2 id="dialog-title">Compare versions</h2><p class="hint">Illustrative excerpt · downloaded → local</p><div class="diff"><del>A vertex algebra has a vacuum.</del><ins>A vertex algebra has a distinguished vacuum vector.</ins></div><div class="dialog-footer">${button('close','Back to writing','primary')}</div>`);return;}
 if(name==='details'){openDialog(`<span class="eyebrow">PAPER DETAILS</span><h2 id="dialog-title">About this paper</h2><label class="field">Title<input id="paper-title" value="${escape(title)}"></label><label class="field">Authors<input value="ChenqiMeng"></label><label class="field">Abstract<textarea>Notes on vertex algebras, their structure and their first examples.</textarea></label><div class="form-columns"><label class="field">Subject<select><option>Mathematics</option><option>Physics</option></select></label><label class="field">License<select><option>CC BY 4.0</option></select></label></div><div class="dialog-footer">${button('save-details','Save changes','primary')}</div>`);return;}
 if(name==='save-details'){title=document.querySelector<HTMLInputElement>('#paper-title')!.value.trim()||title;changed=true;closeDialog();render();toast('Paper details updated in this demo.');return;}
 if(name==='papers'){openDialog(`<span class="eyebrow">YOUR PAPERS</span><h2 id="dialog-title">Open a paper</h2><div class="paper-choice">${icon('book')}<div><strong>${escape(title)}</strong><small>Current paper · ${chapters.length} chapters</small></div>${icon('check')}</div><div class="dialog-footer">${button('new-paper','New paper','quiet','plus')}${button('import','Import from Peerpedia','quiet')}</div>`);return;}
 if(name==='import'){openDialog(`<h2 id="dialog-title">Import a paper</h2><p class="lede">Start from a published version and continue writing locally.</p><label class="field">Peerpedia paper URL<input placeholder="https://peerpedia.dev/…"></label><div class="dialog-footer">${button('import-demo','Import sample paper','primary')}</div><p class="hint">This demo uses sample content and makes no remote request.</p>`);return;}
 if(name==='import-demo'){closeDialog();toast('Sample paper is already open. Your vault is unchanged.');return;}
 if(name==='new-paper'){openDialog(`<h2 id="dialog-title">New paper</h2><label class="field">Paper title<input id="new-title" placeholder="Untitled paper"></label><div class="dialog-footer">${button('create-demo','Create paper','primary')}</div>`);return;}
 if(name==='create-demo'){title=document.querySelector<HTMLInputElement>('#new-title')!.value.trim()||'Untitled paper';chapters.splice(0,chapters.length,{id:'new',title:'Introduction',markdown:'# Introduction\n\nStart writing here.\n'});current=0;changed=true;closeDialog();render();return;}
 if(name==='add'||name==='rename'){openDialog(`<h2 id="dialog-title">${name==='add'?'Add a chapter':'Rename chapter'}</h2><label class="field">Chapter title<input id="chapter-title" value="${name==='rename'?escape(chapters[index].title):''}" placeholder="Chapter title"></label><div class="dialog-footer">${button(name==='add'?'save-add':'save-rename:'+index,'Save chapter','primary')}</div>`,'small-dialog');return;}
 if(name==='save-add'||name==='save-rename'){
  const label=document.querySelector<HTMLInputElement>('#chapter-title')!.value.trim();if(!label)return;
  if(name==='save-add'){chapters.push({id:'chapter-'+Date.now(),title:label,markdown:'# '+label+'\n\n'});current=chapters.length-1;}
  else{chapters[index].title=label;chapters[index].markdown=chapters[index].markdown.replace(/^# .+$/m,'# '+label);}
  changed=true;closeDialog();render();return;
 }
 if(name==='move-up'||name==='move-down'){const active=chapters[current];const target=index+(name==='move-up'?-1:1);const [chapter]=chapters.splice(index,1);chapters.splice(target,0,chapter);current=chapters.indexOf(active);changed=true;closeDialog();render();return;}
 if(name==='remove'){openDialog(`<h2 id="dialog-title">Remove this chapter?</h2><p>${escape(chapters[index].title)} will leave this demo’s manuscript.</p><p class="hint">In Obsidian, the source file stays in your vault.</p><div class="dialog-footer">${button('close','Keep chapter','quiet')}${button('confirm-remove:'+index,'Remove chapter','danger-button')}</div>`,'small-dialog');return;}
 if(name==='confirm-remove'){if(chapters.length===1){toast('Keep at least one chapter.');return;}chapters.splice(index,1);current=Math.min(current,chapters.length-1);changed=true;closeDialog();render();return;}
 if(name==='add-reference'||name==='edit-reference'){openDialog(`<span class="eyebrow">BIBLIOGRAPHY</span><h2 id="dialog-title">${name==='add-reference'?'Add reference':'Edit reference'}</h2><label class="field">Citation key<input value="kac1998"></label><label class="field">Title<input value="Vertex Algebras for Beginners"></label><div class="form-columns"><label class="field">Author<input value="Victor Kac"></label><label class="field">Year<input value="1998"></label></div><label class="field">URL or DOI<input placeholder="https://…"></label><div class="dialog-footer">${button('save-reference','Save reference','primary')}</div><p class="hint">This form demonstrates the flow; entries are sample data.</p>`);return;}
 if(name==='save-reference'){closeDialog();toast('Reference form completed · simulated.');return;}
}
document.querySelectorAll<HTMLButtonElement>('[data-variant]').forEach((element:HTMLButtonElement):void=>element.addEventListener('click',():void=>{variant=element.dataset.variant as Variant;location.hash=variant;mode=variant==='b'?'source':'split';surface='write';sidebar=true;closeDialog();render();}));
dialog.addEventListener('click',(event:MouseEvent):void=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeDialog();}});
document.addEventListener('keydown',(event:KeyboardEvent):void=>{if(event.key==='Escape'&&dialog.open)closeDialog();});
render();

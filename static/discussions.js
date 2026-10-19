(() => {
  "use strict";
  const configNode = document.getElementById("discussion-config");
  if (!configNode) return;
  const config = JSON.parse(configNode.textContent);
  const paper = document.getElementById("paper-text");
  const panel = document.getElementById("discussion-panel");
  const body = document.getElementById("discussion-body");
  const message = document.getElementById("discussion-message");
  const opener = document.getElementById("discussions-open");
  const popover = document.getElementById("passage-selection");
  const blockNodes = [...paper.querySelectorAll("[data-passage]")];
  const byBlock = new Map(blockNodes.map(n => [n.dataset.passage, n]));
  for (const table of blockNodes.filter(n=>n.tagName==="TABLE")) {
    const wrap=document.createElement("div"); wrap.className="passage-table-wrap";
    table.before(wrap); wrap.append(table);
  }
  const csrf = document.querySelector("[name=csrfmiddlewaretoken]").value;
  let anchors = [], selected = [], activeId = null, ownPRs = [], requestSerial = 0;
  const drafts = new Map();
  const length = text => Array.from(text).length;
  const node = (tag, text, cls) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (cls) el.className = cls;
    return el;
  };
  const button = (text, action, cls) => {
    const el = node("button", text, cls);
    el.type = "button";
    el.addEventListener("click", () => Promise.resolve(action(el)).catch(error => { message.textContent = error.message; }));
    return el;
  };
  const link = (text, href) => { const el = node("a", text); el.href = href; return el; };
  async function api(url, data) {
    const response = await fetch(url, data === undefined ? {credentials:"same-origin"} :
      {method:"POST", credentials:"same-origin", headers:{"Content-Type":"application/json","X-CSRFToken":csrf}, body:JSON.stringify(data)});
    let result;
    try { result = await response.json(); } catch { throw new Error("Could not load this discussion. Please try again."); }
    if (!response.ok) throw new Error(result.error || "Could not save. Your text is still here; please try again.");
    return result;
  }
  const commentURL = (id, action) => "/discussion-comments/" + id + "/" + action + "/";
  function openPanel() {
    panel.hidden = false; document.body.classList.add("discussions-open"); opener.setAttribute("aria-expanded","true"); popover.hidden = true; message.textContent = "";
  }
  function closePanel() {
    ++requestSerial;
    panel.hidden = true; document.body.classList.remove("discussions-open"); opener.setAttribute("aria-expanded","false");
    if (globalThis.CSS?.highlights) CSS.highlights.delete("passage-active");
    opener.focus();
  }
  document.getElementById("discussions-close").addEventListener("click", closePanel);
  document.addEventListener("keydown", event => { if (event.key === "Escape" && !panel.hidden) closePanel(); });
  opener.addEventListener("click", () => { openPanel(); showLocations(anchors); });

  // Canonical units ignore UI and MathJax's generated accessibility/rendering trees.
  function units(block) {
    const result = [];
    function walk(n) {
      if (n.nodeType === Node.TEXT_NODE) { result.push({node:n,text:n.data,atom:false}); return; }
      if (n.nodeType !== Node.ELEMENT_NODE || n.matches(".section-edit,.passage-marker,.passage-block-action")) return;
      if (n.hasAttribute("data-passage-math")) { result.push({node:n,text:n.dataset.passageMath,atom:true}); return; }
      if (n.tagName === "BR") { result.push({node:n,text:"\n",atom:true}); return; }
      for (const child of n.childNodes) walk(child);
    }
    for (const child of block.childNodes) walk(child);
    return result;
  }
  function selectedSpans(range) {
    const result = [];
    for (const block of blockNodes) {
      if (!range.intersectsNode(block)) continue;
      const all = block.dataset.passageText;
      if (block.dataset.passageKind !== "text") {
        result.push({block:block.dataset.passage,start:0,end:length(all)}); continue;
      }
      const pieces = units(block);
      if (pieces.map(u => u.text).join("") !== all) continue; // Never guess offsets.
      let cursor = 0, start = null, end = null;
      for (const u of pieces) {
        const size = length(u.text);
        if (range.intersectsNode(u.node)) {
          let a = 0, b = size;
          if (!u.atom) {
            if (range.startContainer === u.node) a = length(u.text.slice(0,range.startOffset));
            if (range.endContainer === u.node) b = length(u.text.slice(0,range.endOffset));
          }
          if (b > a) { if (start === null) start = cursor + a; end = cursor + b; }
        }
        cursor += size;
      }
      if (start !== null && end > start) result.push({block:block.dataset.passage,start,end});
    }
    return result;
  }
  function quote(spans) {
    return spans.map(s => Array.from(byBlock.get(s.block).dataset.passageText).slice(s.start,s.end).join("")).join("\n\n");
  }
  function selectFromPage() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) { popover.hidden = true; return; }
    const range = selection.getRangeAt(0);
    if (!paper.contains(range.commonAncestorContainer)) { popover.hidden = true; return; }
    const spans = selectedSpans(range);
    if (!spans.length || spans.length > 50 || length(quote(spans)) > 12000) { popover.hidden = true; return; }
    selected = spans;
    const rect = range.getBoundingClientRect();
    popover.style.left = Math.max(8, Math.min(innerWidth-165, rect.left)) + "px";
    popover.style.top = Math.max(8, Math.min(innerHeight-48, rect.bottom+8)) + "px";
    popover.hidden = false;
  }
  paper.addEventListener("pointerup", () => setTimeout(selectFromPage, 20));
  paper.addEventListener("keyup", selectFromPage);
  let selectionTimer;
  document.addEventListener("selectionchange", () => {
    clearTimeout(selectionTimer);
    if (window.getSelection()?.isCollapsed) popover.hidden = true;
    else selectionTimer=setTimeout(selectFromPage,80);
  });
  window.addEventListener("scroll",()=>{popover.hidden=true;},true);
  popover.addEventListener("pointerdown", event => event.preventDefault());
  popover.addEventListener("click", () => showSelection(selected));
  function point(u, offset, end) {
    if (!u.atom) return [u.node, Array.from(u.text).slice(0,offset).join("").length];
    const parent = u.node.parentNode, index = [...parent.childNodes].indexOf(u.node);
    return [parent,index + (end ? 1 : 0)];
  }
  function rangeFor(span) {
    const block = byBlock.get(span.block);
    if (!block) return null;
    const r = document.createRange();
    if (block.dataset.passageKind !== "text") { r.selectNodeContents(block); return r; }
    const parts = units(block); let cursor = 0, started = false;
    for (const u of parts) {
      const end = cursor + length(u.text);
      if (!started && span.start < end) { r.setStart(...point(u, span.start-cursor, false)); started = true; }
      if (started && span.end <= end) { r.setEnd(...point(u,span.end-cursor,true)); return r; }
      cursor = end;
    }
    return null;
  }
  function highlight(spans, name) {
    if (!globalThis.CSS?.highlights || !globalThis.Highlight) return;
    const ranges = spans.map(rangeFor).filter(Boolean);
    CSS.highlights.set(name, new Highlight(...ranges));
  }
  function focusAnchor(anchor) {
    highlight(anchor.spans, "passage-active");
    const block = byBlock.get(anchor.spans[0]?.block);
    if (block) block.scrollIntoView({behavior:"smooth",block:"center"});
  }
  async function refreshIndex() {
    const loaded = []; let at = 0;
    do {
      const data = await api(config.index + "?offset=" + at);
      loaded.push(...data.passages); at = data.next;
    } while (at !== null);
    anchors = loaded;
    document.getElementById("discussion-count").textContent = anchors.length ? anchors.reduce((n,a) => n+a.count,0) : "";
    paper.querySelectorAll(".passage-marker").forEach(n => n.remove());
    blockNodes.forEach(n => n.classList.remove("has-discussion"));
    const groups = new Map();
    for (const a of anchors) for (const s of a.spans) {
      if (!groups.has(s.block)) groups.set(s.block,[]);
      if (!groups.get(s.block).includes(a)) groups.get(s.block).push(a);
    }
    for (const [id, group] of groups) {
      const block = byBlock.get(id); if (!block) continue;
      block.classList.add("has-discussion");
      const count = group.reduce((n,a) => n+a.count,0);
      const marker = button(String(count), () => { openPanel(); return group.length === 1 ? showPassage(group[0]) : showLocations(group); }, "passage-marker");
      marker.setAttribute("aria-label",count + (count===1?" comment":" comments") + " on this passage");
      // Table child buttons are invalid HTML; position its control just outside.
      if (block.tagName === "TABLE") { block.parentNode.append(marker); }
      else block.append(marker);
    }
    highlight(anchors.filter(a => a.state === "current").flatMap(a => a.spans), "passage-discussions");
  }
  function description(a) {
    if (a.state !== "current") return "Earlier version · " + a.count + " comments · ratings do not apply here";
    return (a.average === null ? "No ratings" : a.average.toFixed(1) + " / 5 · " + a.ratings + " rating" + (a.ratings===1?"":"s")) + " · " + a.count + (a.count===1?" comment":" comments");
  }
  function showLocations(list) {
    ++requestSerial; activeId = null; body.replaceChildren();
    body.append(node("p","Select a passage to rate it and start a discussion. Equations and tables are discussed as a whole.","discussion-intro"));
    if (!list.length) body.append(node("p","No discussions yet.","discussion-muted"));
    for (const a of list) {
      const item = button("", () => { focusAnchor(a); return showPassage(a); }, "discussion-location");
      item.append(node("span",a.quote.slice(0,220) + (a.quote.length>220?"…":""),"discussion-quote"),node("span",description(a),"discussion-muted")); body.append(item);
    }
  }
  function signin(container) {
    const p = node("p","A verified account is needed to comment or vote. ","discussion-muted");
    p.append(link("Sign in",config.login)); container.append(p);
  }
  function form(container, options) {
    if (!config.participate) { signin(container); return; }
    const f = node("form",undefined,"discussion-form");
    f.append(node("label", options.title));
    const draftKey = options.key || options.title;
    const saved = drafts.get(draftKey);
    let score = saved?.score ?? options.score ?? 0;
    const stars = node("div",undefined,"discussion-stars");
    if (options.rating) {
      const starButtons = [1,2,3,4,5].map(value => {
        const b = button("★", () => { score=value; update(); drafts.set(draftKey,{text:input.value,score}); });
        b.setAttribute("aria-label",value + (value===1?" star":" stars")); return b;
      });
      function update() { starButtons.forEach((b,i) => b.setAttribute("aria-pressed",String(i<score))); }
      update(); stars.append(...starButtons); f.append(stars);
    }
    const input = node("textarea"); input.value = saved?.text ?? options.text ?? ""; input.maxLength = options.limit || 5000; input.required = true; input.setAttribute("aria-label",options.title);
    input.addEventListener("input",()=>drafts.set(draftKey,{text:input.value,score}));
    const actions = node("div",undefined,"discussion-actions");
    const submit = node("button",options.submit || "Post comment","primary"); submit.type="submit";
    actions.append(submit);
    if (options.cancel) actions.append(button("Cancel", () => { drafts.delete(draftKey); f.remove(); }));
    f.append(input,actions);
    f.addEventListener("submit", async event => {
      event.preventDefault(); message.textContent = "";
      if (options.rating && !score) { message.textContent="Choose a rating from 1 to 5."; return; }
      submit.disabled=true;
      try { await options.save(input.value,score); drafts.delete(draftKey); } catch(error) { message.textContent=error.message; } finally { submit.disabled=false; }
    });
    container.append(f); return f;
  }
  function showSelection(spans) {
    openPanel(); ++requestSerial; activeId=null;
    const exact = anchors.find(a => a.state==="current" && JSON.stringify(a.spans)===JSON.stringify(spans));
    if (exact) { showPassage(exact).catch(error=>{message.textContent=error.message;}); return; }
    body.replaceChildren(button("← All discussions",()=>showLocations(anchors)), node("blockquote",quote(spans)));
    highlight(spans,"passage-active");
    form(body,{key:config.create+JSON.stringify(spans),title:"Rate this passage and explain why",rating:true,save:async(text,score)=>{
      const result=await api(config.create,{spans,text,score}); await refreshIndex(); await showPassage(anchors.find(a=>a.id===result.passage));
    }});
    const overlaps = anchors.filter(a => a.spans.some(s => spans.some(t=>s.block===t.block && s.start<t.end && t.start<s.end)));
    if (overlaps.length) {
      body.append(node("p","Related discussions on overlapping passages","discussion-muted"));
      for (const a of overlaps) body.append(button(a.quote.slice(0,85)+"…",()=>showPassage(a),"discussion-location"));
    }
  }
  async function showPassage(anchor) {
    if (!anchor) return;
    openPanel(); activeId=anchor.id;
    const serial=++requestSerial;
    const data=await api("/passages/"+anchor.id+"/");
    if (serial !== requestSerial) return;
    ownPRs=data.own_prs;
    body.replaceChildren(button("← All discussions",()=>showLocations(anchors)),node("blockquote",anchor.quote),node("p",description(anchor),"discussion-muted"));
    const origin=node("p",undefined,"discussion-muted"); origin.append(link("Original version "+anchor.original_version,anchor.original_url)); body.append(origin);
    if (anchor.state!=="current") body.append(node("p","This passage changed or could not be matched confidently. The discussion and its ratings belong to the original version.","discussion-intro"));
    const threadList=node("div"); body.append(threadList);
    data.threads.forEach(c=>threadList.append(thread(c,anchor)));
    addMoreRoots(body,threadList,data.next,anchor);
    if (data.own_rating) body.append(node("p","You have already rated this passage. Open ⋯ on your comment and choose Edit to change your rating.","discussion-muted"));
    if (anchor.state==="current" && !data.own_rating) form(body,{key:config.create+JSON.stringify(anchor.spans),title:"Your rating and comment",rating:true,save:async(text,score)=>{
      await api(config.create,{spans:anchor.spans,text,score}); await reload(anchor);
    }});
  }
  async function reload(anchor) { await refreshIndex(); await showPassage(anchors.find(a=>a.id===anchor.id) || anchor); }
  function addMoreRoots(container,list,next,anchor) {
    if (next===null) return;
    container.append(button("More discussions",async b=>{
      b.disabled=true;
      try { const data=await api("/passages/"+anchor.id+"/?offset="+next); data.threads.forEach(c=>list.append(thread(c,anchor))); b.remove(); addMoreRoots(container,list,data.next,anchor); }
      finally { b.disabled=false; }
    }));
  }
  function thread(root,anchor) {
    const wrap=node("section",undefined,"discussion-thread");
    wrap.append(node("span",root.state,"discussion-state"),comment(root,anchor));
    for (const pr of root.links) { const p=node("p",undefined,"discussion-links"); p.append(link(pr.label || "Linked PR",pr.url),node("span"," · "+pr.status)); wrap.append(p); }
    const list=node("div"); root.replies.forEach(c=>list.append(comment(c,anchor))); wrap.append(list);
    const more = next => {
      if (next===null) return;
      wrap.append(button("More replies",async b=>{
        b.disabled=true;
        try { const data=await api(commentURL(root.id,"replies")+"?offset="+next); data.replies.forEach(c=>list.append(comment(c,anchor))); b.remove(); more(data.next); }
        finally { b.disabled=false; }
      }));
    }; more(root.next_replies);
    return wrap;
  }
  function comment(c,anchor) {
    const el=node("article",undefined,"discussion-comment"); el.style.setProperty("--depth",Math.min(c.depth,3)); el.dataset.comment=c.id;
    const author=node("div",undefined,"discussion-author");
    author.append(node("span",c.author));
    if (c.score!==null) author.append(node("span","★ "+c.score+" / 5","discussion-muted"));
    if (c.reply_to) author.append(node("span","replying to "+c.reply_to,"discussion-muted"));
    author.append(node("span",new Date(c.created).toLocaleDateString()+(c.edited?" · edited":""),"discussion-muted"));
    el.append(author,node("p",c.text,"discussion-text"));
    const actions=node("div",undefined,"discussion-actions discussion-comment-actions");
    const more=node("details",undefined,"discussion-more");
    const summary=node("summary","…");
    summary.setAttribute("aria-label","More actions");
    summary.title="More actions";
    const menu=node("div",undefined,"discussion-more-items");
    more.append(summary,menu);
    more.addEventListener("toggle",()=>{
      if (!more.open) return;
      panel.querySelectorAll(".discussion-more[open]").forEach(other=>{if(other!==more) other.open=false;});
      menu.scrollIntoView({block:"nearest"});
    });
    const secondary=(label,action)=>{
      const item=button(label,()=>{
        more.open=false;
        summary.focus({preventScroll:true});
        return action();
      });
      if(label==="Delete") item.classList.add("discussion-delete-action");
      menu.append(item);
    };
    const write=async(action,data)=>{ await api(commentURL(c.id,action),data); await reload(anchor); };
    if (!c.unavailable) for (const [value,count] of [[1,c.up],[-1,c.down]]) {
      const b=button("",async b=>{
        if (!config.participate) { signin(el); return; }
        b.disabled=true; try { await write("vote",{value:c.vote===value?0:value}); } finally { b.disabled=false; }
      });
      b.className="discussion-vote";
      const icon=document.createElementNS("http://www.w3.org/2000/svg","svg");
      icon.setAttribute("viewBox","0 0 24 24");
      icon.setAttribute("aria-hidden","true");
      icon.setAttribute("fill","none");
      icon.setAttribute("stroke","currentColor");
      icon.setAttribute("stroke-width","1.6");
      icon.setAttribute("stroke-linecap","round");
      icon.setAttribute("stroke-linejoin","round");
      const path=document.createElementNS(icon.namespaceURI,"path");
      path.setAttribute("d","M7 10v11H3V10h4Zm0 0 5-8a3 3 0 0 1 2 3l-1 5h6a2 2 0 0 1 2 2l-2 7a3 3 0 0 1-3 2H7");
      icon.append(path);
      if(value===-1) icon.style.transform="rotate(180deg)";
      b.append(icon,node("span",String(count)));
      b.setAttribute("aria-label",(value===1?"Helpful":"Not helpful")+": "+count);
      b.setAttribute("aria-pressed",String(c.vote===value)); actions.append(b);
    }
    const compose=(key,options)=>{
      const existing=el.querySelector('[data-compose="'+key+'"]');
      if (existing) { existing.querySelector("textarea")?.focus(); return; }
      const f=form(el,{...options,key:c.id+key,cancel:true}); if(f) { f.dataset.compose=key; f.querySelector("textarea").focus(); }
    };
    actions.append(button("Reply",()=>compose("reply",{title:"Reply to "+c.author,submit:"Post reply",save:text=>write("reply",{text})})));
    if (c.can_edit) {
      secondary("Edit",()=>compose("edit",{title:"Edit your comment",rating:c.parent===null,score:c.score,text:c.text,submit:"Save changes",save:(text,score)=>write("edit",{text,score,revision:c.revision})}));
      secondary("Delete",()=>{
        if(el.querySelector(".discussion-delete")) return;
        const confirm=node("div",undefined,"discussion-form discussion-delete");
        confirm.append(node("p","Delete your comment? Replies remain visible."),button("Delete comment",()=>write("edit",{delete:true,revision:c.revision})),button("Cancel",()=>confirm.remove())); el.append(confirm);
      });
    }
    if (c.can_resolve) secondary(c.resolved?"Reopen":"Resolve",()=>write("resolve",{resolved:!c.resolved}));
    if (!c.unavailable && c.edited) secondary("History",async()=>{
      if(el.querySelector(".discussion-history")) { el.querySelector(".discussion-history").remove(); return; }
      const history=node("div",undefined,"discussion-history"); el.append(history);
      async function load(at) {
        const data=await api(commentURL(c.id,"history")+"?offset="+at);
        for(const r of data.revisions) history.append(node("strong","Revision "+r.number+(r.score===null?"":" · ★ "+r.score)),node("p",r.text));
        if(data.next!==null) history.append(button("Earlier edits",async b=>{ b.remove(); await load(data.next); }));
      } await load(0);
    });
    if (!c.unavailable && config.participate) {
      secondary("Report",()=>compose("report",{title:"Report to an administrator",limit:2000,submit:"Send report",save:async reason=>{
        await api(commentURL(c.id,"report"),{reason}); el.querySelector('[data-compose="report"]')?.remove(); message.textContent="Report sent to the administrator.";
      }}));
      if(!c.parent && ownPRs.length) secondary("Link a PR",()=>{
        if(el.querySelector(".discussion-link-form")) return;
        const area=node("div",undefined,"discussion-form discussion-link-form"), select=node("select");
        select.setAttribute("aria-label","Your PR");
        for(const p of ownPRs){ const option=node("option",p.label||p.id); option.value=p.id; select.append(option); }
        area.append(node("label","Link a change you submitted"),select,button("Link PR",()=>write("link_pr",{pr:select.value})),button("Cancel",()=>area.remove())); el.append(area);
      });
    }
    const deletion=menu.querySelector(".discussion-delete-action");
    if(deletion) menu.append(deletion);
    if(menu.childElementCount) actions.append(more);
    el.append(actions); return el;
  }
  document.addEventListener("click",event=>{
    panel.querySelectorAll(".discussion-more[open]").forEach(more=>{if(!more.contains(event.target)) more.open=false;});
  });
  panel.addEventListener("keydown",event=>{
    if(event.key!=="Escape") return;
    const opened=panel.querySelector(".discussion-more[open]");
    if(opened){event.stopPropagation();opened.open=false;opened.querySelector("summary").focus();}
  });
  for (const block of blockNodes.filter(n=>n.dataset.passageKind!=="text")) {
    const b=button("＋",()=>showSelection([{block:block.dataset.passage,start:0,end:length(block.dataset.passageText)}]),"passage-block-action");
    b.setAttribute("aria-label","Discuss this "+block.dataset.passageKind); b.title="Discuss this "+block.dataset.passageKind;
    if(block.tagName==="TABLE"){block.parentNode.append(b);}
    else block.append(b);
  }
  refreshIndex().then(()=>{
    const id=new URL(location.href).searchParams.get("discussion");
    if(id){const a=anchors.find(a=>a.id===id);if(a){focusAnchor(a);return showPassage(a);}}
  }).catch(error=>{opener.addEventListener("click",()=>{message.textContent=error.message;},{once:true});});
})();

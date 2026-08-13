export const SNAPSHOT_SCRIPT = String.raw`(() => {
  const state = globalThis.__maxxBrowser ??= { next: 1, refToElement: new Map(), elementToRef: new WeakMap() };
  const referenceFor = (element) => {
    let reference = state.elementToRef.get(element);
    if (!reference) {
      reference = "e" + state.next++;
      state.elementToRef.set(element, reference);
      state.refToElement.set(reference, element);
    }
    return reference;
  };
  const visible = (element) => {
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0
      && rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth;
  };
  const roleFor = (element) => {
    if (element.getAttribute("role")) return element.getAttribute("role");
    if (element.tagName === "INPUT") return ({ button: "button", submit: "button", reset: "button", checkbox: "checkbox",
      radio: "radio", range: "slider", number: "spinbutton", search: "searchbox" })[element.type] || "textbox";
    return ({ A: "link", BUTTON: "button", TEXTAREA: "textbox", SELECT: "combobox", SUMMARY: "button" })[element.tagName]
      || element.tagName.toLowerCase();
  };
  const nameFor = (element) => {
    const labelledBy = (element.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
      .map((id) => element.ownerDocument.getElementById(id)?.innerText || "").join(" ").trim();
    return labelledBy || element.getAttribute("aria-label") || element.getAttribute("title")
      || element.labels?.[0]?.innerText || element.innerText || element.getAttribute("placeholder") || element.getAttribute("alt") || "";
  };
  const selector = ["a[href]", "button", "input", "textarea", "select", "summary", "[role]", "[contenteditable=true]", "[tabindex]"].join(",");
  const elements = [];
  const text = [];
  const collectText = (root) => {
    const owner = root.nodeType === Node.DOCUMENT_NODE ? root : root.ownerDocument;
    if (!owner) return;
    const base = root.nodeType === Node.DOCUMENT_NODE ? root.body : root;
    if (!base) return;
    const walker = owner.createTreeWalker(base, NodeFilter.SHOW_TEXT);
    let length = 0;
    while (walker.nextNode() && length < 12000) {
      const raw = walker.currentNode.nodeValue?.replace(/\s+/g, " ").trim();
      const parent = walker.currentNode.parentElement;
      if (raw && parent && visible(parent)) { text.push(raw); length += raw.length + 1; }
    }
  };
  const visit = (root) => {
    if (!root || elements.length >= 160) return;
    const documentForRoot = root.nodeType === Node.DOCUMENT_NODE ? root : root.ownerDocument;
    collectText(root);
    for (const element of root.querySelectorAll("*")) {
      if (elements.length < 160 && element.matches(selector) && visible(element)) {
        elements.push({ reference: referenceFor(element), role: roleFor(element), name: nameFor(element).trim().slice(0, 240) || null,
          value: "value" in element ? String(element.value).slice(0, 500) : element.isContentEditable ? String(element.textContent || "").slice(0, 500) : null,
          disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"), focused: element === documentForRoot.activeElement });
      }
      if (element.shadowRoot) visit(element.shadowRoot);
      if (element.tagName === "IFRAME") { try { visit(element.contentDocument); } catch {} }
      if (elements.length >= 160) break;
    }
  };
  visit(document);
  return { url: location.href, title: document.title || location.hostname || "Browser", loading: document.readyState === "loading",
    viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio, mobile: matchMedia("(pointer: coarse)").matches },
    focusedElement: document.activeElement && document.activeElement !== document.body ? referenceFor(document.activeElement) : null,
    visibleText: text.join("\n").slice(0, 12000), elements };
})()`;

export function referenceScript(action: "click" | "fill", reference: string, value = ""): string {
  const ref = JSON.stringify(reference);
  const serializedValue = JSON.stringify(value);
  if (action === "click") return `(() => { const el = globalThis.__maxxBrowser?.refToElement.get(${ref}); if (!el?.isConnected) return {ok:false,error:"stale"}; el.scrollIntoView({block:"center",inline:"center"}); el.click(); return {ok:true}; })()`;
  return `(() => { const el = globalThis.__maxxBrowser?.refToElement.get(${ref}); if (!el?.isConnected) return {ok:false,error:"stale"}; el.focus(); const view = el.ownerDocument.defaultView; if (el.isContentEditable) el.textContent=${serializedValue}; else { const proto = el instanceof view.HTMLSelectElement ? view.HTMLSelectElement.prototype : el instanceof view.HTMLTextAreaElement ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype; const setter=Object.getOwnPropertyDescriptor(proto,"value")?.set; if(setter) setter.call(el,${serializedValue}); else el.value=${serializedValue}; } const Input=view.InputEvent||InputEvent; el.dispatchEvent(new Input("input",{bubbles:true,inputType:"insertText",data:${serializedValue}})); el.dispatchEvent(new view.Event("change",{bubbles:true})); return {ok:true,value:"value" in el?el.value:el.textContent}; })()`;
}

export function dragScript(from: string, to: string): string {
  return `(() => { const source=globalThis.__maxxBrowser?.refToElement.get(${JSON.stringify(from)}); const target=globalThis.__maxxBrowser?.refToElement.get(${JSON.stringify(to)}); if(!source?.isConnected||!target?.isConnected)return {ok:false,error:"stale"}; const data=new DataTransfer(); for(const type of ["dragstart","dragenter","dragover","drop","dragend"]){const node=type==="dragstart"||type==="dragend"?source:target;node.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:data}));} return {ok:true}; })()`;
}

export function annotationInstallScript(token: string): string {
  return String.raw`(() => {
  const sessionToken = ${JSON.stringify(token)};
  const previous = globalThis.__maxxAnnotation;
  const priorSelections = previous?.selectionList || [];
  previous?.dispose?.();
  const state = globalThis.__maxxAnnotation = { installed: true, selectionList: priorSelections, markers: [], pending: null, hoveredInstruction: null };
  const selectorFor = (element) => {
    if (element.id) return "#" + CSS.escape(element.id);
    const parts = [];
    let node = element;
    while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((candidate) => candidate.tagName === node.tagName);
        if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };
  const root = document.documentElement.appendChild(document.createElement("div"));
  root.id = "__maxx-annotations";
  root.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none";
  const shadow = root.attachShadow({mode:"closed"});
  const hover = shadow.appendChild(document.createElement("div"));
  hover.style.cssText = "position:fixed;border:2px solid #1677ff;background:rgba(22,119,255,.08);display:none;box-sizing:border-box;pointer-events:none";
  const tooltip = shadow.appendChild(document.createElement("div"));
  tooltip.style.cssText = "all:initial;position:fixed;display:none;max-width:320px;padding:10px 16px;box-sizing:border-box;border:1px solid rgba(255,255,255,.12);border-radius:22px;background:#2d2d2d;color:#f5f5f5;box-shadow:0 8px 24px rgba(0,0,0,.32);pointer-events:none;white-space:normal;font:14px/1.35 -apple-system,BlinkMacSystemFont,sans-serif";
  const editor = shadow.appendChild(document.createElement("div"));
  editor.style.cssText = "all:initial;position:fixed;display:none;align-items:center;width:340px;height:50px;padding:0 8px 0 14px;box-sizing:border-box;border:1px solid rgba(255,255,255,.14);border-radius:25px;background:#2d2d2d;box-shadow:0 10px 30px rgba(0,0,0,.38);pointer-events:auto;font-family:-apple-system,BlinkMacSystemFont,sans-serif";
  const glyph = editor.appendChild(document.createElement("span"));
  glyph.textContent = "☷";
  glyph.style.cssText = "all:initial;flex:0 0 auto;margin-right:9px;color:#8d8d8d;font:16px/1 -apple-system,BlinkMacSystemFont,sans-serif";
  const input = editor.appendChild(document.createElement("input"));
  input.type = "text";
  input.placeholder = "Describe the change";
  input.maxLength = 2000;
  input.style.cssText = "all:initial;min-width:0;flex:1;color:#f5f5f5;caret-color:#fff;font:14px/1.25 -apple-system,BlinkMacSystemFont,sans-serif";
  const confirm = editor.appendChild(document.createElement("button"));
  confirm.type = "button";
  confirm.textContent = "✓";
  confirm.disabled = true;
  confirm.setAttribute("aria-label", "Add annotation");
  confirm.style.cssText = "all:initial;width:36px;height:36px;display:grid;place-items:center;margin-left:8px;border-radius:50%;background:#fff;color:#333;font:600 23px/1 -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer;opacity:.45";
  const clearMarkers = () => { for (const marker of state.markers) marker.remove(); state.markers = []; };
  const elementFor = (selector) => { try { return document.querySelector(selector); } catch { return null; } };
  const hideTooltip = () => { tooltip.style.display="none"; state.hoveredInstruction=null; };
  const selectionForElement = (element) => state.selectionList.find((selection) => {
    const target=elementFor(selection.selector);
    return target && (target===element || target.contains(element));
  });
  const showTooltip = (selection) => {
    const target=elementFor(selection.selector);
    if (!target || !selection.instruction) { hideTooltip(); return; }
    const r=target.getBoundingClientRect();
    tooltip.textContent=selection.instruction;
    tooltip.style.display="block";
    const bounds=tooltip.getBoundingClientRect();
    const center=r.left+r.width/2;
    const right=center+28;
    const left=right+bounds.width<=innerWidth-12 ? right : Math.max(12,center-bounds.width-28);
    const top=Math.max(12,Math.min(innerHeight-bounds.height-12,r.top+r.height/2-bounds.height/2));
    tooltip.style.left=left+"px"; tooltip.style.top=top+"px";
    state.hoveredInstruction=selection.instruction;
  };
  const metadataFor = (element) => { const r=element.getBoundingClientRect(); return {selector:selectorFor(element),tagName:element.tagName.toLowerCase(),role:element.getAttribute("role"),name:element.getAttribute("aria-label")||element.getAttribute("title")||"",text:(element.innerText||element.textContent||"").trim().slice(0,500),rect:{x:r.x,y:r.y,width:r.width,height:r.height}}; };
  const emit = (payload) => globalThis.__maxxAnnotationPicked(JSON.stringify({...payload,sessionToken}));
  const closeEditor = () => { state.pending=null; editor.style.display="none"; input.value=""; confirm.disabled=true; confirm.style.opacity=".45"; };
  const positionEditor = () => {
    if (!state.pending) return;
    const r=state.pending.element.getBoundingClientRect();
    const width=Math.min(340,Math.max(240,innerWidth-24));
    const left=Math.max(12,Math.min(innerWidth-width-12,r.left+r.width/2-width/2));
    const preferred=r.top+r.height/2-25;
    const top=Math.max(12,Math.min(innerHeight-62,preferred));
    editor.style.width=width+"px"; editor.style.left=left+"px"; editor.style.top=top+"px";
  };
  const openEditor = (element) => { state.pending={element,metadata:metadataFor(element)}; hover.style.display="none"; hideTooltip(); positionEditor(); editor.style.display="flex"; input.focus(); };
  const commit = () => { const instruction=input.value.trim(); if(!state.pending||!instruction)return; const metadata=state.pending.metadata; closeEditor(); emit({selected:true,instruction,...metadata}); };
  input.addEventListener("input", () => { const enabled=Boolean(input.value.trim()); confirm.disabled=!enabled; confirm.style.opacity=enabled?"1":".45"; });
  input.addEventListener("keydown", (event) => { if(event.key==="Enter"){event.preventDefault();commit();} });
  confirm.addEventListener("click", commit);
  const render = () => {
    clearMarkers();
    for (const selection of state.selectionList) {
      const element = elementFor(selection.selector);
      if (!element) continue;
      const r = element.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const marker = shadow.appendChild(document.createElement("div"));
      marker.style.cssText = "position:fixed;left:"+r.left+"px;top:"+r.top+"px;width:"+r.width+"px;height:"+r.height+"px;border:2px solid #1677ff;background:rgba(22,119,255,.07);box-sizing:border-box;pointer-events:none";
      const badge = marker.appendChild(document.createElement("span"));
      badge.textContent = String(selection.index);
      badge.style.cssText = "all:initial;position:absolute;left:50%;top:-9px;transform:translateX(-50%);width:20px;height:20px;display:grid;place-items:center;border-radius:999px;background:#1677ff;color:#fff;font:700 11px/1 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.32)";
      state.markers.push(marker);
    }
  };
  state.setSelections = (selections) => { state.selectionList = Array.isArray(selections) ? selections.slice(0,20) : []; hideTooltip(); render(); };
  const move = (event) => {
    if(state.pending)return;
    const el=document.elementFromPoint(event.clientX,event.clientY);
    if(!el||el===root){hover.style.display="none";hideTooltip();return;}
    const selection=selectionForElement(el);
    if(selection){hover.style.display="none";showTooltip(selection);return;}
    hideTooltip();
    const r=el.getBoundingClientRect(); hover.style.display="block"; hover.style.left=r.left+"px"; hover.style.top=r.top+"px"; hover.style.width=r.width+"px"; hover.style.height=r.height+"px";
  };
  const leave = (event) => { if(!event.relatedTarget){hover.style.display="none";hideTooltip();} };
  const click = (event) => { if(event.target===root)return; const el=document.elementFromPoint(event.clientX,event.clientY); if(!el||el===root)return; event.preventDefault(); event.stopImmediatePropagation(); const metadata=metadataFor(el); const selected=state.selectionList.some((item)=>item.selector===metadata.selector); if(selected)emit({selected:false,instruction:"",...metadata}); else openEditor(el); };
  const keydown = (event) => { if(event.key!=="Escape")return; event.preventDefault(); event.stopImmediatePropagation(); if(state.pending){closeEditor();return;} emit({cancel:true}); };
  let frame = 0;
  const reposition = () => { cancelAnimationFrame(frame); frame=requestAnimationFrame(() => { render(); positionEditor(); }); };
  state.dispose = () => { cancelAnimationFrame(frame); removeEventListener("mousemove", move, true); removeEventListener("mouseout", leave, true); removeEventListener("click", click, true); removeEventListener("keydown", keydown, true); removeEventListener("scroll", reposition, true); removeEventListener("resize", reposition, true); root.remove(); delete globalThis.__maxxAnnotation; };
  addEventListener("mousemove", move, true); addEventListener("mouseout", leave, true); addEventListener("click", click, true); addEventListener("keydown", keydown, true); addEventListener("scroll", reposition, true); addEventListener("resize", reposition, true); render(); return true;
})()`;
}

export const ANNOTATION_DISABLE_SCRIPT = "globalThis.__maxxAnnotation?.dispose?.(); true";

export function annotationSelectionsScript(selections: Array<{ selector: string; index: number; instruction: string }>): string {
  return `globalThis.__maxxAnnotation?.setSelections?.(${JSON.stringify(selections)}); true`;
}

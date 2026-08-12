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

export const ANNOTATION_INSTALL_SCRIPT = String.raw`(() => {
  globalThis.__maxxAnnotation?.dispose?.();
  const state = globalThis.__maxxAnnotation = { installed: true, markers: [] };
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
  hover.style.cssText = "position:fixed;border:2px solid #2f7cff;background:rgba(47,124,255,.12);border-radius:4px;display:none;box-sizing:border-box";
  const move = (event) => { const el=document.elementFromPoint(event.clientX,event.clientY); if(!el||el===root)return; const r=el.getBoundingClientRect(); hover.style.display="block"; hover.style.left=r.left+"px"; hover.style.top=r.top+"px"; hover.style.width=r.width+"px"; hover.style.height=r.height+"px"; };
  const click = (event) => { const el=document.elementFromPoint(event.clientX,event.clientY); if(!el||el===root)return; event.preventDefault(); event.stopImmediatePropagation(); const r=el.getBoundingClientRect(); const marker=shadow.appendChild(document.createElement("div")); marker.style.cssText="position:fixed;left:"+r.left+"px;top:"+r.top+"px;width:"+r.width+"px;height:"+r.height+"px;border:2px solid #ff9f0a;background:rgba(255,159,10,.12);border-radius:4px;box-sizing:border-box"; state.markers.push(marker); if(state.markers.length>20)state.markers.shift().remove(); const payload={selector:selectorFor(el),tagName:el.tagName.toLowerCase(),role:el.getAttribute("role"),name:el.getAttribute("aria-label")||el.getAttribute("title")||"",text:(el.innerText||el.textContent||"").trim().slice(0,500),rect:{x:r.x,y:r.y,width:r.width,height:r.height}}; globalThis.__maxxAnnotationPicked(JSON.stringify(payload)); };
  state.dispose = () => { removeEventListener("mousemove", move, true); removeEventListener("click", click, true); root.remove(); delete globalThis.__maxxAnnotation; };
  addEventListener("mousemove", move, true); addEventListener("click", click, true); return true;
})()`;

export const ANNOTATION_DISABLE_SCRIPT = "globalThis.__maxxAnnotation?.dispose?.(); true";

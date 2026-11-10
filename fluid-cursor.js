/* Fluid ink cursor: a soft blob that follows the pointer with spring physics and
   inverts whatever is underneath it (white + mix-blend-mode: difference).
   Loaded by index.html, personal.html and commercial.html.

   Switch:  ?cursor=0  -> normal system cursor     ?cursor=1 -> fluid cursor (default)
            The choice is kept for the browser tab (sessionStorage), so it survives
            SPA navigation and moving between pages.

   How it looks: a head blob plus a few trailing blobs share one SVG "goo" filter
   (blur, then a hard alpha threshold). Where they overlap they merge into one
   stretched ink drop; the threshold keeps the edge crisp, so the inversion has no
   grey halo. A tiny exact dot marks the real click point (it double-inverts inside
   the blob, so it shows the original colour there).
   Only mouse-like pointers get it; touch/coarse pointers keep the system cursor. */
(function(){
  "use strict";

  /* ---------- Tuning ---------- */
  var SIZE        = 26;    // head blob diameter (px)
  var TRAIL       = 3;     // trailing blobs behind the head (0 = no trail)
  var TAPER       = 0.17;  // each trailing blob is this much smaller than the one before
  var SPEED       = 26;    // how fast the head catches the pointer (1/s; higher = tighter)
  var MAX_LAG     = 48;    // the head never falls further behind the pointer than this (px)
  var STIFFNESS   = 230;   // trail spring stiffness (higher = shorter trail)
  var ELASTICITY  = 0.42;  // 0 = no wobble (critically damped) ... 0.8 = very jelly
  var STRETCH     = 0.95;  // max gap between neighbouring blobs, x SIZE (keeps the ink joined)
  var BLUR        = 7;     // goo blur (px): bigger = rounder, softer merging
  var HOVER_SCALE = 2.0;   // head size over links / clickable images
  var PRESS_SCALE = 0.78;  // while the mouse button is down
  var SMALL_SCALE = 0.36;  // over selectable text and the personal page's "view" pill
  var DOT         = 4;     // exact click-point dot (px); 0 = none
  var REDUCED_SIZE = 18;   // prefers-reduced-motion: a single plain inverted dot

  /* ---------- Switch ---------- */
  var KEY = "fluid-cursor";
  var want = null;
  try{
    var q = new URLSearchParams(location.search).get("cursor");
    if(q === "0" || q === "1"){ want = q; sessionStorage.setItem(KEY, q); }
    else want = sessionStorage.getItem(KEY);
  }catch(_){}
  if(want === "0") return;

  var fineMQ = window.matchMedia("(hover:hover) and (pointer:fine)");
  var reduceMQ = window.matchMedia("(prefers-reduced-motion: reduce)");
  var root = document.documentElement;

  /* Things that make the blob grow (links, buttons, clickable media). */
  var HOVER_SEL = "a[href],button,[role=button],[data-nav],[data-menu-open],[data-view],summary,label,select," +
    ".pcard,.proj-panel,.rt,.pinfo-head,.pinfo-tab,.pinfo-toggle,.frame,.tile,.w-item,.pgbtn,.back," +
    ".brandBtn,.menuBtn,.m-link,.m-sub,.zc-cell,.cg-card,.cc-stage.is-over,.vg-item.hov,.v-imglink";
  /* Never grow over these (full-screen click layers). */
  var HOVER_SKIP = ".ct-hit,.m-soon";
  var FIELD_SEL = "input:not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox])" +
    ":not([type=radio]):not([type=range]):not([type=color]):not([type=file]):not([type=image]),textarea,[contenteditable=''],[contenteditable=true]";
  var TEXT_SEL = "p,li,h1,h2,h3,h4,h5,h6,blockquote,figcaption,dd,dt,pre,code,address,td,th";
  var DRAG_SEL = ".is-dragging,.grabbing,.dragging,.is-drag";
  var SMALL_SEL = ".pill-on";   // personal.html shows its own "view" pill there

  var css =
    "html.fc-on,html.fc-on *,html.fc-on *::before,html.fc-on *::after{cursor:none !important}" +
    "html.fc-on.fc-sys,html.fc-on.fc-sys *{cursor:text !important}" +
    "html.fc-on :is(" + FIELD_SEL + "){cursor:text !important}" +
    ".fc-layer{position:fixed;left:0;top:0;pointer-events:none;z-index:2147483646;mix-blend-mode:difference;" +
      "opacity:0;transition:opacity .28s ease;will-change:transform,opacity;contain:layout style}" +
    ".fc-layer.is-on{opacity:1}" +
    ".fc-blob{position:absolute;border-radius:50%;background:#fff;will-change:transform}" +
    ".fc-dot{width:" + DOT + "px;height:" + DOT + "px;border-radius:50%;background:#fff}" +
    ".fc-dot.is-small{opacity:0}" +
    "@media print{.fc-layer{display:none}}";

  var BOX = 0;                    // goo layer box (px), sized to hold the whole trail
  var goo, dot, blobs = [], svg, styleEl;
  var built = false, active = false, reduced = reduceMQ.matches;

  // physics state: index 0 = head
  var N = 0, px = 0, py = 0, x = [], y = [], vx = [], vy = [];
  var scale = 1, targetScale = 1, tailScale = 1, targetTail = 1;
  var seen = false, inside = false, hidden = true, pressed = false, sys = false, small = false;
  var raf = 0, last = 0, lastTarget = null, checkQueued = false;

  function build(){
    if(built) return;
    built = true;
    styleEl = document.createElement("style");
    styleEl.textContent = css;
    document.head.appendChild(styleEl);

    N = reduced ? 1 : TRAIL + 1;
    BOX = Math.ceil(2 * (SIZE * HOVER_SCALE / 2 + TRAIL * STRETCH * SIZE + BLUR * 3) + 8);

    var NS = "http://www.w3.org/2000/svg";
    svg = document.createElementNS(NS, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("width", "0"); svg.setAttribute("height", "0");
    svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    // blur, then squash alpha into a hard edge: overlapping blobs melt together, the
    // outline stays sharp (no translucent grey ring under the difference blend)
    svg.innerHTML = '<filter id="fc-goo" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">' +
      '<feGaussianBlur in="SourceGraphic" stdDeviation="' + BLUR + '" result="b"/>' +
      '<feColorMatrix in="b" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 26 -10"/></filter>';
    document.body.appendChild(svg);

    goo = document.createElement("div");
    goo.className = "fc-layer";
    goo.setAttribute("aria-hidden", "true");
    goo.style.width = goo.style.height = BOX + "px";
    if(!reduced) goo.style.filter = "url(#fc-goo)";
    for(var i = 0; i < N; i++){
      var d = reduced ? REDUCED_SIZE : SIZE * Math.max(0.3, 1 - i * TAPER);
      // the threshold eats ~a blur-width off the edge; pad so the visible size is right
      var pad = reduced ? 0 : BLUR * 0.9;
      var b = document.createElement("div");
      b.className = "fc-blob";
      b.style.width = b.style.height = (d + pad) + "px";
      b.style.left = b.style.top = (BOX - d - pad) / 2 + "px";
      goo.appendChild(b);
      blobs.push(b);
      x.push(0); y.push(0); vx.push(0); vy.push(0);
    }
    document.body.appendChild(goo);

    if(DOT > 0){
      dot = document.createElement("div");
      dot.className = "fc-layer fc-dot";
      dot.setAttribute("aria-hidden", "true");
      document.body.appendChild(dot);
    }
  }

  function enable(){
    if(active) return;
    build();
    active = true;
    root.classList.add("fc-on");
  }
  function disable(){
    if(!active) return;
    active = false;
    root.classList.remove("fc-on", "fc-sys");
    hide();
    stop();
  }

  function show(){
    if(!hidden) return;
    hidden = false;
    goo.classList.add("is-on");
    if(dot) dot.classList.add("is-on");
  }
  function hide(){
    hidden = true;
    if(goo) goo.classList.remove("is-on");
    if(dot) dot.classList.remove("is-on");
  }
  // put every blob on the pointer (first sighting / coming back into the window)
  function snap(){
    for(var i = 0; i < N; i++){ x[i] = px; y[i] = py; vx[i] = vy[i] = 0; }
    scale = targetScale; tailScale = targetTail;
  }

  /* ---------- What is under the pointer ---------- */
  function overText(t){
    if(!t.closest(TEXT_SEL) || t.closest(HOVER_SEL)) return false;
    var cs = getComputedStyle(t);
    if(cs.userSelect === "none" || cs.webkitUserSelect === "none") return false;
    // only when actually over a glyph, not the empty part of a wide paragraph
    var r = document.caretRangeFromPoint ? document.caretRangeFromPoint(px, py) : null;
    if(!r && document.caretPositionFromPoint){
      var cp = document.caretPositionFromPoint(px, py);
      if(cp){ r = document.createRange(); r.setStart(cp.offsetNode, cp.offset); }
    }
    if(!r || r.startContainer.nodeType !== 3) return false;
    var node = r.startContainer, o = r.startOffset, len = node.length, rr = document.createRange();
    for(var k = Math.max(0, o - 1); k <= Math.min(o, len - 1); k++){
      rr.setStart(node, k); rr.setEnd(node, k + 1);
      var b = rr.getBoundingClientRect();
      if(px >= b.left - 2 && px <= b.right + 2 && py >= b.top && py <= b.bottom) return true;
    }
    return false;
  }

  function classify(t){
    if(!t || !t.closest) return;
    lastTarget = t;
    if(t.tagName === "IFRAME"){ hide(); return; }   // the player's own cursor takes over
    var field = !!t.closest(FIELD_SEL);
    var text = !field && overText(t);
    var wasSys = sys;
    sys = field || text;
    if(sys !== wasSys) root.classList.toggle("fc-sys", sys);
    small = !!t.closest(SMALL_SEL);
    var hov = !sys && !t.closest(HOVER_SKIP) && !!t.closest(HOVER_SEL);
    var drag = !!t.closest(DRAG_SEL);

    if(field){ targetScale = 0; }
    else if(text || small){ targetScale = SMALL_SCALE; }
    else if(pressed || drag){ targetScale = PRESS_SCALE; }
    else if(hov){ targetScale = HOVER_SCALE; }
    else targetScale = 1;
    // over a link the trail tucks in, so the blob reads as one round bubble
    targetTail = hov && !pressed ? 0.55 : 1;
    if(dot) dot.classList.toggle("is-small", field || text);
    if(reduced){ scale = targetScale; tailScale = targetTail; }
    kick();
  }

  // re-check under a still pointer (galleries toggle hover classes as items move)
  function queueCheck(){
    if(checkQueued || !inside || hidden) return;
    checkQueued = true;
    requestAnimationFrame(function(){
      checkQueued = false;
      if(!active || !inside || hidden) return;
      var el = document.elementFromPoint(px, py);
      if(el) classify(el);
    });
  }

  /* ---------- Animation ---------- */
  function kick(){
    if(!raf && active && !document.hidden){ last = 0; raf = requestAnimationFrame(frame); }
  }
  function stop(){ if(raf){ cancelAnimationFrame(raf); raf = 0; } }

  function frame(now){
    raf = 0;
    var dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
    last = now;
    var moving = false;

    if(reduced){
      x[0] = px; y[0] = py;
    } else {
      // head: fast exponential catch-up, never more than MAX_LAG behind
      var f = 1 - Math.exp(-SPEED * dt);
      x[0] += (px - x[0]) * f; y[0] += (py - y[0]) * f;
      var dx = x[0] - px, dy = y[0] - py, d = Math.hypot(dx, dy);
      if(d > MAX_LAG){ x[0] = px + dx / d * MAX_LAG; y[0] = py + dy / d * MAX_LAG; }
      if(d > 0.05) moving = true;

      // trail: each blob is a damped spring hanging off the one in front
      var k = STIFFNESS, c = 2 * Math.sqrt(k) * (1 - ELASTICITY);
      var gap = STRETCH * SIZE, steps = 2, h = dt / steps;
      for(var s = 0; s < steps; s++){
        for(var i = 1; i < N; i++){
          var ax = k * (x[i - 1] - x[i]) - c * vx[i];
          var ay = k * (y[i - 1] - y[i]) - c * vy[i];
          vx[i] += ax * h; vy[i] += ay * h;
          x[i] += vx[i] * h; y[i] += vy[i] * h;
          var lx = x[i] - x[i - 1], ly = y[i] - y[i - 1], l = Math.hypot(lx, ly);
          var g = gap * Math.max(0.3, 1 - i * TAPER) * tailScale;
          if(l > g){ x[i] = x[i - 1] + lx / l * g; y[i] = y[i - 1] + ly / l * g; }
        }
      }
      for(var j = 1; j < N; j++){
        if(Math.abs(vx[j]) + Math.abs(vy[j]) > 0.5 || Math.abs(x[j] - x[0]) + Math.abs(y[j] - y[0]) > 0.1) moving = true;
      }
      var fs = 1 - Math.exp(-16 * dt);
      scale += (targetScale - scale) * fs;
      tailScale += (targetTail - tailScale) * fs;
      if(Math.abs(targetScale - scale) > 0.002 || Math.abs(targetTail - tailScale) > 0.002) moving = true;
      else { scale = targetScale; tailScale = targetTail; }
    }

    render();
    if(moving) raf = requestAnimationFrame(frame);
    else last = 0;
  }

  function render(){
    var half = BOX / 2;
    goo.style.transform = "translate3d(" + (x[0] - half) + "px," + (y[0] - half) + "px,0)";
    for(var i = 0; i < N; i++){
      var s = i === 0 ? scale : scale * tailScale;
      blobs[i].style.transform = "translate3d(" + (x[i] - x[0]) + "px," + (y[i] - y[0]) + "px,0) scale(" + s + ")";
    }
    if(dot) dot.style.transform = "translate3d(" + (px - DOT / 2) + "px," + (py - DOT / 2) + "px,0)";
  }

  /* ---------- Events ---------- */
  function onMove(e){
    if(e.pointerType && e.pointerType !== "mouse"){       // pen / touch: get out of the way
      if(active){ hide(); root.classList.remove("fc-on"); }
      return;
    }
    if(!active) return;
    if(!root.classList.contains("fc-on")) root.classList.add("fc-on");
    px = e.clientX; py = e.clientY;
    inside = true;
    // new element, or inside text (glyph vs. the empty end of a line changes per move)
    if(e.target !== lastTarget || sys || (e.target.closest && e.target.closest(TEXT_SEL))) classify(e.target);
    if(hidden && e.target.tagName !== "IFRAME"){
      if(!seen) seen = true;
      snap(); show(); render();
    }
    kick();
  }
  function onDown(e){
    if(!active || (e.pointerType && e.pointerType !== "mouse")) return;
    pressed = true; classify(e.target);
  }
  function onUp(e){
    if(!active || !pressed) return;
    pressed = false; classify(e.target);
  }
  function onLeave(){ inside = false; lastTarget = null; if(active) hide(); }

  document.addEventListener("pointermove", onMove, {passive:true});
  // pointerover fires before pointermove: take its coordinates so the text test is current
  document.addEventListener("pointerover", function(e){
    if(!active || e.pointerType !== "mouse") return;
    px = e.clientX; py = e.clientY; classify(e.target);
  }, {passive:true});
  document.addEventListener("pointerdown", onDown, {passive:true, capture:true});
  window.addEventListener("pointerup", onUp, {passive:true, capture:true});
  window.addEventListener("pointercancel", onUp, {passive:true});
  // leaving the window (relatedTarget null) or the tab losing focus to another window
  document.addEventListener("mouseout", function(e){ if(!e.relatedTarget) onLeave(); });
  window.addEventListener("blur", function(){ if(active && document.activeElement && document.activeElement.tagName === "IFRAME") hide(); });
  document.addEventListener("visibilitychange", function(){ if(document.hidden) stop(); else if(active && !hidden) kick(); });
  // scrolling moves content under a still pointer
  window.addEventListener("scroll", queueCheck, {passive:true, capture:true});

  function start(){
    if(fineMQ.matches) enable();
    var onFine = function(){ fineMQ.matches ? enable() : disable(); };
    var onReduce = function(){
      // rebuild with the other mode (only happens if the OS setting changes mid-visit)
      var was = active; disable();
      if(built){
        goo.remove(); if(dot) dot.remove(); svg.remove(); styleEl.remove();
        blobs = []; x = []; y = []; vx = []; vy = []; built = false; hidden = true;
      }
      reduced = reduceMQ.matches;
      if(was) enable();
    };
    if(fineMQ.addEventListener){ fineMQ.addEventListener("change", onFine); reduceMQ.addEventListener("change", onReduce); }
    else if(fineMQ.addListener){ fineMQ.addListener(onFine); reduceMQ.addListener(onReduce); }

    // gallery/carousel hover classes change under a still pointer: re-check then
    if(window.MutationObserver){
      new MutationObserver(function(list){
        for(var i = 0; i < list.length; i++){
          var t = list[i].target;
          if(t !== root && t !== goo && t !== dot){ queueCheck(); return; }
        }
      }).observe(document.body, {subtree:true, attributes:true, attributeFilter:["class"]});
    }
  }
  if(document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
})();

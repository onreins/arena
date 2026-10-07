/* Reins FX: small WebGL backgrounds, as a progressive enhancement.
   Any element with data-fx="<look>" gets a canvas behind its content:

     engraving  a banknote-like engraved print over a slow navy flow (Callbook heroes)
     aurora     slow brand-blue light with fine grain (the Agents hero)
     foil       a holographic sheen that follows the pointer (the score stamp)

   The CSS background is never removed, so the page looks right without it:
     - no WebGL                      -> nothing happens
     - prefers-reduced-motion        -> one still frame (no foil)
     - off-screen or background tab  -> not drawn
     - context lost / any error      -> the canvas is removed
   Phones draw at device pixels capped at 1x and 30 frames a second.
   Inspired by the looks in the Shaders library (shaders.com, MIT); written from
   scratch here so it stays tiny and runs on WebGL everywhere. */
(function () {
  "use strict";
  var still = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var coarse = window.matchMedia && matchMedia("(pointer: coarse)").matches;
  var MAX_DPR = coarse ? 1 : 1.5;
  var FRAME_MS = 1000 / 30;

  var VERT = "attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}";

  // Shared GLSL: hash, value noise, fbm, grain.
  var LIB =
    "precision mediump float;uniform vec2 R;uniform float T;uniform vec2 P;uniform float H;" +
    "float h21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}" +
    "float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);" +
    "return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y);}" +
    "float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*vn(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return v;}" +
    "float grain(vec2 c){return h21(c+fract(T*.37)*vec2(13.,7.))-.5;}";

  var LOOKS = {
    // Engraved lines whose spacing bends over a slow flow field, like a banknote portrait plate.
    engraving: LIB +
      "void main(){vec2 uv=gl_FragCoord.xy/R;vec2 p=(gl_FragCoord.xy-.5*R)/R.y;float t=T*.035;" +
      "vec2 q=vec2(fbm(p*1.3+vec2(t,-t*.7)),fbm(p*1.3+vec2(-t*.8,t)+5.2));" +
      "float f=fbm(p*1.6+q*1.4+vec2(0.,t*.5));" +
      "vec3 c=mix(vec3(.043,.055,.141),vec3(.086,.106,.31),smoothstep(.25,.8,f));" +
      "c=mix(c,vec3(.17,.12,.39),smoothstep(.55,.95,q.x)*.55);" +
      "float a=.21;vec2 r=vec2(cos(a)*p.x-sin(a)*p.y,sin(a)*p.x+cos(a)*p.y);" +
      "float v=r.y*58.+f*9.+sin(r.x*2.3+t*2.)*1.2;float w=fwidth(v);" +
      "float ln=1.-smoothstep(.0,w*1.4,abs(fract(v)-.5)-(.08+.32*f));" +
      "float v2=(r.x*.6-r.y)*46.+f*6.;float w2=fwidth(v2);" +
      "float hatch=(1.-smoothstep(0.,w2*1.4,abs(fract(v2)-.5)-.06))*smoothstep(.62,.35,f);" +
      // Quieter on the left, where the headline sits.
      "c+=vec3(.42,.5,1.)*(ln*.10+hatch*.05)*(.45+f)*mix(.32,1.,smoothstep(.15,.72,uv.x));" +
      "c*=1.-.35*dot(uv-.5,uv-.5)*1.6;c+=grain(gl_FragCoord.xy)*.035;gl_FragColor=vec4(c,1.);}",

    // Four soft lights drifting on slow loops, warped by noise, over deep navy.
    aurora: LIB +
      "vec3 L(vec2 p,vec2 c,vec3 col,float r){return col*exp(-dot(p-c,p-c)/r);}" +
      "void main(){vec2 uv=gl_FragCoord.xy/R;vec2 p=(gl_FragCoord.xy-.5*R)/R.y;float t=T*.05;" +
      "p+=.18*vec2(fbm(p*1.4+t),fbm(p*1.4-t+3.1))-.09;" +
      "vec3 c=vec3(.039,.051,.133);" +
      "c+=L(p,vec2(.55+.18*sin(t*1.1),-.05+.15*cos(t*.9)),vec3(.16,.25,.68),.22);" +
      "c+=L(p,vec2(-.35+.2*cos(t*.7),.25+.12*sin(t*1.3)),vec3(.09,.13,.38),.3);" +
      "c+=L(p,vec2(.1+.25*sin(t*.5+2.),-.35+.1*cos(t*.8)),vec3(.15,.1,.36),.18);" +
      "c+=L(p,vec2(-.6+.1*sin(t*1.7),-.3),vec3(.05,.12,.3),.25);" +
      "c*=1.-.3*dot(uv-.5,uv-.5)*1.4;c+=grain(gl_FragCoord.xy)*.03;gl_FragColor=vec4(c,1.);}",

    // Thin-film colours in a band that follows the pointer (P, 0..1; H = hover 0..1), inside a circle.
    foil: LIB +
      "void main(){vec2 uv=gl_FragCoord.xy/R;vec2 d=uv-.5;float rr=length(d);" +
      "float m=smoothstep(.5,.47,rr)*smoothstep(.2,.3,rr);" +
      "vec2 ptr=mix(vec2(.5+.35*cos(T*.25),.5+.35*sin(T*.21)),P,H);" +
      "float band=exp(-pow(dot(uv-ptr,normalize(vec2(1.,.6)))*5.,2.));" +
      "float hue=dot(uv,vec2(1.3,.9))*1.6+T*.04+vn(uv*6.)*.4;" +
      "vec3 film=.5+.5*cos(6.2832*(hue+vec3(0.,.33,.67)));" +
      "float a=m*band*(.22+.5*H);gl_FragColor=vec4(film*a,a);}",
  };

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader");
    return s;
  }

  function mount(el, look) {
    if (!LOOKS[look] || el.__fx) return null;
    if (look === "foil" && still) return null;
    var canvas = document.createElement("canvas");
    var gl = canvas.getContext("webgl", { alpha: look === "foil", premultipliedAlpha: true, antialias: false, powerPreference: "low-power" });
    if (!gl) return null;
    gl.getExtension("OES_standard_derivatives");
    var prog;
    try {
      var frag = (look === "engraving" ? "#extension GL_OES_standard_derivatives : enable\n" : "") + LOOKS[look];
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, frag));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link");
    } catch (e) {
      return null;
    }
    el.__fx = true;
    canvas.className = "fx-canvas fx-" + look;
    canvas.setAttribute("aria-hidden", "true");
    var front = look === "foil";
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;border-radius:inherit;opacity:0;transition:opacity .9s ease;" +
      (front ? "z-index:2;mix-blend-mode:screen;" : "z-index:-1;");
    if (front) el.appendChild(canvas); else el.insertBefore(canvas, el.firstChild);

    gl.useProgram(prog);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    var uR = gl.getUniformLocation(prog, "R"), uT = gl.getUniformLocation(prog, "T");
    var uP = gl.getUniformLocation(prog, "P"), uH = gl.getUniformLocation(prog, "H");

    var visible = true, raf = 0, last = 0, start = performance.now(), shown = false, alive = true;
    var ptr = [0.5, 0.5], hover = 0, hoverTarget = 0;
    var seed = (look.length * 37) % 97; // a different starting point per look

    function size() {
      var r = el.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      var w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
    }
    function draw(now) {
      if (!alive) return;
      hover += (hoverTarget - hover) * 0.12;
      gl.uniform2f(uR, canvas.width, canvas.height);
      gl.uniform1f(uT, still ? 40 : seed + (now - start) / 1000);
      if (uP) gl.uniform2f(uP, ptr[0], ptr[1]);
      if (uH) gl.uniform1f(uH, hover);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!shown) { shown = true; canvas.style.opacity = "1"; }
    }
    function loop(now) {
      raf = 0;
      if (!visible || document.hidden || !alive) return;
      if (now - last >= FRAME_MS) { last = now; draw(now); }
      raf = requestAnimationFrame(loop);
    }
    function wake() { if (!still && !raf && visible && !document.hidden) raf = requestAnimationFrame(loop); }
    function remove() {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      canvas.remove();
      el.__fx = false;
    }

    size();
    draw(performance.now());
    if (window.ResizeObserver) new ResizeObserver(function () { size(); if (still) draw(performance.now()); }).observe(el);
    if (window.IntersectionObserver) {
      new IntersectionObserver(function (es) { visible = es[es.length - 1].isIntersecting; wake(); }).observe(el);
    }
    document.addEventListener("visibilitychange", wake);
    canvas.addEventListener("webglcontextlost", remove);
    if (front) {
      el.addEventListener("pointermove", function (e) {
        var r = el.getBoundingClientRect();
        ptr = [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height];
        hoverTarget = 1;
      });
      el.addEventListener("pointerleave", function () { hoverTarget = 0; });
    }
    wake();
    return { remove: remove };
  }

  function scan(root) {
    var els = (root || document).querySelectorAll("[data-fx]");
    for (var i = 0; i < els.length; i++) mount(els[i], els[i].getAttribute("data-fx"));
  }

  function start() {
    scan();
    // Some elements (the score stamp) are drawn after the data loads.
    if (window.MutationObserver) {
      new MutationObserver(function (ms) {
        for (var i = 0; i < ms.length; i++) if (ms[i].addedNodes.length) { scan(); return; }
      }).observe(document.body, { childList: true, subtree: true });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();

  window.ReinsFx = { mount: mount, scan: scan };
})();

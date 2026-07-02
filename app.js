(function(){
"use strict";

var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ============================================================
   ROAD PATH — shared sine wiggle used by both the DOM road
   layer (skid marks drawn in document flow) and the 3D car
   overlay (fixed to viewport), so the car always rides the
   line that's painted on the page.
   ============================================================ */
var Road = {
  amplitude: 120,
  wavelength: 1400,
  centerX: window.innerWidth / 2,
  docHeight: document.documentElement.scrollHeight,
  viewportW: window.innerWidth,

  xAt: function(docY){
    var amp = this.amplitude;
    return this.centerX + Math.sin(docY / this.wavelength) * amp;
  },
  slopeAt: function(docY){
    // derivative of xAt wrt docY, used for steering angle
    var amp = this.amplitude;
    return (amp / this.wavelength) * Math.cos(docY / this.wavelength);
  },
  recalc: function(){
    this.viewportW = window.innerWidth;
    this.centerX = window.innerWidth / 2;
    this.amplitude = Math.min(130, window.innerWidth * 0.22);
    this.docHeight = document.documentElement.scrollHeight;
  }
};
Road.recalc();

/* ---------- draw DOM road layer (base dashed line + skid) ---------- */
var roadLayerEl = document.getElementById('road-layer');
var svgEl = roadLayerEl.querySelector('svg');
var basePathEl = document.getElementById('road-base-path');
var skidPathEl = document.getElementById('road-skid-path');

function buildRoadPathString(){
  var h = Road.docHeight;
  var step = 24;
  var pts = [];
  for (var y = 0; y <= h; y += step){
    pts.push([Road.xAt(y), y]);
  }
  if (pts.length === 0 || pts[pts.length - 1][1] < h){
    pts.push([Road.xAt(h), h]);
  }
  var d = 'M ' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
  for (var i = 1; i < pts.length; i++){
    d += ' L ' + pts[i][0].toFixed(1) + ' ' + pts[i][1].toFixed(1);
  }
  return d;
}

var skidPathLength = 0;

function layoutRoad(){
  Road.recalc();
  svgEl.setAttribute('width', Road.viewportW);
  svgEl.setAttribute('height', Road.docHeight);
  svgEl.setAttribute('viewBox', '0 0 ' + Road.viewportW + ' ' + Road.docHeight);
  roadLayerEl.style.height = Road.docHeight + 'px';

  var d = buildRoadPathString();
  basePathEl.setAttribute('d', d);
  skidPathEl.setAttribute('d', d);

  skidPathLength = skidPathEl.getTotalLength();
  skidPathEl.style.strokeDasharray = skidPathLength;
  skidPathEl.style.strokeDashoffset = skidPathLength;
}

function updateSkidReveal(){
  var scrollFrac = window.scrollY / Math.max(1, (Road.docHeight - window.innerHeight));
  scrollFrac = Math.max(0, Math.min(1, scrollFrac));
  var offset = skidPathLength * (1 - scrollFrac);
  skidPathEl.style.strokeDashoffset = offset;
}

/* ============================================================
   SCROLL REVEALS
   ============================================================ */
var revealEls = document.querySelectorAll('.reveal, .reveal-stagger');
if (reduceMotion){
  revealEls.forEach(function(el){ el.classList.add('is-visible'); });
} else if ('IntersectionObserver' in window){
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(entry){
      if (entry.isIntersecting){
        entry.target.classList.add('is-visible');
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.18, rootMargin: '0px 0px -60px 0px' });
  revealEls.forEach(function(el){ io.observe(el); });
} else {
  revealEls.forEach(function(el){ el.classList.add('is-visible'); });
}

/* ---------- stat counters ---------- */
var statNums = document.querySelectorAll('.stat .num');
var statsAnimated = false;
function animateStats(){
  if (statsAnimated) return;
  statsAnimated = true;
  statNums.forEach(function(el){
    var target = parseInt(el.getAttribute('data-count'), 10);
    var suffix = el.getAttribute('data-suffix') || '';
    var dur = reduceMotion ? 1 : 1400;
    var start = null;
    function step(ts){
      if (start === null) start = ts;
      var p = Math.min(1, (ts - start) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      var val = Math.round(target * eased);
      el.textContent = val.toLocaleString() + suffix;
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
}
var statsSection = document.querySelector('.stats');
if (statsSection && 'IntersectionObserver' in window){
  var statsIO = new IntersectionObserver(function(entries){
    entries.forEach(function(entry){
      if (entry.isIntersecting){ animateStats(); statsIO.disconnect(); }
    });
  }, { threshold: 0.4 });
  statsIO.observe(statsSection);
} else {
  animateStats();
}

/* ============================================================
   NAV SCROLL STATE
   ============================================================ */
var navEl = document.getElementById('nav');
function updateNav(){
  if (window.scrollY > 40) navEl.classList.add('scrolled');
  else navEl.classList.remove('scrolled');
}

/* ============================================================
   THREE.JS — DRIFTING BRAIN-CAR
   ============================================================ */
var canvas = document.getElementById('car-canvas');
var renderer, scene, camera, carGroup, wheels = [], brainMesh, engineLight;
var smokePool = [];
var MAX_SMOKE = 70;
var smokeTexture;
var clock = new THREE.Clock();

var carState = {
  x: Road.centerX,
  y: 0,
  targetX: Road.centerX,
  yaw: 0,
  bank: 0,
  lastScrollY: window.scrollY,
  speed: 0,
  smoothSpeed: 0
};

function initThree(){
  renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);

  scene = new THREE.Scene();

  var w = window.innerWidth, h = window.innerHeight;
  camera = new THREE.OrthographicCamera(-w/2, w/2, h/2, -h/2, 1, 2000);
  camera.position.set(0, 220, 620);
  camera.lookAt(0, -20, 0);

  var ambient = new THREE.AmbientLight(0x554466, 0.9);
  scene.add(ambient);

  var key = new THREE.DirectionalLight(0xffffff, 1.05);
  key.position.set(200, 400, 300);
  scene.add(key);

  var rim = new THREE.DirectionalLight(0x8b6bff, 0.55);
  rim.position.set(-300, 120, -200);
  scene.add(rim);

  engineLight = new THREE.PointLight(0xff5a36, 0.6, 260);
  engineLight.position.set(0, -10, 0);
  scene.add(engineLight);

  buildSmokeTexture();
  buildCar();

  window.addEventListener('resize', onThreeResize);
}

function onThreeResize(){
  var w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  camera.left = -w/2; camera.right = w/2; camera.top = h/2; camera.bottom = -h/2;
  camera.updateProjectionMatrix();
}

/* ---------- build the brain-car mesh ---------- */
function buildCar(){
  carGroup = new THREE.Group();

  // --- BRAIN BODY ---
  var geo = new THREE.IcosahedronGeometry(48, 4);
  var pos = geo.attributes.position;
  var v = new THREE.Vector3();
  for (var i = 0; i < pos.count; i++){
    v.fromBufferAttribute(pos, i);
    var n = v.clone().normalize();
    var freq = 2.6;
    var noise = Math.sin(n.x * freq * 2.1 + n.y * 3.3) * 0.5
              + Math.sin(n.y * freq * 3.1 + n.z * 1.7) * 0.32
              + Math.sin(n.z * freq * 2.4 + n.x * 2.9) * 0.22;
    var groove = 0;
    if (Math.abs(n.x) < 0.16){
      groove = -0.42 * (1 - Math.abs(n.x) / 0.16);
    }
    var displaced = 1 + (noise * 0.11) + groove * 0.11;
    v.copy(n).multiplyScalar(48 * displaced);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();

  var brainMat = new THREE.MeshStandardMaterial({
    color: 0x9d86ff,
    roughness: 0.42,
    metalness: 0.08,
    emissive: 0x3a2a7a,
    emissiveIntensity: 0.22
  });
  brainMesh = new THREE.Mesh(geo, brainMat);
  brainMesh.position.y = 26;
  brainMesh.scale.set(1, 0.86, 1.02);
  carGroup.add(brainMesh);

  // --- CHASSIS PLATE ---
  var chassisGeo = new THREE.BoxGeometry(112, 10, 76, 2, 1, 2);
  var chassisMat = new THREE.MeshStandardMaterial({ color: 0x121319, roughness: 0.55, metalness: 0.4 });
  var chassis = new THREE.Mesh(chassisGeo, chassisMat);
  chassis.position.y = -6;
  carGroup.add(chassis);

  // --- WHEELS ---
  var wheelGeo = new THREE.CylinderGeometry(20, 20, 16, 20);
  wheelGeo.rotateZ(Math.PI / 2);
  var wheelMat = new THREE.MeshStandardMaterial({ color: 0x0d0e12, roughness: 0.75, metalness: 0.25 });
  var discGeo = new THREE.TorusGeometry(11, 2, 8, 20);
  var discMat = new THREE.MeshStandardMaterial({ color: 0xff5a36, emissive: 0xff5a36, emissiveIntensity: 0.9, roughness: 0.3 });

  var offsets = [
    { x:  44, z:  34, front: true  },
    { x:  44, z: -34, front: true  },
    { x: -44, z:  34, front: false },
    { x: -44, z: -34, front: false }
  ];

  offsets.forEach(function(o){
    var wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.position.set(o.x, -18, o.z);
    var disc = new THREE.Mesh(discGeo, discMat);
    disc.rotation.y = Math.PI / 2;
    disc.position.set(o.x + (o.z > 0 ? 8.5 : -8.5), -18, o.z);
    carGroup.add(wheel);
    carGroup.add(disc);
    wheels.push({ mesh: wheel, front: o.front, side: o.z > 0 ? 1 : -1, offset: o });
  });

  // --- HEADLIGHTS ---
  var lightGeo = new THREE.SphereGeometry(4, 12, 12);
  var lightMat = new THREE.MeshStandardMaterial({ color: 0xeaf6ff, emissive: 0xeaf6ff, emissiveIntensity: 1.4 });
  [ -18, 18 ].forEach(function(z){
    var hl = new THREE.Mesh(lightGeo, lightMat);
    hl.position.set(58, 6, z);
    carGroup.add(hl);
  });

  // --- SPOILER (small, for character) ---
  var spoilerGeo = new THREE.BoxGeometry(4, 14, 66);
  var spoilerMat = new THREE.MeshStandardMaterial({ color: 0x1a1c24, roughness: 0.5 });
  var spoiler = new THREE.Mesh(spoilerGeo, spoilerMat);
  spoiler.position.set(-56, 22, 0);
  carGroup.add(spoiler);
  var strutGeo = new THREE.BoxGeometry(3, 16, 3);
  [ -22, 22 ].forEach(function(z){
    var strut = new THREE.Mesh(strutGeo, spoilerMat);
    strut.position.set(-56, 10, z);
    carGroup.add(strut);
  });

  // ground contact shadow (soft blurred ellipse)
  var shadowTex = buildShadowTexture();
  var shadowMat = new THREE.SpriteMaterial({ map: shadowTex, transparent: true, opacity: 0.5, depthWrite: false });
  var shadowSprite = new THREE.Sprite(shadowMat);
  shadowSprite.scale.set(170, 70, 1);
  shadowSprite.position.y = -30;
  carGroup.add(shadowSprite);

  carGroup.scale.setScalar(carScaleForViewport());
  scene.add(carGroup);
}

function carScaleForViewport(){
  var w = window.innerWidth;
  if (w < 540) return 0.62;
  if (w < 900) return 0.8;
  return 1;
}

function buildShadowTexture(){
  var c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  var ctx = c.getContext('2d');
  var grad = ctx.createRadialGradient(64, 32, 4, 64, 32, 60);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 64);
  return new THREE.CanvasTexture(c);
}

function buildSmokeTexture(){
  var c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  var ctx = c.getContext('2d');
  var grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
  grad.addColorStop(0, 'rgba(220,218,225,0.85)');
  grad.addColorStop(0.5, 'rgba(200,198,208,0.4)');
  grad.addColorStop(1, 'rgba(200,198,208,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(32, 32, 30, 0, Math.PI * 2);
  ctx.fill();
  smokeTexture = new THREE.CanvasTexture(c);
}

/* ---------- smoke particles ---------- */
function spawnSmoke(worldPos, intensity){
  if (smokePool.length >= MAX_SMOKE) return;
  var mat = new THREE.SpriteMaterial({
    map: smokeTexture,
    transparent: true,
    depthWrite: false,
    opacity: 0.55 * intensity
  });
  var sprite = new THREE.Sprite(mat);
  var s = 14 + Math.random() * 10;
  sprite.scale.set(s, s, 1);
  sprite.position.set(
    worldPos.x + (Math.random() - 0.5) * 8,
    worldPos.y + (Math.random() - 0.5) * 6,
    worldPos.z + (Math.random() - 0.5) * 8
  );
  scene.add(sprite);
  smokePool.push({
    sprite: sprite,
    life: 0,
    maxLife: 0.9 + Math.random() * 0.5,
    vx: (Math.random() - 0.5) * 22,
    vy: 14 + Math.random() * 14,
    vz: (Math.random() - 0.5) * 22,
    growTo: s * (2.4 + Math.random() * 1.2)
  });
}

function updateSmoke(dt){
  for (var i = smokePool.length - 1; i >= 0; i--){
    var p = smokePool[i];
    p.life += dt;
    var t = p.life / p.maxLife;
    if (t >= 1){
      scene.remove(p.sprite);
      p.sprite.material.dispose();
      smokePool.splice(i, 1);
      continue;
    }
    p.sprite.position.x += p.vx * dt;
    p.sprite.position.y += p.vy * dt;
    p.sprite.position.z += p.vz * dt;
    var scale = p.sprite.scale.x + (p.growTo - p.sprite.scale.x) * dt * 1.6;
    p.sprite.scale.set(scale, scale, 1);
    p.sprite.material.opacity = 0.55 * (1 - t);
  }
}

/* ---------- per-frame update ---------- */
function updateCar(dt, elapsed){
  var scrollY = window.scrollY;
  var docY = scrollY + carState.screenYpx;

  carState.targetX = Road.xAt(docY);
  carState.x += (carState.targetX - carState.x) * Math.min(1, dt * 6);

  var slope = Road.slopeAt(docY);
  var targetYaw = Math.atan(slope * 2.2);
  carState.yaw += (targetYaw - carState.yaw) * Math.min(1, dt * 5);

  var targetBank = -targetYaw * 0.9;
  carState.bank += (targetBank - carState.bank) * Math.min(1, dt * 5);

  var dScroll = scrollY - carState.lastScrollY;
  carState.lastScrollY = scrollY;
  var instSpeed = Math.min(60, Math.abs(dScroll) / Math.max(dt, 0.001) / 30);
  carState.smoothSpeed += (instSpeed - carState.smoothSpeed) * Math.min(1, dt * 4);

  var scale = carScaleForViewport();
  carGroup.scale.setScalar(scale);

  var worldX = carState.x - Road.viewportW / 2;
  var bobY = Math.sin(elapsed * 2.1) * 3 + Math.sin(elapsed * 5.3) * 1.1;
  var baseY = typeof carState.worldYTarget === 'number' ? carState.worldYTarget : 0;
  carGroup.position.set(worldX, baseY + bobY, 0);
  carGroup.rotation.y = -carState.yaw;
  carGroup.rotation.z = carState.bank * 0.5;
  carGroup.rotation.x = Math.sin(elapsed * 1.7) * 0.01;

  // wheel spin
  var spin = (dScroll * 0.02) + carState.smoothSpeed * 0.15 + 0.02;
  wheels.forEach(function(w){
    w.mesh.rotation.x += spin;
  });

  // engine light pulse tied to speed
  engineLight.intensity = 0.5 + carState.smoothSpeed * 0.9 + Math.sin(elapsed * 6) * 0.05;

  // smoke emission: idle trickle + burst with speed, from rear wheels
  var emitChance = 0.06 + carState.smoothSpeed * 0.5;
  wheels.forEach(function(w){
    if (w.front) return;
    if (Math.random() < emitChance * dt * 12){
      var local = new THREE.Vector3(w.offset.x, -18, w.offset.z);
      var worldPos = local.applyMatrix4(carGroup.matrixWorld);
      spawnSmoke(worldPos, Math.min(1, 0.35 + carState.smoothSpeed * 0.6));
    }
  });
}

carState.screenYpx = window.innerHeight * 0.4;

function updateCarScreenAnchor(){
  var scrollFrac = window.scrollY / Math.max(1, (Road.docHeight - window.innerHeight));
  scrollFrac = Math.max(0, Math.min(1, scrollFrac));
  var fromVh = 0.34, toVh = 0.66;
  carState.screenYpx = window.innerHeight * (fromVh + (toVh - fromVh) * scrollFrac);

  // map screen-space y to world-space y for the ortho camera (camera looks
  // slightly down, so approximate with a fixed vertical placement band)
  var worldY = (window.innerHeight / 2 - carState.screenYpx) * 0.62;
  carState.worldYTarget = worldY;
}

/* ---------- render loop ---------- */
var threeReady = false;
function animate(){
  requestAnimationFrame(animate);
  if (!threeReady) return;
  var dt = Math.min(0.05, clock.getDelta());
  var elapsed = clock.getElapsedTime();
  updateCarScreenAnchor();
  updateCar(dt, elapsed);
  updateSmoke(dt);
  renderer.render(scene, camera);
}

/* ============================================================
   INIT
   ============================================================ */
function init(){
  layoutRoad();
  updateNav();
  updateSkidReveal();

  if (!reduceMotion && window.WebGLRenderingContext){
    try {
      initThree();
      threeReady = true;
      animate();
    } catch (e){
      canvas.style.display = 'none';
    }
  } else {
    canvas.style.display = 'none';
  }

  var ticking = false;
  window.addEventListener('scroll', function(){
    if (!ticking){
      requestAnimationFrame(function(){
        updateNav();
        updateSkidReveal();
        ticking = false;
      });
      ticking = true;
    }
  }, { passive: true });

  var resizeTimer;
  window.addEventListener('resize', function(){
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function(){
      layoutRoad();
      updateSkidReveal();
    }, 150);
  });
}

if (document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();

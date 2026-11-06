/**
 * main.js — WebXR AR (hit-test) + โหมดดูตัวอย่าง 3D + ปุ่มควบคุม
 */
import * as THREE from 'three';
import { loadDino } from './dino.js';
import { AudioFX } from './audio.js';

const $ = (s) => document.querySelector(s);
const el = {
  overlay: $('#overlay'), start: $('#start-screen'), hud: $('#hud'),
  btnAR: $('#btn-start-ar'), btnPreview: $('#btn-preview'), btnExit: $('#btn-exit'),
  support: $('#support-msg'), hint: $('#hint'), chip: $('#mode-chip'),
  status: $('#status'), toast: $('#toast'), controls: $('.controls'),
};

const AR_SCALE = 0.3;       // ไดโนเสาร์ยาวประมาณ 1.5 ม. / สูง ~0.8 ม.
const PREVIEW_SCALE = 1;
const MIN_SCALE = 0.04, MAX_SCALE = 2.5;

const audio = new AudioFX();

/* ───────────── Three.js scene ───────────── */
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local');
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.02, 200);
camera.position.set(0, 3, 9);

// แสง: ท้องฟ้า/พื้น + แดดที่ทำเงา
scene.add(new THREE.HemisphereLight(0xffffff, 0x7a7560, 1.5));
const sun = new THREE.DirectionalLight(0xfff1d6, 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
scene.add(sun, sun.target);

// พื้นรับเงา (โปร่งใส เห็นแต่เงา) สำหรับโหมด AR
const shadowPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
  new THREE.ShadowMaterial({ opacity: 0.5 }),
);
shadowPlane.receiveShadow = true;
shadowPlane.visible = false;
scene.add(shadowPlane);

// พื้นจริงสำหรับโหมดดูตัวอย่าง
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(60, 64).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x4a5a2c, roughness: 1 }),
);
ground.receiveShadow = true;
ground.visible = false;
scene.add(ground);

// วงแหวนบอกตำแหน่งที่จะวาง
const reticle = new THREE.Group();
reticle.matrixAutoUpdate = false;
reticle.visible = false;
{
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xf2b632, transparent: true, opacity: 0.95 });
  reticle.add(
    new THREE.Mesh(new THREE.RingGeometry(0.13, 0.16, 40).rotateX(-Math.PI / 2), ringMat),
    new THREE.Mesh(new THREE.CircleGeometry(0.018, 16).rotateX(-Math.PI / 2), ringMat),
  );
  const tick = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.215, 40, 1, 0, Math.PI * 1.5).rotateX(-Math.PI / 2), ringMat);
  tick.name = 'spin';
  reticle.add(tick);
}
scene.add(reticle);

/* ───────────── สถานะ ───────────── */
let dino = null;
let mode = null;               // null | 'ar' | 'preview'
let session = null;
let hitTestSource = null;
let placed = false;
let cameraGranted = false;
let lastGesture = 0;
const tmpV = new THREE.Vector3();

// กล้องโหมดดูตัวอย่าง
const orbit = { az: 0.6, pol: 1.25, dist: 9 };

/* ───────────── UI helpers ───────────── */
let toastTimer = 0;
function toast(msg, ms = 2200) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
}
function showNotice(html) { el.support.innerHTML = html; el.support.hidden = false; }
function setHint(text, ok = false) {
  if (el.hint.textContent !== text) el.hint.textContent = text;
  el.hint.classList.toggle('ok', ok);
}
function showHUD(on) {
  el.hud.hidden = !on;
  el.start.hidden = on;
}

/* ───────────── ตรวจความสามารถของอุปกรณ์ + สิทธิ์กล้อง ───────────── */
async function checkSupport() {
  let reason = '';
  let ok = false;
  if (!window.isSecureContext) {
    reason = '<b>ต้องเปิดผ่าน HTTPS</b> (หรือ localhost) เบราว์เซอร์จึงจะอนุญาตให้ใช้กล้องและ WebXR';
  } else if (!('xr' in navigator)) {
    reason = '<b>อุปกรณ์/เบราว์เซอร์นี้ไม่รองรับ WebXR</b><br>ให้ใช้ <b>Chrome บน Android</b> ที่รองรับ ARCore (iPhone/iOS Safari ยังไม่รองรับ WebXR AR)';
  } else {
    try {
      ok = await navigator.xr.isSessionSupported('immersive-ar');
      if (!ok) reason = '<b>อุปกรณ์นี้ไม่รองรับ WebXR AR</b><br>ต้องใช้มือถือที่รองรับ ARCore และติดตั้ง "Google Play Services for AR"';
    } catch (e) {
      reason = '<b>ตรวจสอบ WebXR ไม่สำเร็จ</b>: ' + (e.message || e);
    }
  }
  if (!ok) {
    showNotice(reason + '<br>คุณยังกด <b>ดูตัวอย่าง 3D</b> เพื่อดูไดโนเสาร์และทดสอบปุ่มได้');
    el.btnAR.disabled = true;
    el.btnAR.textContent = 'AR ไม่พร้อมใช้งาน';
    return false;
  }
  try {
    if (navigator.permissions?.query) {
      const r = await navigator.permissions.query({ name: 'camera' });
      cameraGranted = r.state === 'granted';
      r.onchange = () => { cameraGranted = r.state === 'granted'; refreshARButton(); };
    }
  } catch { /* บางเบราว์เซอร์ไม่รองรับ query กล้อง */ }
  if (!navigator.mediaDevices?.getUserMedia) cameraGranted = true; // ให้ WebXR ขอสิทธิ์เอง
  el.btnAR.disabled = false;
  refreshARButton();
  return true;
}
function refreshARButton() {
  if (!el.btnAR.disabled) el.btnAR.textContent = cameraGranted ? 'เริ่ม AR' : 'อนุญาตใช้กล้อง';
}

async function requestCamera() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    s.getTracks().forEach((t) => t.stop());
    return true;
  } catch (e) {
    if (e.name === 'NotAllowedError' || e.name === 'SecurityError') {
      showNotice('<b>ไม่ได้รับอนุญาตให้ใช้กล้อง</b><br>แตะไอคอนแม่กุญแจข้าง URL → การอนุญาต → เปิด "กล้อง" แล้วลองใหม่');
      return false;
    }
    if (e.name === 'NotFoundError') {
      showNotice('<b>ไม่พบกล้องบนอุปกรณ์นี้</b>');
      return false;
    }
    return true; // error อื่นๆ ให้ WebXR ลองเอง
  }
}

/* ───────────── เริ่ม/จบ AR ───────────── */
async function onStartAR() {
  audio.unlock();
  el.support.hidden = true;
  if (!cameraGranted) {
    // ขั้นที่ 1: ขอสิทธิ์กล้อง (แยกจากการเริ่มเซสชัน เพราะ requestSession ต้องมาจากการแตะ)
    el.btnAR.disabled = true;
    const ok = await requestCamera();
    el.btnAR.disabled = false;
    if (ok) { cameraGranted = true; refreshARButton(); toast('อนุญาตกล้องแล้ว — แตะ "เริ่ม AR" อีกครั้ง', 3000); }
    return;
  }
  try {
    session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay', 'local-floor'],
      domOverlay: { root: el.overlay },
    });
  } catch (e) {
    showNotice('<b>เริ่ม AR ไม่สำเร็จ</b><br>' + (e.message || e));
    return;
  }
  session.addEventListener('end', onSessionEnd);
  await renderer.xr.setSession(session);

  const viewer = await session.requestReferenceSpace('viewer');
  hitTestSource = await session.requestHitTestSource({ space: viewer });

  const controller = renderer.xr.getController(0);
  controller.addEventListener('select', onSelect);
  scene.add(controller);

  enterMode('ar');
}

function onSessionEnd() {
  hitTestSource?.cancel?.();
  hitTestSource = null;
  session = null;
  leaveMode();
}

/* ───────────── โหมดดูตัวอย่าง 3D ───────────── */
function onStartPreview() {
  audio.unlock();
  enterMode('preview');
}

function enterMode(m) {
  mode = m;
  document.body.classList.toggle('in-ar', m === 'ar');
  showHUD(true);
  el.chip.textContent = m === 'ar' ? 'AR' : 'PREVIEW';
  placed = false;
  dino.resetPose();
  if (m === 'ar') {
    scene.background = null; scene.fog = null;
    ground.visible = false; shadowPlane.visible = true;
    dino.root.visible = false;
    setScale(AR_SCALE);
  } else {
    scene.background = new THREE.Color(0x16240f);
    scene.fog = new THREE.Fog(0x16240f, 25, 70);
    ground.visible = true; shadowPlane.visible = false; reticle.visible = false;
    dino.root.position.set(0, 0, 0);
    dino.anchor.set(0, 0, 0);
    dino.setHeading(0);
    dino.root.visible = true;
    placed = true;
    setScale(PREVIEW_SCALE);
    setHint('ลากนิ้ว = หมุนกล้อง · หนีบ 2 นิ้ว/ล้อเมาส์ = ซูม', true);
  }
}

function leaveMode() {
  mode = null;
  document.body.classList.remove('in-ar');
  scene.background = null; scene.fog = null;
  ground.visible = false; shadowPlane.visible = false; reticle.visible = false;
  dino.root.visible = false;
  showHUD(false);
  renderer.setAnimationLoop(render);
}

el.btnExit.addEventListener('click', () => {
  if (session) session.end();
  else leaveMode();
});

/* ───────────── วาง/ย้ายไดโนเสาร์ ───────────── */
function setScale(s) {
  s = THREE.MathUtils.clamp(s, MIN_SCALE, MAX_SCALE);
  dino.root.scale.setScalar(s);
  dino.wanderRadius = Math.max(1.2, 8 * s);
  return s;
}

function onSelect() {
  if (performance.now() - lastGesture < 450) return; // เป็นท่าหนีบนิ้ว ไม่ใช่การแตะวาง
  if (!reticle.visible) { toast('ยังไม่พบพื้นผิว — ขยับมือถือช้าๆ ให้เห็นพื้น'); return; }
  audio.unlock();
  const first = !placed;
  dino.root.position.setFromMatrixPosition(reticle.matrix);
  dino.anchor.copy(dino.root.position);
  if (first) {
    // หันหน้าเข้าหาผู้ใช้
    camera.updateMatrixWorld();
    renderer.xr.getCamera().getWorldPosition(tmpV);
    dino.setHeading(Math.atan2(tmpV.x - dino.root.position.x, tmpV.z - dino.root.position.z));
  }
  dino.root.visible = true;
  placed = true;
  audio.ping();
  navigator.vibrate?.(30);
  if (first) setTimeout(() => dino.roar(), 350);
}

/* ───────────── ปุ่มควบคุม ───────────── */
const actions = {
  walk: () => { dino.walk(); },
  idle: () => { dino.idle(); },
  roar: () => { dino.roar(); },
  attack: () => { dino.attack(); },
  rotate: () => { dino.turnBy(-Math.PI / 4); },
  rotl: () => { dino.turnBy(Math.PI / 4); },
  smaller: () => { setScale(dino.root.scale.x * 0.8); },
  bigger: () => { setScale(dino.root.scale.x * 1.25); },
  reset: () => {
    dino.resetPose();
    if (mode === 'ar') {
      placed = false; dino.root.visible = false; setScale(AR_SCALE);
      toast('เริ่มต้นใหม่ — แตะพื้นเพื่อวางไดโนเสาร์');
    } else {
      dino.root.position.set(0, 0, 0); dino.anchor.set(0, 0, 0); dino.setHeading(0);
      setScale(PREVIEW_SCALE);
      Object.assign(orbit, { az: 0.6, pol: 1.25, dist: 9 });
    }
  },
};
el.controls.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b || !dino) return;
  audio.unlock();
  if (!placed && b.dataset.act !== 'reset') { toast('แตะที่พื้นเพื่อวางไดโนเสาร์ก่อน'); return; }
  actions[b.dataset.act]?.();
});

// ปุ่ม/แถบ UI ต้องไม่ถูกนับเป็นการแตะวางใน WebXR
el.overlay.addEventListener('beforexrselect', (e) => {
  if (e.target.closest?.('button, .controls, .hud-top')) e.preventDefault();
});

/* ───────────── ท่าทางสัมผัส ───────────── */
const pointers = new Map();
let pinch = null;
function gestureStart() {
  const [a, b] = [...pointers.values()];
  pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), ang: Math.atan2(b.y - a.y, b.x - a.x) };
}
el.overlay.addEventListener('pointerdown', (e) => {
  if (!mode || e.target.closest('button, .hud-top')) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) { gestureStart(); lastGesture = performance.now(); }
});
el.overlay.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (pointers.size === 2 && pinch) {
    lastGesture = performance.now();
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    if (mode === 'ar') {
      if (placed) {
        setScale(dino.root.scale.x * (d / pinch.d));
        let da = ang - pinch.ang;
        if (da > Math.PI) da -= Math.PI * 2; if (da < -Math.PI) da += Math.PI * 2;
        dino.addYaw(-da);
      }
    } else {
      orbit.dist = THREE.MathUtils.clamp(orbit.dist * (pinch.d / d), 3, 30);
    }
    pinch.d = d; pinch.ang = ang;
  } else if (pointers.size === 1 && mode === 'preview') {
    orbit.az -= dx * 0.008;
    orbit.pol = THREE.MathUtils.clamp(orbit.pol - dy * 0.006, 0.25, 1.5);
  }
});
const endPointer = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; };
el.overlay.addEventListener('pointerup', endPointer);
el.overlay.addEventListener('pointercancel', endPointer);
el.overlay.addEventListener('wheel', (e) => {
  if (mode === 'preview') orbit.dist = THREE.MathUtils.clamp(orbit.dist * (1 + e.deltaY * 0.001), 3, 30);
}, { passive: true });

/* ───────────── วนเฟรม ───────────── */
let lastT = performance.now();
let lastUI = '';

function updateHitTest(frame) {
  const refSpace = renderer.xr.getReferenceSpace();
  const results = hitTestSource ? frame.getHitTestResults(hitTestSource) : [];
  if (results.length) {
    const pose = results[0].getPose(refSpace);
    reticle.visible = true;
    reticle.matrix.fromArray(pose.transform.matrix);
  } else {
    reticle.visible = false;
  }
}

function updateLight() {
  const s = dino.root.scale.x, p = dino.root.position;
  sun.position.set(p.x + 3 * s, p.y + 8 * s, p.z + 2 * s);
  sun.target.position.copy(p);
  const c = sun.shadow.camera;
  const r = 4.2 * s;
  c.left = -r; c.right = r; c.top = r; c.bottom = -r; c.near = 2 * s; c.far = 16 * s;
  c.updateProjectionMatrix();
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.03 * s;
  shadowPlane.position.set(p.x, p.y + 0.001, p.z);
  shadowPlane.scale.setScalar(Math.max(8 * s, 1.5));
  if (mode === 'preview') ground.position.y = 0;
}

function updateOrbit() {
  const p = dino.root.position, s = dino.root.scale.x;
  tmpV.set(p.x, p.y + 1.3 * s, p.z);
  const sp = Math.sin(orbit.pol);
  camera.position.set(
    tmpV.x + orbit.dist * sp * Math.sin(orbit.az),
    tmpV.y + orbit.dist * Math.cos(orbit.pol),
    tmpV.z + orbit.dist * sp * Math.cos(orbit.az),
  );
  camera.lookAt(tmpV);
}

function updateUI() {
  const act = dino.action;
  const walking = dino.state === 'walk';
  const key = [act, walking, dino.turning, placed, reticle.visible, mode].join('|');
  if (key === lastUI) return;
  lastUI = key;
  const on = (id, v) => $(id).classList.toggle('active', !!v);
  on('#btn-walk', walking && !act);
  on('#btn-idle', !walking && !act);
  on('#btn-roar', act === 'roar');
  on('#btn-attack', act === 'attack');
  let label = '';
  if (act) label = act.toUpperCase() + '!';
  else if (dino.turning) label = 'TURNING';
  else if (walking) label = 'WALKING';
  el.status.textContent = label;
  el.status.classList.toggle('show', !!label);
  if (mode === 'ar') {
    if (!placed) {
      reticle.visible ? setHint('แตะหน้าจอเพื่อวางไดโนเสาร์', true) : setHint('ขยับมือถือช้าๆ เพื่อค้นหาพื้นผิว…');
    } else {
      setHint('แตะพื้นเพื่อย้าย · หนีบ 2 นิ้ว = ย่อ/ขยาย/หมุน', true);
    }
  }
}

function render(ts, frame) {
  const now = performance.now();
  const dt = Math.min((now - lastT) / 1000, 0.1);
  lastT = now;
  if (mode === 'ar' && frame) updateHitTest(frame);
  if (mode && dino) {
    dino.update(dt);
    updateLight();
    if (mode === 'preview') updateOrbit();
    const spin = reticle.getObjectByName('spin');
    if (spin) spin.rotation.y += dt * 1.5;
    updateUI();
  }
  if (mode === 'ar' && !frame) return;
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ───────────── เริ่มต้น ───────────── */
async function init() {
  el.btnAR.disabled = true;
  el.btnPreview.disabled = true;
  dino = await loadDino('models/dino.glb');
  dino.root.visible = false;
  scene.add(dino.root);
  dino.events.roar = () => { audio.roar(); navigator.vibrate?.([120, 40, 160, 40, 220]); };
  dino.events.attack = () => { audio.attack(); navigator.vibrate?.([60, 30, 120]); };
  dino.events.step = (amp) => audio.step(amp * THREE.MathUtils.clamp(dino.root.scale.x * 2, 0.25, 1));
  el.btnPreview.disabled = false;
  el.btnAR.addEventListener('click', onStartAR);
  el.btnPreview.addEventListener('click', onStartPreview);
  renderer.setAnimationLoop(render);
  await checkSupport();
  window.__app = { dino, scene, camera, renderer, orbit, enterMode, get mode() { return mode; } };
}
init();

/**
 * dino.js — โมเดลไดโนเสาร์ 3D + ระบบแอนิเมชัน
 *
 *  • ProceduralDino : ไดโนเสาร์ 3D สร้างจากเมช (คอ/หัว/ขากรรไกร/หาง 6 ปล้อง/ขา 3 ท่อน/แขน)
 *                     จัดเป็นโครงกระดูกลำดับชั้น (hierarchy) แล้วขยับด้วยโค้ด
 *                     จึงทำงานได้ทันทีโดยไม่ต้องมีไฟล์โมเดลเพิ่ม
 *  • GLBDino        : ถ้ามีไฟล์ models/dino.glb จะโหลดมาใช้แทน และเล่น AnimationClip
 *                     ที่ชื่อมีคำว่า idle / walk / roar / turn / attack
 *
 * ทั้งสองคลาสใช้ API เดียวกัน: idle() walk() roar() attack() turnBy() update(dt)
 */
import * as THREE from 'three';

/* ───────────────────────── utilities ───────────────────────── */
const clamp = THREE.MathUtils.clamp;
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const angleDiff = (a, b) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROAR_DURATION = 3.0;
const ATTACK_DURATION = 1.6;

/* ───────────────────────── base class ───────────────────────── */
class DinoBase {
  constructor() {
    this.root = new THREE.Group();   // ตำแหน่ง/หมุน/สเกล ในโลกจริง
    this.rig = new THREE.Group();    // ออฟเซ็ตท่าทาง (เช่น พุ่งตัวตอนโจมตี)
    this.root.add(this.rig);

    this.state = 'idle';             // 'idle' | 'walk'
    this.action = null;              // null | 'roar' | 'attack'
    this.actionT = 0;
    this._fired = false;

    this.heading = 0;
    this.targetHeading = 0;
    this.turnDir = 0;
    this.turning = false;

    this.t = 0;
    this.phase = 0;
    this._stepIdx = 0;
    this.w = { walk: 0, turn: 0, busy: 0 };

    this.anchor = new THREE.Vector3();
    this.wanderRadius = 2.5;          // เมตร (โลกจริง)
    this.walkSpeed = 1.8;             // หน่วยโมเดล/วินาที
    this.events = { roar() {}, attack() {}, step() {} };
  }

  /* ---- คำสั่งจากปุ่ม ---- */
  idle() { this.state = 'idle'; }
  walk() { this.state = 'walk'; }
  roar() { if (!this.action) { this.action = 'roar'; this.actionT = 0; this._fired = false; } }
  attack() { if (!this.action) { this.action = 'attack'; this.actionT = 0; this._fired = false; } }
  turnBy(rad) { this.targetHeading += rad; }
  addYaw(rad) { this.heading += rad; this.targetHeading += rad; }
  setHeading(h) { this.heading = this.targetHeading = h; this.root.rotation.y = h; }
  resetPose() {
    this.state = 'idle'; this.action = null; this.actionT = 0;
    this.w.walk = this.w.turn = this.w.busy = 0;
    this.targetHeading = this.heading;
  }
  get busy() { return !!this.action; }

  /* ---- วงจรอัปเดตหลัก ---- */
  update(dt) {
    dt = Math.min(dt, 0.05);
    this.t += dt;
    const w = this.w;

    // หมุนตัวเข้าหาทิศเป้าหมาย
    const err = angleDiff(this.heading, this.targetHeading);
    this.turning = Math.abs(err) > 0.05 && !this.action;
    if (!this.action) {
      this.heading += clamp(err * 3, -1.9, 1.9) * dt;
    }
    this.turnDir = this.turning ? Math.sign(err) : 0;
    this.root.rotation.y = this.heading;

    // action timer
    let p = 0;
    if (this.action) {
      const dur = this.action === 'roar' ? ROAR_DURATION : ATTACK_DURATION;
      this.actionT += dt;
      p = this.actionT / dur;
      const fireAt = this.action === 'roar' ? 0.17 : 0.34;
      if (!this._fired && p >= fireAt) {
        this._fired = true;
        this.events[this.action]();
      }
      if (p >= 1) { this.action = null; this.actionT = 0; p = 0; }
    }

    // น้ำหนักการเบลนด์
    w.walk = damp(w.walk, this.state === 'walk' ? 1 : 0, 5, dt);
    w.turn = damp(w.walk > 0.5 ? 0 : w.turn, this.turning ? 1 : 0, 8, dt);
    w.busy = damp(w.busy, this.action ? 1 : 0, 9, dt);
    const amp = Math.max(w.walk * (1 - w.busy), w.turn * 0.55 * (1 - w.busy));

    // เดินไปข้างหน้า + กันไม่ให้เดินไกลเกินไป
    if (this.state === 'walk') {
      const sc = this.root.scale.x;
      const dx = this.anchor.x - this.root.position.x;
      const dz = this.anchor.z - this.root.position.z;
      if (Math.hypot(dx, dz) > this.wanderRadius) {
        const toAnchor = Math.atan2(dx, dz);
        if (Math.abs(angleDiff(this.targetHeading, toAnchor)) > 0.6) {
          this.targetHeading = this.heading + angleDiff(this.heading, toAnchor);
        }
      }
      const sp = this.walkSpeed * w.walk * (1 - w.busy) * (1 - 0.6 * Math.min(1, Math.abs(err)));
      this.root.position.x += Math.sin(this.heading) * sp * sc * dt;
      this.root.position.z += Math.cos(this.heading) * sp * sc * dt;
    }

    // เฟสก้าว + เสียงเท้ากระทบพื้น
    this.phase += 4.4 * dt * clamp(w.walk * (1 - w.busy) + 0.55 * w.turn * (1 - w.busy), 0, 1);
    const idx = Math.floor((this.phase - Math.PI / 2) / Math.PI);
    if (idx !== this._stepIdx) {
      this._stepIdx = idx;
      if (amp > 0.35) this.events.step(amp);
    }

    this.pose(dt, { p, amp });
  }

  pose() {}
}

/* ───────────────────────── ProceduralDino ───────────────────────── */
function makeSkinTextures() {
  const size = 512, cell = 30;
  const rnd = mulberry32(7);
  const mk = (mode) => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.fillStyle = mode === 'bump' ? '#222' : '#dcdcdc';
    g.fillRect(0, 0, size, size);
    const rows = Math.ceil(size / (cell * 0.8)) + 1;
    for (let r = 0; r < rows; r++) {
      const cy = r * cell * 0.8;
      const off = (r % 2) * cell / 2;
      for (let x = -cell; x < size + cell; x += cell) {
        const cx = x + off;
        if (mode === 'bump') {
          const gr = g.createRadialGradient(cx, cy, 1, cx, cy, cell * 0.62);
          gr.addColorStop(0, '#fff'); gr.addColorStop(1, '#222');
          g.fillStyle = gr;
        } else {
          const v = Math.floor(185 + rnd() * 70);
          g.fillStyle = `rgb(${v},${v},${v})`;
        }
        g.beginPath(); g.ellipse(cx, cy, cell * 0.6, cell * 0.5, 0, 0, Math.PI * 2); g.fill();
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    return tex;
  };
  const map = mk('color'); map.colorSpace = THREE.SRGBColorSpace;
  const bump = mk('bump');
  return { map, bump };
}

/** ทาสีหลัง/ท้องด้วย vertex color ตามทิศ normal (หลังเขียวเข้ม → ท้องครีม) */
function paint(geo, top = '#3d5a27', bottom = '#cdbb7c') {
  const n = geo.attributes.normal;
  const col = new Float32Array(n.count * 3);
  const ct = new THREE.Color(top), cb = new THREE.Color(bottom), c = new THREE.Color();
  for (let i = 0; i < n.count; i++) {
    const t = smooth(-0.4, 0.6, n.getY(i));
    c.copy(cb).lerp(ct, t);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

export class ProceduralDino extends DinoBase {
  constructor() {
    super();
    this.kind = 'procedural';
    this.L1 = 0.7;      // ความยาวต้นขา
    this.L2 = 0.65;     // ความยาวหน้าแข้ง
    this.FOOT = 0.1;    // ความสูงข้อเท้าจากพื้น
    this.hipY = 1.4;
    this._build();
  }

  _build() {
    const { map, bump } = makeSkinTextures();
    map.repeat.set(1.6, 1.6); bump.repeat.set(1.6, 1.6);
    const skin = new THREE.MeshStandardMaterial({
      vertexColors: true, map, bumpMap: bump, bumpScale: 1.2, roughness: 0.78, metalness: 0.0,
    });
    const toothMat = new THREE.MeshStandardMaterial({ color: 0xf1ead2, roughness: 0.45 });
    const clawMat = new THREE.MeshStandardMaterial({ color: 0x2b2620, roughness: 0.5 });
    const mouthMat = new THREE.MeshStandardMaterial({ color: 0x6a1b1b, roughness: 0.6 });
    const tongueMat = new THREE.MeshStandardMaterial({ color: 0xb04a52, roughness: 0.55 });
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0xe8c23a, roughness: 0.25, emissive: 0x3a2a00 });
    const pupilMat = new THREE.MeshBasicMaterial({ color: 0x050505 });
    this.materials = [skin, toothMat, clawMat, mouthMat, tongueMat, eyeMat, pupilMat];

    const sphereGeo = paint(new THREE.SphereGeometry(1, 28, 20));
    const mesh = (geo, mat) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true; m.receiveShadow = true;
      return m;
    };
    const blob = (rx, ry, rz, x = 0, y = 0, z = 0, mat = skin, geo = sphereGeo) => {
      const m = mesh(geo, mat);
      m.scale.set(rx, ry, rz); m.position.set(x, y, z);
      return m;
    };
    // ท่อนเรียว: dir = 'fwd' (+z) | 'back' (-z) | 'down' (-y)
    const tube = (rBase, rTip, len, dir) => {
      const g = new THREE.CylinderGeometry(rTip, rBase, len, 16, 1);
      g.translate(0, len / 2, 0);
      if (dir === 'back') g.rotateX(-Math.PI / 2);
      else if (dir === 'fwd') g.rotateX(Math.PI / 2);
      else if (dir === 'down') g.rotateX(Math.PI);
      paint(g);
      return mesh(g, skin);
    };
    const cone = (r, len, mat) => {
      const g = new THREE.ConeGeometry(r, len, 8);
      g.translate(0, len / 2, 0);
      paint(g);
      return mesh(g, mat);
    };
    const group = (x = 0, y = 0, z = 0) => { const g = new THREE.Group(); g.position.set(x, y, z); return g; };

    /* ── hips (ศูนย์กลางลำตัว) ── */
    this.hips = group(0, this.hipY, 0);
    this.rig.add(this.hips);

    this.torso = group();
    this.torso.add(
      blob(0.52, 0.58, 0.62, 0, 0.0, -0.3),    // สะโพก
      blob(0.64, 0.70, 1.05, 0, 0.12, 0.35),   // ลำตัว
      blob(0.55, 0.6, 0.5, 0, 0.22, 0.85),     // อก
    );
    this.hips.add(this.torso);

    /* ── คอ + หัว ── */
    this.neck1 = group(0, 0.5, 1.0);
    this.neck1.add(blob(0.4, 0.4, 0.4), tube(0.38, 0.28, 0.55, 'fwd'));
    this.torso.add(this.neck1);
    this.neck2 = group(0, 0, 0.55);
    this.neck2.add(blob(0.29, 0.29, 0.29), tube(0.28, 0.22, 0.5, 'fwd'));
    this.neck1.add(this.neck2);
    this.head = group(0, 0, 0.5);
    this.neck2.add(this.head);

    const head = this.head;
    head.add(
      blob(0.28, 0.28, 0.5, 0, 0, 0.25),             // กะโหลก
      blob(0.2, 0.16, 0.42, 0, -0.04, 0.64),         // จมูก/ขากรรไกรบน
      blob(0.075, 0.055, 0.16, 0.2, 0.2, 0.36),      // หัวคิ้ว
      blob(0.075, 0.055, 0.16, -0.2, 0.2, 0.36),
      blob(0.15, 0.03, 0.4, 0, -0.19, 0.62, mouthMat),   // เพดานปาก
    );
    for (const s of [-1, 1]) {
      head.add(blob(0.06, 0.06, 0.06, s * 0.23, 0.12, 0.38, eyeMat));
      head.add(blob(0.012, 0.04, 0.025, s * 0.275, 0.12, 0.395, pupilMat));
      head.add(blob(0.022, 0.022, 0.03, s * 0.07, 0.02, 1.0, clawMat)); // รูจมูก
    }
    // ฟันบน
    for (let i = 0; i < 7; i++) {
      for (const s of [-1, 1]) {
        const t = cone(0.025, 0.1 + (i % 2) * 0.03, toothMat);
        t.rotation.x = Math.PI;
        t.position.set(s * (0.12 - i * 0.004), -0.18, 0.42 + i * 0.075);
        head.add(t);
      }
    }
    // ขากรรไกรล่าง (หมุนได้)
    this.jaw = group(0, -0.15, 0.1);
    this.jaw.add(
      blob(0.17, 0.075, 0.42, 0, -0.04, 0.3),
      blob(0.12, 0.025, 0.34, 0, 0.01, 0.3, mouthMat),
      blob(0.07, 0.03, 0.22, 0, 0.03, 0.26, tongueMat),
    );
    for (let i = 0; i < 6; i++) {
      for (const s of [-1, 1]) {
        const t = cone(0.022, 0.08, toothMat);
        t.position.set(s * 0.12, 0.02, 0.3 + i * 0.07);
        this.jaw.add(t);
      }
    }
    head.add(this.jaw);

    /* ── หาง 6 ปล้อง ── */
    this.tailRoot = group(0, 0.15, -0.75);
    this.hips.add(this.tailRoot);
    this.tail = [];
    const N = 6, segLen = 0.46;
    const rad = (i) => 0.4 * Math.pow(1 - i / N, 1.15) + 0.03;
    let parent = this.tailRoot;
    for (let i = 0; i < N; i++) {
      const seg = group(0, 0, i === 0 ? 0 : -segLen);
      seg.add(tube(rad(i), rad(i + 1), segLen, 'back'));
      parent.add(seg);
      this.tail.push(seg);
      parent = seg;
    }

    /* ── ขาหลัง 2 ข้าง ── */
    this.legs = [];
    for (const s of [1, -1]) {
      const hip = group(s * 0.5, -0.05, 0);
      hip.add(blob(0.3, 0.32, 0.34), tube(0.3, 0.17, this.L1, 'down'));
      const knee = group(0, -this.L1, 0);
      knee.add(blob(0.18, 0.18, 0.18), tube(0.17, 0.1, this.L2, 'down'));
      const ankle = group(0, -this.L2, 0);
      ankle.add(blob(0.1, 0.1, 0.1));
      const foot = group();
      foot.add(blob(0.13, 0.07, 0.26, 0, -0.03, 0.1));
      for (const a of [-0.38, 0, 0.38]) {
        const toe = group(a * 0.28, -0.045, 0.22);
        toe.rotation.y = a;
        const c = cone(0.055, 0.28, skin);
        c.rotation.x = Math.PI / 2;
        const claw = cone(0.03, 0.11, clawMat);
        claw.rotation.x = Math.PI / 2; claw.position.z = 0.27;
        toe.add(c, claw);
        foot.add(toe);
      }
      ankle.add(foot);
      knee.add(ankle);
      hip.add(knee);
      this.hips.add(hip);
      this.legs.push({ side: s, hip, knee, ankle });
    }

    /* ── แขนเล็ก ── */
    this.arms = [];
    for (const s of [1, -1]) {
      const sh = group(s * 0.42, 0.05, 1.02);
      sh.add(blob(0.12, 0.12, 0.12), tube(0.1, 0.07, 0.28, 'down'));
      const el = group(0, -0.28, 0);
      el.add(blob(0.07, 0.07, 0.07), tube(0.07, 0.05, 0.22, 'down'));
      for (const a of [-0.12, 0.12]) {
        const c = cone(0.022, 0.12, clawMat);
        c.rotation.x = Math.PI; c.position.set(a * 0.3, -0.22, 0.0);
        c.rotation.z = a * 1.2;
        el.add(c);
      }
      sh.add(el);
      this.torso.add(sh);
      this.arms.push({ side: s, sh, el });
    }
  }

  pose(dt, { p, amp }) {
    const t = this.t, w = this.w, ph = this.phase;
    const idleK = 1 - clamp(w.walk + w.busy, 0, 1) * 0.75;

    // ── envelope ของ roar / attack ──
    let rWind = 0, rOpen = 0, aP = 0, aS = 0, aJaw = 0, aBite = 0;
    if (this.action === 'roar') {
      rWind = smooth(0, 0.17, p) * (1 - smooth(0.17, 0.27, p));
      rOpen = smooth(0.17, 0.27, p) * (1 - smooth(0.86, 1, p));
    } else if (this.action === 'attack') {
      aP = smooth(0, 0.34, p) * (1 - smooth(0.34, 0.46, p));
      aS = smooth(0.34, 0.46, p) * (1 - smooth(0.62, 1.0, p));
      aJaw = smooth(0.3, 0.44, p) * (1 - smooth(0.5, 0.58, p));
      aBite = smooth(0.52, 0.6, p) * (1 - smooth(0.6, 0.82, p));
    }

    // ── ขา: คำนวณมุม แล้วปรับความสูงสะโพกให้เท้าแตะพื้นพอดี ──
    let maxDrop = 0;
    const legPose = this.legs.map((leg) => {
      const lp = ph + (leg.side > 0 ? 0 : Math.PI);
      const s = Math.sin(lp), c = Math.cos(lp);
      let thigh = -0.3 - 0.5 * amp * s - 0.12 * rOpen - 0.2 * aS + 0.1 * aP;
      let knee = 0.55 + 0.85 * amp * Math.max(0, c) - 0.2 * amp * Math.max(0, -c)
        + 0.1 * rWind + 0.25 * aS + 0.15 * aP;
      const ankle = -(thigh + knee) + 0.15 * amp * s;
      const drop = this.L1 * Math.cos(thigh) + this.L2 * Math.cos(thigh + knee);
      maxDrop = Math.max(maxDrop, drop);
      return { leg, thigh, knee, ankle, s };
    });
    const targetHip = maxDrop + this.FOOT;
    this.hipY = damp(this.hipY, targetHip, 25, dt);
    this.hips.position.y = this.hipY;
    for (const lp of legPose) {
      lp.leg.hip.rotation.x = lp.thigh;
      lp.leg.knee.rotation.x = lp.knee;
      lp.leg.ankle.rotation.x = lp.ankle;
    }

    // ── ลำตัว ──
    const breath = Math.sin(t * 1.7);
    const shake = Math.sin(t * 55) * rOpen;
    this.torso.scale.set(
      1 + 0.012 * breath * idleK + 0.05 * rWind + 0.025 * rOpen,
      1 + 0.018 * breath * idleK + 0.05 * rWind,
      1 + 0.012 * breath * idleK + 0.06 * rWind,
    );
    this.hips.rotation.x = -0.12 * rOpen - 0.07 * aP + 0.3 * aS + 0.03 * rWind;
    this.hips.rotation.z = 0.05 * amp * Math.sin(ph) - this.turnDir * 0.06 * w.turn + 0.012 * shake;
    this.hips.rotation.y = 0.07 * amp * Math.cos(ph);
    this.hips.position.x = 0.012 * shake;
    this.rig.position.z = -0.15 * aP + 0.9 * aS;

    // ── คอ/หัว ──
    const look = (0.35 * Math.sin(t * 0.43) + 0.15 * Math.sin(t * 1.1)) * idleK;
    const lead = this.turnDir * 0.5 * w.turn;
    const bob2 = Math.sin(2 * ph);
    this.neck1.rotation.set(
      -0.9 + 0.02 * breath + 0.05 * amp * bob2 + 0.2 * rWind - 0.25 * rOpen - 0.35 * aP + 0.7 * aS,
      0.3 * look + 0.5 * lead, 0);
    this.neck2.rotation.set(
      0.45 - 0.06 * amp * bob2 - 0.12 * rOpen - 0.2 * aP - 0.3 * aS,
      0.4 * look + 0.5 * lead, 0);
    this.head.rotation.set(
      0.5 + 0.04 * Math.sin(t * 0.8) * idleK - 0.07 * amp * Math.cos(2 * ph) + 0.12 * rWind
        - 0.55 * rOpen - 0.25 * aP + 0.35 * aS,
      0.5 * look + 0.3 * lead,
      0.04 * shake * 1.0 + 0.08 * Math.sin(t * 35) * aBite);
    const jaw = 0.04 + 0.03 * Math.sin(t * 1.7) * idleK
      + 0.95 * rOpen + 0.03 * Math.sin(t * 38) * rOpen
      + Math.min(1, 0.5 * aP + 0.95 * aJaw);
    this.jaw.rotation.x = clamp(jaw, 0, 1.05);

    // ── หาง ──
    const n = this.tail.length;
    for (let i = 0; i < n; i++) {
      const f = 0.35 + i * 0.18;
      const yaw = (0.12 * Math.sin(t * 0.9 - i * 0.6) * idleK
        + 0.22 * amp * Math.sin(ph - 0.5 * i + 1.2)
        + this.turnDir * 0.25 * w.turn
        + 0.5 * aBite * Math.sin(t * 20 - i)
        + 0.35 * aS * Math.sin(i * 0.9)) * f;
      const pitch = (i === 0 ? 0.02 : -0.03) + 0.03 * Math.sin(t * 1.3 - i * 0.5) * idleK * (i / n)
        + 0.04 * rOpen;
      this.tail[i].rotation.set(pitch, yaw, 0);
    }

    // ── แขน ──
    for (const a of this.arms) {
      const sg = a.side;
      const sw = Math.sin(ph + (sg > 0 ? Math.PI : 0));
      a.sh.rotation.set(
        -0.6 + 0.08 * Math.sin(t * 1.3 + sg) * idleK + 0.22 * amp * sw - 0.35 * rOpen - 0.7 * aS + 0.2 * aP,
        0, -0.35 * sg - 0.3 * sg * rOpen);
      a.el.rotation.set(-0.9 + 0.12 * Math.sin(t * 1.9 + sg * 2) * idleK - 0.3 * rOpen - 0.3 * aS, 0, 0);
    }
  }
}

/* ───────────────────────── GLBDino (ตัวเลือก) ───────────────────────── */
const CLIP_PATTERNS = {
  idle: /idle|stand|breath/i,
  walk: /walk|run|move/i,
  roar: /roar|scream|howl/i,
  turn: /turn|rotate/i,
  attack: /attack|bite|strike/i,
};

export class GLBDino extends DinoBase {
  constructor(gltf) {
    super();
    this.kind = 'glb';
    this.model = gltf.scene;
    this.rig.add(this.model);

    // ปรับขนาดให้ยาวประมาณ 4.5 หน่วย และวางบนพื้น
    const box = new THREE.Box3().setFromObject(this.model);
    const size = box.getSize(new THREE.Vector3());
    const k = 4.5 / Math.max(size.x, size.z, 0.0001);
    this.model.scale.setScalar(k);
    box.setFromObject(this.model);
    this.model.position.y -= box.min.y;
    this.model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

    this.mixer = new THREE.AnimationMixer(this.model);
    this.clips = {};
    for (const clip of gltf.animations || []) {
      for (const [key, re] of Object.entries(CLIP_PATTERNS)) {
        if (!this.clips[key] && re.test(clip.name)) this.clips[key] = this.mixer.clipAction(clip);
      }
    }
    if (!this.clips.idle && gltf.animations?.length) this.clips.idle = this.mixer.clipAction(gltf.animations[0]);
    this.current = null;
    this._play('idle');
  }

  _play(name) {
    const next = this.clips[name] || this.clips.idle;
    if (!next || next === this.current) return;
    next.reset().setEffectiveWeight(1).fadeIn(0.25).play();
    if (name === 'roar' || name === 'attack') {
      next.setLoop(THREE.LoopOnce, 1); next.clampWhenFinished = true;
    } else next.setLoop(THREE.LoopRepeat, Infinity);
    if (this.current) this.current.fadeOut(0.25);
    this.current = next;
  }

  pose(dt, { amp }) {
    let want = 'idle';
    if (this.action) want = this.action;
    else if (this.state === 'walk') want = 'walk';
    else if (this.turning) want = this.clips.turn ? 'turn' : (this.clips.walk ? 'walk' : 'idle');
    this._play(want);
    this.mixer.update(dt);
  }
}

/** ลองโหลด GLB ก่อน ถ้าไม่มีไฟล์/โหลดไม่ได้ ใช้โมเดล 3D ที่สร้างด้วยโค้ดแทน */
export async function loadDino(glbUrl = 'models/dino.glb') {
  try {
    const head = await fetch(glbUrl, { method: 'HEAD' });
    if (head.ok) {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const gltf = await new GLTFLoader().loadAsync(glbUrl);
      return new GLBDino(gltf);
    }
  } catch (err) {
    console.warn('[dino] โหลด GLB ไม่ได้ ใช้โมเดลที่สร้างด้วยโค้ดแทน:', err);
  }
  return new ProceduralDino();
}

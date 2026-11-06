/**
 * audio.js — เสียงไดโนเสาร์สังเคราะห์ด้วย Web Audio API (ไม่ต้องมีไฟล์เสียง)
 * ต้องเรียก unlock() จากการแตะของผู้ใช้ก่อน (นโยบายของเบราว์เซอร์มือถือ)
 */
export class AudioFX {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    this.muted = false;
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;

      // รีเวิร์บเบาๆ ให้เสียงก้อง
      const conv = this.ctx.createConvolver();
      const len = this.ctx.sampleRate * 1.6;
      const ir = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
      }
      conv.buffer = ir;
      const wet = this.ctx.createGain(); wet.gain.value = 0.28;
      this.master.connect(this.ctx.destination);
      this.master.connect(conv); conv.connect(wet); wet.connect(this.ctx.destination);

      // นอยส์ 2 วินาที
      this.noiseBuf = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
      const nd = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  _distortion(amount = 40) {
    const ws = this.ctx.createWaveShaper();
    const n = 1024, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
    }
    ws.curve = curve; ws.oversample = '2x';
    return ws;
  }

  _noise(t0, dur, freq, q, vol) {
    const c = this.ctx;
    const src = c.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.08);
    g.gain.setValueAtTime(vol, t0 + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + dur);
    src.connect(bp); bp.connect(g); g.connect(this.master);
    src.start(t0); src.stop(t0 + dur + 0.05);
  }

  /** เสียงคำรามยาว ~2.7 วินาที */
  roar(scale = 1) {
    if (!this.ctx || this.muted) return;
    const c = this.ctx, t0 = c.currentTime + 0.02, dur = 2.7;
    const vol = 0.55;

    const amp = c.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(vol, t0 + 0.18);
    amp.gain.setValueAtTime(vol, t0 + 1.5);
    amp.gain.exponentialRampToValueAtTime(0.0005, t0 + dur);

    // สั่นแอมพลิจูด (growl ~ 26Hz)
    const am = c.createGain(); am.gain.value = 0.65;
    const lfo = c.createOscillator(); lfo.frequency.value = 26;
    const lfoDepth = c.createGain(); lfoDepth.gain.value = 0.35;
    lfo.connect(lfoDepth); lfoDepth.connect(am.gain);

    const dist = this._distortion(55);
    const low = c.createBiquadFilter(); low.type = 'lowpass';
    low.frequency.setValueAtTime(500, t0);
    low.frequency.linearRampToValueAtTime(2400, t0 + 0.6);
    low.frequency.linearRampToValueAtTime(900, t0 + dur);

    // formant ให้เสียงเหมือนลำคอ
    const f1 = c.createBiquadFilter(); f1.type = 'peaking'; f1.frequency.value = 600; f1.Q.value = 2; f1.gain.value = 9;
    const f2 = c.createBiquadFilter(); f2.type = 'peaking'; f2.frequency.value = 1300; f2.Q.value = 3; f2.gain.value = 6;

    const pitch = (base) => (o) => {
      o.frequency.setValueAtTime(base * 0.8, t0);
      o.frequency.exponentialRampToValueAtTime(base * 1.7, t0 + 0.55);
      o.frequency.exponentialRampToValueAtTime(base * 1.25, t0 + 1.6);
      o.frequency.exponentialRampToValueAtTime(base * 0.6, t0 + dur);
    };
    const oscs = [['sawtooth', 62], ['sawtooth', 63.5], ['square', 31]].map(([type, f]) => {
      const o = c.createOscillator(); o.type = type; pitch(f / Math.sqrt(scale))(o);
      const g = c.createGain(); g.gain.value = type === 'square' ? 0.35 : 0.5;
      o.connect(g); g.connect(am); o.start(t0); o.stop(t0 + dur + 0.1);
      return o;
    });
    lfo.start(t0); lfo.stop(t0 + dur + 0.1);

    am.connect(dist); dist.connect(low); low.connect(f1); f1.connect(f2); f2.connect(amp); amp.connect(this.master);

    this._noise(t0, dur * 0.9, 900, 0.7, 0.22);
    this._noise(t0 + 0.05, dur * 0.7, 2600, 1.2, 0.07);
    return oscs;
  }

  /** เสียงขู่/งับ สำหรับท่าโจมตี ~1.1 วินาที */
  attack(scale = 1) {
    if (!this.ctx || this.muted) return;
    const c = this.ctx, t0 = c.currentTime + 0.02;
    const amp = c.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(0.5, t0 + 0.08);
    amp.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.9);
    const dist = this._distortion(70);
    const low = c.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 1800;
    const o = c.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(140 / Math.sqrt(scale), t0);
    o.frequency.exponentialRampToValueAtTime(70 / Math.sqrt(scale), t0 + 0.9);
    const o2 = c.createOscillator(); o2.type = 'square';
    o2.frequency.setValueAtTime(70, t0); o2.frequency.exponentialRampToValueAtTime(45, t0 + 0.9);
    const lfo = c.createOscillator(); lfo.frequency.value = 40;
    const am = c.createGain(); am.gain.value = 0.7;
    const ld = c.createGain(); ld.gain.value = 0.3;
    lfo.connect(ld); ld.connect(am.gain);
    o.connect(am); o2.connect(am);
    am.connect(dist); dist.connect(low); low.connect(amp); amp.connect(this.master);
    [o, o2, lfo].forEach((n) => { n.start(t0); n.stop(t0 + 1); });
    this._noise(t0, 0.6, 1800, 0.8, 0.3);

    // เสียงงับ (snap) ที่ ~0.35 วินาที
    const ts = t0 + 0.35;
    this._noise(ts, 0.12, 3200, 2, 0.5);
    const th = c.createOscillator(); th.type = 'sine';
    const tg = c.createGain();
    th.frequency.setValueAtTime(120, ts); th.frequency.exponentialRampToValueAtTime(40, ts + 0.15);
    tg.gain.setValueAtTime(0.6, ts); tg.gain.exponentialRampToValueAtTime(0.001, ts + 0.18);
    th.connect(tg); tg.connect(this.master); th.start(ts); th.stop(ts + 0.2);
  }

  /** เสียงฝีเท้าหนักๆ */
  step(strength = 1, scale = 1) {
    if (!this.ctx || this.muted) return;
    const c = this.ctx, t0 = c.currentTime;
    const o = c.createOscillator(); o.type = 'sine';
    const g = c.createGain();
    const v = 0.35 * Math.min(1, strength);
    o.frequency.setValueAtTime(75 / Math.sqrt(Math.max(scale, 0.3)), t0);
    o.frequency.exponentialRampToValueAtTime(32, t0 + 0.2);
    g.gain.setValueAtTime(v, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22);
    o.connect(g); g.connect(this.master); o.start(t0); o.stop(t0 + 0.25);
    this._noise(t0, 0.09, 300, 0.8, v * 0.5);
  }

  /** เสียงเบาๆ ตอนวาง */
  ping() {
    if (!this.ctx || this.muted) return;
    const c = this.ctx, t0 = c.currentTime;
    const o = c.createOscillator(); o.type = 'triangle';
    const g = c.createGain();
    o.frequency.setValueAtTime(520, t0); o.frequency.exponentialRampToValueAtTime(880, t0 + 0.12);
    g.gain.setValueAtTime(0.18, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.25);
    o.connect(g); g.connect(this.master); o.start(t0); o.stop(t0 + 0.3);
  }
}

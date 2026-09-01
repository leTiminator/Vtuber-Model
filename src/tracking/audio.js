/**
 * Optional microphone level meter, used to drive the mouth when the camera
 * cannot see it well (a hand in front of your face, a mask, low light) or when
 * you simply prefer audio-driven lip flap.
 *
 * Only a loudness value ever leaves this module — no audio is recorded, stored
 * or sent anywhere.
 */
export class MicLevel {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.stream = null;
    this.buffer = null;
    this.level = 0;
    this.active = false;
  }

  async start() {
    if (this.active) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      video: false,
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    const source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.35;
    source.connect(this.analyser);
    this.buffer = new Float32Array(this.analyser.fftSize);
    this.active = true;
  }

  async stop() {
    this.active = false;
    this.level = 0;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.ctx) {
      await this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.analyser = null;
  }

  /** Root-mean-square loudness of the latest audio window, 0..~1. */
  sample() {
    if (!this.active || !this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    for (let i = 0; i < this.buffer.length; i++) sum += this.buffer[i] * this.buffer[i];
    const rms = Math.sqrt(sum / this.buffer.length);
    // Asymmetric smoothing: open fast on a syllable, close a little slower.
    this.level = rms > this.level ? rms : this.level * 0.82 + rms * 0.18;
    return this.level;
  }
}

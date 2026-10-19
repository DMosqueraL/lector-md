// Lectura en voz alta con la Web Speech API.
// Se lee bloque a bloque y cada bloque en trozos cortos: Chrome corta utterances largas.
import { blockText } from './render.js';

const synth = window.speechSynthesis;
export const ttsSupported = !!synth && typeof SpeechSynthesisUtterance !== 'undefined';

const PREFERRED = ['es-CO', 'es-419', 'es-US', 'es-MX', 'es-ES'];

export function getVoices() {
  return new Promise(resolve => {
    if (!ttsSupported) return resolve([]);
    const v = synth.getVoices();
    if (v.length) return resolve(v);
    const done = () => resolve(synth.getVoices());
    synth.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1500);
  });
}

export function sortVoices(voices) {
  const rank = v => {
    const i = PREFERRED.findIndex(p => v.lang.replace('_', '-').startsWith(p));
    if (i >= 0) return i;
    if (v.lang.startsWith('es')) return 10;
    if (v.lang.startsWith('en')) return 20;
    return 30;
  };
  return [...voices].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function chunk(text, max = 220) {
  const parts = text.match(/[^.!?;:\n]+[.!?;:\n]*|\S+/g) || [text];
  const out = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > max && cur) { out.push(cur.trim()); cur = ''; }
    if (p.length > max) {
      for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max));
    } else cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export class Reader {
  constructor({ onChange }) {
    this.blocks = [];
    this.index = 0;
    this.playing = false;
    this.rate = 1;
    this.voice = null;
    this.onChange = onChange;
    this._token = 0;
    this._wakeLock = null;
    this.keepAwake = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.playing) this._lockScreen();
    });
  }

  load(blocks, startIndex = 0) {
    this.stop();
    this.blocks = blocks;
    this.index = Math.min(Math.max(0, startIndex), Math.max(0, blocks.length - 1));
    this._mark();
  }

  play(from = this.index) {
    if (!ttsSupported || !this.blocks.length) return;
    this.index = from;
    this.playing = true;
    this._lockScreen();
    this._speakBlock();
  }

  pause() {
    this.playing = false;
    this._token++;
    synth.cancel();
    this._releaseScreen();
    this._emit();
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  stop() {
    this.pause();
    this.blocks.forEach(b => b.classList.remove('speaking'));
  }

  seek(i) {
    const wasPlaying = this.playing;
    this._token++;
    synth.cancel();
    this.index = Math.min(Math.max(0, i), this.blocks.length - 1);
    if (wasPlaying) this.play(this.index); else { this._mark(); this._emit(); }
  }

  next() { this.seek(this.index + 1); }
  prev() { this.seek(this.index - 1); }

  setRate(r) {
    this.rate = r;
    if (this.playing) this.seek(this.index);
  }

  setVoice(v) {
    this.voice = v;
    if (this.playing) this.seek(this.index);
  }

  _speakBlock() {
    const token = ++this._token;
    const el = this.blocks[this.index];
    if (!el) { this.playing = false; this._releaseScreen(); this._emit(); return; }
    this._mark();
    this._emit();
    const pieces = chunk(blockText(el));
    let k = 0;
    const speakNext = () => {
      if (token !== this._token) return;
      if (k >= pieces.length) {
        if (this.index < this.blocks.length - 1) { this.index++; this._speakBlock(); }
        else { this.playing = false; this._releaseScreen(); this._emit(); }
        return;
      }
      const u = new SpeechSynthesisUtterance(pieces[k++]);
      u.rate = this.rate;
      if (this.voice) { u.voice = this.voice; u.lang = this.voice.lang; } else u.lang = this.lang || 'es-419';
      u.onend = speakNext;
      u.onerror = e => {
        if (token !== this._token) return;
        if (e.error === 'interrupted' || e.error === 'canceled') return;
        // Fallo del motor de voz: se detiene en vez de saltar el resto del documento
        this.playing = false;
        this._token++;
        this._releaseScreen();
        this._emit();
        this.onError?.(e.error);
      };
      synth.speak(u);
    };
    // Algunos motores necesitan un respiro tras cancel()
    synth.cancel();
    setTimeout(speakNext, 60);
  }

  _mark() {
    this.blocks.forEach((b, i) => b.classList.toggle('speaking', i === this.index && (this.playing || i === this.index)));
    const el = this.blocks[this.index];
    if (el && this.playing) {
      const r = el.getBoundingClientRect();
      const margin = 90;
      if (r.top < margin || r.bottom > window.innerHeight - 170) {
        el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      }
    }
  }

  _emit() { this.onChange?.(this); }

  async _lockScreen() {
    if (!this.keepAwake || !('wakeLock' in navigator) || this._wakeLock) return;
    try {
      this._wakeLock = await navigator.wakeLock.request('screen');
      this._wakeLock.addEventListener('release', () => { this._wakeLock = null; });
    } catch { /* sin permiso o no soportado */ }
  }

  _releaseScreen() {
    this._wakeLock?.release().catch(() => {});
    this._wakeLock = null;
  }
}

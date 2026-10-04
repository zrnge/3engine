import { escapeHtml } from '../editor.js';
import { soundCardsHtml, wireSoundCards } from '../audio-panel.js';
import { SPACES } from '../reverb.js';

/**
 * The Audio panel's scene-wide part: mute (this editor's own), the mix, the room it sounds
 * like, the scene's music and ambience, and a test tone.
 *
 * Moved out of game.js as it was; it reaches the rest of the editor through `app`
 * (game.js): the engine, editor and history — and what other parts offer (app.markDirty…).
 */
export function wireAudioMixer(app) {
  const { engine, editor, history, rig, assets, player, input, scene, viewport } = app;

  let _testOsc = null;
  let _testGain = null;

  // mute toggle (defensive: the controls panel may be absent in a cached/old HTML)
  const muteCheck = document.getElementById('aud-mute');
  const volumeEl = document.getElementById('aud-volume');
  const volumeReadout = document.getElementById('aud-volume-v');
  // The mix (master + music / effects / ambience) is part of the scene and ships
  // in exports. Mute is only this editor's preference.
  const MIX_SLIDERS = { master: 'aud-volume', music: 'aud-music', effects: 'aud-effects', ambience: 'aud-ambience' };

  function refreshMute() {
    engine.audio.setMuted(muteCheck?.checked ?? false);
    const volume = volumeEl ? Number(volumeEl.value) : 1;
    if (volumeReadout) volumeReadout.textContent = `${Math.round(volume * 100)}%`;
    engine.audio.setMix({ master: volume });
  }
  if (muteCheck) muteCheck.addEventListener('change', refreshMute);
  volumeEl?.addEventListener('input', refreshMute);

  for (const [bus, id] of Object.entries(MIX_SLIDERS)) {
    if (bus === 'master') continue;
    const el = document.getElementById(id);
    el?.addEventListener('input', () => {
      engine.audio.setMix({ [bus]: Number(el.value) });
      document.getElementById(`${id}-v`).textContent = `${Math.round(Number(el.value) * 100)}%`;
    });
  }

  // the room the game sounds like (reverb.js) — part of the scene, like the mix
  const spaceSel = document.getElementById('aud-space');
  const spaceAmountEl = document.getElementById('aud-space-amount');
  if (spaceSel) {
    spaceSel.innerHTML = Object.entries(SPACES)
      .map(([name, s]) => `<option value="${name}">${escapeHtml(s.label)}</option>`).join('');
    spaceSel.addEventListener('change', () => {
      engine.audio.setMix({ space: spaceSel.value });
      app.markDirty();
    });
  }
  spaceAmountEl?.addEventListener('input', () => {
    engine.audio.setMix({ spaceAmount: Number(spaceAmountEl.value) });
    document.getElementById('aud-space-amount-v').textContent = `${Math.round(Number(spaceAmountEl.value) * 100)}%`;
  });

  /** Show the scene's mix in the sliders — after a load or a new scene. */
  function syncMixUI() {
    for (const [bus, id] of Object.entries(MIX_SLIDERS)) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.value = engine.audio.mix[bus];
      const readout = document.getElementById(`${id}-v`);
      if (readout) readout.textContent = `${Math.round(engine.audio.mix[bus] * 100)}%`;
    }
    if (spaceSel) spaceSel.value = engine.audio.mix.space;
    if (spaceAmountEl) {
      spaceAmountEl.value = engine.audio.mix.spaceAmount;
      document.getElementById('aud-space-amount-v').textContent = `${Math.round(engine.audio.mix.spaceAmount * 100)}%`;
    }
  }

  // ---- scene music & ambience: sounds that belong to no object ----
  const sceneAudioEl = document.getElementById('scene-audio');
  function renderSceneAudio() {
    if (!sceneAudioEl) return;
    sceneAudioEl.innerHTML = soundCardsHtml(engine, null, 'scn-aud');
    wireSoundCards({
      engine, history, root: sceneAudioEl, entity: null, prefix: 'scn-aud',
      rerender: renderSceneAudio, onChange: () => app.markDirty(),
    });
  }
  syncMixUI();
  renderSceneAudio();

  // test tone buttons
  const testBtn = document.getElementById('aud-test');
  const stopTestBtn = document.getElementById('aud-stop-test');
  function stopTestTone() {
    if (_testOsc) { _testOsc.stop(); _testOsc.disconnect(); _testOsc = null; }
    if (_testGain) { _testGain.disconnect(); _testGain = null; }
    if (testBtn) testBtn.disabled = false;
    if (stopTestBtn) stopTestBtn.disabled = true;
  }
  function startTestTone() {
    engine.unlockAudio();
    const ctx = engine.listener.context;
    if (!ctx) return;
    if (muteCheck?.checked) return;
    _testGain = ctx.createGain();
    _testGain.gain.value = 0.15;
    _testGain.connect(engine.listener.getInput()); // through master volume and mute
    _testOsc = ctx.createOscillator();
    _testOsc.type = 'sawtooth';
    _testOsc.frequency.value = 220;
    _testOsc.connect(_testGain);
    _testOsc.start();
    // quick "pew" envelope: ramp frequency down
    _testOsc.frequency.setValueAtTime(880, ctx.currentTime);
    _testOsc.frequency.exponentialRampToValueAtTime(110, ctx.currentTime + 0.25);
    _testGain.gain.setValueAtTime(0.15, ctx.currentTime);
    _testGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    _testOsc.stop(ctx.currentTime + 0.28);
    _testOsc.onended = stopTestTone;
    if (testBtn) testBtn.disabled = true;
    if (stopTestBtn) stopTestBtn.disabled = false;
  }
  if (testBtn) testBtn.addEventListener('click', startTestTone);
  if (stopTestBtn) stopTestBtn.addEventListener('click', stopTestTone);

  Object.assign(app, { syncMixUI, renderSceneAudio, refreshMute });
}

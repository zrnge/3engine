import { soundCardsHtml, wireSoundCards } from '../audio-panel.js';

/**
 * The selected object's sounds. The cards themselves are in ../audio-panel.js.
 *
 * Mixed into ObjectEditor.prototype (see ../editor.js), so `this` is the editor.
 */
export const audioSectionMethods = {
  _audioSection(entity) {
    return `<h4 class="insp-h">Sounds on this object</h4>${soundCardsHtml(this.engine, entity, 'insp-aud')}`;
  },

  _wireAudioSection(entity) {
    wireSoundCards({
      engine: this.engine,
      history: this.history,
      root: this.audioEl,
      entity,
      prefix: 'insp-aud',
      rerender: () => this._renderAudio(this.selected),
    });
  },

  _clearSound(entity) {
    this.engine.clearEntitySounds(entity);
  },
};

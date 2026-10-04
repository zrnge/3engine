import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';

/**
 * Effects — what the picture goes through after it's drawn, in this order:
 *
 *   ambient occlusion  corners, creases and where things meet the ground darken
 *   bloom              what is brighter than the threshold glows into the air
 *   depth of field     what is nearer or farther than the focus blurs
 *   (held objects)     a first-person gun, sharp, drawn into the same picture
 *   tone mapping       the HDR picture onto the screen's range (as without effects)
 *   colour             contrast, saturation, warmth, a vignette, film grain
 *
 * All off, the scene is drawn straight to the screen as before. Any on, it is
 * drawn into an HDR picture (multisampled, so edges stay smooth) and through
 * the passes that are on. The settings are the level's (Environment; see
 * environment.js normalizeSettings).
 */

/** The colour stage: on the tone-mapped picture, as a grade is. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    contrast: { value: 0 },
    saturation: { value: 0 },
    warmth: { value: 0 },
    vignette: { value: 0 },
    grain: { value: 0 },
    time: { value: 0 },
    resolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float contrast, saturation, warmth, vignette, grain, time;
    uniform vec2 resolution;
    varying vec2 vUv;
    void main() {
      vec4 tex = texture2D(tDiffuse, vUv);
      vec3 c = tex.rgb;
      // warmth: towards amber, or towards blue
      c *= vec3(1.0 + warmth * 0.12, 1.0 + warmth * 0.02, 1.0 - warmth * 0.12);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, 1.0 + saturation);
      c = (c - 0.5) * (1.0 + contrast) + 0.5;
      // the corners darker, as through a lens (wider screens: by their shape)
      vec2 d = (vUv - 0.5) * vec2(resolution.x / resolution.y, 1.0);
      c *= 1.0 - vignette * smoothstep(0.35, 1.05, length(d) * 1.25);
      // grain that moves, as film's does
      float n = fract(sin(dot(vUv * resolution + fract(time * 13.7) * 91.0, vec2(12.9898, 78.233))) * 43758.5453);
      c += (n - 0.5) * grain * 0.14;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), tex.a);
    }`,
};

/** Held objects (view-model.js) drawn into the picture so far, over its depth cleared. */
class HeldPass extends Pass {
  constructor() {
    super();
    this.needsSwap = false; // drawn on top of what is there
    this.draw = null;
  }

  render(renderer, writeBuffer, readBuffer) {
    if (!this.draw) return;
    renderer.setRenderTarget(readBuffer);
    this.draw();
    this.draw = null;
  }
}

/** What each focus choice means for depth of field. */
export const DOF_FOCUS = ['the player', 'the middle of the view', 'a distance'];

const GRADE_KEYS = ['contrast', 'saturation', 'warmth', 'vignette', 'grain'];

export class Effects {
  constructor(engine) {
    this.engine = engine;
    this.settings = {
      bloom: false, bloomStrength: 0.6, bloomThreshold: 0.85, bloomRadius: 0.4,
      ao: false, aoStrength: 0.8, aoRadius: 0.6,
      dof: false, dofFocus: 'the player', dofDistance: 8, dofBlur: 0.4,
      contrast: 0, saturation: 0, warmth: 0, vignette: 0, grain: 0,
    };
    this._composer = null;
    this._passes = null;
    this._focus = null; // depth of field: the distance focused on now (it eases there)
  }

  /** Take the level's settings (see environment.js normalizeSettings). */
  apply(settings = {}) {
    const before = this._layout();
    this.settings = { ...this.settings, ...settings };
    if (this._layout() !== before) this._arrange();
    this._tune();
  }

  /** Is the colour stage doing anything? */
  get grading() { return GRADE_KEYS.some((k) => Math.abs(Number(this.settings[k]) || 0) > 1e-4); }

  /** Is anything to be done to the picture? */
  get active() {
    const s = this.settings;
    return (!!s.bloom || !!s.ao || !!s.dof || this.grading) && !!this.engine.renderer?.getContext;
  }

  /** Which passes are on: a change rebuilds the chain. */
  _layout() {
    const s = this.settings;
    return [!!s.ao, !!s.bloom, !!s.dof, this.grading].join();
  }

  /**
   * Draw the scene — through the effects when they're on. `held` (optional)
   * draws a first-person view's held objects over it; with effects on, that
   * happens inside the chain, so they are tone-mapped and graded as the world
   * is, and the depth of field doesn't blur them.
   */
  render(scene, camera, held = null) {
    const renderer = this.engine.renderer;
    if (!this.active) {
      renderer.render(scene, camera);
      held?.();
      return;
    }
    const composer = this._ensure(renderer);
    const p = this._passes;
    p.render.scene = scene;
    p.render.camera = camera;
    if (p.ao) { p.ao.scene = scene; p.ao.camera = camera; }
    if (p.dof) {
      p.dof.scene = scene;
      p.dof.camera = camera;
      p.dof.uniforms.focus.value = this._focusDistance(camera);
    }
    if (p.grade) {
      p.grade.uniforms.time.value = this.engine.time ?? performance.now() / 1000;
    }
    p.held.draw = held;
    composer.render();
    p.held.draw = null;
  }

  /**
   * Depth of field: how far away is sharp. The player (follow / orbit play),
   * what the middle of the view rests on (first person), or a set distance.
   * It eases there, as a lens refocusing.
   */
  _focusDistance(camera) {
    const s = this.settings;
    let want = s.dofDistance;
    const engine = this.engine;
    if (s.dofFocus === 'the player' && engine.playerEntity?.object3D && engine.cameraRig?.mode !== 'fps') {
      want = camera.position.distanceTo(engine.playerEntity.object3D.getWorldPosition(_v));
    } else if (s.dofFocus !== 'a distance') {
      camera.getWorldDirection(_dir);
      const player = engine.playerEntity;
      const hit = engine.physics?.raycast?.(camera.position, _dir, 200, { skip: (e) => e === player || e.viewModel });
      want = hit ? hit.distance : 60;
    }
    want = Math.max(0.3, want);
    this._focus = this._focus === null ? want : this._focus + (want - this._focus) * 0.15;
    return this._focus;
  }

  /** The window changed size: so do the pictures the effects draw into. */
  setSize(width, height) {
    if (!this._composer) return;
    this._composer.setPixelRatio(this.engine.renderer.getPixelRatio());
    this._composer.setSize(width, height);
    this._passes.grade?.uniforms.resolution.value.set(width, height);
  }

  _ensure(renderer) {
    if (this._composer) return this._composer;
    const size = renderer.getSize(new THREE.Vector2());
    // HDR, so what's brighter than white stays brighter until it has bloomed;
    // multisampled, as the screen is, so edges don't turn jagged
    const target = new THREE.WebGLRenderTarget(size.x * renderer.getPixelRatio(), size.y * renderer.getPixelRatio(), {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    this._composer = new EffectComposer(renderer, target);
    this._composer.setPixelRatio(renderer.getPixelRatio());
    this._composer.setSize(size.x, size.y);
    this._size = size;
    this._arrange();
    return this._composer;
  }

  /** The chain for the passes that are on. */
  _arrange() {
    const composer = this._composer;
    if (!composer) return;
    const old = this._passes;
    for (const pass of [...composer.passes]) composer.removePass(pass);
    const s = this.settings;
    const { x: w, y: h } = this._size;
    const scene = this.engine.scene;
    const camera = this.engine.camera;
    const p = {
      render: old?.render ?? new RenderPass(scene, camera),
      ao: s.ao ? (old?.ao ?? new GTAOPass(scene, camera, w, h)) : null,
      bloom: s.bloom ? (old?.bloom ?? new UnrealBloomPass(new THREE.Vector2(w, h), s.bloomStrength, s.bloomRadius, s.bloomThreshold)) : null,
      dof: s.dof ? (old?.dof ?? new BokehPass(scene, camera, { focus: s.dofDistance, aperture: 0.002, maxblur: 0.01 })) : null,
      held: old?.held ?? new HeldPass(),
      output: old?.output ?? new OutputPass(), // tone mapping and colour, as the screen would have had them
      grade: this.grading ? (old?.grade ?? new ShaderPass(GradeShader)) : null,
    };
    // passes turned off: their pictures go
    for (const k of ['ao', 'bloom', 'dof', 'grade']) if (old?.[k] && !p[k]) old[k].dispose?.();
    for (const k of ['render', 'ao', 'bloom', 'dof', 'held', 'output', 'grade']) if (p[k]) composer.addPass(p[k]);
    composer.setSize(w, h); // each pass at the size of the picture
    p.grade?.uniforms.resolution.value.set(w, h);
    this._passes = p;
    this._tune();
  }

  /** The settings into the passes that are on. */
  _tune() {
    const p = this._passes;
    if (!p) return;
    const s = this.settings;
    if (p.bloom) {
      p.bloom.strength = s.bloomStrength;
      p.bloom.threshold = s.bloomThreshold;
      p.bloom.radius = s.bloomRadius;
    }
    if (p.ao) {
      p.ao.blendIntensity = s.aoStrength;
      p.ao.updateGtaoMaterial({ radius: s.aoRadius, thickness: Math.max(0.5, s.aoRadius * 2), scale: 1, distanceExponent: 1, distanceFallOff: 1 });
    }
    if (p.dof) {
      const b = Math.max(0, Math.min(1, s.dofBlur));
      p.dof.uniforms.aperture.value = 0.0004 + b * 0.0046;
      p.dof.uniforms.maxblur.value = 0.003 + b * 0.017;
    }
    if (p.grade) for (const k of GRADE_KEYS) p.grade.uniforms[k].value = Number(s[k]) || 0;
  }

  dispose() {
    const p = this._passes;
    if (p) for (const k of ['ao', 'bloom', 'dof', 'output', 'grade']) p[k]?.dispose?.();
    this._composer?.dispose();
    this._composer = null;
    this._passes = null;
  }
}

const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();

/**
 * Tiny3 Exporter — package the current editor scene into a playable
 * HTML file.
 *
 * The exported page reuses the same vendored Three.js runtime modules and
 * engine source as the editor. It must be placed in the project root
 * (next to lib/, src/, assets/) or served from the same origin to work.
 */

export class GameExporter {
  constructor(serializer) {
    this.serializer = serializer;
  }

  /** Build and download tiny3-game.html from the current scene. */
  exportToFile(filename = 'tiny3-game.html') {
    const sceneJson = JSON.stringify(this.serializer.serialize(), null, 2);
    const html = this._buildHtml(sceneJson);
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (a.parentNode) a.parentNode.removeChild(a);
        URL.revokeObjectURL(url);
      });
    });
  }

  /** Build the standalone game HTML string. */
  _buildHtml(sceneJson) {
    const safeJson = sceneJson.replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Tiny3 Game</title>
  <style>
    html, body { margin: 0; padding: 0; overflow: hidden; background: #0b0e14; }
    canvas { display: block; }
    #hint {
      position: fixed; bottom: 12px; left: 12px; color: #8b949e;
      font-family: system-ui, sans-serif; font-size: 12px; pointer-events: none;
      background: rgba(13,17,23,0.8); padding: 6px 10px; border-radius: 6px;
      border: 1px solid #30363d;
    }
  </style>
  <script type="importmap">
    {
      "imports": {
        "three": "./lib/three.module.js",
        "three/addons/loaders/GLTFLoader.js": "./lib/GLTFLoader.js",
        "three/addons/controls/TransformControls.js": "./lib/TransformControls.js",
        "../utils/BufferGeometryUtils.js": "./lib/utils/BufferGeometryUtils.js"
      }
    }
  </script>
</head>
<body>
  <div id="hint">Click to focus · WASD move · Space jump · F fire · Esc releases pointer</div>
  <script type="application/json" id="scene-data">${safeJson}</script>
  <script type="module">
    import * as THREE from 'three';
    import { Engine } from './src/engine.js';
    import { CameraRig } from './src/cameras.js';
    import { AssetLoader } from './src/loader.js';
    import { SceneSerializer } from './src/scene.js';
    import { Player } from './src/player.js';
    import { Entity } from './src/entity.js';
    import { LightEntity } from './src/editor.js';
    import { Coin } from './src/enemy.js';
    import { RigidBody } from './src/physics.js';

    async function boot() {
      const engine = new Engine({ background: 0x0b0e14 });
      const rig = new CameraRig(engine.camera, engine.renderer.domElement);
      engine.cameraRig = rig;
      rig.enabled = true;

      // ensure at least some ambient light exists
      let hasAmbient = false;
      engine.scene.traverse((n) => { if (n.isAmbientLight) hasAmbient = true; });
      if (!hasAmbient) {
        engine.scene.add(new THREE.AmbientLight(0xffffff, 0.4));
      }

      const assets = new AssetLoader();

      // minimal editor stub used by SceneSerializer in game mode
      const editor = {
        selectables: [],
        selected: null,
        select(e) { this.selected = e; },
        register(e) { if (!this.selectables.includes(e)) this.selectables.push(e); },
        unregister(e) {
          const i = this.selectables.indexOf(e);
          if (i !== -1) this.selectables.splice(i, 1);
        },
        _renderHierarchy() {},
      };

      // player must exist before deserialization so the serializer can restore it
      const player = engine.add(new Player());
      player.enabled = true;

      const serializer = new SceneSerializer(engine, editor, rig, player, assets);
      const data = JSON.parse(document.getElementById('scene-data').textContent);
      await serializer.deserialize(data);

      // if the scene didn't include a ground, add a default one
      let ground = editor.selectables.find((e) => e.object3D.name === 'Ground');
      if (!ground) {
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(60, 1, 60),
          new THREE.MeshStandardMaterial({ color: 0x1a2233 })
        );
        mesh.position.y = -0.5;
        mesh.name = 'Ground';
        ground = new Entity(mesh);
        ground.rigidBody = new RigidBody({ type: 'static' });
        engine.add(ground);
        editor.register(ground);
      }

      // wire action sounds
      player.onFire = (p, eng) => eng.playEntitySounds(p.target || p, { trigger: 'fire' });
      player.onJump = (p, eng) => eng.playEntitySounds(p.target || p, { trigger: 'jump' });

      // unlock audio on first user gesture
      const unlock = () => engine.unlockAudio();
      window.addEventListener('pointerdown', unlock, { once: true });
      window.addEventListener('keydown', unlock, { once: true });

      // start autoplay sounds
      for (const rec of engine.sounds) {
        if (rec.autoplay && rec.type !== 'positional' && !rec.audio.isPlaying) {
          rec.audio.play();
        }
      }

      engine.onUpdate = (dt) => {
        if (rig.enabled !== false) rig.update(dt, engine.input);
        engine.input.endFrame();
      };

      window.__tiny3Game = { engine, player, rig };

      engine.start();
    }

    boot().catch((err) => {
      console.error('[Tiny3 Game] boot failed:', err);
      document.body.innerHTML = '<pre style="color:#f47067;padding:20px">' + (err.stack || err.message) + '</pre>';
    });
  </script>
</body>
</html>`;
  }
}

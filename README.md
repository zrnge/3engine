# Tiny3

A minimal game engine built on [Three.js](https://threejs.org) — game loop, input,
entities, camera rig, GLB asset loading and a built-in object editor — plus a
small playable sandbox. No build step, no dependencies to install: everything is
vendored in `lib/`, perfect for GitHub Pages.

## Run locally

```sh
python -m http.server 8000
# open http://localhost:8000
```

(Any static file server works — ES modules just can't load from `file://`.)

## Controls

| Input | Action |
|---|---|
| `WASD` / arrows | Move player |
| `Space` | Jump |
| `1` `2` `3` `4` | Camera: orbit · follow · FPS · free-fly |
| Mouse drag (orbit) / wheel | Orbit / zoom |
| Click object | Select it |
| Drag selected | Move it on the ground plane |
| `R` (+`Shift`) | Rotate selected ±15° |
| `[` `]` | Scale selected down / up |
| `Delete` | Remove selected |
| `L` | Load a `.glb` / `.gltf` model from disk into the scene |
| `P` / `Esc` | Pause / deselect & release pointer |

## Engine API

```js
import { Engine } from './src/engine.js';

const engine = new Engine();
engine.add(myEntity);          // { object3D, update(dt, engine) }
engine.onUpdate = (dt) => {};  // per-frame hook
engine.start();
```

- **`src/engine.js`** — renderer, scene, fixed-clamp game loop, entity registry
- **`src/input.js`** — keyboard, mouse buttons/position/NDC, wheel, pointer lock
- **`src/cameras.js`** — `CameraRig` with orbit / follow / FPS / free modes
- **`src/loader.js`** — `AssetLoader.load(url)` for GLB/GLTF models (with caching & cloning)
- **`src/editor.js`** — `ObjectEditor`: click-select, drag-move, rotate, scale, delete
- **`src/entity.js`** — `Entity` base class + `aabbCollides` helper
- **`src/player.js`**, **`src/enemy.js`** — sample game objects

## Deploy to GitHub Pages

1. Create a repo on GitHub, then push:
   ```sh
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
2. Repo **Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)`**.
3. Visit `https://<you>.github.io/<repo>/`. The `.nojekyll` file keeps Pages from
   processing the vendored Three.js files.

## Credits

`assets/duck.glb` is the Khronos Group sample Duck model (CC-BY 4.0).
Three.js r160 is vendored under `lib/` (MIT).

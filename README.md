# Tiny3 — a tiny Three.js game engine

A minimal, dependency-light game engine built on [Three.js](https://threejs.org), plus a demo game (**Cube Runner**) that shows how to use it. Pure static files — no build step — so it deploys to GitHub Pages as-is.

## Demo game: Cube Runner

- **Move:** WASD or arrow keys
- **Jump:** Space
- **Pause:** P
- Collect gold coins for points, dodge the red chasers. Three hits and the game resets.

## Engine API

```js
import { Engine } from './src/engine.js';
import { Player } from './src/player.js';

const engine = new Engine({ background: 0x0b0e14 });
engine.add(new Player());            // any entity with object3D + update(dt, engine)
engine.onUpdate = (dt, eng) => {};   // per-frame game logic
engine.start();
```

| Module | Purpose |
|---|---|
| `src/engine.js` | Renderer, scene, camera, fixed-clamped game loop, entity registry, pause (P), auto-resize |
| `src/input.js` | Keyboard state: `isDown(code)` (held) and `wasPressed(code)` (edge) |
| `src/entity.js` | `Entity` base class + `aabbCollides()` collision helper |
| `src/player.js` | Example player controller (move, jump, gravity) |
| `src/enemy.js` | Example entities: collectible `Coin`, homing `Enemy` |

## Run locally

Any static file server works (ES modules need `http://`, not `file://`):

```sh
python -m http.server 8000
# then open http://localhost:8000
```

## Deploy to GitHub Pages

1. Create a repo on GitHub, then push:
   ```sh
   git init
   git add .
   git commit -m "Tiny3 engine + Cube Runner demo"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
2. In the repo: **Settings → Pages → Source: Deploy from a branch**, pick `main` / `/ (root)`, save.
3. Your game appears at `https://<you>.github.io/<repo>/` within a minute or two.

Three.js is vendored in `lib/`, so the site works fully offline of CDNs.

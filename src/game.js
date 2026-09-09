import * as THREE from 'three';
import { Engine } from './engine.js';
import { aabbCollides } from './entity.js';
import { Player } from './player.js';
import { Coin, Enemy } from './enemy.js';

// ---- setup ----
const engine = new Engine();
const { scene } = engine;

scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(5, 10, 7);
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(20, 20),
  new THREE.MeshStandardMaterial({ color: 0x1a2233 })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
scene.add(new THREE.GridHelper(20, 20, 0x2b3a55, 0x22304a));

const player = engine.add(new Player());

// ---- game state ----
let score = 0;
let lives = 3;
let invincibleUntil = 0;
const scoreEl = document.getElementById('score');
const livesEl = document.getElementById('lives');

const coins = [];
function spawnCoin() {
  const [x, z] = Coin.randomPosition();
  coins.push(engine.add(new Coin(x, z)));
}
for (let i = 0; i < 5; i++) spawnCoin();

const enemies = [];
let enemyTimer = 0;
const ENEMY_INTERVAL = 4; // seconds between spawns

// ---- per-frame game logic ----
engine.onUpdate = (dt, eng) => {
  // coin pickup
  for (let i = coins.length - 1; i >= 0; i--) {
    const coin = coins[i];
    if (aabbCollides(player.object3D, player.halfSize, coin.object3D, coin.halfSize)) {
      coin.destroy(eng);
      coins.splice(i, 1);
      score += 1;
      scoreEl.textContent = score;
      spawnCoin();
    }
  }

  // enemy spawning + collision
  enemyTimer += dt;
  if (enemyTimer >= ENEMY_INTERVAL) {
    enemyTimer = 0;
    enemies.push(eng.add(new Enemy(player)));
  }

  const now = performance.now() / 1000;
  for (let i = enemies.length - 1; i >= 0; i--) {
    const enemy = enemies[i];
    if (
      now > invincibleUntil &&
      aabbCollides(player.object3D, player.halfSize, enemy.object3D, enemy.halfSize)
    ) {
      enemy.destroy(eng);
      enemies.splice(i, 1);
      lives -= 1;
      livesEl.textContent = lives;
      invincibleUntil = now + 1.5; // brief grace period
      if (lives <= 0) resetGame();
    }
  }

  // flash player while invincible
  player.object3D.material.opacity = now > invincibleUntil ? 1 : 0.4 + 0.3 * Math.sin(now * 20);
  player.object3D.material.transparent = true;

  eng.input.endFrame();
};

function resetGame() {
  score = 0;
  lives = 3;
  scoreEl.textContent = score;
  livesEl.textContent = lives;
  for (const e of enemies) e.destroy(engine);
  enemies.length = 0;
  player.object3D.position.set(0, 0.5, 0);
  invincibleUntil = performance.now() / 1000 + 2;
}

engine.start();

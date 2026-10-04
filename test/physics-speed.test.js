import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { contactBetween, probeBox, PhysicsWorld, RigidBody } from '../src/physics.js';

// Physics made quicker must stay the same physics. These check the quick ways
// against the plain ones, and keep the speed from quietly sliding back.

/** The separating-axis test as it was written plainly (15 axes, each worked out in full). */
function plainBoxBox(A, B) {
  const d = new THREE.Vector3().subVectors(B.center, A.center);
  let best = Infinity;
  let depth = 0;
  const n = new THREE.Vector3();
  const L = new THREE.Vector3();
  const test = (axis, bias) => {
    const len = axis.length();
    if (len < 1e-6) return true;
    L.copy(axis).divideScalar(len);
    const rA = A.half.x * Math.abs(A.axes[0].dot(L)) + A.half.y * Math.abs(A.axes[1].dot(L)) + A.half.z * Math.abs(A.axes[2].dot(L));
    const rB = B.half.x * Math.abs(B.axes[0].dot(L)) + B.half.y * Math.abs(B.axes[1].dot(L)) + B.half.z * Math.abs(B.axes[2].dot(L));
    const dist = d.dot(L);
    const overlap = rA + rB - Math.abs(dist);
    if (overlap <= 0) return false;
    if (overlap * bias < best) { best = overlap * bias; depth = overlap; n.copy(L).multiplyScalar(dist > 0 ? -1 : 1); }
    return true;
  };
  for (let i = 0; i < 3; i++) if (!test(A.axes[i], 1)) return null;
  for (let i = 0; i < 3; i++) if (!test(B.axes[i], 1)) return null;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (!test(new THREE.Vector3().crossVectors(A.axes[i], B.axes[j]), 1.05)) return null;
  return { n, depth };
}

let seed = 7;
const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

function randomBox(near = null) {
  const c = new THREE.Vector3((rand() - 0.5) * 3, (rand() - 0.5) * 3, (rand() - 0.5) * 3);
  if (near) c.add(near);
  const box = probeBox(c, new THREE.Vector3(0.2 + rand(), 0.2 + rand(), 0.2 + rand()));
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rand() * 7, rand() * 7, rand() * 7));
  if (rand() < 0.25) q.identity(); // lined up: the ties a stack has
  box.axes.forEach((axis, k) => axis.set(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0).applyQuaternion(q));
  return box;
}

describe('quicker physics, the same physics', () => {
  it('box against box: the same overlap and the same way out as the plain test, 2000 times', () => {
    let touching = 0;
    for (let k = 0; k < 2000; k++) {
      const A = randomBox();
      const B = randomBox(A.center);
      const quick = contactBetween(A, B);
      const plain = plainBoxBox(A, B);
      expect(!!quick).toBe(!!plain);
      if (!plain) continue;
      touching++;
      expect(quick.depth).toBeCloseTo(plain.depth, 9);
      expect(quick.n.distanceTo(plain.n)).toBeLessThan(1e-9);
    }
    expect(touching).toBeGreaterThan(500); // it was really tested
  });

  it('a raycast among a thousand bodies costs about nothing', () => {
    const physics = new PhysicsWorld();
    for (let i = 0; i < 1000; i++) {
      const o = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
      o.position.set((rand() - 0.5) * 180, 0.5, (rand() - 0.5) * 180);
      o.updateMatrixWorld(true);
      physics.register({ object3D: o, rigidBody: new RigidBody({ type: i % 3 ? 'static' : 'dynamic' }) });
    }
    physics.step(1 / 60);
    const from = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const batch = (n) => {
      const t = performance.now();
      for (let k = 0; k < n; k++) {
        from.set((rand() - 0.5) * 180, 1, (rand() - 0.5) * 180);
        dir.set(rand() - 0.5, -0.05, rand() - 0.5).normalize();
        physics.raycast(from, dir, 60);
      }
      return (performance.now() - t) / n;
    };
    batch(50); // warmed up
    // the best of three: other tests running alongside steal time from one batch, not from all three
    const each = Math.min(batch(200), batch(200), batch(200));
    expect(each).toBeLessThan(0.5); // it was 1.9 ms here (6 ms on a slower machine): every body rebuilt, every ray
  });
});

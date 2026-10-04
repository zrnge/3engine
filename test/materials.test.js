// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';

// Decoding images needs a real browser: stand in textures that carry the same
// identity (asset id + name), which is all the material code relies on.
vi.mock('../src/factories.js', async (importOriginal) => {
  const actual = await importOriginal();
  const { Texture } = await import('three');
  return {
    ...actual,
    loadStoredTexture: vi.fn(async ({ assetId, name } = {}) => {
      if (assetId === 'missing') throw new Error('not in the store');
      const t = new Texture();
      t.name = name;
      t.userData.assetId = assetId;
      return t;
    }),
  };
});

import { loadStoredTexture } from '../src/factories.js';
import {
  normalizeSpec, materialSpec, applyMaterialSpec, createMaterial, adoptMaterial, materialReady,
  withTexture, withMadeTexture, classifyTexture, potSize, setMaxAnisotropy, updateWorldUVs,
  countUsers, cloneMaterial,
} from '../src/materials.js';
import {
  PATTERNS, normalizeTexParams, samplePattern, renderTexturePixels, makeProceduralTexture,
} from '../src/texgen.js';

afterEach(() => setMaxAnisotropy(1));

// ------------------------------------------------------------ texture maker

describe('texture maker', () => {
  it('every pattern repeats seamlessly: each edge continues the opposite one', () => {
    const close = (a, b) => {
      expect(a.t).toBeCloseTo(b.t, 6);
      expect(a.h).toBeCloseTo(b.h, 6);
    };
    for (const pattern of Object.keys(PATTERNS)) {
      if (pattern === 'gradient') continue; // a ramp, by design
      const p = normalizeTexParams({ pattern, seed: 3 });
      for (const t of [0.13, 0.5, 0.77]) {
        close(samplePattern(p, 0, t), samplePattern(p, 1, t));
        close(samplePattern(p, t, 0), samplePattern(p, t, 1));
      }
    }
  });

  it('keeps checker squares and brick rows even, or they would not repeat', () => {
    expect(normalizeTexParams({ pattern: 'checker', scale: 7 }).scale).toBe(8);
    expect(normalizeTexParams({ pattern: 'bricks', scale: 5 }).scale).toBe(6);
    expect(normalizeTexParams({ pattern: 'planks', scale: 5 }).scale).toBe(5);
    expect(normalizeTexParams({ pattern: 'nope', size: 999 })).toMatchObject({ pattern: 'checker', size: 512 });
  });

  it('a flat pattern has a flat normal map; bricks have bumps', () => {
    const flat = renderTexturePixels({ pattern: 'checker', size: 64, bump: 0 });
    expect(flat.color.length).toBe(64 * 64 * 4);
    for (let i = 0; i < flat.normal.length; i += 4) {
      expect([flat.normal[i], flat.normal[i + 1], flat.normal[i + 2]]).toEqual([128, 128, 255]);
    }
    const bricks = renderTexturePixels({ pattern: 'bricks', size: 64 });
    let tilted = 0;
    for (let i = 0; i < bricks.normal.length; i += 4) if (Math.abs(bricks.normal[i] - 128) > 20) tilted++;
    expect(tilted).toBeGreaterThan(20);
  });

  it('the same settings make the same pixels; the seed changes them', () => {
    const a = renderTexturePixels({ pattern: 'noise', size: 64, seed: 1 });
    const b = renderTexturePixels({ pattern: 'noise', size: 64, seed: 1 });
    const c = renderTexturePixels({ pattern: 'noise', size: 64, seed: 2 });
    expect(a.color).toBe(b.color); // cached
    expect(Array.from(a.color)).not.toEqual(Array.from(c.color));
  });

  it('makes a filtered, mipmapped texture — not DataTexture\'s blocky default', () => {
    const tex = makeProceduralTexture({ pattern: 'tiles', size: 64 });
    expect(tex.generateMipmaps).toBe(true);
    expect(tex.magFilter).toBe(THREE.LinearFilter);
    expect(tex.minFilter).toBe(THREE.LinearMipmapLinearFilter);
  });
});

// ------------------------------------------------------------ materials

describe('material description', () => {
  it('every PBR slot gets the right colour space', async () => {
    const m = createMaterial({
      maps: {
        map: { assetId: 'a' }, normalMap: { assetId: 'n' }, roughnessMap: { assetId: 'r' },
        metalnessMap: { assetId: 'm' }, aoMap: { assetId: 'o' }, emissiveMap: { assetId: 'e' }, alphaMap: { assetId: 'x' },
      },
    });
    await materialReady(m);
    expect(m.map.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(m.emissiveMap.colorSpace).toBe(THREE.SRGBColorSpace);
    for (const slot of ['normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap']) {
      expect(m[slot].colorSpace, slot).toBe(THREE.NoColorSpace);
    }
  });

  it('survives a round trip exactly — what you save is what comes back', async () => {
    const spec = withMadeTexture(normalizeSpec({
      color: '#ff8800', metalness: 0.3, emissive: '#112233', emissiveIntensity: 2,
      alphaMode: 'cutout', alphaCutoff: 0.4, normalStrength: 1.5, flipGreen: true,
      uv: { repeat: [3, 2], offset: [0.25, 0], rotation: 45, wrap: 'mirror', filter: 'pixel', worldScale: true, tileSize: 2 },
    }), { pattern: 'tiles', seed: 5, size: 64 });
    const m = createMaterial(spec);
    await materialReady(m);
    const saved = materialSpec(m);
    expect(saved.maps.map.procedural.pattern).toBe('tiles');
    expect(saved.maps.normalMap.output).toBe('normal');
    expect(saved.uv).toEqual({ repeat: [3, 2], offset: [0.25, 0], rotation: 45, wrap: 'mirror', filter: 'pixel', worldScale: true, tileSize: 2 });
    const again = createMaterial(saved);
    await materialReady(again);
    expect(materialSpec(again)).toEqual(saved);
  });

  it('re-applying keeps the textures; moving a slider never reloads an image', async () => {
    const m = createMaterial(withMadeTexture({}, { pattern: 'bricks', size: 64 }));
    const { map, normalMap } = m;
    const spec = materialSpec(m);
    spec.uv.repeat = [4, 4];
    await applyMaterialSpec(m, spec);
    expect(m.map).toBe(map);
    expect(m.normalMap).toBe(normalMap);
    expect(m.map.repeat.toArray()).toEqual([4, 4]);
    expect(m.normalMap.repeat.toArray()).toEqual([4, 4]); // every slot moves together
  });

  it('smooth uses the GPU\'s best anisotropic filtering; pixelated is crisp', async () => {
    setMaxAnisotropy(8);
    const m = createMaterial(withMadeTexture({}, { pattern: 'checker', size: 64 }));
    expect(m.map.anisotropy).toBe(8);
    expect(m.map.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    const version = m.map.version;
    const spec = materialSpec(m);
    spec.uv.filter = 'pixel';
    spec.uv.wrap = 'mirror';
    await applyMaterialSpec(m, spec);
    expect(m.map.magFilter).toBe(THREE.NearestFilter);
    expect(m.map.anisotropy).toBe(1);
    expect(m.map.wrapS).toBe(THREE.MirroredRepeatWrapping);
    expect(m.map.version).toBeGreaterThan(version); // re-uploaded, or the change would not show
  });

  it('transparency modes: auto by opacity, cutout for hard edges, blend for glass', () => {
    const m = createMaterial({ opacity: 0.5 });
    expect([m.transparent, m.alphaTest]).toEqual([true, 0]);
    applyMaterialSpec(m, { opacity: 1, alphaMode: 'cutout', alphaCutoff: 0.3 });
    expect([m.transparent, m.alphaTest]).toEqual([false, 0.3]);
    applyMaterialSpec(m, { alphaMode: 'blend' });
    expect([m.transparent, m.alphaTest]).toEqual([true, 0]);
  });

  it('normal strength, and DirectX normal maps flip green', () => {
    const m = createMaterial({ normalStrength: 0.5, flipGreen: true });
    expect(m.normalScale.toArray()).toEqual([0.5, -0.5]);
  });

  it('a packed ORM image fills AO, roughness and metalness with one texture', async () => {
    const m = createMaterial({ maps: { orm: { assetId: 'orm-1', name: 'wall_arm.png' } } });
    await materialReady(m);
    expect(m.aoMap).toBeTruthy();
    expect(m.roughnessMap).toBe(m.aoMap);
    expect(m.metalnessMap).toBe(m.aoMap);
    const saved = materialSpec(m);
    expect(saved.maps.orm).toEqual({ assetId: 'orm-1', name: 'wall_arm.png' });
    expect(saved.maps.roughnessMap).toBeNull();
    expect(loadStoredTexture).toHaveBeenCalledTimes(1 + 7); // 7 from the colour-space test
  });

  it('reads the older { color, map } form', async () => {
    const m = createMaterial({ color: '#ffffff', map: { assetId: 'old', name: 'old.png' }, baseColor: '#e0601a' });
    await materialReady(m);
    expect(m.map.userData.assetId).toBe('old');
    expect(m.userData.baseColor).toBe(0xe0601a);
  });

  it('leaves a model\'s own textures alone unless they are changed here', async () => {
    const m = new THREE.MeshStandardMaterial();
    const own = new THREE.Texture(); // came in the GLB: no source of ours
    own.repeat.set(2, 2);
    m.map = own;
    const spec = materialSpec(m);
    expect('map' in spec.maps).toBe(false);
    spec.color = '#ff0000';
    await applyMaterialSpec(m, spec);
    expect(m.map).toBe(own);
    expect(own.repeat.toArray()).toEqual([2, 2]); // its own placement kept
    await applyMaterialSpec(m, { ...spec, maps: { map: null } });
    expect(m.map).toBeNull();
  });

  it('keeps the newest texture when an older one finishes loading later', async () => {
    let release;
    loadStoredTexture.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const m = new THREE.MeshStandardMaterial();
    const slow = applyMaterialSpec(m, { maps: { map: { assetId: 'slow' } } });
    applyMaterialSpec(m, withMadeTexture({}, { pattern: 'grid', size: 64 }));
    const late = new THREE.Texture();
    release(late);
    await slow;
    expect(m.map).not.toBe(late);
    expect(m.map.userData.source.procedural.pattern).toBe('grid');
  });

  it('a missing image warns instead of breaking the load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = createMaterial({ maps: { map: { assetId: 'missing' } } });
    await expect(materialReady(m)).resolves.toBe(m);
    expect(m.map).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('editing helpers', () => {
  it('a first colour texture shows untinted, and clearing it brings the colour back', () => {
    let s = withTexture({ color: '#e0601a' }, 'map', { assetId: 't' });
    expect([s.color, s.baseColor]).toEqual(['#ffffff', '#e0601a']);
    s = withTexture({ ...s, color: '#ffcccc' }, 'map', { assetId: 't2' }); // replacing keeps the tint
    expect(s.color).toBe('#ffcccc');
    s = withTexture(s, 'map', null);
    expect(s.color).toBe('#e0601a');
    expect(s.baseColor).toBeUndefined();
  });

  it('data maps show as painted: their sliders go to 1', () => {
    expect(withTexture({ roughness: 0.2 }, 'roughnessMap', { assetId: 'r' }).roughness).toBe(1);
    expect(withTexture({ metalness: 0 }, 'orm', { assetId: 'o' })).toMatchObject({ roughness: 1, metalness: 1 });
    expect(withTexture({}, 'emissiveMap', { assetId: 'e' }).emissive).toBe('#ffffff');
    expect(withTexture({}, 'normalMap', { assetId: 'n' }, { directX: true }).flipGreen).toBe(true);
  });

  it('sorts a texture set into slots by file name', () => {
    const cases = {
      'brick_wall_diff_2k.jpg': 'map',
      'Bricks076_1K_Color.png': 'map',
      'T_Crate_D.png': 'map',
      'brick_wall_nor_gl_2k.png': 'normalMap',
      'Bricks076_1K_NormalDX.png': 'normalMap',
      'T_Crate_N.tga': 'normalMap',
      'metal_plate_rough.jpg': 'roughnessMap',
      'Metal_Plate_Metallic.png': 'metalnessMap',
      'rock_ao.png': 'aoMap',
      'Rock_AmbientOcclusion.jpg': 'aoMap',
      'brick_wall_arm_2k.jpg': 'orm',
      'lamp_emissive.png': 'emissiveMap',
      'leaves_opacity.png': 'alphaMap',
      'Rock_Displacement.png': 'height',
      'holiday-photo.jpg': null,
    };
    for (const [name, slot] of Object.entries(cases)) expect(classifyTexture(name).slot, name).toBe(slot);
    expect(classifyTexture('Bricks076_1K_NormalDX.png').directX).toBe(true);
    expect(classifyTexture('brick_wall_nor_gl_2k.png').directX).toBe(false);
  });

  it('resizes to the nearest power of two, capped', () => {
    expect(potSize(1, 1)).toEqual([1, 1]);
    expect(potSize(1000, 700)).toEqual([1024, 512]);
    expect(potSize(4000, 3000)).toEqual([2048, 2048]);
    expect(potSize(4000, 3000, 4096)).toEqual([4096, 4096]);
    expect(potSize(300, 90, 1024)).toEqual([256, 64]);
  });
});

describe('library and tile-by-size', () => {
  it('library materials are one shared material', async () => {
    const library = new Map();
    const a = createMaterial({ color: '#123456', library: 'Stone' }, { library });
    const b = createMaterial({ color: '#ffffff', library: 'Stone' }, { library });
    expect(b).toBe(a);
    expect(library.get('Stone')).toBe(a);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    await adoptMaterial(mesh, { library: 'Stone' }, library);
    expect(mesh.material).toBe(a);
    const scene = new THREE.Scene();
    scene.add(mesh, new THREE.Mesh(new THREE.BoxGeometry(), a));
    expect(countUsers(scene, a)).toBe(2);
  });

  it('"Make unique" really is independent: its tiling does not move the original\'s textures', async () => {
    const library = new Map();
    const shared = createMaterial({ ...withMadeTexture({}, { pattern: 'bricks', size: 64 }), maps: {
      ...withMadeTexture({}, { pattern: 'bricks', size: 64 }).maps, orm: { assetId: 'orm-2' },
    }, library: 'Bricks' }, { library });
    await materialReady(shared);
    const own = cloneMaterial(shared);
    expect(own).not.toBe(shared);
    expect(own.userData.t3.library).toBeUndefined();
    expect(own.map).not.toBe(shared.map);
    expect(own.map.source).toBe(shared.map.source); // the pixels are still shared
    expect(own.roughnessMap).toBe(own.aoMap);          // ORM still one texture
    const spec = materialSpec(own);
    spec.uv.repeat = [5, 5];
    await applyMaterialSpec(own, spec);
    expect(own.map.repeat.x).toBe(5);
    expect(shared.map.repeat.x).toBe(1);
  });

  it('tile by size repeats the texture as the object grows instead of stretching it', () => {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const original = Array.from(geo.attributes.uv.array);
    const mesh = new THREE.Mesh(geo, createMaterial({ uv: { worldScale: true, tileSize: 1 } }));
    mesh.scale.set(4, 1, 1);
    const scene = new THREE.Scene();
    scene.add(mesh);
    scene.updateMatrixWorld(true);

    const frontSpan = () => {
      const { normal, uv } = mesh.geometry.attributes;
      const us = [];
      const vs = [];
      for (let i = 0; i < normal.count; i++) {
        if (normal.getZ(i) > 0.9) { us.push(uv.getX(i)); vs.push(uv.getY(i)); }
      }
      return [Math.max(...us) - Math.min(...us), Math.max(...vs) - Math.min(...vs)];
    };

    updateWorldUVs(scene);
    expect(mesh.geometry).not.toBe(geo); // its own copy: shared geometry is never rewritten
    expect(frontSpan()).toEqual([4, 1]);

    mesh.scale.set(2, 3, 1);
    scene.updateMatrixWorld(true);
    updateWorldUVs(scene);
    expect(frontSpan()).toEqual([2, 3]);

    mesh.material.userData.t3.uv.worldScale = false;
    updateWorldUVs(scene);
    expect(Array.from(mesh.geometry.attributes.uv.array)).toEqual(original);
  });
});

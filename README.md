# Tiny3

A browser-based 3D scene editor and game engine built on [Three.js](https://threejs.org).
Build a scene with a real transform gizmo, give objects physics and scripts, press
**Play**, and export a playable HTML file.

No build step and no install: Three.js is vendored under `lib/`, so the whole
thing runs as static files on GitHub Pages.

## Run locally

```sh
npm run serve        # or: python serve.py
# open http://localhost:8000
```

`serve.py` is `python -m http.server` with caching turned off, so an edit always
shows up on reload. Any static server works, but a caching one can keep serving
old modules after you change them. (ES modules can't load from `file://`.)

## What's in the editor

One panel per job, docked in two columns. Click a panel's header to collapse or
expand it (remembered between visits), drag the header to float the panel
anywhere, and double-click a floating panel's header to dock it again.

| Left dock | What it does |
|---|---|
| **Levels** | The game's levels: add, open, rename, reorder, duplicate, delete; ★ marks where the game starts |
| **Hierarchy** | Every object in the scene. Click to select, drag to reparent, shift-click for multi-select |
| **Shape** | Add shapes; type exact position / rotation / scale; snapping and gizmo sensitivity |
| **Color & Texture** | Full PBR materials: 8 texture slots, texture maker, tiling / offset / rotation, tile by size, smooth or pixelated, transparency, glow, and a shared material library |
| **Lighting** | Natural environment — sun, sky, shadows, fog — with presets and a time-of-day slider, plus extra lights |
| **Asset Browser** | Save a selected object as a prefab and place linked copies (see [Prefabs](#prefabs)) |

| Right dock | What it does |
|---|---|
| **Inspector** | Name, parent, physics body, components, rules, behavior script, animation clips |
| **Audio** | Mixer (master · music · effects · ambience), scene music & ambience, and the sounds on the selection — made in the sound maker or imported |
| **Camera** | The camera the game plays with, what it follows, and a tab of settings for each camera (orbit, follow, first person, fly) |
| **Controls** | Pick which object is the player, and **+ Add control** — any key, mouse button or on-screen button, doing anything |
| **Game** | Variables — score, lives, anything a rule needs to remember |
| **Screens & dialogue** | The game's own menus, inventory, map and shop screens, and conversations with choices — see [Screens and dialogue](#screens-and-dialogue) |

The **Toolbar** across the top has play/stop, gizmo and camera modes, import GLB,
undo/redo, copy/paste, new/save/load and **Export**. Export makes the whole game —
Three.js, the engine, every level, model, sound and texture — playable without the
editor: as one HTML file that runs anywhere, or as a website for GitHub Pages (see
[Publishing your game](#publishing-your-game)).

### Controls

**Camera** (orbit mode)

| Mouse | Touch | Does |
|---|---|---|
| Left-click + drag | One-finger drag | Orbit around the pivot |
| Right-click + drag | Two-finger drag | Pan (speed tunable in the Camera panel) |
| Scroll anywhere | Pinch | Zoom |
| Double-click a model | — | Glide onto that point and zoom in |

Also: middle-drag, `Space`+left-drag, or the **✋ Pan** tool (`H`) pan with the
left button — handy on a trackpad.

**Editing**

| Input | Action |
|---|---|
| Click (without dragging) | Select — shift-click to add to the selection |
| Drag a gizmo handle | Move / rotate / scale |
| `G` `R` `S` | Gizmo mode: move · rotate · scale |
| `1` `2` `3` `4` | Camera: orbit · follow · first person · free-fly |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| `Ctrl+C` `Ctrl+V` `Ctrl+D` | Copy · paste · duplicate |
| `Ctrl+S` / `Ctrl+O` | Save / open a game `.tiny3` (an older `.json` opens too) |
| `L` | Import a `.glb` / `.gltf` model from disk |
| `Delete` | Delete selection |
| `Esc` | Deselect, or stop Play mode |
| `P` | Pause / resume while playing |

Single keys and `Ctrl` shortcuts stand aside while you type in a field, so a
`3` typed into a position stays a `3`, and `Ctrl+V` pastes text there.

**First person** (`3`) looks out of the player's eyes: click the view in Play to
look around with the mouse (`Esc` gives the mouse back), and `W` walks wherever
you look.

In Play mode the panels lock and the simulation runs; stopping restores the exact
scene you started from. Exported games show the variables (score, lives…) at the
top of the screen; name a variable with a leading `_` to keep it hidden. The game
autosaves into the browser's database (IndexedDB) a moment after every change, and
at once when you leave the tab; imported models and sounds are kept there too, so
a refresh loses nothing. If an autosave ever fails, a notice says so and offers
💾 Save.

**Saving and storage.**
- **Save carries everything.** The saved `.tiny3` file holds the game and its
  models, imported textures and sound files — a zip of `game.json` and the files
  as they are (a 17 MB model stays 17 MB; inside an older `.json` it was base64,
  a third bigger) — so it opens complete in any browser or on any computer. A
  `.json` saved before still opens. Files saved before v0.18.2 don't carry their
  models, so open those in the browser that made them.
- **Someone else's game, safely.** A game opened from a file that has
  behaviour scripts has them **off** until you allow them (a notice says how
  many, with *Allow scripts*): a script can do anything the editor's page can,
  including reading the other games kept in this browser. The choice is kept
  after a reload; new games, templates and exported games run theirs as always.
- **Cleanup at startup.** Files nothing has needed for 30 days are removed from
  browser storage.
- **Cleanup now.** The Asset Browser shows how much is stored, and **Remove
  unused** clears everything the open game doesn't need. It keeps anything Undo
  or the clipboard could still bring back.

## Natural lighting

Every scene starts in daylight. The **Environment** section of the Lighting panel
lights the whole scene on its own:

- **Sun** with soft shadows, sized automatically to fit whatever is in the scene
- **Sky light** — the side of an object facing away from the sun is lit by the
  sky and the ground instead of going black
- **Reflections** of the sky on shiny and metal surfaces
- **Filmic tone mapping** and **atmospheric fog**

Pick a preset — **Day**, **Golden hour**, **Overcast**, **Night**, **Studio** — or
drag **Time**: one slider moves the sun and recolours the light, sky and fog
together, from noon through sunset to moonlight. **Off** leaves only the lights
you add. Lights you add sit on top of the environment, for lamps and highlights.

The environment is saved with the scene and ships in exported games.

**Sharper shadows.**
- **Shadow detail** (Low, Medium, High) sets how many pixels the sun's shadow
  has.
- **Shadow range** keeps shadows sharp round the player (or what the editor
  looks at) instead of stretched over a whole big level. The shadow moves in
  whole pixels as you walk, so its edges don't shimmer. Left at 0 it is
  **automatic**: a small level is shadowed all at once; a big one (a terrain,
  a town — over 70 m from its middle) sharply round the player: 35, 50 or 70 m
  each way for Low, Medium, High. Over all of a big level each shadow pixel was
  a quarter of a metre or more, and with the sun low the ground showed it in
  blocky bands.
- A **low sun** (morning, evening) skims the ground, so shadows are kept off
  the surface casting them a little more then: no bands of the ground
  shadowing itself at sunset.

**Lamp shadows.** A point or spot light with **Cast shadows** on (Lighting
panel) casts them, tuned to the lamp: as far as its light reaches, at the level's
Shadow detail, with soft edges and no speckled "acne". **Lamp shadows** sets how
many cast at once (4 by default, up to 8). Each frame those are the nearest to the
camera, and the rest light without shadows for that frame. A level with forty
torches neither draws forty shadow maps (a point light draws six) nor runs out
of the GPU's texture slots. The number casting stays the same as you move, so
nothing is rebuilt when one lamp hands its shadow to the next.

**Effects.** Each can be switched on alone, and the editor shows them as you
work:

| Effect | What it does |
|---|---|
| **Bloom** | What is brighter than **From brightness** glows into the air round it, by **Glow**, as far as **Spread**. Give a material a glow (its emissive colour, under Surface) for neon, lava or a lamp |
| **Ambient occlusion** | Corners, creases and where things meet the ground are shaded softly, as real light is: objects sit in the world instead of floating on it. **Shade** is how dark, **Reach** how far from a corner (m) |
| **Depth of field** | What is nearer or farther than the focus blurs, as through a lens. **Focus on** the player (seen from behind), what the middle of the view rests on (first person), or a set distance. It refocuses smoothly |
| **Colour** | **Contrast**, **Saturation** (−1 is black and white), **Warmth** (amber, or blue), a **Vignette** that darkens the corners, and moving **Film grain** |

A first-person gun is drawn into the same picture: graded with the world, and
never blurred by the depth of field. Hollow House uses a drained, cold, grainy
grade; Night Watch a cold one with a vignette.

**Light probes.** Outdoors, everything takes its reflections and its soft light
from the sky. Inside a room that's wrong: pans, walls and the player shine with
a blue sky they can't see. Add a **Probe** (Lighting panel, next to the lights)
and scale its box to the room; a box drawn to the room's size takes the walls
too. It captures the room from its middle (the lamps, the walls, the sky
through the windows), and everything inside the box is lit and reflected by
that instead. Where boxes overlap, the smaller one wins (a cupboard in a room).
What moves (the player, a thrown box) takes the probe of wherever it is.

It is captured when the level loads, when a probe is placed, moved or sized,
when the sky changes, and when a lamp is switched on or off. In the editor a
probe shows as a box and a mirror ball (what it caught); in the game neither is
drawn. **Strength** sets how much it shows, and **Capture again** is for after
moving walls or furniture. Only the box and the strength are saved, so a probe
costs nothing in the file.

**Speed.**
- **Draw copies together** (on by default). While playing, copies that look
  alike (the same shape, and the same material but any colour) are drawn in
  one go. 60 crates took 4 draws instead of 64. They are still clicked, shot,
  collided with and destroyed one by one.
- **Draw distance.** Nothing farther than this is drawn.
- **Level of detail** (a component). Far away, an object is drawn with a
  simpler version of its shape, made automatically, and farther still not at
  all. Only its drawing changes.

These settings are saved per level.

## What the player sees

- **HUD:** every variable shows at the top of the screen. In the Game panel,
  pick how each one looks: a **number**, a **bar** (health, fuel) or **hearts**
  (lives), with how many make it full — or **hidden**. Names starting with `_`
  never show.
- **Variables on screen** (Game panel): where the HUD sits — a corner, the
  middle of a side, top or bottom centre, nudged by pixels — side by side or
  one under another, its font, text size, value and label colours, capitals,
  bold, a text shadow, and the box behind it (colour, opacity, border, rounded
  corners), with a preview. A variable's **⚙** gives it a label, place, colour
  and size of its own: the score big and red top right, lives and ammo bottom
  left. In a bottom corner it sits above a touch screen's joystick and buttons.
- **Show message:** a rule or control action that puts text on screen for a few
  seconds — "The door grinds open…" — in the middle, top or bottom.
- **Title screen:** the game's name, a subtitle and "Press any key to start",
  shown before the game begins (in exported games; tick *Also when I press Play
  here* to see it in the editor too, or use *Preview*).
- **Crosshair** (Game panel), off unless you choose a style:
  - **Style:** dot, cross, cross + dot, circle, circle + dot.
  - **Look:** size, thickness, gap, colour, opacity, and a dark outline so it
    shows on anything.
  - **When:** in first person, while the mouse is captured, or always.

  A preview shows it over sky and ground.
- **Pause menu** (exported games). It opens with Esc, P, the ⏸ button on
  touch screens, or when the player switches tabs, and the game stops behind it.
  - **Resume**
  - **Restart level**, which puts the variables back as they were when the
    level began.
  - **Restart game**, which asks once more first.
  - **Sound effects** and **Music** volume and **Mute**, remembered for the
    next visit.
  - The game's controls.

  In first person, the Esc that frees the mouse also pauses.

**Animator** (a component) makes a character move like one. A model plays
the clips you pick for **standing**, **walking**, **running** (from a speed you
set) and **in the air**, blending between them. A plain shape bobs as it walks,
leans into its run, stretches as it falls and squashes when it lands. This is
drawn only: the physics never sees it, so it can't make a character jitter or
sink.

## Screens and dialogue

The **Screens & dialogue** panel designs the game's own interface: menus, an
inventory, a map, a shop, a note, and conversations. A preview shows each one
drawn as the game draws it, and it works the same in Play and in an exported
game.

### Screens

A screen is a card with a title, a place (the middle, a side, the top or bottom,
or the whole screen) and a width, plus what's on it:

| Item | What it is |
|---|---|
| **Text** | Any text, with `{expressions}` worked out as it plays: `Coins: {coins}`, `{len(bag)} things` |
| **Button** | Closes this screen, opens or closes another, starts a dialogue, sends an event, restarts the game, or just runs its rules. Every button also runs the rules **A button is pressed** (this screen, this label). It can have a key too (`Digit1`, `KeyY`, `Enter`) |
| **List** | A list variable as tiles: an inventory. The same ones go together (`potion ×2`) if you like. Clicking a tile puts it in a variable (*Picked into*, `picked` by default) and runs the rules **An item is picked** |
| **Bar** | A number variable out of its maximum: health in a menu |

A screen can **pause the game** while it's up (a menu, an inventory) or let it
run on (a map in the corner), **dim** what's behind it, and have a **×** to close
it.

Open one with a rule (**Show / hide a screen**: show, hide, or toggle) or with a
key in Controls. The same action works there too: *I* toggles the bag in
Night Watch.

### Dialogue

A dialogue is lines, each said by someone, in order. A line either goes on to
another (the next one, a named one, or the end), or offers **choices**, which
the player picks with a click or the number keys. Each choice can:

- be shown **only if** an expression holds (`coins >= 5`,
  `not contains(bag, "key")`);
- **set** a variable (`coins` to `=coins - 5`);
- **send** an event (to every object with an *I receive an event* rule for it);
- **go to** a line, or end the dialogue.

Lines and choices can use `{expressions}` too: `Hello, {name}`. Space, Enter or
E goes on. Start a dialogue with the rule **Start a dialogue**, usually on the
person's *Someone interacts with me* rule. **A dialogue ends** rules run after
it. In the panel, **try it** in the preview: click the choices, and it goes
where they go (nothing is set or sent there).

Rules can also ask **A screen is up** and **A dialogue is under way**. Screen
and dialogue texts are in the Languages table, so they can be translated.

## Terrain and buildings

The Shape panel's **⛰ Terrain** and **🏠 Building** make whole pieces of a world
from a few settings, changed in the Inspector — live as a slider moves, one
undo step when you let go. Only the settings are saved (a few hundred bytes),
and the object is made again from them when the game opens or is exported.

- **Terrain** — a field, rolling hills, a valley with a river, a mountain, a
  mountain range, a crater, an island in the sea or a plateau. Its size,
  height, roughness and a *Variation* number (🎲 for another one of the same
  kind), its detail, a water level, and its colours: grass, rock where it is
  steep, snow above a snow line, sand by the water. It is solid as itself
  (you walk over its hills); its **Water** is a trigger zone (Physics →
  Parts), so a rule can say what happens when you get in.
- **Building** — a house, a hut, a shop, a tower: width, depth, storeys and
  their height, wall thickness; one room or two (a wall across the middle with
  a doorway); a door on any side, anywhere along it; windows on every wall,
  with or without glass; stairs between storeys (a flight on the back wall, a
  hole in the floor above); a gable, hip, flat or no roof; plaster, brick,
  wood or stone walls and their colours. The doors and windows are real
  openings: you walk in, see out, and walkers find their way round inside.
  Its parts are named (*Wall front*, *Floor 2*, *Stairs 1*, *Windows*,
  *Roof*…) for Physics → Parts.

**The ground stays out of a house.** A building **flattens the ground under
it**: a terrain beneath it is levelled to its base across its footprint (a
little beyond its walls), and eases back to its own shape round it — so a hill
never comes up through its floor. It follows the house as you move, turn or
resize it, and the land comes back where it stood. Any object can do the same
(Inspector → *Flatten the ground under it*, once the level has a terrain): an
imported house, a camp, a road. A new building put on a terrain stands on its
ground there. The levelling is worked out from where things are, never saved.

A new one is framed by the camera; a change that grows it round the camera
(a higher mountain) stands back again. Put things on it as its children —
trees on the hills, furniture in the house — and they stay when it is made
again.

### Big worlds

A terrain's **Detail** goes up to 1024 cells along a side. Over 128 it is made
in **chunks** of 128 (512 is 16 chunks): each is drawn simpler far from the
camera (every 2nd point beyond one and a half chunks away, every 4th beyond
three). A skirt down each chunk's edges hides where a simpler one meets a
finer one. Only the drawing changes: you walk on, and the brushes work on,
the full ground. Each chunk is its own part of the collider, so a big
terrain's physics stays quick. Its **Ground** is *textured* (a fine grain of
earth tiled every *Grain size* metres, under its colours) or *plain*. The
**Wild Valley** template is a 400 m valley at detail 512 with forests,
drawing at about 80 frames a second in a headless browser.

### Sculpt & paint

Select a terrain. Its Inspector has brushes; pick one and drag on the land
(the right button still pans, the wheel zooms; **Off** to select and move
again). A ring shows the brush, sized by **Size** (m), with **Strength** for how
much each moment of the stroke does:

| Brush | What it does |
|---|---|
| **Raise** · **Lower** | The ground up or down, most in the middle of the brush |
| **Smooth** | Bumps and ridges evened out |
| **Flatten** | To the height where the stroke began: a building plot, a road |
| **Paint** | Grass, dark grass, dirt, a path, mud, flowers, rock, sand or snow — or **Erase**. Another paint fades the last out first; edges are soft |

Each stroke is one undo step. What you sculpted and painted is saved with the
terrain as two small grids, run-length encoded: an untouched grid is a few
bytes, a painted path a few kilobytes. The land itself is still made from its
settings. Change its detail later and the grids are read at the new one. The
colours of dark grass, dirt (and mud), path and flowers are under *Paints*.

### Scatter

**🌲 Scatter** (Shape panel) is many of one kind of thing over an area:
**trees**, **pines**, **bushes**, **rocks**, **grass** or **flowers**. Choosing a
kind sets what suits it; then:

- **How many** (up to 20 000) over an **Area** (m across), and **Variation** for
  another arrangement;
- **Spacing**, the closest two can be; **Clumping**, from evenly spread to in
  copses and patches;
- **Steepest**, not on slopes steeper than this; **Not in water**; and **Not on**
  what is painted (paths, paths and dirt, any paint), so a path through a
  forest stays clear;
- **Smallest** / **Biggest**, two **colours** (leaves, and trunks or stems), and
  **Variety**, how much each one's colour differs;
- **Solid**: trunks and rocks are bumped into (a box round each in the
  scatter's collider). Grass and flowers are always walked through;
- **Draw distance**: not drawn farther away than this.

Each one stands on the terrain under it, worked out from the terrain's
settings rather than by casting rays. Rocks and grass lean with the slope.
Move the scatter, change the land under it (sculpting, a new shape, a house
levelling the ground) and it is placed again once you stop. Thousands are
drawn as copies, in cells, so a cell out of view costs nothing: Wild Valley's
11 000 plants are about 200 draws. Only the settings are saved.

## Importing models

Press **＋ GLB** (or `L`), or drag files from the desktop straight onto the view.


- **What comes in:** `.glb` files, and `.gltf` files with their `.bin` and
  textures. Pick them together, or drop the whole folder, so a Sketchfab download
  works as it is. A file picker can't reach into a `textures/` folder beside the
  `.gltf`, so picking the `.gltf` alone offers **Choose its folder…**. A `.gltf`
  is packed into one `.glb` on import, so it saves and exports like any other model.
- **Compressed models:** Draco meshes, meshopt, and KTX2 / Basis textures. The
  decoders live in `lib/libs/` and load only when a model needs them. An exported
  game carries only the decoders its own models use.
- **Where it goes:** a dropped model stands on whatever it lands on. A picked one
  stands on the ground in the middle of the view. Either way the camera glides
  onto it.
- **Wrong units:** a model that comes out over 50 m or under 5 cm across probably
  has a file in other units. A notice offers the likely fix (*Made in
  centimetres*, *Fit to 1 m*) or keeps its size. Each fix is one click, and
  undoable.
- **When it fails:** the notice says why: a damaged file, an old glTF 1.0 file,
  or a `.gltf` missing its `.bin` or textures (it names them).

Each copy of a model owns its materials, so recolouring one duck leaves the
others alone. For a shared look, use a library material or a prefab. A model
with several materials has a **Part** menu in Color & Texture. Clicking a part
of the model in the view picks it too.


**Other formats.** Besides .glb and .gltf, the editor reads:
- **.obj**, with its **.mtl** and textures (pick or drop them together, or the folder);
- **.fbx**, with its skeleton, animations and textures, inside the file or beside it;
- **.stl**, a single shape from 3D printing or CAD.

Each is made into a .glb as it comes in, so everything after (saving, copies,
physics, exported games) works with one kind of model. Their older materials
(shiny / matt) become standard ones, keeping colour, texture, bumps, glow and
see-through. A texture a file names but that wasn't given with it is listed
(drop it with the model). An empty animation take from an .fbx is dropped. A
model made in centimetres (most .fbx) is offered its size fix as it lands.

**Smaller models.** A model's textures are most of its size: a 4096 × 4096
PNG is 20–30 MB, and a game in a browser needs nothing like that. On import,
each texture is made no bigger than **Textures at most** (2048 px by default;
1024, 4096, or as they are). One with nothing see-through is stored as a
**JPEG**; normal maps and see-through ones stay PNG. A picture only changes if
it comes out smaller, and nothing else in the model does. It says what it
saved: a crate whose 4096 texture was 33 MB became 658 KB. The settings are
under the library and belong to this browser, not the game.

### The asset library

The **Asset Browser**'s **Library** shows everything the game can use:

| Kind | What it does |
|---|---|
| **Models** | Imported ones, each with a picture of itself. Click to place it in front of the view |
| **Animations** | Clips from other files |
| **Textures** | Pictures put on surfaces. Click to put it on the selected object |
| **Sounds** | Sound files. Click to hear it |
| **Built-in** | The engine's own models (`assets/library.json`). Clicking one stores it in this game, as if imported, so an export carries it |

Search by name (and a built-in's tags), filter by kind. Each shows its size
and how many times the game uses it (*×3*, or *unused*). **✎** renames it;
**×** deletes one nothing uses. **＋ Import…** takes models in every format
above. **Prefabs** has the game's prefabs, as before. Add your own models to
the built-in list by putting the file in `assets/` and an entry in
`assets/library.json`.

## Animated models

Bring any GLB/GLTF with animations: a third-person character, or first-person
arms holding a gun. Nothing in Tiny3 expects particular clip names or keys. You
decide what each clip is for and what plays it.

Select the model (**+ GLB** to import one). The Inspector's **Animation**
section lists every clip in the file:

- **▶** previews a clip.
- **+ Bind** waits for whatever you press next: a key, a mouse button, or
  **On-screen button** for touch screens. That becomes a control that plays
  the clip, shown on the clip and in the Controls panel.
  - **once**: plays through, then back to movement. A shot can't cut a reload
    short unless you tick *Cut off others*.
  - **loop**: keeps going until a *Stop animation*.
  - **while held**: aiming, blocking, charging.
  - **while held, once**: plays through and stays on its last frame until let
    go — raising a gun.

  It can also play a sound.
- **🧍 Make it the player** (third person): the model becomes the player,
  gets a capsule body so it stands, walks and jumps, and the game camera
  follows it.
- **🖐 Hold in first-person view**: the model is drawn in front of the camera
  in first person, turned to a starting place. Rigged arms keep their own size,
  with the eye at their shoulder end and the sights in the middle of the view;
  a plain object is sized to fit and held at your right hand. Adjust it with the
  **Held in view** sliders and **👁 Preview in first person**. It is drawn over
  the world, so a gun never pokes through a wall you stand against, and its
  **Animator** follows the player's movement. The **Aiming** tab places it for
  an [Aim](#aiming-and-shooting) control.

**Only one clip, or none?** Many models come that way, and there are two fixes:
- **One animation per file** (Mixamo, many stores): **＋ Clips from other
  files…** adds several at once. A file with one clip gives it the file's name,
  so *Walking.glb* becomes **Walking**, not *mixamo.com*. An **.fbx** works too
  (Mixamo's come as .fbx). A clip made for a **different skeleton** is carried
  across by body part (see below), and the Inspector says so.
- **Every move in one long clip** (*Take 001*, Sketchfab's *allanimations*):
  **✂** cuts a part out of it into a new named clip. Drag the time slider and
  the model shows each moment. Mark **Start here** and **End here**, then
  **▶ Play part** loops it before you cut.

Each clip shows its length. Added clips and cut parts can be removed with ×, and
they save, copy, update across prefabs and export with the model.

**Plays on its own** (at the top of the Animation section) picks the clip a
model loops whenever it isn't moving, such as breathing or idling. Tick **Also
while editing** to see it as you build the scene. It is the Animator's standing
clip, so the two always agree.

Both setups add an **Animator**. Pick its standing, walking, running and
in-the-air clips from the model's own list. **Play animation** and **Stop
animation** are also rule actions, so events can play a clip too (a *Death*
clip when health reaches zero, say).

Rigged characters, whose skin follows a skeleton, animate properly, and their
collider fits the body rather than the outstretched arms.

### The Animator

| Setting | What it does |
|---|---|
| **Blend by speed** | Standing, walking and running are mixed by how fast it goes, each with a weight, eased over *Blend (s)*: nothing pops from one clip to the next. Walking and running are kept in step, at the same moment of their stride. Off: one clip at a time, as before |
| **Walking at** · **Running at** (m/s) | The speeds the clips were made for |
| **Play as fast as it moves** | Walking and running are sped up or slowed down to match its real speed, so its feet don't slide over the ground |
| **Clips for states** | A clip for each state it can be in, from *Set state* or an Enemy AI: *chasing* → Run, *stunned* → Dizzy, *dead* → Death. Each one *loops* while in that state, plays *once, then holds* its last frame (a fall), or plays *once, then moves* again. The state machine is its states (rules and the AI change them); this is what each one looks like |
| **Feet on the ground (IK)** | Each leg bends so its foot rests on the ground under it: steps, slopes, rocks. The hips lower as far as the lower foot needs. For a model with legs (hips, thighs, shins, feet) |
| **Looks at** | Its head (and a little of its neck and chest) turns toward the player, the camera, or *what it sees* (its Senses), eased, and never further round than a neck turns |
| **Root motion** | A clip that moves the character (a lunge, a dodge, a dance) moves the object itself, or its body, instead of walking on the spot and snapping back |

The IK runs after the clips each frame and touches nothing else. A bone it
moves is put back before the next frame's clips, so it never builds up.

### One skeleton's clips on another

Skeletons are read as bodies. Each bone's place (hips, spine, chest, neck,
head, each shoulder, arm, forearm, hand, finger, thigh, shin, foot, toe) is
read from its name, whichever tool named it:

| Tool | Example names |
|---|---|
| Mixamo | `mixamorig:LeftUpLeg`, Sketchfab's `mixamorig7:LeftArm_03` |
| Blender | `UpperLeg.L`, `thigh.L`, `DEF-forearm.L` |
| 3ds Max | `Bip01 L Thigh` |
| Unreal | `thigh_l`, `calf_r` |

A clip from a file made for another skeleton is carried across part by part.
Each bone takes the turn the other skeleton's bone made from its own rest
pose, on top of its own rest pose, so a T-posed rig's clips move an A-posed
one. In the Robot's case, a Mixamo dance moves the built-in Robot's Blender
skeleton. The hips' travel stays the other rig's (it dances on the spot), and
each kind of skeleton works it out once for all its copies.

## Templates

**New** opens a chooser: start empty, or from a finished game to play and change.

| Template | What it is |
|---|---|
| **3D Platformer** | Two levels of floating platforms, a moving platform, coins, three lives (the water costs one) and a golden ring to the next level |
| **Top-Down Collector** | Collect 12 gems in 60 seconds while slimes chase you; three hits and it's over |
| **First-Person Explorer** | A ruined temple seen from your own eyes: pull the lever to open the door, find three relics, escape through the portal |
| **Car Racing** | Three laps of a walled circuit against three rival cars: a 3-2-1 start, checkpoint gates, positions, lap times and speed on screen, a follow camera, R back on the track. Finish first to win |
| **AK Arena** | A first-person shooter made from models: an AK74u in your hands (its own shoot and reload animations), 30 rounds a magazine and spare magazines to pick up, R to reload; four robots chase and punch — three bullets each, five punches and you are down |
| **Night Watch** | A stealth game: three robot guards with Enemy AI watch a walled yard at night, with lanterns. Old Tom by the gate talks you through it (a dialogue with choices) and gives you a sleep dart; *I* opens your bag (a screen), and using the dart puts a guard near you to sleep. Take the plans from the shed (into a list variable) and slip out by the exit. Keep behind crates and walk — they hear running. Ring the bell across the yard to draw them off. Seen, they chase and call the others; three punches and you're caught. On screen, how alarmed they are, read from their states |
| **Wild Valley** | An open world: a 400 m river valley in 16 chunks, a path painted up its east bank, pine forests on both slopes, broadleaf trees by the river, rocks, a meadow of grass and flowers — all scattered and kept off the path. Follow it north to find three standing stones |
| **Hollow House** | A short horror story in a small house at night: Gran's note, a key in the kitchen drawer, a bedroom door that swings open on its hinge, a vase that falls as you walk in. Take the music box and the lights die, something comes out of the kitchen after you — get out of the front door before she finds you |

Templates are built from exactly the pieces you have — made textures and
sounds, physics bodies, components, rules, controls, variables and levels — so
every part of them can be opened, changed and learnt from.
A template can use model files too (`assetUrl`, e.g. `assets/robot.glb`):
opening it brings them into the game as if imported with **+ GLB**, so it saves
and exports with them inside. AK Arena's AK74u is `assets/ak74u.glb`.

**When playing** (Camera panel) sets the camera the game plays with, separately
from the view you edit in — the Explorer is edited from above and played in
first person.

**Orbit zoom is free.** There's no closest and no farthest. Far out each scroll
moves by the same share of the distance; close in, it still moves a real step,
and when you reach the point it circles, that point goes on ahead of you. You
fly in and through, never stuck.

**Every camera can be turned and tilted.** Each tab of the Camera panel has a
**Turn** and a **Tilt** (degrees), applied live as you drag them; the mouse,
or a drag in the editor, still turns the view freely on top.

| Camera | Turn and Tilt |
|---|---|
| Orbit | go round, and over, the point it circles |
| Follow | go round the target (180 looks at its face, 90 from its side) and from higher up or lower down |
| First person, Fly | turn and tilt the view itself |

A model made facing backwards gets *Turn round the target: 180*, or a first
person view that starts facing a wall gets *Turn the view: 180*.

**Every camera is adjustable.** The Camera panel has a tab for each one, and
**👁 View through this camera** shows your changes live as you drag. Each camera
keeps its own **field of view** and **view distance** (how far it draws: 1000 m
unless you change it — more for a big open world, less to save work on phones).
Every setting saves with the game and applies in Play and in exports.

| Camera | Settings |
|---|---|
| **Orbit** | Distance; closest and farthest zoom; raise; pan speed; stay centred on the target |
| **Follow** (third person) | Distance, height and side (over the shoulder); aim height; look ahead; snappiness; zoom limits for the scroll wheel; **mouse turns the camera** (W then walks where the camera faces); swing behind as the target turns; keep out of walls; fixed height for top-down |
| **First person** | Eye height and eye forward (how far the view sits from the body); mouse speed; how far you can look up and down; invert; capture the mouse. How the view moves with the body, all off until set: **head bob** (with step length and side-to-side sway), **breathing** when standing, a **dip on landing**, a **lean when strafing**; **shake strength** |
| **Fly** | Speed; Shift speed-up; mouse speed; invert; capture the mouse |

**Looking with the mouse.** When the game's camera looks with the mouse (first
person, fly, or follow with *Mouse turns the camera*), pressing **Play**
captures the mouse straight away, as an exported game does on its first click.
**Esc** gives it back, and clicking the view takes it again. **The editor never
captures the cursor.** In a first-person or fly view you look around by
dragging with any mouse button, and a plain click still selects. A game that
turns with keys can switch **Capture the mouse to look around** off.

## Levels

A game is a list of levels — rooms, stages, a boss fight, an ending. The
**Levels** panel adds, opens, renames, reorders, duplicates and deletes them;
click a level to edit it. ★ marks where the game starts.

Each level has its own objects, lighting, camera and music. **Controls and
variables belong to the whole game**, so the score and lives carry from one
level to the next.

To move between them:

- the **Go to level** action, in a rule or a control — `next`, `previous`,
  `this` (restart the level), `first`, a level's name, or its number
- the **Level exit** component — a trigger zone (door, portal, finish flag) that
  sends the player on

Going `next` from the last level wins the game. **Play** starts from the level
you are editing, and **Stop** brings you back to it exactly as it was; an
exported game starts at the ★ level and carries every level. Save, autosave
and export all keep every level, and a scene saved before levels existed opens
as a one-level game.

## Materials and textures

Materials follow the glTF 2.0 **PBR metallic-roughness** model — the same one
Unity, Unreal and Godot use — so textures from any texture site work as-is.

| Slot | What it does |
|---|---|
| **Base colour** | The surface colour (sRGB). The colour picker becomes a *tint* |
| **Normal** | Bumps that catch the light, with a strength and a *DirectX style* (flip green) switch |
| **Roughness** · **Metalness** | Matte vs shiny, metal vs not — the sliders become multipliers |
| **Ambient occlusion** | Darkens cracks, with a strength |
| **Packed ORM** | One image with AO / roughness / metalness in red / green / blue (Poly Haven "ARM") |
| **Glow** | Emissive — glowing screens, lava, neon; colour and strength under Surface |
| **Opacity mask** | See-through parts; Transparency **Cutout** (leaves, fences) or **Blend** (glass) |

**Load set…** takes a whole texture set at once and puts each image in its slot
by file name (`_diff`, `_nor_gl`, `_NormalDX`, `_rough`, `_ao`, `_arm`, `T_Crate_N`…).
Images are resized on import to power-of-two sides, 2048 at most by default, so
they mipmap cleanly and don't bloat a scene or an exported game.

**A material from a model.** Every Load also takes a **.glb** or a **.gltf**,
and you can drop one (or its whole folder) straight onto the Color & Texture
panel. A `.gltf` needs only its pictures here, not its `.bin`. When they're in a
`textures/` folder beside it, as in a Poly Haven download, the panel offers
**Choose its folder…** and finds them inside. Material packs from Poly Haven,
ambientCG, Sketchfab, Blender or Substance come this way.
- **Load set…** (or a drop) takes the model's whole material: every picture —
  colour, normal, roughness / metalness or packed ORM, AO, glow — and its
  colour, metal, roughness, glow strength, normal and AO strength, see-through
  mode, tiling and pixelated or smooth look. The object becomes that material;
  nothing is left over from before. One undo step.
- A slot's own **Load** takes just that picture (a model's normal map into
  Normal, say).
- A model with several materials lists them, each with its colour picture as a
  thumbnail, to pick one.
- The pictures are the file's own, not redrawn. **KTX2 / Basis** pictures, the
  GPU format that optimised models (gltfpack, glTF-Transform, Sketchfab
  "optimised") use, are turned into ordinary PNGs. Tiling that only unpacks a
  compressed model's UVs isn't copied, since on a box it would show one pixel.

**Placement:** tiling, offset and rotation; edges repeat, mirror or stretch;
**Smooth** (mipmapped, anisotropic) or **Pixelated** for pixel art. **Tile by
size** repeats the texture by real size, so scaling a wall adds bricks instead of
stretching them.

**Texture maker** — no image needed: Checker, Grid, Bricks, Wood planks, Tiles,
Noise and Gradient, each seamless and with a matching normal map, tuned with
colours, count, gap, variation, bumps and resolution (64–1024 px; 64 or 128 for
pixel art). Only the settings are saved.

**Material library:** **Save to library…** names a material; any other object
can then use it, and editing it changes them all. **Make unique** gives an object
its own copy again.

## Sound

Every sound has a **name**, and that's how the rest of the game uses it: a rule
*Play sound "coin"*, a Collectible's *Sound*, a Damager's *Hit sound*, a Jump
control's *Sound*. Type the name, or pick it from the suggestions.

**Sound maker.** No files needed — choose one from **Add** in the Audio panel:

| Effects | Ambience loops |
|---|---|
| Jump · Coin · Shoot · Hit · Explosion · Power-up · Click · Footstep | Wind · Rain · Hum |

**🎲 Vary** makes the same kind of sound a little different; **Tweak** opens
wave, pitch, slide, length, brightness and wobble. A made sound is saved as a
few numbers, not audio, so it costs almost nothing in a scene or export. Your
own audio files still work — **Add → Audio file…**.

**Per sound:** heard *from its object* (quieter with distance) or *everywhere*;
a **channel** (effects, music, ambience); volume; **vary pitch** so repeats
don't sound robotic; **overlap** so rapid shots layer instead of cutting each
other off; loop; and **On start** to begin when Play starts (never while you
edit).

**Scene music & ambience** belong to the scene, not to an object. *Play music*
fades the current track out and the new one in; *Stop music* fades out.

**Space:** the room the game sounds like — **Small room**, **Hall**, **Cave**
or **Cathedral**, with how much echo you want. A footstep in a cave rings on
after it ends; outdoors (the default, **None**) it stops dead. Sound effects
and ambience are heard through it; music keeps the space it was made with. The
echo is generated, so it adds nothing to a scene or an export. The
First-Person Explorer template uses **Hall** for its stone temple.

**Mixer:** master, music, effects and ambience volumes are saved with the
scene, with a limiter so a burst of sounds gets louder rather than distorted.
Exported games get a 🔊 mute button.

## Prefabs

A prefab is an object you reuse: a coin, a crate, an enemy. Select an object
and press **💾 Prefab**. Then click the prefab in the Asset Browser to place
copies. Spawners, **Spawn prefab** rules and **Shoot** controls use prefabs too,
including in exported games.

**Copies stay linked.** To change them all, change any one copy and press
**Apply to all** in the Inspector. Every copy, in every level, updates.

**A copy can still be different.** Anything you change on one copy is kept when
the prefab changes. The Inspector lists those changes:
- **Apply** gives one change to every copy.
- **Revert** throws it away.
- **Unlink** turns the copy into an ordinary object.

Where a copy stands, which way it faces and its name always belong to the copy.

**Child objects come along.** A car saved with its wheels (children in the
Hierarchy) places, spawns and duplicates with them. Change a wheel on one copy,
then select the car and **Apply to all**: every car's wheel changes. Something
you hang on one copy by hand stays that copy's own.

**Renaming is safe.** Rules, components, controls and prefabs that name an
object follow it when it's renamed, in the same undo step.

Prefabs are saved with the game file, and every level shares them. Deleting a
prefab leaves its copies in place as ordinary objects. **Apply to all** can be
undone.

## Physics

Give an object a body in the Inspector: **static** (floors and walls),
**kinematic** (moved by animation or rules; carries whatever stands on it) or
**dynamic** (falls, gets pushed). A **trigger** detects overlaps without blocking.

- **Real shapes.** Choose a body's **Shape**:
  - **Auto** gives a ball a sphere and everything else a box.
  - **Box**
  - **Sphere**
  - **Capsule**, a rounded pill that slides over small ledges, good for characters.
  - **Mesh**, the model's real triangles: walk into a house through its door,
    over a hilly terrain, up its stairs. The camera stays inside its rooms too.
    It's for static and kinematic bodies; a dynamic body with this shape uses a
    box. A body added to an imported model starts as Mesh.

  A rotated floor, wall or plank collides where it really is, so tilt a box and
  you have a ramp.
- **Solid (blocks player)** in the Inspector is the quick way: a static body,
  the model's real shape for a model. The red outline shows where a box-shaped
  body blocks.
- **The player falls and collides only with a Dynamic body.** A body added to the
  player starts as a Dynamic capsule. If the player's body is Static or
  Kinematic, Play says so and offers to fix it.
- **Play → Stop puts everything back**, the stand-in player too (the one used
  when no object is chosen as the player).
- **Slopes.**
  - Up to about 45°, a slope is solid ground: bodies stand still on it and walk
    up it at full speed.
  - Up to 60°, it still counts as ground for jumping, and slows the climb.
    Running up one no longer throws you into the air at the top.
  - Steeper slopes make bodies slide off. A character's **Steepest slope**
    (Movement feel) sets this for it: 30° for a heavy robot, 75° for a goat.
- **Rough ground** (a model's terrain, rocks, ruins): walking keeps you on the
  ground over mounds, crests, ledges and into pits, even at speed, instead of
  flying off each bump. The distance to the ground is measured exactly, where
  it used to be misjudged on edges and crests.
- **Steps and stairs.** A character (a capsule body) steps up onto ledges,
  kerbs, stairs and rocks up to 0.45 m high. It doesn't step up a taller wall,
  under a low ceiling, or when a crate (a box body) is pushed into a step. The
  player is a capsule by default: the stand-in player, the templates' players,
  and a body the controls give it.
- **Soft steps.** A sudden rise or drop while walking, such as a stair, a
  rock or a kerb, is drawn eased over about a tenth of a second, the camera
  included. The physics stays exact; only what you see glides.
- **Moving platforms.** Anything standing on a kinematic body moves with it.
- **Same at any frame rate.** Physics steps in fixed 1/60 s slices, so a jump is
  the same height on a 30 Hz laptop and a 144 Hz monitor. Drawing is smoothed
  between slices.
- **Raycasts** (`engine.physics.raycast`) hit tilted faces with the right normal,
  and a ray landing exactly on a box's edge gets the face it came through. They
  go through trigger zones, which block nothing, unless you pass
  `{ triggers: true }`.
- **Passes through** (collision layers). A body can pass through the player,
  any group, or particular objects, as if neither were there: no bumping, no
  pushing, no standing on it. A trigger passing through something isn't set
  off by it either. Set on either one of the two, it works both ways. For
  example, a ghost through walls, your own team's bullets through you, or a
  curtain only the player walks through.
- **Tumbles** (dynamic bodies, not the player). Tick it and the body turns as
  well as moves: a crate dropped on its corner topples onto a face, one pushed
  over a ledge tips off once its middle passes the edge, a tall one hit high up
  falls over, barrels and balls roll down slopes and roll to a stop, a stack can
  be knocked down — and a stack left alone stands still. Friction decides
  whether a box on a slope stays or slides. Characters are left upright.
- **Gravity ×** per body: 1 as usual, 0 floats (a ghost, a balloon), 0.3 a moon
  jump, 2 heavy.
- **Moving bodies push each other by weight.** A heavy hero shoves a light
  crate along; a body standing on another one counts as on the ground, so it
  can jump off it. A character's **Push strength** (Movement feel) is the most
  it shoves with, × its own weight: a heavy crate barely moves for a weak
  push, and at 0 it can't push anything.
- **Many bodies.** Only bodies near each other are tested together, so a level
  with hundreds of moving things stays quick. `npm run bench` measures it on
  your machine:

  | Scene | ms per step (one machine) |
  |---|---|
  | 100 / 300 / 1000 tumbling crates | 1.5 / 4.3 / 17 |
  | 100 / 500 characters among 500 still objects | 0.9 / 2.1 |
  | one raycast among 600 / 1000 bodies | 0.03 / 0.05 |
- **A model's parts, each its own physics.** Under Physics, a model lists its
  parts (its meshes), and each is one of:
  - **In its body:** part of its own collider (the default).
  - **Left out:** not solid at all.
  - **Own box:** a solid box of its own round just that part.
  - **Trigger zone:** entered, not bumped into.

  A field model, for example: its ground and rocks stay in its body (with
  *Mesh*, its real shape), its grass is left out (walked through), and its pond
  is a zone. **Find** narrows a long list ("grass"), and **All shown** gives
  every part it shows one choice. An archway's pillars and top as own boxes
  let you walk through the middle, where one box round it all was a wall. The
  view outlines each part with a role of its own while it's selected.

  What touches a part touches the model: its rules' *Something enters me*,
  *leaves me*, *I bump into something* and *Something hits me* can say **At part** ("Pond water"),
  and a ray that hits it says which part.
- **Wheels built in the editor.** A car built from a stretched box with
  cylinder tyres as its children keeps round wheels as they spin and steer.
- **Fast things don't go through thin ones** (continuous collision). A body
  that moves farther than its own size in one step is traced along the way it
  went, so a bullet at 240 m/s stops at an 8 cm pane of glass. It's hit, pushed
  back and heard of (collision, shot) as usual. A thin trigger it goes right
  through, like a finish line, still fires *enters* and *leaves*. A tumbling
  body (a thrown crate, a car, a ragdoll's limb) is traced the same way.

### Joints

Add a **Joint** to a dynamic body to hold it to another (**To**: an object's
name) or to a point in the world (To left empty):

| Kind | What it does | For |
|---|---|---|
| **Hinge** | Turns about one axis only (its X, Y or Z), between *Turns from* and *Turns to* (°) | A door, a gate, a lever, a drawbridge |
| **Ball** | Turns any way about its anchor, swinging at most *Swings at most* (°) from how it began | A pendulum, a chain's links, a lamp on a cord |
| **Fixed** | Held as it was: welded | A crate glued to a cart, a breakable shelf |
| **Rope** | No further apart than its *Length*; slack when closer | A hanging sign, a tethered ball |
| **Spring** | Pulled back to its *Length*, springy (*Stiffness*, *Damping*) | A bouncing lamp, a tow, a punching bag |

- **Anchor X/Y/Z** is where they're joined, in metres from the body's middle,
  along its own axes: a door 1 m wide hinged on its left edge has Anchor X −0.5.
- **Breaks at (N)**: pulled harder than this, it comes apart (0: never). Its
  rules' **A joint breaks** is set off then, with the object it was joined to
  as *the other*. A rope holding 50 kg breaks at less than about 1200 N.
- Two joined bodies pass through each other unless *The two still collide*.
- A hinge, ball or fixed joint makes its body **Tumble** (it has to turn).
- Joints are solved together, all three ways at once, so a chain of links or a
  long pendulum holds its length as it swings rather than stretching.

### Ragdolls

A character can **go limp**: its clips stop, and its body becomes a set of
capsules (hips, chest, head, upper and lower arms, thighs and shins), joined
where its bones meet, each swinging only as far as a body bends. They fall,
tumble down steps, drape over railings and come to rest, and its skeleton
follows them every frame.

- Health's **When it runs out → go limp**: it falls the way the hit came (away
  from what hurt it). It stays in the level, limp.
- The rule action **Go limp (ragdoll)**, with **Flung (m/s)** away from what set
  the rule off: a blast throws the guards near it.
- In a script: `act('ragdoll', { push: 3 })` (this object), or `act('ragdoll', { target: 'Guard' })`.
- Any rigged model with humanoid bone names works (Mixamo, Blender, 3ds Max,
  Unreal — see *One skeleton's clips on another*). A model with no skeleton
  just tumbles over as itself.
- Stopping play stands everyone back up.

### Characters: crouching, slopes, pushing

- The **Crouch** control (Movement): held, or pressed on and off. The body is
  lower (*Height* × standing, from its feet), so it fits under pipes and
  through vents, and slower (*Speed ×*). A first-person view lowers with it,
  eased. It stands up again only where there's room over its head: let go
  under a low beam and it stays down until it's out from under. *Clip while
  crouched* plays a crouch walk.
- **Steepest slope** and **Push strength**: see above, both in Movement feel.

## Making a game without code

Four pieces work together, all edited from panels — no JavaScript required.

### Controls

Nothing about input is hardcoded. The **Controls** panel is a list of controls;
**+ Add control** makes a new one. Each control is:

- **Input** — one or more of: a keyboard key or a **gamepad** button or stick
  (click the chip, then press it), a mouse button, or an **on-screen button** for
  phones and tablets
- **Do** — what happens
- **Who** — the player, or any object by name

**Gamepads** (standard layout, Xbox names) work wherever a key does: in
controls, in *Key pressed* rules, and as `keys.PadA` in scripts. A stick tilted
part way walks slowly. The right stick looks around in first person and turns a
mouse-driven follow camera. New games already take a pad: left stick and D-pad
move, **A** jumps. On a touch screen the move controls become a thumb
**joystick**; *Game → Touch screens* switches back to ▲ ▼ ◀ ▶ buttons.

A field that asks who something applies to (what a shot **Can hit**, who a
**Damager** hurts, who sets off a rule) is a list: **Anything**, **The player**,
any **group**, or one object.

**Only if…** Any control can have conditions. Pressed while they don't hold, it
does nothing, as if it weren't pressed. A move control still brakes. Examples:
- **W** walks only while **Shift** is held (a key combination).
- **F** fires only with **ammo > 0**, **not** while **stunned**, and **not
  more often than every 0.5 s**.
- **Space** jumps when **on the ground**, **or** with a double-jump token.
- **Space** dashes while **on the ground** **and not** stunned, **or not** in
  first person.
- **E** opens only **near the door**, and its "E  Open" prompt shows only when it
  would work.

Controls can **Rotate** and **Scale** too (under *Movement*). A rotation per
second, or a scale times per second, keeps going while the input is held.
Otherwise it happens once per press.

**+ Do: more than one thing, joined by AND, THEN or OR.** Under a control's own
Do, **+ Do** adds another. It can be any rule action (play a sound, show a
message, spawn, rotate, save the game…), each with its own **Only if**. In
front of each is how it follows the ones before:
- **AND:** at the same moment.
- **THEN:** after a wait (*After (s)*). THENs add up, so you can chain a sequence.
- **OR:** otherwise. It's tried only if nothing before it happened, its own
  Only if then deciding (like *else if*); with none, it's a plain *else*.

A group (a Do and the ANDs and THENs after it) happens when its first Do does,
and the next OR starts another group. For example:

*E → open the door (only if you have the key) **AND** play the creak **THEN**
show "Opened" · **OR** show "Locked"*.

A Do that acts every frame (Move, a turn per second) acts while the input is
held; the others act once per press.

**If yes, do · If not, do.** Every **Only if** — the control's own and each
further Do's — has its own Do's once it has a condition: **+ If yes, do** adds
something to do when it holds, **+ If not, do** something to do when it
doesn't, each any rule action, at once or *After (s)*. One control can then
say it all:

*Click → shoot, **only if** ammo > 0 · **if yes, do** ammo − 1, play the shot ·
**if not, do** show "Out of ammo", play a click.*

Which of them happen is decided at the press, as things stand, and they are
done after the control's own Do — so the last round, taken by *ammo − 1*,
still fires.

The conditions are the rules' own (below), joined the same way (see **And, or,
not**).

| Do | What it does |
|---|---|
| **Move** | While held: forward / back / left / right, relative to the world, the camera, or the object itself; optionally turns to face the way it goes |
| **Sprint** | While held and moving: the target's Move speed × *Speed ×* (1.8 unless you change it). Bind it to any input — Shift, a mouse button, an on-screen button. An Animator switches to its running clip once the pace passes its *Run from* speed, and head bob keeps step. *Widen view* opens the field of view by that many degrees while sprinting (0 = off). A new scene has no sprint: add one if your game wants it |
| **Turn** | While held: spin left or right (with Move relative to *self*, that's tank controls) |
| **Jump** | When standing on something; plays sounds set to the Jump trigger. How forgiving it is — just after running off an edge, pressed just before landing, double jumps, lower jumps when let go early — is the **Movement feel** component |
| **Interact** | Runs the *Someone interacts with me* rules of the nearest object in range — or the one under the pointer — and shows its prompt ("E  Open door") when you're close |
| **Aim** | Aim down the sights, or over the shoulder — see [Aiming and shooting](#aiming-and-shooting) |
| **Shoot prefab** | Spawns a prefab and launches it: the way the shooter faces, where the camera aims (up and down too), or towards the mouse pointer. *Shots per second* above 0 keeps firing while held. *Counts as* a shot (a bullet, an arrow) or something thrown (a ball, a grenade) to what it hits |
| **Shoot (instant hit)** | A bullet that hits at once: damage, a push, an impact prefab, and the target's *I'm shot* rules. Picks what it *Can hit* and how far it reaches |
| **Hit / attack (melee)** | A punch, a sword, a kick: hits what is in front within *Reach* and *Wide* degrees (in first person, where you look), or what the pointer is on (a click, a tap). The nearest one, or every one in reach. Damage, a knock back, a sound, and the target's *Something hits me (with an attack)* rules. Also a rule action |
| **Recoil** | Kicks the view up (and a little sideways) and a held gun back, then settles. Put it on the same input as a shot. Also a rule action |
| **Play animation** / **Stop animation** | Plays one of the target's clips once, looped, while the input is held, or *while held, once* — plays through and stays on its last frame (see [Animated models](#animated-models)) |
| **Shake camera** | Shakes the view (strength, how long): a shot, a hit, an explosion. Each camera's *Shake strength* scales it, and 0 turns shaking off. Also a rule action |
| Set / change variable · Play sound · Spawn · Show or hide · Destroy · Damage · Win · Lose · Restart · Log | The same actions as rules, once per press |

A new scene starts with WASD / arrow keys to move, Space to jump, and an
on-screen D-pad. On-screen buttons appear in Play mode and in exported games:
move buttons form a D-pad at bottom-left, the rest are round buttons at
bottom-right. Scenes saved before controls existed have their old key map
turned into controls when they load.

### Aiming and shooting

Nothing aims or shoots until a game adds the controls for it — say the right
mouse button to **Aim** and the left to shoot.

**Aim** (while held, or *press on/off*):
- zooms in (*Zoom in*), slows the mouse (*Mouse speed ×*) and the walk
  (*Move speed ×*), over *Takes (s)*;
- first person: a gun held in view moves to its **aiming place**. Set it in
  the Inspector: **Held in view → Aiming**, the same sliders, shown in the
  preview. Rigged arms stay where they are and aim with their own clip;
- third person: the follow camera moves in (*Follow camera distance ×*) and
  over the shoulder, and the player turns to face where it aims;
- *Crosshair while aiming: hide* for sights; sprinting stops unless *Can
  sprint while aiming*; *Animation* plays a clip (raising the gun) and holds
  its last frame until you stop aiming.

You can fire while aiming. A shot's clip plays on top of the aiming pose, so
the gun stays up.

**Shoot (instant hit)** decides what it hits:
- **Aim with**: the *camera* (the middle of the screen, where a crosshair
  is), the *pointer* (whatever the mouse is on — or the last tap — within
  range), or the way the shooter *faces*.
- **Range**: how far it reaches.
- **Can hit**: anything, the player, a **group**, or one object. Anything
  else in the way stops the shot like a wall, unless **Goes through everything
  else** is ticked.
- **Also hits within (m)**: a blast. What it can hit that close to where the
  shot lands is hit too.
- **Damage**, **Push**, an **Impact** prefab (sparks, a mark) and a **Sound**.

**What a hit does** is up to the target:
- **Health → When it runs out**: *destroy*, *hide* (out of sight and out of the
  way), or *nothing*; **After (s)** waits first, for a falling-over clip.
- Rules on the target: *When* **I'm shot**, **I'm hurt** or **My health runs
  out**, *if* **My health is** `<= 5`…, *do* anything — **Play animation**
  (its own clips), **Move object** (by an offset, to a spot, or to another
  object, straight there or sliding), **Show / hide**, **Destroy** (optionally
  after a few seconds), spawn an explosion, add to the score.

### Groups

Give objects **Groups** in the Inspector (under *Parent*): `Enemies`,
`Targets`, several split by commas. A prefab's groups go with every copy,
spawned ones too. Then a shot, a Damager or a rule can pick the whole group
instead of one object.

A rule's **Which** is picked from a list (me, the player, what set it off,
groups and objects), not typed:
- **A group**, or a name several objects share, means **all of them**:
  *Destroy every Coins*, *Hide Crate (all 3)*. The list says how many.
- Where only one object makes sense (*Move object to*, *Face towards*, a
  *Pivot object*), it's **the nearest** one.
- New shapes and models get their own names (Box, Box 2, …), so they can be
  told apart. Renaming an object updates every rule, control, component and
  *Passes through* that names it.

### Components

Named behaviours you attach to an object from the inspector. Each has typed
fields, so there is nothing to look up.

| Component | What it does |
|---|---|
| **Rotator** | Spins continuously |
| **Mover** | Slides back and forth — moving platforms |
| **Follower** | Chases another object — enemies, pets. It finds its way round walls, through doorways and up ramps (see [Finding the way](#finding-the-way)) |
| **Vehicle** | Makes an object a car, kart, truck or buggy that drives like one — see [Driving](#driving) |
| **Race** | On a start / finish line: laps round checkpoints, a countdown, positions, lap times, cars the player isn't driving racing too — see [Racing](#racing) |
| **Patrol** | Walks from point to point and round again (or back and forth), waiting at each if you like — guards, animals, a moving hazard. The points are ordinary objects: a group, in name order, or names split by commas |
| **Movement feel** | How a character moves under its controls: how quickly it gets going and stops, steering in the air, jumping just after leaving an edge or pressed just before landing, jumps in the air, lower jumps when the key is let go early, fastest fall. Over rough ground: **Steps up onto** (0.45 m), **Soften steps and bumps**, **Tilt with the ground** (0 keeps people upright; 1 for cars, boards and animals, which ride over bumps nose-up then nose-down) and **Hover height** (hovercraft, drones and flyers held that high over hills and pits; with Gravity × 0 it flies). Without it, it moves as before |
| **Health** | Hit points, optionally mirrored into a variable. When they run out: destroy, hide, or nothing — after a delay if you like |
| **Damager** | Hurts what touches it — anything, the player, a group or one object — with a cooldown. On a bullet prefab, it is what the bullet does |
| **Collectible** | Adds to a variable and disappears on touch |
| **Spawner** | Creates prefab copies on a timer |
| **Timer** | Counts a variable up or down |
| **Senses (sees and hears)** | What it notices — see [Enemies that see and hear](#enemies-that-see-and-hear) |
| **Enemy AI** | Guards, monsters, soldiers: patrol or stand guard, chase, attack, search, call the others, take cover — see [Enemies that see and hear](#enemies-that-see-and-hear) |
| **Level exit** | Touching it goes to another level |
| **Animator** | Animates a character as it moves: the clips you pick for standing, walking, running and in the air, or bob / lean / squash for shapes |

### Driving

Add the **Vehicle** component to a car model, make the car the player, and use
the **Follow** camera (with *Swing behind as the target turns*). It drives with
the controls you already have: **Move forward** is the throttle, **back** brakes
and then reverses, **left / right** steer (a stick or trigger part way: part
throttle, part steering), and **Jump** held is the handbrake.

- **It is a real car, not a sliding box.** The body turns every way, held up by a
  spring and damper at each wheel. The tyres grip sideways up to a limit and
  past it they slide, which is how it drifts. So it leans in corners, dips its
  nose when braking, squats as it pulls away, flies off ramps and lands, and
  rides over rough ground, without any of that being scripted.
- **Its wheels are found in the model by name:** *wheel*, *tire*, *tyre* or
  *rim* (not a steering wheel or a spare), and a tyre and its rim spin as one.
  They spin with the speed, the front ones steer, and they move with the
  suspension. A model without wheel parts, or a plain box, gets four at its
  corners that aren't drawn. **Front of the model** says which way the car
  faces if it wasn't made facing +Z.
- **Settings in plain words:** top speed (km/h), 0–100 km/h time, reverse speed,
  stopping time from 100, steering angle and how much of it is left at top
  speed, grip (1 road, less for ice or dirt, more for slicks), rear grip on the
  handbrake, driven wheels, suspension travel and firmness, how flat it stays in
  corners, how much it levels itself in the air, and whether it rights itself
  after landing on its side or roof.
- **Driven wheels:** *all* is the easiest to drive and reaches quick 0–100
  times; *rear* can swing its tail out (drifting); *front* understeers.
  Traction control and ABS keep a little grip back for turning, so flooring it
  doesn't spin the car out; the handbrake isn't held back.
- **It parks itself:** with no throttle at a walking pace it holds still, on a
  slope too.
- **Computer-driven cars:** give a car a **Patrol** (waypoints round a track) or
  a **Follower**, and it drives there with its own steering and pedals.
- **Getting in and out.** The player walks up to a car and sees **E  Drive**;
  E (or a gamepad's Y, or a tap on the prompt) gets in: the person is hidden
  inside, and the car becomes the player, with the camera following it. E
  again, below 30 km/h, gets out beside the driver's door (or the other door if
  a wall is there), leaving the car parked. The key is a setting (E, F, G, Q,
  Enter, or none).
- **Its own sound, no files needed.** The engine note is made as it drives. It
  follows the revs through five gears (they drop at each change), is brighter
  and louder on the throttle, and revs freely in the air. It's heard from where
  the car is. A car nobody drives is switched off. The tyres screech when they
  slide, and a crash thumps and clanks as hard as the hit. The volumes are
  settings, on the Effects channel. A paused game falls silent.
- **Skid marks** are laid where the tyres slide: drifts, handbrake turns, hard
  stops. They're drawn only, and cleared on Stop.
- **Crashes** shake the view (the player's car; how hard is a setting) and run
  the car's **I crash** rules. They say what it hit and only fire for crashes
  harder than the speed you set: lose health, a life, points, or the race.
- **Speed you can feel:** the view widens with the speed (**Wider view at
  speed**, 10° by default).
- **Buttons and hints speak car:** while you drive, the touch **Jump** button
  says **Brake**, and an exported game's help line reads *W throttle · S brake /
  reverse · A/D steer · Space handbrake*.
- **A speedometer:** the player's car writes its speed (km/h) into the variable
  `speed`, and the HUD shows it. The variable's name is a setting; leave it empty
  for none.

### Racing

Put the **Race** component on the start / finish line: a gate, a painted strip,
or an empty marker. Put the checkpoints (gates, cones, empty markers) in a group
called **Checkpoints**, named in order round the track (*Checkpoint 1*,
*Checkpoint 2*…). A checkpoint is reached by driving into its box (a little
bigger than it), or within 8 m of an empty marker, so they need no bodies and
cars drive straight through them. That's the whole setup: every car (Vehicle)
in the scene races.

- **3, 2, 1, GO!** Every car is held on the line, with a beep for each second.
- **Laps and checkpoints in order.** Skipping one doesn't count, and the line
  after the last checkpoint is a lap. Messages say *Lap 2 / 3*, *Final lap!*
  and your best lap.
- **Positions** go by laps, checkpoints, and how far along the way to the next.
- **Your race is in variables** the HUD shows and rules can use: `lap`,
  `position`, `raceTime` and `bestLap` (seconds).
- **The finish:** *You finished 2nd! 1:23.4*. Finishing in the top places
  (a setting; 0 = any) wins the game, otherwise it's lost.
- **The other cars race too**, driven by the race: at each checkpoint in turn,
  turning in early towards the next, braking in time for the corners. **Other
  cars' speed** (a % of their top speed) is their skill, and **Keep it close**
  has them ease off when far ahead and push when behind. A car that gets stuck
  is put back on the track.
- **R** (a setting) puts your car back at its last checkpoint, facing the next.
- **An arrow** floats over your next checkpoint.
- Laps, countdown, which cars race (every car, or a group), messages and the
  arrow are all settings.

### Finding the way

Followers and patrols don't walk straight into walls. The engine measures the
level's still, solid bodies (boxes, meshes, tilted ramps) into a walking grid for
each size of walker, and finds a path over it: round walls, through doorways,
up ramps and steps it can climb (0.45 m), down drops it can take (3 m). Nothing to
set up. A door that opens (a kinematic body moving) is noticed and the way is
measured again. *Find a way round walls* can be switched off to walk straight.

### Enemies that see and hear

Two components, no code:

**Senses** — what an object notices.

| Setting | What it does |
|---|---|
| **Looks for** | the player, a group, or one object |
| **Sees as far as** · **Field of view** | a cone in front of it (120° by default). It looks at the head and the middle of what it looks for, and never sees through anything solid: a wall, a crate, a closed door |
| **Notices within** | right beside it, it notices you whichever way it faces |
| **Hears noises** | shots, an alert, a *Make a noise* action — each heard as far as it is loud |
| **Hears footsteps** | of what it looks for: *when running* (faster than 4 m/s), *when moving*, or *never*, within *Footsteps within* |
| **Remembers for** | how long it still knows where it last saw or heard someone |

Its rules: **When** *I see someone*, *I lose sight of someone*, *I hear
something* (anything, footsteps, a shot, an alert, a hit, a noise; made by
whom). **If** *I can see* (who) and *I heard something* (in the last N s). Hurt
by someone it can't see, it knows where the hit came from.

Selected in the editor, an object with Senses shows its view in the scene: the
cone at its eyes, a yellow ring for what it notices any way it faces, a purple
ring for the footsteps it hears.

**Enemy AI** — a state machine that acts on what it senses. Without Senses it
has the usual ones (15 m, 120°, footsteps when running within 8 m).

| State | What it does |
|---|---|
| **patrolling** | walks its points (a group, in name order, or names), waiting at each |
| **guarding** | no points: stands at its post, facing where it faced |
| **chasing** | runs at who it sees, finding its way round walls |
| **attacking** | within reach: *hits* (a melee attack: "Something hits me — with an attack") or *shoots* (a share of its shots hit, by *Shots that hit*; each one heard), every so often, with an animation and a sound if you like. *Nothing* leaves it to your rules |
| **searching** | lost them: it goes where it last saw them, or to what it heard, looks about for *Searches for* seconds, then goes back |
| **taking cover** | hurt below *Takes cover below health*, it runs to the nearest point of its cover group that the threat can't see, and stays a while |

- **Calling the others.** Seeing someone first, it calls the others within
  *Calls others within*. They come to look where it saw them.
- **Its state is the object's state.** *I enter a state: chasing* plays an
  alarm, *State is* asks about one guard or any of a group (the Night Watch
  shows "Unaware / Searching… / SEEN!" that way).
- **A rule can take it over.** *Set state* to anything else — `stunned`,
  `talking`, `asleep` — and it stands still until a rule sets one of its own
  states again (*Wait 2*, *Set state: guarding*).
- **Noises.** *Make a noise* (a rule) at an object: a bell, a thrown bottle, a
  slammed door — heard by Senses within *Heard within*. Shots from the
  Controls are heard too: *Heard within* on *Shoot (instant hit)* (30 m) and
  *Shoot prefab* (25 m). Set it to 0 for a silencer, or for a thrown stone.
- It turns at 300°/s rather than snapping round: heard from behind, it turns to
  look, and only then sees you.

### Variables

Named game state, edited in the **Game** panel with a starting value. They show
live in the HUD during play and go back to their starting values when you stop.
Each one holds one **type** of value:

| Type | Holds | Starting value typed as | For |
|---|---|---|---|
| **Number** | 5, −2.5 | a number | score, lives, ammo |
| **Text** | `Gran` | plain text | a name, who is talking, a dialogue line |
| **Yes / no** | yes or no | a menu | a door opened, a switch on |
| **List** | items in order | `["torch", "bread"]` (`[]` for none) | an inventory, the keys found, a quest log |
| **Record** | named fields | `{stage: 1, giver: "Gran"}` | a quest, a character's stats, a save slot |

Changing the type keeps what it can: `5` becomes the text `"5"`, then the list
`["5"]`. A list or record that doesn't read is said, and nothing changes. The
HUD shows text as it is, a list as its items (`torch, bread`) and a record as its
fields (`stage: 1, giver: Gran`). A bar or hearts are for numbers only.

#### Values and expressions

Wherever a rule takes a value (*Set variable*, *Variable becomes*, *Add to a
list*…), it reads as:

- a number, `true` / `false`, a list `[1, "a"]`, or a record `{a: 1}`;
- text, with `{an expression}` worked out inside it: `Coins: {coins}`,
  `{giver}: you have {len(inventory)} things`;
- `=` and an expression: `=score + 10`, `=quest.stage + 1`, `=len(inventory)`.

**Show message** works out `{…}` in its text the same way.

An expression uses the variables by name: `score * 2 > best`, `quest.stage`,
`inventory[0]` (`inventory[-1]` is the last), `quest["title"]`. It has
`+ - * / %`, comparisons (`=` and `==` both mean *is*), `and or not` (also
`&& || !`), `a ? b : c`, list `[…]` and record `{…}` literals, and these
functions:

`min max abs round floor ceil sqrt pow clamp random randint` ·
`len contains indexOf count join first last keys has` ·
`upper lower text number`

`+` joins text and lists. A name that isn't a variable is 0, and dividing by 0
gives 0, so a game value is never *Infinity*. It runs no JavaScript and reaches
nothing outside the game's variables. A broken expression stops only its own
rule and says why in the console, and the other rules carry on.

### Rules

**When** something happens, **if** its conditions hold, **do** these things,
**else** those.

| When | If | Do |
|---|---|---|
| Play starts · Every N seconds (0: every frame) · **I receive an event** · **I enter a state** · **I see someone** · **I lose sight of someone** · **I hear something** · **A button is pressed** · **An item is picked** · **A dialogue ends** · Key / pad button pressed, held or released · Mouse button pressed, held or released · **I'm clicked / tapped** · Something enters/leaves me · I bump into something · **Something hits me** (*With* a shot, something thrown, a vehicle, an attack, or a moving object; *What* hit me and who it was *Done by*; harder than N m/s; from above / below / the front / behind / a side; its speed into a variable) · Someone interacts with me · Variable becomes · I'm shot · I'm hurt · I crash (a vehicle, harder than N km/h) · My health runs out | Variable is (any value, or an expression) · **Expression is true** · **List contains** · **State is** · **I can see** · **I heard something** · **A screen is up** · **A dialogue is under way** · My health is · Key / pad button held · Mouse button held · Is on the ground · Is moving faster than · Is near · Is touching · Is shown · Exists (any left) · How many there are · Random chance · Not more often than every N s · The player is driving · The camera is · Play has run for | Set / change a variable · **Add to a list** · **Remove from a list** · **Set a field of a record** · **Wait** · **Send event** · **Set state** · **Make a noise** · **Show / hide a screen** · **Start a dialogue** · **Move** (while it runs) · **Push / launch** · **Jump** · **Turn** · **Rotate** · **Scale** · **Face towards** · **Stop moving** · Destroy (now or after N s) · Move object · Spawn · Show or hide · Play / stop animation · Play / stop sound · Play / stop music · Shake camera · Recoil · Show message · Damage · Win · Lose · Restart game · Go to level · Log |

- **And, or, not.** In front of each condition is how it joins the ones before
  it: **AND**, **OR**, **AND NOT** or **OR NOT**. The first has **IF** or
  **IF NOT**. *NOT* turns that one condition round: *not* on the ground, *not*
  driving, *not* near the guard.
  - **AND comes before OR**, as in most programming languages. *A AND B OR C*
    means *(A and B) or C*, and *A OR B AND C* means *A or (B and C)*. Each OR
    starts a new group, drawn with a dashed line above it. The list holds when
    every condition in some group does.
  - **Not more often than every N s** always holds the whole list back until
    its time is up, however it's joined.
  - Games saved before the operators, with *Needs all* or *Needs any*, load
    as ANDs or ORs.
- **Lists and records.** *Add to a list* (at the end or the start; *not if it
  is there already* if you like); *Remove from a list* (this value, every one
  of it, the first, the last, or everything); *List contains*; *Set a field of
  a record* (`quest` → `stage` → `=quest.stage + 1`). *Change variable by* adds
  an item to a list and joins text to text.
- **Wait: sequences.** The actions after a *Wait* happen that much later, and
  Waits add up: *show "Who's there?"* · *Wait 2* · *play a knock* · *Wait 1* ·
  *open the door*. If the object is gone in the meantime, the rest is dropped.
- **Events: objects telling each other.** *Send event* `alarm` to anything
  listening, a group, the player, one object, *what set this rule off*, or
  *me*. Every object it reaches that has a rule *When I receive an event*
  `alarm` runs it, with the sender as *what set it off*, so it can answer. Sent
  *after* some seconds it's a timer: *When Play starts: send `tick` to me after
  1 s*, and *When I receive `tick`: … and send `tick` to me after 1 s* repeats
  every second.
- **States: what an object is doing now.** *Set state* `chasing` (on me, the
  player, a group…) and *When I enter a state* `chasing` runs once when it
  changes, not again while it stays. *State is* (any of a group, too) and the
  expression `state == "open"` ask about it. That's a state machine: a guard
  *patrolling* → *chasing* → *searching*, a door *closed* → *opening* →
  *open*. States are cleared when play starts.
- **Else** is what it does when the conditions don't hold. For example, clicking
  a door with the key opens it, without it shows *Locked*.
- **Who a condition is about:** **me** (the object the rule, or the control, is
  on), **the player**, **what set it off**, **any of a group**, or one object.
  For instance: *any Enemies near me*, *how many Coins there are ≤ 0*.
- **I'm clicked / tapped** fires for the object under the pointer (or at the
  middle of the view when the mouse is captured). It's the nearest one, so a
  wall hides what's behind it.
- **Moving by the rules:** **Move** set off every frame (a held key, *every 0
  seconds*) moves it forward, back, left, right, up or down, relative to itself,
  the world or the camera. It stops when the rule stops, as a released key
  does, and on a car it presses the pedals and turns the wheel. **Push /
  launch** adds speed once (jump pads, knock-back, *away from other*). **Jump**
  (only from the ground, if you like), **Turn** (by some degrees, over some
  seconds if you like, or per second), **Face towards** and **Stop moving** do
  what they say. In first person, turning the player turns the view with it.
- **Rotate** turns it about X, Y and Z:
  - **by** some degrees: about its own axes, or the world's;
  - **to** a rotation: the same numbers as its Rotation in the Inspector;
  - **per second**, while the rule runs.

  Over (s) swings it there smoothly. Two presses of a door's key swing it
  twice as far, and 360 is a whole turn round.
- **Scale** resizes it:
  - **times** (2 is twice as big, 0.5 half);
  - **to** a size (1 is as it was made);
  - **by** (adds, or takes away with −);
  - **times per second**, while the rule runs.

  It can be the same every way or X, Y, Z apiece, at once or over some
  seconds. What it bumps into grows and shrinks with it, and it never
  shrinks to nothing: *scale to 0 over 1 s, then Destroy* makes a hit enemy
  shrink away.
- **Pivot: where it turns and grows from.** Turn, Rotate and Scale turn or
  scale an object about its **origin** (a box's middle, a model's feet) unless
  you choose otherwise:
  - **a point on it:** pick *left / middle / right* (X), *bottom / middle /
    top* (Y) and *back / middle / front* (Z) of its own box. A door on *left*
    swings about its hinge side, and a pillar on *bottom* grows up from the
    ground instead of into it.
  - **an object:** it turns about that object, for example a moon round its
    planet (*Rotate per second, Relative to world, Pivot: Planet*).

  The sides are the object's own, so a swung door keeps its hinge. *Left* is
  its −X side (on the left as the editor first looks at it), and *front* is
  its +Z side, the way it faces. While the object is selected, an orange dot
  shows the pivot in the view, with a line along the axis it turns about.
  **Move object** has the same choice for *which point arrives*: its bottom
  lands on the spot.
- A rule's **How** shows only the fields that matter for it. Hover over a
  label for what it means.
- **Per second** (and **Move**) acts a little every frame the rule runs. On a
  one-off trigger (a key *pressed*, a click, something entering), it barely
  moves, so the Inspector warns you. For a key or button, one click switches
  it to *while held*.
- Sent **to** the same place, rotation or size again (every frame, or while a
  key is held), a move already on its way carries on. It doesn't start over.

A coin is: a box with **Trigger** ticked, a **Collectible** component pointing at
`score`. A win condition is a rule on any object: *When* variable `score` becomes
`>= 10`, *Do* Win.

### Triggers

Tick **Trigger** on a rigid body to make it detect overlaps without blocking
movement. That is what pickups, checkpoints, damage zones and goal areas are built
from, and what feeds the "something enters me" event.

### Saving the game, and checkpoints

- **Save game** keeps where the game is, in the browser:
  - the level and every variable;
  - where the player stands, and its health;
  - what has changed in the level: objects destroyed, hidden or moved, and
    their health;
  - the last checkpoint.
- **Load game** goes back there. The level loads afresh, so things collected
  since the save come back, then the saved changes are made again.
- **Slots.** A game can keep several (*save*, *slot 2*…).
  **Delete saved game** clears one, and the condition **A saved game exists**
  tells you whether there's anything to load.
- **Each game its own.** Saves are kept under the game's name, so two games on
  one website don't share them. Objects spawned during play aren't kept.
- **Set checkpoint.** A flag with *When the player enters me — Set checkpoint
  (here)* puts the player standing on it next time.
- **Respawn** brings the player back to its checkpoint (or where the level
  began), with health full. Anything else respawns where it began. On a
  **Health** component, *When it runs out: respawn* does this by itself.

## Behavior scripts

The escape hatch for when components and rules aren't enough. Every object has a
**Behavior** box in the inspector; the code runs once per frame in Play mode, with
these already in scope — no `this.` needed:

| | |
|---|---|
| `entity` | the object's `THREE.Object3D` |
| `body` | its `RigidBody`, or `null` |
| `delta` | seconds since the last frame |
| `time` | seconds since the engine started |
| `keys` | `keys.KeyW`, `keys.Space`, `keys.ArrowLeft` … → boolean |
| `engine` | the `Engine`, for anything else |
| `fire()` | play this object's sounds tagged with the `fire` trigger |
| `log(...)` | `console.log`, tagged with the object's name |

```js
// spin
entity.rotation.y += delta * 2;

// bob up and down
entity.position.y = 1 + Math.sin(time * 3) * 0.5;

// jump on space
if (keys.Space && body.grounded) body.velocity.y = 10;
```

And the scripting API, the same things rules and components can do, one line
each:

| | |
|---|---|
| `first`, `state` | true on the first frame; an object kept between frames |
| `pressed(code)`, `held(code)`, `released(code)`, `mouse` | input: `pressed("KeyE")`, `mouse.clicked(0)` |
| `vars` | variables: `vars.get("score")`, `vars.set("lives", 3)`, `vars.change("score", 1)` |
| `find(name)`, `findAll(name)` | the nearest object by name or group, or all of them |
| `player`, `camera` | the player's object, the camera |
| `act(type, props)` | **any rule action**: `act("rotate", { y: 90, seconds: 1 })`, `act("destroy", { target: "group:Coins" })` |
| `spawn`, `destroy`, `damage`, `message`, `sound`, `play` | the usual things, directly |
| `touching(who)`, `raycast(from, dir)`, `distanceTo(what)` | what it touches, what's in a direction, how far |
| `save(slot)`, `load(slot)` | the game saved and loaded |
| `use(module)` | a script module's exports (see *Script modules*) |
| `THREE` | Three.js |

```js
// a door: E opens it when you're close
if (pressed('KeyE') && distanceTo('player') < 3) act('rotate', { y: 90, seconds: 1, pivot: 'a point on it', pivotX: 'left' });

// collect what you touch
for (const coin of touching('group:Coins')) { destroy(coin); vars.change('score', 1); }
```

The **?** under the box lists all of it. For code editors,
`types/tiny3-script.d.ts` declares every name, with its types. Put `/// <reference
path="./types/tiny3-script.d.ts" />` at the top of a file you write a script
in, and it's completed and checked as you type. A name an older script declares
itself (its own `state`, say) is its own.

A script that throws is stopped rather than flooding the console. The editor
says so, with why and on which line, and the Behavior box keeps saying it until
you press **Apply** again.

### Script modules

Code that several scripts share goes in a **module**: 🧰 **Tools → Modules**,
**+ Module**. A module is the game's, the same in every level, and is written as
a normal JavaScript module:

```js
// module "maths"
export const TAU = Math.PI * 2;
export function wobble(t, amount = 0.2) { return Math.sin(t * TAU) * amount; }

// module "enemies": modules import each other
import { wobble } from 'maths';
export let alerted = 0;
export function bob(object, time) { object.position.y = 1 + wobble(time); }
```

A Behavior script imports from one at its top, or with `use()` anywhere:

```js
import { bob } from 'enemies';
bob(entity, time);

const { TAU } = use('maths');
```

- A module runs once, the first time something imports it. After that every
  script shares it, `let` counters and caches included, until Play starts
  again.
- Two modules that import each other each get what the other has run so far,
  as in the browser.
- **Check** reads a module for mistakes and lists what it exports, without
  running it. A mistake while playing says which module and which line.
- The list says which scripts and modules import each one.
- Modules are saved with the game and exported with it.
- A module has `THREE`, `engine`, `vars` and `log`, not one object's API (it
  belongs to no object). Pass it what it needs, as `bob(entity, time)` does.
- A game opened from a file runs its modules only once its scripts are
  trusted.

`import` and `export` lines are read a line at a time (no build step): each must
start its own line. Everything JavaScript modules allow at the top of a line
works:
- named, default and `* as` imports;
- `export function`, `export class`, `export const` / `let` (several names, or
  `{ a, b } =`);
- `export default`, `export { a, b as c }`;
- `export { x } from 'other'`.

## Tools

🧰 **Tools** in the toolbar opens a drawer along the bottom of the view, over
the game. It's usable while the game plays and keeps what it had when you
close it. It has four tabs.

### Logic graph

The level's rules as a graph. Each rule is a node: its object, its WHEN, its
IFs and its DOs. What a rule sets off elsewhere is a link out of that DO line:

| A rule's DO | Links to |
|---|---|
| **Send event** “alarm” | each rule that *receives* “alarm”, on the objects it's sent to (dashed: to *other*, whoever set it off) |
| **Set state** “chasing” | each *I enter a state: chasing* rule of what it sets |
| **Set / Change variable** | the variable, then each rule that watches it (*Variable becomes*) or tests it in an IF or an expression |
| **Show a screen**, **Start a dialogue** | the screen (its *A button is pressed* rules), the dialogue (its *A dialogue ends*) |
| **Spawn**, **Go to level** | the prefab, the level |

A **Controls** node holds the controls that reach any of those: a key that
changes the score, opens the map, or sends an event.

- **Click a rule** to select its object and show that rule in the Inspector,
  where it's edited as always.
- **Drag a rule's ⊕ onto another rule** to link them. It asks for the event's
  name: the first rule gets *Send event* to the other's object, which receives
  it in the rule you dropped on, or in a new *I receive an event* rule. Click
  a link to see what it is, or to remove it. Undo takes back either.
- **Drag nodes** where you like; the level keeps where you put them.
  **Arrange** lays them out again, **Fit** brings everything into view, and
  wheel or drag pans and zooms. **Only the selected object** shows that
  object's rules, and **+ Rule** adds one to it.
- **While playing**, a rule lights up as it runs and counts how many times it
  has. A link pulses when its event is sent, and a rule that failed turns red.

### Debugger

- **Pause / Resume**, and **⏭ 1 frame** or **10**: the game goes on 1/60 s
  at a time while you watch.
- **Breakpoints:** click a rule's **●** in the Logic graph. When that rule
  runs, the game pauses at the end of that frame (its actions done) and says
  where and why, e.g. *Breakpoint: Guard · rule 2 — WHEN I enter "chasing" →
  DO*. Breakpoints stay set across Play and Stop. **Pause on errors** stops
  the same way at a rule or script that fails.
- **Trace:** what happened, newest first, with a filter. It lists each rule
  that ran, with its WHEN, who set it off, and whether its conditions held
  (DO, ELSE, or *conditions not met*). It also lists each event sent and who
  was listening, each script's `log()`, and each mistake. Click a rule's line
  to find it in the graph.
- **Variables:** every variable live. Type a new value to change it while
  playing (or paused): a number, true / false, a list `[1, 2]`, or text.
- **Watch:** one object's live state:
  - where it is and how it's turned;
  - its body and speed, and whether it's on the ground;
  - its state, what it sees and has heard;
  - its clip, and each component's own numbers (a timer, an ammo count, an
    AI's).

### Profiler

How long each part of a frame takes, frame by frame (a chart of the last
300), with each part's recent average and worst:
- the parts timed: physics, controls, components, rules, scripts,
  animation and drawing;
- what's left over (*other*: the sky, levels of detail, the editor itself).

- **Slowest lately:** each script by its object, each kind of component
  (Enemy AI, Animator…), and the objects whose components take longest
  together.
- **Drawing:**
  - what the renderer sent: draw calls, triangles, textures, meshes and
    shaders, every pass counted (bloom and AO draw again);
  - how many of everything there is: objects, bodies, joints, rules,
    components, scripts, animated models, and memory (in Chrome).
- **Freeze** keeps the chart still to look at; **Reset** starts it again.

It times the game only while its tab is showing, at no cost otherwise.
Drawing is CPU time: a frame much longer than its parts is waiting on the GPU
or on the screen's refresh.

## Engine API

```js
import { Engine } from './src/engine.js';

const engine = new Engine();
engine.add(myEntity);          // { object3D, update(dt, engine) }
engine.onUpdate = (dt) => {};  // per-frame hook
engine.start();
```

| Module | Responsibility |
|---|---|
| `src/engine.js` | Renderer, scene, game loop, entity registry |
| `src/effects.js` | The picture's effects: ambient occlusion, bloom, depth of field, held objects drawn in, tone mapping, the colour stage |
| `src/light-shadows.js` | Lamps' shadows tuned to each lamp, and only the nearest few at once |
| `src/generators/scatter.js` | Scatter: trees, pines, bushes, rocks, grass, flowers placed on the ground, drawn as copies in cells, solid if asked |
| `src/editor/terrain-brush.js` | Sculpt & paint brushes on a selected terrain |
| `src/world-detail.js` | Far terrain chunks drawn simpler, far scatter cells not drawn (drawing only) |
| `src/grid-codec.js` | Grids (a terrain's sculpting and paint) as short text: run-length encoded, sampled at any resolution |
| `src/probes.js` | Light probes: a room captured from inside, lighting and reflected by what is in its box |
| `src/sound.js` | `SoundSystem` — sounds by name, channels, mixer, overlap, music fades |
| `src/sfx.js` | The sound maker — effects and ambience synthesized from settings |
| `src/audio-panel.js` | The sound cards in the Audio panel |
| `src/physics.js` | `PhysicsWorld` — fixed-step rigid bodies, box/sphere/capsule shapes, slopes, triggers, raycasts, tumbling (contact points, impulses, resting stacks), sweep-and-prune pairing, crouching heights |
| `src/joints.js` | Joints: hinge, ball, fixed, rope, spring — limits, breaking; solved each slice after contacts |
| `src/ragdoll.js` | A character gone limp: capsules for its limbs, joined with swing limits, its bones following them |
| `src/gameplay.js` | Ties components, rules and variables together behind one API |
| `src/components.js` | The component registry and its runtime |
| `src/rules.js` | Events, conditions and actions — the "When … Do …" model |
| `src/controls.js` | Controls — inputs → actions, as data, and the runtime that performs them |
| `src/controls-panel.js` | The Controls panel UI |
| `src/play-overlay.js` | On-screen touch buttons and the interaction prompt, in Play and exported games |
| `src/variables.js` | `VariableStore` — named game state: numbers, text, yes / no, lists, records |
| `src/expr.js` | Expressions: a safe parser and evaluator (no `eval`), `{…}` in text, the value a rule's field reads as |
| `src/inspector-gameplay.js` | The Components and Rules inspector UI |
| `src/behavior.js` | Compiles and runs the per-entity scripts (their `import` lines take from the script modules) |
| `src/script-modules.js` | Script modules: code the scripts share, `import` / `export` read without a build step, run once and shared |
| `src/tools/logic-graph.js` | The Logic graph's model: rules as nodes, what sets off what as links, layout, linking rules by a drag |
| `src/tools/debugger.js` | The Debugger: the trace, breakpoints, pause and step, an object's live state |
| `src/tools/profiler.js` | The Profiler: each part of a frame's time, the slowest scripts and components, the renderer's numbers |
| `src/app/tools-drawer.js` | The Tools drawer (editor only): Logic graph, Debugger, Profiler, Modules |
| `src/entity.js` | `Entity` base class, parenting, collision helpers |
| `src/input.js` | Keyboard, mouse, wheel, pointer lock, on-screen buttons, `keyState` |
| `src/cameras.js` | `CameraRig` — orbit / follow / fps / free modes; `CAMERA_SETTINGS`, every adjustable setting described once |
| `src/camera-panel.js` | The Camera panel's per-camera tabs, drawn from `CAMERA_SETTINGS` |
| `src/rig.js` | A skeleton read as a body (hips, legs, arms… from bone names), bone maps between rigs, clips carried from one rig to another |
| `src/ik.js` | After the clips: feet on the ground (two-bone IK), a head that turns, root motion |
| `src/model-import.js` | .obj (+ .mtl), .fbx and .stl made into .glb on import, their materials made standard (editor only) |
| `src/asset-compress.js` | A .glb's textures made smaller on import: no bigger than a size, JPEG when opaque |
| `src/app/asset-library.js` | The asset library: models, animations, textures, sounds and the built-in models, with pictures, search and use counts |
| `src/loader.js` | `AssetLoader` for GLB/GLTF, with caching and the Draco / meshopt / KTX2 decoders; copies models skeletons and all, each with its own materials; imports picked or dropped files |
| `src/gltf-files.js` | glTF files as files: which decoders one needs, and a `.gltf` with its files packed into one `.glb` |
| `src/placement.js` | Where a new model stands, how big it is, and the size fixes offered for other units |
| `src/model-parts.js` | A model's parts (one per material of its file): edited, saved and restored one by one |
| `src/file-drop.js` | Files and folders dropped from the desktop |
| `src/mesh-collider.js` | Mesh colliders: a model's triangles in a bounding-volume tree; box, capsule and ray tests against them |
| `src/gltf-material.js` | A model's materials for the Color & Texture panel: read straight from the .glb / .gltf (pictures as stored), KTX2 pictures turned into PNGs |
| `src/vehicle.js` | Cars: wheels found by name, suspension on each, tyres that grip and slide, engine, brakes, handbrake, levelling, self-righting; revs and gears; crashes; getting in and out; drawn wheels that spin and steer; driving towards a point for AI |
| `src/vehicle-audio.js` | A car's sounds, made as it drives: engine note, tyre screech, crash |
| `src/skid-marks.js` | Skid marks: ribbons laid where tyres slide |
| `src/race.js` | Races: checkpoints in order, laps, countdown, positions, lap times, results; driving the other cars round; resets; the next-checkpoint arrow |
| `src/ai.js` | Senses (sight cone, line of sight, hearing, footsteps, memory) and the Enemy AI state machine (patrol, guard, chase, attack, search, alert, cover) |
| `src/walking.js` | Walking by itself: a step towards a point, standing still, the next turn of a path, a patrol's points — shared by Follower, Patrol and Enemy AI |
| `src/sense-markers.js` | The selected object's sight cone and hearing rings, drawn in the editor |
| `src/navigation.js` | Finding the way: a walking grid measured from the level's solid bodies, A* paths for followers and patrols |
| `src/dispose.js` | Frees the GPU memory of an object that left the game (not what other objects still share) |
| `src/animation.js` | `AnimationPlayer`: one per model, shared by the Animator, Play animation and the preview |
| `src/view-model.js` | Held in first-person view: drawn locked to the camera, over the world |
| `tools/make-blaster.mjs` | Builds `assets/blaster.glb`, the first-person test model, and `assets/blaster-inspect.glb`, one more move for it in a file of its own |
| `src/assets-db.js` | `AssetStore` — imported files persisted in IndexedDB by content hash; import from saved files, cleanup |
| `src/asset-refs.js` | `assetIdsIn` — the one answer to "which stored files does this game need", shared by save, export and cleanup |
| `src/scene.js` | `SceneSerializer` — the scene ⇄ JSON round trip |
| `src/project.js` | `Project` — the game's levels, switching between them, what they share |
| `src/templates.js` | The starter games in the New chooser |
| `src/entity-fields.js` | An object's plain settings (groups, held in view, parts' physics, flatten the ground…), listed once for saving, loading, copying and prefabs |
| `src/entity-index.js` | The objects by name and by group, kept up to date — what rules and components find their targets in |
| `src/game-file.js` | The `.tiny3` saved-game file: game.json and its files, zipped |
| `src/script-trust.js` | Scripts in a game opened from a file: off until allowed |
| `src/ground-pads.js` | A terrain levelled under what flattens the ground (a house, a camp, a road) |
| `src/generators/` | Terrain and buildings made from settings (terrain.js, building.js, noise.js; generated.js lists them) |
| `src/game-ui.js` | Title screen and HUD-style settings |
| `src/screens.js` | Screens and dialogue: their data, the HTML they are drawn as, and the runtime that opens them and runs their buttons and choices |
| `src/app/screens-panel.js` | The Screens & dialogue panel, with previews (a dialogue can be tried in place) |
| `src/poses.js` | Visual-only animation (bob, lean, squash) applied just for drawing |
| `src/play-overlay.js` | Everything drawn over the game: HUD, messages, title, touch buttons |
| `src/levels-panel.js` | The Levels panel |
| `src/export.js` | `GameExporter` — the game as one playable HTML file, or as a website (.zip or a folder) |
| `src/zip.js` | Writes (and reads) .zip files in the browser, for the website export |
| `src/editor.js` | `ObjectEditor` — selection, the gizmo, snapping; the rest is mixed in from `src/editor/` |
| `src/editor/` | One file per job: `history` (undo helpers), `clipboard` (copy/paste/duplicate), `prefabs`, `hierarchy`, `inspector`, `physics-section`, `script-section`, `animation-section`, `audio-section`, `lighting` |
| `src/light-entity.js` | `LightEntity` — a light as an object in the scene (kept apart so exported games don't load the editor) |
| `src/reverb.js` | `SPACES` and the generated echo for each one |
| `src/prefabs.js` | `PrefabLibrary` and the linking rules: which parts a copy takes from its prefab |
| `src/factories.js` | The primitives and lights the editor can create |
| `src/materials.js` | PBR material description ⇄ Three.js material, texture import, tile by size |
| `src/texgen.js` | The texture maker — seamless patterns and their normal maps |
| `src/materials-panel.js` | The Color & Texture panel |
| `src/history.js` | Undo/redo command stack |
| `src/ui.js` | Draggable / resizable panels |
| `src/game.js` | Entry point: makes the engine and the editor, and wires the editor's parts together (`app`) |
| `src/app/` | The editor's parts, each `wire…(app)`: objects (shapes, terrain, buildings, importing), asset browser, New (templates), audio mixer, Game panel, files (save, open, autosave, scripts' trust), Play mode |

## Tests

```sh
npm install
npm test
```

Vitest runs headlessly against the same vendored Three.js the browser loads
(see `vitest.config.js`). Coverage is focused on the parts you cannot see fail:
physics (tumbling, stacking and rolling included), pathfinding, entity parenting,
behavior scripts, camera controls, scene serialization and export.

There is also a browser smoke test that boots the real editor, builds a playable
scene, and plays it — the only thing that catches live-page bugs like a toolbar
button swallowing the jump key:

```sh
npm run serve   # in another terminal
npm run test:browser
```

It drives whatever Chrome or Edge is already installed, so no browser download is
needed. Override with `TINY3_URL` / `TINY3_CHANNEL`.

And a check for names a module uses without declaring or importing them — what
would only fail when that line runs (or, like `history` or `name`, silently be
the browser's own):

```sh
npm run check
```

## Publishing your game

Give it a **Name** and an **Icon** (an emoji, or an image) in the Game panel:
they are the browser tab's title and icon, the loading screen, and the exported
files' names. Then press **🚀 Export** and choose:

| Export | For |
|---|---|
| **One file (.html)** | Sending to someone, or playing offline: everything is inside one page, and it runs even double-clicked from Downloads |
| **Website (.zip)** | GitHub Pages, itch.io or any web host. `index.html` and the game's files; each model, texture and sound is a file of its own, so it's smaller, cached by the browser and loaded in parallel. It needs a web server: double-clicked, browsers block its files |
| **Website into a folder…** | The same website written straight into a folder you pick, such as a clone of your GitHub Pages repository (Chrome and Edge) |

Either way the game opens with a loading screen, and carries the Draco / KTX2
decoders only if its models use them.

**The website is an app.** A player can install it on a phone's home screen,
or among a computer's apps: it opens full screen, with the game's icon.
- **Offline.** It keeps every file of the game the first time it's played, so
  it plays with no connection after that.
- **Install button.** Where the browser offers installing, the game shows ⤓
  (and *Install game* in the pause menu).
- **Updates.** A new export replaces the old copy, and other games on the same
  website keep their own.

### Languages

In the Game panel, pick the language the game is **written in**, then **add**
the others it can be played in.
- **Translate texts…** lists every text a player sees: messages, win and lose
  messages, the title screen, HUD labels, prompts, touch buttons, level names,
  and the engine's own words (Paused, Resume, You win!…). Next to each, you
  type its translation. It says how many are left.
- **Which language.** A player gets the language their browser asks for (or
  the game's own), and can change it in the pause menu, where it's remembered.
- **Right to left.** Arabic, Persian, Hebrew and Urdu read right to left, on
  screen too.
- **Play in** tries a translation in the editor.

**Your game on GitHub Pages:** make a repository, put the website's files in it
(unzip the .zip there, or export into its folder), push, then **Settings → Pages
→ Deploy from a branch → `main` / `/ (root)`**. The game is at
`https://<you>.github.io/<repo>/`. The export includes `.nojekyll`, so Pages
serves every file as it is.

## Deploy the editor to GitHub Pages

1. Push the repo, then **Settings → Pages → Deploy from a branch → `main` / `/ (root)`**.
2. Visit `https://<you>.github.io/<repo>/`.

`.nojekyll` stops Pages from processing the vendored files. `node_modules/` is
git-ignored and is only needed to run the tests. Keep all of `lib/`, including
the `.wasm` files in `lib/libs/`: compressed models need them.

## Known limitations

- Only bodies with **Tumbles** turn from hits; other moving bodies keep an
  upright collider. A tumbling model tumbles as its box (or ball, or pill), not
  its exact shape.
- Moving (dynamic) bodies are boxes, spheres or capsules; only static and
  kinematic ones can be meshes.
- A ragdoll can't get back up: it stays limp until play stops (or it is
  removed). Its limbs are capsules, not the mesh's shape, and it doesn't blend
  back into animation. Joints are solved by position (a few rounds a slice):
  a long chain of heavy links on a light one stretches a little.
- Settled tumbling bodies are held still but still checked each slice: dozens
  are fine, a heap of thousands is not.
- The walking grid keeps one floor per spot: a follower finds its way on its
  own storey and up ramps to open platforms, but not up stairs to a floor built
  directly over another.
- Enemies see as well in the dark as in the light: lights and shadows don't hide
  you, and crouching doesn't make you harder to see (only to reach: a low
  vent). Only solid bodies block their view; an object
  with no body (a bush with no collider) doesn't.
- Animation blends by speed (1D: idle, walk, run), not by direction: there is
  no strafing blend space. Feet IK bends legs for the ground but doesn't turn
  the foot to a slope. A clip carried to another skeleton moves its limbs but
  not its hips' travel. Retargeting needs humanoid bone names (a horse or a
  spider is matched only by identical names).
- Imported geometry isn't compressed (no Draco encoding in the browser): only
  textures are made smaller. .fbx textures in TGA or other formats a browser
  can't show come in untextured; .dae, .3ds and .blend aren't read (export a
  .glb from Blender).
- Big worlds are drawn simpler far away, but all of a level is loaded at
  once: nothing is streamed in as you walk. A detail-1024 terrain takes a
  couple of seconds to make. Scatter's shapes are its own six kinds, not your
  models (place those, or a prefab's copies, by hand: they are drawn together
  in play).
- The sun has one shadow map that follows the view, not cascades: far shadows
  past the Shadow range aren't drawn. There are no baked lightmaps: light
  bouncing off walls is approximated by light probes, which capture a room's
  light but cast no soft shadows of their own.
- Ambient occlusion and depth of field cost a full extra render each; on slow
  phones keep them off (they are off by default).
- Noises go through walls: anything within a noise's *Heard within* hears it.
- The Logic graph shows rules, controls and what they reach. Components (an
  Enemy AI, a Damager) and Behavior scripts act too, but appear only in the
  Debugger's trace and the Profiler. A breakpoint stops at the end of a frame,
  not in the middle of a rule, and there are no breakpoints inside scripts
  (use the browser's own debugger: a `debugger;` line works). Script modules'
  `import` and `export` must each start a line; a module's exports are fixed
  when it runs.
- Cover is where you put it (a group of points). They don't find cover on their
  own, and a group of enemies doesn't plan together (flanking, keeping apart):
  each acts on what it senses, and calls the others.

## Credits

`assets/duck.glb` is the Khronos Group sample Duck model (CC-BY 4.0).
`assets/robot.glb` is RobotExpressive by Tomás Laulhé (CC0 1.0), from the
three.js examples. `assets/blaster.glb` and `assets/blaster-inspect.glb` are
generated by `tools/make-blaster.mjs`.
Three.js r160 is vendored under `lib/` (MIT), with its decoders in `lib/libs/`:
Draco (Apache 2.0), Basis Universal (Apache 2.0), meshoptimizer, ktx-parse and
zstddec (MIT).

/**
 * Reverb — the room a game sounds like it happens in.
 *
 * A footstep in a cave and the same footstep in a small room are the same
 * recording; what differs is the echo that follows it. A scene picks a space
 * (see SPACES) and how much of it to hear, and every sound effect and ambient
 * sound is heard through it. Music stays dry: it was made with its own space.
 *
 * The echoes are made here rather than loaded: an impulse response is noise
 * that fades away, darkening as it goes (high notes die first in a real room),
 * after a short gap for the walls being far off. Two channels of it, made
 * separately, give the echo width. No files means nothing to download, and a
 * space costs a fraction of a second to build.
 */

export const SPACES = {
  none: { label: 'None (outdoors)', seconds: 0, decay: 0, damping: 20000, preDelay: 0 },
  room: { label: 'Small room', seconds: 0.6, decay: 3.2, damping: 6000, preDelay: 0.006 },
  hall: { label: 'Hall', seconds: 1.8, decay: 2.4, damping: 4200, preDelay: 0.018 },
  cave: { label: 'Cave', seconds: 3.2, decay: 1.7, damping: 1800, preDelay: 0.03 },
  cathedral: { label: 'Cathedral', seconds: 4.5, decay: 1.5, damping: 3000, preDelay: 0.04 },
};

export const SPACE_NAMES = Object.keys(SPACES);

/** A space by name; anything unknown is no space at all. */
export function spaceSettings(name) {
  return SPACES[name] ? { name, ...SPACES[name] } : { name: 'none', ...SPACES.none };
}

/**
 * The impulse response for a space: what a single clap in it sounds like.
 * Returns null for 'none' (nothing to hear) or without a usable context.
 */
export function impulseBuffer(context, name) {
  const space = spaceSettings(name);
  if (!space.seconds || !context?.createBuffer) return null;
  const rate = context.sampleRate || 44100;
  const length = Math.max(1, Math.floor(rate * space.seconds));
  const buffer = context.createBuffer(2, length, rate);
  const gap = Math.floor(rate * space.preDelay);
  // one-pole lowpass, re-derived per channel: the further into the tail, the
  // darker it gets, which is what makes a cave sound like stone and not static
  const cutoff = Math.min(0.99, (2 * Math.PI * space.damping) / rate);

  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let last = 0;
    let seed = 1013904223 + ch * 7919; // same every time: a space sounds like itself
    for (let i = 0; i < length; i++) {
      if (i < gap) { data[i] = 0; continue; }
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const noise = (seed / 2147483648) - 1; // -1..1
      const t = (i - gap) / Math.max(1, length - gap);
      last += cutoff * (noise - last); // lowpass
      data[i] = last * (1 - t) ** space.decay;
    }
  }
  return buffer;
}

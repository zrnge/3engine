/**
 * Files dragged in from the desktop — folders included, with their layout, so
 * a .gltf can find its .bin and textures by the paths it names.
 */

/**
 * Ask for a whole folder — every file in it and its subfolders, as
 * [{ file, path }] with the folder's own layout ('brick/textures/diff.jpg'),
 * so a .gltf finds what it names. [] if cancelled.
 */
export function pickFolder() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.multiple = true;
    input.addEventListener('change', () => resolve([...(input.files || [])]
      .map((file) => ({ file, path: file.webkitRelativePath || file.name }))));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

/** Is this drag carrying files from outside the page (not a hierarchy row)? */
export function draggingFiles(event) {
  return [...(event.dataTransfer?.types || [])].includes('Files');
}

function fileOf(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** Every entry in a folder (the browser hands them over in batches). */
async function entriesIn(folder) {
  const reader = folder.createReader();
  const all = [];
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return all;
    all.push(...batch);
  }
}

/**
 * Take what a drop carried: [{ file, path }], where `path` is the file's place
 * inside a dropped folder ('car/textures/paint.png') or just its name.
 *
 * Must be called during the drop event itself — the browser empties the drop
 * data as soon as the event is over. The folders are then read at leisure.
 */
export function droppedFiles(dataTransfer) {
  const items = [...(dataTransfer?.items || [])].filter((i) => i.kind === 'file');
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) {
    const files = [...(dataTransfer?.files || [])];
    return Promise.resolve(files.map((file) => ({ file, path: file.name })));
  }
  return (async () => {
    const out = [];
    const walk = async (entry, dir) => {
      if (entry.isFile) {
        out.push({ file: await fileOf(entry), path: dir + entry.name });
      } else if (entry.isDirectory) {
        for (const child of await entriesIn(entry)) await walk(child, `${dir}${entry.name}/`);
      }
    };
    for (const entry of entries) await walk(entry, '');
    return out;
  })();
}

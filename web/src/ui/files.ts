// Saving a file the server sent, and reading one the director picked.

/** Hands a downloaded file to the browser to save under `name`. */
export function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // The browser has started saving by now; the address can go.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A picked file's contents as JSON. */
export async function readJsonFile(file: File): Promise<unknown> {
  const text = await file.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file.name} isn't a world file: it isn't JSON.`);
  }
}

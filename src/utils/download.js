function filenamePart(value, fallback) {
  return String(value || fallback)
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "") || fallback;
}

/** Download a serializable value as a UTF-8 JSON file in the browser. */
export function downloadJson(value, filename) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.endsWith(".json") ? filename : `${filenamePart(filename, "download")}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function jsonFilename(value, fallback = "download") {
  return filenamePart(value, fallback);
}

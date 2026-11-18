// Old editor tabs kept independent backups under the signed-in user's draft ID.
try {
  const keys = Object.keys(localStorage);
  for (const row of document.querySelectorAll("[data-recovery-prefix]")) {
    const prefix = row.getAttribute("data-recovery-prefix");
    let index = 0;
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue;
      const contents = localStorage.getItem(key);
      if (contents === null) continue;
      const backup = new Blob([contents], { type: "application/json" });
      const link = document.createElement("a");
      index++;
      link.download = `draft-${row.getAttribute("data-draft-id")}-browser-${index}.json`;
      link.href = URL.createObjectURL(backup);
      link.textContent = `Download browser backup ${index} (JSON)`;
      row.appendChild(link);
    }
  }
} catch {
  // Browser storage can be unavailable. The server ZIP link works independently.
}

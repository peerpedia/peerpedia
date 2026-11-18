/** @returns {void} */
(function readingPosition() {
  /** @param {string} paper @returns {string} */
  function key(paper) {
    return `peerpedia:reading:visitor:${paper}`;
  }
  /** @param {string} paper @returns {{chapter: string, position: number} | null} */
  function guestPosition(paper) {
    try {
      return JSON.parse(localStorage.getItem(key(paper)));
    } catch (_) {
      return null;
    }
  }
  const data = document.getElementById("reading-config");
  if (!data) {
    // Refresh links when Back restores the abstract from the browser cache.
    /** @returns {void} */
    function updateLinks() {
      for (const link of document.querySelectorAll("a[data-resume-paper]")) {
        const url = new URL(link.href);
        const saved = guestPosition(link.dataset.resumePaper);
        if (saved?.chapter) {
          url.searchParams.set("chapter", saved.chapter);
          url.searchParams.set("resume", "1");
        } else {
          url.searchParams.delete("chapter");
          url.searchParams.delete("resume");
        }
        link.href = url.href;
      }
    }
    updateLinks();
    window.addEventListener("pageshow", updateLinks);
    return;
  }
  const config = JSON.parse(data.textContent);
  const saved = config.progress_url
    ? config.saved
    : guestPosition(config.paper);
  const query = new URLSearchParams(location.search);
  const resume =
    !location.hash && (!query.has("chapter") || query.get("resume") === "1");
  const root = document.documentElement;
  if (!location.hash && !query.has("chapter") && query.get("resume") === "1") {
    history.replaceState(
      history.state,
      "",
      config.chapters[config.chapter] + "&resume=1",
    );
  }
  if (resume && saved && Object.hasOwn(config.chapters, saved.chapter)) {
    if (saved.chapter !== config.chapter) {
      root.classList.add("resuming");
      location.replace(config.chapters[saved.chapter] + "&resume=1");
      return;
    }
    if (saved.position > 0) root.classList.add("resuming");
  }

  /** @returns {number} */
  function scrollRange() {
    return Math.max(0, root.scrollHeight - innerHeight);
  }

  /** @returns {void} */
  function start() {
    if (root.classList.contains("resuming")) {
      scrollTo(0, saved.position * scrollRange());
      root.classList.remove("resuming");
    }
    const csrf = document.querySelector("[name=csrfmiddlewaretoken]")?.value;
    let timer;
    let pending = Promise.resolve();
    /** @returns {void} */
    function save() {
      clearTimeout(timer);
      const position = Math.min(
        1,
        Math.max(0, scrollY / Math.max(1, scrollRange())),
      );
      const state = { chapter: config.chapter, position };
      if (config.progress_url) {
        /** @returns {Promise<void>} */
        async function send() {
          await fetch(config.progress_url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRFToken": csrf,
            },
            body: JSON.stringify({ submission: config.submission, ...state }),
            keepalive: true,
          });
        }
        /** @returns {void} */
        function ignoreNetworkError() {}
        pending = pending.then(send).catch(ignoreNetworkError);
      } else {
        try {
          localStorage.setItem(key(config.paper), JSON.stringify(state));
        } catch (_) {}
      }
    }
    /** @returns {void} */
    function scheduleSave() {
      clearTimeout(timer);
      timer = setTimeout(save, 1200);
    }
    window.addEventListener("scroll", scheduleSave, { passive: true });
    window.addEventListener("pagehide", save);
  }
  document.addEventListener("DOMContentLoaded", start, { once: true });
})();

(() => {
  const data = document.getElementById("reading-config");
  const config = data ? JSON.parse(data.textContent) : null;
  const csrf = document.querySelector("[name=csrfmiddlewaretoken]")?.value;
  const returnButton = document.getElementById("reading-return");
  const rememberReturn = () => {
    try {
      sessionStorage.setItem(
        "peerpedia:reference-return",
        JSON.stringify({ url: location.href, position: scrollY }),
      );
    } catch (_) {}
  };
  document.addEventListener("click", async (event) => {
    const reference = event.target.closest(
      "a.cross-reference, a.citation, .reference-list a",
    );
    if (reference) {
      rememberReturn();
      if (returnButton) returnButton.hidden = false;
    }
    const button = event.target.closest(".copy-reference");
    if (!button) return;
    const dialog = document.getElementById("reference-copy-dialog");
    if (!dialog) return;
    const url = new URL(button.dataset.referenceUrl, location.href).href;
    dialog.querySelector("[name=permalink]").value = url;
    dialog.querySelector("[name=markdown]").value =
      `[${button.getAttribute("aria-label").replace("Copy reference to ", "")}](${url})`;
    dialog.querySelector("[name=internal]").value = button.dataset.reference;
    document.getElementById("reference-copy-status").textContent = "";
    dialog.showModal();
  });
  document.querySelectorAll("[data-copy-field]").forEach((button) => {
    button.addEventListener("click", async () => {
      const input = document.querySelector(
        `[name=${button.dataset.copyField}]`,
      );
      input.select();
      try {
        await navigator.clipboard.writeText(input.value);
        document.getElementById("reference-copy-status").textContent =
          "Copied to clipboard.";
      } catch (_) {
        document.getElementById("reference-copy-status").textContent =
          "Select the text and copy it with your keyboard.";
      }
    });
  });
  if (returnButton) {
    try {
      returnButton.hidden = !sessionStorage.getItem(
        "peerpedia:reference-return",
      );
    } catch (_) {}
    returnButton.addEventListener("click", () => {
      try {
        const value = JSON.parse(
          sessionStorage.getItem("peerpedia:reference-return"),
        );
        const url = new URL(value.url);
        if (url.origin !== location.origin) return;
        sessionStorage.setItem(
          "peerpedia:return-position",
          JSON.stringify(value),
        );
        sessionStorage.removeItem("peerpedia:reference-return");
        if (url.href === location.href) {
          scrollTo(0, value.position);
          returnButton.hidden = true;
        } else location.assign(url.href);
      } catch (_) {}
    });
    try {
      const value = JSON.parse(
        sessionStorage.getItem("peerpedia:return-position"),
      );
      if (value?.url === location.href) {
        window.addEventListener("load", () => scrollTo(0, value.position));
        sessionStorage.removeItem("peerpedia:return-position");
      }
    } catch (_) {}
  }
  if (!config || !document.getElementById("chapter-complete")) return;
  const key = `peerpedia:reading:${config.user}:${config.paper}`;
  let state = { chapter: "", position: 0, completed: {} },
    ready = false,
    timer,
    saveQueue = Promise.resolve();
  const chapter = config.chapters.find((p) => p.id === config.chapter);
  const complete = document.getElementById("chapter-complete");
  function decorate() {
    document.querySelectorAll("[data-chapter-state]").forEach((el) => {
      const page = config.chapters.find(
        (p) => p.id === el.dataset.chapterState,
      );
      const saved = state.completed[page.id];
      el.textContent = saved ? (saved === page.hash ? "✓" : "✓ Updated") : "";
    });
    complete.textContent = state.completed[chapter.id]
      ? "Mark unread"
      : "Mark complete and continue";
  }
  function store(extra = {}) {
    const run = saveQueue.catch(() => {}).then(() => saveProgress(extra));
    saveQueue = run;
    return run;
  }
  async function saveProgress(extra) {
    if (!ready) return;
    state.chapter = chapter.id;
    state.position = Math.min(
      1,
      Math.max(
        0,
        scrollY /
          Math.max(1, document.documentElement.scrollHeight - innerHeight),
      ),
    );
    if (config.progress_url) {
      const response = await fetch(config.progress_url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRFToken": csrf },
        body: JSON.stringify({
          submission: config.submission,
          chapter: chapter.id,
          position: state.position,
          ...extra,
        }),
        keepalive: true,
      });
      if (!response.ok) throw new Error("Could not save progress. Try again.");
      state = await response.json();
    } else {
      if ("complete" in extra) {
        if (extra.complete) state.completed[chapter.id] = chapter.hash;
        else delete state.completed[chapter.id];
      }
      try {
        localStorage.setItem(key, JSON.stringify(state));
      } catch (_) {}
    }
    decorate();
  }
  complete.addEventListener("click", async () => {
    const mark = !state.completed[chapter.id];
    complete.disabled = true;
    try {
      await store({ complete: mark });
      const next = document.getElementById("next-chapter");
      if (mark && next) location.assign(next.href);
    } catch (error) {
      document.getElementById("reading-status").textContent = error.message;
    } finally {
      complete.disabled = false;
    }
  });
  (async () => {
    try {
      if (config.progress_url) {
        const response = await fetch(config.progress_url);
        if (response.ok) state = await response.json();
      } else state = JSON.parse(localStorage.getItem(key)) || state;
      state.completed ||= {};
      if (!config.explicit && !location.hash && state.chapter) {
        const previous = config.chapters.find((p) => p.id === state.chapter);
        if (previous && previous.id !== chapter.id) {
          location.replace(previous.url + "&resume=1");
          return;
        }
      }
      if (
        (!config.explicit ||
          new URLSearchParams(location.search).has("resume")) &&
        !location.hash &&
        state.chapter === chapter.id
      ) {
        const restore = () =>
          scrollTo(
            0,
            state.position *
              Math.max(1, document.documentElement.scrollHeight - innerHeight),
          );
        if (document.readyState === "complete") restore();
        else window.addEventListener("load", restore, { once: true });
      }
    } catch (_) {}
    ready = true;
    decorate();
  })();
  window.addEventListener(
    "scroll",
    () => {
      clearTimeout(timer);
      timer = setTimeout(() => store().catch(() => {}), 1200);
    },
    { passive: true },
  );
  window.addEventListener("pagehide", () => {
    clearTimeout(timer);
    store().catch(() => {});
  });
})();

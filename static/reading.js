/** @returns {void} */
(() => {
  document.body.classList.add("reader-interactive");
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
  /** @param {MouseEvent} event @returns {void} */
  function handleReferenceClick(event) {
    const reference = event.target.closest(
      'a[data-reference], a.bm-citation, .bm-bibliography a, #paper-text a[href^="?chapter="], #paper-text a[href^="#"]:not(.bm-heading-link)',
    );
    if (reference) {
      rememberReturn();
      if (returnButton) returnButton.hidden = false;
    }
    const button = event.target.closest(".copy-reference");
    if (!button) return;
    const dialog = document.getElementById("reference-copy-dialog");
    if (!dialog) return;
    const citationData = document.getElementById("citation-config");
    const citation = citationData ? JSON.parse(citationData.textContent) : null;
    // A desktop reader uses a loopback URL. Shared citations must still open
    // the published snapshot on Peerpedia, not this computer's private server.
    const url = new URL(
      button.dataset.referenceUrl,
      citation?.url || location.href,
    ).href;
    dialog.querySelector("[name=permalink]").value = url;
    dialog.querySelector("[name=markdown]").value =
      `[${button.getAttribute("aria-label").replace("Copy reference to ", "")}](${url})`;
    dialog.querySelector("[name=internal]").value =
      button.dataset.reference || "";
    document.getElementById("reference-internal-label").hidden =
      !button.dataset.reference;
    document.getElementById("reference-internal-row").hidden =
      !button.dataset.reference;
    document.getElementById("reference-citation-group").hidden = !citation;
    if (citation) {
      dialog.querySelector("[name=citation]").value =
        `${citation.text} ${citation.url}`;
      dialog.querySelector("[name=paper]").value = citation.paper_url;
    }
    document.getElementById("reference-copy-status").textContent = "";
    dialog.showModal();
  }
  document.addEventListener("click", handleReferenceClick);
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
  if (!config) return;
  const key = `peerpedia:reading:${config.user}:${config.paper}`;
  let ready = false;
  let timer;
  let saveQueue = Promise.resolve();

  /** @returns {Promise<void>} */
  async function savePosition() {
    const position = Math.min(
      1,
      Math.max(
        0,
        scrollY /
          Math.max(1, document.documentElement.scrollHeight - innerHeight),
      ),
    );
    const state = { chapter: config.chapter, position };
    if (config.progress_url) {
      await fetch(config.progress_url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRFToken": csrf },
        body: JSON.stringify({ submission: config.submission, ...state }),
        keepalive: true,
      });
    } else {
      localStorage.setItem(key, JSON.stringify(state));
    }
  }

  /** @returns {void} */
  function ignoreStorageError() {}

  /** @returns {void} */
  function store() {
    if (ready)
      saveQueue = saveQueue.then(savePosition).catch(ignoreStorageError);
  }

  /** @returns {Promise<void>} */
  async function resumeReading() {
    try {
      let state;
      if (config.progress_url) {
        const response = await fetch(config.progress_url);
        if (!response.ok) throw new Error("Progress unavailable");
        state = await response.json();
      } else state = JSON.parse(localStorage.getItem(key));
      if (!location.hash && state?.chapter) {
        if (
          !config.explicit &&
          state.chapter !== config.chapter &&
          Object.hasOwn(config.chapters, state.chapter)
        ) {
          location.replace(config.chapters[state.chapter] + "&resume=1");
          return;
        }
        if (
          state.chapter === config.chapter &&
          (!config.explicit ||
            new URLSearchParams(location.search).has("resume"))
        ) {
          /** @returns {void} */
          function restore() {
            scrollTo(
              0,
              state.position *
                Math.max(
                  1,
                  document.documentElement.scrollHeight - innerHeight,
                ),
            );
          }
          if (document.readyState === "complete") restore();
          else window.addEventListener("load", restore, { once: true });
        }
      }
    } catch (_) {
      if (config.progress_url) {
        document.getElementById("reading-status").textContent =
          "Could not load reading progress. Reload the page to try again.";
        return;
      }
    }
    ready = true;
  }

  /** @returns {void} */
  function scheduleSave() {
    clearTimeout(timer);
    timer = setTimeout(store, 1200);
  }
  /** @returns {void} */
  function saveOnExit() {
    clearTimeout(timer);
    store();
  }
  resumeReading();
  window.addEventListener("scroll", scheduleSave, { passive: true });
  window.addEventListener("pagehide", saveOnExit);
})();

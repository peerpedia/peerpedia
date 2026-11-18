/** @returns {void} */
(() => {
  document.body.classList.add("reader-interactive");
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
})();

/* Native disclosures and fragment links also work when scripting is disabled. */
/** @returns {void} */
(() => {
  const contents = document.querySelector(".reader-contents");
  if (!contents) return;
  const outline = contents.querySelector(".reader-outline");
  const summary = contents.querySelector("summary");
  const toolbar = contents.closest(".reader-toolbar");
  const article = document.querySelector("main.markdown-body");
  const headings = new Map();
  for (const heading of article.querySelectorAll(
    "h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]",
  )) {
    headings.set(heading.id, heading);
  }
  const sections = [];
  for (const link of contents.querySelectorAll("[data-section]")) {
    const heading = headings.get(link.dataset.section);
    if (!heading) continue;
    sections.push({ link, heading });
    const controls = link.parentElement.querySelector("template");
    if (controls) heading.append(...controls.content.children);

    /** @returns {void} */
    function focusSection() {
      contents.open = false;
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
    }
    link.addEventListener("click", focusSection);
  }
  let active = -1;
  let scheduled = false;

  /** @returns {void} */
  function updatePosition() {
    scheduled = false;
    let index = -1;
    const threshold = Math.max(110, toolbar.offsetHeight);
    for (const [i, section] of sections.entries()) {
      if (section.heading.getBoundingClientRect().top <= threshold) index = i;
    }
    if (
      window.scrollY > 0 &&
      window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 3
    ) {
      index = sections.length - 1;
    }
    if (index === active) return;
    if (active >= 0) sections[active].link.removeAttribute("aria-current");
    active = index;
    if (index < 0) return;
    const link = sections[index].link;
    link.setAttribute("aria-current", "location");
    if (contents.open) {
      const bounds = link.getBoundingClientRect();
      const panel = outline.getBoundingClientRect();
      if (bounds.top < panel.top || bounds.bottom > panel.bottom) {
        outline.scrollTop += bounds.top - panel.top - outline.clientHeight / 3;
      }
    }
  }

  /** @returns {void} */
  function scheduleUpdate() {
    if (!scheduled) {
      scheduled = true;
      window.requestAnimationFrame(updatePosition);
    }
  }

  /** @param {KeyboardEvent} event @returns {void} */
  function closeOutline(event) {
    if (event.key === "Escape" && contents.open) {
      contents.open = false;
      summary.focus();
    }
  }
  /** @param {PointerEvent} event @returns {void} */
  function dismissOutline(event) {
    if (contents.open && !contents.contains(event.target))
      contents.open = false;
  }
  document.addEventListener("keydown", closeOutline);
  document.addEventListener("pointerdown", dismissOutline);
  window.addEventListener("scroll", scheduleUpdate, { passive: true });
  window.addEventListener("resize", scheduleUpdate);
  window.addEventListener("hashchange", scheduleUpdate);
  window.addEventListener("pageshow", scheduleUpdate);
  if ("ResizeObserver" in window) {
    new ResizeObserver(scheduleUpdate).observe(article);
  }
  scheduleUpdate();
})();

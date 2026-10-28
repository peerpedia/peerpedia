/* Section links work without JavaScript; this adds reading-position feedback. */
(() => {
  const contents = document.querySelector(".reader-contents");
  if (!contents) return;
  const navigation = contents.querySelector("nav");
  const summary = contents.querySelector("summary");
  const currentLabel = contents.querySelector(".reader-current");
  const links = Array.from(contents.querySelectorAll("[data-section]"));
  const headings = links.map((link) =>
    document.getElementById(link.dataset.section),
  );
  const desktop = window.matchMedia("(min-width: 1050px)");
  let active = -1;
  let scheduled = false;

  function updatePosition() {
    scheduled = false;
    const threshold = desktop.matches ? 120 : 110;
    let index = -1;
    headings.forEach((heading, i) => {
      if (heading.getBoundingClientRect().top <= threshold) index = i;
    });
    if (
      window.scrollY > 0 &&
      window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 3
    ) {
      index = links.length - 1;
    }
    if (index === active) return;
    links.forEach((link, i) => {
      if (i === index) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
    active = index;
    currentLabel.textContent = index < 0 ? "" : links[index].textContent;
    if (index >= 0 && desktop.matches) {
      const link = links[index];
      const linkRect = link.getBoundingClientRect();
      const navRect = navigation.getBoundingClientRect();
      if (linkRect.top < navRect.top || linkRect.bottom > navRect.bottom) {
        navigation.scrollTop +=
          linkRect.top - navRect.top - navigation.clientHeight / 3;
      }
    }
  }

  function scheduleUpdate() {
    if (!scheduled) {
      scheduled = true;
      window.requestAnimationFrame(updatePosition);
    }
  }

  function setLayout() {
    contents.open = desktop.matches;
    scheduleUpdate();
  }
  // Keep the desktop outline open; the same native disclosure is a mobile menu.
  summary.addEventListener("click", (event) => {
    if (desktop.matches) event.preventDefault();
  });
  links.forEach((link) =>
    link.addEventListener("click", () => {
      if (!desktop.matches) contents.open = false;
      const heading = document.getElementById(link.dataset.section);
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
    }),
  );
  contents.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !desktop.matches && contents.open) {
      contents.open = false;
      summary.focus();
    }
  });
  window.addEventListener("scroll", scheduleUpdate, { passive: true });
  window.addEventListener("resize", scheduleUpdate);
  window.addEventListener("hashchange", scheduleUpdate);
  window.addEventListener("pageshow", scheduleUpdate);
  desktop.addEventListener("change", setLayout);
  // Math typesetting can move headings long after the initial document layout.
  if ("ResizeObserver" in window)
    new ResizeObserver(scheduleUpdate).observe(
      document.querySelector("#paper-text"),
    );
  setLayout();
})();

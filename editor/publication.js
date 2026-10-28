export function publicationGuide({ initial, data, details, focusSource }) {
  const $ = (id) => document.getElementById(id);
  const rules = initial.publication_requirements || [];
  let serverIssues = initial.publication_issues || [];
  let baseline = data();
  let attempted = serverIssues.length > 0;
  const buttons = new Map();
  const dialog = $("publication-problems");
  function focus(field) {
    if (dialog.open) dialog.close();
    $("publication-readiness").open = false;
    if (field === "markdown") {
      $("paper-details").open = false;
      focusSource();
    } else if (details.elements[field]) {
      $("paper-details").open = true;
      const control = details.elements[field];
      const target = control.length && !control.tagName ? control[0] : control;
      target.closest("details.optional-subjects")?.setAttribute("open", "");
      target.focus();
      target.scrollIntoView({ block: "nearest" });
    } else if ($("section-metadata-help")) {
      $("publication-readiness").open = true;
      $("section-metadata-help").hidden = false;
      $("section-metadata-help").focus();
    }
  }
  for (const rule of rules) {
    const button = document.createElement("button");
    button.type = "button";
    button.addEventListener("click", () => focus(rule.field));
    $("publication-checklist").append(button);
    buttons.set(rule.field, button);
  }
  function problems() {
    const value = data();
    const result = rules
      .filter(
        (rule) =>
          !String(
            rule.field === "markdown"
              ? value.markdown
              : value.data[rule.field] || "",
          ).trim(),
      )
      .map((rule) => ({ ...rule, message: rule.help }));
    for (const control of Array.from(details.elements)) {
      const name = control.name;
      if (
        name &&
        control.validity &&
        !control.validity.valid &&
        !result.some((p) => p.field === name)
      ) {
        result.push({
          field: name,
          label: rules.find((r) => r.field === name)?.label || "Paper details",
          message: control.validationMessage,
        });
      }
    }
    for (const issue of serverIssues)
      if (!result.some((p) => p.field === issue.field)) result.push(issue);
    return result;
  }
  function refresh() {
    const value = data();
    serverIssues = serverIssues.filter(
      (issue) =>
        JSON.stringify(
          issue.field === "markdown" ? value.markdown : value.data[issue.field],
        ) ===
        JSON.stringify(
          issue.field === "markdown"
            ? baseline.markdown
            : baseline.data[issue.field],
        ),
    );
    const items = problems();
    $("publication-count").textContent = items.length || "✓";
    $("publication-count").classList.toggle(
      "needs-attention",
      items.length > 0,
    );
    $("publication-status").textContent = items.length
      ? `${items.length} ${items.length === 1 ? "item needs" : "items need"} attention before review`
      : "Ready to review";
    for (const rule of rules) {
      const missing = items.some((p) => p.field === rule.field);
      const button = buttons.get(rule.field);
      button.textContent = `${missing ? "!" : "✓"} ${rule.label}`;
      button.classList.toggle("needs-attention", missing);
      button.setAttribute(
        "aria-label",
        `${rule.label} — ${missing ? "needs attention" : "complete"}`,
      );
    }
    for (const field of new Set([
      ...rules.map((r) => r.field),
      "secondary_categories",
    ])) {
      const issue = attempted
        ? items.find((p) => p.field === field)
        : serverIssues.find((p) => p.field === field);
      const control =
        field === "markdown"
          ? $("source-editor").querySelector('[contenteditable="true"]')
          : details.querySelector(`[name="${field}"]`);
      const wrapper =
        field === "markdown" ? $("source-pane") : control?.closest(".field");
      wrapper?.classList.toggle("has-error", Boolean(issue));
      if (control) {
        if (issue) control.setAttribute("aria-invalid", "true");
        else control.removeAttribute("aria-invalid");
        const ids = new Set(
          (control.getAttribute("aria-describedby") || "")
            .split(" ")
            .filter(Boolean),
        );
        const errorId = `publication-error-${field}`;
        if (issue) ids.add(errorId);
        else ids.delete(errorId);
        if (ids.size)
          control.setAttribute("aria-describedby", [...ids].join(" "));
        else control.removeAttribute("aria-describedby");
      }
      const error = $(`publication-error-${field}`);
      if (error) {
        error.hidden = !issue;
        error.textContent = issue?.message || "";
      }
    }
    return items;
  }
  function showProblems() {
    attempted = true;
    const items = refresh();
    if (!items.length) return false;
    const list = $("publication-problem-list");
    list.replaceChildren();
    for (const item of items) {
      const li = document.createElement("li"),
        button = document.createElement("button"),
        label = document.createElement("strong");
      label.textContent = item.label;
      button.type = "button";
      button.append(label, document.createTextNode(item.message));
      button.addEventListener("click", () => focus(item.field));
      li.append(button);
      list.append(li);
    }
    $("publication-problems-help").textContent =
      "Nothing has been published. Select an item to correct it. Your text stays in this draft.";
    if (!dialog.open) dialog.showModal();
    return true;
  }
  $("publication-problems-close").addEventListener("click", () =>
    dialog.close(),
  );
  refresh();
  if (serverIssues.length) showProblems();
  return {
    refresh,
    showProblems,
    serverErrors(fields) {
      baseline = data();
      serverIssues = Object.entries(fields).flatMap(([field, errors]) =>
        errors.map((e) => ({
          field: field === "file" ? "markdown" : field,
          label:
            rules.find((r) => r.field === field)?.label ||
            (field === "secondary_categories"
              ? "Cross-list subjects"
              : "Paper details"),
          message: e.message,
        })),
      );
      attempted = true;
      refresh();
      return serverIssues
        .map((issue) => `${issue.label} — ${issue.message}`)
        .join(" ");
    },
  };
}

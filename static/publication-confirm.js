(() => {
  const form = document.querySelector("[data-publication-confirm]");
  if (!form) return;
  const dialog = document.getElementById("publication-problems");
  form.noValidate = true;
  function errors() {
    const problems = [];
    for (const input of form.elements) {
      if (!input.willValidate) continue;
      const wrapper = input.closest(".field") || input.closest("p");
      const invalid = !input.validity.valid;
      wrapper?.classList.toggle("has-error", invalid);
      if (invalid) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
      let hint = wrapper?.querySelector("[data-confirm-error]");
      if (!hint && wrapper) {
        hint = document.createElement("p");
        hint.className = "publication-field-error";
        hint.dataset.confirmError = "";
        hint.id = `confirmation-error-${input.name}`;
        wrapper.append(hint);
      }
      const message =
        input.name === "license"
          ? "Choose the license you want readers to use."
          : ["rights_confirmed", "confirm"].includes(input.name)
            ? "Confirm that you reviewed this submission and have permission to publish it."
            : input.validationMessage;
      if (hint) {
        hint.textContent = invalid ? message : "";
        hint.hidden = !invalid;
        if (invalid) input.setAttribute("aria-describedby", hint.id);
        else if (input.getAttribute("aria-describedby") === hint.id)
          input.removeAttribute("aria-describedby");
      }
      if (invalid)
        problems.push({
          input,
          message,
          label:
            input.name === "license"
              ? "Content license"
              : "Publication permission",
        });
    }
    return problems;
  }
  function show(items) {
    const list = document.getElementById("publication-problem-list");
    list.replaceChildren();
    for (const item of items) {
      const li = document.createElement("li"),
        button = document.createElement("button"),
        title = document.createElement("strong");
      button.type = "button";
      title.textContent = item.label;
      button.append(title, document.createTextNode(item.message));
      button.addEventListener("click", () => {
        dialog.close();
        item.input.focus();
        item.input.scrollIntoView({ block: "center" });
      });
      li.append(button);
      list.append(li);
    }
    document.getElementById("publication-problems-close").textContent =
      "Back to confirmation";
    if (!dialog.open) dialog.showModal();
  }
  let attempted = false;
  form.addEventListener("submit", (event) => {
    attempted = true;
    const missing = errors();
    if (missing.length) {
      event.preventDefault();
      show(missing);
    }
  });
  form.addEventListener("input", () => {
    if (attempted) errors();
  });
  document
    .getElementById("publication-problems-close")
    .addEventListener("click", () => dialog.close());
  if (form.querySelector(".field-errors")) {
    attempted = true;
    const missing = errors();
    if (missing.length) show(missing);
  }
})();

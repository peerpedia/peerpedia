const rebaseForm = document.getElementById("rebase-form");
rebaseForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.getElementById("rebase-status");
  try {
    const response = await fetch(location.pathname, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": rebaseForm.elements.csrfmiddlewaretoken.value,
      },
      body: JSON.stringify({
        revision: Number(rebaseForm.elements.revision.value),
        latest: rebaseForm.elements.latest.value,
        target: rebaseForm.elements.target?.value || "",
      }),
    });
    if (response.redirected)
      throw new Error("Please sign in again, then return to this comparison.");
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || "Could not update the base.");
    location.assign(rebaseForm.dataset.editor);
  } catch (error) {
    status.textContent = error.message;
  }
});

import { EditorView, placeholder } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";

const initial = JSON.parse(document.getElementById("editor-data").textContent);
const $ = (id) => document.getElementById(id);
const details = $("details-form");
const csrf = $("review-form").elements.csrfmiddlewaretoken.value;
const workspace = $("workspace");
const previewPane = $("preview-pane");
const preview = $("draft-preview");
const mobile = matchMedia("(max-width:760px)");
let revision = initial.revision;
let saved,
  saving,
  saveTimer,
  previewTimer,
  previewGeneration = 0;
let resolving = null,
  recovery = null,
  changingCopy = false,
  leaving = false;
let headings = [],
  followLocked = false,
  openedSection = false;
let renderQueue = Promise.resolve();
const recoveryPrefix = `peerpedia:draft:${initial.user_id}:${initial.id}:`;
let clientId;
try {
  clientId =
    sessionStorage.getItem("peerpedia:editor-tab") || crypto.randomUUID();
  sessionStorage.setItem("peerpedia:editor-tab", clientId);
} catch (_) {
  clientId = crypto.randomUUID();
}
const recoveryKey = recoveryPrefix + clientId;
try {
  const copies = Object.keys(localStorage)
    .filter((k) => k.startsWith(recoveryPrefix))
    .map((k) => ({ key: k, ...JSON.parse(localStorage.getItem(k)) }));
  recovery = copies.sort((a, b) => b.time - a.time)[0] || null;
} catch (_) {
  /* Storage can be disabled; server saving remains available. */
}

const view = new EditorView({
  state: EditorState.create({
    doc: initial.markdown,
    extensions: [
      basicSetup,
      markdown(),
      placeholder(
        "# Your note title\n\nStart writing in Markdown…\n\nUse ## for sections, $x^2$ for inline math, and $$ for display equations.",
      ),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        "aria-label": "Markdown source",
        spellcheck: "false",
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !changingCopy) changed();
      }),
      EditorView.domEventHandlers({
        scroll: () => {
          followSource();
        },
      }),
    ],
  }),
  parent: $("source-editor"),
});
function data() {
  const fields = new FormData(details),
    result = {};
  if (initial.is_section)
    return {
      data: { ...initial.data, explanation: fields.get("explanation") || "" },
      markdown: view.state.doc.toString(),
    };
  for (const key of [
    "title",
    "authors",
    "abstract",
    "primary_category",
    "explanation",
  ])
    result[key] = fields.get(key) || "";
  result.secondary_categories = fields.getAll("secondary_categories").sort();
  return { data: result, markdown: view.state.doc.toString() };
}
function serial(value = data()) {
  return JSON.stringify(value);
}
saved = serial();
function status(text) {
  $("save-status").textContent = text;
}
function warn(text) {
  $("editor-alert").textContent = text;
  $("editor-alert").hidden = !text;
}
function backup() {
  try {
    localStorage.setItem(
      recoveryKey,
      JSON.stringify({ contents: data(), revision, time: Date.now() }),
    );
  } catch (_) {
    warn(
      "Browser recovery storage is unavailable. Keep this tab open until the draft is saved, or download your Markdown.",
    );
  }
}
function clearBackup() {
  try {
    localStorage.removeItem(recoveryKey);
  } catch (_) {}
}
function changed() {
  $("draft-title").textContent =
    details.elements.title?.value || initial.data.title || "Untitled paper";
  status("Unsaved changes");
  backup();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save().catch(() => {}), 850);
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updatePreview, 500);
}
details.addEventListener("input", changed);
details.addEventListener("change", changed);
details.addEventListener("submit", (event) => event.preventDefault());
$("close-details").addEventListener("click", () => {
  $("paper-details").open = false;
  $("paper-details").querySelector("summary").focus();
});
async function post(url, body, options = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRFToken": csrf },
    body: JSON.stringify(body),
    ...options,
  });
  if (response.redirected || response.status === 403)
    throw new Error(
      "Your session needs attention. Sign in in another tab, then return here. Your text is preserved.",
    );
  let result;
  try {
    result = await response.json();
  } catch (_) {
    throw new Error(
      "Could not save or preview. Check your connection and try again.",
    );
  }
  if (!response.ok) {
    if (response.status === 409 && result.draft) showConflict(result.draft);
    const fields = result.fields
      ? Object.entries(result.fields)
          .map(
            ([key, errors]) =>
              `${key}: ${errors.map((e) => e.message).join(" ")}`,
          )
          .join(" ")
      : "";
    throw new Error(
      fields || result.error || "The request could not be completed.",
    );
  }
  return result;
}
function updateState(result) {
  revision = result.revision;
  $("review-revision").value = revision;
  $("discard-revision").value = revision;
  $("stale-banner").hidden = !result.stale;
  initial.stale = result.stale;
}
async function save() {
  clearTimeout(saveTimer);
  if (resolving || !$("recovery").hidden)
    throw new Error("Choose which draft copy to continue with first.");
  if (saving) {
    await saving;
    return serial() === saved ? undefined : save();
  }
  const captured = data(),
    encoded = serial(captured);
  if (encoded === saved) return;
  status("Saving…");
  saving = (async () => {
    try {
      const result = await post(initial.save_url, { revision, ...captured });
      updateState(result);
      saved = encoded;
      warn("");
      if (serial() === saved) {
        clearBackup();
        status("Saved");
      } else {
        backup();
        status("Unsaved changes");
        saveTimer = setTimeout(() => save().catch(() => {}), 850);
      }
    } catch (error) {
      status(resolving ? "Save conflict" : "Couldn’t save");
      backup();
      warn(error.message);
      throw error;
    } finally {
      saving = null;
    }
  })();
  return saving;
}
function showConflict(server) {
  resolving = server;
  $("conflict").hidden = false;
  if (server.submitted_url) {
    $("conflict-message").textContent =
      "This draft was submitted in another tab. Your current text is preserved here. Download it before opening a new draft.";
    $("use-server").textContent = "Open submitted snapshot";
    $("use-local").hidden = true;
  }
}
function replaceCopy(contents) {
  changingCopy = true;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: contents.markdown },
  });
  changingCopy = false;
  for (const key of [
    "title",
    "authors",
    "abstract",
    "primary_category",
    "explanation",
  ])
    if (details.elements[key])
      details.elements[key].value = contents.data[key] || "";
  details.querySelectorAll("[name=secondary_categories]").forEach((el) => {
    el.checked = (contents.data.secondary_categories || []).includes(el.value);
  });
  $("draft-title").textContent = contents.data.title || "Untitled paper";
  updatePreview();
}
$("use-server").addEventListener("click", () => {
  if (
    !confirm(
      "Replace the text in this editor with the saved copy? Download your Markdown first if you want to keep it.",
    )
  )
    return;
  if (resolving.submitted_url) {
    clearBackup();
    leaving = true;
    location.assign(resolving.submitted_url);
    return;
  }
  replaceCopy(resolving);
  updateState(resolving);
  saved = serial();
  resolving = null;
  $("conflict").hidden = true;
  clearBackup();
  warn("");
  status("Saved");
});
$("use-local").addEventListener("click", async () => {
  if (
    !confirm(
      "Save this editor’s contents over the newer saved draft? Published snapshots will not change.",
    )
  )
    return;
  updateState(resolving);
  saved = serial({ data: resolving.data, markdown: resolving.markdown });
  resolving = null;
  $("conflict").hidden = true;
  await save().catch(() => {});
});
if (recovery && serial(recovery.contents) !== saved) {
  $("recovery").hidden = false;
  status("Recovery copy available");
}
$("restore-recovery").addEventListener("click", () => {
  replaceCopy(recovery.contents);
  $("recovery").hidden = true;
  // An old recovery copy must never overwrite a newer server save without a choice.
  if (recovery.revision !== revision) {
    showConflict(initial);
    backup();
  } else changed();
  try {
    if (recovery.key !== recoveryKey) localStorage.removeItem(recovery.key);
  } catch (_) {}
});
$("dismiss-recovery").addEventListener("click", () => {
  try {
    localStorage.removeItem(recovery.key);
  } catch (_) {}
  $("recovery").hidden = true;
  status("Saved");
});
window.addEventListener("online", () => save().catch(() => {}));
window.addEventListener("offline", () => {
  status("Offline");
  warn(
    "You are offline. Changes will stay in browser recovery until the connection returns.",
  );
});
window.addEventListener("beforeunload", (event) => {
  if (serial() !== saved && !leaving) {
    backup();
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener("pagehide", () => {
  if (serial() !== saved && !leaving) backup();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) save().catch(() => {});
});
$("review-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("review-button").disabled = true;
  try {
    await save();
    if (serial() !== saved) await save();
    if (!initial.base) {
      const missing = ["title", "authors", "abstract", "primary_category"].find(
        (name) => !details.elements[name].value.trim(),
      );
      if (missing) {
        $("paper-details").open = true;
        details.elements[missing].focus();
        throw new Error(
          "Add your title, authors, abstract, and primary subject in Paper details before reviewing. Your draft is saved.",
        );
      }
      if (!view.state.doc.toString().trim()) {
        $("paper-details").open = false;
        view.focus();
        throw new Error(
          "Write your note or import a Markdown file before reviewing. Your details are saved.",
        );
      }
    }
    leaving = true;
    $("review-form").submit();
  } catch (error) {
    warn(error.message);
    $("review-button").disabled = false;
  }
});
$("compare-latest").addEventListener("click", async (event) => {
  event.preventDefault();
  const target = event.currentTarget.href;
  try {
    await save();
    leaving = true;
    location.assign(target);
  } catch (error) {
    warn(error.message);
  }
});
$("download-draft").addEventListener("click", () => {
  const blob = new Blob([view.state.doc.toString()], {
    type: "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = "peerpedia-draft.md";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("import-draft").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".md") || file.size > 1024 * 1024) {
    warn("Choose a Markdown file up to 1 MB.");
    return;
  }
  if (
    view.state.doc.length &&
    !confirm(
      "Replace the draft text with this file? Paper details stay unchanged. You can undo the import.",
    )
  )
    return;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      await file.arrayBuffer(),
    );
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    });
  } catch (_) {
    warn("This file is not valid UTF-8 Markdown.");
  }
});
$("discard-draft").addEventListener("click", async () => {
  if (
    !confirm(
      "Discard this private draft? Published papers and PR snapshots will remain unchanged.",
    )
  )
    return;
  clearTimeout(saveTimer);
  try {
    if (saving) await saving;
    if (resolving)
      throw new Error(
        "Resolve the saved-copy conflict before discarding this draft.",
      );
    leaving = true;
    clearBackup();
    $("discard-form").submit();
  } catch (error) {
    warn(error.message);
  }
});

async function updatePreview() {
  clearTimeout(previewTimer);
  const generation = ++previewGeneration,
    source = view.state.doc.toString();
  $("preview-status").textContent = "Updating preview…";
  try {
    const result = await post(initial.preview_url, {
      revision,
      markdown: source,
    });
    if (generation !== previewGeneration) return;
    renderQueue = renderQueue
      .catch(() => {})
      .then(async () => {
        if (generation !== previewGeneration) return;
        if (window.MathJax?.startup?.promise)
          await window.MathJax.startup.promise;
        if (generation !== previewGeneration) return;
        window.MathJax?.typesetClear?.([preview]);
        preview.innerHTML = result.html;
        preview.querySelectorAll(".math.inline,.math.block").forEach((node) => {
          const block = node.classList.contains("block");
          node.textContent =
            (block ? "\\[" : "\\(") +
            node.textContent +
            (block ? "\\]" : "\\)");
        });
        if (window.MathJax?.typesetPromise)
          await window.MathJax.typesetPromise([preview]);
        headings = Array.from(preview.querySelectorAll("[data-source-line]"));
        $("preview-status").textContent = source.trim()
          ? "Preview · same renderer as the published paper"
          : "Your formatted note will appear here as you write.";
        if (!openedSection) {
          openedSection = true;
          const heading = headings.find((el) => el.id === initial.section);
          if (heading) {
            goToLine(Number(heading.dataset.sourceLine), false);
            previewPane.scrollTop = heading.offsetTop - preview.offsetTop;
          }
        }
      });
    await renderQueue;
  } catch (error) {
    $("preview-status").textContent = "Preview unavailable · " + error.message;
  }
}
function goToLine(line, focus = true) {
  const pos = view.state.doc.line(
    Math.min(Math.max(line, 1), view.state.doc.lines),
  ).from;
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 24 }),
  });
  if (focus) view.focus();
}
preview.addEventListener("click", (event) => {
  const heading = event.target.closest("[data-source-line]");
  if (!heading) return;
  goToLine(Number(heading.dataset.sourceLine));
  if (mobile.matches) setLayout("source");
});
function followSource() {
  if (
    followLocked ||
    !$("sync-scroll").checked ||
    !headings.length ||
    workspace.dataset.layout !== "split"
  )
    return;
  const top = view.scrollDOM.getBoundingClientRect().top;
  const pos = view.posAtCoords({
    x: view.contentDOM.getBoundingClientRect().left + 4,
    y: top + 30,
  });
  if (pos == null) return;
  const line = view.state.doc.lineAt(pos).number;
  let target = headings[0];
  for (const el of headings) {
    if (Number(el.dataset.sourceLine) <= line) target = el;
  }
  followLocked = true;
  previewPane.scrollTop = target.offsetTop - preview.offsetTop;
  setTimeout(() => (followLocked = false), 100);
}
previewPane.addEventListener(
  "scroll",
  () => {
    if (
      followLocked ||
      !$("sync-scroll").checked ||
      !headings.length ||
      workspace.dataset.layout !== "split"
    )
      return;
    let target = headings[0];
    const top = previewPane.getBoundingClientRect().top;
    for (const el of headings)
      if (el.getBoundingClientRect().top < top + 80) target = el;
    const pos = view.state.doc.line(
      Math.min(Number(target.dataset.sourceLine), view.state.doc.lines),
    ).from;
    followLocked = true;
    view.dispatch({
      effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 24 }),
    });
    setTimeout(() => (followLocked = false), 100);
  },
  { passive: true },
);
function setLayout(layout) {
  if (mobile.matches && layout === "split") layout = "source";
  workspace.dataset.layout = layout;
  document.querySelectorAll("[data-layout]").forEach((el) => {
    if (el.tagName === "BUTTON")
      el.setAttribute("aria-pressed", String(el.dataset.layout === layout));
  });
  view.requestMeasure();
}
document
  .querySelectorAll("button[data-layout]")
  .forEach((el) =>
    el.addEventListener("click", () => setLayout(el.dataset.layout)),
  );
mobile.addEventListener("change", () =>
  setLayout(mobile.matches ? "source" : "split"),
);
setLayout(mobile.matches ? "source" : "split");
const divider = $("pane-divider");
function resize(value) {
  const percent = Math.min(75, Math.max(25, value));
  $("source-pane").style.width = percent + "%";
  divider.setAttribute("aria-valuenow", String(Math.round(percent)));
  view.requestMeasure();
}
divider.addEventListener("pointerdown", (event) => {
  divider.setPointerCapture(event.pointerId);
});
divider.addEventListener("pointermove", (event) => {
  if (divider.hasPointerCapture(event.pointerId)) {
    const box = workspace.getBoundingClientRect();
    resize(((event.clientX - box.left) / box.width) * 100);
  }
});
divider.addEventListener("pointerup", (event) => {
  divider.releasePointerCapture(event.pointerId);
});
divider.addEventListener("keydown", (event) => {
  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    resize(
      event.key === "Home"
        ? 25
        : event.key === "End"
          ? 75
          : Number(divider.getAttribute("aria-valuenow")) +
            (event.key === "ArrowLeft" ? -5 : 5),
    );
  }
});
updatePreview();

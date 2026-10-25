export function chapterWorkspace({
  initial,
  view,
  changed,
  replaceText,
  preview,
  warn,
}) {
  const $ = (id) => document.getElementById(id);
  let chapters = structuredClone(initial.chapters || []),
    bibliography = initial.bibliography || "";
  let active =
    chapters.find((p) => p.id === initial.chapter)?.id ||
    chapters[0]?.id ||
    "main";
  let previewCopy = "";
  let targets = [],
    currentResults = [],
    dragged = null;
  const controls = $("chapter-panel");
  if (initial.is_section) controls.hidden = true;
  function sync() {
    const page = chapters.find((p) => p.id === active);
    if (page) page.markdown = view.state.doc.toString();
  }
  function switchTo(id) {
    if (id === active) return;
    sync();
    const page = chapters.find((p) => p.id === id);
    if (!page) return;
    active = id;
    replaceText(page.markdown);
    draw();
    preview();
  }
  function draw() {
    $("chapter-list").replaceChildren();
    const list = chapters.length
      ? chapters
      : [{ id: "main", title: "Single-page note" }];
    list.forEach((page, index) => {
      const row = document.createElement("li"),
        button = document.createElement("button");
      button.type = "button";
      button.textContent = `${index + 1}. ${page.title}`;
      button.setAttribute("aria-current", String(page.id === active));
      button.addEventListener("click", () => switchTo(page.id));
      row.append(button);
      row.draggable = chapters.length > 1;
      row.addEventListener("dragstart", () => {
        dragged = page.id;
      });
      row.addEventListener("dragover", (event) => event.preventDefault());
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        if (!dragged || dragged === page.id) return;
        sync();
        const from = chapters.findIndex((p) => p.id === dragged),
          to = chapters.findIndex((p) => p.id === page.id);
        chapters.splice(to, 0, chapters.splice(from, 1)[0]);
        dragged = null;
        draw();
        changed();
      });
      $("chapter-list").append(row);
    });
    for (const id of [
      "rename-chapter",
      "delete-chapter",
      "chapter-up",
      "chapter-down",
    ])
      $(id).disabled = !chapters.length;
    $("active-chapter").textContent =
      chapters.find((p) => p.id === active)?.title || "Your note";
  }
  $("add-chapter").addEventListener("click", () => {
    const title = prompt("Chapter title");
    if (!title?.trim()) return;
    sync();
    if (!chapters.length)
      chapters = [
        {
          id: "main",
          title: initial.data.title || "Introduction",
          markdown: view.state.doc.toString(),
        },
      ];
    const page = { id: crypto.randomUUID(), title: title.trim(), markdown: "" };
    chapters.push(page);
    active = page.id;
    replaceText("");
    draw();
    changed();
    view.focus();
  });
  $("rename-chapter").addEventListener("click", () => {
    const page = chapters.find((p) => p.id === active);
    if (!page) return;
    const title = prompt("Chapter title", page.title);
    if (!title?.trim()) return;
    page.title = title.trim();
    draw();
    changed();
  });
  $("delete-chapter").addEventListener("click", () => {
    if (chapters.length <= 1) {
      warn("Keep at least one chapter.");
      return;
    }
    if (
      !confirm(
        "Delete this chapter from the draft? Published versions remain available.",
      )
    )
      return;
    chapters = chapters.filter((p) => p.id !== active);
    active = chapters[0].id;
    replaceText(chapters[0].markdown);
    draw();
    changed();
  });
  for (const [id, delta] of [
    ["chapter-up", -1],
    ["chapter-down", 1],
  ])
    $(id).addEventListener("click", () => {
      sync();
      const at = chapters.findIndex((p) => p.id === active),
        to = at + delta;
      if (to < 0 || to >= chapters.length) return;
      [chapters[at], chapters[to]] = [chapters[to], chapters[at]];
      draw();
      changed();
    });
  $("edit-bibliography").addEventListener("click", () => {
    $("bib-source").value = bibliography;
    $("bib-dialog").showModal();
  });
  $("bib-source").addEventListener("input", () => {
    bibliography = $("bib-source").value;
    changed();
  });
  $("import-bib").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 1024 * 1024 || !file.name.endsWith(".bib")) {
      warn("Choose a .bib file up to 1 MB.");
      return;
    }
    if (
      bibliography &&
      !confirm(
        "Replace the bibliography? Existing citations may need updating.",
      )
    )
      return;
    try {
      bibliography = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      $("bib-source").value = bibliography;
      changed();
    } catch (_) {
      warn("Use a UTF-8 bibliography.");
    }
  });
  function bibEscape(value) {
    return value
      .replace(/[{}]/g, "")
      .replaceAll("\\", "\\textbackslash{} ")
      .replaceAll("\n", " ");
  }
  function addEntry({ key, title, authors, year, url, snapshot_identifier }) {
    if (!/^[A-Za-z][A-Za-z0-9_:-]*$/.test(key))
      throw new Error(
        "Use a citation key starting with a letter, without spaces.",
      );
    const snapshotNote = snapshot_identifier
      ? `  note = {Peerpedia snapshot ${bibEscape(snapshot_identifier)}},\n`
      : "";
    bibliography += `\n@misc{${key},\n  title = {${bibEscape(title)}},\n  author = {${bibEscape(authors)}},\n  year = {${bibEscape(String(year || ""))}},\n${snapshotNote}  url = {${bibEscape(url)}}\n}\n`;
    $("bib-source").value = bibliography;
    changed();
    return key;
  }
  $("bib-entry-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const fields = new FormData(event.target);
    try {
      addEntry({
        ...Object.fromEntries(fields),
        authors: fields.get("bib_authors") || "",
      });
      event.target.reset();
      $("bib-entry-status").textContent = "Added to references.bib.";
    } catch (error) {
      $("bib-entry-status").textContent = error.message;
    }
  });
  function insert(text) {
    const selection = view.state.selection.main;
    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert: text },
      selection: { anchor: selection.from + text.length },
    });
    $("link-dialog").close();
    view.focus();
  }
  function makePersistent(target) {
    if (target.explicit) return true;
    sync();
    if (
      previewCopy !==
      JSON.stringify({
        chapters,
        bibliography,
        chapter: active,
        markdown: view.state.doc.toString(),
      })
    ) {
      warn(
        "The text changed. Wait for the preview to update, then choose the reference again.",
      );
      return false;
    }
    const page = chapters.find((p) => p.id === target.chapter);
    const source = page?.markdown ?? view.state.doc.toString();
    const lines = source.split("\n");
    const start = lines
      .slice(0, target.line - 1)
      .reduce((n, line) => n + line.length + 1, 0);
    let change;
    if (target.kind === "equation") {
      const end = lines
        .slice(0, target.end_line)
        .reduce((n, line) => n + line.length + 1, 0);
      const text = source.slice(start, Math.min(end, source.length));
      change = {
        from: start,
        to: Math.min(end, source.length),
        insert: `::: equation {#${target.label}}\n${text}\n:::\n`,
      };
    } else {
      const end = start + lines[target.line - 1].length;
      change = { from: end, to: end, insert: ` {#${target.label}}` };
    }
    if (target.chapter === active) view.dispatch({ changes: change });
    else if (page)
      page.markdown =
        source.slice(0, change.from) + change.insert + source.slice(change.to);
    target.explicit = true;
    changed();
    return true;
  }
  function showTargets(items, external = false) {
    const result = $("link-results");
    result.replaceChildren();
    items.forEach((target) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${target.text || target.title}${target.title && target.text ? " · " + target.title : ""}`;
      button.addEventListener("click", () => {
        if (target.kind === "citation") {
          insert("[@" + target.label + "]");
          return;
        }
        if (!external && !makePersistent(target)) return;
        insert(
          external
            ? `[${target.text || target.title}](${new URL(target.url, location.origin).href})`
            : "@" + target.label,
        );
      });
      result.append(button);
    });
    if (!items.length) result.textContent = "No matching targets.";
  }
  $("insert-reference").addEventListener("click", () => {
    showTargets(targets);
    $("link-dialog").showModal();
  });
  $("local-references").addEventListener("click", () =>
    showTargets(
      targets.filter((t) =>
        (t.title + " " + t.text)
          .toLowerCase()
          .includes($("link-query").value.toLowerCase()),
      ),
    ),
  );
  $("search-papers").addEventListener("click", async () => {
    try {
      const response = await fetch(
        initial.references_url +
          "?q=" +
          encodeURIComponent($("link-query").value),
      );
      if (!response.ok) throw new Error("Search is unavailable.");
      currentResults = (await response.json()).papers;
      $("link-results").replaceChildren();
      for (const paper of currentResults) {
        const row = document.createElement("div"),
          cite = document.createElement("button"),
          browse = document.createElement("button"),
          label = document.createElement("p");
        label.textContent = `${paper.title} · ${paper.authors} · ${paper.snapshot_identifier}`;
        cite.textContent = "Cite frozen version";
        browse.textContent = "Sections and equations";
        cite.type = browse.type = "button";
        cite.addEventListener("click", () => {
          if (initial.is_section) {
            warn("Add new bibliography entries in the full-paper editor.");
            $("link-dialog").close();
            return;
          }
          const key = "pp" + paper.submission.replaceAll("-", "");
          if (!bibliography.includes("{" + key + ","))
            addEntry({
              key,
              ...paper,
              authors: paper.authors.split("\n").join(" and "),
            });
          insert("[@" + key + "]");
        });
        browse.addEventListener("click", async () => {
          try {
            const response = await fetch(
              initial.references_url + "?submission=" + paper.submission,
            );
            if (!response.ok) throw new Error();
            const result = await response.json();
            showTargets([...result.chapters, ...result.targets], true);
          } catch (_) {
            $("link-results").textContent =
              "Could not load targets. Try again.";
          }
        });
        row.append(label, cite, browse);
        $("link-results").append(row);
      }
    } catch (error) {
      $("link-results").textContent = error.message;
    }
  });
  $("insert-block").addEventListener("change", (event) => {
    const kind = event.target.value;
    event.target.value = "";
    if (!kind) return;
    const id = kind + ":" + crypto.randomUUID().slice(0, 8);
    const body =
      kind === "figure"
        ? "```tikzpicture\n\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}\n```"
        : kind === "table"
          ? "| A | B |\n|---|---|\n| 1 | 2 |"
          : kind === "equation" || kind === "unnumbered"
            ? "$$\nx = 1\n$$"
            : "Write here.";
    const suffix = ["proof", "unnumbered"].includes(kind)
      ? ""
      : " {#" + id + "}";
    const selection = view.state.selection.main;
    view.dispatch({
      changes: {
        from: selection.from,
        to: selection.to,
        insert: `\n::: ${kind}${suffix}\n${body}\n:::\n`,
      },
    });
    view.focus();
  });
  draw();
  return {
    initialText: () =>
      chapters.find((p) => p.id === active)?.markdown ?? initial.markdown,
    payload: () => {
      sync();
      return {
        chapters: structuredClone(chapters),
        bibliography,
        markdown: chapters.length
          ? chapters.map((p) => p.markdown).join("\n\n")
          : view.state.doc.toString(),
      };
    },
    preview: () => {
      sync();
      return {
        chapters: structuredClone(chapters),
        bibliography,
        chapter: active,
        markdown: view.state.doc.toString(),
      };
    },
    replace: (contents) => {
      chapters = structuredClone(contents.chapters || []);
      bibliography = contents.bibliography || "";
      active = chapters.some((p) => p.id === active)
        ? active
        : chapters[0]?.id || "main";
      draw();
      return (
        chapters.find((p) => p.id === active)?.markdown ?? contents.markdown
      );
    },
    rendered: (result, copy) => {
      previewCopy = JSON.stringify(copy);
      targets = result.targets || [];
      $("reference-warnings").textContent = (result.warnings || []).join(" ");
    },
    navigate: (url) => {
      const next = new URL(url, location.href);
      const id = next.searchParams.get("chapter");
      if (id && chapters.some((p) => p.id === id)) {
        switchTo(id);
        return true;
      }
      return false;
    },
  };
}

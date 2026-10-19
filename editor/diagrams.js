import DOMPurify from "dompurify";

const config = document.querySelector("[data-diagram-worker]");
const queue = [];
const observed = new Set();
const cache = new Map();
let cacheSize = 0;
let active = null;
let serial = 0;

// The converter output is untrusted. Only static SVG geometry and local font
// names survive. In particular, TeX specials cannot add HTML, scripts or URLs.
DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
  // CSS escapes can disguise url() inside SVG presentation attributes.
  if (/[\\\u0000-\u001f\u007f]/.test(data.attrValue)) data.keepAttr = false;
  if (data.attrName === "style") {
    const font = /^font-family:\s*([a-z][a-z0-9]{1,30});?\s*$/i.exec(
      data.attrValue,
    );
    if (font) node.setAttribute("font-family", font[1]);
    data.keepAttr = false;
  }
  if (/href$/i.test(data.attrName) && !/^#[\w:-]+$/.test(data.attrValue))
    data.keepAttr = false;
  if (
    /url\s*\(/i.test(data.attrValue) &&
    !/^url\(#[\w:-]+\)$/.test(data.attrValue)
  )
    data.keepAttr = false;
});

function safeDiagram(result) {
  if (
    typeof result.html !== "string" ||
    result.html.length > 2000000 ||
    !Number.isFinite(result.width) ||
    !Number.isFinite(result.height) ||
    result.width <= 0 ||
    result.height <= 0 ||
    result.width > 10000 ||
    result.height > 10000
  )
    throw new Error("The diagram has invalid dimensions or is too large.");
  const fragment = DOMPurify.sanitize(result.html, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: [
      "svg",
      "g",
      "path",
      "text",
      "tspan",
      "defs",
      "clipPath",
      "use",
      "rect",
      "circle",
      "ellipse",
      "line",
      "polyline",
      "polygon",
      "linearGradient",
      "radialGradient",
      "stop",
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    FORBID_ATTR: ["name"],
  });
  const svg = fragment.querySelector("svg");
  if (
    !svg ||
    fragment.querySelectorAll("svg").length !== 1 ||
    svg.querySelectorAll("*").length > 10000
  )
    throw new Error("The compiler did not produce a supported diagram.");
  // TeX uses a 10 pt base font; match the surrounding paper text.
  svg.setAttribute("width", result.width / 10 + "em");
  svg.setAttribute("height", result.height / 10 + "em");
  svg.setAttribute("viewBox", `-72 -72 ${result.width} ${result.height}`);
  return svg;
}

function display(node, svg) {
  const copy = svg.cloneNode(true);
  // Independent pictures may generate identical PGF identifiers.
  const prefix = `diagram-${++serial}-`;
  for (const element of [copy, ...copy.querySelectorAll("*")]) {
    if (element.id) element.id = prefix + element.id;
    for (const attribute of [...element.attributes]) {
      let value = attribute.value.replace(
        /url\(#([\w:-]+)\)/g,
        `url(#${prefix}$1)`,
      );
      if (/href$/i.test(attribute.name) && value.startsWith("#"))
        value = "#" + prefix + value.slice(1);
      element.setAttribute(attribute.name, value);
    }
  }
  node.querySelector(".diagram-output").replaceChildren(copy);
  node.querySelector(".diagram-status").hidden = true;
  node.dataset.diagramState = "ready";
}

function failure(node, message, log = "") {
  node.dataset.diagramState = "error";
  node.querySelector(".diagram-status").textContent = message;
  node.querySelector(".diagram-source").open = true;
  if (log) {
    const details = document.createElement("details");
    details.className = "diagram-diagnostics";
    const summary = document.createElement("summary");
    summary.textContent = "Compiler details";
    const pre = document.createElement("pre");
    pre.textContent = log.slice(-8000);
    details.append(summary, pre);
    node.append(details);
  }
}

async function savedDiagram(node) {
  const start = Date.now();
  let delay = 1000;
  while (node.isConnected && Date.now() - start < 120000) {
    try {
      const response = await fetch(node.dataset.savedUrl, {
        credentials: "omit",
      });
      if (!response.ok) throw new Error("Diagram is not ready yet.");
      const data = await response.json();
      if (data.status === "error") return failure(node, data.error);
      if (data.status === "ready") {
        const url = new URL(data.url, location.origin);
        if (
          url.origin !== location.origin ||
          !/^\/diagrams\/[a-f0-9]{64}\.svg$/.test(url.pathname)
        )
          throw new Error("Invalid diagram URL.");
        const img = document.createElement("img");
        img.alt = "TeX diagram";
        img.onload = () => {
          node.dataset.diagramState = "ready";
          node.querySelector(".diagram-status").hidden = true;
        };
        img.onerror = () =>
          failure(node, "Could not load this diagram. Reload to try again.");
        img.src = url.href;
        node.querySelector(".diagram-output").replaceChildren(img);
        return;
      }
    } catch {
      /* A queued job or temporary outage should not prevent reading. */
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 1.5, 10000);
  }
  if (node.isConnected)
    failure(
      node,
      "This diagram is still being prepared. Reload later; its source is available below.",
    );
}

function next() {
  if (active) return;
  let node;
  do {
    node = queue.shift();
  } while (node && !node.isConnected);
  if (!node) return;
  if (node.dataset.savedUrl) {
    savedDiagram(node);
    return next();
  }
  const source = node.querySelector(".diagram-source code").textContent;
  if (cache.has(source)) {
    display(node, cache.get(source));
    return next();
  }
  if (new TextEncoder().encode(source).length > 32768) {
    failure(node, "Keep each diagram below 32 KB.");
    return next();
  }
  let worker, timer;
  const finish = () => {
    clearTimeout(timer);
    worker?.terminate();
    active = null;
    next();
  };
  const deadline = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      failure(
        node,
        "Diagram compilation timed out. Simplify the diagram and try again.",
      );
      finish();
    }, ms);
  };
  try {
    worker = new Worker(config.dataset.diagramWorker);
    active = { node, cancel: finish };
    node.dataset.diagramState = "compiling";
    node.querySelector(".diagram-status").textContent =
      "Loading diagram compiler…";
    deadline(45000);
    worker.onmessage = ({ data }) => {
      if (data.type === "compiling") {
        node.querySelector(".diagram-status").textContent =
          "Compiling diagram…";
        deadline(8000);
        return;
      }
      try {
        if (data.type === "error") failure(node, data.message, data.log);
        else if (data.type === "result") {
          const svg = safeDiagram(data.result);
          const size = svg.outerHTML.length + source.length;
          while (
            cache.size &&
            (cache.size >= 24 || cacheSize + size > 4000000)
          ) {
            const key = cache.keys().next().value;
            cacheSize -= cache.get(key).outerHTML.length + key.length;
            cache.delete(key);
          }
          cache.set(source, svg);
          cacheSize += size;
          display(node, svg);
        } else throw new Error("Unexpected compiler response.");
      } catch (error) {
        failure(node, error.message);
      }
      finish();
    };
    worker.onerror = (event) => {
      event.preventDefault();
      failure(
        node,
        "Could not load the diagram compiler. Reload the page to try again.",
      );
      finish();
    };
    worker.postMessage(source);
  } catch (error) {
    failure(node, "Diagram compilation is unavailable in this browser.");
    finish();
  }
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      observed.delete(entry.target);
      queue.push(entry.target);
    }
    next();
  },
  { rootMargin: "400px" },
);

function render(root = document) {
  for (const node of observed) {
    if (!node.isConnected) {
      observer.unobserve(node);
      observed.delete(node);
    }
  }
  // Detach old preview work immediately; a stale compilation must never replace
  // a newer preview, and hidden source edits must not queue expensive work.
  if (active && !active.node.isConnected) active.cancel();
  for (const node of root.querySelectorAll(
    "[data-diagram]:not([data-diagram-state])",
  )) {
    node.dataset.diagramState = "waiting";
    observed.add(node);
    observer.observe(node);
  }
}
window.PeerpediaDiagrams = { render };
render();

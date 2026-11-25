import { UserFacingError } from "../user-error";
/** The renderer's output is manuscript data. Construct an inert reading DOM, never install its HTML in a live document. */
const HTML = "http://www.w3.org/1999/xhtml";
const SVG = "http://www.w3.org/2000/svg";
const MATH = "http://www.w3.org/1998/Math/MathML";
const words = (value: string): Set<string> => new Set(value.split(/\s+/));
const elements = new Map([
  [HTML, words("a abbr article aside b bdi bdo blockquote br caption cite code dd del details div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i ins kbd li mark ol p pre q s samp section small span strong sub summary sup table tbody td th thead tr u ul var wbr")],
  [SVG, words("svg g defs symbol path text tspan use circle ellipse rect line polyline polygon clipPath mask marker linearGradient radialGradient stop title desc")],
  [MATH, words("math semantics annotation mi mn mo ms mtext mrow mfrac msqrt mroot mstyle mspace mpadded mphantom mfenced menclose msub msup msubsup munder mover munderover mmultiscripts mprescripts none mtable mtr mtd")],
]);
const ordinary = words("id class title lang dir aria-label aria-hidden role colspan rowspan scope start value open display encoding mathvariant mathsize stretchy fence separator symmetric accent accentunder form lspace rspace columnalign rowalign columnspacing rowspacing columnlines rowlines scriptlevel displaystyle");
const geometry = words("d x y dx dy x1 y1 x2 y2 cx cy r rx ry width height viewBox preserveAspectRatio points transform pathLength font-size font-family text-anchor alignment-baseline dominant-baseline stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset stroke-opacity fill-rule fill-opacity opacity clip-rule offset gradientUnits gradientTransform markerUnits markerWidth markerHeight refX refY orient");
const paint = words("fill stroke clip-path mask marker-start marker-mid marker-end stop-color");
const inline = words("height width min-width max-width top bottom left right margin-left margin-right margin-top margin-bottom padding-left padding-right vertical-align font-size font-family font-style font-weight color background-color border-color border-top-width border-bottom-width border-right-width border-left-width border-bottom-style position display text-align line-height transform transform-origin white-space");
const fragment = /^#[\w:.-]+$/u;
const localPaint = /^(?:none|currentColor|transparent|[a-z]+|#[a-f\d]{3,8}|url\(#[\w:.-]+\)|rgba?\([\d.,%\s]+\))$/i;

export function articleLink(value: string): string | null {
  if (value.startsWith("#") || /^\?chapter=[\w%-]+(?:#[^\s]*)?$/.test(value)) return value;
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function copyNode(node: Node, parent: Node, doc: Document): void {
  if (node.nodeType === 3) { parent.appendChild(doc.createTextNode(node.textContent ?? "")); return; }
  if (node.nodeType !== 1) return;
  const source = node as Element;
  const ns = source.namespaceURI ?? "";
  const tag = source.localName;
  if (!elements.get(ns)?.has(tag)) return;
  const target = doc.createElementNS(ns, tag);
  for (const { name, value } of Array.from(source.attributes)) {
    if (ordinary.has(name) || (ns === SVG && geometry.has(name))) target.setAttribute(name, value);
    else if (ns === SVG && paint.has(name) && localPaint.test(value)) target.setAttribute(name, value);
    else if (ns === SVG && tag === "use" && ["href", "xlink:href"].includes(name) && fragment.test(value)) {
      target.setAttribute("href", value);
    } else if (ns === HTML && tag === "a" && name === "href") {
      const link = articleLink(value);
      if (link) { target.setAttribute("href", "#"); target.setAttribute("data-preview-link", link); }
    } else if (name === "style") {
      const css = (source as HTMLElement).style;
      const safe = (target as HTMLElement).style;
      for (const property of Array.from(css)) {
        const v = css.getPropertyValue(property);
        if (/^border(?:-(?:left|right|top|bottom))?-style$/.test(property) && /^(solid|dashed)$/.test(v)) safe.setProperty(property, v);
        else if ((property === "border-width" || property === "--bm-tikz-tag-space") && /^(?:\d+(?:\.\d+)?|\.\d+)em$/.test(v.trim())) safe.setProperty(property, v);
        else if (property === "margin" && /^0(?:px)? -?(?:\d+(?:\.\d+)?|\.\d+)em$/.test(v)) safe.setProperty(property, v);
        else if (inline.has(property) && /^[\w\s.,%+\-#]+$/.test(v)) safe.setProperty(property, v);
      }
    }
  }
  for (const child of Array.from(source.childNodes)) copyNode(child, target, doc);
  parent.appendChild(target);
}

export function articleFragment(doc: Document, source: DocumentFragment): DocumentFragment {
  const result = doc.createDocumentFragment();
  for (const child of Array.from(source.childNodes)) copyNode(child, result, doc);
  return result;
}

export interface PreviewTheme { katex: ReadonlyMap<string, string>; fonts: string }

export function localTheme(
  manifest: { stylesheet: string; katex: { fonts: string[] }; tikz: { fonts: string[] } }, resource: (path: string) => string,
): PreviewTheme {
  if (manifest.stylesheet !== "style.css") throw new UserFacingError("The preview stylesheet manifest is invalid.");
  const local = (path: string): string => {
    const url = new URL(resource(path));
    if (url.protocol !== "app:" && !/^data:font\/(?:woff2?|ttf);base64,[A-Za-z0-9+/]+={0,2}$/.test(url.href)) {
      throw new UserFacingError("Preview assets must be local fonts.");
    }
    return url.href;
  };
  const fonts = manifest.tikz.fonts.map((path: string): string => {
    const match = /^tikz\/([\w-]+)\.(ttf|woff2)$/.exec(path);
    if (!match) throw new UserFacingError("The diagram font manifest is invalid.");
    return `@font-face{font-family:tikzjax-${match[1]};src:url(${JSON.stringify(local(path))}) format("${match[2] === "woff2" ? "woff2" : "truetype"}")}`;
  }).join("\n");
  const katex = new Map<string, string>();
  for (const path of manifest.katex.fonts) {
    if (!/^fonts\/katex\/[\w-]+\.(?:ttf|woff2?)$/.test(path)) throw new UserFacingError("The math font manifest is invalid.");
    katex.set("./" + path, local(path));
  }
  return { katex, fonts };
}

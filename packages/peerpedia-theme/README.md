# Peerpedia article theme

`@peerpedia/theme/style.css` styles rendered BananaMark HTML inside
`.peerpedia-article`. It supplies article typography, colors, environments,
mathematics, code, tables, references, and responsive and print styles.

## Use the theme

From a Peerpedia checkout, build a local package with Node 22 or newer.

```sh
npm ci --prefix packages/peerpedia-theme
npm pack ./packages/peerpedia-theme
```

Install the resulting `peerpedia-theme-0.1.0.tgz` in the consuming project.
The installed package has no runtime dependencies.

```js
import "@peerpedia/theme/style.css";
```

```html
<article class="peerpedia-article">
  <h1>A paper title</h1>
  <p>Rendered article HTML goes here.</p>
</article>
```

For a plain HTML page, serve the contents of the installed package's `dist`
directory together and link its `style.css`. Keep the relative directories
when copying assets. A bundler that resolves CSS URLs can also place those
assets for you.

Override `--pp-` tokens on `.peerpedia-article` or with a selector targeting
that element. For example, `.peerpedia-article { --pp-accent: #284d74; }`
changes article links and theorem accents. Sites that share the palette in
their own interface can load `@peerpedia/theme/tokens.css` and apply
`.peerpedia-theme-tokens` to the desired region. The Peerpedia website opts in
to those tokens and maps its existing variables to them. It also sets
`--pp-bm-surface`, `--pp-bm-target-border`, and `--pp-code-block-padding` on
preview and writing guide examples to preserve their existing appearance.

## Fonts and licenses

`@peerpedia/theme/assets.json` maps each asset to a path relative to the
directory containing `style.css`. Its font lists give the exact paths to copy
or resolve through the package exports.

| Asset | Public path | License included |
| --- | --- | --- |
| Peerpedia styles | `style.css` | `licenses/peerpedia-MIT.txt` |
| BananaMark styles | `style.css` | `licenses/bananamark-MIT.txt` |
| KaTeX styles | `style.css` | `licenses/katex-MIT.txt` |
| KaTeX fonts | `fonts/katex/` | `licenses/katex-OFL-1.1.txt` |
| BaKoMa fonts for TikZ | `tikz/` | `tikz/LICENCE` |

KaTeX font URLs are resolved relative to the stylesheet. For compiled TikZ
SVGs, configure your renderer to use the served `tikz/` directory when
generating font URLs. The theme includes the fonts and presentation for
already-rendered diagrams. Local system fonts supply the text font stack. The
KaTeX font notice follows the [official SIL Open Font License text](https://openfontlicense.org/open-font-license-official-text/)
and the copyright and reserved names embedded in the supplied fonts.

## Verify the package

```sh
npm --prefix packages/peerpedia-theme test
npm --prefix packages/peerpedia-theme run build
```

The package test packs and installs the theme in a fresh, offline consumer,
parses the installed CSS, and checks its selectors, relative font references,
font files, and licenses. For a browser check, put
[`tests/fixture.html`](tests/fixture.html) alongside a copy of the installed
`dist` directory named `theme` and serve the containing directory.

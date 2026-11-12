---
version: alpha
name: Lede
themes: [light, dark]
# derived from the tokens below (faded mixes, rules, the shadow), or local to one component
omitted: ["--a-*", "--*-t", "--*-p", "--*-ts", "--*-ps", "--rule", "--lost", "--pop", "--achura-*", "--wait", "--was"]
colors:
  canvas: "#FAF9F6"
  win: "#F3F1EC"
  tile: "#FFFFFF"
  line: "#E7E4DD"
  ink: "#1A1D2E"
  muted: "#5F6275"
  paper: "#EEEBE4"
  time: "#2F5BEA"
  src: "#FFAA00"
  page: "#8452F2"
  bnc: "#D7263D"
  live: "#12974A"
  on-time: "#FFFFFF"
  on-src: "#1A1D2E"
  on-page: "#FFFFFF"
  on-bnc: "#FFFFFF"
  on-live: "#FFFFFF"
  focus: "{colors.page}"
  canvas-dark: "#0E0F13"
  win-dark: "#15161C"
  tile-dark: "#1D1F27"
  line-dark: "#2C2F3A"
  ink-dark: "#EDEEF3"
  muted-dark: "#A3A6B6"
  paper-dark: "#B4B7C2"
  time-dark: "#6B8CFF"
  src-dark: "#FFC14D"
  page-dark: "#A585FF"
  bnc-dark: "#FF5C6B"
  live-dark: "#3DDC84"
  on-time-dark: "#0E0F13"
  on-src-dark: "#0E0F13"
  on-page-dark: "#0E0F13"
  on-bnc-dark: "#0E0F13"
  on-live-dark: "#0E0F13"
typography:
  font:
    fontFamily: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif
  mono:
    fontFamily: ui-monospace, SFMono-Regular, Menlo, monospace
  fs-xs:
    fontSize: 12px
  fs-s:
    fontSize: 14px
  fs-m:
    fontSize: 17px
  fs-l:
    fontSize: 20px
  fs-xl:
    fontSize: 44px
  fs-xxl:
    fontSize: 56px
rounded:
  r-win: 36px
  r-tile: 20px
---
<!-- Google's DESIGN.md format, @google/design.md 0.4.0 (alpha). public/index.html's :root is the source;
bench/checks fails when the two differ. -->

## Overview
Lede is a site's stats, told as a story. The home screen tells the period's story in reading order: how much changed and why, then the charts that prove it.

## Colors
Color says what kind of thing a mark is, on every tile and sub-page: visitors over time are blue (`time`), sources amber (`src`), pages violet (`page`), bounce (people leaving) red (`bnc`), and people here now green (`live`). Violet is a shade darker than it might be, so white names on a solid bar read at AA. `on-*` is the text on a solid subject color.

The grays plus ink are the canvas, window, tile, line (edges, tracks, hover, skeletons) and muted text. `paper` is a page with no picture yet: light, as most pages are, so the shade over it shows in both themes. Focus rings use `page`.

## Typography
Six text sizes: `fs-xs` for fine print and axes, `fs-s` for labels and rows, `fs-m` for sentences, `fs-l` for titles, `fs-xl` for hero numbers and `fs-xxl` for the home total. `font` is the system sans; `mono` the system monospace.

## Layout
One rounded app window on a quiet canvas. Every tile zooms to fill the window, and items inside zoom again into filtered views.

## Elevation & Depth
What floats over the page gets an outline and a shadow below.

## Shapes
Concentric corners: the window's radius (`r-win`) is a tile's (`r-tile`) plus the 16px between them.

## Components
Each tile is a title, one graphic and one sentence.

## Do's and Don'ts
- Color is solid. Transparency means empty, before, those who left, or how much; it keeps a color's hue, never white.
- In crowded charts, the marks the sentence names stay solid while the rest fade, so the eye finds them. Small marks fade less so they show.
- Parts of one color are told apart in one of two ways, by what they are. Parts of one bar that touch (a strip of shares) are told apart by texture: the first plain, then up to four textures, each inked a little more. Bands that stand apart and carry their own names (the ribbons, and the pages' bars that overlap) are told apart by shade, the same steps in both so a page is as dark in one as in the other, since a texture can't be followed across a crossing. Either way the name is on or beside the part, so color is never the only way to tell.
- The ribbons, wherever one thing goes to another, fade nothing, since a see-through strand can't be followed across another. Each source has its own step of `src` and each page its own step of `page`, mixed towards `ink` at the top of its turn and towards `tile` at the bottom, so neighbours differ and the last and least stand back in both themes. A strand keeps its source's step into the page it lands in, so a page's edge shows where its own came from, and where it leaves its source it has a cap in its page's step, so a source's edge is a stacked bar of where its own went. No strand has a gradient or an outline, and pointing at a source, a page or a strand turns the other strands to `line`. On the Bounce screen the ribbons run straight across and have a third step, read on and left after one page: a page's strand to the first is grey (`lost`) and to the second its own step of `bnc`. A band always holds its own name: in a narrow box the names go on two lines, then the bands narrow together, and they never become thin bars with names beside them. The source and page the sentence names have the color itself, which no other row has, so solid color still says what is named.
- Text stays ink; color sits in marks, swatches and underlines.

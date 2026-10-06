// All race page pixel art, as SVG strings. Swap this file to reskin the page.
// The robot is original: a boxy helmet with a dark visor, an antenna light, a chest light,
// side arms and two legs. Parts are separate groups so CSS can animate them.

/** Pixels per side of the robot sprite. */
export const SPRITE_GRID = 16;

const HEX = /^#[0-9a-f]{6}$/i;
const FALLBACK = "#8b8d98";

/** Only a #rrggbb color reaches the SVG markup. */
function safeHex(hex: string): string {
  return HEX.test(hex) ? hex.toLowerCase() : FALLBACK;
}

function scaleHex(hex: string, change: (channel: number) => number): string {
  const color = safeHex(hex);
  const channels = [1, 3, 5].map((i) => Math.round(Math.min(255, Math.max(0, change(parseInt(color.slice(i, i + 2), 16))))));
  return `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** A darker (factor < 1) #rrggbb of the color. */
export function shade(hex: string, factor: number): string {
  return scaleHex(hex, (c) => c * factor);
}

/** A lighter #rrggbb: mixes `amount` (0..1) of white in. */
export function tint(hex: string, amount: number): string {
  return scaleHex(hex, (c) => c + (255 - c) * amount);
}

/** One char per pixel. Each char names its group and its color key. */
const ROBOT = [
  ".......AA.......",
  ".......nn.......",
  "..oooooooooooo..",
  "..ohhhhhhhhhho..",
  "..obvvvvvvvvbo..",
  "..obvEEvvEEvbo..",
  "..obvEEvvEEvbo..",
  "..obvvvvvvvvbo..",
  "..obbbbbbbbbbo..",
  "...oooooooooo...",
  ".ll.obbccbbo.rr.",
  ".lL.obbccbbo.Rr.",
  ".lL.obbbbbbo.Rr.",
  ".ll.oooooooo.rr.",
  ".....gg..gg.....",
  "....ggg..ggg....",
];

const ROBOT_GROUPS: [group: string, chars: string][] = [
  ["robot-legs", "g"],
  ["robot-arm-left", "lL"],
  ["robot-arm-right", "rR"],
  ["robot-body", "ohbv"],
  ["robot-chest", "c"],
  ["robot-eyes", "E"],
  ["robot-antenna", "n"],
  ["robot-light", "A"],
];

/** Rects for the chars of one group, merging runs of the same char on a row. */
function rects(grid: string[], chars: string, colors: Record<string, string>): string {
  const out: string[] = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const char = row[x] ?? ".";
      let end = x + 1;
      while (end < row.length && row[end] === char) end++;
      const fill = colors[char];
      if (chars.includes(char) && fill !== undefined) {
        out.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${fill}"/>`);
      }
      x = end;
    }
  });
  return out.join("");
}

function svg(className: string, width: number, height: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges" class="${className}" aria-hidden="true" focusable="false">${body}</svg>`;
}

/**
 * The robot in `color` (#rrggbb; anything else draws the fallback gray), with each part in its own
 * group for CSS to animate.
 */
export function robotSvg(color: string): string {
  const body = safeHex(color);
  const outline = shade(body, 0.42);
  const colors: Record<string, string> = {
    A: "#ffd23f",
    n: "#9aa0b4",
    o: outline,
    h: tint(body, 0.4),
    b: body,
    v: "#0c0f1c",
    E: "#dff9ff",
    c: tint(body, 0.7),
    l: shade(body, 0.7),
    L: tint(body, 0.2),
    r: shade(body, 0.7),
    R: tint(body, 0.2),
    g: shade(body, 0.55),
  };
  const groups = ROBOT_GROUPS.map(([group, chars]) => `<g class="${group}">${rects(ROBOT, chars, colors)}</g>`).join("");
  return svg("robot-svg", SPRITE_GRID, SPRITE_GRID, groups);
}

const CROWN = [
  "o..o..o.",
  "oo.oo.oo",
  "oyoyyoyo",
  "oyyyyyyo",
  "oyryyryo",
  "oooooooo",
];

/** The winner's pixel crown. */
export function crownSvg(): string {
  return svg("crown-svg", 8, 6, rects(CROWN, "oyr", { o: "#b07d00", y: "#ffd23f", r: "#e5484d" }));
}


const HAMMER = [
  "hhhh.",
  "hhhh.",
  "..s..",
  "..s..",
  "..s..",
];

/** The pixel hammer a robot swings while it edits. */
export function hammerSvg(): string {
  return svg("hammer-svg", 5, 5, rects(HAMMER, "hs", { h: "#c7cbd6", s: "#8a5a2b" }));
}

/** The repo core: a crystal drawn smooth, with two orbit rings for CSS to spin. */
export function coreSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-60 -60 120 120" class="core-svg" aria-hidden="true" focusable="false">
<defs>
<radialGradient id="core-glow"><stop offset="0" stop-color="#7fe3ff" stop-opacity=".55"/><stop offset="1" stop-color="#7fe3ff" stop-opacity="0"/></radialGradient>
<linearGradient id="core-face" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c9f4ff"/><stop offset=".5" stop-color="#4cc3ee"/><stop offset="1" stop-color="#1f5f99"/></linearGradient>
</defs>
<circle class="core-halo" r="58" fill="url(#core-glow)"/>
<g class="core-ring core-ring-a"><ellipse rx="46" ry="14" fill="none" stroke="#7fe3ff" stroke-opacity=".55" stroke-width="1.5" stroke-dasharray="6 5"/></g>
<g class="core-ring core-ring-b"><ellipse rx="40" ry="12" fill="none" stroke="#b18cff" stroke-opacity=".45" stroke-width="1.2" stroke-dasharray="2 6"/></g>
<g class="core-gem">
<polygon points="0,-30 22,-8 0,32 -22,-8" fill="url(#core-face)"/>
<polygon points="0,-30 22,-8 0,-2 -22,-8" fill="#e6fbff" fill-opacity=".55"/>
<polygon points="0,-2 22,-8 0,32" fill="#0b3a66" fill-opacity=".35"/>
</g>
</svg>`;
}

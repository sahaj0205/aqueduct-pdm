/**
 * The camera. Every "transition" in the walkthrough is one of these moves.
 *
 * THE WALKTHROUGH IS NOT A SLIDE DECK, and this file is why it can afford not to be.
 * Every scene lives at its own fixed address in one large coordinate space — the plant
 * at the origin, chiller-1's record to its right, the thirteen pipeline stations on a
 * long run below — and all of them are mounted at all times. Going from scene 4 to
 * scene 5 does not mount or unmount anything. It moves the camera. That single decision
 * is what makes the three effects the walkthrough is built around possible at all:
 *
 *   blasting an asset apart      the pieces fly to real world positions and stay there
 *   pointing back at scene 3     scene 3 is still on the canvas, so widen to fit both
 *   background work visible      other assets' stations are just outside the viewport
 *
 * A deck of nineteen slides can do none of those without faking each one separately.
 *
 * WORLD UNITS ARE CSS PIXELS AT SCALE 1. There is no separate design-unit system to
 * convert through; a scene box of 1200x700 is 1200x700 px when the camera sits at
 * scale 1. Keeping the two the same means a scene can be laid out by eye in a browser
 * and its numbers pasted straight into the scene table.
 *
 * NOTHING HERE TOUCHES THE DOM OR REACT. It is arithmetic on plain objects, so
 * scripts/verify-story.ts drives a whole camera move frame by frame outside a browser
 * and checks that it lands, does not overshoot, and zooms at an even rate. A camera that
 * overshoots on a projector in front of an audience is not a bug you want to discover
 * live.
 */

/** A rectangle in world space. `x`/`y` is its top-left corner. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The visible area, in CSS pixels. */
export interface Viewport {
  w: number;
  h: number;
}

/**
 * Where the camera is pointing and how close it is.
 *
 * `x`/`y` is the world point sitting at the CENTRE of the viewport — not a corner.
 * Centre-based is worth the small arithmetic cost because every camera target in this
 * show is "look at this thing", and a thing has a centre.
 *
 * `scale` is pixels per world unit: above 1 is zoomed in, below 1 is zoomed out.
 */
export interface Camera {
  x: number;
  y: number;
  scale: number;
}

/**
 * The camera plus its momentum, which is the thing the spring actually integrates.
 *
 * ZOOM IS CARRIED AS ITS LOGARITHM, and this is the one non-obvious decision in the
 * file. Interpolating scale linearly from 1.0 down to 0.1 — which is roughly the pull-out
 * for the final map scene — spends the first half of the move barely changing the
 * apparent size and the second half collapsing everything at once, because what the eye
 * reads is the RATIO between successive frames, not the difference. In log space a
 * constant rate of change is a constant rate of apparent zoom, so the move reads as one
 * even push. The midpoint of a 1.0 → 0.25 move lands at 0.5, not at 0.625.
 */
export interface Rig {
  x: number;
  y: number;
  /** Natural log of the scale. */
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/**
 * How much of the viewport is left empty around a framed box, as a fraction.
 *
 * 0.12 — six per cent of the viewport on each side. Below about 0.08 scene content
 * touches the screen edge and reads as cropped; above about 0.2 every scene looks
 * timid and the type gets small on a projector.
 */
export const FRAME_PADDING = 0.12;

/**
 * The closest the camera will ever get, whatever it is looking at.
 *
 * Without a ceiling, framing a small scene — a single 320x180 card — would magnify it
 * to fill a 1440-wide viewport at scale 4.5, which turns 15px type into 68px type and
 * looks like a rendering error rather than a design. 1.6 leaves small scenes visibly
 * closer than large ones without leaving the register of the product's own typography.
 */
export const MAX_SCALE = 1.6;

/**
 * Spring stiffness, in radians per second.
 *
 * The error remaining after `t` seconds is `(1 + omega*t) * exp(-omega*t)` of the original
 * distance, so at 9 rad/s a move is 87% done at 0.25 s and 97% at 0.4 s. On the two largest
 * moves in the show it becomes indistinguishable from arrived — under two screen pixels —
 * at 0.90 s and 1.07 s, and the loop shuts off a quarter of a second after that. Those are
 * measured rather than estimated; scripts/verify-story.ts prints them.
 *
 * That shape is what a camera move wants: most of the distance covered fast enough that
 * nobody is waiting, then a long soft landing that lets the eye catch up and understand
 * that the new scene came from somewhere rather than replacing what was there. Doubling
 * this makes the walkthrough feel like tab-switching; halving it makes every press feel
 * like a page load.
 *
 * A presenter never waits out the tail regardless, because the spring can be retargeted
 * mid-flight — pressing space again during a move curves the path rather than queueing.
 */
export const OMEGA = 9;

/**
 * When a move counts as finished — measured in SCREEN pixels, not world units.
 *
 * This distinction is not pedantry. The final pull-out sits at scale 0.28, where one
 * screen pixel is three and a half world units, and the opening scenes sit near scale 1.6,
 * where one screen pixel is two thirds of a world unit. A single tolerance in world units
 * therefore means two different visible errors at the two ends of the show: either the
 * loop keeps running long after the picture stopped changing, or it stops while a scene is
 * still visibly drifting. Dividing by the scale makes "finished" mean the same thing to
 * the eye everywhere in the show.
 *
 * Half a pixel of position and two pixels a second of drift are both below what any
 * display can show, so the loop stops at the first frame the audience could not tell apart
 * from the last one.
 */
const SETTLE_PX = 0.5;
const SETTLE_PX_PER_S = 2;
/** Zoom tolerance, in log units — 0.08% of scale, which is sub-pixel on any element. */
const SETTLE_ZOOM = 0.0008;
const SETTLE_ZOOM_VEL = 0.004;

/** The centre of a box. */
export function centreOf(box: Box): { x: number; y: number } {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

/**
 * The camera that frames a box inside a viewport.
 *
 * Takes the tighter of the two axes so the whole box is visible rather than filling the
 * screen and cropping — a scene that is cropped is a scene with a fact missing off the
 * edge. Guards against a zero-sized viewport, which happens for exactly one frame before
 * the resize observer has measured anything and would otherwise produce a scale of
 * Infinity and a blank screen.
 */
export function fit(
  box: Box,
  viewport: Viewport,
  padding = FRAME_PADDING,
  maxScale = MAX_SCALE,
): Camera {
  const usableW = Math.max(1, viewport.w * (1 - padding));
  const usableH = Math.max(1, viewport.h * (1 - padding));
  const byWidth = usableW / Math.max(1, box.w);
  const byHeight = usableH / Math.max(1, box.h);
  const centre = centreOf(box);
  return { x: centre.x, y: centre.y, scale: Math.min(byWidth, byHeight, maxScale) };
}

/** A rig sitting exactly on a camera, with no momentum. */
export function rigAt(camera: Camera): Rig {
  return { x: camera.x, y: camera.y, z: Math.log(camera.scale), vx: 0, vy: 0, vz: 0 };
}

/** The camera a rig currently represents. */
export function cameraOf(rig: Rig): Camera {
  return { x: rig.x, y: rig.y, scale: Math.exp(rig.z) };
}

/**
 * Advance the camera one frame toward where it is meant to be.
 *
 * WHY A SPRING AND NOT A KEYFRAMED TWEEN. A tween has to know its duration and its start
 * point before it begins, so interrupting one — which is exactly what a presenter does by
 * pressing space again mid-move — means either finishing the old move first, snapping, or
 * restarting with a visible change of direction. A spring has no duration and no start:
 * it only ever reads where it is, how fast it is going, and where it wants to be, so
 * retargeting mid-flight just curves the path. Every press lands smoothly regardless of
 * what the camera was doing.
 *
 * WHY THE CLOSED FORM rather than integrating the acceleration. This is the exact
 * solution of a critically damped spring over an interval, which means it is
 * unconditionally stable at any timestep. The naive alternative — add the spring force to
 * velocity, add velocity to position — diverges when the frame time spikes, and frame
 * times spike for a very ordinary reason: a laptop lid closes, or a presenter switches to
 * another window mid-talk. On return, `dt` is measured in seconds rather than
 * milliseconds and the integrated version throws the camera into deep space where nothing
 * is rendered. This one simply arrives.
 *
 * CRITICALLY DAMPED, so it never overshoots. Any bounce here would read as the camera
 * changing its mind about where to look, which is the single most nauseating thing a
 * presentation can do on a large screen.
 */
export function stepRig(rig: Rig, target: Camera, dt: number, omega = OMEGA): Rig {
  const decay = Math.exp(-omega * dt);
  const tz = Math.log(target.scale);

  const channel = (p: number, v: number, t: number): [number, number] => {
    const d = p - t;
    const c = v + omega * d;
    return [t + (d + c * dt) * decay, (v - c * omega * dt) * decay];
  };

  const [x, vx] = channel(rig.x, rig.vx, target.x);
  const [y, vy] = channel(rig.y, rig.vy, target.y);
  const [z, vz] = channel(rig.z, rig.vz, tz);
  return { x, y, z, vx, vy, vz };
}

/**
 * Has the camera arrived?
 *
 * Both halves are required. Position alone would report "arrived" at the instant the
 * camera passes through its target at speed, and velocity alone would report it while
 * momentarily stationary somewhere else. Used to stop the animation loop, so a settled
 * walkthrough burns no frames while the presenter talks over a scene — which on a laptop
 * driving a projector is the difference between a quiet room and a loud fan.
 */
export function settled(rig: Rig, target: Camera): boolean {
  const tolPos = SETTLE_PX / target.scale;
  const tolVel = SETTLE_PX_PER_S / target.scale;
  return (
    Math.abs(rig.x - target.x) < tolPos &&
    Math.abs(rig.y - target.y) < tolPos &&
    Math.abs(rig.z - Math.log(target.scale)) < SETTLE_ZOOM &&
    Math.abs(rig.vx) < tolVel &&
    Math.abs(rig.vy) < tolVel &&
    Math.abs(rig.vz) < SETTLE_ZOOM_VEL
  );
}

/**
 * The CSS transform that puts the camera's world point at the centre of the screen.
 *
 * Read right to left, which is the order the browser applies it: move the world so the
 * camera's target sits on the origin, scale about that origin, then push the origin to
 * the middle of the viewport. Requires `transform-origin: 0 0` on the element, which
 * Story.module.css sets — with the default 50% origin the scale would happen about the
 * centre of the world's bounding box and every frame would be somewhere unintended.
 *
 * ONE TRANSFORM ON ONE ELEMENT, not a transform per scene. The browser composites the
 * whole world as a single layer, so a camera move is GPU work proportional to screen
 * area rather than to how much is on the canvas, and stays smooth at nineteen scenes.
 */
export function transformOf(camera: Camera, viewport: Viewport): string {
  const cx = viewport.w / 2;
  const cy = viewport.h / 2;
  return (
    `translate(${cx.toFixed(2)}px, ${cy.toFixed(2)}px) ` +
    `scale(${camera.scale.toFixed(5)}) ` +
    `translate(${(-camera.x).toFixed(2)}px, ${(-camera.y).toFixed(2)}px)`
  );
}

/**
 * Where a world point currently appears on screen, in CSS pixels from the viewport's
 * top-left.
 *
 * The inverse of the transform above, and the reason it exists is the callback mechanic
 * in later checkpoints: to draw a line from the scene being explained back to the card
 * that justifies it, something has to know where both ends have ended up on screen. Also
 * how the verification script checks the transform is right without a browser.
 */
export function worldToScreen(
  camera: Camera,
  viewport: Viewport,
  point: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: viewport.w / 2 + (point.x - camera.x) * camera.scale,
    y: viewport.h / 2 + (point.y - camera.y) * camera.scale,
  };
}

/**
 * The smallest box containing all of the given boxes.
 *
 * Exists for the two moves that have to hold more than one thing on screen at once: the
 * callback ping, which frames the current scene together with the earlier card it is
 * pointing at, and the final pull-out, which frames every scene in the show. Returns a
 * zero box for an empty list rather than throwing, because a callback with nothing to
 * point at should be a camera that does not move, not a crash mid-presentation.
 */
export function union(boxes: Box[]): Box {
  if (boxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const box of boxes) {
    x0 = Math.min(x0, box.x);
    y0 = Math.min(y0, box.y);
    x1 = Math.max(x1, box.x + box.w);
    y1 = Math.max(y1, box.y + box.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

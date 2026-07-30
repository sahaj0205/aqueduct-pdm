/**
 * The presenter's hands: keyboard and click, wired to the show machine.
 *
 * ONE PRESS IS ONE BEAT, whatever key it came from. A presenter should not have to
 * remember which key this particular thing wants, so every key that means "next" in every
 * other presentation tool means "next" here — space, right, down, page down, enter — and
 * the same for going back. A clicker plugged into the laptop sends page up and page down,
 * which is why those two are on the list and are the reason this is worth being generous
 * about.
 *
 * WHY THE LISTENER IS ON THE WINDOW rather than on a focused element. A presentation gets
 * clicked on, dragged over, and shown after switching windows, and a key handler attached
 * to something focusable stops working the moment focus moves — which in front of an
 * audience looks like the machine has frozen. The whole page is the control surface.
 *
 * Modified presses are left alone so the browser keeps its own shortcuts: command-left is
 * "go back a page" to everyone who has ever used a browser, and stealing it to rewind a
 * beat would trap somebody in the walkthrough.
 */

import { useCallback, useEffect, useState } from "react";

import { START, type Spot, back, clampSpot, forward, jumpTo } from "./show.ts";

const FORWARD_KEYS = new Set([" ", "Spacebar", "ArrowRight", "ArrowDown", "PageDown", "Enter"]);
const BACK_KEYS = new Set(["ArrowLeft", "ArrowUp", "PageUp", "Backspace"]);

export function useShow(beats: readonly number[], from: Spot = START) {
  const [spot, setSpot] = useState<Spot>(() => clampSpot(beats, from));

  const advance = useCallback(() => {
    setSpot((here) => forward(beats, here));
  }, [beats]);

  const rewind = useCallback(() => {
    setSpot((here) => back(beats, here));
  }, [beats]);

  const go = useCallback(
    (scene: number) => {
      setSpot(jumpTo(beats, scene));
    },
    [beats],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (FORWARD_KEYS.has(event.key)) {
        event.preventDefault();
        advance();
        return;
      }
      if (BACK_KEYS.has(event.key)) {
        event.preventDefault();
        rewind();
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        go(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance, rewind, go]);

  return { spot, advance, rewind, go };
}

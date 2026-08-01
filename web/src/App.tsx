import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";

import { api, reveal } from "./api.ts";
import { AdvisoryDetail } from "./components/AdvisoryDetail.tsx";
import { ControlBar } from "./components/ControlBar.tsx";
import { Deck } from "./deck/Deck.tsx";
import { Credit } from "./design/Credit.tsx";
import { Mark } from "./design/Mark.tsx";
import { BRAND } from "./lib/brand.ts";
import { Term } from "./design/Term.tsx";
import { FmApp } from "./fm/FmApp.tsx";
import type { ClockState } from "./components/ControlBar.tsx";
import { NavTabs } from "./components/NavTabs.tsx";
import { Splash } from "./components/Splash.tsx";
import { Story } from "./story/Story.tsx";
import { Walkthrough } from "./components/Walkthrough.tsx";
import { clampToEra, toIso } from "./lib/clock.ts";
import { buildTour } from "./lib/tour.ts";
import { Diagnosis } from "./screens/Diagnosis.tsx";
import { Engine } from "./screens/Engine.tsx";
import { Operations } from "./screens/Operations.tsx";
import { Configuration } from "./screens/Configuration.tsx";
import { Prediction } from "./screens/Prediction.tsx";
import { Reveal } from "./screens/Reveal.tsx";
import { Twin } from "./screens/Twin.tsx";
import type {
  AdvisorySummary,
  ClockRange,
  InjectedFault,
  SiteSummary,
  TwinState,
  TwinTopology,
} from "./types.ts";

/**
 * The shell: the clock, the navigation, the error state, and everything the screens
 * share. Each screen is a plain component below it.
 *
 * WHY THE CLOCK LIVES HERE AND NOT IN A SCREEN. Every screen shows one moment and they
 * must all show the SAME moment. Held in the shell, the clock survives navigation —
 * open an advisory and come back and the day has not jumped — and no screen can grow
 * its own copy.
 *
 * Three states, all of them explicit: loading, failed, and loaded. The failed state
 * carries the message and how to fix it, because the alternative — an empty table —
 * would read as "nothing is wrong with the building", which is the most dangerous
 * thing this dashboard could imply.
 */

/**
 * Where each screen used to live, and where it lives now.
 *
 * THREE PLACES, EACH WITH ITS OWN ADDRESS. The home page is the front door at "/", the
 * guided walk is "/tour", and the working application is "/console" with every screen
 * nested beneath it. Before this the front door was hidden at "/welcome" while the
 * console owned the root, which is backwards — the thing you land on should be the thing
 * at the root, and a guided walk with no address of its own cannot be linked to or
 * returned to.
 *
 * The paths were renamed alongside the tabs, because a URL is read aloud in a
 * demonstration and shown in the address bar of a shared screen, and "/engine" tells a
 * viewer as little there as it did on the tab. Old paths redirect rather than 404: this
 * build is already deployed, and a link somebody saved last week should still land.
 *
 * THE COMPONENT FILES WERE NOT RENAMED. `screens/Engine.tsx` still renders "How we
 * know". Renaming seven files and their imports would be a large diff with no visible
 * effect whatever, so the correspondence is written down here instead — this table is
 * the one place that maps the internal name to the name a viewer sees.
 */
const MOVED: Record<string, string> = {
  "/welcome": "/", //                 the front door is the home page now
  "/building": "/console/building",
  "/how-we-know": "/console/how-we-know",
  "/sensor-or-machine": "/console/sensor-or-machine",
  "/time-left": "/console/time-left",
  "/rules": "/console/rules",
  "/answer": "/console/answer",
  "/twin": "/console/building", //    Twin.tsx          → The building
  "/engine": "/console/how-we-know", // Engine.tsx      → How we know
  "/diagnosis": "/console/sensor-or-machine",
  "/prediction": "/console/time-left",
  "/config": "/console/rules",
  "/reveal": "/console/answer",
};

/**
 * Every screen the console serves, in tab order. This list IS the routing table — the
 * router maps each entry through the resolver below, and the guided walk resolves its
 * steps through the same one.
 */
const CONSOLE_SCREENS = [
  "/console",
  "/console/building",
  "/console/how-we-know",
  "/console/sensor-or-machine",
  "/console/time-left",
  "/console/rules",
  "/console/answer",
] as const;

/**
 * Everything the screens need from the shell, gathered once.
 *
 * The guided walk and the router both have to be able to put up any screen, and passing
 * six props through two call sites twice is how they drift apart.
 */
interface ScreenCtx {
  at: string | null;
  summary: SiteSummary | null;
  advisories: AdvisorySummary[] | null;
  topology: TwinTopology | null;
  twinState: TwinState | null;
}

/**
 * The screen a console path names.
 *
 * ONE RESOLVER, used by the router and by the guided walk. The walk shows a screen
 * without navigating to it — it keeps its own address — so without this the two would be
 * separate lists of paths, and a step pointing somewhere the router does not agree with
 * is a blank page in the middle of a demonstration.
 */
function ScreenFor({ path, ctx }: { path: string; ctx: ScreenCtx }) {
  switch (path) {
    case "/console/building":
      return <Twin at={ctx.at} advisories={ctx.advisories} />;
    case "/console/how-we-know":
      return <Engine at={ctx.at} twinState={ctx.twinState} />;
    case "/console/sensor-or-machine":
      return <Diagnosis />;
    case "/console/time-left":
      return <Prediction at={ctx.at} />;
    case "/console/rules":
      return <Configuration />;
    case "/console/answer":
      return <Reveal at={ctx.at} />;
    default:
      return (
        <Operations
          summary={ctx.summary}
          advisories={ctx.advisories}
          topology={ctx.topology}
          twinState={ctx.twinState}
        />
      );
  }
}

/** The advisory detail, reading its id from the URL rather than from a state flag. */
function AdvisoryRoute() {
  const { advisoryId } = useParams<{ advisoryId: string }>();
  const navigate = useNavigate();
  if (!advisoryId) return <Navigate to="/console" replace />;
  return <AdvisoryDetail advisoryId={advisoryId} onBack={() => navigate("/console")} />;
}

export function App() {
  const [summary, setSummary] = useState<SiteSummary | null>(null);
  const [advisories, setAdvisories] = useState<AdvisorySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [topology, setTopology] = useState<TwinTopology | null>(null);
  const [twinState, setTwinState] = useState<TwinState | null>(null);

  // The clock. One position, shared by every screen, so the queue and the building
  // drawing can never disagree about what day it is. Null until the range is known --
  // there is no sensible default moment in a database holding four runs placed years
  // apart, and guessing one would land the dashboard in an empty stretch of calendar.
  const [range, setRange] = useState<ClockRange | null>(null);
  const [clock, setClock] = useState<ClockState | null>(null);
  const [faults, setFaults] = useState<InjectedFault[] | null>(null);

  /**
   * Which stop of the guided walk is showing.
   *
   * THE MODE FLAGS ARE GONE. There used to be a `guided` boolean and an `entered`
   * boolean, each mirrored into session storage, and between them they decided which of
   * three things the page was. The route decides that now — "/" is the front door,
   * "/tour" is the walk, "/console" is the working application — so the only thing left
   * worth remembering is how far through the walk somebody is.
   */
  const [step, setStep] = useState(0);

  /**
   * The front door, and whether it has been through.
   *
   * Shown INSTEAD OF the dashboard rather than over it, because the point is that a
   * first-time visitor should not see an unexplained clock and an unexplained queue at
   * all until they have been told what the thing is. Data loading carries on behind it,
   * and the front page is handed the results — the figures on it are counted from the
   * running system rather than written down.
   */

  const location = useLocation();
  const navigate = useNavigate();

  /**
   * Leaving the front door. Sets the flag, picks a mode, and navigates — the front door
   * is a route now, so getting out of it is a navigation like any other.
   */
  const enter = useCallback(
    (withTour: boolean) => {
      setStep(0);
      navigate(withTour ? "/tour" : "/console");
    },
    [navigate],
  );

  const leaveTour = useCallback(() => {
    navigate("/console");
  }, [navigate]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [nextRange, nextTopology, key] = await Promise.all([
        api.eras(),
        // The shape of the building, fetched once. Every node, every relation and every
        // instrument comes from the semantic model rather than being written into the
        // frontend, so a building with a sixth zone gets a sixth box with no code change.
        api.twinTopology(),
        // The answer key is optional and its absence is not an error: the reveal
        // service is a separate process and the dashboard is fully usable without it.
        reveal.scenarios(),
      ]);
      setRange(nextRange);
      setTopology(nextTopology);
      setFaults(key?.faults ?? null);
      // Start at the end of the first run rather than its beginning. A run opens with
      // three weeks of healthy commissioning data, so a dashboard that started there
      // would open on an empty queue and look broken; the end of the run is where
      // there is something to see, and the clock can be dragged backwards.
      // An empty era list is not possible from a database with health history -- the
      // endpoint 404s rather than returning one -- but it is checked instead of
      // asserted, because the alternative is a crash on an index that reads as a
      // frontend bug rather than as an empty database.
      const first = nextRange.eras[0];
      if (first) {
        setClock((current) =>
          current ?? {
            at: clampToEra(nextRange, new Date(first.t_to)),
            playing: false,
            speed: 1,
          },
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Derived, never written down. Every moment the tour stops at comes from the run list
  // the API returned, refined by the answer key only when the reveal service is running —
  // see lib/tour.ts for why a tour with dates typed into it would fail silently.
  const tour = useMemo(
    () => (range ? buildTour(range, faults) : []),
    [range, faults],
  );

  // Everything the clock drives is refetched when it moves. Kept separate from the
  // load above so that dragging the scrubber does not refetch the topology, the asset
  // list or the answer key, none of which depend on the moment.
  useEffect(() => {
    if (!clock) return;
    const at = toIso(clock.at);
    let cancelled = false;
    void (async () => {
      try {
        const [nextSummary, nextAdvisories, nextTwinState] = await Promise.all([
          api.summary(at),
          api.advisories("open", at),
          api.twinState(at),
        ]);
        if (cancelled) return;
        setSummary(nextSummary);
        setAdvisories(nextAdvisories);
        setTwinState(nextTwinState);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clock]);

  /**
   * The front door has its own address.
   *
   * IT USED TO BE A STATE FLAG WITH NO URL, and that was a trap: once somebody pressed
   * "open the console" the flag was set for the session and there was no route, no link
   * and no control anywhere that could bring the page back. Reloading did not help,
   * because the flag survives a reload. It is a route now, so the browser's own back
   * button works, the address can be pasted to somebody, and the wordmark in the header
   * links to it.
   *
   * The dashboard is deliberately not rendered underneath it — an unexplained clock
   * glimpsed behind a panel is the confusion this screen exists to prevent. Data loading
   * carries on regardless, so reading it warms every fetch the first screen needs.
   */
  const atFrontDoor = location.pathname === "/";
  const onTour = location.pathname === "/tour";
  const ctx: ScreenCtx = {
    at: clock ? toIso(clock.at) : null,
    summary,
    advisories,
    topology,
    twinState,
  };

  // The facility-manager platform: its own shell, its own routes, its own data layer.
  // Handed off before any of the console's rendering below, so it shares nothing with
  // the narrative walkthrough except the router it's mounted under.
  if (location.pathname.startsWith("/fm")) {
    return <FmApp />;
  }

  // The walkthrough: the journey of one reading, told as a camera move through a single
  // world. Handed off the same way and for the same reason — it owns the whole viewport,
  // has no masthead, no clock and no tabs, and is shown on a projector rather than worked
  // in. It shares the design tokens and nothing else.
  if (location.pathname.startsWith("/story")) {
    return <Story />;
  }

  // The deck: the same system presented to somebody deciding whether it is worth having,
  // rather than shown as a camera move. Handed off for the same reasons as the two above —
  // it owns the viewport, has no masthead, clock or tabs, and shares only the design tokens.
  if (location.pathname.startsWith("/deck")) {
    return <Deck />;
  }

  // The flow reference: what happens to one reading, stage by stage, with the module and
  // the table behind each one.
  //
  // NOT A REACT SCREEN, and that is the point. It is a standalone document in web/public,
  // so it can be opened, printed, and sent to somebody with the application not running —
  // which is what a reference gets used for. It shares the design tokens by copy rather
  // than by import, because a file served outside the bundle cannot resolve one.
  //
  // The server hands out /flow.html directly and React never runs for it. This catches
  // only the extensionless address somebody actually types, which the SPA fallback would
  // otherwise swallow into the console. Matched exactly, so it can never redirect to
  // itself.
  if (location.pathname === "/flow" || location.pathname === "/flow/") {
    window.location.replace("/flow.html");
    return null;
  }

  if (atFrontDoor) {
    // The two responses the shell is already fetching are handed straight to it, so the
    // figures on the front page are counted from the running system rather than typed in.
    return (
      <Splash
        onStart={() => enter(true)}
        onSkip={() => enter(false)}
        range={range}
        topology={topology}
      />
    );
  }

  return (
    <div className="app-shell">
    <div className="page">
      {/* The vocabulary layer, working. Three domain words in the one line that
          describes the building, each carrying its own definition — where before this
          checkpoint a reader who did not know what a cooling tower was had nowhere to
          find out without leaving the page. */}
      <header className="masthead">
        <Link className="brand" to="/" title="What is this?">
          <Mark size={22} />
          <h1>{BRAND.name}</h1>
        </Link>
        <span className="sub">
          Predicting which machine fails next in one{" "}
          <Term id="air-handler">air handler</Term> and three{" "}
          <Term id="chiller">chillers</Term> — a <Term id="replay">replay</Term>, marked
          against what really happened.
        </span>
      </header>

      {error && (
        <div className="notice">
          <strong>The API did not answer.</strong>
          <p className="muted">{error}</p>
          <p className="muted">
            Start it with <code>make api</code>, then reload. The queue itself is
            written by <code>make advisory-replay</code>.
          </p>
        </div>
      )}

      {!error && range && clock && (
        <ControlBar range={range} clock={clock} onChange={setClock} faults={faults} />
      )}

      {/* The tour and the tabs occupy the same place, so switching between them does not
          reshape the page under the viewer. The tour is only offered once the run list
          has arrived, because every step it takes is derived from that list. */}
      {!error &&
        (onTour && tour.length > 0 ? (
          <Walkthrough
            steps={tour}
            index={step}
            onIndex={setStep}
            onExit={leaveTour}
            onMoment={(at) =>
              setClock((current) =>
                current ? { ...current, at, playing: false } : current,
              )
            }
          />
        ) : (
          <NavTabs
            onStartTour={
              tour.length > 0
                ? () => {
                    setStep(0);
                    navigate("/tour");
                  }
                : undefined
            }
          />
        ))}

      {/* On the guided walk the current step decides which screen sits under the bar, so
          the walk keeps its own address instead of navigating away from itself. */}
      {!error && onTour && <ScreenFor path={tour[step]?.to ?? "/console"} ctx={ctx} />}

      {!error && !onTour && (
        <Routes>
            {/* Every console screen resolves through the same function the guided walk
                uses, so a path can never mean one thing to the router and another to the
                walk. The list is the routing table. */}
            {CONSOLE_SCREENS.map((path) => (
              <Route
                key={path}
                path={path}
                element={<ScreenFor path={path} ctx={ctx} />}
              />
            ))}

            <Route path="/console/advisory/:advisoryId" element={<AdvisoryRoute />} />

            {/* Anything that used to be a tab still lands where it moved to. */}
            {Object.entries(MOVED).map(([from, to]) => (
              <Route key={from} path={from} element={<Navigate to={to} replace />} />
            ))}

            {/* An unknown path goes to the console rather than to a blank screen. */}
            <Route path="*" element={<Navigate to="/console" replace />} />
          </Routes>
      )}
      <footer className="appFoot">
        <Credit />
      </footer>
    </div>
    </div>
  );
}

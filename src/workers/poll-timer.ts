// A throttle-resistant clock for the mission-run poller.
//
// Browsers clamp main-thread setInterval to ~once a minute (or pause it) once a
// tab is hidden. MissionRun's 2s status poll is what keeps the Cloud Run
// pipeline driver warm (the driver only gets CPU while a request is in flight),
// so a throttled poll starves the run and it stalls when you switch tabs.
//
// Worker timers are exempt from background-tab throttling, so we run the poll's
// *clock* here and post a 'tick' on each interval. The page does the actual
// authed fetch on the main thread (where the Firebase token lives) - this worker
// is only a metronome.

export {}; // make this a module (isolatedModules)

type TimerMsg = { type: 'start'; intervalMs: number } | { type: 'stop' };

// In a worker, the global postMessage takes a single argument. This project's
// tsconfig only includes the DOM lib (which types postMessage as
// Window.postMessage, requiring a targetOrigin), so narrow the call locally.
const post = (message: unknown) => (postMessage as (m: unknown) => void)(message);

let timer: ReturnType<typeof setInterval> | null = null;

function stop() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as TimerMsg;
  if (msg.type === 'start') {
    stop();
    timer = setInterval(() => post('tick'), msg.intervalMs);
  } else if (msg.type === 'stop') {
    stop();
  }
});

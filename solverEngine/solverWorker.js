// solverWorker.js

let highsInstancePromise = null;
let solverReady = false;

function postStatus(stage, detail, extra = {}) {
  // stage: short machine label, detail: human readable
  self.postMessage({ type: 'status', stage, detail, ts: Date.now(), ...extra });
}

function startHeartbeat() {
  if (self.__hb) return;
  self.__hb = setInterval(() => {
    self.postMessage({ type: 'heartbeat', ts: Date.now(), solverReady });
  }, 1000);
}

function loadHiGHS() {
  if (highsInstancePromise) return highsInstancePromise;

  highsInstancePromise = new Promise((resolve) => {
    try {
      startHeartbeat();

      // IMPORTANT: Emscripten uses `Module.locateFile` to find the wasm.
      // We set it BEFORE importing highs.js.
      postStatus('solver:init', 'Configuring WASM locator…');

      self.Module = self.Module || {};
      self.Module.locateFile = (path) => {
        // If highs.js asks for "highs.wasm", force it to vendor/highs.wasm
        if (path.endsWith('.wasm')) return `./vendor/${path}`;
        return `./vendor/${path}`;
      };
      importScripts('../vendor/highs.js');

      // Optional: some builds use these names:
      self.Module.print = (...args) => postStatus('solver:stdout', args.join(' '));
      self.Module.printErr = (...args) => postStatus('solver:stderr', args.join(' '));

      postStatus('solver:import', 'Loading HiGHS runtime (highs.js)…');
      importScripts('./vendor/highs.js'); // current line in your repo :contentReference[oaicite:3]{index=3}

      // Many builds export createHiGHS (async)
      if (self.createHiGHS) {
        postStatus('solver:create', 'Creating HiGHS instance (this downloads/instantiates WASM)…');

        // If wasm fetch 404s, this may hang; we also add an internal guard timer.
        const guard = setTimeout(() => {
          postStatus(
            'solver:timeout',
            'HiGHS creation is taking unusually long. Check that ./vendor/highs.wasm is served and not 404.'
          );
        }, 8000);

        self.createHiGHS()
          .then((instance) => {
            clearTimeout(guard);
            solverReady = true;
            postStatus('solver:ready', 'HiGHS solver is ready ✅', { solverReady: true });
            resolve({ type: 'createHiGHS', instance });
          })
          .catch((err) => {
            clearTimeout(guard);
            postStatus('solver:error', `HiGHS init failed: ${err?.message || String(err)}`);
            resolve({ type: 'error', error: err });
          });

        return;
      }

      // Some builds export Highs directly
      if (self.Highs) {
        solverReady = true;
        postStatus('solver:ready', 'HiGHS solver is ready ✅', { solverReady: true });
        resolve({ type: 'Highs', instance: new self.Highs() });
        return;
      }

      postStatus('solver:missing', 'HiGHS exports not found in highs.js (createHiGHS/Highs missing).');
      resolve({ type: 'missing' });
    } catch (err) {
      postStatus('solver:error', `Worker import/init error: ${err?.message || String(err)}`);
      resolve({ type: 'error', error: err });
    }
  });

  return highsInstancePromise;
}

async function solveLP(model, options) {
  const loader = await loadHiGHS();

  if (!loader || loader.type === 'missing' || loader.type === 'error') {
    return { status: 'no_solver', message: loader?.error?.message || 'HiGHS not available' };
  }

  const highs = loader.instance;

  try {
    postStatus('solve:loadModel', 'Loading model into solver…');

    if (highs.readModelFromString) {
      highs.readModelFromString(model);

      if (options?.timeLimitSec && highs.setOptionValue) {
        highs.setOptionValue('time_limit', options.timeLimitSec);
      }

      postStatus('solve:run', `Running solver (time limit ${options?.timeLimitSec || '-'}s)…`);
      highs.run();

      postStatus('solve:extract', 'Extracting solution…');
      const solution = highs.getSolution();
      const info = highs.getInfo();

      postStatus('solve:done', 'Solve complete ✅');
      return { status: 'ok', solution, info };
    }

    return { status: 'no_solver', message: 'HiGHS API mismatch' };
  } catch (err) {
    postStatus('solve:error', `Solve error: ${err?.message || String(err)}`);
    return { status: 'error', message: err.message };
  }
}

self.onmessage = async (event) => {
  const { model, options, requestId } = event.data || {};
  postStatus('request:recv', `Received request ${requestId || '(no id)'}`);

  const result = await solveLP(model, options);

  // Keep your current response shape, but also include solverReady.
  self.postMessage({ requestId, result, solverReady });
};

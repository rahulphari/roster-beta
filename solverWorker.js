let highsInstancePromise = null;
let solverReady = false;

function loadHiGHS() {
  if (highsInstancePromise) return highsInstancePromise;
  highsInstancePromise = new Promise((resolve) => {
    try {
      importScripts('./vendor/highs.js');
      if (self.__highsPlaceholder) {
        resolve({ type: 'missing', message: 'Placeholder HiGHS bundle detected. Replace vendor/highs.js and vendor/highs.wasm.' });
        return;
      }
      if (self.createHiGHS) {
        self.createHiGHS()
          .then((instance) => {
            solverReady = true;
            resolve({ type: 'createHiGHS', instance });
          })
          .catch((err) => {
            resolve({ type: 'error', error: err });
          });
      } else if (self.Highs) {
        solverReady = true;
        resolve({ type: 'Highs', instance: new self.Highs() });
      } else {
        resolve({ type: 'missing' });
      }
    } catch (err) {
      resolve({ type: 'error', error: err });
    }
  });
  return highsInstancePromise;
}

async function solveLP(model, options) {
  const loader = await loadHiGHS();
  if (!loader || loader.type === 'missing' || loader.type === 'error') {
    return { status: 'no_solver', message: loader?.message || loader?.error?.message || 'HiGHS not available' };
  }

  const highs = loader.instance;
  try {
    if (highs.readModelFromString) {
      highs.readModelFromString(model);
      if (options?.timeLimitSec && highs.setOptionValue) {
        highs.setOptionValue('time_limit', options.timeLimitSec);
      }
      highs.run();
      const solution = highs.getSolution();
      const info = highs.getInfo();
      return { status: 'ok', solution, info };
    }
    return { status: 'no_solver', message: 'HiGHS API mismatch' };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

self.onmessage = async (event) => {
  const { model, options, requestId } = event.data;
  const result = await solveLP(model, options);
  self.postMessage({ requestId, result, solverReady });
};

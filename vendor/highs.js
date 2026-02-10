// Placeholder HiGHS-js loader for offline use.
// Replace with real HiGHS-js bundle when available.
(function () {
  if (typeof self === 'undefined') return;
  if (!self.createHiGHS && !self.Highs) {
    self.createHiGHS = async function () {
      throw new Error('HiGHS-js bundle not available.');
    };
  }
})();

// Placeholder HiGHS-js loader for offline use.
// Replace with real HiGHS-js bundle when available.
(function () {
  if (typeof self === 'undefined') return;
  self.__highsPlaceholder = true;
  if (!self.createHiGHS && !self.Highs) {
    self.createHiGHS = async function () {
      throw new Error('HiGHS-js bundle not available.');
    };
  }
})();

(function () {
  function buildAttempts(config) {
    const minDays = config.continuity.minDays;
    const maxDays = config.continuity.maxDays;
    const buffer = Math.floor(0.2 * minDays);
    return [
      {
        id: 'strict',
        label: 'Attempt 1/4 strict',
        allowLastResortTransitions: false,
        allowEndOfHorizonException: false,
        minDays,
        maxDays,
      },
      {
        id: 'wo-plus-minus',
        label: 'Attempt 2/4 WO ±1',
        allowLastResortTransitions: false,
        allowEndOfHorizonException: false,
        minDays,
        maxDays,
        woPlusMinus: true,
      },
      {
        id: 'continuity-buffer',
        label: 'Attempt 3/4 continuity buffer',
        allowLastResortTransitions: false,
        allowEndOfHorizonException: true,
        minDays: Math.max(1, minDays - buffer),
        maxDays: maxDays + buffer,
      },
      {
        id: 'last-resort',
        label: 'Attempt 4/4 last resort transitions',
        allowLastResortTransitions: true,
        allowEndOfHorizonException: true,
        minDays: Math.max(1, minDays - buffer),
        maxDays: maxDays + buffer,
      },
    ];
  }

  window.RelaxationPlanner = { buildAttempts };
})();

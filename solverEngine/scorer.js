(function () {
  function buildEmptyStats(employees, dates, shifts) {
    const perEmployee = {};
    employees.forEach((emp) => {
      perEmployee[emp.id] = { A: 0, B: 0, C: 0, WO: 0, L: 0 };
    });
    const perDay = dates.map(() => ({ A: 0, B: 0, C: 0, WO: 0, L: 0 }));
    const perRole = {};
    employees.forEach((emp) => {
      if (!perRole[emp.role]) perRole[emp.role] = { A: 0, B: 0, C: 0, WO: 0, L: 0 };
    });
    return { perEmployee, perDay, perRole, shifts };
  }

  function scoreRoster({ roster, employees, dates, config, validatorResult }) {
    const shifts = config.shiftMode === 2 ? ['A', 'B'] : ['A', 'B', 'C'];
    const stats = buildEmptyStats(employees, dates, shifts);

    roster.forEach((emp) => {
      emp.schedule.forEach((shift, idx) => {
        stats.perEmployee[emp.id][shift] = (stats.perEmployee[emp.id][shift] || 0) + 1;
        stats.perDay[idx][shift] = (stats.perDay[idx][shift] || 0) + 1;
        stats.perRole[emp.role][shift] = (stats.perRole[emp.role][shift] || 0) + 1;
      });
    });

    const hardViolations = validatorResult?.hardViolations || [];
    const hardCount = hardViolations.length;
    const rulesCompliance = Math.max(0, 100 - hardCount * 2);
    const configCompliance = Math.max(0, 100 - (validatorResult?.staffingViolations?.length || 0) * 1.5);

    const satisfactionScore = Math.max(0, 100 - hardCount * 5);
    const fairnessScore = Math.max(0, 100 - Math.abs(rulesCompliance - configCompliance));

    return {
      scores: {
        rulesCompliance: Number(rulesCompliance.toFixed(1)),
        configCompliance: Number(configCompliance.toFixed(1)),
        satisfactionScore: Number(satisfactionScore.toFixed(1)),
        fairnessScore: Number(fairnessScore.toFixed(1)),
      },
      stats,
    };
  }

  window.Scorer = { scoreRoster };
})();

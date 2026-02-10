(function () {
  function explainRoster({ roster, employees, dates, config, validatorResult }) {
    const violations = validatorResult?.hardViolations || [];
    const staffingViolations = validatorResult?.staffingViolations || [];

    const reasons = {};
    roster.forEach((emp) => {
      reasons[emp.id] = emp.schedule.map((shift, idx) => {
        const dayKey = dates[idx];
        const tags = [];
        if (shift === 'WO') tags.push('WO cadence enforcement');
        if (shift === 'L') tags.push('Leave lock');
        const staffingMin = staffingViolations.find((v) => v.dayIndex === idx && v.role === emp.role && v.shift === shift && v.type === 'min');
        if (staffingMin) tags.push(`Staffing requirement for role ${emp.role} shift ${shift}`);
        const transitionViolation = violations.find((v) => v.employeeId === emp.id && v.dayIndex === idx);
        if (transitionViolation) tags.push(transitionViolation.explanation);
        if (!tags.length) tags.push('Fair distribution adjustment');
        return { dayKey, shift, tags };
      });
    });

    return { reasons, violations, staffingViolations };
  }

  window.Explainer = { explainRoster };
})();

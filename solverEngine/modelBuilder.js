(function () {
  function sanitizeId(value) {
    return String(value).replace(/[^a-zA-Z0-9_]/g, '_');
  }

  function buildModel({ employees, dates, config, attempt }) {
    const shifts = config.shiftMode === 2 ? ['A', 'B'] : ['A', 'B', 'C'];
    const workShifts = [...shifts];
    const allShifts = [...workShifts, 'WO', 'L'];
    const lines = [];
    const binaries = [];
    const variables = [];
    const constraints = [];
    const objectiveTerms = [];

    const horizon = dates.length;

    function varName(eId, dIdx, shift) {
      return `x_${sanitizeId(eId)}_${dIdx}_${shift}`;
    }

    function startVarName(eId, dIdx, shift) {
      return `start_${sanitizeId(eId)}_${dIdx}_${shift}`;
    }

    employees.forEach((emp) => {
      for (let d = 0; d < horizon; d += 1) {
        allShifts.forEach((shift) => {
          const name = varName(emp.id, d, shift);
          variables.push(name);
          binaries.push(name);
        });
      }
    });

    // Assignment constraint
    employees.forEach((emp) => {
      for (let d = 0; d < horizon; d += 1) {
        const expr = allShifts.map((s) => `${varName(emp.id, d, s)}`).join(' + ');
        constraints.push(`${expr} = 1`);
      }
    });

    // Staffing min/max
    for (let d = 0; d < horizon; d += 1) {
      workShifts.forEach((shift) => {
        Object.keys(config.staffingMatrix).forEach((role) => {
          const limits = config.staffingMatrix[role][shift] || { min: 0, max: 0 };
          const roleEmployees = employees.filter((e) => e.role === role);
          if (!roleEmployees.length) return;
          const expr = roleEmployees.map((e) => varName(e.id, d, shift)).join(' + ');
          if (limits.min !== null && limits.min !== undefined) {
            constraints.push(`${expr} >= ${limits.min}`);
          }
          if (limits.max !== null && limits.max !== undefined) {
            constraints.push(`${expr} <= ${limits.max}`);
          }
        });
      });
    }

    // Leave locking
    employees.forEach((emp) => {
      if (!emp.leaveMap) return;
      for (let d = 0; d < horizon; d += 1) {
        const dateKey = dates[d];
        if (emp.leaveMap[dateKey]) {
          allShifts.forEach((shift) => {
            if (shift === 'L') {
              constraints.push(`${varName(emp.id, d, 'L')} = 1`);
            } else {
              constraints.push(`${varName(emp.id, d, shift)} = 0`);
            }
          });
        }
      }
    });

    // WO cadence window (7 days)
    const windowSize = 7;
    employees.forEach((emp) => {
      for (let t = 0; t <= horizon - windowSize; t += 1) {
        const windowDays = Array.from({ length: windowSize }, (_, k) => t + k);
        const terms = windowDays.map((dIdx) => varName(emp.id, dIdx, 'WO'));
        const leaveTerms = windowDays.map((dIdx) => varName(emp.id, dIdx, 'L'));
        if (config.leavePolicy === 'L_COUNTS_AS_WO') {
          constraints.push(`${terms.concat(leaveTerms).join(' + ')} = 1`);
        } else {
          constraints.push(`${terms.join(' + ')} = 1`);
        }
        const workTerms = windowDays
          .map((dIdx) => workShifts.map((s) => varName(emp.id, dIdx, s)).join(' + '))
          .join(' + ');
        constraints.push(`${workTerms} <= 6`);
      }
    });

    // Transition legality
    employees.forEach((emp) => {
      for (let d = 0; d < horizon - 1; d += 1) {
        if (workShifts.includes('C')) {
          constraints.push(`${varName(emp.id, d, 'C')} + ${varName(emp.id, d + 1, 'A')} <= 1`);
          constraints.push(`${varName(emp.id, d, 'C')} + ${varName(emp.id, d + 1, 'B')} <= 1`);
        }
        if (!attempt.allowLastResortTransitions) {
          constraints.push(`${varName(emp.id, d, 'B')} + ${varName(emp.id, d + 1, 'A')} <= 1`);
        } else {
          const penaltyVar = `pen_BA_${sanitizeId(emp.id)}_${d}`;
          variables.push(penaltyVar);
          objectiveTerms.push(`100 ${penaltyVar}`);
          constraints.push(`${penaltyVar} - ${varName(emp.id, d, 'B')} - ${varName(emp.id, d + 1, 'A')} >= -1`);
          constraints.push(`${penaltyVar} >= 0`);
        }
      }
    });

    // Continuity min/max
    const minDays = attempt.minDays ?? config.continuity.minDays;
    const maxDays = attempt.maxDays ?? config.continuity.maxDays;

    employees.forEach((emp) => {
      workShifts.forEach((shift) => {
        for (let d = 0; d < horizon; d += 1) {
          const startVar = startVarName(emp.id, d, shift);
          variables.push(startVar);
          binaries.push(startVar);
          if (d === 0) {
            constraints.push(`${startVar} - ${varName(emp.id, d, shift)} = 0`);
          } else {
            constraints.push(`${startVar} - ${varName(emp.id, d, shift)} + ${varName(emp.id, d - 1, shift)} >= 0`);
          }

          if (d <= horizon - minDays) {
            const runTerms = [];
            for (let k = 0; k < minDays; k += 1) {
              runTerms.push(varName(emp.id, d + k, shift));
            }
            constraints.push(`${runTerms.join(' + ')} - ${minDays} ${startVar} >= 0`);
          } else if (attempt.allowEndOfHorizonException) {
            const penaltyVar = `pen_short_${sanitizeId(emp.id)}_${d}_${shift}`;
            variables.push(penaltyVar);
            objectiveTerms.push(`50 ${penaltyVar}`);
            const remaining = horizon - d;
            const runTerms = [];
            for (let k = 0; k < remaining; k += 1) {
              runTerms.push(varName(emp.id, d + k, shift));
            }
            constraints.push(`${runTerms.join(' + ')} - ${remaining} ${startVar} + ${penaltyVar} >= 0`);
          }
        }

        for (let t = 0; t <= horizon - (maxDays + 1); t += 1) {
          const windowTerms = [];
          for (let k = 0; k < maxDays + 1; k += 1) {
            windowTerms.push(varName(emp.id, t + k, shift));
          }
          constraints.push(`${windowTerms.join(' + ')} <= ${maxDays}`);
        }
      });
    });

    // Objective placeholder: minimize penalties
    lines.push('Minimize');
    lines.push(objectiveTerms.length ? ` obj: ${objectiveTerms.join(' + ')}` : ' obj: 0');
    lines.push('Subject To');
    constraints.forEach((c, idx) => lines.push(` c${idx + 1}: ${c}`));
    lines.push('Binary');
    binaries.forEach((b) => lines.push(` ${b}`));
    lines.push('End');

    return { lp: lines.join('\n'), shifts: workShifts };
  }

  window.ModelBuilder = { buildModel };
})();

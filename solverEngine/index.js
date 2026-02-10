// solverEngine/index.js
(function () {
  let worker = null;
  let requestCounter = 0;

  function getWorker() {
    if (worker) return worker;
    worker = new Worker('./solverWorker.js');

    // Global event hook for UI (optional)
    worker.addEventListener('message', (event) => {
      const data = event.data || {};
      if (data.type === 'status' && window.__onSolverStatus) window.__onSolverStatus(data);
      if (data.type === 'heartbeat' && window.__onSolverHeartbeat) window.__onSolverHeartbeat(data);
    });

    return worker;
  }

  /**
   * @param {string} model
   * @param {object} options
   * @param {object} extras
   * @param {(evt:any)=>void} extras.onEvent - receives status/heartbeat + final result event
   * @param {number} extras.timeoutMs
   */
  function solveWithWorker(model, options, extras = {}) {
    const { onEvent, timeoutMs = 30000 } = extras;

    return new Promise((resolve) => {
      const w = getWorker();
      const requestId = `${Date.now()}_${requestCounter++}`;

      let timeout = null;
      if (timeoutMs) {
        timeout = setTimeout(() => {
          try {
            onEvent?.({ type: 'client_timeout', requestId, ts: Date.now() });
          } catch {}
          resolve({ status: 'error', message: `Solver timed out after ${Math.round(timeoutMs / 1000)}s` });
        }, timeoutMs);
      }

      const handler = (event) => {
        const data = event.data || {};

        // Forward worker status to caller (UI)
        if (data.type === 'status' || data.type === 'heartbeat') {
          try { onEvent?.(data); } catch {}
          return;
        }

        if (data.requestId !== requestId) return;

        w.removeEventListener('message', handler);
        if (timeout) clearTimeout(timeout);

        try { onEvent?.({ type: 'final', requestId, ts: Date.now(), data }); } catch {}
        resolve(data.result);
      };

      w.addEventListener('message', handler);
      w.postMessage({ model, options, requestId });
    });
  }

  // ---- everything below here is your existing logic unchanged ----

  function pickBestDraft(drafts) {
    return drafts.reduce((best, draft) => {
      if (!best) return draft;
      const hardA = draft.validator?.hardViolations?.length || 0;
      const hardB = best.validator?.hardViolations?.length || 0;
      if (hardA !== hardB) return hardA < hardB ? draft : best;
      if (draft.scores.satisfactionScore !== best.scores.satisfactionScore) {
        return draft.scores.satisfactionScore > best.scores.satisfactionScore ? draft : best;
      }
      return draft;
    }, null);
  }

  function normalizeRosterSolution(solution, employees, dates, shifts) {
    const roster = employees.map((emp) => ({ ...emp, schedule: [] }));
    if (!solution?.col_value || !solution?.col_name) {
      return roster;
    }
    const assignments = {};
    solution.col_name.forEach((name, idx) => {
      if (!name.startsWith('x_')) return;
      if (solution.col_value[idx] < 0.5) return;
      const [, empId, dayIdx, shift] = name.split('_');
      assignments[`${empId}_${dayIdx}`] = shift;
    });
    roster.forEach((emp) => {
      for (let d = 0; d < dates.length; d += 1) {
        const shift = assignments[`${emp.id}_${d}`] || 'WO';
        emp.schedule.push(shift);
      }
    });
    return roster;
  }

  function buildWOCalendar(dates, startOffset = 0) {
    const woDays = [];
    for (let d = 0; d < dates.length; d += 1) {
      if ((d + startOffset) % 7 === 6) {
        woDays.push(d);
      }
    }
    return woDays;
  }

  function fallbackGenerate({ employees, dates, config, attempt }) {
    const shifts = config.shiftMode === 2 ? ['A', 'B'] : ['A', 'B', 'C'];
    const roster = employees.map((emp, idx) => {
      const woDays = buildWOCalendar(dates, idx);
      const schedule = [];
      const blockLength = attempt.minDays || config.continuity.minDays;
      let currentShift = shifts[idx % shifts.length];
      let blockCount = 0;
      for (let d = 0; d < dates.length; d += 1) {
        if (woDays.includes(d)) {
          schedule.push('WO');
          blockCount = 0;
          if (currentShift === 'C' && shifts.length === 3) {
            currentShift = 'A';
          }
          continue;
        }
        schedule.push(currentShift);
        blockCount += 1;
        if (blockCount >= blockLength) {
          blockCount = 0;
          const nextIdx = (shifts.indexOf(currentShift) + 1) % shifts.length;
          if (currentShift === 'C' && shifts.length === 3) {
            currentShift = 'A';
          } else {
            currentShift = shifts[nextIdx];
          }
        }
      }
      return { ...emp, schedule };
    });

    return roster;
  }

  function validateRoster({ roster, dates, config }) {
    const shifts = config.shiftMode === 2 ? ['A', 'B'] : ['A', 'B', 'C'];
    const hardViolations = [];
    const staffingViolations = [];

    roster.forEach((emp) => {
      for (let d = 0; d < dates.length - 1; d += 1) {
        const today = emp.schedule[d];
        const next = emp.schedule[d + 1];
        if (today === 'C' && ['A', 'B'].includes(next)) {
          hardViolations.push({ employeeId: emp.id, dayIndex: d, type: 'C_RESET', explanation: 'C reset rule' });
        }
        if (!config.constraintsToggles.allowLastResortTransitions && today === 'B' && next === 'A') {
          hardViolations.push({ employeeId: emp.id, dayIndex: d, type: 'B_TO_A', explanation: 'B→A forbidden' });
        }
      }

      for (let t = 0; t <= dates.length - 7; t += 1) {
        const window = emp.schedule.slice(t, t + 7);
        const woCount = window.filter((s) => s === 'WO').length;
        const leaveCount = window.filter((s) => s === 'L').length;
        const target = config.leavePolicy === 'L_COUNTS_AS_WO' ? woCount + leaveCount : woCount;
        if (target !== 1) {
          hardViolations.push({ employeeId: emp.id, dayIndex: t, type: 'WO_CADENCE', explanation: 'WO cadence violation' });
        }
      }

      shifts.forEach((shift) => {
        let streak = 0;
        emp.schedule.forEach((s) => {
          if (s === shift) {
            streak += 1;
          } else {
            if (streak > 0 && streak < config.continuity.minDays) {
              hardViolations.push({ employeeId: emp.id, type: 'MIN_CONTINUITY', explanation: 'Min continuity violation' });
            }
            if (streak > config.continuity.maxDays) {
              hardViolations.push({ employeeId: emp.id, type: 'MAX_CONTINUITY', explanation: 'Max continuity violation' });
            }
            streak = 0;
          }
        });
        if (streak > 0 && streak < config.continuity.minDays) {
          hardViolations.push({ employeeId: emp.id, type: 'MIN_CONTINUITY', explanation: 'Min continuity violation' });
        }
        if (streak > config.continuity.maxDays) {
          hardViolations.push({ employeeId: emp.id, type: 'MAX_CONTINUITY', explanation: 'Max continuity violation' });
        }
      });
    });

    for (let d = 0; d < dates.length; d += 1) {
      shifts.forEach((shift) => {
        Object.keys(config.staffingMatrix).forEach((role) => {
          const limits = config.staffingMatrix[role][shift] || { min: 0, max: 0 };
          const count = roster.filter((e) => e.role === role && e.schedule[d] === shift).length;
          if (count < limits.min) {
            staffingViolations.push({ dayIndex: d, role, shift, type: 'min', count, limit: limits.min });
          }
          if (limits.max !== null && limits.max !== undefined && count > limits.max) {
            staffingViolations.push({ dayIndex: d, role, shift, type: 'max', count, limit: limits.max });
          }
        });
      });
    }

    return { hardViolations, staffingViolations };
  }

  async function generateRoster({ employees, dates, config, onProgress, onSolverEvent }) {
    const attempts = window.RelaxationPlanner.buildAttempts(config);
    const drafts = [];

    for (const attempt of attempts) {
      if (onProgress) onProgress(attempt.label);

      const model = window.ModelBuilder.buildModel({ employees, dates, config, attempt });

      const result = await solveWithWorker(
        model.lp,
        { timeLimitSec: config.timeLimitSec || 5 },
        { onEvent: onSolverEvent, timeoutMs: (config.workerTimeoutMs || 30000) }
      );

      let roster;
      let status = result.status;

      if (status === 'ok') {
        roster = normalizeRosterSolution(result.solution, employees, dates, model.shifts);
      } else {
        roster = fallbackGenerate({ employees, dates, config, attempt });
        status = 'fallback';
      }

      const validator = validateRoster({ roster, dates, config });
      const scored = window.Scorer.scoreRoster({ roster, employees, dates, config, validatorResult: validator });
      const explained = window.Explainer.explainRoster({ roster, employees, dates, config, validatorResult: validator });

      drafts.push({ attempt, roster, status, validator, scores: scored.scores, stats: scored.stats, explanation: explained });
    }

    const best = pickBestDraft(drafts);
    return { drafts, best };
  }

  window.SolverEngine = {
    generateRoster,
    validateRoster,
  };
})();

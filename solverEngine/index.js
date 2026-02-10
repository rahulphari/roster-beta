// solverEngine/index.js
(function () {
  let worker = null;
  let requestCounter = 0;

  function getWorker() {
    if (worker) return worker;
    worker = new Worker('./solverEngine/solverWorker.js');

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

  // ---- everything below here is your existing logic (with improved fallback) ----

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

  // -----------------------------
  // Heuristic roster generator (no solver required)
  // -----------------------------

  function dayNameToIndex(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' && Number.isFinite(v)) return ((v % 7) + 7) % 7;

    const s = String(v).trim().toLowerCase();
    const map = {
      sun: 0, sunday: 0,
      mon: 1, monday: 1,
      tue: 2, tues: 2, tuesday: 2,
      wed: 3, wednesday: 3,
      thu: 4, thur: 4, thurs: 4, thursday: 4,
      fri: 5, friday: 5,
      sat: 6, saturday: 6,
    };
    return map[s] ?? null;
  }

  // Try to read a preferred WO field from whatever your parser uses.
  function getPreferredWOIndex(emp) {
    const candidate =
      emp.prefWO ??
      emp.prefWo ??
      emp.preferredWO ??
      emp.preferredWo ??
      emp.weekOff ??
      emp.weekoff ??
      emp.woPref ??
      null;

    return dayNameToIndex(candidate);
  }

  function buildWeeklyWOCalendar(dates, empIndex, preferredDowIdx /*0..6 or null*/) {
    // Enforce exactly one WO per 7-day window.
    const woDays = new Set();
    for (let start = 0; start < dates.length; start += 7) {
      const end = Math.min(start + 7, dates.length);

      const withinWeek =
        (preferredDowIdx !== null ? preferredDowIdx : (empIndex % 7));

      const day = start + withinWeek;
      if (day >= start && day < end) woDays.add(day);
      else woDays.add(start);
    }
    return woDays;
  }

  function isForbiddenTransition(prev, next, config) {
    if (prev === 'C' && (next === 'A' || next === 'B')) return true; // C reset rule
    if (!config.constraintsToggles.allowLastResortTransitions && prev === 'B' && next === 'A') return true;
    return false;
  }

  function getShifts(config) {
    return config.shiftMode === 2 ? ['A', 'B'] : ['A', 'B', 'C'];
  }

  function getRoleMin(config, role, shift) {
    const row = config.staffingMatrix?.[role]?.[shift];
    if (!row) return 0;
    const v = row.min;
    return Number.isFinite(v) ? v : 0;
  }

  // Replaces your old fallbackGenerate() and buildWOCalendar()
  function fallbackGenerate({ employees, dates, config, attempt }) {
    const shifts = getShifts(config);

    // continuity targets for this attempt
    const minDays = attempt.minDays ?? config.continuity.minDays;
    const maxDays = attempt.maxDays ?? config.continuity.maxDays;

    // Clone employees into roster with schedules
    const roster = employees.map((e) => ({
      ...e,
      schedule: Array(dates.length).fill(null),
    }));

    // 1) Place WO (and preserve Leaves if present via common patterns)
    roster.forEach((emp, idx) => {
      const prefWO = getPreferredWOIndex(emp);
      const woDays = buildWeeklyWOCalendar(dates, idx, prefWO);

      for (let d = 0; d < dates.length; d += 1) {
        const leaveList = emp.leaveDays ?? emp.leaves ?? null;
        const isLeave =
          (Array.isArray(leaveList) && leaveList.includes(d)) ||
          (emp.leaveSet instanceof Set && emp.leaveSet.has(d)) ||
          (emp.leaveMap && emp.leaveMap[dates[d]]); // supports leaveMap keyed by dateStr if caller passes that

        if (isLeave) {
          emp.schedule[d] = 'L';
          continue;
        }

        if (woDays.has(d)) emp.schedule[d] = 'WO';
      }
    });

    // 2) Greedy staffing fill per day per role:
    const roles = Object.keys(config.staffingMatrix || {});
    const state = new Map(); // emp.id -> {currentShift, streak}

    roster.forEach((emp, idx) => {
      const last = emp.lastShift && shifts.includes(emp.lastShift) ? emp.lastShift : shifts[idx % shifts.length];
      const streak = Number.isFinite(emp.streak) ? emp.streak : 0;
      state.set(emp.id, { currentShift: last, streak });
    });

    function canAssign(emp, dayIdx, newShift) {
      if (emp.schedule[dayIdx] === 'WO' || emp.schedule[dayIdx] === 'L') return false;

      const prev = dayIdx > 0 ? emp.schedule[dayIdx - 1] : null;
      const next = dayIdx < dates.length - 1 ? emp.schedule[dayIdx + 1] : null;

      if (prev && prev !== 'WO' && prev !== 'L' && isForbiddenTransition(prev, newShift, config)) return false;
      if (next && next !== 'WO' && next !== 'L' && isForbiddenTransition(newShift, next, config)) return false;

      return true;
    }

    function assign(emp, dayIdx, shift) {
      emp.schedule[dayIdx] = shift;
    }

    function scoreCandidate(emp, dayIdx, shift) {
      const st = state.get(emp.id);
      const current = st?.currentShift ?? shift;
      const streak = st?.streak ?? 0;

      let penalty = 0;

      // keep same shift until minDays reached
      if (shift !== current && streak < minDays) penalty += 50;

      // avoid exceeding maxDays if possible
      if (shift === current && streak >= maxDays) penalty += 40;

      // small penalty for changing shift at all
      if (shift !== current) penalty += 5;

      // tiny preference to lastShift on day0
      if (dayIdx === 0 && emp.lastShift && shift !== emp.lastShift) penalty += 2;

      return penalty;
    }

    function updateContinuityAfterDay(emp, dayIdx) {
      const st = state.get(emp.id);
      if (!st) return;

      const today = emp.schedule[dayIdx];
      if (!today || today === 'WO' || today === 'L') return;

      if (today === st.currentShift) st.streak += 1;
      else {
        st.currentShift = today;
        st.streak = 1;
      }
    }

    for (let d = 0; d < dates.length; d += 1) {
      // counts per role/shift today
      const counts = {};
      for (const role of roles) {
        counts[role] = {};
        for (const s of shifts) counts[role][s] = 0;
      }
      roster.forEach((e) => {
        const s = e.schedule[d];
        if (!s || s === 'WO' || s === 'L') return;
        if (!counts[e.role]) return;
        if (counts[e.role][s] === undefined) return;
        counts[e.role][s] += 1;
      });

      // satisfy mins first
      for (const role of roles) {
        const roleEmps = roster.filter((e) => e.role === role);

        for (const shift of shifts) {
          const minReq = getRoleMin(config, role, shift);
          let need = minReq - (counts[role]?.[shift] ?? 0);
          if (need <= 0) continue;

          const candidates = roleEmps
            .filter((e) => e.schedule[d] === null)
            .filter((e) => canAssign(e, d, shift))
            .map((e) => ({ e, score: scoreCandidate(e, d, shift) }))
            .sort((a, b) => a.score - b.score);

          let i = 0;
          while (need > 0 && i < candidates.length) {
            const pick = candidates[i].e;
            assign(pick, d, shift);
            counts[role][shift] += 1;
            need -= 1;
            i += 1;
          }
        }

        // assign remaining unassigned for this role -> balance across shifts
        for (const emp of roleEmps) {
          if (emp.schedule[d] !== null) continue;

          const options = shifts
            .filter((s) => canAssign(emp, d, s))
            .map((s) => ({ s, c: counts[role][s], score: scoreCandidate(emp, d, s) }))
            .sort((a, b) => (a.c - b.c) || (a.score - b.score));

          const chosen = options[0]?.s ?? shifts[0];
          assign(emp, d, chosen);
          counts[role][chosen] += 1;
        }
      }

      roster.forEach((emp) => updateContinuityAfterDay(emp, d));
    }

    // 3) Small repair pass: if a shift change happens before minDays, try swap to continue prev shift
    function trySwapSameRole(dayIdx, role, fromEmp, toShift) {
      const partner = roster.find((e) =>
        e.role === role &&
        e.id !== fromEmp.id &&
        e.schedule[dayIdx] === toShift
      );
      if (!partner) return false;

      const fromShift = fromEmp.schedule[dayIdx];
      if (!fromShift || fromShift === 'WO' || fromShift === 'L') return false;

      if (!canAssign(fromEmp, dayIdx, toShift)) return false;
      if (!canAssign(partner, dayIdx, fromShift)) return false;

      fromEmp.schedule[dayIdx] = toShift;
      partner.schedule[dayIdx] = fromShift;
      return true;
    }

    for (const emp of roster) {
      for (let d = 1; d < dates.length; d += 1) {
        const prev = emp.schedule[d - 1];
        const cur = emp.schedule[d];
        if (!prev || !cur) continue;
        if (prev === 'WO' || prev === 'L' || cur === 'WO' || cur === 'L') continue;

        if (prev !== cur) {
          let streak = 1;
          for (let k = d - 2; k >= 0; k -= 1) {
            if (emp.schedule[k] === prev) streak += 1;
            else break;
          }
          if (streak < minDays) {
            trySwapSameRole(d, emp.role, emp, prev);
          }
        }
      }
    }

    // Any still-null -> WO
    roster.forEach((e) => {
      for (let d = 0; d < dates.length; d += 1) {
        if (e.schedule[d] === null) e.schedule[d] = 'WO';
      }
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

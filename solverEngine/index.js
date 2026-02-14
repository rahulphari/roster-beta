// solverEngine/index.js
// Heuristic-first roster generation (no HiGHS / no MILP solver).
(function () {
  function pickBestDraft(drafts) {
    return drafts.reduce((best, draft) => {
      if (!best) return draft;
      const hardA = draft.validator?.hardViolations?.length || 0;
      const hardB = best.validator?.hardViolations?.length || 0;
      if (hardA !== hardB) return hardA < hardB ? draft : best;

      const staffA = draft.validator?.staffingViolations?.length || 0;
      const staffB = best.validator?.staffingViolations?.length || 0;
      if (staffA !== staffB) return staffA < staffB ? draft : best;

      // Prefer higher satisfaction if present on both
      const satA = draft.scores?.satisfactionScore;
      const satB = best.scores?.satisfactionScore;
      if (typeof satA === 'number' && typeof satB === 'number' && satA !== satB) {
        return satA > satB ? draft : best;
      }

      return best;
    }, null);
  }

  function dayNameToIndex(v) {
    if (v == null) return null;
    if (typeof v === 'number') return ((v % 7) + 7) % 7;
    const s = String(v).trim().toLowerCase();
    const map = {
      sun: 0, sunday: 0,
      mon: 1, monday: 1,
      tue: 2, tues: 2, tuesday: 2,
      wed: 3, weds: 3, wednesday: 3,
      thu: 4, thur: 4, thurs: 4, thursday: 4,
      fri: 5, friday: 5,
      sat: 6, saturday: 6,
    };
    if (s in map) return map[s];
    // Try numeric string
    const n = Number(s);
    if (!Number.isNaN(n)) return ((n % 7) + 7) % 7;
    return null;
  }

  function getPreferredWOIndex(emp) {
    const candidates = [
      emp.prefWO,
      emp.prefWo,
      emp.preferredWO,
      emp.preferredWo,
      emp.weekOff,
      emp.weekoff,
      emp.woPref,
    ];
    for (const c of candidates) {
      const idx = dayNameToIndex(c);
      if (idx !== null) return idx;
    }
    return null;
  }

  function buildWeeklyWOCalendar(dates, empIndex, preferredDowIdx) {
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

  // Attempt-1 strict WO: choose the day in each 7-day chunk whose *actual weekday*
  // matches the employee preference. Falls back only if we can't parse dates.
  function buildWeeklyWOCalendarStrictPref(dates, preferredDowIdx) {
    const woDays = new Set();
    for (let start = 0; start < dates.length; start += 7) {
      const end = Math.min(start + 7, dates.length);

      let picked = null;
      for (let d = start; d < end; d += 1) {
        const dt = new Date(dates[d]);
        if (!Number.isNaN(dt.getTime()) && dt.getDay() === preferredDowIdx) {
          picked = d;
          break;
        }
      }

      // If dates are unparseable or no matching weekday exists in this chunk,
      // we fall back to start to keep the rest of the heuristic unchanged.
      woDays.add(picked !== null ? picked : start);
    }
    return woDays;
  }

  function isForbiddenTransition(prev, next, config) {
    if (!prev || !next) return false;
    if (prev === 'C' && (next === 'A' || next === 'B')) return true;

    const allowLastResort = !!config?.constraintsToggles?.allowLastResortTransitions;
    if (!allowLastResort && prev === 'B' && next === 'A') return true;

    return false;
  }

  function getShifts(config) {
    if (config?.shiftMode === 2) return ['A', 'B'];
    return ['A', 'B', 'C'];
  }

  function getRoleMin(config, role, shift) {
    const v = config?.staffingMatrix?.[role]?.[shift]?.min;
    return typeof v === 'number' ? v : 0;
  }

  function computeDerivedScores({ validator, dates }) {
    const hard = validator?.hardViolations?.length || 0;
    const staff = validator?.staffingViolations?.length || 0;
    const denom = Math.max(1, dates.length);

    // Simple proxies when a proper scorer isn't provided.
    const rulesCompliance = Math.max(0, Math.round(100 - (hard / denom) * 100));
    const configCompliance = Math.max(0, Math.round(100 - (staff / denom) * 100));

    return {
      rulesCompliance,
      configCompliance,
      satisfactionScore: 50,
      fairnessScore: 50,
    };
  }

  function fallbackGenerate({ employees, dates, config, attempt, attemptIndex }) {
    const shifts = getShifts(config);

    const minDays = attempt.minDays ?? config.continuity.minDays;
    const maxDays = attempt.maxDays ?? config.continuity.maxDays;

    const roster = employees.map((e) => ({
      ...e,
      schedule: Array(dates.length).fill(null),
    }));

    // Pre-fill leave + WO
    roster.forEach((emp, idx) => {
      const prefWO = getPreferredWOIndex(emp);
      const woDays =
        (attemptIndex === 0 && prefWO !== null)
          ? buildWeeklyWOCalendarStrictPref(dates, prefWO)
          : buildWeeklyWOCalendar(dates, idx, prefWO);

      for (let d = 0; d < dates.length; d += 1) {
        const leaveList = emp.leaveDays ?? emp.leaves ?? null;
        const isLeave =
          (Array.isArray(leaveList) && leaveList.includes(d)) ||
          (emp.leaveSet instanceof Set && emp.leaveSet.has(d)) ||
          (emp.leaveMap && emp.leaveMap[dates[d]]);

        if (isLeave) {
          emp.schedule[d] = 'L';
          continue;
        }

        if (woDays.has(d)) emp.schedule[d] = 'WO';
      }
    });

    // Track continuity state per employee
    const state = new Map();
    roster.forEach((emp, idx) => {
      const seeded = shifts[idx % shifts.length];
      const currentShift = shifts.includes(emp.lastShift) ? emp.lastShift : seeded;
      const streak = typeof emp.streak === 'number' ? emp.streak : 0;
      state.set(emp.id, { currentShift, streak });
    });

    function canAssign(emp, dayIdx, newShift) {
      const cur = emp.schedule[dayIdx];
      if (cur === 'WO' || cur === 'L') return false;
      if (cur && cur !== null) return false;

      const prev = dayIdx > 0 ? emp.schedule[dayIdx - 1] : null;
      const next = dayIdx < emp.schedule.length - 1 ? emp.schedule[dayIdx + 1] : null;

      const isShift = (v) => v && v !== 'WO' && v !== 'L';

      if (isShift(prev) && isForbiddenTransition(prev, newShift, config)) return false;
      if (isShift(next) && isForbiddenTransition(newShift, next, config)) return false;

      return true;
    }

    function scoreCandidate(emp, dayIdx, shift) {
      const st = state.get(emp.id);
      const curShift = st.currentShift;
      const curStreak = st.streak;

      let penalty = 0;

      // Big penalty for breaking min continuity
      if (shift !== curShift && curStreak > 0 && curStreak < minDays) penalty += 50;

      // Penalty for exceeding max continuity
      if (shift === curShift && curStreak >= maxDays) penalty += 40;

      // Small penalty for switching shift
      if (shift !== curShift) penalty += 5;

      // Mild preference to continue last shift on day 0
      if (dayIdx === 0 && shift !== emp.lastShift && shifts.includes(emp.lastShift)) penalty += 2;

      return penalty;
    }

    function countAssignedForDay(dayIdx) {
      const counts = {};
      for (const emp of roster) {
        const v = emp.schedule[dayIdx];
        if (!v || v === 'WO' || v === 'L') continue;
        if (!counts[emp.role]) counts[emp.role] = {};
        counts[emp.role][v] = (counts[emp.role][v] || 0) + 1;
      }
      return counts;
    }

    function ensureCountsRoleShift(dayIdx, role, shift, counts) {
      const minReq = getRoleMin(config, role, shift);
      const current = counts?.[role]?.[shift] || 0;
      let need = minReq - current;
      if (need <= 0) return;

      const candidates = roster
        .filter((e) => e.role === role && e.schedule[dayIdx] === null && canAssign(e, dayIdx, shift))
        .map((e) => ({ emp: e, penalty: scoreCandidate(e, dayIdx, shift) }))
        .sort((a, b) => a.penalty - b.penalty);

      for (let i = 0; i < candidates.length && need > 0; i += 1) {
        const e = candidates[i].emp;
        e.schedule[dayIdx] = shift;
        if (!counts[role]) counts[role] = {};
        counts[role][shift] = (counts[role][shift] || 0) + 1;
        need -= 1;
      }
    }

    function assignRemainingRole(dayIdx, role, counts) {
      const roleEmps = roster.filter((e) => e.role === role);
      for (const emp of roleEmps) {
        if (emp.schedule[dayIdx] !== null) continue;

        const options = shifts
          .filter((s) => canAssign(emp, dayIdx, s))
          .map((s) => ({
            shift: s,
            load: (counts?.[role]?.[s] || 0),
            penalty: scoreCandidate(emp, dayIdx, s),
          }))
          .sort((a, b) => (a.load - b.load) || (a.penalty - b.penalty));

        const chosen = options.length ? options[0].shift : shifts[0];
        emp.schedule[dayIdx] = chosen;

        if (!counts[role]) counts[role] = {};
        counts[role][chosen] = (counts[role][chosen] || 0) + 1;
      }
    }

    // Construct day by day
    for (let d = 0; d < dates.length; d += 1) {
      const counts = countAssignedForDay(d);

      const roles = Array.from(new Set(roster.map((e) => e.role)));
      for (const role of roles) {
        for (const sh of shifts) {
          ensureCountsRoleShift(d, role, sh, counts);
        }
        assignRemainingRole(d, role, counts);
      }

      // Update continuity state after day assignment
      for (const emp of roster) {
        const v = emp.schedule[d];
        if (!v || v === 'WO' || v === 'L') continue;
        const st = state.get(emp.id);
        if (st.currentShift === v) st.streak += 1;
        else {
          st.currentShift = v;
          st.streak = 1;
        }
      }
    }

    function trySwapSameRole(dayIdx, role, fromEmp, toShift) {
      // find another employee with same role assigned toShift on dayIdx,
      // swap their shift with fromEmp's current assignment to reduce min continuity break.
      const fromShift = fromEmp.schedule[dayIdx];
      const candidates = roster.filter(
        (e) =>
          e.role === role &&
          e.id !== fromEmp.id &&
          e.schedule[dayIdx] === toShift
      );

      for (const other of candidates) {
        if (!canAssign(fromEmp, dayIdx, toShift)) continue;
        // other is already assigned toShift, but we'd like to move other to fromShift
        // Check if other can take fromShift
        const otherCur = other.schedule[dayIdx];
        other.schedule[dayIdx] = null;
        const okOther = canAssign(other, dayIdx, fromShift);
        other.schedule[dayIdx] = otherCur;
        if (!okOther) continue;

        // perform swap
        fromEmp.schedule[dayIdx] = toShift;
        other.schedule[dayIdx] = fromShift;
        return true;
      }
      return false;
    }

    // Repair: reduce min continuity breaks by swapping same-role assignments
    for (const emp of roster) {
      let streak = 1;
      for (let d = 1; d < dates.length; d += 1) {
        const prev = emp.schedule[d - 1];
        const cur = emp.schedule[d];

        const isShift = (v) => v && v !== 'WO' && v !== 'L';

        if (!isShift(prev) || !isShift(cur)) {
          streak = isShift(cur) ? 1 : 0;
          continue;
        }

        if (cur === prev) {
          streak += 1;
          continue;
        }

        // shift changed: if previous streak was < minDays, attempt swap
        if (streak > 0 && streak < minDays) {
          // Try to swap today's shift with someone on prev shift
          trySwapSameRole(d, emp.role, emp, prev);
        }

        streak = 1;
      }
    }

    // Final: fill any remaining null with WO
    for (const emp of roster) {
      for (let d = 0; d < emp.schedule.length; d += 1) {
        if (emp.schedule[d] === null) emp.schedule[d] = 'WO';
      }
    }

    return roster;
  }

  function validateRoster({ roster, dates, config }) {
    const hardViolations = [];
    const staffingViolations = [];

    const shifts = getShifts(config);
    const minDays = config?.continuity?.minDays ?? 1;
    const maxDays = config?.continuity?.maxDays ?? 7;

    const allowLastResort = !!config?.constraintsToggles?.allowLastResortTransitions;

    // Hard validations per employee
    for (const emp of roster) {
      // Forbidden transitions
      for (let d = 1; d < dates.length; d += 1) {
        const prev = emp.schedule[d - 1];
        const cur = emp.schedule[d];

        const isShift = (v) => v && v !== 'WO' && v !== 'L';
        if (!isShift(prev) || !isShift(cur)) continue;

        if (prev === 'C' && (cur === 'A' || cur === 'B')) {
          hardViolations.push({ code: 'C_RESET', empId: emp.id, dayIdx: d, prev, cur });
        }
        if (!allowLastResort && prev === 'B' && cur === 'A') {
          hardViolations.push({ code: 'B_TO_A', empId: emp.id, dayIdx: d, prev, cur });
        }
      }

      // WO cadence: exactly 1 WO per any 7-day window (optionally count L as WO)
      const leaveCountsAsWO = config?.leavePolicy === 'L_COUNTS_AS_WO';
      for (let start = 0; start + 6 < dates.length; start += 1) {
        let wo = 0;
        let l = 0;
        for (let d = start; d < start + 7; d += 1) {
          if (emp.schedule[d] === 'WO') wo += 1;
          if (emp.schedule[d] === 'L') l += 1;
        }
        const effective = leaveCountsAsWO ? (wo + l) : wo;
        if (effective !== 1) {
          hardViolations.push({
            code: 'WO_CADENCE',
            empId: emp.id,
            windowStart: start,
            wo,
            l,
            effective,
          });
        }
      }

      // Min/max continuity for shifts
      for (const sh of shifts) {
        let streak = 0;
        for (let d = 0; d < dates.length; d += 1) {
          const v = emp.schedule[d];
          if (v === sh) streak += 1;
          else {
            if (streak > 0) {
              if (streak < minDays) hardViolations.push({ code: 'MIN_CONTINUITY', empId: emp.id, shift: sh, streak });
              if (streak > maxDays) hardViolations.push({ code: 'MAX_CONTINUITY', empId: emp.id, shift: sh, streak });
            }
            streak = 0;
          }
        }
        if (streak > 0) {
          if (streak < minDays) hardViolations.push({ code: 'MIN_CONTINUITY', empId: emp.id, shift: sh, streak });
          if (streak > maxDays) hardViolations.push({ code: 'MAX_CONTINUITY', empId: emp.id, shift: sh, streak });
        }
      }
    }

    // Staffing validations per day
    for (let d = 0; d < dates.length; d += 1) {
      const counts = {};
      for (const emp of roster) {
        const v = emp.schedule[d];
        if (!v || v === 'WO' || v === 'L') continue;
        if (!counts[emp.role]) counts[emp.role] = {};
        counts[emp.role][v] = (counts[emp.role][v] || 0) + 1;
      }

      const roles = Object.keys(config?.staffingMatrix || {});
      for (const role of roles) {
        for (const sh of shifts) {
          const req = config?.staffingMatrix?.[role]?.[sh];
          if (!req) continue;
          const min = typeof req.min === 'number' ? req.min : 0;
          const max = (typeof req.max === 'number') ? req.max : null;
          const got = counts?.[role]?.[sh] || 0;

          if (got < min) staffingViolations.push({ code: 'STAFF_MIN', dayIdx: d, role, shift: sh, got, min });
          if (max !== null && got > max) staffingViolations.push({ code: 'STAFF_MAX', dayIdx: d, role, shift: sh, got, max });
        }
      }
    }

    return { hardViolations, staffingViolations };
  }

  async function generateRoster({ employees, dates, config, onProgress }) {
    const attempts = window.RelaxationPlanner.buildAttempts(config);
    const drafts = [];

    for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
      const attempt = attempts[attemptIndex];
      if (onProgress) onProgress(attempt.label);

      const roster = fallbackGenerate({ employees, dates, config, attempt, attemptIndex });

      const validator = validateRoster({ roster, dates, config });

      let scored = null;
      try {
        scored = window.Scorer?.scoreRoster?.({ roster, employees, dates, config, validatorResult: validator }) || null;
      } catch {
        scored = null;
      }

      const scores = (scored && scored.scores) ? scored.scores : computeDerivedScores({ validator, dates });

      let explained = null;
      try {
        explained = window.Explainer?.explainRoster?.({ roster, employees, dates, config, validatorResult: validator, scoreResult: scored }) || null;
      } catch {
        explained = null;
      }

      drafts.push({
        attempt,
        roster,
        status: 'heuristic',
        validator,
        scores,
        stats: scored?.stats || null,
        explanation: explained || {},
      });
    }

    const best = pickBestDraft(drafts);
    return { drafts, best };
  }

  window.SolverEngine = {
    generateRoster,
    validateRoster,
  };
})();

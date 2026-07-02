const db = require("./db");
const dock = require("./docker");

let interval = null;

async function runSchedule(schedule) {
  const now = new Date();
  const targets =
    schedule.instanceCode === "*"
      ? db.getInstances()
      : [db.getByCode(schedule.instanceCode)].filter(Boolean);

  for (const inst of targets) {
    try {
      switch (schedule.type) {
        case "start":
          await dock.startInstance(inst.code);
          db.updateInstance(inst.code, { status: "running" });
          break;
        case "stop":
          await dock.stopInstance(inst.code);
          db.updateInstance(inst.code, { status: "stopped" });
          break;
        case "restart":
          await dock.restartInstance(inst.code);
          db.updateInstance(inst.code, { status: "running" });
          break;
      }
      db.addAudit({
        action: "schedule_" + schedule.type,
        user: "scheduler",
        instance: inst.code,
        timestamp: now.toISOString(),
        details: { scheduleId: schedule.id },
      });
    } catch (err) {
      console.error("Schedule error:", schedule.id, inst.code, err.message);
    }
  }
  db.updateSchedule(schedule.id, { lastRun: now.toISOString() });
}

function check() {
  const schedules = db.getSchedules().filter((s) => s.enabled);
  const now = Date.now();
  for (const s of schedules) {
    const lastRun = s.lastRun ? new Date(s.lastRun).getTime() : 0;
    const ms = s.interval * 60 * 1000;
    if (now - lastRun >= ms) {
      runSchedule(s);
    }
  }
}

function initScheduler() {
  if (interval) return;
  interval = setInterval(check, 60000);
}

function stopScheduler() {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

module.exports = { initScheduler, stopScheduler };
